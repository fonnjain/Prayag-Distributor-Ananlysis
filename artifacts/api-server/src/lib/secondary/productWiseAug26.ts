import ExcelJS from "exceljs";
import crypto from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db, pool, secondarySkuLines, type InsertSecSkuLine } from "@workspace/db";
import { normSecKey } from "../mgmt/names.js";
import { canonGroupFromMap } from "../sku/catalogue.js";
import { assertSkuWipeGuard } from "../sku/skuWipeGuard.js";

export const AUG26_PRODUCTWISE = {
  fy: "2026-27",
  month: "Aug-26",
  skuSource: "productwise_xlsx",
  valueBasis: "Basic Order Value (ex-GST)",
} as const;

/** SHA-256 of the reviewed 1–19 Aug-26 Product-Wise CRM export. */
export const AUG26_PRODUCTWISE_APPROVED_SHA256 =
  "9b1d0de5de753eb413055196cf9d627b91628cda87b6b3720f697834b6be42d2";

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

export type ProductWiseAug26LoadProvenance = {
  sourceNote: string;
  uploadedBy: string;
  uploadedAt: string;
  archiveSha256: string;
};

export type ProductWiseAug26RecordedProvenance = ProductWiseAug26LoadProvenance & {
  fy: string;
  month: string;
  rows: number;
  net: number;
  valueBasis: typeof AUG26_PRODUCTWISE.valueBasis;
};

type MonthSummary = { monthLabel: string; rows: number; net: number };

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
export async function prepareProductWiseAug26Load(filePath: string): Promise<PreparedProductWiseAug26Load> {
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
      if (toMonthLabel(orderDate) !== AUG26_PRODUCTWISE.month) {
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
  if (parsed.length === 0) throw new Error("Product-Wise report contains no valid August rows");

  const occurrences = new Map<string, number>();
  const rows: InsertSecSkuLine[] = parsed.map((row) => {
    const naturalKey = `${row.orderId}\u0000${row.itemCode}`;
    row.occurrence = (occurrences.get(naturalKey) ?? 0) + 1;
    occurrences.set(naturalKey, row.occurrence);
    return {
      lineUid: sha1([
        AUG26_PRODUCTWISE.skuSource,
        AUG26_PRODUCTWISE.fy,
        AUG26_PRODUCTWISE.month,
        row.orderId,
        row.itemCode,
        String(row.occurrence),
      ]),
      fy: AUG26_PRODUCTWISE.fy,
      monthLabel: AUG26_PRODUCTWISE.month,
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
  metadata: Pick<ProductWiseAug26LoadProvenance, "sourceNote" | "uploadedBy">,
): void {
  if (!metadata.sourceNote.trim()) throw new Error("source_note is required");
  if (metadata.sourceNote.length > 2_000) throw new Error("source_note must be 2,000 characters or fewer");
  if (!metadata.uploadedBy.trim()) throw new Error("uploaded_by is required");
  if (metadata.uploadedBy.length > 200) throw new Error("uploaded_by must be 200 characters or fewer");
}

export function toProductWiseAug26RecordedProvenance(
  provenance: ProductWiseAug26LoadProvenance,
  controls: Pick<ProductWiseAug26Controls, "rows" | "net">,
): ProductWiseAug26RecordedProvenance {
  return {
    ...provenance,
    fy: AUG26_PRODUCTWISE.fy,
    month: AUG26_PRODUCTWISE.month,
    rows: controls.rows,
    net: controls.net,
    valueBasis: AUG26_PRODUCTWISE.valueBasis,
  };
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
  continuity: ProductWiseAug26Continuity;
  provenance: ProductWiseAug26RecordedProvenance;
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
): Promise<ProductWiseAug26CommitResult> {
  assertProductWiseAug26Controls(prepared);
  assertProductWiseAug26UploadMetadata(provenance);
  if (!Number.isFinite(Date.parse(provenance.uploadedAt))) throw new Error("uploadedAt must be a valid ISO timestamp");
  if (!/^[a-f0-9]{64}$/.test(provenance.archiveSha256)) throw new Error("archiveSha256 must be a lowercase SHA-256 digest");

  let continuity: ProductWiseAug26Continuity | null = null;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('productwise-aug26-load'))`);
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

    await tx.execute(sql`
      DELETE FROM secondary_sku_line
       WHERE fy = ${AUG26_PRODUCTWISE.fy} AND month_label = ${AUG26_PRODUCTWISE.month}
    `);
    for (let offset = 0; offset < prepared.rows.length; offset += 1_000) {
      await tx.insert(secondarySkuLines).values(prepared.rows.slice(offset, offset + 1_000));
    }
    await tx.execute(sql`
      INSERT INTO secondary_sku_load_provenance
        (fy, month_label, source_note, uploaded_by, uploaded_at,
         archive_sha256, row_count, net_amount, source, value_basis)
      VALUES
        (${AUG26_PRODUCTWISE.fy}, ${AUG26_PRODUCTWISE.month},
         ${provenance.sourceNote.trim()}, ${provenance.uploadedBy.trim()},
         ${new Date(provenance.uploadedAt)}, ${provenance.archiveSha256},
         ${prepared.controls.rows}, ${prepared.controls.net},
         ${AUG26_PRODUCTWISE.skuSource}, ${AUG26_PRODUCTWISE.valueBasis})
    `);
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
    continuity: continuity!,
    provenance: toProductWiseAug26RecordedProvenance(provenance, prepared.controls),
  };
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
  }>(
    `SELECT fy, month_label, source_note, uploaded_by, uploaded_at::text,
            archive_sha256, row_count, net_amount::text, value_basis
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
    fy: row.fy,
    month: row.month_label,
    rows: Number(row.row_count),
    net: Number(row.net_amount),
    valueBasis: AUG26_PRODUCTWISE.valueBasis,
  };
}