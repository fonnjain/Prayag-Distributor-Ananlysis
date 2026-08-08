// GET /api/product-reports?fy=2026-27&heads=[..]&states=[..]&customers=[..]
//   Products page data: per-product sales from sale_line for the FY, with the
//   shared State Head / State / Distributor filters (values from
//   /api/company-reports/filters).
// GET /api/product-reports/export — same params; returns an xlsx workbook.
//
// RULE 2 (litre rule) is respected: qty is reported per product code only,
// never summed across products/groups. WATER TANK rows report litres.
import { Router } from "express";
import ExcelJS from "exceljs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, saleLines, itemMaster } from "@workspace/db";
import {
  resolveProductCode,
  buildResolverIndex,
} from "../lib/sku/productCodeResolver.js";
import {
  entityConds,
  hasEntityFilterValues,
  type EntityFilter,
} from "../lib/saleLineFilter.js";
import { parseJsonArray } from "./companyReports.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";
import { parseMonthsParam } from "../lib/periodMonths.js";
import { isFrozen } from "../lib/customers/registerSync.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";

const router = Router();

const FY_RE = /^\d{4}-\d{2}$/;
const DEFAULT_FY = "2026-27";
const PRODUCT_REPORTS_TTL_MS = 10 * 60 * 1000;

export type ProductRow = {
  code: string;
  product: string;
  group: string;
  qty: number;
  unit: string;
  amount: number;
};

/** A code+feature listed under two segments with different MRP — kept
 *  unresolved (loaded under both) pending a business decision. */
export type MrpConflict = {
  code: string;
  feature: string;
  product: string;
  options: { segment: string; mrp: number | null }[];
};

/** A segment name from the product upload that has no canonical mapping yet
 *  (MANHOLE COVER / WATER HEATER / COCKROACH TRAPS & GRATINGS). */
export type UnmappedSegment = {
  segment: string;
  codes: number;
};

/** Register codes (this FY) that fail to resolve to any master code,
 *  grouped by family prefix, so the catalogue gap is sized and visible. */
export type RegisterGap = {
  totalUnresolved: number;
  totalCodes: number;
  prefixes: { prefix: string; codes: number }[];
};

export type ProductDataQuality = {
  mrpConflicts: MrpConflict[];
  unmappedSegments: UnmappedSegment[];
  unmappedCodeTotal: number;
  registerGap: RegisterGap;
};

export type ProductReportsPayload = {
  fy: string;
  filtered: boolean;
  /** Month labels the figures are restricted to (empty = full FY). */
  months: string[];
  total: number;
  products: ProductRow[];
  /** Data-quality panels from the Product_Upload_Sample_File.csv load. */
  dataQuality: ProductDataQuality;
};

/** Family prefix for an unresolved register code: leading letters up to and
 *  including a hyphen (PTA-, CPCS-), else the leading letter run, else the
 *  bucket "(numeric)" for all-digit codes. Mirrors the loader script. */
function familyPrefix(code: string): string {
  const hyphen = /^([A-Za-z]+-)/.exec(code);
  if (hyphen) return hyphen[1];
  const alpha = /^([A-Za-z]+)/.exec(code);
  if (alpha) return alpha[1];
  return "(numeric)";
}

/**
 * Build the three data-quality panels the Products page renders:
 *   (a) the unresolved MRP conflicts (TTS-01/02/03),
 *   (b) the "segment not yet mapped" UNMAPPED segments,
 *   (c) the unresolved register-code gap for this FY, grouped by prefix.
 * These do NOT depend on the entity/month filter — they describe the loaded
 * master and the whole FY register — so they are computed once per FY.
 */
export async function buildProductDataQuality(fy: string): Promise<ProductDataQuality> {
  // (a) MRP conflicts — variants flagged mrp_conflict, grouped by (code,feature).
  const conflictRows = await db.execute<{
    code: string;
    feature_name: string;
    product_name: string | null;
    segment_source: string | null;
    mrp: string | null;
  }>(sql`
    SELECT code, feature_name, product_name, segment_source, mrp
    FROM item_master_variant
    WHERE mrp_conflict = TRUE
    ORDER BY code, feature_name, segment_source
  `);
  const conflictMap = new Map<string, MrpConflict>();
  for (const r of conflictRows.rows) {
    const key = `${r.code}\u0000${r.feature_name}`;
    let c = conflictMap.get(key);
    if (!c) {
      c = {
        code: r.code,
        feature: r.feature_name,
        product: r.product_name ?? "",
        options: [],
      };
      conflictMap.set(key, c);
    }
    c.options.push({
      segment: r.segment_source ?? "",
      mrp: r.mrp === null ? null : Number(r.mrp),
    });
  }
  const mrpConflicts = Array.from(conflictMap.values());

  // (b) UNMAPPED segments — distinct source segments whose canon is UNMAPPED,
  //     with the code count per source segment.
  const unmappedRows = await db.execute<{ segment_source: string; codes: string }>(sql`
    SELECT segment_source, count(DISTINCT code)::text AS codes
    FROM item_master_variant
    WHERE segment_canon = 'UNMAPPED'
    GROUP BY segment_source
    ORDER BY segment_source
  `);
  const unmappedSegments = unmappedRows.rows.map((r) => ({
    segment: r.segment_source ?? "",
    codes: Number(r.codes),
  }));
  const unmappedTotalRow = await db.execute<{ codes: string }>(sql`
    SELECT count(DISTINCT code)::text AS codes
    FROM item_master_variant
    WHERE segment_canon = 'UNMAPPED'
  `);
  const unmappedCodeTotal = Number(unmappedTotalRow.rows[0]?.codes ?? 0);

  // (c) Register-code gap — resolve every distinct FY code against the master
  //     using the shared resolver (exact first). Group the unresolved by prefix.
  const masterRes = await db.execute<{ code: string }>(sql`SELECT code FROM item_master`);
  const { has, codes } = buildResolverIndex(masterRes.rows.map((r) => r.code));
  const fyCodesRes = await db.execute<{ code: string }>(
    sql`SELECT DISTINCT code FROM sale_line WHERE fy = ${fy}`,
  );
  const fyCodes = fyCodesRes.rows.map((r) => r.code);
  const prefixCounts = new Map<string, number>();
  let totalUnresolved = 0;
  for (const c of fyCodes) {
    const r = resolveProductCode(c, has, codes);
    if (r.method === "unresolved") {
      totalUnresolved++;
      const p = familyPrefix(c);
      prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
    }
  }
  const prefixes = Array.from(prefixCounts.entries())
    .map(([prefix, cnt]) => ({ prefix, codes: cnt }))
    .sort((a, b) => b.codes - a.codes || a.prefix.localeCompare(b.prefix))
    .slice(0, 10);

  return {
    mrpConflicts,
    unmappedSegments,
    unmappedCodeTotal,
    registerGap: { totalUnresolved, totalCodes: fyCodes.length, prefixes },
  };
}

export async function buildProductReports(
  fy: string,
  filter?: EntityFilter,
  months?: string[],
): Promise<ProductReportsPayload> {
  const rows = await db
    .select({
      code: saleLines.code,
      product: sql<string>`coalesce(max(${itemMaster.itemName}), ${saleLines.code})`,
      group: sql<string>`coalesce(max(${saleLines.groupCanon}), 'Unmapped')`,
      // Per-code qty only (RULE 2): tanks report litres, everything else pieces.
      qty: sql<number>`coalesce(case when max(coalesce(${saleLines.groupRaw}, '')) = 'WATER TANK' then sum(${saleLines.qtyLtr}::numeric) else sum(${saleLines.qty}::numeric) end, 0)::float8`,
      unit: sql<string>`case when max(coalesce(${saleLines.groupRaw}, '')) = 'WATER TANK' then 'Ltr' else coalesce(max(${itemMaster.unit}), '') end`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
    })
    .from(saleLines)
    .leftJoin(itemMaster, eq(saleLines.code, itemMaster.code))
    .where(and(
      eq(saleLines.fy, fy),
      eq(saleLines.versionStatus, "current"),
      ...(months && months.length > 0 ? [inArray(saleLines.monthLabel, months)] : []),
      ...entityConds(filter),
    ))
    .groupBy(saleLines.code);

  const products = rows
    .map((r) => ({
      code: r.code,
      product: r.product,
      group: r.group,
      qty: Math.round(r.qty * 100) / 100,
      unit: r.unit,
      amount: Math.round(r.amount),
    }))
    .sort((a, b) => b.amount - a.amount);

  const dataQuality = await buildProductDataQuality(fy);

  return {
    fy,
    filtered: hasEntityFilterValues(filter),
    months: months ?? [],
    total: products.reduce((s, p) => s + p.amount, 0),
    products,
    dataQuality,
  };
}

function parseParams(req: import("express").Request, res: import("express").Response):
  | { fy: string; filter: EntityFilter | undefined; months: string[] | undefined }
  | null {
  const fy = typeof req.query.fy === "string" && req.query.fy.trim() !== ""
    ? req.query.fy.trim()
    : DEFAULT_FY;
  if (!FY_RE.test(fy)) {
    res.status(400).json({ error: "Invalid fy — expected YYYY-YY" });
    return null;
  }
  const monthsResult = parseMonthsParam(req.query.months, fy);
  if (!monthsResult.ok) {
    res.status(400).json({ error: monthsResult.error });
    return null;
  }
  const months = monthsResult.months;
  const filter: EntityFilter = {
    heads: parseJsonArray(req.query.heads),
    states: parseJsonArray(req.query.states),
    customers: parseJsonArray(req.query.customers),
  };
  return { fy, filter: hasEntityFilterValues(filter) ? filter : undefined, months };
}

router.get("/product-reports", async (req, res) => {
  const params = parseParams(req, res);
  if (!params) return;
  const { fy, filter, months } = params;
  try {
    if (filter || (months && months.length > 0)) {
      // Active filters or a sub-year period — always build live, never cache
      // or snapshot (the key space would be unbounded).
      res.json(await buildProductReports(fy, filter, months));
      return;
    }
    const payload = await serveWithSnapshot({
      key: `product-reports|v2|${fy}`,
      ttlMs: PRODUCT_REPORTS_TTL_MS,
      build: () => buildProductReports(fy) as unknown as Promise<Record<string, unknown>>,
      log: req.log,
      frozen: isFrozen(fy),
    });
    res.json(payload);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "product-reports error");
    res.status(500).json({ error: "Failed to compute product reports" });
  }
});

// ── Excel export ─────────────────────────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };
const MAX_EXPORT_ROWS_PER_SHEET = 20_000;
const MAX_CONCURRENT_EXPORTS = 2;
let activeExports = 0;

router.get("/product-reports/export", async (req, res) => {
  const params = parseParams(req, res);
  if (!params) return;
  const { fy, filter, months } = params;

  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.status(429).json({ error: "Another export is already running — try again in a few seconds." });
    return;
  }
  activeExports++;
  try {
    const p = await buildProductReports(fy, filter, months);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Prayag Sales Intelligence";

    // Cover sheet — basis + active filters, so a filtered file is
    // self-describing and never mistaken for unfiltered company totals.
    const info = wb.addWorksheet("Info");
    info.columns = [{ width: 26 }, { width: 95 }];
    const infoRows: Array<[string, string]> = [
      ["Page", `Products — FY ${p.fy} primary sales by product (sale_line register)`],
      ["FY", p.fy],
      ["Month filter", months?.length ? months.join(", ") : "Full FY"],
      ["Total sales (INR)", String(p.total)],
      ["State Head filter", filter?.heads?.length ? filter.heads.join(", ") : "All"],
      ["State filter", filter?.states?.length ? filter.states.join(", ") : "All"],
      ["Distributor filter", filter?.customers?.length ? filter.customers.join(", ") : "All"],
      ["Note", "Quantity is per product only and must never be summed across products or groups (litres vs pieces). WATER TANK rows report litres."],
    ];
    for (const [k, v] of infoRows) {
      const row = info.addRow([k, v]);
      row.getCell(1).font = { bold: true };
    }

    const ws = wb.addWorksheet("Products");
    const columns = [
      { header: "Code", key: "code", width: 14 },
      { header: "Product", key: "product", width: 40 },
      { header: "Group", key: "group", width: 22 },
      { header: "Qty", key: "qty", width: 12 },
      { header: "Unit", key: "unit", width: 8 },
      { header: "Sales (INR)", key: "amount", width: 16 },
    ];
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
    });
    const truncated = p.products.length > MAX_EXPORT_ROWS_PER_SHEET;
    for (const r of p.products.slice(0, MAX_EXPORT_ROWS_PER_SHEET)) {
      ws.addRow(columns.map((c) => (r as unknown as Record<string, unknown>)[c.key] ?? ""));
    }
    if (truncated) {
      const row = ws.addRow([`… truncated: showing ${MAX_EXPORT_ROWS_PER_SHEET.toLocaleString()} of ${p.products.length.toLocaleString()} rows. Narrow the filters to export the rest.`]);
      row.font = { italic: true };
    }
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    const suffix = p.filtered ? "_filtered" : "";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Products_${fy}${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "product-reports export error");
    res.status(500).json({ error: "Export failed" });
  } finally {
    activeExports--;
  }
});

export default router;
