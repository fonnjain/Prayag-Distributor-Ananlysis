// GET /api/company-reports?fy=2026-27&asOf=2026-07-13
import { currentOpenFy } from "../lib/fyAnchors.js";
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
  applyMonthFilter,
  asOfScopedMonths,
  computeLikeMonths,
  hasActiveFilter,
  normStateExpr,
  type CompanyReportsFilter,
  type CompanyReportsPayload,
} from "../lib/companyReports.js";
import { priorFy as getPriorFy } from "../lib/mgmt/names.js";
import { entityCondsAliased, normStateExprAliased } from "../lib/saleLineFilter.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";
import { isFrozen } from "../lib/customers/registerSync.js";
import { provisionalMonthsExportInfo } from "../lib/exportInfo.js";

const router = Router();

// In-process warm-cache TTL. sale_line only changes on register syncs (every
// few hours), so 10 minutes keeps repeat loads instant without staleness risk.
const COMPANY_REPORTS_TTL_MS = 10 * 60 * 1000;

const FY_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_LABEL_RE = /^[A-Z][a-z]{2}-\d{2}$/;

export function parseJsonArray(raw: unknown): string[] | undefined {
  const tokens = Array.isArray(raw) ? raw : [raw];
  const values: string[] = [];
  for (const token of tokens) {
    if (typeof token !== "string" || token === "") continue;
    try {
      const decoded: unknown = JSON.parse(token);
      if (Array.isArray(decoded)) {
        values.push(...decoded.filter((value): value is string => typeof value === "string"));
        continue;
      }
    } catch { /* accept repeated plain query values below */ }
    values.push(token);
  }
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return unique.length > 0 ? unique.slice(0, 500) : undefined;
}

function parseMonths(raw: unknown): string[] | undefined {
  // Do not use parseJsonArray here: its general-purpose 500-value cap and
  // deduplication would let an invalid or 13th month disappear before
  // validation. Month validation must see every submitted token first.
  const tokens = Array.isArray(raw) ? raw : [raw];
  const values: string[] = [];
  for (const token of tokens) {
    if (typeof token !== "string" || token === "") continue;
    try {
      const decoded: unknown = JSON.parse(token);
      if (Array.isArray(decoded)) {
        values.push(...decoded.filter((value): value is string => typeof value === "string"));
        continue;
      }
    } catch { /* accept repeated plain query values below */ }
    values.push(token);
  }
  const months = values.flatMap((value) => value.split(",").map((month) => month.trim()).filter(Boolean));
  return months.length > 0 ? months : undefined;
}

function canonicalFilter(filter: CompanyReportsFilter | undefined): CompanyReportsFilter | undefined {
  if (!filter) return undefined;
  const unique = (values?: string[]) => values?.length ? [...new Set(values.map((value) => value.trim()).filter(Boolean))] : undefined;
  const normalized = {
    months: unique(filter.months),
    heads: unique(filter.heads),
    states: unique(filter.states),
    customers: unique(filter.customers),
  };
  return hasActiveFilter(normalized) ? normalized : undefined;
}

export function parseCompanyReportsFilter(query: Record<string, unknown>): {
  filter: CompanyReportsFilter | undefined;
  invalidMonths: boolean;
} {
  const months = parseMonths(query.months);
  return {
    filter: canonicalFilter({
      months,
      heads: parseJsonArray(query.heads),
      states: parseJsonArray(query.states),
      customers: parseJsonArray(query.customers),
    }),
    invalidMonths: Boolean(months && (months.length > 12 || months.some((m) => !MONTH_LABEL_RE.test(m)))),
  };
}

/** Parse + validate filter params shared by the data and export routes. */
function parseFilter(
  query: Record<string, unknown>,
  res: import("express").Response,
): CompanyReportsFilter | undefined | null {
  const parsed = parseCompanyReportsFilter(query);
  if (parsed.invalidMonths) {
    res.status(400).json({ error: "Invalid months — expected comma-separated labels like Apr-26" });
    return null;
  }
  return parsed.filter;
}

type DrillPeriod = {
  currentMonths: string[];
  priorMonths: string[];
  mode: "complete-like-months" | "selected-complete-like-months";
};

async function resolveDrillPeriod(fy: string, requestedMonths?: string[]): Promise<DrillPeriod> {
  const like = await computeLikeMonths(fy);
  const selected = applyMonthFilter(like.current, like.prior, requestedMonths?.length ? { months: requestedMonths } : undefined);
  return {
    currentMonths: selected.likeMonths,
    priorMonths: selected.likeMonthsPrior,
    mode: requestedMonths?.length ? "selected-complete-like-months" : "complete-like-months",
  };
}

export const DRILL_ROW_LIMIT = 5_000;

export function report4Reconciliation(
  totalRows: number,
  parentAmount: number,
  childAmount: number,
): {
  parentAmount: number;
  childAmount: number;
  delta: number;
  unattributed: number | null;
  complete: boolean;
} {
  const complete = totalRows <= DRILL_ROW_LIMIT;
  const delta = childAmount - parentAmount;
  return {
    parentAmount,
    childAmount,
    delta,
    unattributed: complete ? delta : null,
    complete,
  };
}

function scopedText(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : undefined;
}

export function registryJoinForDrill() {
  // Join the bounded period/entity rowset to effective registry candidates and
  // discard lower-priority candidates with NOT EXISTS. This avoids a
  // per-sale-row LATERAL lookup; PostgreSQL can plan the candidate join as a
  // hash/index join and only evaluates the precedence check for matches.
  return sql`
    LEFT JOIN canonical_item_category_registry r
      ON UPPER(BTRIM(r.item_code)) = UPPER(BTRIM(sl.code))
      AND (r.effective_from IS NULL OR r.effective_from <= COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY')))
      AND (r.effective_to IS NULL OR COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY')) < r.effective_to)
      AND NOT EXISTS (
        SELECT 1
        FROM canonical_item_category_registry r2
        WHERE UPPER(BTRIM(r2.item_code)) = UPPER(BTRIM(r.item_code))
          AND (r2.effective_from IS NULL OR r2.effective_from <= COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY')))
          AND (r2.effective_to IS NULL OR COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY')) < r2.effective_to)
          AND (
            (r2.effective_from IS NOT NULL AND r.effective_from IS NULL)
            OR (r2.effective_from > r.effective_from)
            OR (r2.effective_from IS NOT DISTINCT FROM r.effective_from AND r2.id > r.id)
          )
      )
  `;
}

function drillPeriodClause(fy: string, priorFy: string, period: DrillPeriod) {
  if (!period.currentMonths.length) return sql`AND false`;
  return sql`AND ((sl.fy = ${fy} AND sl.month_label IN (${sql.join(period.currentMonths.map((month) => sql`${month}`), sql`, `)}))
    OR (sl.fy = ${priorFy} AND sl.month_label IN (${sql.join(period.priorMonths.map((month) => sql`${month}`), sql`, `)})))`;
}

/**
 * Report 4's expensive level is item code. It is deliberately a single
 * grouped query (rather than one request per group/customer), bounded before
 * JSON serialization, with parent/child reconciliation values attached.
 */
async function report4Items(
  fy: string,
  filter: CompanyReportsFilter | undefined,
  group: string | undefined,
  period: DrillPeriod,
) {
  const priorFy = getPriorFy(fy);
  const groupClause = group ? sql`AND COALESCE(r.master_category, 'Unmapped') = ${group}` : sql``;
  const result = await db.execute<{
    code: string; itemName: string | null; group: string; subcategory: string;
    amountThisFy: number | string; amountLastFy: number | string;
    qtyThisFy: number | string; qtyLastFy: number | string;
    totalRows: number | string; totalAmount: number | string;
  }>(sql`
    SELECT sl.code, MAX(im.item_name) AS "itemName",
      COALESCE(r.master_category, 'Unmapped') AS "group",
      COALESCE(r.canonical_category, 'Unmapped') AS subcategory,
      COALESCE(SUM(sl.amount::numeric) FILTER (WHERE sl.fy = ${fy}), 0)::float8 AS "amountThisFy",
      COALESCE(SUM(sl.amount::numeric) FILTER (WHERE sl.fy = ${priorFy}), 0)::float8 AS "amountLastFy",
      COALESCE(SUM(CASE WHEN sl.fy = ${fy} AND sl.group_raw = 'WATER TANK' THEN sl.qty_ltr::numeric
        WHEN sl.fy = ${fy} THEN sl.qty::numeric ELSE 0 END), 0)::float8 AS "qtyThisFy",
      COALESCE(SUM(CASE WHEN sl.fy = ${priorFy} AND sl.group_raw = 'WATER TANK' THEN sl.qty_ltr::numeric
        WHEN sl.fy = ${priorFy} THEN sl.qty::numeric ELSE 0 END), 0)::float8 AS "qtyLastFy",
      COUNT(*) OVER ()::int AS "totalRows",
      SUM(SUM(sl.amount::numeric) FILTER (WHERE sl.fy = ${fy})) OVER ()::float8 AS "totalAmount"
    FROM sale_line_current sl
    LEFT JOIN item_master im ON im.code = sl.code
    ${registryJoinForDrill()}
      WHERE 1=1 ${drillPeriodClause(fy, priorFy, period)}
      ${entityCondsAliased(filter, "sl")} ${groupClause}
    GROUP BY sl.code, r.master_category, r.canonical_category
    ORDER BY "amountThisFy" DESC, sl.code
    LIMIT ${DRILL_ROW_LIMIT}
  `);
  const rows = result.rows.map((row) => ({
    code: row.code, itemName: row.itemName ?? "", group: row.group,
    subcategory: row.subcategory,
    qtyThisFy: Number(row.qtyThisFy), qtyLastFy: Number(row.qtyLastFy),
    amountThisFy: Number(row.amountThisFy), amountLastFy: Number(row.amountLastFy),
  }));
  const totalRows = Number(result.rows[0]?.totalRows ?? rows.length);
  const childAmount = rows.reduce((sum, row) => sum + row.amountThisFy, 0);
  const parentAmount = Number(result.rows[0]?.totalAmount ?? childAmount);
  return {
    rows, limit: DRILL_ROW_LIMIT, totalRows, truncated: totalRows > DRILL_ROW_LIMIT,
    reconciliation: report4Reconciliation(totalRows, parentAmount, childAmount),
    source: "sale_line_current + canonical_item_category_registry + item_master; taxable amount, registry-effective item assignment",
  };
}

async function report7Parties(
  fy: string,
  asOf: string,
  filter: CompanyReportsFilter | undefined,
  group: string | undefined,
  state: string | undefined,
  period: DrillPeriod,
) {
  const groupClause = group ? sql`AND COALESCE(r.master_category, 'Unmapped') = ${group}` : sql``;
  const stateClause = state ? sql`AND ${normStateExprAliased("sl")} = ${state}` : sql``;
  const selectedMonths = period.currentMonths.length
    ? sql`AND sl.month_label IN (${sql.join(period.currentMonths.map((value) => sql`${value}`), sql`, `)})`
    : sql`AND false`;
  const result = await db.execute<{
    customer: string; state: string; group: string; amount: number | string;
    totalRows: number | string; totalAmount: number | string;
  }>(sql`
    SELECT COALESCE(sl.customer, '') AS customer, ${normStateExprAliased("sl")} AS state,
      COALESCE(r.master_category, 'Unmapped') AS "group",
      COALESCE(SUM(sl.amount::numeric), 0)::float8 AS amount,
      COUNT(*) OVER ()::int AS "totalRows",
      SUM(SUM(sl.amount::numeric)) OVER ()::float8 AS "totalAmount"
    FROM sale_line_current sl
    ${registryJoinForDrill()}
    WHERE sl.fy = ${fy}
      AND (sl.invoice_date IS NULL OR sl.invoice_date <= ${asOf})
      ${selectedMonths} ${entityCondsAliased(filter, "sl")} ${groupClause} ${stateClause}
    GROUP BY 1, 2, 3
    ORDER BY amount DESC, customer
    LIMIT ${DRILL_ROW_LIMIT}
  `);
  const rows = result.rows.map((row) => ({ customer: row.customer, state: row.state, group: row.group, amount: Number(row.amount) }));
  const totalRows = Number(result.rows[0]?.totalRows ?? rows.length);
  const childAmount = rows.reduce((sum, row) => sum + row.amount, 0);
  const parentAmount = Number(result.rows[0]?.totalAmount ?? childAmount);
  return {
    rows, limit: DRILL_ROW_LIMIT, totalRows, truncated: totalRows > DRILL_ROW_LIMIT,
    reconciliation: { parentAmount, childAmount, delta: childAmount - parentAmount, complete: totalRows <= DRILL_ROW_LIMIT },
    source: "sale_line_current + canonical_item_category_registry; taxable amount through as-of date",
  };
}

router.get("/company-reports", async (req, res) => {
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : currentOpenFy();
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
      const payload = await buildCompanyReports(rawFy, rawAsOf, filter, { includeC1ExportData: true });
      res.json(payload);
      return;
    }
    // Cold-start fast path: serve the last persisted payload instantly with
    // meta.snapshotSavedAt + meta.refreshing, rebuilding in the background.
    const payload = await serveWithSnapshot({
      // v2: month-completeness rule fixed (Oct-24-style months no longer
      // dropped) — versioned key forces frozen-FY snapshots to rebuild once.
      // v4 includes R1 party/R2 month drill data in the normal web payload.
      key: `company-reports|v4|${rawFy}`,
      ttlMs: COMPANY_REPORTS_TTL_MS,
      build: () => buildCompanyReports(rawFy, undefined, undefined, { includeC1ExportData: true }),
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
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : currentOpenFy();
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

// Browser drill endpoints. Aliases keep the resource names readable to the
// page while allowing older clients to use the report-number spelling.
router.get(["/company-reports/report4/items", "/company-reports/r4/items"], async (req, res) => {
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : currentOpenFy();
  if (!FY_RE.test(rawFy)) return res.status(400).json({ error: "Invalid fy — expected YYYY-YY" });
  const filter = parseFilter(req.query as Record<string, unknown>, res);
  if (filter === null) return;
  const state = scopedText(req.query as Record<string, unknown>, "state");
  try {
    const period = await resolveDrillPeriod(rawFy, filter?.months);
    return res.json({
      fy: rawFy,
      scope: {
        state,
        distributor: filter?.customers?.[0] ?? null,
        group: scopedText(req.query as Record<string, unknown>, "group"),
        period,
      },
      ...(await report4Items(rawFy, state ? { ...filter, states: [state] } : filter, scopedText(req.query as Record<string, unknown>, "group"), period)),
    });
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "company-reports report 4 item drill error");
    return res.status(500).json({ error: "Failed to load Report 4 item drill-down" });
  }
});

router.get(["/company-reports/report7/parties", "/company-reports/r7/parties"], async (req, res) => {
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : currentOpenFy();
  const asOf = typeof req.query.asOf === "string" ? req.query.asOf : new Date().toISOString().slice(0, 10);
  if (!FY_RE.test(rawFy) || !DATE_RE.test(asOf)) {
    return res.status(400).json({ error: "Invalid fy or asOf" });
  }
  const filter = parseFilter(req.query as Record<string, unknown>, res);
  if (filter === null) return;
  try {
    const resolvedPeriod = await resolveDrillPeriod(rawFy, filter?.months);
    const currentMonths = asOfScopedMonths(rawFy, asOf, resolvedPeriod.currentMonths);
    const period: DrillPeriod = {
      ...resolvedPeriod,
      currentMonths,
      priorMonths: currentMonths.map((month) => {
        const index = resolvedPeriod.currentMonths.indexOf(month);
        return resolvedPeriod.priorMonths[index] ?? "";
      }).filter(Boolean),
    };
    return res.json({
      fy: rawFy, asOf,
      scope: {
        state: scopedText(req.query as Record<string, unknown>, "state"),
        distributor: filter?.customers?.[0] ?? null,
        group: scopedText(req.query as Record<string, unknown>, "group"),
        period,
      },
      ...(await report7Parties(
        rawFy, asOf, filter,
        scopedText(req.query as Record<string, unknown>, "group"),
        scopedText(req.query as Record<string, unknown>, "state"),
        period,
      )),
    });
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "company-reports report 7 party drill error");
    return res.status(500).json({ error: "Failed to load Report 7 party drill-down" });
  }
});

// ── Excel export ─────────────────────────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };

// Availability guards: detail sheets (3B/4/5) can be the full customer×group
// set, so cap rows per sheet and never run more than a couple of workbook
// builds at once (each holds the whole workbook in memory).
const MAX_EXPORT_ROWS_PER_SHEET = 20_000;
const MAX_EXPORT_PARTIES_PER_STATE = 1_000;
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

const MONEY_FORMAT = "₹#,##,##0.00;[Red]-₹#,##,##0.00";
const PERCENT_FORMAT = "0.00%;[Red]-0.00%";
const THIN_BORDER: ExcelJS.Borders = {
  top: { style: "thin", color: { argb: "FF808080" } },
  bottom: { style: "thin", color: { argb: "FF808080" } },
  left: { style: "thin", color: { argb: "FF808080" } },
  right: { style: "thin", color: { argb: "FF808080" } },
  diagonal: {},
};

function setFormula(cell: ExcelJS.Cell, formula: string, result: number | string | boolean): void {
  cell.value = { formula: formula.replace(/^=/, ""), result };
}

function styleReportRange(ws: ExcelJS.Worksheet, headerRow: number, lastRow: number, firstCol: number, lastCol: number): void {
  for (let row = headerRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      const cell = ws.getCell(row, col);
      cell.border = THIN_BORDER;
      if (row === headerRow) {
        cell.font = { bold: true };
        cell.fill = HEADER_FILL;
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      }
    }
  }
}

function addHiddenSheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name);
  ws.state = "veryHidden";
  return ws;
}

function selectedState(p: CompanyReportsPayload, filter?: CompanyReportsFilter): string {
  const rows = p.c1_byState ?? p.r1r2_byState;
  const explicit = filter?.states?.[0];
  if (explicit) return explicit;
  return rows[0]?.label ?? "";
}

function capPartiesByState<T extends { state: string }>(rows: T[]): T[] {
  const byState = new Map<string, T[]>();
  for (const row of rows) {
    const stateRows = byState.get(row.state) ?? [];
    if (stateRows.length < MAX_EXPORT_PARTIES_PER_STATE) stateRows.push(row);
    byState.set(row.state, stateRows);
  }
  return [...byState.values()].flat();
}

function maxCappedPartyCount<T extends { state: string }>(rows: T[]): number {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

function partyCapNote(p: CompanyReportsPayload): string {
  const counts = new Map<string, number>();
  for (const source of [p.r1_partyByCustomer ?? p.r5_byCustomer, p.r2_byPartyMonth ?? []]) {
    const sourceCounts = new Map<string, number>();
    for (const row of source) sourceCounts.set(row.state, (sourceCounts.get(row.state) ?? 0) + 1);
    for (const [state, count] of sourceCounts) {
      counts.set(state, Math.max(counts.get(state) ?? 0, count));
    }
  }
  const truncated = [...counts.entries()]
    .filter(([, count]) => count > MAX_EXPORT_PARTIES_PER_STATE)
    .map(([state, count]) => `${state} (${count.toLocaleString()} → ${MAX_EXPORT_PARTIES_PER_STATE.toLocaleString()})`);
  return truncated.length
    ? `C1 party detail is capped at ${MAX_EXPORT_PARTIES_PER_STATE.toLocaleString()} parties per state. Truncated states: ${truncated.join(", ")}.`
    : `C1 party detail cap: ${MAX_EXPORT_PARTIES_PER_STATE.toLocaleString()} parties per state. No state was truncated.`;
}

function nthMatchingHelperFormula(
  helperSheet: string,
  stateColumn: string,
  valueColumn: string,
  helperEnd: number,
  selectorCell: string,
  nthExpression: string,
  requireNonblankColumns?: [string, string],
): string {
  const stateRange = `'${helperSheet}'!$${stateColumn}$2:$${stateColumn}$${helperEnd}`;
  const valueRange = `'${helperSheet}'!$${valueColumn}$2:$${valueColumn}$${helperEnd}`;
  const firstState = `'${helperSheet}'!$${stateColumn}$2`;
  const rowExpression = `AGGREGATE(15,6,(ROW(${stateRange})-ROW(${firstState})+1)/(${stateRange}=${selectorCell}),${nthExpression})`;
  const indexExpression = `INDEX(${valueRange},${rowExpression})`;
  if (!requireNonblankColumns) {
    return `=IFERROR(IF(${indexExpression}="","",${indexExpression}),"")`;
  }
  const required = requireNonblankColumns.map((column) => {
    const range = `'${helperSheet}'!$${column}$2:$${column}$${helperEnd}`;
    return `INDEX(${range},${rowExpression})<>""`;
  }).join(",");
  return `=IFERROR(IF(AND(${required}),IF(${indexExpression}="","",${indexExpression}),""),"")`;
}

function buildReport1(
  wb: ExcelJS.Workbook,
  p: CompanyReportsPayload,
  filter: CompanyReportsFilter | undefined,
  dataR1: ExcelJS.Worksheet,
): void {
  const rows = p.c1_byState ?? p.r1r2_byState;
  const parties = capPartiesByState(p.r1_partyByCustomer ?? p.r5_byCustomer.map((r) => ({ ...r, district: "" })));
  const state = selectedState(p, filter);
  const ws = wb.addWorksheet("Report 1");
  ws.columns = [
    { width: 3 }, { width: 24 }, { width: 20 }, { width: 20 }, { width: 20 },
    { width: 14 }, { width: 14 }, { width: 3 }, { width: 3 },
    { width: 24 }, { width: 38 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 14 }, { width: 14 },
  ];
  ws.getCell("B3").value = "Grand Total / State";
  ws.getCell("B4").value = "State";
  ws.getCell("C4").value = `Prior FY (${p.priorFy})`;
  ws.getCell("D4").value = `Current FY (${p.fy})`;
  ws.getCell("E4").value = "Difference";
  ws.getCell("F4").value = "Growth %";
  ws.getCell("G4").value = "Share %";
  ws.getCell("J4").value = "District";
  ws.getCell("K4").value = "Party";
  ws.getCell("L4").value = `Prior FY (${p.priorFy})`;
  ws.getCell("M4").value = `Current FY (${p.fy})`;
  ws.getCell("N4").value = "Difference";
  ws.getCell("O4").value = "Growth %";
  ws.getCell("P4").value = "Share %";

  const stateEnd = Math.max(5, rows.length + 4);
  const stateTotalPrior = rows.reduce((sum, row) => sum + row.lastFy, 0);
  const stateTotalCurrent = rows.reduce((sum, row) => sum + row.thisFy, 0);
  setFormula(ws.getCell("C3"), stateEnd >= 5 ? `=SUM(C5:C${stateEnd})` : "=0", stateTotalPrior);
  setFormula(ws.getCell("D3"), stateEnd >= 5 ? `=SUM(D5:D${stateEnd})` : "=0", stateTotalCurrent);
  setFormula(ws.getCell("E3"), "=D3-C3", stateTotalCurrent - stateTotalPrior);
  setFormula(ws.getCell("F3"), "=IF(C3=0,\"\",(D3-C3)/ABS(C3))",
    stateTotalPrior === 0 ? "" : (stateTotalCurrent - stateTotalPrior) / Math.abs(stateTotalPrior));
  setFormula(ws.getCell("G3"), stateTotalCurrent === 0 ? "=0" : `=SUM(G5:G${stateEnd})`, stateTotalCurrent === 0 ? 0 : 1);
  ws.getCell("J3").value = state;
  const selectedParties = parties.filter((row) => row.state === state);
  // Reserve enough live formula rows for the largest capped dropdown state.
  // Rows beyond the selected state's count retain blank cached results.
  const partyOutputCount = Math.max(1, maxCappedPartyCount(parties));
  const partyEnd = partyOutputCount + 4;
  const selectedPrior = selectedParties.reduce((sum, row) => sum + row.lastFy, 0);
  const selectedCurrent = selectedParties.reduce((sum, row) => sum + row.thisFy, 0);
  setFormula(ws.getCell("K3"), `=COUNTIF(K5:K${partyEnd},"?*")`, selectedParties.length);
  setFormula(ws.getCell("L3"), `=SUM(L5:L${partyEnd})`, selectedPrior);
  setFormula(ws.getCell("M3"), `=SUM(M5:M${partyEnd})`, selectedCurrent);
  setFormula(ws.getCell("N3"), "=M3-L3", selectedCurrent - selectedPrior);
  setFormula(ws.getCell("O3"), '=IF(OR(L3="",L3=0),"",(M3-L3)/ABS(L3))',
    selectedPrior === 0 ? "" : (selectedCurrent - selectedPrior) / Math.abs(selectedPrior));
  setFormula(ws.getCell("P3"), selectedCurrent === 0 ? "=0" : `=SUM(P5:P${partyEnd})`, selectedCurrent === 0 ? 0 : 1);

  rows.forEach((row, index) => {
    const excelRow = index + 5;
    ws.getCell(excelRow, 2).value = row.label;
    ws.getCell(excelRow, 3).value = row.lastFy;
    ws.getCell(excelRow, 4).value = row.thisFy;
    setFormula(ws.getCell(excelRow, 5), `=D${excelRow}-C${excelRow}`, row.diff);
    setFormula(ws.getCell(excelRow, 6), `=IF(C${excelRow}=0,"",(D${excelRow}-C${excelRow})/ABS(C${excelRow}))`,
      row.growthPct == null ? "" : row.growthPct / 100);
    setFormula(ws.getCell(excelRow, 7), `=IF($D$3=0,"",D${excelRow}/$D$3)`, row.sharePct / 100);
  });
  const stateDataRows = rows.length ? rows : [{ label: "" }];
  dataR1.getRow(1).values = ["State"];
  stateDataRows.forEach((row, index) => { dataR1.getCell(index + 2, 1).value = row.label; });
  dataR1.getRow(1).values = ["State", "", "", "Detail state", "District", "Party", "Prior FY", "Current FY"];
  (parties.length ? parties : [{ state: "", district: "", customer: "", lastFy: 0, thisFy: 0 }]).forEach((row, index) => {
    const r = index + 2;
    dataR1.getCell(r, 4).value = row.state;
    dataR1.getCell(r, 5).value = row.district;
    dataR1.getCell(r, 6).value = row.customer;
    dataR1.getCell(r, 7).value = row.lastFy;
    dataR1.getCell(r, 8).value = row.thisFy;
  });
  const stateListEnd = Math.max(2, rows.length + 1);
  ws.getCell("J3").dataValidation = {
    type: "list",
    allowBlank: true,
    showErrorMessage: true,
    formulae: [`'Export Data R1'!$A$2:$A$${stateListEnd}`],
  };
  const partyHelperEnd = Math.max(2, parties.length + 1);
  for (let index = 0; index < partyOutputCount; index++) {
    const row = parties[index];
    const excelRow = index + 5;
    const selectedParty = selectedParties[index];
    const nth = `ROWS($K$5:K${excelRow})`;
    setFormula(ws.getCell(excelRow, 10), nthMatchingHelperFormula("Export Data R1", "D", "E", partyHelperEnd, "$J$3", nth), selectedParty?.district ?? "");
    setFormula(ws.getCell(excelRow, 11), nthMatchingHelperFormula("Export Data R1", "D", "F", partyHelperEnd, "$J$3", nth), selectedParty?.customer ?? "");
    setFormula(ws.getCell(excelRow, 12), nthMatchingHelperFormula("Export Data R1", "D", "G", partyHelperEnd, "$J$3", nth), selectedParty?.lastFy ?? "");
    setFormula(ws.getCell(excelRow, 13), nthMatchingHelperFormula("Export Data R1", "D", "H", partyHelperEnd, "$J$3", nth), selectedParty?.thisFy ?? "");
    setFormula(ws.getCell(excelRow, 14), `=IF(K${excelRow}="","",M${excelRow}-L${excelRow})`, selectedParty?.diff ?? "");
    setFormula(ws.getCell(excelRow, 15), `=IF(OR(K${excelRow}="",L${excelRow}=0),"",(M${excelRow}-L${excelRow})/ABS(L${excelRow}))`,
      selectedParty && selectedParty.lastFy !== 0 ? selectedParty.diff / Math.abs(selectedParty.lastFy) : "");
    setFormula(ws.getCell(excelRow, 16), `=IF(OR(K${excelRow}="",$M$3=0),"",M${excelRow}/$M$3)`,
      selectedParty && selectedCurrent !== 0 ? selectedParty.thisFy / selectedCurrent : "");
  }
  for (const row of ws.getRows(3, partyEnd - 2) ?? []) {
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      if ([3, 4, 5, 12, 13, 14].includes(col)) cell.numFmt = MONEY_FORMAT;
      if ([6, 7, 15, 16].includes(col)) cell.numFmt = PERCENT_FORMAT;
    });
  }
  styleReportRange(ws, 4, Math.max(stateEnd, partyEnd), 2, 7);
  styleReportRange(ws, 4, partyEnd, 10, 16);
  ws.getRow(3).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 4 }];
}

function buildReport2(
  wb: ExcelJS.Workbook,
  p: CompanyReportsPayload,
  filter: CompanyReportsFilter | undefined,
  dataR2: ExcelJS.Worksheet,
): void {
  const rows = p.c1_byState ?? p.r1r2_byState;
  const state = selectedState(p, filter);
  // The payload already contains the selected complete/current period. Never
  // add future FY month pairs merely because the workbook has room for them.
  const months = p.likeMonths;
  const stateMonths = p.r2_byStateMonth ?? [];
  const parties = capPartiesByState(p.r2_byPartyMonth ?? []);
  const selectedParties = parties.filter((row) => row.state === state);
  const ws = wb.addWorksheet("Report 2");
  ws.getColumn(1).width = 3;
  ws.getColumn(2).width = 24;
  for (let col = 3; col <= 7; col++) ws.getColumn(col).width = 20;
  ws.getColumn(10).width = 38;
  ws.getColumn(11).width = 24;
  const report2LastCol = 12 + months.length * 3 - 1;
  for (let col = 12; col <= report2LastCol; col++) ws.getColumn(col).width = 16;
  ws.getCell("B2").value = "Grand Total / State";
  ws.getCell("B3").value = "State";
  ws.getCell("C3").value = `Prior FY (${p.priorFy})`;
  ws.getCell("D3").value = `Current FY (${p.fy})`;
  ws.getCell("E3").value = "Difference";
  ws.getCell("F3").value = "Growth %";
  ws.getCell("G3").value = "Share %";
  ws.getCell("J2").value = "Selected state";
  ws.getCell("K2").value = state;
  ws.getCell("J3").value = "Party";
  ws.getCell("K3").value = "District";
  months.forEach((month, index) => {
    const col = 12 + index * 3;
    ws.getCell(3, col).value = `${toPriorMonthLabel(month)} LY`;
    ws.getCell(3, col + 1).value = `${month} TY`;
    ws.getCell(3, col + 2).value = `${month} Growth %`;
  });
  const stateEnd = Math.max(4, rows.length + 3);
  const stateTotalPrior = rows.reduce((sum, row) => sum + row.lastFy, 0);
  const stateTotalCurrent = rows.reduce((sum, row) => sum + row.thisFy, 0);
  setFormula(ws.getCell("C2"), `=SUM(C4:C${stateEnd})`, stateTotalPrior);
  setFormula(ws.getCell("D2"), `=SUM(D4:D${stateEnd})`, stateTotalCurrent);
  setFormula(ws.getCell("E2"), "=D2-C2", stateTotalCurrent - stateTotalPrior);
  setFormula(ws.getCell("F2"), '=IF(C2=0,"",(D2-C2)/ABS(C2))',
    stateTotalPrior === 0 ? "" : (stateTotalCurrent - stateTotalPrior) / Math.abs(stateTotalPrior));
  setFormula(ws.getCell("G2"), stateTotalCurrent === 0 ? "=0" : `=SUM(G4:G${stateEnd})`, stateTotalCurrent === 0 ? 0 : 1);
  rows.forEach((row, index) => {
    const excelRow = index + 4;
    ws.getCell(excelRow, 2).value = row.label;
    ws.getCell(excelRow, 3).value = row.lastFy;
    ws.getCell(excelRow, 4).value = row.thisFy;
    setFormula(ws.getCell(excelRow, 5), `=D${excelRow}-C${excelRow}`, row.diff);
    setFormula(ws.getCell(excelRow, 6), `=IF(C${excelRow}=0,"",(D${excelRow}-C${excelRow})/ABS(C${excelRow}))`,
      row.growthPct == null ? "" : row.growthPct / 100);
    setFormula(ws.getCell(excelRow, 7), `=IF($D$2=0,"",D${excelRow}/$D$2)`, row.sharePct / 100);
  });
  const stateDataRows = stateMonths.length ? stateMonths : [{ state: "", month: "", lastFy: null, thisFy: null }];
  dataR2.getRow(1).values = ["State", "Month", "Prior FY", "Current FY"];
  stateDataRows.forEach((row, index) => {
    const r = index + 2;
    dataR2.getCell(r, 1).value = row.state;
    dataR2.getCell(r, 2).value = row.month;
    dataR2.getCell(r, 3).value = row.lastFy;
    dataR2.getCell(r, 4).value = row.thisFy;
  });
  const stateDataEnd = Math.max(2, stateDataRows.length + 1);
  const partyStartCol = 7;
  dataR2.getRow(1).getCell(partyStartCol).value = "Party state";
  dataR2.getRow(1).getCell(partyStartCol + 1).value = "District";
  dataR2.getRow(1).getCell(partyStartCol + 2).value = "Party";
  months.forEach((month, index) => {
    dataR2.getRow(1).getCell(partyStartCol + 3 + index * 2).value = `${month} LY`;
    dataR2.getRow(1).getCell(partyStartCol + 4 + index * 2).value = `${month} TY`;
  });
  const partyRows = parties.length ? parties : [{ state: "", district: "", customer: "", months: [] }];
  partyRows.forEach((row, index) => {
    const r = index + 2;
    dataR2.getCell(r, partyStartCol).value = row.state;
    dataR2.getCell(r, partyStartCol + 1).value = row.district;
    dataR2.getCell(r, partyStartCol + 2).value = row.customer;
    months.forEach((month, monthIndex) => {
      const m = row.months.find((candidate) => candidate.month === month);
      dataR2.getCell(r, partyStartCol + 3 + monthIndex * 2).value = m?.lastFy;
      dataR2.getCell(r, partyStartCol + 4 + monthIndex * 2).value = m?.thisFy;
    });
  });
  // Match Report 1: changing the dropdown must never run out of formula rows.
  const partyOutputCount = Math.max(1, maxCappedPartyCount(parties));
  const partyEnd = partyOutputCount + 3;
  const partyHelperEnd = Math.max(2, parties.length + 1);
  ws.getCell("K2").dataValidation = {
    type: "list",
    allowBlank: true,
    showErrorMessage: true,
    formulae: [`'Export Data R1'!$A$2:$A$${Math.max(2, rows.length + 1)}`],
  };
  months.forEach((month, monthIndex) => {
    const col = 12 + monthIndex * 3;
    const matching = stateMonths.find((row) => row.state === state && row.month === month);
    const hasBothSources = matching?.lastFy != null && matching.thisFy != null;
    const prior = hasBothSources ? matching?.lastFy ?? null : null;
    const current = hasBothSources ? matching?.thisFy ?? null : null;
    const stateRange = `'Export Data R2'!$A$2:$A$${stateDataEnd}`;
    const monthRange = `'Export Data R2'!$B$2:$B$${stateDataEnd}`;
    const priorRange = `'Export Data R2'!$C$2:$C$${stateDataEnd}`;
    const currentRange = `'Export Data R2'!$D$2:$D$${stateDataEnd}`;
    setFormula(ws.getCell(2, col),
      `=IF(COUNTIFS(${stateRange},$K$2,${monthRange},"${month}",${priorRange},"<>",${currentRange},"<>")=0,"",SUMIFS(${priorRange},${stateRange},$K$2,${monthRange},"${month}"))`,
      prior == null ? "" : prior);
    setFormula(ws.getCell(2, col + 1),
      `=IF(COUNTIFS(${stateRange},$K$2,${monthRange},"${month}",${priorRange},"<>",${currentRange},"<>")=0,"",SUMIFS(${currentRange},${stateRange},$K$2,${monthRange},"${month}"))`,
      current == null ? "" : current);
    setFormula(ws.getCell(2, col + 2),
      `=IF(OR(${ws.getCell(2, col).address}="",${ws.getCell(2, col + 1).address}="",${ws.getCell(2, col).address}=0),"",(${ws.getCell(2, col + 1).address}-${ws.getCell(2, col).address})/ABS(${ws.getCell(2, col).address}))`,
      prior == null || current == null || prior === 0 ? "" : (current - prior) / Math.abs(prior));
    ws.getCell(2, col).numFmt = MONEY_FORMAT;
    ws.getCell(2, col + 1).numFmt = MONEY_FORMAT;
    ws.getCell(2, col + 2).numFmt = PERCENT_FORMAT;
  });
  for (let index = 0; index < partyOutputCount; index++) {
    const row = parties[index];
    const excelRow = index + 4;
    const selectedParty = selectedParties[index];
    const nth = `ROWS($J$4:J${excelRow})`;
    setFormula(ws.getCell(excelRow, 10), nthMatchingHelperFormula("Export Data R2", "G", "I", partyHelperEnd, "$K$2", nth), selectedParty?.customer ?? "");
    setFormula(ws.getCell(excelRow, 11), nthMatchingHelperFormula("Export Data R2", "G", "H", partyHelperEnd, "$K$2", nth), selectedParty?.district ?? "");
    months.forEach((month, monthIndex) => {
      const col = 12 + monthIndex * 3;
      const helperPriorCol = partyStartCol + 3 + monthIndex * 2;
      const helperCurrentCol = helperPriorCol + 1;
      const monthValues = selectedParty?.months.find((candidate) => candidate.month === month);
      const hasBothSources = monthValues?.lastFy != null && monthValues.thisFy != null;
      const priorValue = hasBothSources ? monthValues?.lastFy ?? null : null;
      const currentValue = hasBothSources ? monthValues?.thisFy ?? null : null;
      const helperPriorLetter = columnLetter(helperPriorCol);
      const helperCurrentLetter = columnLetter(helperCurrentCol);
      setFormula(ws.getCell(excelRow, col),
        nthMatchingHelperFormula("Export Data R2", "G", helperPriorLetter, partyHelperEnd, "$K$2", nth, [helperPriorLetter, helperCurrentLetter]),
        priorValue != null ? priorValue : "");
      setFormula(ws.getCell(excelRow, col + 1),
        nthMatchingHelperFormula("Export Data R2", "G", helperCurrentLetter, partyHelperEnd, "$K$2", nth, [helperPriorLetter, helperCurrentLetter]),
        currentValue != null ? currentValue : "");
      setFormula(ws.getCell(excelRow, col + 2),
        `=IF(OR(${ws.getCell(excelRow, col).address}="",${ws.getCell(excelRow, col + 1).address}="",${ws.getCell(excelRow, col).address}=0),"",(${ws.getCell(excelRow, col + 1).address}-${ws.getCell(excelRow, col).address})/ABS(${ws.getCell(excelRow, col).address}))`,
        priorValue != null && currentValue != null && priorValue !== 0
          ? (currentValue - priorValue) / Math.abs(priorValue) : "");
      ws.getCell(excelRow, col).numFmt = MONEY_FORMAT;
      ws.getCell(excelRow, col + 1).numFmt = MONEY_FORMAT;
      ws.getCell(excelRow, col + 2).numFmt = PERCENT_FORMAT;
    });
  }
  for (const row of ws.getRows(2, partyEnd - 1) ?? []) {
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      if ([3, 4, 5].includes(col)) cell.numFmt = MONEY_FORMAT;
      if ([6, 7].includes(col)) cell.numFmt = PERCENT_FORMAT;
    });
  }
  styleReportRange(ws, 3, Math.max(stateEnd, partyEnd), 2, 7);
  styleReportRange(ws, 3, partyEnd, 10, report2LastCol);
  ws.getRow(2).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 3 }];
}

function columnLetter(column: number): string {
  let n = column;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function toPriorMonthLabel(month: string): string {
  return `${month.slice(0, 4)}${String(Number(month.slice(4)) - 1).padStart(2, "0")}`;
}

/** Full workbook, including verification helpers and the as-of snapshot.
 * This is intentionally only used by the separate working-data download. */
export async function buildWorkingDataWorkbook(p: CompanyReportsPayload, filter?: CompanyReportsFilter): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.calcProperties.fullCalcOnLoad = true;

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
    ["Provisional months", await provisionalMonthsExportInfo(p.fy)],
    ["Note", "Figures are territory + project combined as shown on the page. Quantity is never summed across groups (litres vs pieces)."],
    ["Source — all sale figures", "sale_line taxable amount (primary sales), filtered by FY, complete months, head/state/customer scope; server-computed values are authoritative. C1 export comparisons apply those explicit filters directly to both FYs."],
    ["Report 1 district source", "customer_master.company exact normalized match to sale customer. District is blank when no unique exact district exists; this metadata lookup never joins sale rows."],
    ["Report 2 month source", "sale_line grouped independently by state/month and customer/month using the same explicit head/state/customer filters in both FYs. Future/incomplete current-FY months and prior-only rows are intentionally blank."],
    ["Party detail cap", partyCapNote(p)],
    ["C1 Report 7 decision", "Later Report 7 will use PTMT, PLUMBING (including Water Tank), C P, SANITARYWARE, SINK, HARDWARE. This changes Sandeep's format: Water Tank will disappear into Plumbing (~₹6.58 Cr), and Hardware (~₹0.87 Cr) will be added. Report 7 is not changed in C1."],
  ];
  for (const [k, v] of infoRows) {
    const row = info.addRow([k, v]);
    row.getCell(1).font = { bold: true };
  }

  const dataR1 = addHiddenSheet(wb, "Export Data R1");
  const dataR2 = addHiddenSheet(wb, "Export Data R2");
  buildReport1(wb, p, filter, dataR1);
  buildReport2(wb, p, filter, dataR2);
  const compareCols = [
    { header: "Label", key: "label", width: 30 },
    { header: `This FY (${p.fy})`, key: "thisFy" },
    { header: `Last FY (${p.priorFy})`, key: "lastFy" },
    { header: "Diff", key: "diff" },
    { header: "Growth %", key: "growthPct" },
    { header: "Share %", key: "sharePct" },
  ];
  const r3Rows = (p.r3_bySubcategory?.length
    ? p.r3_bySubcategory.map((row) => ({
      label: row.group,
      subcategory: row.subcategory,
      thisFy: row.thisFy,
      lastFy: row.lastFy,
      diff: row.thisFy - row.lastFy,
      growthPct: row.lastFy === 0 ? null : ((row.thisFy - row.lastFy) / Math.abs(row.lastFy)) * 100,
      sharePct: 0,
    }))
    : p.r3_byGroup) as unknown as Array<Record<string, unknown>>;
  addSheet(wb, "R3 By Group", [
    { header: "Master group", key: "label", width: 30 },
    { header: "Sub-category", key: "subcategory", width: 26 },
    ...compareCols.slice(1),
  ], r3Rows);
  addSheet(wb, "R3A State x Group", [
    { header: "State", key: "state", width: 24 },
    { header: "Master group", key: "group", width: 24 },
    { header: "Sub-category", key: "subcategory", width: 24 },
    { header: `This FY`, key: "thisFy" },
    { header: `Last FY`, key: "lastFy" },
  ], p.r3a_byStateGroup as unknown as Array<Record<string, unknown>>);
  addSheet(wb, "R3B Party x Group", [
    { header: "Party", key: "customer", width: 36 },
    { header: "State", key: "state", width: 22 },
    { header: "Master group", key: "group", width: 22 },
    { header: "Sub-category", key: "subcategory", width: 22 },
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
    { header: "Master group", key: "group", width: 24 },
    { header: "Sub-category", key: "subcategory", width: 24 },
    { header: "This FY (like months)", key: "thisFyLike", width: 22 },
    { header: "Last FY (like months)", key: "lastFyLike", width: 22 },
    { header: "Last FY (full year)", key: "lastFyFull", width: 22 },
    { header: "Growth % (like)", key: "growthLike" },
  ], (p.r6_bySubcategoryFull?.length ? p.r6_bySubcategoryFull : p.r6_byGroupFull) as unknown as Array<Record<string, unknown>>);

  const r7 = wb.addWorksheet("R7 As-of Snapshot");
  r7.columns = [{ width: 30 }, { width: 24 }];
  const addR7 = (a: string, b: string | number, bold = false) => {
    const row = r7.addRow([a, b]);
    if (bold) row.font = { bold: true };
  };
  addR7("As-of date", p.r7_asOf.date, true);
  addR7("Total sale", p.r7_asOf.total);
  addR7(p.fy === "2023-24" ? "Invoice count*" : "Invoice count", p.r7_asOf.invoiceCount);
  addR7("Customer count", p.r7_asOf.customerCount);
  if (p.fy === "2023-24") {
    addR7(
      "Invoice-count limitation",
      "Month-only source: no invoice date or identifier. This is a line-based fallback, not a distinct invoice count.",
    );
  }
  addR7("", "");
  addR7("By group", "Amount", true);
  for (const g of p.r7_asOf.byGroup) addR7(g.group, g.amount);
  addR7("", "");
  addR7("By state", "Amount", true);
  for (const s of p.r7_asOf.byState) addR7(s.state, s.amount);

  // Helper sheets are deliberately last and veryHidden in the working-data
  // workbook; the sales-head wrapper below removes them.
  const visibleOrder = [
    "Info", "Report 1", "Report 2", "R3 By Group", "R3A State x Group",
    "R3B Party x Group", "R4 Quantity", "R5 By Customer",
    "R6 By Group (full prior)", "R7 As-of Snapshot",
  ];
  const ordered = [...visibleOrder, "Export Data R1", "Export Data R2"];
  ordered.forEach((name, index) => {
    const sheet = wb.getWorksheet(name);
    if (sheet) (sheet as unknown as { orderNo: number }).orderNo = index + 1;
  });

  return wb;
}

/**
 * Sales-head workbook. Verification dumps and the metadata snapshot live only
 * behind Download working data. Formula cells which depended on those hidden
 * ranges are frozen to their already-computed cached values before the helper
 * sheets are removed, so the default file never contains broken references.
 */
export async function buildWorkbook(p: CompanyReportsPayload, filter?: CompanyReportsFilter): Promise<ExcelJS.Workbook> {
  const wb = await buildWorkingDataWorkbook(p, filter);
  for (const sheet of ["Report 1", "Report 2"]) {
    const ws = wb.getWorksheet(sheet);
    if (!ws) continue;
    ws.eachRow((row) => row.eachCell((cell) => {
      const value = cell.value;
      if (value && typeof value === "object" && "formula" in value &&
          String((value as { formula?: string }).formula).includes("Export Data")) {
        const result = (value as { result?: string | number | boolean | null }).result;
        cell.value = result ?? "";
      }
    }));
  }
  // Remove the deliberately non-analytic columns/sheets from the deliverable.
  const r4 = wb.getWorksheet("R4 Quantity");
  if (r4) r4.spliceColumns(2, 1); // Group (raw) is source provenance, not analysis.
  const r1 = wb.getWorksheet("Report 1");
  // ExcelJS does not consistently move populated cells/formula caches when
  // two consecutive spliceColumns calls remove the old spacer columns.
  // Snapshot the detail blocks and place them at their compact destinations
  // explicitly; this keeps the selected party/month values intact.
  const r1Detail = r1 ? snapshotCells(r1, 10, 16) : null;
  if (r1) {
    r1.spliceColumns(1, 1);
    r1.spliceColumns(7, 2); // blank spacer columns
    restoreShiftedCells(r1, r1Detail, 7);
  }
  const r2 = wb.getWorksheet("Report 2");
  const r2LastSourceColumn = 12 + p.likeMonths.length * 3 - 1;
  const r2Detail = r2 ? snapshotCells(r2, 10, Math.max(11, r2LastSourceColumn)) : null;
  if (r2) {
    r2.spliceColumns(1, 1);
    r2.spliceColumns(7, 2); // blank spacer columns
    restoreShiftedCells(r2, r2Detail, 7);
  }
  // Dropdowns need the hidden helper ranges. The sales-head file is a
  // filtered snapshot, so do not leave validations pointing at removed sheets.
  for (const ws of [r1, r2]) clearDataValidations(ws);
  for (const name of ["R7 As-of Snapshot", "Export Data R1", "Export Data R2"]) {
    const sheet = wb.getWorksheet(name);
    if (sheet) wb.removeWorksheet(sheet.id);
  }
  for (const sheet of wb.worksheets) clearDataValidations(sheet);
  const visibleOrder = [
    "Info", "Report 1", "Report 2", "R3 By Group", "R3A State x Group",
    "R3B Party x Group", "R4 Quantity", "R5 By Customer", "R6 By Group (full prior)",
  ];
  visibleOrder.forEach((name, index) => {
    const sheet = wb.getWorksheet(name);
    if (sheet) (sheet as unknown as { orderNo: number }).orderNo = index + 1;
  });
  return wb;
}

type CellSnapshot = Array<Array<ExcelJS.CellValue>>;

function snapshotCells(ws: ExcelJS.Worksheet, firstColumn: number, lastColumn: number): CellSnapshot {
  const result: CellSnapshot = [];
  for (let row = 1; row <= ws.rowCount; row++) {
    const values: ExcelJS.CellValue[] = [];
    for (let column = firstColumn; column <= lastColumn; column++) values.push(ws.getCell(row, column).value);
    result.push(values);
  }
  return result;
}

function restoreShiftedCells(
  ws: ExcelJS.Worksheet,
  snapshot: CellSnapshot | null,
  destinationFirstColumn: number,
): void {
  if (!snapshot) return;
  for (let row = 0; row < snapshot.length; row++) {
    for (let index = 0; index < snapshot[row].length; index++) {
      ws.getCell(row + 1, destinationFirstColumn + index).value = snapshot[row][index] ?? null;
    }
  }
}

function clearDataValidations(ws: ExcelJS.Worksheet | undefined): void {
  if (!ws) return;
  // ExcelJS 4.4 exposes validation metadata at runtime through a private
  // worksheet member, but intentionally omits that field from Worksheet's
  // public type. Keep this narrow internal cast at the boundary and replace
  // the map so no undefined keys left by DataValidations.remove() serialize.
  const internal = ws as unknown as {
    dataValidations?: { model?: Record<string, unknown> };
  };
  if (internal.dataValidations?.model) internal.dataValidations.model = {};
}

// Explicit test seam name for consumers that do not need the route itself.
export const buildCompanyReportsWorkbook = buildWorkbook;

router.get("/company-reports/export", async (req, res) => {
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : currentOpenFy();
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
    const payload = await buildCompanyReports(rawFy, rawAsOf, filter, { includeC1ExportData: true });
    const wb = await buildWorkbook(payload, filter);
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

/** Verification-oriented download. The ordinary export intentionally contains
 * only the sales-head sheets; this opt-in file retains helper ranges, raw
 * category provenance and the R7 as-of reconciliation snapshot. */
router.get("/company-reports/working-data", async (req, res) => {
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : currentOpenFy();
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
    const payload = await buildCompanyReports(rawFy, rawAsOf, filter, { includeC1ExportData: true });
    const wb = await buildWorkingDataWorkbook(payload, filter);
    const buf = await wb.xlsx.writeBuffer();
    const suffix = filter ? "_filtered" : "";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Company_Reports_Working_Data_${rawFy}${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "company-reports working-data export error");
    res.status(500).json({ error: "Working-data export failed" });
  } finally {
    activeExports--;
  }
});

export default router;
