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

export type ProductReportsPayload = {
  fy: string;
  filtered: boolean;
  /** Month labels the figures are restricted to (empty = full FY). */
  months: string[];
  total: number;
  products: ProductRow[];
};

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

  return {
    fy,
    filtered: hasEntityFilterValues(filter),
    months: months ?? [],
    total: products.reduce((s, p) => s + p.amount, 0),
    products,
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
      key: `product-reports|v1|${fy}`,
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
