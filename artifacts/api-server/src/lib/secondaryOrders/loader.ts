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
import { pool } from "@workspace/db";
import { canonGroupFromMap } from "../sku/catalogue.js";
import { normSecKey } from "../mgmt/names.js";
import { logger } from "../logger.js";

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

type PersonRow = { person_id: number; name: string; norm_key: string };
let _personCache: PersonRow[] | null = null;

async function getPersons(): Promise<PersonRow[]> {
  if (_personCache) return _personCache;
  const { rows } = await pool.query<PersonRow>(
    "SELECT person_id, name, norm_key FROM person ORDER BY person_id",
  );
  _personCache = rows;
  return rows;
}

async function resolvePersonId(rawName: string | null): Promise<number | null> {
  if (!rawName) return null;
  const persons = await getPersons();
  const key = normSecKey(rawName);
  const matches = persons.filter((p) => normSecKey(p.name) === key || p.norm_key === key);
  if (matches.length === 1) return matches[0].person_id;
  return null; // ambiguous or not found
}

// ── Load result ───────────────────────────────────────────────────────────────

export type CollisionDetail = {
  orderId: string;
  productCode: string;
  field: string;
  stored: string | null;
  incoming: string | null;
};

export type LoadResult = {
  rowsScanned: number;
  rowsInserted: number;
  rowsSkipped: number;        // same values, idempotent
  collisions: CollisionDetail[];
  unresolvedSalesUsers: string[];
  unmappedCategories: string[];
  sourceFile: string;
};

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
  };

  const rows: RawRow[] = [];
  let colIdx: ColIndex | null = null;
  let rowsScanned = 0;
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
      });
    }
    break; // first sheet only
  }

  if (!colIdx) throw new Error("No header row found in secondary order report XLSX");

  // Resolve sales user IDs in bulk
  const persons = await getPersons();
  const nameToPersonId = new Map<string, number | null>();
  for (const rawName of unresolvedRawUsers) {
    const key = normSecKey(rawName);
    const matches = persons.filter((p) => normSecKey(p.name) === key || p.norm_key === key);
    nameToPersonId.set(rawName, matches.length === 1 ? matches[0].person_id : null);
  }

  // Determine which sales users were unresolved
  const unresolvedSalesUsers: string[] = [];
  for (const [name, id] of nameToPersonId) {
    if (id === null) unresolvedSalesUsers.push(name);
  }

  if (dryRun) {
    logger.info({ rowsScanned, rowsParsed: rows.length, dryRun: true }, "[secondaryOrders] dry run complete");
    return {
      rowsScanned,
      rowsInserted: 0,
      rowsSkipped: 0,
      collisions: [],
      unresolvedSalesUsers,
      unmappedCategories: Array.from(unmappedCategories),
      sourceFile,
    };
  }

  // ── Upsert rows with collision detection ─────────────────────────────────
  // Strategy: INSERT ... ON CONFLICT DO NOTHING for idempotent rows.
  // For each conflict, compare stored vs incoming and report if different.

  let rowsInserted = 0;
  let rowsSkipped = 0;
  const collisions: CollisionDetail[] = [];

  const BATCH_SIZE = 500;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const r of batch) {
        const salesUserId = r.salesUserName ? (nameToPersonId.get(r.salesUserName) ?? null) : null;

        const result = await client.query<{ id: number }>(
          `INSERT INTO secondary_order_line
             (order_id, order_datetime, order_status, sales_user_name, sales_user_id,
              customer_name, dealer_id, dealer_mobile, cp_name, cp_code,
              state, district, city, pincode,
              category_name, segment_canon, product_code,
              gst_pct, gst_amount, qty, discount_pct, discount_amount,
              dealer_order_value, basic_order_value, source_file)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
              $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
           ON CONFLICT (order_id, product_code) DO NOTHING
           RETURNING id`,
          [
            r.orderId, r.orderDatetime, r.orderStatus, r.salesUserName, salesUserId,
            r.customerName, r.dealerId, r.dealerMobile, r.cpName, r.cpCode,
            r.state, r.district, r.city, r.pincode,
            r.categoryName, r.segmentCanon, r.productCode,
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
          }>(
            `SELECT order_status, qty, basic_order_value, dealer_order_value, discount_pct
             FROM secondary_order_line
             WHERE order_id = $1 AND product_code = $2`,
            [r.orderId, r.productCode],
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
                collisions.push({ orderId: r.orderId, productCode: r.productCode, field, stored, incoming });
              }
            }
            if (!hasDiff) rowsSkipped++;
          } else {
            rowsSkipped++;
          }
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      client.release();
      throw err;
    }
    client.release();
  }

  logger.info(
    { rowsScanned, rowsInserted, rowsSkipped, collisions: collisions.length, sourceFile },
    "[secondaryOrders] load complete",
  );

  return {
    rowsScanned,
    rowsInserted,
    rowsSkipped,
    collisions,
    unresolvedSalesUsers,
    unmappedCategories: Array.from(unmappedCategories),
    sourceFile,
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
        MIN(order_datetime)::date::text      AS date_min,
        MAX(order_datetime)::date::text      AS date_max,
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
        COUNT(*) FILTER (WHERE cm.id IS NOT NULL)::text AS matched,
        COUNT(*)::text AS total,
        array_agg(DISTINCT sol.dealer_id) FILTER (WHERE cm.id IS NULL) AS unmatched_ids
      FROM secondary_order_line sol
      LEFT JOIN customer_master cm ON cm.id = sol.dealer_id
    `),
    pool.query<{ matched: string; total: string; unmatched_ids: string[] }>(`
      SELECT
        COUNT(*) FILTER (WHERE cm.id IS NOT NULL)::text AS matched,
        COUNT(*)::text AS total,
        array_agg(DISTINCT sol.cp_code) FILTER (WHERE cm.id IS NULL) AS unmatched_ids
      FROM secondary_order_line sol
      LEFT JOIN customer_master cm ON cm.id = sol.cp_code
    `),
    pool.query<{ matched: string; total: string; unmatched_names: string[] }>(`
      SELECT
        COUNT(*) FILTER (WHERE p.person_id IS NOT NULL)::text AS matched,
        COUNT(*)::text AS total,
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
    discountAbove90: discountLines.rows,
    secondarySkuLineCount: Number(oc.ssl),
    secondaryRegisterLineCount: Number(oc.srl),
    saleLineCount: Number(oc.sl),
  };
}
