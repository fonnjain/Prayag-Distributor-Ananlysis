// GET /api/company-reports?fy=2026-27&asOf=2026-07-13
//   Optional filters: months (comma-sep labels e.g. "Apr-26,May-26"),
//   heads / states / customers (JSON-encoded string arrays).
// GET /api/company-reports/filters?fy= — cascading dropdown options
//   (State Head → states → distributors, from sale_line for that FY).
// GET /api/company-reports/export — same params as the main route; returns
//   an xlsx workbook with one worksheet per report.
//
// Returns all data for Reports 1-7 (company-wide, primary sales only).
// Rules enforced in companyReports.ts:
//   1. Like months only (never full-prior-year vs part-year current).
//   2. Qty never summed across groups (litre/piece unit mismatch).
//   3. Live data from sale_line (populated from live register chain).
import { Router } from "express";
import ExcelJS from "exceljs";
import { and, eq, sql } from "drizzle-orm";
import { db, saleLines } from "@workspace/db";
import {
  buildCompanyReports,
  hasActiveFilter,
  normStateExpr,
  type CompanyReportsFilter,
  type CompanyReportsPayload,
} from "../lib/companyReports.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";
import { isFrozen } from "../lib/customers/registerSync.js";

const router = Router();

// In-process warm-cache TTL. sale_line only changes on register syncs (every
// few hours), so 10 minutes keeps repeat loads instant without staleness risk.
const COMPANY_REPORTS_TTL_MS = 10 * 60 * 1000;

const FY_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_LABEL_RE = /^[A-Z][a-z]{2}-\d{2}$/;

export function parseJsonArray(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      return v.length > 0 ? v.slice(0, 500) : undefined;
    }
  } catch { /* fall through */ }
  return undefined;
}

/** Parse + validate filter params shared by the data and export routes.
 *  Returns null (after responding 400) on invalid input. */
function parseFilter(query: Record<string, unknown>, res: import("express").Response): CompanyReportsFilter | undefined | null {
  const months = typeof query.months === "string" && query.months !== ""
    ? query.months.split(",").map((m) => m.trim()).filter(Boolean)
    : undefined;
  if (months && (months.length > 12 || months.some((m) => !MONTH_LABEL_RE.test(m)))) {
    res.status(400).json({ error: "Invalid months — expected comma-separated labels like Apr-26" });
    return null;
  }
  const heads = parseJsonArray(query.heads);
  const states = parseJsonArray(query.states);
  const customers = parseJsonArray(query.customers);
  const filter: CompanyReportsFilter = { months, heads, states, customers };
  return hasActiveFilter(filter) ? filter : undefined;
}

router.get("/company-reports", async (req, res) => {
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : "2026-27";
  const rawAsOf = typeof req.query.asOf === "string" ? req.query.asOf : undefined;
  if (!FY_RE.test(rawFy)) {
    res.status(400).json({ error: "Invalid fy — expected YYYY-YY" });
    return;
  }
  if (rawAsOf !== undefined && !DATE_RE.test(rawAsOf)) {
    res.status(400).json({ error: "Invalid asOf — expected YYYY-MM-DD" });
    return;
  }
  const filter = parseFilter(req.query as Record<string, unknown>, res);
  if (filter === null) return;

  try {
    if (rawAsOf !== undefined || filter) {
      // Explicit as-of date or active filters — always build live, never
      // cache or snapshot (the key space would be unbounded).
      const payload = await buildCompanyReports(rawFy, rawAsOf, filter);
      res.json(payload);
      return;
    }
    // Cold-start fast path: serve the last persisted payload instantly with
    // meta.snapshotSavedAt + meta.refreshing, rebuilding in the background.
    const payload = await serveWithSnapshot({
      // v2: month-completeness rule fixed (Oct-24-style months no longer
      // dropped) — versioned key forces frozen-FY snapshots to rebuild once.
      key: `company-reports|v3|${rawFy}`,
      ttlMs: COMPANY_REPORTS_TTL_MS,
      build: () => buildCompanyReports(rawFy, undefined),
      log: req.log,
      frozen: isFrozen(rawFy),
    });
    res.json(payload);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "company-reports error");
    res.status(500).json({ error: "Failed to compute company reports" });
  }
});

// ── Cascading filter options ─────────────────────────────────────────────────
// Head → states → distributors, from sale_line for the requested FY. Values
// returned here are exactly what the data route's filters match against.

router.get("/company-reports/filters", async (req, res) => {
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : "2026-27";
  if (!FY_RE.test(rawFy)) {
    res.status(400).json({ error: "Invalid fy — expected YYYY-YY" });
    return;
  }
  try {
    const rows = await db.select({
      head: sql<string>`coalesce(${saleLines.headCanon}, 'Unmapped')`,
      state: normStateExpr(),
      customer: sql<string>`coalesce(${saleLines.customer}, '')`,
    })
      .from(saleLines)
      .where(and(eq(saleLines.fy, rawFy), eq(saleLines.versionStatus, "current")))
      .groupBy(sql`1, 2, 3`);

    // head → state → Set<customer>
    const tree = new Map<string, Map<string, Set<string>>>();
    for (const r of rows) {
      if (!r.customer) continue;
      const states = tree.get(r.head) ?? new Map<string, Set<string>>();
      const custs = states.get(r.state) ?? new Set<string>();
      custs.add(r.customer);
      states.set(r.state, custs);
      tree.set(r.head, states);
    }
    const heads = [...tree.entries()]
      .map(([head, states]) => ({
        head,
        states: [...states.entries()]
          .map(([state, custs]) => ({ state, customers: [...custs].sort() }))
          .sort((a, b) => a.state.localeCompare(b.state)),
      }))
      .sort((a, b) => a.head.localeCompare(b.head));
    res.json({ fy: rawFy, heads });
  } catch (err) {
    req.log.error({ err }, "company-reports filters error");
    res.status(500).json({ error: "Failed to load filter options" });
  }
});

// ── Excel export ─────────────────────────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };

// Availability guards: detail sheets (3B/4/5) can be the full customer×group
// set, so cap rows per sheet and never run more than a couple of workbook
// builds at once (each holds the whole workbook in memory).
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

function buildWorkbook(p: CompanyReportsPayload, filter?: CompanyReportsFilter): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";

  // Cover sheet — basis + any active filters, so an exported file is
  // self-describing and never mistaken for unfiltered company totals.
  const info = wb.addWorksheet("Info");
  info.columns = [{ width: 26 }, { width: 90 }];
  const infoRows: Array<[string, string]> = [
    ["Page", "Company Reports 1-7 (primary sales — Prayag to distributors)"],
    ["FY", p.fy],
    ["Prior FY", p.priorFy],
    ["Like months (this FY)", p.likeMonths.join(", ") || "none"],
    ["Like months (prior FY)", p.likeMonthsPrior.join(", ") || "none"],
    ["As of", p.asOfDate],
    ["State Head filter", filter?.heads?.length ? filter.heads.join(", ") : "All"],
    ["State filter", filter?.states?.length ? filter.states.join(", ") : "All"],
    ["Distributor filter", filter?.customers?.length ? filter.customers.join(", ") : "All"],
    ["Month filter", filter?.months?.length ? filter.months.join(", ") : "All complete months"],
    ["Note", "Figures are territory + project combined as shown on the page. Quantity is never summed across groups (litres vs pieces)."],
  ];
  for (const [k, v] of infoRows) {
    const row = info.addRow([k, v]);
    row.getCell(1).font = { bold: true };
  }

  const compareCols = [
    { header: "Label", key: "label", width: 30 },
    { header: `This FY (${p.fy})`, key: "thisFy" },
    { header: `Last FY (${p.priorFy})`, key: "lastFy" },
    { header: "Diff", key: "diff" },
    { header: "Growth %", key: "growthPct" },
    { header: "Share %", key: "sharePct" },
  ];
  addSheet(wb, "R1-R2 Sale by State", compareCols, p.r1r2_byState as unknown as Array<Record<string, unknown>>);
  addSheet(wb, "R3 By Group", compareCols, p.r3_byGroup as unknown as Array<Record<string, unknown>>);
  addSheet(wb, "R3A State x Group", [
    { header: "State", key: "state", width: 24 },
    { header: "Group", key: "group", width: 24 },
    { header: `This FY`, key: "thisFy" },
    { header: `Last FY`, key: "lastFy" },
  ], p.r3a_byStateGroup as unknown as Array<Record<string, unknown>>);
  addSheet(wb, "R3B Party x Group", [
    { header: "Party", key: "customer", width: 36 },
    { header: "State", key: "state", width: 22 },
    { header: "Group", key: "group", width: 22 },
    { header: `This FY`, key: "thisFy" },
    { header: `Last FY`, key: "lastFy" },
  ], p.r3b_byPartyGroup as unknown as Array<Record<string, unknown>>);
  addSheet(wb, "R4 Quantity", [
    { header: "Group", key: "group", width: 22 },
    { header: "Group (raw)", key: "groupRaw", width: 22 },
    { header: "Party", key: "customer", width: 36 },
    { header: "State", key: "state", width: 22 },
    { header: "Qty this FY", key: "qtyThisFy" },
    { header: "Qty last FY", key: "qtyLastFy" },
    { header: "Unit", key: "unit", width: 8 },
    { header: "Amount this FY", key: "amountThisFy" },
    { header: "Amount last FY", key: "amountLastFy" },
  ], p.r4_byGroupQty as unknown as Array<Record<string, unknown>>);
  addSheet(wb, "R5 By Customer", [
    { header: "Customer", key: "customer", width: 36 },
    { header: "State", key: "state", width: 22 },
    { header: "State Head", key: "head", width: 24 },
    { header: `This FY`, key: "thisFy" },
    { header: `Last FY`, key: "lastFy" },
    { header: "Diff", key: "diff" },
  ], p.r5_byCustomer as unknown as Array<Record<string, unknown>>);
  addSheet(wb, "R6 By Group (full prior)", [
    { header: "Group", key: "group", width: 24 },
    { header: "This FY (like months)", key: "thisFyLike", width: 22 },
    { header: "Last FY (like months)", key: "lastFyLike", width: 22 },
    { header: "Last FY (full year)", key: "lastFyFull", width: 22 },
    { header: "Growth % (like)", key: "growthLike" },
  ], p.r6_byGroupFull as unknown as Array<Record<string, unknown>>);

  const r7 = wb.addWorksheet("R7 As-of Snapshot");
  r7.columns = [{ width: 30 }, { width: 24 }];
  const addR7 = (a: string, b: string | number, bold = false) => {
    const row = r7.addRow([a, b]);
    if (bold) row.font = { bold: true };
  };
  addR7("As-of date", p.r7_asOf.date, true);
  addR7("Total sale", p.r7_asOf.total);
  addR7("Invoice count", p.r7_asOf.invoiceCount);
  addR7("Customer count", p.r7_asOf.customerCount);
  addR7("", "");
  addR7("By group", "Amount", true);
  for (const g of p.r7_asOf.byGroup) addR7(g.group, g.amount);
  addR7("", "");
  addR7("By state", "Amount", true);
  for (const s of p.r7_asOf.byState) addR7(s.state, s.amount);

  return wb;
}

router.get("/company-reports/export", async (req, res) => {
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : "2026-27";
  const rawAsOf = typeof req.query.asOf === "string" ? req.query.asOf : undefined;
  if (!FY_RE.test(rawFy)) {
    res.status(400).json({ error: "Invalid fy — expected YYYY-YY" });
    return;
  }
  if (rawAsOf !== undefined && !DATE_RE.test(rawAsOf)) {
    res.status(400).json({ error: "Invalid asOf — expected YYYY-MM-DD" });
    return;
  }
  const filter = parseFilter(req.query as Record<string, unknown>, res);
  if (filter === null) return;

  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.status(429).json({ error: "Another export is already running — try again in a few seconds." });
    return;
  }
  activeExports++;
  try {
    const payload = await buildCompanyReports(rawFy, rawAsOf, filter);
    const wb = buildWorkbook(payload, filter);
    const buf = await wb.xlsx.writeBuffer();
    const suffix = filter ? "_filtered" : "";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Company_Reports_${rawFy}${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "company-reports export error");
    res.status(500).json({ error: "Export failed" });
  } finally {
    activeExports--;
  }
});

export default router;
