// GET /api/analytics?fy=2026-27&compare=2025-26
//   Optional entity filters: heads / states / customers (JSON-encoded string
//   arrays, values from /api/company-reports/filters). Filtered requests
//   always build live (never snapshot — unbounded key space) and always read
//   the sale_line register (the SAP aggregate has no entity dimensions).
// GET /api/analytics/export — same params; returns an xlsx workbook.
import { Router, type IRouter, type Request, type Response } from "express";
import ExcelJS from "exceljs";
import { buildAnalytics, priorFy, type AnalyticsReport } from "../lib/analytics/analytics.js";
import { hasEntityFilterValues, type EntityFilter } from "../lib/saleLineFilter.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";
import { isFrozen } from "../lib/customers/registerSync.js";
import { parseJsonArray } from "./companyReports.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const DEFAULT_FY = "2026-27";
const ANALYTICS_TTL_MS = 15 * 60 * 1000;

function parseParams(req: Request, res: Response):
  | { fy: string; compareFy: string; filter: EntityFilter | undefined }
  | null {
  const fyRaw = req.query["fy"];
  const fy =
    typeof fyRaw === "string" && fyRaw.trim() !== "" ? fyRaw.trim() : DEFAULT_FY;
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return null;
  }
  const compareRaw = req.query["compare"];
  const compareFy =
    typeof compareRaw === "string" && compareRaw.trim() !== ""
      ? compareRaw.trim()
      : priorFy(fy);
  if (!FY_PATTERN.test(compareFy)) {
    res.status(400).json({ error: "compare must look like 2025-26" });
    return null;
  }
  const filter: EntityFilter = {
    heads: parseJsonArray(req.query.heads),
    states: parseJsonArray(req.query.states),
    customers: parseJsonArray(req.query.customers),
  };
  return { fy, compareFy, filter: hasEntityFilterValues(filter) ? filter : undefined };
}

router.get(
  "/analytics",
  async (req: Request, res: Response): Promise<void> => {
    const params = parseParams(req, res);
    if (!params) return;
    const { fy, compareFy, filter } = params;
    try {
      if (filter) {
        // Active entity filters — always build live, never cache or snapshot
        // (the key space would be unbounded).
        res.json(await buildAnalytics(fy, compareFy, filter));
        return;
      }
      // Snapshot-first: serve the last persisted payload instantly. Both the
      // FY and its comparison year must be frozen for the payload to be final
      // (a live compare year changes as new months are ingested).
      const report = await serveWithSnapshot({
        // v2: month-completeness rule fixed — forces frozen snapshots to rebuild.
        key: `analytics|v2|${fy}|${compareFy}`,
        ttlMs: ANALYTICS_TTL_MS,
        build: () => buildAnalytics(fy, compareFy) as Promise<Record<string, unknown>>,
        log: req.log,
        frozen: isFrozen(fy) && isFrozen(compareFy),
      });
      res.json(report);
    } catch (err) {
      req.log.error({ err, fy, compareFy }, "analytics build failed");
      res.status(500).json({ error: "Could not compute analytics." });
    }
  },
);

// ── Excel export ─────────────────────────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };
const MAX_EXPORT_ROWS_PER_SHEET = 20_000;
const MAX_CONCURRENT_EXPORTS = 2;
let activeExports = 0;

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  columns: Array<{ header: string; key: string; width?: number }>,
  rows: Array<Record<string, unknown>>,
) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18 }));
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
  });
  const truncated = rows.length > MAX_EXPORT_ROWS_PER_SHEET;
  for (const r of rows.slice(0, MAX_EXPORT_ROWS_PER_SHEET)) ws.addRow(columns.map((c) => r[c.key] ?? ""));
  if (truncated) {
    const row = ws.addRow([`… truncated: showing ${MAX_EXPORT_ROWS_PER_SHEET.toLocaleString()} of ${rows.length.toLocaleString()} rows. Narrow the filters to export the rest.`]);
    row.font = { italic: true };
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function buildWorkbook(p: AnalyticsReport, filter?: EntityFilter): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";

  // Cover sheet — basis + active filters, so a filtered file is
  // self-describing and never mistaken for unfiltered company totals.
  const info = wb.addWorksheet("Info");
  info.columns = [{ width: 26 }, { width: 95 }];
  const infoRows: Array<[string, string]> = [
    ["Page", "Growth — YoY analytics on primary sales (sale_line register)"],
    ["FY", p.fy],
    ["Compare FY", p.compareFy],
    ["Source", p.source],
    ["Comparable months", p.comparableMonths.join(", ") || "none"],
    ["State Head filter", filter?.heads?.length ? filter.heads.join(", ") : "All"],
    ["State filter", filter?.states?.length ? filter.states.join(", ") : "All"],
    ["Distributor filter", filter?.customers?.length ? filter.customers.join(", ") : "All"],
    ["Note", "YoY and retention figures use complete months only, matched by month name across both years. The prior FY is scoped to the current-FY customer set when head/state filters are active."],
  ];
  for (const [k, v] of infoRows) {
    const row = info.addRow([k, v]);
    row.getCell(1).font = { bold: true };
  }

  addSheet(wb, "YoY Summary", [
    { header: "Split", key: "split", width: 24 },
    { header: `This FY (${p.fy})`, key: "current" },
    { header: `Last FY (${p.compareFy})`, key: "prior" },
    { header: "Growth %", key: "pct" },
  ], [
    { split: "Overall sales", ...p.yoy.overall },
    { split: "Territory business", ...p.yoy.territory },
    { split: "Institutional business", ...p.yoy.institutional },
  ]);

  const monthCols = [
    { header: "Month", key: "monthLabel", width: 12 },
    { header: "Amount (INR)", key: "amount" },
    { header: "Territory (INR)", key: "territoryAmount" },
    { header: "Institutional (INR)", key: "institutionalAmount" },
    { header: "Complete", key: "complete", width: 10 },
  ];
  addSheet(wb, `Monthly ${p.fy}`, monthCols, p.months as unknown as Array<Record<string, unknown>>);
  addSheet(wb, `Monthly ${p.compareFy}`, monthCols, p.compareMonths as unknown as Array<Record<string, unknown>>);

  addSheet(wb, "By Head", [
    { header: "Head", key: "head", width: 28 },
    { header: "Amount (INR)", key: "amount" },
    { header: "Share %", key: "sharePct", width: 10 },
    { header: "Territory", key: "isTerritory", width: 10 },
  ], p.byHead as unknown as Array<Record<string, unknown>>);

  addSheet(wb, "By Group", [
    { header: "Group", key: "group", width: 26 },
    { header: "Amount (INR)", key: "amount" },
    { header: "Share %", key: "sharePct", width: 10 },
  ], p.groups as unknown as Array<Record<string, unknown>>);

  const ret = wb.addWorksheet("Retention");
  ret.columns = [{ width: 34 }, { width: 22 }];
  const addRet = (a: string, b: string | number, bold = false) => {
    const row = ret.addRow([a, b]);
    if (bold) row.font = { bold: true };
  };
  addRet("Period (comparable months)", p.retention.periodMonths.join(", ") || "none", true);
  addRet("Retained customers", p.retention.retained);
  addRet("New customers", p.retention.newCustomers);
  addRet("Lost customers", p.retention.lost);
  addRet("Retained revenue (INR)", p.retention.retainedRevenue);
  addRet("New revenue (INR)", p.retention.newRevenue);
  addRet("Lost prior revenue (INR)", p.retention.lostPriorRevenue);

  addSheet(wb, "Margins", [
    { header: "Group", key: "group", width: 26 },
    { header: "Revenue (INR)", key: "revenue" },
    { header: "Margin (INR)", key: "margin" },
  ], p.margins.byGroup as unknown as Array<Record<string, unknown>>);

  return wb;
}

router.get("/analytics/export", async (req: Request, res: Response): Promise<void> => {
  const params = parseParams(req, res);
  if (!params) return;
  const { fy, compareFy, filter } = params;

  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.status(429).json({ error: "Another export is already running — try again in a few seconds." });
    return;
  }
  activeExports++;
  try {
    const payload = await buildAnalytics(fy, compareFy, filter);
    const wb = buildWorkbook(payload, filter);
    const buf = await wb.xlsx.writeBuffer();
    const suffix = filter ? "_filtered" : "";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Growth_${fy}${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    req.log.error({ err, fy, compareFy }, "analytics export error");
    res.status(500).json({ error: "Export failed" });
  } finally {
    activeExports--;
  }
});

export default router;
