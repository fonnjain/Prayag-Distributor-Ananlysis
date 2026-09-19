/**
 * Secondary Order Report XLSX loader.
 *
 * Streams the Product-Wise Secondary Order Report and upserts rows into
 * secondary_order_line.  Idempotent: re-uploading the same file produces
 * the same row count.  Collisions (same unique pair with different stored
 * values) are reported and NOT silently overwritten.
 *
 * IMPORTANT: This is ORDER BOOKING data, not dispatch. It remains a separate
 * read-only history table; the verified Aug-26 Product-Wise workbook is also
 * loaded through its own protected SKU-source route. Never treat either table
 * as primary dispatch or sum them together.
 *
 * Category → segment mapping reuses the existing group_map.json vocabulary
 * (same mapping used by the secondary SKU loader).  Do NOT create a second map.
 */

import ExcelJS from "exceljs";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { canonGroupFromMap } from "../sku/catalogue.js";
import { normSecKey } from "../mgmt/names.js";
import { logger } from "../logger.js";
import { invalidateSnapshotsAsync } from "../payloadSnapshot.js";
import {
  resolveApprovedProductWiseManifest,
} from "./approvedManifests.js";
import {
  evaluateSecondaryOrderAnalyticsApproval,
  evaluateSecondaryOrderUpload,
  type StableIdResolution,
  type SecondaryOrderUploadMetrics,
  type SecondaryOrderAnalyticsApproval,
  type UploadQualityEvaluation,
} from "./uploadQuality.js";
import {
  resolveProductWiseHeaders,
  validateProductWiseValues,
  type ProductWiseColumnIndexes,
  type ProductWiseSemanticValidation,
} from "../secondary/productWiseHeaders.js";
import {
  assertGenericProductWiseOrderMonth,
  indiaMonthLabel,
  productWiseOrderMonthPlan,
} from "./monthReplacement.js";

function plainCellValue(v: unknown): string | number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return plainCellValue(o.result);
    if ("text" in o) return plainCellValue(o.text);
    if ("richText" in o && Array.isArray(o.richText)) {
      return o.richText.map((r) => (r as { text?: string }).text ?? "").join("");
    }
    if ("error" in o) return null;
    return null;
  }
  return v as string | number | null;
}

function toText(v: unknown): string | null {
  const p = plainCellValue(v);
  if (p == null) return null;
  const s = String(p).trim();
  return s === "" ? null : s;
}

function toRawSourceText(v: unknown): string {
  const p = plainCellValue(v);
  return p == null ? "" : String(p);
}

export function normalizeProductWiseNullableText(v: unknown): string | null {
  const text = toText(v);
  return text?.toUpperCase() === "NA" ? null : text;
}

function toNum(v: unknown): number | null {
  const p = plainCellValue(v);
  if (p == null || p === "") return null;
  const n = Number(String(p).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse "DD-MM-YYYY HH:mm:ss" date string from the workbook.
 * Also handles Date objects (exceljs may parse date cells).
 */
export function parseOrderDatetime(v: unknown): Date | null {
  if (v instanceof Date) return v;
  const raw = plainCellValue(v);
  if (raw == null) return null;
  const s = String(raw).trim();
  // Format: "19-08-2026 15:06:12"
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [, dd, mm, yyyy, HH, MM, SS] = m;
    const d = new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Do not delegate to Date's locale-dependent string parser: ambiguous source
  // literals must be rejected, never silently interpreted as MM-DD.
  return null;
}

function parseDiscountPct(v: unknown): number | null {
  const p = plainCellValue(v);
  if (p == null || p === "") return null;
  // Sometimes "50" or 50 (numeric) or "50 (%)"
  if (typeof p === "number") return p;
  const m = String(p).match(/^(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]);
}

/** Fiscal year from the literal parsed source timestamp (India calendar). */
function fiscalYearFromDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "numeric",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = value("year");
  const month = value("month");
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const PRODUCT_WISE_ERA_START_MS = Date.UTC(2026, 6, 31, 18, 30);
/** Product-Wise is a new CRM era; pre-August rows belong to legacy sources. */
export function assertProductWiseEraStart(rows: Iterable<{ orderDatetime: Date }>): void {
  for (const row of rows) {
    if (row.orderDatetime.getTime() < PRODUCT_WISE_ERA_START_MS) {
      throw new Error(
        `Product-Wise era violation: accepted order date ${row.orderDatetime.toISOString()} ` +
        "is before 2026-08-01 00:00 IST; refusing the entire load.",
      );
    }
  }
}

// ── Salesperson resolution ────────────────────────────────────────────────────
// Conservative: only match if normSecKey resolves unambiguously to exactly one person.
// Null is acceptable; unresolved names are reported in verification.

type PersonRow = { person_id: number; name: string };

async function getPersons(): Promise<PersonRow[]> {
  const { rows } = await pool.query<PersonRow>(
    "SELECT person_id, name FROM person ORDER BY person_id",
  );
  return rows;
}

// ── Load result ───────────────────────────────────────────────────────────────

export type CollisionDetail = {
  orderId: string;
  productCode: string;
  field: string;
  stored: string | null;
  incoming: string | null;
};

export type SourcePairCollision = {
  orderId: string;
  productCode: string;
  identical: boolean;
  occurrences: Array<{
    occurrence: number;
    sourceRowNumber: number;
    qty: number | null;
    discountPct: number | null;
    basicOrderValue: number | null;
    dealerOrderValue: number | null;
  }>;
};

export type LoadResult = {
  rowsScanned: number;
  rowsParsed: number;
  rowsRejected: number;
  rowsInserted: number;
  rowsSkipped: number;        // same values, idempotent
  collisions: CollisionDetail[];
  sourcePairCollisions: SourcePairCollision[];
  exactDuplicateExportRows: Array<{
    orderId: string;
    productCode: string;
    qty: number | null;
    basicOrderValue: number | null;
  }>;
  exactDuplicateWarning: boolean;
  unresolvedSalesUsers: string[];
  unmappedCategories: string[];
  sourceFile: string;
  sourceSha256: string;
  sourceBytes: number;
  rowsRemoved?: number;
  sep26Controls?: Prompt121Sep26Controls;
  semanticValidation?: ProductWiseSemanticValidation;
  uploadVerification?: SecondaryOrderUploadVerification;
};

export type Prompt121Sep26Controls = {
  sourceSha256: string;
  rows: number;
  orders: number;
  dateMin: string;
  dateMax: string;
  basic: number;
  inclusive: number;
  gst: number;
  retailers: number;
  distributors: number;
  codes: number;
  salesUsers: number;
  statuses: string[];
  discountMin: number;
  discountMedian: number;
  discountMax: number;
  discountNulls: number;
  cityUnavailableLiterals: number;
  blankGstTypes: number;
  months: string[];
};

type SepControlRow = {
  orderId: string;
  orderDatetime: Date;
  dealerId: string;
  cpCode: string;
  productCode: string;
  salesUserName: string | null;
  orderStatus: string;
  discountPct: number | null;
  basicOrderValue: number | null;
  dealerOrderValueIncl: number | null;
  gstAmount: number | null;
  city: string | null;
  cityRaw: string;
  gstType: string | null;
  gstTypeRaw: string;
};

export const PRODUCT_WISE_ORDER_SNAPSHOT_PREFIXES = [
  "sku-facts-v5-source-metadata|",
  "sku-trend-v6-identity-value-metadata|",
  "mgmt-data|",
  "analytics|",
  "warnings|v3|",
  "company-reports|v3|",
] as const;

export function assertManifestReplacementAllowed(input: {
  incomingCutoff: Date;
  incomingCompleteness: "partial" | "complete";
  incomingManifestId: string;
  incomingSha256: string;
  existingMaxOrderDatetime: Date | null;
  existingCompleteness: string[];
  existingManifestIds: string[];
  existingManifestShas: string[];
}): void {
  const exactReplay = input.existingManifestIds.length === 1 &&
    input.existingManifestShas.length === 1 &&
    input.existingManifestIds[0] === input.incomingManifestId &&
    input.existingManifestShas[0] === input.incomingSha256;
  if (exactReplay) return;
  if (input.existingMaxOrderDatetime && input.incomingCutoff < input.existingMaxOrderDatetime) {
    throw new Error("Product-Wise manifest replacement cutoff must be monotonic.");
  }
  if (input.existingCompleteness.includes("complete") && input.incomingCompleteness !== "complete") {
    throw new Error("A complete Product-Wise manifest cannot be replaced by a partial manifest.");
  }
}

export async function invalidateProductWiseOrderSnapshots(): Promise<void> {
  await Promise.all(PRODUCT_WISE_ORDER_SNAPSHOT_PREFIXES.map((prefix) => invalidateSnapshotsAsync(prefix)));
}

export function assertPrompt121Sep26Controls(
  rows: SepControlRow[],
  rowsScanned: number,
  rowsRejected: number,
  sourceSha256: string,
): Prompt121Sep26Controls {
  const errors: string[] = [];
  const manifest = resolveApprovedProductWiseManifest(sourceSha256);
  const indiaDates = rows.map((row) => row.orderDatetime.getTime()).sort((a, b) => a - b);
  const expectedMin = Date.parse(manifest.dateMin);
  const expectedMax = Date.parse(manifest.dateMax);
  const discounts = rows.map((row) => row.discountPct).filter((value): value is number => value != null).sort((a, b) => a - b);
  const basic = rows.reduce((sum, row) => sum + (row.basicOrderValue ?? 0), 0);
  const inclusive = rows.reduce((sum, row) => sum + (row.dealerOrderValueIncl ?? 0), 0);
  const gst = rows.reduce((sum, row) => sum + (row.gstAmount ?? 0), 0);
  const controls: Prompt121Sep26Controls = {
    sourceSha256, rows: rows.length, orders: new Set(rows.map((row) => row.orderId)).size,
    dateMin: indiaDates.length ? new Date(indiaDates[0]!).toISOString() : "",
    dateMax: indiaDates.length ? new Date(indiaDates[indiaDates.length - 1]!).toISOString() : "",
    basic, inclusive, gst,
    retailers: new Set(rows.map((row) => row.dealerId)).size,
    distributors: new Set(rows.map((row) => row.cpCode)).size,
    codes: new Set(rows.map((row) => row.productCode)).size,
    salesUsers: new Set(rows.map((row) => row.salesUserName)).size,
    statuses: [...new Set(rows.map((row) => row.orderStatus))].sort(),
    discountMin: discounts[0] ?? NaN,
    discountMedian: discounts.length % 2 ? discounts[Math.floor(discounts.length / 2)]! : (discounts[discounts.length / 2 - 1]! + discounts[discounts.length / 2]!) / 2,
    discountMax: discounts[discounts.length - 1] ?? NaN,
    discountNulls: rows.length - discounts.length,
    cityUnavailableLiterals: rows.filter((row) => row.city == null && row.cityRaw.trim().toUpperCase() === "NA").length,
    blankGstTypes: rows.filter((row) => row.gstType == null && row.gstTypeRaw === "").length,
    months: [...new Set(rows.map((row) => indiaMonthLabel(row.orderDatetime)))].sort(),
  };
  const near = (actual: number, expected: number, cents = false) => Math.abs(actual - expected) <= (cents ? manifest.valueToleranceCents : 0);
  if (rowsScanned !== manifest.rows || rows.length !== manifest.rows) errors.push(`rows=${rows.length}; scanned=${rowsScanned}; expected ${manifest.rows}`);
  if (rowsRejected !== manifest.rejectedRows) errors.push(`rowsRejected=${rowsRejected}; expected ${manifest.rejectedRows}`);
  if (controls.orders !== manifest.orders) errors.push(`orders=${controls.orders}; expected ${manifest.orders}`);
  if (indiaDates[0] !== expectedMin || indiaDates[indiaDates.length - 1] !== expectedMax) errors.push("date range is not the reviewed 1–17 Sep-26 range");
  if (!near(basic, manifest.basic) || !near(inclusive, manifest.inclusive, true) || !near(gst, manifest.gst, true)) errors.push(`value controls basic=${basic}, inclusive=${inclusive}, gst=${gst}`);
  if (controls.retailers !== manifest.retailers || controls.distributors !== manifest.distributors || controls.codes !== manifest.codes || controls.salesUsers !== manifest.salesUsers) errors.push("identity/code control totals do not match reviewed Sep-26 controls");
  if (controls.statuses.length !== manifest.statuses.length || controls.statuses[0] !== manifest.statuses[0]) errors.push(`statuses=${controls.statuses.join(",")}; expected ${manifest.statuses.join(",")}`);
  if (controls.discountMin !== manifest.discountMin || controls.discountMedian !== manifest.discountMedian || controls.discountMax !== manifest.discountMax || controls.discountNulls !== manifest.discountNulls) errors.push("discount controls do not match reviewed Sep-26 controls");
  if (controls.cityUnavailableLiterals !== manifest.cityUnavailableLiterals) errors.push(`city unavailable literals=${controls.cityUnavailableLiterals}; expected ${manifest.cityUnavailableLiterals}`);
  if (controls.blankGstTypes !== manifest.blankGstTypes) errors.push(`blank GST types=${controls.blankGstTypes}; expected ${manifest.blankGstTypes}`);
  if (controls.months.length !== 1 || controls.months[0] !== manifest.month) errors.push(`months=${controls.months.join(",")}; expected ${manifest.month}`);
  if (rows.some((row) => row.orderId === manifest.absentOrderId)) errors.push(`${manifest.absentOrderId} must remain absent`);
  if (errors.length) throw new Error(`Reviewed Sep-26 controls refused: ${errors.join("; ")}`);
  return controls;
}

export type SecondaryOrderUploadVerification = {
  uploadId: number;
  sourceFile: string;
  sourceSha256: string;
  sourceBytes: number;
  loadedAt: string;
  metrics: SecondaryOrderUploadMetrics;
} & UploadQualityEvaluation;

type StoredUploadRow = {
  id: number;
  source_file: string;
  source_sha256: string;
  source_bytes: string;
  loaded_at: string;
  verification: SecondaryOrderUploadMetrics | string;
  comparison: UploadQualityEvaluation["comparison"] | string;
  assessment: SecondaryOrderUploadVerification["assessment"];
  material_reasons: string[] | null;
  analytics_status: SecondaryOrderUploadVerification["analyticsStatus"];
  entry_point: string | null;
};
type UploadBaselineRow = {
  id: number;
  verification: SecondaryOrderUploadMetrics | string;
};
type InsertedUploadRow = {
  id: number;
  loaded_at: string;
};
type PoolConnectCallback = NonNullable<Parameters<typeof pool.connect>[0]>;
type SecondaryOrderDbClient = NonNullable<Parameters<PoolConnectCallback>[1]>;

function rate(matched: number, total: number): number {
  return total === 0 ? 0 : matched / total;
}

function parseJsonColumn<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

/** Prompt 56 lineage has `{}` verification by design and is not quality data. */
export function isNormalSecondaryOrderUploadVerification(value: unknown): value is SecondaryOrderUploadMetrics {
  return !!value && typeof value === "object" &&
    typeof (value as Partial<SecondaryOrderUploadMetrics>).rowsParsed === "number" &&
    typeof (value as Partial<SecondaryOrderUploadMetrics>).rowsScanned === "number";
}

async function sourceLineage(filePath: string): Promise<{ sourceSha256: string; sourceBytes: number }> {
  const source = await fs.promises.readFile(filePath);
  return {
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    sourceBytes: source.byteLength,
  };
}

async function resolveStableIdCoverage(ids: Iterable<string>): Promise<StableIdResolution> {
  const distinct = Array.from(new Set(ids));
  if (distinct.length === 0) return { matched: 0, total: 0, rate: 0 };
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM customer_master WHERE id = ANY($1::text[])`,
    [distinct],
  );
  const matched = result.rows.length;
  return { matched, total: distinct.length, rate: rate(matched, distinct.length) };
}

async function recordUploadVerification(
  client: SecondaryOrderDbClient,
  source: { sourceFile: string; sourceSha256: string; sourceBytes: number; sourceId?: string; entryPoint?: string },
  metrics: SecondaryOrderUploadMetrics,
  provenance: { sourceNote?: string; uploadedBy?: string } = {},
): Promise<SecondaryOrderUploadVerification> {
  const baselineResult = await client.query<UploadBaselineRow>(
    `SELECT id, verification
     FROM secondary_order_upload
     WHERE assessment <> 'MATERIAL_REGRESSION'
       -- Prompt 56 is a separate historical lineage feed, not evidence for
       -- the normal Product-Wise uploader's quality baseline.
       AND COALESCE(entry_point, 'load-secondary-orders') = 'load-secondary-orders'
       AND verification ? 'rowsParsed'
     ORDER BY id DESC
     LIMIT 1`,
  );
  const baseline = baselineResult.rows[0];
  const evaluation = evaluateSecondaryOrderUpload(
    metrics,
    baseline
      ? { uploadId: baseline.id, metrics: parseJsonColumn<SecondaryOrderUploadMetrics>(baseline.verification) }
      : null,
  );
  const inserted = await client.query<InsertedUploadRow>(
    `INSERT INTO secondary_order_upload
      (source_file, source_id, entry_point, source_sha256, source_bytes, source_note, uploaded_by, verification, comparison, assessment, material_reasons, analytics_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::text[], $12)
     RETURNING id, loaded_at::text`,
    [
      source.sourceFile,
      source.sourceId ?? null,
      source.entryPoint ?? "load-secondary-orders",
      source.sourceSha256,
       source.sourceBytes, provenance.sourceNote ?? null, provenance.uploadedBy ?? null,
       JSON.stringify(metrics), JSON.stringify(evaluation.comparison),
       evaluation.assessment, evaluation.materialReasons, evaluation.analyticsStatus,
    ],
  );
  const row = inserted.rows[0];
  return { uploadId: row.id, loadedAt: row.loaded_at, ...source, metrics, ...evaluation };
}

export async function getSecondaryOrderUploadHistory(limit = 25): Promise<SecondaryOrderUploadVerification[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const result = await pool.query<StoredUploadRow>(
    `SELECT id, source_file, source_sha256, source_bytes, loaded_at::text, verification, comparison,
            assessment, material_reasons, analytics_status, entry_point
     FROM secondary_order_upload
     WHERE COALESCE(entry_point, 'load-secondary-orders') = 'load-secondary-orders'
       AND verification ? 'rowsParsed'
     ORDER BY id DESC
     LIMIT $1`,
    [safeLimit],
  );
  return result.rows
    .filter((row) => isNormalSecondaryOrderUploadVerification(parseJsonColumn<unknown>(row.verification)))
    .map((row) => ({
    uploadId: row.id,
    sourceFile: row.source_file,
    sourceSha256: row.source_sha256,
    sourceBytes: Number(row.source_bytes),
    loadedAt: row.loaded_at,
    metrics: parseJsonColumn<SecondaryOrderUploadMetrics>(row.verification),
    assessment: row.assessment,
    materialReasons: row.material_reasons ?? [],
    comparison: parseJsonColumn<UploadQualityEvaluation["comparison"]>(row.comparison),
    analyticsStatus: row.analytics_status,
  }));
}

/** Prompt 56 historical-load lineage is intentionally visible, but never fed
 * into normal uploader quality evaluation because it has no stable-ID metrics. */
export type Prompt56OrderLineage = {
  uploadId: number; sourceFile: string; sourceId: string | null;
  sourceSha256: string; sourceBytes: number; loadedAt: string; entryPoint: string | null;
};
export async function getPrompt56OrderLineage(limit = 500): Promise<Prompt56OrderLineage[]> {
  const result = await pool.query<StoredUploadRow & { source_id: string | null }>(
    `SELECT id, source_file, source_id, source_sha256, source_bytes, loaded_at::text,
            verification, comparison, assessment, material_reasons, analytics_status, entry_point
     FROM secondary_order_upload WHERE entry_point = 'load-prompt56-orders'
     ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(Math.floor(limit), 1), 1000)],
  );
  return result.rows.map((r) => ({
    uploadId: r.id, sourceFile: r.source_file, sourceId: r.source_id,
    sourceSha256: r.source_sha256, sourceBytes: Number(r.source_bytes),
    loadedAt: r.loaded_at, entryPoint: r.entry_point,
  }));
}

export type SecondaryOrderUploadReview = {
  uploads: SecondaryOrderUploadVerification[];
  approval: SecondaryOrderAnalyticsApproval;
};

/**
 * Return the operator-facing page of upload records plus the independent
 * evidence-window decision.  Readiness is advisory only; all order-booking
 * consumers remain isolated until a human approval process changes policy.
 */
export async function getSecondaryOrderUploadReview(limit = 25): Promise<SecondaryOrderUploadReview> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const history = await getSecondaryOrderUploadHistory(100);
  return {
    uploads: history.slice(0, safeLimit),
    approval: evaluateSecondaryOrderAnalyticsApproval(history),
  };
}

// ── XLSX file resolution ──────────────────────────────────────────────────────

/**
 * Resolve the path to the secondary order report XLSX.
 * 1. If SOL_XLSX env var is set, use it.
 * 2. Otherwise search attached_assets/ for the known filename prefix.
 * 3. If an absolute path is passed, use it directly.
 */
export function resolveSecondaryOrderXlsx(overridePath?: string): string {
  if (overridePath) {
    if (!path.isAbsolute(overridePath)) throw new Error("overridePath must be absolute");
    if (!fs.existsSync(overridePath)) throw new Error(`File not found: ${overridePath}`);
    return overridePath;
  }
  if (process.env.SOL_XLSX) {
    if (!fs.existsSync(process.env.SOL_XLSX)) throw new Error(`SOL_XLSX not found: ${process.env.SOL_XLSX}`);
    return process.env.SOL_XLSX;
  }
  const PREFIX = "Product-Wise-Secondary-Order-Report_";
  for (const dir of [
    path.resolve(process.cwd(), "attached_assets"),
    path.resolve(process.cwd(), "../../attached_assets"),
  ]) {
    if (!fs.existsSync(dir)) continue;
    const matches = fs.readdirSync(dir)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith(".xlsx"))
      .sort();
    if (matches.length > 0) return path.join(dir, matches[matches.length - 1]);
  }
  throw new Error(`Secondary order report XLSX not found. Set SOL_XLSX env var or place file in attached_assets/${PREFIX}*.xlsx`);
}

// ── Main loader ───────────────────────────────────────────────────────────────

export async function loadSecondaryOrders(
  opts: {
    filePath?: string;
    dryRun?: boolean;
    sourceNote?: string;
    uploadedBy?: string;
    declaredSourceFile?: string;
    expectedSha?: string;
  } = {},
): Promise<LoadResult> {
  const filePath = resolveSecondaryOrderXlsx(opts.filePath);
  const localSourceFile = path.basename(filePath);
  const sourceFile = opts.declaredSourceFile?.trim() || localSourceFile;
  const dryRun = opts.dryRun ?? false;
  const { sourceSha256, sourceBytes } = await sourceLineage(filePath);
  if (opts.expectedSha && sourceSha256 !== opts.expectedSha) {
    throw new Error(`Workbook SHA ${sourceSha256} does not match expected SHA ${opts.expectedSha}.`);
  }
  const manifest = resolveApprovedProductWiseManifest(sourceSha256);

  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "ignore",
    hyperlinks: "ignore",
    worksheets: "emit",
  });

  // Collect all rows first for batch processing
  type RawRow = {
    orderId: string;
    orderDatetime: Date;
    orderStatus: string;
    salesUserName: string | null;
    customerName: string | null;
    dealerId: string;
    dealerMobile: string | null;
    cpName: string | null;
    cpCode: string;
    state: string | null;
    district: string | null;
    city: string | null;
    cityRaw: string;
    pincode: string | null;
    categoryName: string | null;
    segmentCanon: string | null;
    productCode: string;
    gstType: string | null;
    gstTypeRaw: string;
    gstPct: number | null;
    gstAmount: number | null;
    qty: number | null;
    discountPct: number | null;
    discountAmount: number | null;
    dealerOrderValue: number | null;
    basicOrderValue: number | null;
    dealerOrderValueIncl: number | null;
    occurrence: number;
    sourceRowNumber: number;
    contentHash: string;
    isExactDuplicateExport: boolean;
  };

  const rows: RawRow[] = [];
  let colIdx: ProductWiseColumnIndexes | null = null;
  let rowsScanned = 0;
  let rowsRejected = 0;
  const unmappedCategories = new Set<string>();
  const unresolvedRawUsers = new Set<string>();

  for await (const worksheet of workbook) {
    for await (const row of worksheet) {
      const values = ((row.values as unknown[]) ?? []).slice(1); // exceljs 1-indexes values[0]=null

      // Header row detection
      if (colIdx === null) {
        colIdx = resolveProductWiseHeaders(values.map((v) => toText(v) ?? ""));
        continue;
      }

      rowsScanned++;

      const at = (column: keyof ProductWiseColumnIndexes) => colIdx?.[column] === undefined ? null : values[colIdx[column]!];
      const orderId = toText(at("orderId"));
      const productCode = toText(at("productCode"));
      const dealerId = toText(at("retailerId"));
      const cpCode = toText(at("distributorCode"));
      const rawDatetime = parseOrderDatetime(at("date"));

      if (!orderId || !productCode || !dealerId || !cpCode || !rawDatetime) {
        rowsRejected++;
        continue; // skip malformed rows
      }

      const orderStatus = toText(at("orderStatus")) ?? "PENDING";
      const salesUserName = toText(at("salesUserName"));
      const categoryName = toText(at("categoryName"));
      const dealerOrderValueIncl = toNum(at("dealerOrderValueIncl"));
      const basicOrderValue = toNum(at("basicOrderValue"));
      const gstAmount = toNum(at("gstAmount"));
      const cityRaw = toRawSourceText(at("city"));
      const gstTypeRaw = toRawSourceText(at("gstType"));
      const city = normalizeProductWiseNullableText(at("city"));
      const gstType = normalizeProductWiseNullableText(at("gstType"));

      if (salesUserName && !unresolvedRawUsers.has(salesUserName)) {
        unresolvedRawUsers.add(salesUserName); // collect for resolution pass
      }

      const segmentCanon = categoryName ? canonGroupFromMap(categoryName) : null;
      if (categoryName && !segmentCanon) unmappedCategories.add(categoryName);

      const sourceRowNumber = rowsScanned + 1; // worksheet rows are header + data
      const hashParts = [
         rawDatetime.toISOString(), orderStatus, salesUserName, toText(at("retailerName")),
         dealerId, toText(at("retailerMobile")), toText(at("distributorName")), cpCode,
        toText(at("state")), toText(at("district")), city, cityRaw,
        toText(at("pincode")), categoryName, productCode, gstType, gstTypeRaw, toNum(at("gstPct")),
         gstAmount, toNum(at("qty")), parseDiscountPct(at("discountPct")),
         toNum(at("discountAmount")), dealerOrderValueIncl, basicOrderValue,
      ];
      rows.push({
        orderId,
        orderDatetime: rawDatetime,
        orderStatus,
        salesUserName,
         customerName: toText(at("retailerName")),
        dealerId,
         dealerMobile: toText(at("retailerMobile")),
         cpName: toText(at("distributorName")),
        cpCode,
         state: toText(at("state")),
         district: toText(at("district")),
         city,
         cityRaw,
         pincode: toText(at("pincode")),
        categoryName,
        segmentCanon,
        productCode,
         gstType,
         gstTypeRaw,
         gstPct: toNum(at("gstPct")),
         gstAmount,
         qty: toNum(at("qty")),
         discountPct: parseDiscountPct(at("discountPct")),
         discountAmount: toNum(at("discountAmount")),
         dealerOrderValue: dealerOrderValueIncl,
         basicOrderValue,
         dealerOrderValueIncl,
        occurrence: 0,
        sourceRowNumber,
        contentHash: createHash("sha256").update(JSON.stringify(hashParts)).digest("hex"),
        isExactDuplicateExport: false,
      });
    }
    break; // first sheet only
  }

  if (!colIdx) throw new Error("No header row found in secondary order report XLSX");
  if (rows.length === 0) throw new Error("Secondary order report contains no valid data rows");
  const semanticValidation = validateProductWiseValues(rows);
  // Must happen before any DB transaction/insert: Product-Wise is only valid
  // from its CRM-era start. There is deliberately no upper bound here.
  assertProductWiseEraStart(rows);

  // Assign source-position occurrences and make repeated pairs visible. The
  // line hash prevents an exact repeated export row from becoming invisible.
  const pairGroups = new Map<string, RawRow[]>();
  for (const row of rows) {
    const key = `${row.orderId}\u0000${row.productCode}`;
    const group = pairGroups.get(key) ?? [];
    row.occurrence = group.length + 1;
    group.push(row);
    pairGroups.set(key, group);
  }
  const sourcePairCollisions: SourcePairCollision[] = [];
  const exactDuplicateExportRows: LoadResult["exactDuplicateExportRows"] = [];
  for (const group of pairGroups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    const identical = group.every((row) => row.contentHash === first.contentHash);
    if (identical) {
      for (const row of group.slice(1)) {
        row.isExactDuplicateExport = true;
        exactDuplicateExportRows.push({
          orderId: row.orderId,
          productCode: row.productCode,
          qty: row.qty,
          basicOrderValue: row.basicOrderValue,
        });
      }
    }
    sourcePairCollisions.push({
      orderId: first.orderId,
      productCode: first.productCode,
      identical,
      occurrences: group.map((row) => ({
        occurrence: row.occurrence,
        sourceRowNumber: row.sourceRowNumber,
        qty: row.qty,
        discountPct: row.discountPct,
        basicOrderValue: row.basicOrderValue,
        dealerOrderValue: row.dealerOrderValue,
      })),
    });
  }
  const exactDuplicateWarning = rows.length > 0 && exactDuplicateExportRows.length / rows.length > 0.005;
  const rowsByMonth = new Map<string, RawRow[]>();
  for (const row of rows) {
    const month = indiaMonthLabel(row.orderDatetime);
    assertGenericProductWiseOrderMonth(month);
    const monthRows = rowsByMonth.get(month) ?? [];
    monthRows.push(row);
    rowsByMonth.set(month, monthRows);
  }
  const sep26Controls = assertPrompt121Sep26Controls(rows, rowsScanned, rowsRejected, sourceSha256);

  // Resolve sales user IDs in bulk
  const persons = await getPersons();
  const nameToPersonId = new Map<string, number | null>();
  for (const rawName of unresolvedRawUsers) {
    const key = normSecKey(rawName);
    const matches = persons.filter((p) => normSecKey(p.name) === key);
    nameToPersonId.set(rawName, matches.length === 1 ? matches[0].person_id : null);
  }

  // Determine which sales users were unresolved
  const unresolvedSalesUsers: string[] = [];
  for (const [name, id] of nameToPersonId) {
    if (id === null) unresolvedSalesUsers.push(name);
  }

  const [retailerResolution, distributorResolution] = await Promise.all([
    resolveStableIdCoverage(rows.map((row) => row.dealerId)),
    resolveStableIdCoverage(rows.map((row) => row.cpCode)),
  ]);
  const personTotal = nameToPersonId.size;
  const personMatched = Array.from(nameToPersonId.values()).filter((id) => id != null).length;

  if (dryRun) {
    logger.info({ rowsScanned, rowsParsed: rows.length, dryRun: true }, "[secondaryOrders] dry run complete");
    return {
      rowsScanned,
      rowsParsed: rows.length,
      rowsRejected,
      rowsInserted: 0,
      rowsSkipped: 0,
      collisions: [],
      sourcePairCollisions,
      exactDuplicateExportRows,
      exactDuplicateWarning,
      unresolvedSalesUsers,
      unmappedCategories: Array.from(unmappedCategories),
      sourceFile,
      sourceSha256,
      sourceBytes,
      semanticValidation,
      sep26Controls,
    };
  }

  // ── Upsert rows with collision detection ─────────────────────────────────
  // Strategy: INSERT ... ON CONFLICT DO NOTHING for idempotent rows.
  // For each conflict, compare stored vs incoming and report if different.

  let rowsInserted = 0;
  let rowsSkipped = 0;
  let rowsRemoved = 0;
  const collisions: CollisionDetail[] = [];
  const changedLineIdentityKeys = new Set<string>();

  // A source file and its ledger entry form one unit of evidence. The advisory
  // lock serializes baseline selection; the single transaction guarantees a
  // failed write never leaves lines that lack source-file verification.
  let uploadVerification: SecondaryOrderUploadVerification;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('secondary_order_upload'))`);

    for (const [month, monthRows] of rowsByMonth) {
      const monthPlan = productWiseOrderMonthPlan({
        month,
        incoming: monthRows.map((row) => ({ orderId: row.orderId, productCode: row.productCode, occurrence: row.occurrence })),
        existing: [],
      });
      if (monthPlan.action === "frozen") {
        throw new Error(`Product-Wise ${month} replacement is frozen from ${monthPlan.freezeAt?.toISOString()}.`);
      }
      if (monthPlan.freezeAt?.toISOString() !== new Date(manifest.freezeAt).toISOString()) {
        throw new Error(`Approved manifest ${manifest.version} freeze window does not match the Product-Wise month policy.`);
      }
      const existingManifest = await client.query<{
        max_order_datetime: Date | null;
        completeness: string[];
        manifest_ids: string[];
        manifest_shas: string[];
      }>(
        `SELECT MAX(order_datetime) AS max_order_datetime,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT period_completeness), NULL) AS completeness,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT manifest_id), NULL) AS manifest_ids,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT manifest_sha256), NULL) AS manifest_shas
           FROM secondary_order_line
          WHERE source_era = 'product_wise_crm' AND source_kind = 'product_wise'
            AND order_datetime >= $1 AND order_datetime < $2`,
        [monthPlan.startUtc, monthPlan.endUtc],
      );
      const existing = existingManifest.rows[0];
      assertManifestReplacementAllowed({
        incomingCutoff: new Date(manifest.cutoff),
        incomingCompleteness: manifest.completeness,
        incomingManifestId: manifest.version,
        incomingSha256: sourceSha256,
        existingMaxOrderDatetime: existing?.max_order_datetime ?? null,
        existingCompleteness: existing?.completeness ?? [],
        existingManifestIds: existing?.manifest_ids ?? [],
        existingManifestShas: existing?.manifest_shas ?? [],
      });
      if (month !== "Sep-26" || monthRows.some((row) => indiaMonthLabel(row.orderDatetime) !== month)) {
        throw new Error(`Reviewed Sep-26 replacement received an unintended month: ${month}.`);
      }
      const outsideTarget = await client.query<{ count: string }>(
        `WITH incoming(order_id, product_code, occurrence) AS (
           SELECT * FROM UNNEST($3::text[], $4::text[], $5::int[])
         )
         SELECT COUNT(*)::text AS count
           FROM secondary_order_line sol
           JOIN incoming i USING (order_id, product_code, occurrence)
          WHERE sol.source_era = 'product_wise_crm'
            AND sol.source_kind = 'product_wise'
            AND NOT (sol.order_datetime >= $1 AND sol.order_datetime < $2)`,
        [
          monthPlan.startUtc,
          monthPlan.endUtc,
          monthRows.map((row) => row.orderId),
          monthRows.map((row) => row.productCode),
          monthRows.map((row) => row.occurrence),
        ],
      );
      if (Number(outsideTarget.rows[0]?.count ?? 0) > 0) {
        throw new Error("Reviewed Sep-26 controls refused: an incoming Product-Wise identity already exists outside the target Sep-26 bounds.");
      }
      const overlap = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM secondary_order_line
          WHERE order_id = ANY($1::text[])
            AND source_era = 'product_wise_crm'
            AND source_kind = 'product_wise'
            AND order_datetime >= $2 AND order_datetime < $3`,
        [
          monthRows.map((row) => row.orderId),
          productWiseOrderMonthPlan({ month: "Aug-26", incoming: [], existing: [] }).startUtc,
          monthPlan.startUtc,
        ],
      );
      if (Number(overlap.rows[0]?.count ?? 0) > 0) {
        throw new Error("Reviewed Sep-26 controls refused: an incoming order ID overlaps an existing Aug-26 Product-Wise order.");
      }
      const removed = await client.query(
        `DELETE FROM secondary_order_line
          WHERE source_era = 'product_wise_crm'
            AND source_kind = 'product_wise'
            AND order_datetime >= $1 AND order_datetime < $2
          RETURNING id`,
        [monthPlan.startUtc, monthPlan.endUtc],
      );
      rowsRemoved += removed.rowCount ?? 0;
    }

    for (const r of rows) {
        const salesUserId = r.salesUserName ? (nameToPersonId.get(r.salesUserName) ?? null) : null;

        const result = await client.query<{ id: number }>(
          `INSERT INTO secondary_order_line
              (source_era, source_kind, fiscal_year, period_completeness, source_id, manifest_id, manifest_sha256,
               order_id, order_datetime, order_status, sales_user_name, sales_user_id,
              customer_name, dealer_id, dealer_mobile, cp_name, cp_code,
               state, district, city, city_raw, pincode,
             category_name, segment_canon, product_code, occurrence, source_row_number,
             content_hash, is_exact_duplicate_export,
               gst_type, gst_type_raw, gst_pct, gst_amount, qty, discount_pct, discount_amount,
              dealer_order_value, basic_order_value, source_file)
           VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
                $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37,
                $38, $39)
           RETURNING id`,
          [
            "product_wise_crm", "product_wise",
             fiscalYearFromDate(r.orderDatetime), manifest.completeness, sourceFile, manifest.version, sourceSha256,
             r.orderId, r.orderDatetime, r.orderStatus, r.salesUserName, salesUserId,
            r.customerName, r.dealerId, r.dealerMobile, r.cpName, r.cpCode,
             r.state, r.district, r.city, r.cityRaw, r.pincode,
            r.categoryName, r.segmentCanon, r.productCode, r.occurrence, r.sourceRowNumber,
            r.contentHash, r.isExactDuplicateExport,
             r.gstType, r.gstTypeRaw, r.gstPct, r.gstAmount, r.qty, r.discountPct, r.discountAmount,
             r.dealerOrderValue, r.basicOrderValue, sourceFile,
          ],
        );

        if (result.rowCount && result.rowCount > 0) {
          rowsInserted++;
        } else {
          // Check for collision: does the stored row have different values?
          const existing = await client.query<{
            order_status: string;
            qty: string | null;
            basic_order_value: string | null;
            dealer_order_value: string | null;
            discount_pct: string | null;
            content_hash: string;
          }>(
            `SELECT order_status, qty, basic_order_value, dealer_order_value, discount_pct, content_hash
             FROM secondary_order_line
              WHERE source_era = 'product_wise_crm'
                AND order_id = $1 AND product_code = $2 AND occurrence = $3`,
            [r.orderId, r.productCode, r.occurrence],
          );
          if (existing.rows.length > 0) {
            const ex = existing.rows[0];
            const checks: Array<[string, string | null, string | null]> = [
              ["order_status", ex.order_status, r.orderStatus],
              ["qty", ex.qty, r.qty != null ? String(r.qty) : null],
              ["basic_order_value", ex.basic_order_value, r.basicOrderValue != null ? String(r.basicOrderValue) : null],
              ["dealer_order_value", ex.dealer_order_value, r.dealerOrderValue != null ? String(r.dealerOrderValue) : null],
              ["discount_pct", ex.discount_pct, r.discountPct != null ? String(r.discountPct) : null],
            ];
            let hasDiff = false;
            for (const [field, stored, incoming] of checks) {
              const storedNum = stored != null ? Number(stored) : null;
              const incomingNum = incoming != null ? Number(incoming) : null;
              const different = field === "order_status"
                ? stored !== incoming
                : (storedNum !== incomingNum && !(stored == null && incoming == null));
              if (different) {
                hasDiff = true;
                changedLineIdentityKeys.add(`${r.orderId}\u0000${r.productCode}\u0000${r.occurrence}`);
                collisions.push({ orderId: r.orderId, productCode: r.productCode, field, stored, incoming });
              }
            }
            if (ex.content_hash !== r.contentHash) {
              collisions.push({
                orderId: r.orderId,
                productCode: r.productCode,
                field: "content_hash",
                stored: ex.content_hash,
                incoming: r.contentHash,
              });
              hasDiff = true;
              changedLineIdentityKeys.add(`${r.orderId}\u0000${r.productCode}\u0000${r.occurrence}`);
            }
            if (!hasDiff) rowsSkipped++;
          } else {
            rowsSkipped++;
          }
        }
    }

    const reviewed = await client.query<{
      rows: string; orders: string; date_min: Date; date_max: Date;
      basic: string; inclusive: string; gst: string; retailers: string;
      distributors: string; codes: string; sales_users: string;
      statuses: string[]; discount_min: string; discount_median: string;
      discount_max: string; discount_nulls: string; absent: string;
    }>(
      `SELECT COUNT(*)::text AS rows, COUNT(DISTINCT order_id)::text AS orders,
              MIN(order_datetime) AS date_min, MAX(order_datetime) AS date_max,
              COALESCE(SUM(basic_order_value), 0)::text AS basic,
              COALESCE(SUM(dealer_order_value), 0)::text AS inclusive,
              COALESCE(SUM(gst_amount), 0)::text AS gst,
              COUNT(DISTINCT dealer_id)::text AS retailers,
              COUNT(DISTINCT cp_code)::text AS distributors,
              COUNT(DISTINCT product_code)::text AS codes,
              COUNT(DISTINCT sales_user_name)::text AS sales_users,
              ARRAY_AGG(DISTINCT order_status) AS statuses,
              MIN(discount_pct)::text AS discount_min,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY discount_pct)::text AS discount_median,
              MAX(discount_pct)::text AS discount_max,
              COUNT(*) FILTER (WHERE discount_pct IS NULL)::text AS discount_nulls,
              COUNT(*) FILTER (WHERE order_id = 'SORD-161782')::text AS absent
         FROM secondary_order_line
        WHERE source_era = 'product_wise_crm' AND source_kind = 'product_wise'
          AND order_datetime >= $1 AND order_datetime < $2`,
      [productWiseOrderMonthPlan({ month: "Sep-26", incoming: [], existing: [] }).startUtc,
        productWiseOrderMonthPlan({ month: "Sep-26", incoming: [], existing: [] }).endUtc],
    );
    const checked = reviewed.rows[0];
    const reviewedNumbersMatch = checked &&
      Number(checked.rows) === sep26Controls.rows &&
      Number(checked.orders) === sep26Controls.orders &&
      Number(checked.retailers) === sep26Controls.retailers &&
      Number(checked.distributors) === sep26Controls.distributors &&
      Number(checked.codes) === sep26Controls.codes &&
      Number(checked.sales_users) === sep26Controls.salesUsers &&
      Math.abs(Number(checked.basic) - sep26Controls.basic) <= manifest.valueToleranceCents &&
      Math.abs(Number(checked.inclusive) - sep26Controls.inclusive) <= manifest.valueToleranceCents &&
      Math.abs(Number(checked.gst) - sep26Controls.gst) <= manifest.valueToleranceCents &&
      Number(checked.discount_min) === sep26Controls.discountMin &&
      Number(checked.discount_median) === sep26Controls.discountMedian &&
      Number(checked.discount_max) === sep26Controls.discountMax &&
      Number(checked.discount_nulls) === sep26Controls.discountNulls &&
      Number(checked.absent) === 0 &&
      JSON.stringify((checked.statuses ?? []).slice().sort()) === JSON.stringify(sep26Controls.statuses);
    if (!reviewedNumbersMatch || checked.date_min.getTime() !== Date.parse(manifest.dateMin) || checked.date_max.getTime() !== Date.parse(manifest.dateMax)) {
      throw new Error("Reviewed Sep-26 controls refused: post-insert authoritative secondary_order_line controls do not match the approved manifest.");
    }

    const repeatedPairRows = sourcePairCollisions.reduce((total, pair) => total + pair.occurrences.length, 0);
    const metrics: SecondaryOrderUploadMetrics = {
      rowsScanned,
      rowsParsed: rows.length,
      rowsRejected,
      retailerResolution,
      distributorResolution,
      personResolution: {
        matched: personMatched,
        total: personTotal,
        rate: rate(personMatched, personTotal),
      },
      repeatedPairCount: sourcePairCollisions.length,
      repeatedPairRows,
      repeatedPairRate: rate(repeatedPairRows, rows.length),
      exactDuplicateRows: exactDuplicateExportRows.length,
      exactDuplicateRate: rate(exactDuplicateExportRows.length, rows.length),
      changedLineCollisionCount: changedLineIdentityKeys.size,
      changedLineCollisionRate: rate(changedLineIdentityKeys.size, rows.length),
    };
    uploadVerification = await recordUploadVerification(
      client,
      { sourceFile, sourceSha256, sourceBytes, sourceId: sourceFile, entryPoint: "load-secondary-orders" },
      metrics,
      { sourceNote: opts.sourceNote, uploadedBy: opts.uploadedBy },
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  logger.info(
    {
      rowsScanned,
      rowsParsed: rows.length,
      rowsInserted,
      rowsSkipped,
      collisions: collisions.length,
      assessment: uploadVerification.assessment,
      sourceFile,
      localSourceFile,
    },
    "[secondaryOrders] load complete",
  );
  await invalidateProductWiseOrderSnapshots();

  return {
    rowsScanned,
    rowsParsed: rows.length,
    rowsRejected,
    rowsInserted,
    rowsSkipped,
    collisions,
    sourcePairCollisions,
    exactDuplicateExportRows,
    exactDuplicateWarning,
    unresolvedSalesUsers,
    unmappedCategories: Array.from(unmappedCategories),
    sourceFile,
    sourceSha256,
    sourceBytes,
    rowsRemoved,
    sep26Controls,
    uploadVerification,
  };
}

// ── Verification helper ───────────────────────────────────────────────────────

export type VerificationResult = {
  rowsLoaded: number;
  distinctOrders: number;
  distinctRetailers: number;
  distinctDistributors: number;
  distinctProductCodes: number;
  dateMin: string | null;
  dateMax: string | null;
  totalQty: number;
  totalBasic: number;
  totalDealer: number;
  statusSplit: Record<string, number>;
  dealerJoin: { matched: number; total: number; pct: string; unmatched: string[] };
  cpJoin: { matched: number; total: number; pct: string; unmatched: string[] };
  salesUserResolution: { matched: number; total: number; pct: string; unmatched: string[] };
  categoryMapping: Array<{ category: string; segmentCanon: string | null }>;
  unmappedCategoryCount: number;
  exactDuplicateExportRows: Array<{
    order_id: string; product_code: string; qty: string; basic_order_value: string;
  }>;
  exactDuplicateWarning: boolean;
  discountAbove90: Array<{
    order_id: string; dealer_id: string; product_code: string;
    qty: string; basic_order_value: string; discount_pct: string;
  }>;
  secondarySkuLineCount: number;
  secondaryRegisterLineCount: number;
  saleLineCount: number;
};

export async function verifySecondaryOrders(): Promise<VerificationResult> {
  const [
    totals,
    statusSplit,
    dealerJoin,
    cpJoin,
    userResolution,
    catMapping,
    discountLines,
    exactDuplicateRows,
    otherCounts,
  ] = await Promise.all([
    pool.query<{
      rows_loaded: string; distinct_orders: string; distinct_retailers: string;
      distinct_distributors: string; distinct_codes: string;
      date_min: string; date_max: string;
      total_qty: string; total_basic: string; total_dealer: string;
    }>(`
      SELECT
        COUNT(*)                             AS rows_loaded,
        COUNT(DISTINCT order_id)             AS distinct_orders,
        COUNT(DISTINCT dealer_id)            AS distinct_retailers,
        COUNT(DISTINCT cp_code)              AS distinct_distributors,
        COUNT(DISTINCT product_code)         AS distinct_codes,
        MIN((order_datetime AT TIME ZONE 'Asia/Kolkata')::date)::text AS date_min,
        MAX((order_datetime AT TIME ZONE 'Asia/Kolkata')::date)::text AS date_max,
        COALESCE(SUM(qty::numeric),0)::text          AS total_qty,
        COALESCE(SUM(basic_order_value::numeric),0)::text  AS total_basic,
        COALESCE(SUM(dealer_order_value::numeric),0)::text AS total_dealer
      FROM secondary_order_line
    `),
    pool.query<{ order_status: string; cnt: string }>(
      `SELECT order_status, COUNT(*) AS cnt FROM secondary_order_line GROUP BY order_status`,
    ),
    pool.query<{ matched: string; total: string; unmatched_ids: string[] }>(`
      SELECT
        COUNT(DISTINCT sol.dealer_id) FILTER (WHERE cm.id IS NOT NULL)::text AS matched,
        COUNT(DISTINCT sol.dealer_id)::text AS total,
        array_agg(DISTINCT sol.dealer_id) FILTER (WHERE cm.id IS NULL) AS unmatched_ids
      FROM secondary_order_line sol
      LEFT JOIN customer_master cm ON cm.id = sol.dealer_id
    `),
    pool.query<{ matched: string; total: string; unmatched_ids: string[] }>(`
      SELECT
        COUNT(DISTINCT sol.cp_code) FILTER (WHERE cm.id IS NOT NULL)::text AS matched,
        COUNT(DISTINCT sol.cp_code)::text AS total,
        array_agg(DISTINCT sol.cp_code) FILTER (WHERE cm.id IS NULL) AS unmatched_ids
      FROM secondary_order_line sol
      LEFT JOIN customer_master cm ON cm.id = sol.cp_code
    `),
    pool.query<{ matched: string; total: string; unmatched_names: string[] }>(`
      SELECT
        COUNT(DISTINCT sol.sales_user_name) FILTER (WHERE p.person_id IS NOT NULL)::text AS matched,
        COUNT(DISTINCT sol.sales_user_name) FILTER (WHERE sol.sales_user_name IS NOT NULL)::text AS total,
        array_agg(DISTINCT sol.sales_user_name) FILTER (WHERE p.person_id IS NULL AND sol.sales_user_name IS NOT NULL) AS unmatched_names
      FROM secondary_order_line sol
      LEFT JOIN person p ON p.person_id = sol.sales_user_id
    `),
    pool.query<{ category_name: string; segment_canon: string | null }>(
      `SELECT DISTINCT category_name, segment_canon FROM secondary_order_line ORDER BY category_name`,
    ),
    pool.query<{ order_id: string; dealer_id: string; product_code: string; qty: string; basic_order_value: string; discount_pct: string }>(
      `SELECT order_id, dealer_id, product_code, qty::text, basic_order_value::text, discount_pct::text
       FROM secondary_order_line WHERE discount_pct::numeric > 90
       ORDER BY discount_pct::numeric DESC LIMIT 200`,
    ),
    pool.query<{ order_id: string; product_code: string; qty: string; basic_order_value: string }>(
      `SELECT order_id, product_code, qty::text, basic_order_value::text
       FROM secondary_order_line
       WHERE is_exact_duplicate_export
       ORDER BY order_id, product_code, occurrence`,
    ),
    pool.query<{ ssl: string; srl: string; sl: string }>(`
      SELECT
        (SELECT COUNT(*) FROM secondary_sku_line)::text AS ssl,
        (SELECT COUNT(*) FROM secondary_register_line)::text AS srl,
        (SELECT COUNT(*) FROM sale_line_all)::text AS sl
    `),
  ]);

  const t = totals.rows[0];
  const statusMap: Record<string, number> = {};
  for (const r of statusSplit.rows) statusMap[r.order_status] = Number(r.cnt);

  const dj = dealerJoin.rows[0];
  const djPct = dj.total === "0" ? "0%" : `${(Number(dj.matched) / Number(dj.total) * 100).toFixed(1)}%`;

  const cp = cpJoin.rows[0];
  const cpPct = cp.total === "0" ? "0%" : `${(Number(cp.matched) / Number(cp.total) * 100).toFixed(1)}%`;

  const ur = userResolution.rows[0];
  const urPct = ur.total === "0" ? "0%" : `${(Number(ur.matched) / Number(ur.total) * 100).toFixed(1)}%`;

  const unmappedCats = catMapping.rows.filter((r) => r.segment_canon == null).length;

  const oc = otherCounts.rows[0];

  return {
    rowsLoaded: Number(t.rows_loaded),
    distinctOrders: Number(t.distinct_orders),
    distinctRetailers: Number(t.distinct_retailers),
    distinctDistributors: Number(t.distinct_distributors),
    distinctProductCodes: Number(t.distinct_codes),
    dateMin: t.date_min ?? null,
    dateMax: t.date_max ?? null,
    totalQty: Number(t.total_qty),
    totalBasic: Number(t.total_basic),
    totalDealer: Number(t.total_dealer),
    statusSplit: statusMap,
    dealerJoin: {
      matched: Number(dj.matched),
      total: Number(dj.total),
      pct: djPct,
      unmatched: dj.unmatched_ids ?? [],
    },
    cpJoin: {
      matched: Number(cp.matched),
      total: Number(cp.total),
      pct: cpPct,
      unmatched: cp.unmatched_ids ?? [],
    },
    salesUserResolution: {
      matched: Number(ur.matched),
      total: Number(ur.total),
      pct: urPct,
      unmatched: ur.unmatched_names ?? [],
    },
    categoryMapping: catMapping.rows.map((r) => ({
      category: r.category_name,
      segmentCanon: r.segment_canon,
    })),
    unmappedCategoryCount: unmappedCats,
    exactDuplicateExportRows: exactDuplicateRows.rows,
    exactDuplicateWarning: Number(t.rows_loaded) > 0 &&
      exactDuplicateRows.rows.length / Number(t.rows_loaded) > 0.005,
    discountAbove90: discountLines.rows,
    secondarySkuLineCount: Number(oc.ssl),
    secondaryRegisterLineCount: Number(oc.srl),
    saleLineCount: Number(oc.sl),
  };
}
