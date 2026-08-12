// GET /api/coverage-reports?heads=[..]&states=[..]
//   Coverage page data (retailer roster reach) filtered by State Head / State.
// GET /api/coverage-reports/export — same params; returns an xlsx workbook.
//
// The coverage data is a stock (roster reach), not a flow — there is no month
// dimension and no distributor dimension, so this route accepts head/state
// filters only. Rows come from the latest dashboard snapshot (roster +
// STATE HD Dashboard sources); filtering happens here at the aggregate level
// because per-state coverage rows and per-head resource rows both carry their
// own key. State values are matched case-insensitively against the shared
// filter tree (sale_line normalised states are uppercase geographic names).
import { Router } from "express";
import ExcelJS from "exceljs";
import { ensureSeeded } from "../lib/dashboard/sync.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";
import { parseJsonArray } from "./companyReports.js";
import { normHead, normState, displayHead, displayState, NORTH_EAST_STATES } from "../lib/reportFilterVocab.js";
import type { HeadResource, CoverageRow, CoverageTotals } from "../lib/dashboard/transform.js";

const router = Router();

type DashboardData = {
  heads_resources: HeadResource[];
  coverage: CoverageRow[];
  coverage_totals: CoverageTotals;
};

export type CoverageReportsPayload = {
  filtered: boolean;
  /** True when a state filter is active: per-head distributor/dealer counts
   *  cover the head's FULL territory (the roster has no per-head state split). */
  headsFullTerritory: boolean;
  syncedAt: string;
  coverageTotals: CoverageTotals;
  headsResources: HeadResource[];
  coverage: CoverageRow[];
};

// Expand a head's covered-states list ("North East" region → its states).
function headStateSet(statesField: string): Set<string> {
  const out = new Set<string>();
  for (const s of statesField.split(",")) {
    const n = normState(s);
    if (!n) continue;
    if (n === "NORTH EAST") for (const ne of NORTH_EAST_STATES) out.add(ne);
    else out.add(n);
  }
  return out;
}

// Pure aggregate-level filter — exported for tests.
export function buildPayload(
  data: DashboardData,
  syncedAt: string,
  heads?: string[],
  states?: string[],
): CoverageReportsPayload {
  const filtered = Boolean(heads?.length || states?.length);

  const headSet = heads?.length ? new Set(heads.map(normHead)) : null;
  const stateSetRaw = states?.length ? new Set(states.map(normState)) : null;

  // Head table: exact under a head filter; under a state filter, constrained
  // to heads whose covered territory touches a selected state (their counts
  // stay full-territory figures — flagged via headsFullTerritory).
  let headsResources = data.heads_resources.filter(
    (h) => !headSet || headSet.has(normHead(h.head)),
  );
  if (stateSetRaw) {
    headsResources = headsResources.filter((h) =>
      [...headStateSet(h.states)].some((s) => stateSetRaw.has(s)),
    );
  }

  // Head filter → the union of the selected heads' covered states also narrows
  // the state-wise table (each coverage row carries only its state).
  let stateSet = stateSetRaw;
  if (headSet) {
    const headStates = new Set<string>();
    for (const h of headsResources) for (const s of headStateSet(h.states)) headStates.add(s);
    stateSet = stateSetRaw
      ? new Set([...stateSetRaw].filter((s) => headStates.has(s)))
      : headStates;
  }

  const coverage = data.coverage.filter((c) => !stateSet || stateSet.has(normState(c.state)));

  const coverageTotals: CoverageTotals = filtered
    ? {
        states: coverage.length,
        districts: coverage.reduce((a, c) => a + c.districts, 0),
        cities: coverage.reduce((a, c) => a + c.cities, 0),
        retailers: coverage.reduce((a, c) => a + c.retailers, 0),
      }
    : data.coverage_totals;

  // Apply canonical display names on the way out — filter logic above uses
  // normHead/normState so matching is unaffected; only the rendered label changes.
  const headsResourcesDisplay = headsResources.map((h) => ({
    ...h,
    head: displayHead(h.head),
  }));

  const coverageDisplay = coverage.map((c) => ({
    ...c,
    state: displayState(c.state),
  }));

  return {
    filtered,
    headsFullTerritory: Boolean(stateSetRaw),
    syncedAt,
    coverageTotals,
    headsResources: headsResourcesDisplay,
    coverage: coverageDisplay,
  };
}

async function loadData(): Promise<{ data: DashboardData; syncedAt: string }> {
  const snapshot = await ensureSeeded();
  return {
    data: snapshot.data as unknown as DashboardData,
    syncedAt: snapshot.syncedAt.toISOString(),
  };
}

router.get("/coverage-reports", async (req, res) => {
  const heads = parseJsonArray(req.query.heads);
  const states = parseJsonArray(req.query.states);
  try {
    const { data, syncedAt } = await loadData();
    res.json(buildPayload(data, syncedAt, heads, states));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "coverage-reports error");
    res.status(500).json({ error: "Failed to load coverage data" });
  }
});

// ── Excel export ─────────────────────────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };
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
  for (const r of rows) ws.addRow(columns.map((c) => r[c.key] ?? ""));
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

router.get("/coverage-reports/export", async (req, res) => {
  const heads = parseJsonArray(req.query.heads);
  const states = parseJsonArray(req.query.states);

  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.status(429).json({ error: "Another export is already running — try again in a few seconds." });
    return;
  }
  activeExports++;
  try {
    const { data, syncedAt } = await loadData();
    const p = buildPayload(data, syncedAt, heads, states);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Prayag Sales Intelligence";

    const info = wb.addWorksheet("Info");
    info.columns = [{ width: 26 }, { width: 90 }];
    const infoRows: Array<[string, string]> = [
      ["Page", "Coverage — retailer roster reach by state head and state"],
      ["Data synced at", p.syncedAt],
      ["State Head filter", heads?.length ? heads.join(", ") : "All"],
      ["State filter", states?.length ? states.join(", ") : "All"],
      ["States", String(p.coverageTotals.states)],
      ["Districts", String(p.coverageTotals.districts)],
      ["Cities", String(p.coverageTotals.cities)],
      ["Retailers", String(p.coverageTotals.retailers)],
      ["Note", "Coverage is a roster stock (reach), not a sales flow — no month or distributor dimension applies."],
    ];
    if (p.headsFullTerritory) {
      infoRows.push(["Heads sheet caveat", "A state filter is active: the head table is constrained to heads covering the selected states, but per-head distributor/dealer counts still cover each head's FULL territory (the roster has no per-head state split)."]);
    }
    for (const [k, v] of infoRows) {
      const row = info.addRow([k, v]);
      row.getCell(1).font = { bold: true };
    }

    addSheet(wb, p.headsFullTerritory ? "Heads (full territory)" : "Resources by Head", [
      { header: "State Head", key: "head", width: 28 },
      { header: "Distributors", key: "distributors", width: 14 },
      { header: "Dealers", key: "dealers", width: 12 },
      { header: "Total", key: "total", width: 10 },
      { header: "States Covered", key: "states", width: 60 },
    ], p.headsResources as unknown as Array<Record<string, unknown>>);

    addSheet(wb, "State Penetration", [
      { header: "State", key: "state", width: 28 },
      { header: "Districts", key: "districts", width: 12 },
      { header: "Cities", key: "cities", width: 12 },
      { header: "Retailers", key: "retailers", width: 12 },
    ], p.coverage as unknown as Array<Record<string, unknown>>);

    const buf = await wb.xlsx.writeBuffer();
    const suffix = heads?.length || states?.length ? "_filtered" : "";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Coverage${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "coverage-reports export error");
    res.status(500).json({ error: "Export failed" });
  } finally {
    activeExports--;
  }
});

export default router;
