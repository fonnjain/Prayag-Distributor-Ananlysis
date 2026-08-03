// GET /api/regional-reports?heads=[..]&states=[..]
//   Regional page data (order-book retail sales) filtered by State Head / State.
// GET /api/regional-reports/export — same params; returns an xlsx workbook.
//
// The Regional page keeps its original basis: FY26-27 order-book retail sales
// aggregated in the dashboard snapshot (by_state, heads_retail,
// top_retailers). Those are aggregates — there is no row-level backing with a
// month or distributor dimension — so this route accepts head/state filters
// only and filters at the aggregate level. Vocabulary bridging (order-book
// nicknames/spellings vs the shared sale_line filter tree) lives in
// lib/reportFilterVocab.ts.
import { Router } from "express";
import ExcelJS from "exceljs";
import { ensureSeeded } from "../lib/dashboard/sync.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";
import { parseJsonArray } from "./companyReports.js";
import { normHead, normState } from "../lib/reportFilterVocab.js";
import type { ByState, HeadRetail, TopRetailer } from "../lib/dashboard/transform.js";

const router = Router();

type RegionalData = {
  by_state: ByState[];
  heads_retail: HeadRetail[];
  top_retailers: TopRetailer[];
};

export type RegionalReportsPayload = {
  filtered: boolean;
  /** True when a state filter is active: per-head sales/retailer figures
   *  cover the head's FULL territory (no state-level split exists). */
  headsFullTerritory: boolean;
  syncedAt: string;
  byState: ByState[];
  headsRetail: HeadRetail[];
  topRetailers: TopRetailer[];
};

// Pure aggregate-level filter — exported for tests.
// Head attribution on by_state / top_retailers uses the row's dominant head
// (the order book aggregates carry one head per row), so a head filter is a
// dominant-head approximation on those two tables and exact on heads_retail.
export function filterRegional(
  data: RegionalData,
  syncedAt: string,
  heads?: string[],
  states?: string[],
): RegionalReportsPayload {
  const filtered = Boolean(heads?.length || states?.length);
  const headSet = heads?.length ? new Set(heads.map(normHead)) : null;
  const stateSet = states?.length ? new Set(states.map(normState)) : null;

  const byState = data.by_state.filter(
    (r) =>
      (!stateSet || stateSet.has(normState(r.state))) &&
      (!headSet || headSet.has(normHead(r.head))),
  );

  // Heads applicable under a state filter = heads whose order-book rows touch
  // a selected state. Their sales/retailers stay full-territory figures (no
  // state split exists) — the payload flags this so UI/export can say so.
  let headsRetail = data.heads_retail.filter(
    (h) => !headSet || headSet.has(normHead(h.head)),
  );
  if (stateSet) {
    const headsInStates = new Set(
      data.by_state
        .filter((r) => stateSet.has(normState(r.state)))
        .map((r) => normHead(r.head)),
    );
    headsRetail = headsRetail.filter((h) => headsInStates.has(normHead(h.head)));
  }

  // Top retailers: state filter is exact; a head filter narrows to the states
  // dominated by the selected heads (retailer rows carry no head).
  let retailerStateSet = stateSet;
  if (headSet) {
    const headStates = new Set(
      data.by_state
        .filter((r) => headSet.has(normHead(r.head)))
        .map((r) => normState(r.state)),
    );
    retailerStateSet = stateSet
      ? new Set([...stateSet].filter((s) => headStates.has(s)))
      : headStates;
  }
  const topRetailers = data.top_retailers.filter(
    (r) => !retailerStateSet || retailerStateSet.has(normState(r.state)),
  );

  return {
    filtered,
    headsFullTerritory: Boolean(stateSet),
    syncedAt,
    byState,
    headsRetail,
    topRetailers,
  };
}

async function loadData(): Promise<{ data: RegionalData; syncedAt: string }> {
  const snapshot = await ensureSeeded();
  return {
    data: snapshot.data as unknown as RegionalData,
    syncedAt: snapshot.syncedAt.toISOString(),
  };
}

router.get("/regional-reports", async (req, res) => {
  const heads = parseJsonArray(req.query.heads);
  const states = parseJsonArray(req.query.states);
  try {
    const { data, syncedAt } = await loadData();
    res.json(filterRegional(data, syncedAt, heads, states));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "regional-reports error");
    res.status(500).json({ error: "Failed to load regional data" });
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

router.get("/regional-reports/export", async (req, res) => {
  const heads = parseJsonArray(req.query.heads);
  const states = parseJsonArray(req.query.states);

  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.status(429).json({ error: "Another export is already running — try again in a few seconds." });
    return;
  }
  activeExports++;
  try {
    const { data, syncedAt } = await loadData();
    const p = filterRegional(data, syncedAt, heads, states);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Prayag Sales Intelligence";

    // Cover sheet — basis + active filters, so a filtered file is
    // self-describing and never mistaken for unfiltered company totals.
    const info = wb.addWorksheet("Info");
    info.columns = [{ width: 26 }, { width: 95 }];
    const infoRows: Array<[string, string]> = [
      ["Page", "Regional — FY26-27 order-book retail sales by state, head, and retailer"],
      ["Data synced at", p.syncedAt],
      ["State Head filter", heads?.length ? heads.join(", ") : "All"],
      ["State filter", states?.length ? states.join(", ") : "All"],
      ["Note", "Aggregate-level data: no month or distributor dimension applies. State rows carry their dominant head, so a head filter is a dominant-head approximation on the By State and Top Retailers sheets."],
    ];
    if (p.headsFullTerritory) {
      infoRows.push(["Heads sheet caveat", "A state filter is active: per-head sales/retailer figures still cover each head's FULL territory (the order book has no per-head state split)."]);
    }
    for (const [k, v] of infoRows) {
      const row = info.addRow([k, v]);
      row.getCell(1).font = { bold: true };
    }

    addSheet(wb, "By State", [
      { header: "State", key: "state", width: 24 },
      { header: "Head", key: "head", width: 24 },
      { header: "Retailers", key: "retailers", width: 12 },
      { header: "Sales (INR)", key: "sales", width: 16 },
    ], p.byState as unknown as Array<Record<string, unknown>>);

    addSheet(wb, p.headsFullTerritory ? "Heads (full territory)" : "By Head", [
      { header: "Head", key: "head", width: 26 },
      { header: "Retailers", key: "retailers", width: 12 },
      { header: "Sales (INR)", key: "sales", width: 16 },
      { header: "Share %", key: "share", width: 10 },
    ], p.headsRetail as unknown as Array<Record<string, unknown>>);

    addSheet(wb, "Top Retailers", [
      { header: "Company", key: "company", width: 36 },
      { header: "State", key: "state", width: 20 },
      { header: "City", key: "city", width: 20 },
      { header: "Sales (INR)", key: "sales", width: 16 },
    ], p.topRetailers as unknown as Array<Record<string, unknown>>);

    const buf = await wb.xlsx.writeBuffer();
    const suffix = p.filtered ? "_filtered" : "";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Regional${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "regional-reports export error");
    res.status(500).json({ error: "Export failed" });
  } finally {
    activeExports--;
  }
});

export default router;
