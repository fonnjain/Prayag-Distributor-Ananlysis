import ExcelJS from "exceljs";
import crypto from "node:crypto";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, registerMonthState, secondarySkuLines, type InsertSecSkuLine } from "@workspace/db";
import { normSecKey } from "../mgmt/names.js";
import { canonGroupFromMap } from "../sku/catalogue.js";
import { assertSkuWipeGuard } from "../sku/skuWipeGuard.js";
import { isMonthFrozen, monthFreezeAt } from "../registers/monthlyReplace.js";
import { logger } from "../logger.js";

export const AUG26_PRODUCTWISE = {
  fy: "2026-27",
  month: "Aug-26",
  skuSource: "productwise_xlsx",
  valueBasis: "Basic Order Value (ex-GST)",
} as const;

/** SHA-256 of the reviewed 1–19 Aug-26 Product-Wise CRM export. */
export const AUG26_PRODUCTWISE_APPROVED_SHA256 =
  "9b1d0de5de753eb413055196cf9d627b91628cda87b6b3720f697834b6be42d2";
export const AUG26_PRODUCTWISE_SOURCE_FILE =
  "Product-Wise-Secondary-Order-Report_29_6569_19-Aug-2026_1787135138176.xlsx";

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

type ProductWiseRow = {
  orderId: string;
  orderDate: Date;
  monthLabel: string;
  salesUserName: string;
  retailer: string;
  dealerId: string;
  distributor: string;
  cpCode: string;
  categoryName: string;
  itemCode: string;
  qty: number;
  discountPct: number | null;
  basicOrderValue: number;
  occurrence: number;
};

export type ProductWiseAug26Controls = {
  rowsScanned: number;
  rows: number;
  rowsRejected: number;
  noMonth: number;
  wrongMonth: number;
  missingNames: number;
  missingItemCode: number;
  missingBasicValue: number;
  net: number;
  qty: number;
  retailers: number;
  distributors: number;
  itemCodes: number;
  salespeople: number;
  orders: number;
  pendingRows: number;
  months: string[];
  meanDiscountPct: number | null;
  unmappedCategories: string[];
};

export type PreparedProductWiseAug26Load = {
  rows: InsertSecSkuLine[];
  controls: ProductWiseAug26Controls;
};
export type PreparedProductWiseRangeLoad = PreparedProductWiseAug26Load;

export type ProductWiseAug26LoadProvenance = {
  sourceNote: string;
  uploadedBy: string;
  uploadedAt: string;
  archiveSha256: string;
  sourceFile: string;
};

export type ProductWiseAug26RecordedProvenance = ProductWiseAug26LoadProvenance & {
  fy: string;
  month: string;
  rows: number;
  net: number;
  valueBasis: typeof AUG26_PRODUCTWISE.valueBasis;
  controls: ProductWiseAug26Controls;
};

type MonthSummary = { monthLabel: string; rows: number; net: number };

export type ProductWiseMonthFreezeDecision = {
  month: string;
  frozen: boolean;
  freezeAt: Date | null;
  frozenAt: Date | null;
};

/** Product-Wise never owns a second freeze clock: state is the shared
 * register_month_state row, with the shared date calculation only providing
 * the first transition when that state row has not been created yet. */
export function productWiseMonthFreezeDecision(
  month: string,
  sharedFrozenAt: Date | null,
  now: Date = new Date(),
): ProductWiseMonthFreezeDecision {
  const freezeAt = monthFreezeAt(month);
  if (sharedFrozenAt != null) {
    return { month, frozen: true, freezeAt, frozenAt: sharedFrozenAt };
  }
  if (isMonthFrozen(month, now)) {
    return { month, frozen: true, freezeAt, frozenAt: freezeAt };
  }
  return { month, frozen: false, freezeAt, frozenAt: null };
}

/** Small deterministic seam used by the transactional range loader and its
 * overlap test. `rowsAfter` models the two permitted outcomes: unchanged for a
 * freeze skip, or an exact full replacement for an open month. */
export function productWiseRangeMonthPlan(input: {
  month: string;
  incomingRows: number;
  rowsBefore: number;
  sharedFrozenAt: Date | null;
  now: Date;
}): {
  action: "loaded" | "frozen-skipped";
  rowsBefore: number;
  rowsAfter: number;
  freezeAt: Date | null;
} {
  const freeze = productWiseMonthFreezeDecision(input.month, input.sharedFrozenAt, input.now);
  return freeze.frozen
    ? {
      action: "frozen-skipped",
      rowsBefore: input.rowsBefore,
      rowsAfter: input.rowsBefore,
      freezeAt: freeze.freezeAt,
    }
    : {
      action: "loaded",
      rowsBefore: input.rowsBefore,
      rowsAfter: input.incomingRows,
      freezeAt: null,
    };
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const cell = value as Record<string, unknown>;
    if ("result" in cell) return text(cell.result);
    if ("text" in cell) return text(cell.text);
    if ("richText" in cell && Array.isArray(cell.richText)) {
      return cell.richText.map((part) => String((part as { text?: unknown }).text ?? "")).join("").trim() || null;
    }
    if ("error" in cell) return null;
  }
  const result = String(value).trim();
  return result || null;
}

function numeric(value: unknown): number | null {
  const raw = text(value);
  if (raw == null) return null;
  const parsed = Number(raw.replace(/[₹,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function discountPct(value: unknown): number | null {
  const raw = text(value);
  if (raw == null) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function parseOrderDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  const raw = text(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (match) {
    const [, day, month, year, hour, minute, second] = match;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+05:30`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toMonthLabel(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]}-${String(date.getUTCFullYear() % 100).padStart(2, "0")}`;
}

function sha1(parts: string[]): string {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

function canonicalCrmId(value: string, prefix: "RET" | "DIST"): string {
  return value.trim().toUpperCase().replace(new RegExp(`^${prefix}[-#\\s]*`), `${prefix}#`);
}

function normalisedRetailerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Parse the approved Product-Wise workbook without touching the database.
 * It accepts only the established CRM column order and records every reason a
 * row cannot enter the existing raw SKU shape.
 */
export async function prepareProductWiseAug26Load(
  filePath: string,
  options: { allowRange?: boolean } = {},
): Promise<PreparedProductWiseAug26Load> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "ignore",
    hyperlinks: "ignore",
    worksheets: "emit",
  });

  const parsed: ProductWiseRow[] = [];
  let headerSeen = false;
  let rowsScanned = 0;
  let rowsRejected = 0;
  let noMonth = 0;
  let wrongMonth = 0;
  let missingNames = 0;
  let missingItemCode = 0;
  let missingBasicValue = 0;
  let pendingRows = 0;
  const unmappedCategories = new Set<string>();

  for await (const worksheet of workbook) {
    for await (const row of worksheet) {
      const values = ((row.values as unknown[]) ?? []).slice(1);
      if (!headerSeen) {
        const headers = values.map((value) => text(value) ?? "");
        for (let index = 0; index < EXPECTED_HEADERS.length; index++) {
          if (headers[index] !== EXPECTED_HEADERS[index]) {
            throw new Error(
              `Product-Wise header mismatch at column ${index + 1}: expected "${EXPECTED_HEADERS[index]}", got "${headers[index]}"`,
            );
          }
        }
        headerSeen = true;
        continue;
      }

      rowsScanned++;
      const orderId = text(values[1]);
      const orderDate = parseOrderDate(values[0]);
      const salesUserName = text(values[2]);
      const retailer = text(values[3]);
      const dealerId = text(values[4]);
      const distributor = text(values[6]);
      const cpCode = text(values[7]);
      const categoryName = text(values[12]);
      const itemCode = text(values[13]);
      const qty = numeric(values[16]);
      const basicOrderValue = numeric(values[20]);
      const status = (text(values[21]) ?? "PENDING").toUpperCase();

      if (!orderDate) {
        noMonth++;
        rowsRejected++;
        continue;
      }
       const monthLabel = toMonthLabel(orderDate);
       const isWithinFy = (
         (monthLabel.endsWith("-26") && ["Aug", "Sep", "Oct", "Nov", "Dec"].some((m) => monthLabel.startsWith(m)))
         || (monthLabel.endsWith("-27") && ["Jan", "Feb", "Mar"].some((m) => monthLabel.startsWith(m)))
       );
       if ((!options.allowRange && monthLabel !== AUG26_PRODUCTWISE.month) || (options.allowRange && !isWithinFy)) {
        wrongMonth++;
        rowsRejected++;
        continue;
      }
      if (!itemCode) {
        missingItemCode++;
        rowsRejected++;
        continue;
      }
      if (basicOrderValue == null) {
        missingBasicValue++;
        rowsRejected++;
        continue;
      }
      if (!orderId || !salesUserName || !retailer || !dealerId || !distributor || !cpCode || !categoryName || qty == null) {
        missingNames++;
        rowsRejected++;
        continue;
      }
      if (status === "PENDING") pendingRows++;
      if (!canonGroupFromMap(categoryName)) unmappedCategories.add(categoryName);
      parsed.push({
        orderId,
        orderDate,
        monthLabel,
        salesUserName,
        retailer,
        dealerId,
        distributor,
        cpCode,
        categoryName,
        itemCode,
        qty,
        discountPct: discountPct(values[17]),
        basicOrderValue,
        occurrence: 0,
      });
    }
    break;
  }

  if (!headerSeen) throw new Error("No Product-Wise header row found");
  if (parsed.length === 0) throw new Error(`Product-Wise report contains no valid ${options.allowRange ? "FY2026-27" : "August"} rows`);

  const occurrences = new Map<string, number>();
  const rows: InsertSecSkuLine[] = parsed.map((row) => {
    const naturalKey = `${row.orderId}\u0000${row.itemCode}`;
    row.occurrence = (occurrences.get(naturalKey) ?? 0) + 1;
    occurrences.set(naturalKey, row.occurrence);
    return {
      lineUid: sha1([
        AUG26_PRODUCTWISE.skuSource,
        AUG26_PRODUCTWISE.fy,
         row.monthLabel,
        row.orderId,
        row.itemCode,
        String(row.occurrence),
      ]),
      fy: AUG26_PRODUCTWISE.fy,
       monthLabel: row.monthLabel,
      headRaw: row.salesUserName,
      headCanon: normSecKey(row.salesUserName),
      stateRaw: null,
      stateCanon: null,
      retailer: row.retailer,
      retailerId: canonicalCrmId(row.dealerId, "RET"),
      dealerId: canonicalCrmId(row.dealerId, "RET"),
      distributor: row.distributor,
      cpCode: canonicalCrmId(row.cpCode, "DIST"),
      itemCode: row.itemCode,
      segmentRaw: row.categoryName,
      segmentCanon: canonGroupFromMap(row.categoryName) ?? null,
      qty: String(row.qty),
      mrp: null,
      // Dealer Order Value is GST-inclusive and deliberately never enters this field.
      netAmount: String(row.basicOrderValue),
      grossAmount: null,
      discountPct: row.discountPct == null ? null : String(row.discountPct),
      source: AUG26_PRODUCTWISE.skuSource,
    };
  });

  const discounts = parsed.map((row) => row.discountPct).filter((value): value is number => value != null);
  return {
    rows,
    controls: {
      rowsScanned,
      rows: rows.length,
      rowsRejected,
      noMonth,
      wrongMonth,
      missingNames,
      missingItemCode,
      missingBasicValue,
      net: rows.reduce((sum, row) => sum + Number(row.netAmount ?? 0), 0),
      qty: rows.reduce((sum, row) => sum + Number(row.qty ?? 0), 0),
      retailers: new Set(parsed.map((row) => row.dealerId)).size,
      distributors: new Set(parsed.map((row) => row.cpCode)).size,
      itemCodes: new Set(rows.map((row) => row.itemCode)).size,
      salespeople: new Set(rows.map((row) => row.headCanon).filter(Boolean)).size,
      orders: new Set(parsed.map((row) => row.orderId)).size,
      pendingRows,
      months: [...new Set(rows.map((row) => row.monthLabel))].sort(),
      meanDiscountPct: discounts.length === 0 ? null : discounts.reduce((sum, value) => sum + value, 0) / discounts.length,
      unmappedCategories: [...unmappedCategories].sort(),
    },
  };
}

/** Manual range uploads replace a whole month, so a small valid subset must
 * never be allowed to wipe an established month. */
export function assertProductWiseRangeReplacementCoverage(input: {
  rowsBefore: number;
  netBefore: number;
  rowsIncoming: number;
  netIncoming: number;
}): void {
  const MIN_COVERAGE = 0.98;
  if (
    input.rowsBefore > 0 &&
    (input.rowsIncoming < Math.ceil(input.rowsBefore * MIN_COVERAGE) ||
      input.netIncoming < input.netBefore * MIN_COVERAGE)
  ) {
    throw new Error(
      `Product-Wise range replacement is materially short: ${input.rowsIncoming}/${input.rowsBefore} rows, ` +
      `₹${input.netIncoming.toFixed(2)}/₹${input.netBefore.toFixed(2)} net. Existing month was preserved.`,
    );
  }
}

/** Parser for manual Product-Wise range exports. It keeps the reviewed CRM
 * shape and FY boundary, but permits the expected frozen/open overlap. */
export async function prepareProductWiseRangeLoad(filePath: string): Promise<PreparedProductWiseRangeLoad> {
  return prepareProductWiseAug26Load(filePath, { allowRange: true });
}

export function assertProductWiseRangeControls(prepared: PreparedProductWiseRangeLoad): void {
  const c = prepared.controls;
  if (c.rows === 0 || c.rowsRejected > 0 || c.months.length === 0) {
    throw new Error(
      `Product-Wise range controls refused: rows=${c.rows}; rowsRejected=${c.rowsRejected}; months=${c.months.join(",")}`,
    );
  }
}

export function assertApprovedAug26ProductWiseArchive(sha256: string): void {
  if (sha256 !== AUG26_PRODUCTWISE_APPROVED_SHA256) {
    throw new Error("This route accepts only the reviewed 1–19 Aug-26 Product-Wise workbook.");
  }
}

export function assertProductWiseAug26Controls(prepared: PreparedProductWiseAug26Load): void {
  const controls = prepared.controls;
  const errors: string[] = [];
  if (controls.rowsScanned !== 8_602) errors.push(`rowsScanned=${controls.rowsScanned}; expected 8602`);
  if (controls.rows !== 8_602) errors.push(`rows=${controls.rows}; expected 8602`);
  if (controls.rowsRejected !== 0) errors.push(`rowsRejected=${controls.rowsRejected}; expected 0`);
  if (controls.net !== 56_403_177) errors.push(`net=${controls.net}; expected 56403177`);
  if (controls.qty !== 322_465) errors.push(`qty=${controls.qty}; expected 322465`);
  if (controls.retailers !== 1_132) errors.push(`retailers=${controls.retailers}; expected 1132`);
  if (controls.distributors !== 128) errors.push(`distributors=${controls.distributors}; expected 128`);
  if (controls.itemCodes !== 1_605) errors.push(`itemCodes=${controls.itemCodes}; expected 1605`);
  if (controls.salespeople !== 121) errors.push(`salespeople=${controls.salespeople}; expected 121`);
  if (controls.orders !== 1_361) errors.push(`orders=${controls.orders}; expected 1361`);
  if (controls.pendingRows !== 430) errors.push(`pendingRows=${controls.pendingRows}; expected 430`);
  if (controls.noMonth || controls.wrongMonth || controls.missingNames || controls.missingItemCode || controls.missingBasicValue) {
    errors.push(
      `invalidRows: noMonth=${controls.noMonth}, wrongMonth=${controls.wrongMonth}, missingNames=${controls.missingNames}, missingItemCode=${controls.missingItemCode}, missingBasicValue=${controls.missingBasicValue}`,
    );
  }
  if (controls.months.length !== 1 || controls.months[0] !== AUG26_PRODUCTWISE.month) {
    errors.push(`months=${controls.months.join(",")}; expected ${AUG26_PRODUCTWISE.month}`);
  }
  if (errors.length > 0) throw new Error(`Aug-26 Product-Wise controls refused: ${errors.join("; ")}`);
}

export function assertProductWiseAug26UploadMetadata(
  metadata: Pick<ProductWiseAug26LoadProvenance, "sourceNote" | "uploadedBy" | "sourceFile">,
): void {
  if (!metadata.sourceNote.trim()) throw new Error("source_note is required");
  if (metadata.sourceNote.length > 2_000) throw new Error("source_note must be 2,000 characters or fewer");
  if (!metadata.uploadedBy.trim()) throw new Error("uploaded_by is required");
  if (metadata.uploadedBy.length > 200) throw new Error("uploaded_by must be 200 characters or fewer");
  if (!metadata.sourceFile.trim()) throw new Error("source_file is required");
  if (metadata.sourceFile.length > 500) throw new Error("source_file must be 500 characters or fewer");
}

export function toProductWiseAug26RecordedProvenance(
  provenance: ProductWiseAug26LoadProvenance,
  controls: ProductWiseAug26Controls,
): ProductWiseAug26RecordedProvenance {
  return {
    ...provenance,
    fy: AUG26_PRODUCTWISE.fy,
    month: AUG26_PRODUCTWISE.month,
    rows: controls.rows,
    net: controls.net,
    valueBasis: AUG26_PRODUCTWISE.valueBasis,
    controls,
  };
}

export type ProductWiseAug26MonthStatus = "not_loaded" | "in_progress" | "frozen_verified";

const EMPTY_CONTROLS: ProductWiseAug26Controls = {
  rowsScanned: 0, rows: 0, rowsRejected: 0, noMonth: 0, wrongMonth: 0,
  missingNames: 0, missingItemCode: 0, missingBasicValue: 0, net: 0, qty: 0,
  retailers: 0, distributors: 0, itemCodes: 0, salespeople: 0, orders: 0,
  pendingRows: 0, months: [], meanDiscountPct: null, unmappedCategories: [],
};

function parseControls(value: unknown): ProductWiseAug26Controls {
  if (!value || typeof value !== "object") return EMPTY_CONTROLS;
  return { ...EMPTY_CONTROLS, ...(value as Partial<ProductWiseAug26Controls>) };
}

export function productWiseAug26MonthStatus(
  hasLoad: boolean,
  closedAt: string | Date | null,
  now: Date = new Date(),
): ProductWiseAug26MonthStatus {
  if (closedAt != null || isMonthFrozen(AUG26_PRODUCTWISE.month, now)) return "frozen_verified";
  return hasLoad ? "in_progress" : "not_loaded";
}

export function assertProductWiseAug26MonthWritable(
  state: { hasLoad: boolean; closedAt: string | Date | null },
  now: Date = new Date(),
): void {
  if (productWiseAug26MonthStatus(state.hasLoad, state.closedAt, now) !== "frozen_verified") return;
  throw new Error(`Product-Wise ${AUG26_PRODUCTWISE.month} is permanently frozen and cannot be replaced.`);
}

async function skuMonthSummaries(): Promise<MonthSummary[]> {
  const result = await db.execute<{ month_label: string; rows: number; net: string }>(sql`
    SELECT month_label, COUNT(*)::int AS rows, COALESCE(SUM(net_amount), 0)::text AS net
      FROM secondary_sku_line
     WHERE fy = ${AUG26_PRODUCTWISE.fy}
     GROUP BY month_label
     ORDER BY month_label
  `);
  return result.rows.map((row) => ({ monthLabel: row.month_label, rows: Number(row.rows), net: Number(row.net) }));
}

export type ProductWiseAug26CommitResult = {
  skuMonths: MonthSummary[];
  continuity: ProductWiseAug26Continuity | null;
  provenance: ProductWiseAug26RecordedProvenance;
  month: {
    action: "loaded" | "frozen-skipped";
    rowsBefore: number | null;
    rowsWritten: number | null;
    freezeAt: string | null;
  };
};

export type ProductWiseAug26Continuity = {
  matchedRetailers: number;
  nameMismatches: number;
  zeroAugustRetailers: number;
  medianAugustToJulyRatio: number | null;
};

/**
 * Product-Wise began on 1 Aug, so no same-month overlap is possible. Instead,
 * use the accepted RET# population continuity test against the frozen Jul-26
 * PSCode 3 source. This validates the source seam without pretending the two
 * systems have comparable row counts.
 */
async function assertProductWiseAug26Continuity(
  tx: { execute: (query: unknown) => Promise<{ rows: Array<{ retailer_id: string | null; retailer: string | null; net: string }> }> },
  prepared: PreparedProductWiseAug26Load,
): Promise<ProductWiseAug26Continuity> {
  const july = await tx.execute(sql`
    SELECT retailer_id, MIN(retailer) AS retailer, SUM(net_amount)::text AS net
      FROM secondary_sku_line
     WHERE fy = '2026-27'
       AND month_label = 'Jul-26'
       AND source = 'pscode3_xlsx'
       AND retailer_id IS NOT NULL
     GROUP BY retailer_id
  `);
  const julyByRetailer = new Map<string, { net: number; name: string }>();
  for (const row of july.rows) {
    if (!row.retailer_id || !row.retailer) continue;
    const key = canonicalCrmId(row.retailer_id, "RET");
    const current = julyByRetailer.get(key);
    julyByRetailer.set(key, {
      net: (current?.net ?? 0) + Number(row.net),
      name: current?.name ?? row.retailer,
    });
  }
  const augustByRetailer = new Map<string, { net: number; name: string }>();
  for (const row of prepared.rows) {
    if (!row.retailerId || !row.retailer) continue;
    const key = canonicalCrmId(row.retailerId, "RET");
    const current = augustByRetailer.get(key);
    augustByRetailer.set(key, {
      net: (current?.net ?? 0) + Number(row.netAmount ?? 0),
      name: current?.name ?? row.retailer,
    });
  }

  const ratios: number[] = [];
  let nameMismatches = 0;
  let zeroAugustRetailers = 0;
  for (const [retailerId, julyRow] of julyByRetailer) {
    const augustRow = augustByRetailer.get(retailerId);
    if (!augustRow) continue;
    if (normalisedRetailerName(julyRow.name) !== normalisedRetailerName(augustRow.name)) nameMismatches++;
    if (augustRow.net <= 0) zeroAugustRetailers++;
    if (julyRow.net > 0) ratios.push(augustRow.net / julyRow.net);
  }
  ratios.sort((left, right) => left - right);
  const midpoint = Math.floor(ratios.length / 2);
  const medianAugustToJulyRatio = ratios.length === 0
    ? null
    : ratios.length % 2 === 1
      ? ratios[midpoint]!
      : (ratios[midpoint - 1]! + ratios[midpoint]!) / 2;
  const continuity = {
    matchedRetailers: ratios.length,
    nameMismatches,
    zeroAugustRetailers,
    medianAugustToJulyRatio,
  };
  const expectedMedian = 0.698953118;
  if (
    continuity.matchedRetailers !== 675 ||
    continuity.nameMismatches !== 0 ||
    continuity.zeroAugustRetailers !== 0 ||
    continuity.medianAugustToJulyRatio == null ||
    Math.abs(continuity.medianAugustToJulyRatio - expectedMedian) > 0.000_001
  ) {
    throw new Error(
      `Aug-26 Product-Wise continuity refused: matchedRetailers=${continuity.matchedRetailers}; ` +
      `nameMismatches=${continuity.nameMismatches}; zeroAugustRetailers=${continuity.zeroAugustRetailers}; ` +
      `medianAugustToJulyRatio=${continuity.medianAugustToJulyRatio ?? "null"}; expected 675/0/0/${expectedMedian}`,
    );
  }
  return continuity;
}

/** Replace exactly Aug-26 after all source controls and safety gates pass. */
export async function commitProductWiseAug26Load(
  prepared: PreparedProductWiseAug26Load,
  provenance: ProductWiseAug26LoadProvenance,
  options: { now?: Date } = {},
): Promise<ProductWiseAug26CommitResult> {
  assertProductWiseAug26Controls(prepared);
  assertProductWiseAug26UploadMetadata(provenance);
  if (!Number.isFinite(Date.parse(provenance.uploadedAt))) throw new Error("uploadedAt must be a valid ISO timestamp");
  if (!/^[a-f0-9]{64}$/.test(provenance.archiveSha256)) throw new Error("archiveSha256 must be a lowercase SHA-256 digest");

  let continuity: ProductWiseAug26Continuity | null = null;
  let monthResult: ProductWiseAug26CommitResult["month"] = {
    action: "loaded", rowsBefore: null, rowsWritten: null, freezeAt: null,
  };
  const now = options.now ?? new Date();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`productwise-month|${AUG26_PRODUCTWISE.fy}|${AUG26_PRODUCTWISE.month}`}))`);
    const sharedState = await tx.select({ frozenAt: registerMonthState.frozenAt })
      .from(registerMonthState)
      .where(and(
        eq(registerMonthState.fy, AUG26_PRODUCTWISE.fy),
        eq(registerMonthState.monthLabel, AUG26_PRODUCTWISE.month),
      ));
    const stateResult = await tx.execute<{ source_fingerprint: string; controls: unknown; closed_at: string | null }>(sql`
      SELECT source_fingerprint, controls, closed_at::text
        FROM secondary_sku_month_state
       WHERE fy = ${AUG26_PRODUCTWISE.fy} AND month_label = ${AUG26_PRODUCTWISE.month}
         AND source = ${AUG26_PRODUCTWISE.skuSource}
       FOR UPDATE
    `);
    const priorProvenance = await tx.execute<{ archive_sha256: string; controls: unknown }>(sql`
      SELECT archive_sha256, controls FROM secondary_sku_load_provenance
       WHERE fy = ${AUG26_PRODUCTWISE.fy} AND month_label = ${AUG26_PRODUCTWISE.month}
         AND source = ${AUG26_PRODUCTWISE.skuSource}
       ORDER BY uploaded_at DESC, id DESC LIMIT 1
    `);
    const state = stateResult.rows[0];
    const previousLoad = state ?? priorProvenance.rows[0] ?? null;
    const closedAt = state?.closed_at ? new Date(state.closed_at)
      : sharedState[0]?.frozenAt ?? (isMonthFrozen(AUG26_PRODUCTWISE.month, now)
        ? monthFreezeAt(AUG26_PRODUCTWISE.month)
        : null);
    assertProductWiseAug26MonthWritable({ hasLoad: previousLoad != null, closedAt }, now);
    if (closedAt != null && sharedState[0]?.frozenAt == null) {
      await tx.insert(registerMonthState).values({
        fy: AUG26_PRODUCTWISE.fy, monthLabel: AUG26_PRODUCTWISE.month, frozenAt: closedAt,
      }).onConflictDoUpdate({
        target: [registerMonthState.fy, registerMonthState.monthLabel],
        set: { frozenAt: closedAt },
      });
    }
    const targetSources = await tx.execute<{ source: string }>(sql`
      SELECT DISTINCT source
        FROM secondary_sku_line
       WHERE fy = ${AUG26_PRODUCTWISE.fy} AND month_label = ${AUG26_PRODUCTWISE.month}
    `);
    const foreignSource = targetSources.rows.find((row) => row.source !== AUG26_PRODUCTWISE.skuSource);
    if (foreignSource) {
      throw new Error(`Aug-26 already contains source '${foreignSource.source}', so Product-Wise will not overwrite it.`);
    }

    await assertSkuWipeGuard({
      tx: tx as any,
      fy: AUG26_PRODUCTWISE.fy,
      incoming: prepared.rows.map((row) => ({
        monthLabel: row.monthLabel,
        distributor: row.distributor ?? null,
        head: row.headCanon ?? null,
      })),
      skipGuard: false,
      callerLabel: "Product-Wise Aug-26 controlled load",
      sourceLike: AUG26_PRODUCTWISE.skuSource,
      memberGuardEnabled: true,
    });
    continuity = await assertProductWiseAug26Continuity(tx as any, prepared);
    const before = await tx.execute<{ rows: string }>(sql`
      SELECT COUNT(*)::text AS rows
        FROM secondary_sku_line
       WHERE fy = ${AUG26_PRODUCTWISE.fy}
         AND month_label = ${AUG26_PRODUCTWISE.month}
         AND source = ${AUG26_PRODUCTWISE.skuSource}
    `);
    await tx.execute(sql`
      DELETE FROM secondary_sku_line
       WHERE fy = ${AUG26_PRODUCTWISE.fy} AND month_label = ${AUG26_PRODUCTWISE.month}
    `);
    for (let offset = 0; offset < prepared.rows.length; offset += 1_000) {
      await tx.insert(secondarySkuLines).values(prepared.rows.slice(offset, offset + 1_000).map((row) => ({
        ...row,
        frozenAt: closedAt,
        sourceFile: provenance.sourceFile,
      })));
    }
    await tx.execute(sql`
      INSERT INTO secondary_sku_load_provenance
        (fy, month_label, source_note, uploaded_by, uploaded_at,
         archive_sha256, row_count, net_amount, source, value_basis, source_file, controls, verified_at)
      VALUES
        (${AUG26_PRODUCTWISE.fy}, ${AUG26_PRODUCTWISE.month},
         ${provenance.sourceNote.trim()}, ${provenance.uploadedBy.trim()},
         ${new Date(provenance.uploadedAt)}, ${provenance.archiveSha256},
         ${prepared.controls.rows}, ${prepared.controls.net},
           ${AUG26_PRODUCTWISE.skuSource}, ${AUG26_PRODUCTWISE.valueBasis}, ${provenance.sourceFile},
           ${JSON.stringify(prepared.controls)}::jsonb, ${now})
    `);
    await tx.execute(sql`
      INSERT INTO secondary_sku_month_state
        (fy, month_label, source, status, source_fingerprint, controls, source_note,
         uploaded_by, uploaded_at, verified_at, closed_at)
      VALUES
        (${AUG26_PRODUCTWISE.fy}, ${AUG26_PRODUCTWISE.month}, ${AUG26_PRODUCTWISE.skuSource},
         ${closedAt != null ? "frozen_verified" : "in_progress"}, ${provenance.archiveSha256},
         ${JSON.stringify(prepared.controls)}::jsonb, ${provenance.sourceNote.trim()},
         ${provenance.uploadedBy.trim()}, ${new Date(provenance.uploadedAt)}, ${now}, ${closedAt})
      ON CONFLICT (fy, month_label, source) DO UPDATE SET
        status = EXCLUDED.status, source_fingerprint = EXCLUDED.source_fingerprint,
        controls = EXCLUDED.controls, source_note = EXCLUDED.source_note,
        uploaded_by = EXCLUDED.uploaded_by, uploaded_at = EXCLUDED.uploaded_at,
        verified_at = EXCLUDED.verified_at,
        closed_at = COALESCE(secondary_sku_month_state.closed_at, EXCLUDED.closed_at)
    `);
    monthResult = {
      action: "loaded",
      rowsBefore: Number(before.rows[0]?.rows ?? 0),
      rowsWritten: prepared.rows.length,
      freezeAt: closedAt?.toISOString() ?? null,
    };
  });

  const skuMonths = await skuMonthSummaries();
  const augustSku = skuMonths.find((month) => month.monthLabel === AUG26_PRODUCTWISE.month);
  if (!augustSku || augustSku.rows !== prepared.rows.length) {
    throw new Error("Aug-26 post-load verification failed: SKU detail does not match the prepared row count");
  }
  if (Math.abs(augustSku.net - prepared.controls.net) > 1) {
    throw new Error("Aug-26 post-load verification failed: SKU detail does not match the prepared NET");
  }
  return {
    skuMonths,
    continuity,
    provenance: toProductWiseAug26RecordedProvenance(provenance, prepared.controls),
    month: monthResult,
  };
}

export type ProductWiseMonthFreezeStatus = {
  month: string;
  source: string;
  rows: number;
  frozen: boolean;
  frozenAt: string | null;
  stateFrozenAt: string | null;
  sourceFiles: string[];
};

export type ProductWiseRangeMonthResult = {
  month: string;
  action: "loaded" | "frozen-skipped";
  incomingRows: number;
  rowsBefore: number;
  rowsWritten: number | null;
  freezeAt: string | null;
};

/**
 * Controlled loader for future manual Product-Wise range exports. Each month
 * is independently inspected under one transaction lock: an old range row
 * cannot overwrite, merge with, or duplicate a permanently frozen month while
 * the open portion of the very same workbook can still replace normally.
 */
export async function commitProductWiseRangeLoad(
  prepared: PreparedProductWiseRangeLoad,
  provenance: ProductWiseAug26LoadProvenance,
  options: { now?: Date } = {},
): Promise<{ months: ProductWiseRangeMonthResult[]; skuMonths: MonthSummary[] }> {
  assertProductWiseRangeControls(prepared);
  assertProductWiseAug26UploadMetadata(provenance);
  if (!Number.isFinite(Date.parse(provenance.uploadedAt))) throw new Error("uploadedAt must be a valid ISO timestamp");
  if (!/^[a-f0-9]{64}$/.test(provenance.archiveSha256)) throw new Error("archiveSha256 must be a lowercase SHA-256 digest");

  const now = options.now ?? new Date();
  const byMonth = new Map<string, InsertSecSkuLine[]>();
  for (const row of prepared.rows) {
    const rows = byMonth.get(row.monthLabel);
    if (rows) rows.push(row);
    else byMonth.set(row.monthLabel, [row]);
  }
  const results: ProductWiseRangeMonthResult[] = [];

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('productwise-range-load'))`);
    for (const [month, incoming] of [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      // Every Product-Wise writer, including the single-month Aug route, takes
      // this exact lock before its baseline read and destructive replacement.
      // Sorted range iteration keeps multi-month uploads deadlock-free.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`productwise-month|${AUG26_PRODUCTWISE.fy}|${month}`}))`);
      const sharedState = await tx.select({ frozenAt: registerMonthState.frozenAt })
        .from(registerMonthState)
        .where(and(
          eq(registerMonthState.fy, AUG26_PRODUCTWISE.fy),
          eq(registerMonthState.monthLabel, month),
        ));
      const freeze = productWiseMonthFreezeDecision(month, sharedState[0]?.frozenAt ?? null, now);
      const closedAt = freeze.frozen ? freeze.frozenAt : null;
      const before = await tx.execute<{ rows: string; net: string }>(sql`
        SELECT COUNT(*)::text AS rows, COALESCE(SUM(net_amount), 0)::text AS net
          FROM secondary_sku_line
         WHERE fy = ${AUG26_PRODUCTWISE.fy}
           AND month_label = ${month}
           AND source = ${AUG26_PRODUCTWISE.skuSource}
      `);
      const rowsBefore = Number(before.rows[0]?.rows ?? 0);
      const netBefore = Number(before.rows[0]?.net ?? 0);
      const net = incoming.reduce((sum, row) => sum + Number(row.netAmount ?? 0), 0);
      const plan = productWiseRangeMonthPlan({
        month,
        incomingRows: incoming.length,
        rowsBefore,
        sharedFrozenAt: sharedState[0]?.frozenAt ?? null,
        now,
      });

      if (plan.action === "frozen-skipped") {
        const frozenAt = freeze.frozenAt!;
        if (sharedState[0]?.frozenAt == null) {
          await tx.insert(registerMonthState)
            .values({ fy: AUG26_PRODUCTWISE.fy, monthLabel: month, frozenAt })
            .onConflictDoUpdate({
              target: [registerMonthState.fy, registerMonthState.monthLabel],
              set: { frozenAt },
            });
        }
        await tx.execute(sql`
          UPDATE secondary_sku_line
             SET frozen_at = ${frozenAt}
           WHERE fy = ${AUG26_PRODUCTWISE.fy}
             AND month_label = ${month}
             AND source = ${AUG26_PRODUCTWISE.skuSource}
             AND frozen_at IS NULL
        `);
        const freezeAt = freeze.freezeAt?.toISOString() ?? null;
        logger.warn(
          { fy: AUG26_PRODUCTWISE.fy, month, freezeAt, incomingRows: incoming.length },
          "[productwise] frozen month skipped from manual range upload",
        );
        results.push({
          month, action: "frozen-skipped", incomingRows: incoming.length,
          rowsBefore: plan.rowsBefore, rowsWritten: null, freezeAt,
        });
        continue;
      }

      const foreign = await tx.execute<{ source: string }>(sql`
        SELECT DISTINCT source
          FROM secondary_sku_line
         WHERE fy = ${AUG26_PRODUCTWISE.fy}
           AND month_label = ${month}
           AND source <> ${AUG26_PRODUCTWISE.skuSource}
      `);
      if (foreign.rows[0]) {
        throw new Error(`${month} already contains source '${foreign.rows[0].source}', so Product-Wise will not overwrite it.`);
      }
      assertProductWiseRangeReplacementCoverage({
        rowsBefore,
        netBefore,
        rowsIncoming: incoming.length,
        netIncoming: net,
      });
      await tx.execute(sql`
        DELETE FROM secondary_sku_line
         WHERE fy = ${AUG26_PRODUCTWISE.fy}
           AND month_label = ${month}
           AND source = ${AUG26_PRODUCTWISE.skuSource}
      `);
      for (let offset = 0; offset < incoming.length; offset += 1_000) {
        await tx.insert(secondarySkuLines).values(incoming.slice(offset, offset + 1_000).map((row) => ({
          ...row,
          frozenAt: closedAt,
          sourceFile: provenance.sourceFile,
        })));
      }
      const monthControls: ProductWiseAug26Controls = {
        ...prepared.controls,
        rowsScanned: incoming.length,
        rows: incoming.length,
        net,
        months: [month],
      };
      await tx.execute(sql`
        INSERT INTO secondary_sku_load_provenance
          (fy, month_label, source_note, uploaded_by, uploaded_at,
           archive_sha256, row_count, net_amount, source, value_basis, source_file, controls, verified_at)
        VALUES
          (${AUG26_PRODUCTWISE.fy}, ${month}, ${provenance.sourceNote.trim()},
           ${provenance.uploadedBy.trim()}, ${new Date(provenance.uploadedAt)},
           ${provenance.archiveSha256}, ${incoming.length}, ${net},
           ${AUG26_PRODUCTWISE.skuSource}, ${AUG26_PRODUCTWISE.valueBasis}, ${provenance.sourceFile},
           ${JSON.stringify(monthControls)}::jsonb, ${now})
      `);
      await tx.execute(sql`
        INSERT INTO secondary_sku_month_state
          (fy, month_label, source, status, source_fingerprint, controls, source_note,
           uploaded_by, uploaded_at, verified_at, closed_at)
        VALUES
          (${AUG26_PRODUCTWISE.fy}, ${month}, ${AUG26_PRODUCTWISE.skuSource},
           ${closedAt != null ? "frozen_verified" : "in_progress"}, ${provenance.archiveSha256}, ${JSON.stringify(monthControls)}::jsonb,
           ${provenance.sourceNote.trim()}, ${provenance.uploadedBy.trim()},
           ${new Date(provenance.uploadedAt)}, ${now}, ${closedAt})
        ON CONFLICT (fy, month_label, source) DO UPDATE SET
          status = EXCLUDED.status, source_fingerprint = EXCLUDED.source_fingerprint,
          controls = EXCLUDED.controls, source_note = EXCLUDED.source_note,
          uploaded_by = EXCLUDED.uploaded_by, uploaded_at = EXCLUDED.uploaded_at,
          verified_at = EXCLUDED.verified_at,
          closed_at = COALESCE(secondary_sku_month_state.closed_at, EXCLUDED.closed_at)
      `);
      results.push({
        month, action: "loaded", incomingRows: incoming.length,
        rowsBefore: plan.rowsBefore, rowsWritten: plan.rowsAfter, freezeAt: null,
      });
    }
  });
  return { months: results, skuMonths: await skuMonthSummaries() };
}

export async function getProductWiseMonthFreezeStatus(): Promise<ProductWiseMonthFreezeStatus[]> {
  const result = await pool.query<{
    month_label: string;
    source: string;
    rows: string;
    frozen_at: string | null;
    state_frozen_at: string | null;
    source_files: string[] | null;
  }>(
    `SELECT ssl.month_label,
            ssl.source,
            COUNT(*)::text AS rows,
            CASE WHEN COUNT(*) FILTER (WHERE ssl.frozen_at IS NULL) = 0 THEN MIN(ssl.frozen_at)::text ELSE NULL END AS frozen_at,
            rms.frozen_at::text AS state_frozen_at,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT ssl.source_file), NULL) AS source_files
       FROM secondary_sku_line ssl
       LEFT JOIN register_month_state rms
         ON rms.fy = ssl.fy AND rms.month_label = ssl.month_label
      WHERE ssl.fy = $1
      GROUP BY ssl.month_label, ssl.source, rms.frozen_at
      ORDER BY MIN(TO_DATE(ssl.month_label, 'Mon-YY')), ssl.source`,
    [AUG26_PRODUCTWISE.fy],
  );
  return result.rows.map((row) => ({
    month: row.month_label,
    source: row.source,
    rows: Number(row.rows),
    // Range loads do not schedule a future write merely to stamp row evidence.
    // The same shared clock remains authoritative for freshness between the
    // upload and the next operational touch of that month.
    frozen: row.frozen_at != null || row.state_frozen_at != null || isMonthFrozen(row.month_label),
    frozenAt: row.frozen_at ?? row.state_frozen_at ?? (
      isMonthFrozen(row.month_label) ? monthFreezeAt(row.month_label)?.toISOString() ?? null : null
    ),
    stateFrozenAt: row.state_frozen_at ?? (
      isMonthFrozen(row.month_label) ? monthFreezeAt(row.month_label)?.toISOString() ?? null : null
    ),
    sourceFiles: row.source_files ?? [],
  }));
}

export async function getLatestProductWiseAug26LoadProvenance(): Promise<ProductWiseAug26RecordedProvenance | null> {
  const result = await pool.query<{
    fy: string;
    month_label: string;
    source_note: string;
    uploaded_by: string;
    uploaded_at: string;
    archive_sha256: string;
    row_count: string;
    net_amount: string;
    value_basis: string;
    source_file: string | null;
    controls: unknown;
    verified_at: string | null;
  }>(
    `SELECT fy, month_label, source_note, uploaded_by, uploaded_at::text,
            archive_sha256, row_count, net_amount::text, value_basis, source_file,
            controls, verified_at::text
       FROM secondary_sku_load_provenance
      WHERE fy = $1 AND month_label = $2 AND source = $3
      ORDER BY uploaded_at DESC, id DESC
      LIMIT 1`,
    [AUG26_PRODUCTWISE.fy, AUG26_PRODUCTWISE.month, AUG26_PRODUCTWISE.skuSource],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sourceNote: row.source_note,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    archiveSha256: row.archive_sha256,
    sourceFile: row.source_file ?? "unknown",
    fy: row.fy,
    month: row.month_label,
    rows: Number(row.row_count),
    net: Number(row.net_amount),
    valueBasis: AUG26_PRODUCTWISE.valueBasis,
    controls: parseControls(row.controls),
  };
}

type ProductWiseStateRow = {
  fy: string; month_label: string; source: string; status: ProductWiseAug26MonthStatus;
  source_fingerprint: string; controls: unknown; source_note: string; uploaded_by: string;
  uploaded_at: string; verified_at: string; closed_at: string | null;
};

async function latestProductWiseState(): Promise<ProductWiseStateRow | null> {
  const result = await pool.query<ProductWiseStateRow>(
    `SELECT fy, month_label, source, status, source_fingerprint, controls, source_note,
            uploaded_by, uploaded_at::text, verified_at::text, closed_at::text
       FROM secondary_sku_month_state
      WHERE fy = $1 AND month_label = $2 AND source = $3 LIMIT 1`,
    [AUG26_PRODUCTWISE.fy, AUG26_PRODUCTWISE.month, AUG26_PRODUCTWISE.skuSource],
  );
  return result.rows[0] ?? null;
}

export async function getProductWiseAug26MonthState(): Promise<{
  hasLoad: boolean; closedAt: string | null;
}> {
  const [state, latest] = await Promise.all([latestProductWiseState(), getLatestProductWiseAug26LoadProvenance()]);
  return { hasLoad: state != null || latest != null, closedAt: state?.closed_at ?? null };
}

export type ProductWiseAug26Freshness = {
  fy: string; month: string; status: ProductWiseAug26MonthStatus;
  sourceFingerprint: string | null; sourceNote: string | null; uploadedBy: string | null;
  uploadedAt: string | null; verifiedAt: string | null; frozenAt: string | null;
  controls: ProductWiseAug26Controls | null;
};

export async function getProductWiseAug26Freshness(
  now: Date = new Date(),
): Promise<ProductWiseAug26Freshness> {
  const [state, latest] = await Promise.all([latestProductWiseState(), getLatestProductWiseAug26LoadProvenance()]);
  const hasLoad = state != null || latest != null;
  const status = productWiseAug26MonthStatus(hasLoad, state?.closed_at ?? null, now);
  return {
    fy: AUG26_PRODUCTWISE.fy, month: AUG26_PRODUCTWISE.month, status,
    sourceFingerprint: state?.source_fingerprint ?? latest?.archiveSha256 ?? null,
    sourceNote: state?.source_note ?? latest?.sourceNote ?? null,
    uploadedBy: state?.uploaded_by ?? latest?.uploadedBy ?? null,
    uploadedAt: state?.uploaded_at ?? latest?.uploadedAt ?? null,
    verifiedAt: state?.verified_at ?? null,
    frozenAt: status === "frozen_verified"
      ? state?.closed_at ?? monthFreezeAt(AUG26_PRODUCTWISE.month)?.toISOString() ?? null
      : null,
    controls: state ? parseControls(state.controls) : latest?.controls ?? null,
  };
}