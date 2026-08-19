/**
 * Secondary Order Report XLSX loader.
 *
 * Streams the Product-Wise Secondary Order Report and upserts rows into
 * secondary_order_line.  Idempotent: re-uploading the same file produces
 * the same row count.  Collisions (same unique pair with different stored
 * values) are reported and NOT silently overwritten.
 *
 * IMPORTANT: This is ORDER BOOKING data, not dispatch.  Never sum or compare
 * with secondary_sku_line, secondary_register_line, or sale_line.
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
import {
  evaluateSecondaryOrderAnalyticsApproval,
  evaluateSecondaryOrderUpload,
  type StableIdResolution,
  type SecondaryOrderUploadMetrics,
  type SecondaryOrderAnalyticsApproval,
  type UploadQualityEvaluation,
} from "./uploadQuality.js";

// ── Expected column headers (exact, in column order) ─────────────────────────
const EXPECTED_HEADERS = [
  "Date",
  "Order ID",
  "Sales User Name",
  "Customer Name",
  "Dealer ID",
  "Dealer Mobile",
  "Channel Partner Name",
  "CP Code",
  "State",
  "District",
  "City",
  "Pincode",
  "Category Name",
  "Product Code",
  "GST (%)",
  "GST Amount",
  "Qty",
  "Discount (%)",
  "Discount Amount",
  "Dealer Order Value",
  "Basic Order Value",
  "Order Status",
] as const;

type ColIndex = {
  date: number;
  orderId: number;
  salesUserName: number;
  customerName: number;
  dealerId: number;
  dealerMobile: number;
  cpName: number;
  cpCode: number;
  state: number;
  district: number;
  city: number;
  pincode: number;
  categoryName: number;
  productCode: number;
  gstPct: number;
  gstAmount: number;
  qty: number;
  discountPct: number;
  discountAmount: number;
  dealerOrderValue: number;
  basicOrderValue: number;
  orderStatus: number;
};

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
function parseOrderDatetime(v: unknown): Date | null {
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
  // Fallback: try ISO
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
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
  uploadVerification?: SecondaryOrderUploadVerification;
};

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
  source: { sourceFile: string; sourceSha256: string; sourceBytes: number },
  metrics: SecondaryOrderUploadMetrics,
): Promise<SecondaryOrderUploadVerification> {
  const baselineResult = await client.query<UploadBaselineRow>(
    `SELECT id, verification
     FROM secondary_order_upload
     WHERE assessment <> 'MATERIAL_REGRESSION'
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
      (source_file, source_sha256, source_bytes, verification, comparison, assessment, material_reasons, analytics_status)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::text[], $8)
     RETURNING id, loaded_at::text`,
    [
      source.sourceFile,
      source.sourceSha256,
      source.sourceBytes,
      JSON.stringify(metrics),
      JSON.stringify(evaluation.comparison),
      evaluation.assessment,
      evaluation.materialReasons,
      evaluation.analyticsStatus,
    ],
  );
  const row = inserted.rows[0];
  return { uploadId: row.id, loadedAt: row.loaded_at, ...source, metrics, ...evaluation };
}

export async function getSecondaryOrderUploadHistory(limit = 25): Promise<SecondaryOrderUploadVerification[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const result = await pool.query<StoredUploadRow>(
    `SELECT id, source_file, source_sha256, source_bytes, loaded_at::text, verification, comparison,
            assessment, material_reasons, analytics_status
     FROM secondary_order_upload
     ORDER BY id DESC
     LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map((row) => ({
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
  } = {},
): Promise<LoadResult> {
  const filePath = resolveSecondaryOrderXlsx(opts.filePath);
  const sourceFile = path.basename(filePath);
  const dryRun = opts.dryRun ?? false;
  const { sourceSha256, sourceBytes } = await sourceLineage(filePath);

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
    pincode: string | null;
    categoryName: string | null;
    segmentCanon: string | null;
    productCode: string;
    gstPct: number | null;
    gstAmount: number | null;
    qty: number | null;
    discountPct: number | null;
    discountAmount: number | null;
    dealerOrderValue: number | null;
    basicOrderValue: number | null;
    occurrence: number;
    sourceRowNumber: number;
    contentHash: string;
    isExactDuplicateExport: boolean;
  };

  const rows: RawRow[] = [];
  let colIdx: ColIndex | null = null;
  let rowsScanned = 0;
  let rowsRejected = 0;
  const unmappedCategories = new Set<string>();
  const unresolvedRawUsers = new Set<string>();

  for await (const worksheet of workbook) {
    for await (const row of worksheet) {
      const values = ((row.values as unknown[]) ?? []).slice(1); // exceljs 1-indexes values[0]=null

      // Header row detection
      if (colIdx === null) {
        const headers = values.map((v) => toText(v) ?? "");
        // Validate exact header shape
        for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
          if (headers[i] !== EXPECTED_HEADERS[i]) {
            throw new Error(
              `Secondary order report header mismatch at column ${i + 1}: ` +
              `expected "${EXPECTED_HEADERS[i]}", got "${headers[i]}"`,
            );
          }
        }
        colIdx = {
          date: 0, orderId: 1, salesUserName: 2, customerName: 3, dealerId: 4,
          dealerMobile: 5, cpName: 6, cpCode: 7, state: 8, district: 9, city: 10,
          pincode: 11, categoryName: 12, productCode: 13, gstPct: 14, gstAmount: 15,
          qty: 16, discountPct: 17, discountAmount: 18, dealerOrderValue: 19,
          basicOrderValue: 20, orderStatus: 21,
        };
        continue;
      }

      rowsScanned++;

      const orderId = toText(values[colIdx.orderId]);
      const productCode = toText(values[colIdx.productCode]);
      const dealerId = toText(values[colIdx.dealerId]);
      const cpCode = toText(values[colIdx.cpCode]);
      const rawDatetime = parseOrderDatetime(values[colIdx.date]);

      if (!orderId || !productCode || !dealerId || !cpCode || !rawDatetime) {
        rowsRejected++;
        continue; // skip malformed rows
      }

      const orderStatus = toText(values[colIdx.orderStatus]) ?? "PENDING";
      const salesUserName = toText(values[colIdx.salesUserName]);
      const categoryName = toText(values[colIdx.categoryName]);

      if (salesUserName && !unresolvedRawUsers.has(salesUserName)) {
        unresolvedRawUsers.add(salesUserName); // collect for resolution pass
      }

      const segmentCanon = categoryName ? canonGroupFromMap(categoryName) : null;
      if (categoryName && !segmentCanon) unmappedCategories.add(categoryName);

      const sourceRowNumber = rowsScanned + 1; // worksheet rows are header + data
      const hashParts = [
        rawDatetime.toISOString(), orderStatus, salesUserName, toText(values[colIdx.customerName]),
        dealerId, toText(values[colIdx.dealerMobile]), toText(values[colIdx.cpName]), cpCode,
        toText(values[colIdx.state]), toText(values[colIdx.district]), toText(values[colIdx.city]),
        toText(values[colIdx.pincode]), categoryName, productCode, toNum(values[colIdx.gstPct]),
        toNum(values[colIdx.gstAmount]), toNum(values[colIdx.qty]), parseDiscountPct(values[colIdx.discountPct]),
        toNum(values[colIdx.discountAmount]), toNum(values[colIdx.dealerOrderValue]),
        toNum(values[colIdx.basicOrderValue]),
      ];
      rows.push({
        orderId,
        orderDatetime: rawDatetime,
        orderStatus,
        salesUserName,
        customerName: toText(values[colIdx.customerName]),
        dealerId,
        dealerMobile: toText(values[colIdx.dealerMobile]),
        cpName: toText(values[colIdx.cpName]),
        cpCode,
        state: toText(values[colIdx.state]),
        district: toText(values[colIdx.district]),
        city: toText(values[colIdx.city]),
        pincode: toText(values[colIdx.pincode]),
        categoryName,
        segmentCanon,
        productCode,
        gstPct: toNum(values[colIdx.gstPct]),
        gstAmount: toNum(values[colIdx.gstAmount]),
        qty: toNum(values[colIdx.qty]),
        discountPct: parseDiscountPct(values[colIdx.discountPct]),
        discountAmount: toNum(values[colIdx.discountAmount]),
        dealerOrderValue: toNum(values[colIdx.dealerOrderValue]),
        basicOrderValue: toNum(values[colIdx.basicOrderValue]),
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
    };
  }

  // ── Upsert rows with collision detection ─────────────────────────────────
  // Strategy: INSERT ... ON CONFLICT DO NOTHING for idempotent rows.
  // For each conflict, compare stored vs incoming and report if different.

  let rowsInserted = 0;
  let rowsSkipped = 0;
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

    for (const r of rows) {
        const salesUserId = r.salesUserName ? (nameToPersonId.get(r.salesUserName) ?? null) : null;

        const result = await client.query<{ id: number }>(
          `INSERT INTO secondary_order_line
             (order_id, order_datetime, order_status, sales_user_name, sales_user_id,
              customer_name, dealer_id, dealer_mobile, cp_name, cp_code,
              state, district, city, pincode,
             category_name, segment_canon, product_code, occurrence, source_row_number,
             content_hash, is_exact_duplicate_export,
              gst_pct, gst_amount, qty, discount_pct, discount_amount,
              dealer_order_value, basic_order_value, source_file)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
              $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
            ON CONFLICT (order_id, product_code, occurrence) DO NOTHING
           RETURNING id`,
          [
            r.orderId, r.orderDatetime, r.orderStatus, r.salesUserName, salesUserId,
            r.customerName, r.dealerId, r.dealerMobile, r.cpName, r.cpCode,
            r.state, r.district, r.city, r.pincode,
             r.categoryName, r.segmentCanon, r.productCode, r.occurrence, r.sourceRowNumber,
             r.contentHash, r.isExactDuplicateExport,
            r.gstPct, r.gstAmount, r.qty, r.discountPct, r.discountAmount,
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
             WHERE order_id = $1 AND product_code = $2 AND occurrence = $3`,
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
      { sourceFile, sourceSha256, sourceBytes },
      metrics,
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
    },
    "[secondaryOrders] load complete",
  );

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
