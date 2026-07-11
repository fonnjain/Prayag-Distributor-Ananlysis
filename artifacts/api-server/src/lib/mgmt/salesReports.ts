// Per-salesperson report: secondary order booking + primary dispatched-sale.
//
// Secondary: delegates to buildDeepDive (order booking file).
// Primary:   loads the state-head dispatch registers + Party TM bridge, then
//            slices parties bridged to this rep (or rolled-up team).
//            By-state / group / segment breakdowns are NOT available at
//            party grain from the register; the primary block returns party
//            amounts only.
// Monthly:   sums the whole team when scope="team" (buildDeepDive doesn't
//            expose that; we re-aggregate from the order file directly).
import {
  buildDeepDive,
  type DeepDive,
  type DeepRow,
} from "./salespeople.js";
import { loadOrderFile } from "./orders.js";
import { loadRoster } from "./roster.js";
import { loadStateHeadRegisters } from "./stateHeadRegisters.js";
import { loadPartyBridge } from "./bridge.js";
import {
  normName,
  normParty,
  normHead,
  fyStartYear,
  priorFy as calcPriorFy,
} from "./names.js";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type PrimaryParty = {
  party: string;
  amount: number;
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
  monthly: SalesRepMonthRow[];
  secondary: {
    tiles: DeepDive["tiles"];
    byState: DeepRow[];
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
  };
  primary: PrimaryReport;
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

// BFS descent over the hierarchy to collect all member keys under a root.
// Mirrors the unexported descendantMemberKeys in salespeople.ts.
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

// -------------------------------------------------------------------------
// Main builder
// -------------------------------------------------------------------------

export async function buildSalesReports(
  fy: string,
  repKey: string,
  scope: "own" | "team",
): Promise<SalesRepReport> {
  const prior = calcPriorFy(fy);
  const startYear = fyStartYear(fy);

  // Run heavy I/O in parallel.
  const [dive, orderFile, roster, registers, bridge] = await Promise.all([
    buildDeepDive(fy, repKey, scope),
    loadOrderFile(fy),
    loadRoster(),
    loadStateHeadRegisters(),
    loadPartyBridge(),
  ]);

  // Build a minimal hierarchy so we can roll up team monthly amounts.
  const memberByKey = new Map<string, (typeof roster.members)[number]>();
  for (const m of roster.members) {
    if (m.normKey && !memberByKey.has(m.normKey)) memberByKey.set(m.normKey, m);
  }
  const childrenOf = new Map<string, string[]>();
  const memberKeys = new Set<string>();
  for (const [key, m] of memberByKey) {
    memberKeys.add(key);
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

  // Monthly: sum across team members (each order ID is unique per TM).
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
    monthly.push({
      month: fiscalMonthLabel(i, startYear),
      orderAmount,
      orders,
      saleAmount,
    });
  }

  // Secondary: extract from DeepDive.
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
  const secondary = {
    tiles: dive.available ? dive.tiles : emptyTiles,
    byState: dive.byState,
    byGroup: dive.byGroup,
    bySegment: dive.bySegment,
    parties: {
      top: dive.parties.top,
      newTop: dive.parties.newTop,
      churned: dive.parties.churned,
      newCount: dive.parties.newCount,
      churnedCount: dive.parties.churnedCount,
    },
    movers: dive.movers,
  };

  // Primary: state-head registers + bridge.
  let primary: PrimaryReport;

  if (bridge.status !== "ok") {
    const reason =
      bridge.status === "building"
        ? "The Party TM Map bridge is being built in the background. Check back in a few minutes."
        : bridge.status === "missing"
          ? "The Party TM Map sheet was not found in Drive. Share it with the connected account to enable primary data."
          : "The Party TM Map bridge could not be loaded: " + (bridge.detail || "unknown error");
    primary = {
      available: false,
      reason,
      headTotal: 0,
      bridgedToAnyTmAmount: 0,
      totalBridged: 0,
      bridgeCoverage: 0,
      bridgedParties: [],
      unbridgedParties: [],
    };
  } else {
    // Find all state heads for the team members.
    const stateHeadsOfTeam = new Set<string>();
    for (const k of teamKeys) {
      const m = memberByKey.get(k);
      if (m?.stateHead) stateHeadsOfTeam.add(m.stateHead.trim());
    }

    // Collect party amounts from the relevant head registers.
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

    for (const [nk, amount] of partyAmounts) {
      headTotal += amount;
      const entry = bridge.entries.get(nk);
      if (entry) {
        bridgedToAnyTmAmount += amount;
        if (tmKeySet.has(entry.memberKey)) {
          totalBridged += amount;
          bridgedParties.push({ party: partyNames.get(nk) ?? nk, amount });
        }
      } else {
        unbridgedParties.push({ party: partyNames.get(nk) ?? nk, amount });
      }
    }

    bridgedParties.sort((a, b) => b.amount - a.amount);
    unbridgedParties.sort((a, b) => b.amount - a.amount);

    const bridgeCoverage =
      headTotal > 0
        ? Math.round((bridgedToAnyTmAmount / headTotal) * 1000) / 10
        : 0;

    primary = {
      available: true,
      headTotal,
      bridgedToAnyTmAmount,
      totalBridged,
      bridgeCoverage,
      bridgedParties,
      unbridgedParties,
    };
  }

  return {
    fy,
    priorFy: prior,
    repKey,
    repName: dive.repName,
    scope: effectiveScope,
    hasTeam: dive.hasTeam,
    available: dive.available,
    reason: dive.reason,
    monthly,
    secondary,
    primary,
  };
}
