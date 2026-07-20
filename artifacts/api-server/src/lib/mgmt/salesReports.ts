// Per-salesperson report: secondary order booking + primary dispatched-sale.
//
// Secondary: re-aggregates from the cached order-booking file, adding
//   cross-dimensional maps (partyByState, segmentByState) built from
//   roster state — no extra Sheets read required.
// Primary:   loads the state-head dispatch registers + Party TM Map bridge,
//   then slices parties bridged to this rep (or rolled-up team). Item-code
//   breakdown is loaded from sale_line via the DB.
//
// State derivation for Secondary: the source file rarely carries a State
// column; we derive state from the roster spine (TM → state), so all of a
// rep's parties fall under their assigned state, and a head's team spans
// multiple states.
import {
  buildDeepDive,
  type DeepDive,
  type DeepRow,
} from "./salespeople.js";
import { loadOrderFile, type OrderFileAgg } from "./orders.js";
import { loadRoster } from "./roster.js";
import { loadStateHeadRegisters } from "./stateHeadRegisters.js";
import { loadPartyBridge } from "./bridge.js";
import { loadGroupIndex, canonicalGroup } from "./groups.js";
import {
  normName,
  normParty,
  normHead,
  fyStartYear,
  priorFy as calcPriorFy,
} from "./names.js";
import { db, saleLines, itemMaster } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { loadCollectionForFy } from "./collection.js";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type PrimaryParty = {
  party: string;
  amount: number;
};

export type ItemCodeRow = {
  code: string;
  description: string;
  amount: number;
};

// A party row in the partyByState cross-dimensional table. Includes prior-FY
// amount for growth display in the 3B (By Party filtered by State) report.
export type RepPartyRow = {
  id: string;
  name: string;
  amount: number;
  priorAmount: number;
};

export type StateMonthRow = {
  state: string;
  thisFy: number;
  lastFy: number;
  diff: number;
  growthPct: number | null;
  months: number[];
  monthsPrior: number[];
};

export type PartyGroupRow = {
  party: string;
  state: string;
  total: number;
  byGroup: Record<string, number>;
};

export type PrimaryReport = {
  available: boolean;
  reason?: string;
  headTotal: number;
  bridgedToAnyTmAmount: number;
  totalBridged: number;
  bridgeCoverage: number;
  bridgedParties: PrimaryParty[];
  unbridgedParties: PrimaryParty[];
  byItemCode: ItemCodeRow[];
  itemCodeNote?: string;
};

export type SalesRepMonthRow = {
  month: string;
  orderAmount: number;
  orders: number;
  saleAmount: number;
};

export type SalesRepReport = {
  fy: string;
  priorFy: string;
  repKey: string;
  repName: string;
  scope: "own" | "team";
  hasTeam: boolean;
  available: boolean;
  reason?: string;
  basis: "secondary" | "primary";

  monthly: SalesRepMonthRow[];

  stateOptions: string[];

  secondary: {
    tiles: DeepDive["tiles"];
    byState: DeepRow[];
    partyByState: Record<string, RepPartyRow[]>;
    segmentByState: Record<string, DeepRow[]>;
    byGroup: DeepRow[];
    bySegment: DeepRow[];
    parties: {
      top: DeepRow[];
      newTop: DeepRow[];
      churned: DeepRow[];
      newCount: number;
      churnedCount: number;
    };
    movers: {
      partiesUp: DeepRow[];
      partiesDown: DeepRow[];
      segmentsUp: DeepRow[];
      segmentsDown: DeepRow[];
    };
    saleCollection: { sale: number; saleLast: number; collection: number | null };
    byStateByMonth: StateMonthRow[];
    byGroupByState: Record<string, DeepRow[]>;
    partyGroupMatrix: PartyGroupRow[];
  };

  primary: PrimaryReport;

  reconciliation: {
    secondary: {
      repTotal: number;
      fileTotal: number | null;
      delta: number;
      ok: boolean;
      note: string;
    };
    primary: {
      bridgedAmount: number;
      unbridgedAmount: number;
      headTotal: number;
      delta: number;
      ok: boolean;
      note: string;
    };
  };
};

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

const FISCAL_MONTH_NAMES = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
];

function fiscalMonthLabel(idx: number, startYear: number): string {
  const calMonth = (idx + 3) % 12;
  const calYear = calMonth < 3 ? startYear + 1 : startYear;
  return `${FISCAL_MONTH_NAMES[idx]}-${String(calYear).slice(2)}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function growth(thisV: number, lastV: number): number | null {
  if (lastV === 0) return null;
  return round1(((thisV - lastV) / Math.abs(lastV)) * 100);
}

function share(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return round1((part / whole) * 100);
}

function comparisonRows(
  thisMap: Map<string, number>,
  lastMap: Map<string, number>,
  totalThis: number,
): DeepRow[] {
  const keys = new Set([...thisMap.keys(), ...lastMap.keys()]);
  const rows: DeepRow[] = [];
  for (const k of keys) {
    const thisFy = thisMap.get(k) ?? 0;
    const lastFy = lastMap.get(k) ?? 0;
    if (thisFy === 0 && lastFy === 0) continue;
    rows.push({
      label: k,
      thisFy,
      lastFy,
      diff: thisFy - lastFy,
      growthPct: growth(thisFy, lastFy),
      sharePct: share(thisFy, totalThis),
    });
  }
  rows.sort((a, b) => b.thisFy - a.thisFy);
  return rows;
}

// BFS descent over the hierarchy to collect all member keys under a root.
function collectTeamKeys(
  childrenOf: Map<string, string[]>,
  memberKeys: Set<string>,
  rootKey: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [rootKey];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    if (memberKeys.has(k)) out.push(k);
    for (const c of childrenOf.get(k) ?? []) stack.push(c);
  }
  return out;
}

// Build partyByState from order file + roster state.
// state is derived from the roster spine (TM's assigned state), since the
// secondary order booking file rarely carries a per-row State column.
// When the file does have state data (partyState populated at read time),
// that takes precedence over the roster-derived state.
function buildPartyByState(
  thisAgg: OrderFileAgg | null,
  priorAgg: OrderFileAgg | null,
  teamKeys: string[],
  stateOf: Map<string, string>,
): {
  partyByState: Record<string, RepPartyRow[]>;
  segmentByState: Record<string, DeepRow[]>;
  stateOptions: string[];
} {
  const partyAmountThis = new Map<string, Map<string, number>>();  // state → retailerId → amount
  const partyAmountPrior = new Map<string, Map<string, number>>();
  const partyName = new Map<string, string>();  // retailerId → display name
  const segAmountThis = new Map<string, Map<string, number>>();  // state → segment → amount
  const segAmountPrior = new Map<string, Map<string, number>>();
  const stateSet = new Set<string>();

  const addToStateParty = (
    statePartyMap: Map<string, Map<string, number>>,
    state: string,
    retailerId: string,
    amount: number,
  ): void => {
    let m = statePartyMap.get(state);
    if (!m) { m = new Map(); statePartyMap.set(state, m); }
    m.set(retailerId, (m.get(retailerId) ?? 0) + amount);
  };

  const addToStateSeg = (
    stateSegMap: Map<string, Map<string, number>>,
    state: string,
    segment: string,
    amount: number,
  ): void => {
    let m = stateSegMap.get(state);
    if (!m) { m = new Map(); stateSegMap.set(state, m); }
    m.set(segment, (m.get(segment) ?? 0) + amount);
  };

  for (const tmKey of teamKeys) {
    const tmState = stateOf.get(tmKey) ?? "";
    if (!tmState) continue;
    stateSet.add(tmState);

    if (thisAgg) {
      const tm = thisAgg.perTm.get(tmKey);
      if (tm) {
        for (const [rid, rs] of tm.retailers) {
          // Prefer the per-party state from the file; fall back to TM roster state.
          const st = tm.partyState.get(rid) || tmState;
          addToStateParty(partyAmountThis, st, rid, rs.amount);
          if (!partyName.has(rid)) partyName.set(rid, rs.name || rid);
          stateSet.add(st);
        }
        // Segment by state from perPartyPerSegment
        for (const [rid] of tm.retailers) {
          const st = tm.partyState.get(rid) || tmState;
          const segs = tm.perPartyPerSegment.get(rid);
          if (!segs) continue;
          for (const [seg, v] of segs) {
            addToStateSeg(segAmountThis, st, seg, v);
          }
        }
      }
    }
    if (priorAgg) {
      const tm = priorAgg.perTm.get(tmKey);
      if (tm) {
        for (const [rid, rs] of tm.retailers) {
          const st = tm.partyState.get(rid) || tmState;
          addToStateParty(partyAmountPrior, st, rid, rs.amount);
        }
        for (const [rid] of tm.retailers) {
          const st = tm.partyState.get(rid) || tmState;
          const segs = tm.perPartyPerSegment.get(rid);
          if (!segs) continue;
          for (const [seg, v] of segs) {
            addToStateSeg(segAmountPrior, st, seg, v);
          }
        }
      }
    }
  }

  const stateOptions = [...stateSet].sort();
  const partyByState: Record<string, RepPartyRow[]> = {};
  const segmentByState: Record<string, DeepRow[]> = {};

  for (const state of stateOptions) {
    const thisMap = partyAmountThis.get(state) ?? new Map<string, number>();
    const priorMap = partyAmountPrior.get(state) ?? new Map<string, number>();
    const allIds = new Set([...thisMap.keys(), ...priorMap.keys()]);
    const rows: RepPartyRow[] = [];
    for (const rid of allIds) {
      const amount = thisMap.get(rid) ?? 0;
      const priorAmount = priorMap.get(rid) ?? 0;
      if (amount === 0 && priorAmount === 0) continue;
      rows.push({ id: rid, name: partyName.get(rid) ?? rid, amount, priorAmount });
    }
    rows.sort((a, b) => b.amount - a.amount);
    partyByState[state] = rows;

    const thisSegs = segAmountThis.get(state) ?? new Map<string, number>();
    const priorSegs = segAmountPrior.get(state) ?? new Map<string, number>();
    const total = [...thisSegs.values()].reduce((a, v) => a + v, 0);
    segmentByState[state] = comparisonRows(thisSegs, priorSegs, total);
  }

  return { partyByState, segmentByState, stateOptions };
}

async function segmentToGroup(perSegment: Map<string, number>): Promise<Map<string, number>> {
  const index = await loadGroupIndex();
  const out = new Map<string, number>();
  for (const [seg, v] of perSegment) {
    const group = canonicalGroup(index, seg) ?? "Unmapped";
    out.set(group, (out.get(group) ?? 0) + v);
  }
  return out;
}

// Item-code breakdown from sale_line (Primary basis only).
// Matches sale_line.customer → normParty → bridge entry for this TM's team.
async function buildItemCodeRows(
  fy: string,
  bridgedNormKeys: Set<string>,
): Promise<{ rows: ItemCodeRow[]; note?: string }> {
  if (bridgedNormKeys.size === 0) {
    return { rows: [], note: "No parties are bridged to this rep for the selected FY." };
  }
  try {
    const lines = await db
      .select({ code: saleLines.code, customer: saleLines.customer, amount: saleLines.amount })
      .from(saleLines)
      .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")));

    const byCode = new Map<string, number>();
    for (const row of lines) {
      const amt = Number(row.amount);
      if (!amt) continue;
      const nk = normParty(row.customer);
      if (!bridgedNormKeys.has(nk)) continue;
      byCode.set(row.code, (byCode.get(row.code) ?? 0) + amt);
    }

    if (byCode.size === 0) {
      return {
        rows: [],
        note:
          "No sale_line rows matched bridged parties for this FY. " +
          "Ensure invoice registers are loaded via Data Sources.",
      };
    }

    const codes = [...byCode.keys()];
    const items = await db
      .select({ code: itemMaster.code, itemName: itemMaster.itemName })
      .from(itemMaster)
      .where(inArray(itemMaster.code, codes));
    const descMap = new Map(items.map((r) => [r.code, r.itemName ?? ""]));

    const rows = codes
      .map((code) => ({
        code,
        description: descMap.get(code) ?? "",
        amount: byCode.get(code) ?? 0,
      }))
      .sort((a, b) => b.amount - a.amount);

    return { rows };
  } catch {
    return {
      rows: [],
      note: "Item-code breakdown could not be loaded from the invoice register.",
    };
  }
}

// -------------------------------------------------------------------------
// Main builder
// -------------------------------------------------------------------------

export async function buildSalesReports(
  fy: string,
  repKey: string,
  scope: "own" | "team",
  options: {
    basis?: "secondary" | "primary";
    filterState?: string;
    filterParty?: string;
  } = {},
): Promise<SalesRepReport> {
  const { basis = "secondary" } = options;
  const prior = calcPriorFy(fy);
  const startYear = fyStartYear(fy);

  // Run all heavy I/O in parallel.
  const [dive, orderFile, priorOrderFile, roster, registers, bridge, collectionMap] = await Promise.all([
    buildDeepDive(fy, repKey, scope),
    loadOrderFile(fy),
    loadOrderFile(prior),
    loadRoster(),
    loadStateHeadRegisters(),
    loadPartyBridge(),
    loadCollectionForFy(fy).catch(() => new Map<string, number>()),
  ]);

  // Build minimal hierarchy for team rollup.
  const memberByKey = new Map<string, (typeof roster.members)[number]>();
  for (const m of roster.members) {
    if (m.normKey && !memberByKey.has(m.normKey)) memberByKey.set(m.normKey, m);
  }
  const childrenOf = new Map<string, string[]>();
  const memberKeys = new Set<string>();
  const stateOf = new Map<string, string>();  // normKey → state

  for (const [key, m] of memberByKey) {
    memberKeys.add(key);
    stateOf.set(key, m.state || m.workingState || "");
    const parentKey = normName(m.stateHead);
    if (parentKey && memberByKey.has(parentKey) && parentKey !== key) {
      const arr = childrenOf.get(parentKey);
      if (arr) arr.push(key);
      else childrenOf.set(parentKey, [key]);
    }
  }

  const effectiveScope = dive.scope;
  const teamKeys =
    effectiveScope === "team"
      ? collectTeamKeys(childrenOf, memberKeys, repKey)
      : [repKey];

  // Monthly: sum across team members.
  const monthly: SalesRepMonthRow[] = [];
  for (let i = 0; i < 12; i++) {
    let orderAmount = 0;
    let orders = 0;
    let saleAmount = 0;
    if (orderFile) {
      for (const k of teamKeys) {
        const tm = orderFile.perTm.get(k);
        if (!tm) continue;
        orderAmount += tm.monthAmount[i];
        orders += tm.monthOrderIds[i].size;
        saleAmount += tm.saleMonthAmount[i];
      }
    }
    monthly.push({ month: fiscalMonthLabel(i, startYear), orderAmount, orders, saleAmount });
  }

  // Secondary tiles from DeepDive.
  const emptyTiles: DeepDive["tiles"] = {
    netOrderBooked: 0,
    netOrderBookedLast: 0,
    growthPct: null,
    orders: 0,
    activeRetailers: 0,
    newRetailers: 0,
    avgOrderValue: null,
    businessPerRetailer: null,
    target: null,
    achievementPct: null,
  };

  // Build cross-dimensional state maps (partyByState, segmentByState).
  const { partyByState, segmentByState, stateOptions } = buildPartyByState(
    orderFile,
    priorOrderFile,
    teamKeys,
    stateOf,
  );

  // bySegment globally → then via group index for byGroup.
  const thisSegMap = new Map<string, number>();
  const priorSegMap = new Map<string, number>();
  if (orderFile) {
    for (const k of teamKeys) {
      const tm = orderFile.perTm.get(k);
      if (!tm) continue;
      for (const [seg, v] of tm.perSegment) {
        thisSegMap.set(seg, (thisSegMap.get(seg) ?? 0) + v);
      }
    }
  }
  if (priorOrderFile) {
    for (const k of teamKeys) {
      const tm = priorOrderFile.perTm.get(k);
      if (!tm) continue;
      for (const [seg, v] of tm.perSegment) {
        priorSegMap.set(seg, (priorSegMap.get(seg) ?? 0) + v);
      }
    }
  }
  const totalSec = [...thisSegMap.values()].reduce((a, v) => a + v, 0);
  const totalSecPrior = [...priorSegMap.values()].reduce((a, v) => a + v, 0);

  const thisGroupMap = await segmentToGroup(thisSegMap);
  const priorGroupMap = await segmentToGroup(priorSegMap);

  const byGroup = comparisonRows(thisGroupMap, priorGroupMap, totalSec);
  const bySegment = comparisonRows(thisSegMap, priorSegMap, totalSec);

  // Report 2: State × Month growth grid.
  // Primary source: perStatePerMonth (requires a State/Territory column in the order file).
  // Fallback: when perStatePerMonth is absent (no State column), allocate the TM's monthly
  // totals (tm.monthAmount) to the TM's roster state — the same fallback buildPartyByState uses.
  const stateMonthThis = new Map<string, number[]>();
  const stateMonthPrior = new Map<string, number[]>();
  for (const k of teamKeys) {
    const tmState = stateOf.get(k) ?? "";
    const tm = orderFile?.perTm.get(k);
    if (tm) {
      if (tm.perStatePerMonth.size > 0) {
        for (const [state, months] of tm.perStatePerMonth) {
          let arr = stateMonthThis.get(state);
          if (!arr) { arr = new Array(12).fill(0) as number[]; stateMonthThis.set(state, arr); }
          for (let i = 0; i < 12; i++) arr[i] += months[i] ?? 0;
        }
      } else if (tmState) {
        // No per-state column in file — fall back to roster state for monthly totals.
        let arr = stateMonthThis.get(tmState);
        if (!arr) { arr = new Array(12).fill(0) as number[]; stateMonthThis.set(tmState, arr); }
        for (let i = 0; i < 12; i++) arr[i] += tm.monthAmount[i] ?? 0;
      }
    }
    const tmP = priorOrderFile?.perTm.get(k);
    if (tmP) {
      if (tmP.perStatePerMonth.size > 0) {
        for (const [state, months] of tmP.perStatePerMonth) {
          let arr = stateMonthPrior.get(state);
          if (!arr) { arr = new Array(12).fill(0) as number[]; stateMonthPrior.set(state, arr); }
          for (let i = 0; i < 12; i++) arr[i] += months[i] ?? 0;
        }
      } else if (tmState) {
        let arr = stateMonthPrior.get(tmState);
        if (!arr) { arr = new Array(12).fill(0) as number[]; stateMonthPrior.set(tmState, arr); }
        for (let i = 0; i < 12; i++) arr[i] += tmP.monthAmount[i] ?? 0;
      }
    }
  }
  const byStateByMonth: StateMonthRow[] = stateOptions
    .map((state) => {
      const months = stateMonthThis.get(state) ?? (new Array(12).fill(0) as number[]);
      const monthsPrior = stateMonthPrior.get(state) ?? (new Array(12).fill(0) as number[]);
      const thisFy = months.reduce((a, v) => a + v, 0);
      const lastFy = monthsPrior.reduce((a, v) => a + v, 0);
      const diff = thisFy - lastFy;
      const growthPct = lastFy > 0 ? round1((diff / Math.abs(lastFy)) * 100) : null;
      return { state, thisFy, lastFy, diff, growthPct, months, monthsPrior };
    })
    .filter((r) => r.thisFy > 0 || r.lastFy > 0);

  // Report 3A: Group-wise by State (map segmentByState rows to groups via group index).
  const groupIndex = await loadGroupIndex();
  const byGroupByState: Record<string, DeepRow[]> = {};
  for (const [state, segRows] of Object.entries(segmentByState)) {
    const thisGrpMap = new Map<string, number>();
    const priorGrpMap = new Map<string, number>();
    let stateTotal = 0;
    for (const row of segRows) {
      const group = canonicalGroup(groupIndex, row.label) ?? "Unmapped";
      thisGrpMap.set(group, (thisGrpMap.get(group) ?? 0) + row.thisFy);
      priorGrpMap.set(group, (priorGrpMap.get(group) ?? 0) + row.lastFy);
      stateTotal += row.thisFy;
    }
    byGroupByState[state] = comparisonRows(thisGrpMap, priorGrpMap, stateTotal);
  }

  // Report 7: Party × Group matrix (perPartyPerSegment mapped to canonical groups).
  const partyGroupAccum = new Map<string, {
    name: string; state: string; byGroup: Map<string, number>; total: number;
  }>();
  for (const k of teamKeys) {
    const tm = orderFile?.perTm.get(k);
    if (!tm) continue;
    const tmState = stateOf.get(k) ?? "";
    for (const [rid, segMap] of tm.perPartyPerSegment) {
      const state = tm.partyState.get(rid) || tmState;
      let entry = partyGroupAccum.get(rid);
      if (!entry) {
        entry = { name: rid, state, byGroup: new Map(), total: 0 };
        partyGroupAccum.set(rid, entry);
      }
      for (const [seg, amt] of segMap) {
        const group = canonicalGroup(groupIndex, seg) ?? "Unmapped";
        entry.byGroup.set(group, (entry.byGroup.get(group) ?? 0) + amt);
        entry.total += amt;
      }
    }
  }
  const partyGroupMatrix: PartyGroupRow[] = [...partyGroupAccum.values()]
    .sort((a, b) => b.total - a.total)
    .map(({ name, state, total, byGroup }) => ({
      party: name,
      state,
      total,
      byGroup: Object.fromEntries(byGroup),
    }));

  // Sale & Collection: Sale = this FY net secondary total, Collection = pending.
  const saleTotal = dive.available ? dive.tiles.netOrderBooked : 0;
  const saleTotalPrior = dive.available ? dive.tiles.netOrderBookedLast : 0;

  const secondary = {
    tiles: dive.available ? dive.tiles : emptyTiles,
    byState: dive.byState,
    partyByState,
    segmentByState,
    byGroup,
    bySegment,
    parties: {
      top: dive.parties.top,
      newTop: dive.parties.newTop,
      churned: dive.parties.churned,
      newCount: dive.parties.newCount,
      churnedCount: dive.parties.churnedCount,
    },
    movers: dive.movers,
    saleCollection: {
      sale: saleTotal,
      saleLast: saleTotalPrior,
      collection: (() => {
        // Collection is tracked at state-head level (one aggregate per head).
        // For a team-scope report the rep IS the head; for own-scope find the
        // head above them in the roster.
        const headKey =
          effectiveScope === "team"
            ? repKey
            : normName(memberByKey.get(repKey)?.stateHead ?? "");
        return headKey ? (collectionMap.get(headKey) ?? null) : null;
      })(),
    },
    byStateByMonth,
    byGroupByState,
    partyGroupMatrix,
  };

  // Reconciliation — secondary: rep rollup cross-foots against the state-level breakdown
  // derived from the same order file. Comparing to orderFile.totalSaleAmount would compare
  // one rep against the whole company file, which is meaningless.
  const repSecTotal = orderFile
    ? teamKeys.reduce((sum, k) => sum + (orderFile.perTm.get(k)?.saleAmount ?? 0), 0)
    : 0;
  const byStateTotal = secondary.byState.reduce((a, r) => a + r.thisFy, 0);
  const secDelta = orderFile ? Math.abs(repSecTotal - byStateTotal) : 0;
  const secOk = !orderFile || secDelta <= 1;

  // Primary: registers + bridge.
  let primary: PrimaryReport;

  if (bridge.status !== "ok") {
    const reason =
      bridge.status === "building"
        ? "The Party TM Map bridge is being built in the background. Check back in a few minutes."
        : bridge.status === "missing"
          ? "The Party TM Map sheet was not found in Drive. Share it with the connected account to enable primary data."
          : "The Party TM Map bridge could not be loaded: " + (bridge.detail ?? "unknown error");
    primary = {
      available: false,
      reason,
      headTotal: 0,
      bridgedToAnyTmAmount: 0,
      totalBridged: 0,
      bridgeCoverage: 0,
      bridgedParties: [],
      unbridgedParties: [],
      byItemCode: [],
      itemCodeNote: reason,
    };
  } else {
    const stateHeadsOfTeam = new Set<string>();
    for (const k of teamKeys) {
      const m = memberByKey.get(k);
      if (m?.stateHead) stateHeadsOfTeam.add(m.stateHead.trim());
    }

    const partyAmounts = new Map<string, number>();
    const partyNames = new Map<string, string>();

    for (const headDisplay of stateHeadsOfTeam) {
      const headKey = normHead(headDisplay);
      const headAgg = registers.byHead.get(headKey);
      if (!headAgg) continue;
      const fyAgg = headAgg.byFy.get(fy);
      if (!fyAgg) continue;
      for (const [rawParty, agg] of fyAgg.parties) {
        const nk = normParty(rawParty);
        if (!nk) continue;
        partyAmounts.set(nk, (partyAmounts.get(nk) ?? 0) + agg.amount);
        if (!partyNames.has(nk)) partyNames.set(nk, rawParty);
      }
    }

    const tmKeySet = new Set(teamKeys);
    let headTotal = 0;
    let bridgedToAnyTmAmount = 0;
    let totalBridged = 0;
    const bridgedParties: PrimaryParty[] = [];
    const unbridgedParties: PrimaryParty[] = [];
    const bridgedNormKeys = new Set<string>();

    for (const [nk, amount] of partyAmounts) {
      headTotal += amount;
      const entry = bridge.entries.get(nk);
      if (entry) {
        bridgedToAnyTmAmount += amount;
      }
      if (entry && tmKeySet.has(entry.memberKey)) {
        // Bridged to this rep's team — show in rep's primary view.
        totalBridged += amount;
        bridgedParties.push({ party: partyNames.get(nk) ?? nk, amount });
        bridgedNormKeys.add(nk);
      } else {
        // Either unmapped or bridged to a different TM — goes into unbridged so
        // headTotal = totalBridged + Σ(unbridgedParties) always holds (±₹0).
        unbridgedParties.push({ party: partyNames.get(nk) ?? nk, amount });
      }
    }
    bridgedParties.sort((a, b) => b.amount - a.amount);
    unbridgedParties.sort((a, b) => b.amount - a.amount);

    const bridgeCoverage =
      headTotal > 0 ? Math.round((bridgedToAnyTmAmount / headTotal) * 1000) / 10 : 0;

    // Item-code breakdown from sale_line (Report 4 — Primary only).
    const { rows: byItemCode, note: itemCodeNote } = await buildItemCodeRows(fy, bridgedNormKeys);

    primary = {
      available: true,
      headTotal,
      bridgedToAnyTmAmount,
      totalBridged,
      bridgeCoverage,
      bridgedParties,
      unbridgedParties,
      byItemCode,
      itemCodeNote,
    };
  }

  // Reconciliation — primary: bridged + unbridged must equal head total (±₹1).
  const priDelta = primary.available
    ? Math.abs(primary.totalBridged + primary.unbridgedParties.reduce((s, p) => s + p.amount, 0) - primary.headTotal)
    : 0;
  const priOk = !primary.available || priDelta <= 1;

  return {
    fy,
    priorFy: prior,
    repKey,
    repName: dive.repName,
    scope: effectiveScope,
    hasTeam: dive.hasTeam,
    available: dive.available,
    reason: dive.reason,
    basis,
    monthly,
    stateOptions,
    secondary,
    primary,
    reconciliation: {
      secondary: {
        repTotal: Math.round(repSecTotal),
        fileTotal: null,
        delta: Math.round(secDelta),
        ok: secOk,
        note: secOk
          ? !orderFile
            ? "Order file not loaded — cannot cross-foot."
            : "Rep total cross-foots with state-level breakdown within ₹1."
          : `Rep total (${Math.round(repSecTotal).toLocaleString("en-IN")}) differs from state-level sum (${Math.round(byStateTotal).toLocaleString("en-IN")}) by ₹${Math.round(secDelta).toLocaleString("en-IN")}.`,
      },
      primary: {
        bridgedAmount: Math.round(primary.totalBridged),
        unbridgedAmount: Math.round(
          primary.unbridgedParties.reduce((s, p) => s + p.amount, 0),
        ),
        headTotal: Math.round(primary.headTotal),
        delta: Math.round(priDelta),
        ok: priOk,
        note: priOk
          ? !primary.available
            ? "Primary bridge not available."
            : "Bridged + unbridged total matches head register total within ₹1."
          : `Bridged + unbridged (${Math.round(primary.totalBridged + primary.unbridgedParties.reduce((s, p) => s + p.amount, 0)).toLocaleString("en-IN")}) differs from head total (${Math.round(primary.headTotal).toLocaleString("en-IN")}) by ₹${Math.round(priDelta).toLocaleString("en-IN")}.`,
      },
    },
  };
}
