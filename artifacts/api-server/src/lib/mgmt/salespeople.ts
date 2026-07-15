// Sales People deep-dive: one level below the State Head view.
//
// Everything here is derived from the same NET Sub Total Secondary Order
// Booking pipeline the management report uses (loadOrderFile), joined to the
// roster spine. The primary dispatched-sale register is never used because it
// carries no salesperson column.
//
// Three products:
//   1. A reporting tree built generically from the roster's Reporting Manager
//      (RosterMember.stateHead). Heads are the roots; reps nest underneath.
//      The full multi-level tree needs the HR roster (Team Member Details,
//      which carries Reporting Manager). When that Drive file is not shared the
//      roster falls back to the flat STATE HEAD DASHBOARD (head -> rep, two
//      levels) and multiLevel is false so the UI can say the second tier is
//      unavailable.
//   2. A per-rep deep-dive (own book or own + rolled-up juniors) with headline
//      tiles and four FY-vs-FY tables (By State, By Party, By Group, By
//      Segment) plus top-5 movers.
//   3. A verify/data-health reconciliation against the locked net anchors.
import verifyAnchorsJson from "../../../config/verify_anchors.json";
import {
  loadOrderFile,
  loadRetailerFirstSeen,
  getOrderLoadStatus,
  type OrderFileAgg,
} from "./orders.js";
import { loadRoster, type Roster } from "./roster.js";
import { loadGroupIndex, canonicalGroup } from "./groups.js";
import { loadTargetsForFy } from "./targets.js";
import {
  normName,
  priorFy,
  fyBoundsSerial,
  buildHeadResolver,
} from "./names.js";

type FyAnchor = { perHeadSale?: Record<string, number>; saleReportTotal?: number };
type VerifyAnchors = { fy_anchors: Record<string, FyAnchor> };
const anchors = verifyAnchorsJson as VerifyAnchors;

// -------------------------------------------------------------------------
// Hierarchy (roster-derived reporting tree)
// -------------------------------------------------------------------------

type Hierarchy = {
  roots: string[];
  childrenOf: Map<string, string[]>;
  nameOf: Map<string, string>;
  stateOf: Map<string, string>;
  memberKeys: Set<string>;
  multiLevel: boolean;
};

function buildHierarchy(roster: Roster): Hierarchy {
  const memberByKey = new Map<string, (typeof roster.members)[number]>();
  for (const m of roster.members) {
    if (m.normKey && !memberByKey.has(m.normKey)) memberByKey.set(m.normKey, m);
  }
  const childrenOf = new Map<string, string[]>();
  const nameOf = new Map<string, string>();
  const stateOf = new Map<string, string>();
  const memberKeys = new Set<string>();
  const rootsSet = new Set<string>();
  const addChild = (parent: string, child: string): void => {
    const arr = childrenOf.get(parent);
    if (arr) arr.push(child);
    else childrenOf.set(parent, [child]);
  };
  for (const [key, m] of memberByKey) {
    memberKeys.add(key);
    nameOf.set(key, m.name);
    stateOf.set(key, m.state || m.workingState || "");
    const parentKey = normName(m.stateHead);
    if (!parentKey) {
      rootsSet.add(key);
    } else if (memberByKey.has(parentKey) && parentKey !== key) {
      addChild(parentKey, key);
    } else {
      // Manager is not a roster member (the fallback roster's State Head, or an
      // HR manager missing from the sheet) -> synthesise a head root node.
      if (!nameOf.has(parentKey)) nameOf.set(parentKey, m.stateHead.trim());
      if (!stateOf.has(parentKey)) stateOf.set(parentKey, "");
      addChild(parentKey, key);
      rootsSet.add(parentKey);
    }
  }
  let multiLevel = false;
  for (const root of rootsSet) {
    for (const c of childrenOf.get(root) ?? []) {
      if ((childrenOf.get(c) ?? []).length > 0) {
        multiLevel = true;
        break;
      }
    }
    if (multiLevel) break;
  }
  return { roots: [...rootsSet], childrenOf, nameOf, stateOf, memberKeys, multiLevel };
}

// Member keys under a node (inclusive), guarding against manager cycles.
function descendantMemberKeys(h: Hierarchy, key: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [key];
  while (stack.length) {
    const k = stack.pop() as string;
    if (seen.has(k)) continue;
    seen.add(k);
    if (h.memberKeys.has(k)) out.push(k);
    for (const c of h.childrenOf.get(k) ?? []) stack.push(c);
  }
  return out;
}

export type RepNode = {
  key: string;
  name: string;
  state: string;
  isMember: boolean;
  hasTeam: boolean;
  ownNet: number;
  teamNet: number;
  children: RepNode[];
};

export type SalesTree = {
  fy: string;
  available: boolean;
  reason?: string;
  rosterSource: Roster["source"];
  multiLevel: boolean;
  loadDetail: string | null;
  heads: RepNode[];
};

function ownNetOf(agg: OrderFileAgg | null, key: string): number {
  return agg?.perTm.get(key)?.saleAmount ?? 0;
}

function buildNode(
  h: Hierarchy,
  agg: OrderFileAgg | null,
  key: string,
  seen: Set<string>,
): RepNode {
  seen.add(key);
  const childKeys = (h.childrenOf.get(key) ?? []).filter((c) => !seen.has(c));
  const children = childKeys.map((c) => buildNode(h, agg, c, seen));
  const ownNet = ownNetOf(agg, key);
  const teamNet = ownNet + children.reduce((a, c) => a + c.teamNet, 0);
  children.sort((a, b) => b.teamNet - a.teamNet);
  return {
    key,
    name: h.nameOf.get(key) ?? key,
    state: h.stateOf.get(key) ?? "",
    isMember: h.memberKeys.has(key),
    hasTeam: children.length > 0,
    ownNet,
    teamNet,
    children,
  };
}

export async function buildSalesTree(fy: string): Promise<SalesTree> {
  const [roster, agg] = await Promise.all([loadRoster(), loadOrderFile(fy)]);
  const h = buildHierarchy(roster);
  const seen = new Set<string>();
  const heads = h.roots
    .map((r) => buildNode(h, agg, r, seen))
    .sort((a, b) => b.teamNet - a.teamNet);
  const status = getOrderLoadStatus(fy);
  return {
    fy,
    available: heads.length > 0,
    reason: heads.length === 0 ? "The roster is empty, so no sales people could be listed." : undefined,
    rosterSource: roster.source,
    multiLevel: h.multiLevel,
    loadDetail: agg ? null : (status?.detail ?? `No order booking data is available for ${fy} yet.`),
    heads,
  };
}

// -------------------------------------------------------------------------
// Per-rep deep-dive
// -------------------------------------------------------------------------

export type DeepRow = {
  label: string;
  thisFy: number;
  lastFy: number;
  diff: number;
  growthPct: number | null;
  sharePct: number | null;
  flag?: "new" | "old" | "churned";
};

type KeyAgg = {
  net: number;
  orderIds: Set<string>;
  retailers: Map<string, { amount: number; name: string }>;
  perSegment: Map<string, number>;
  byState: Map<string, number>;
};

function aggregateKeys(
  agg: OrderFileAgg | null,
  keys: string[],
  stateOf: Map<string, string>,
): KeyAgg {
  const res: KeyAgg = {
    net: 0,
    orderIds: new Set<string>(),
    retailers: new Map(),
    perSegment: new Map(),
    byState: new Map(),
  };
  if (!agg) return res;
  for (const k of keys) {
    const tm = agg.perTm.get(k);
    if (!tm) continue;
    res.net += tm.saleAmount;
    for (const o of tm.orderIds) res.orderIds.add(o);
    for (const [rid, rs] of tm.retailers) {
      const cur = res.retailers.get(rid);
      if (cur) {
        cur.amount += rs.amount;
        if (!cur.name || cur.name === rid) cur.name = rs.name;
      } else {
        res.retailers.set(rid, { amount: rs.amount, name: rs.name });
      }
    }
    for (const [seg, v] of tm.perSegment) {
      res.perSegment.set(seg, (res.perSegment.get(seg) ?? 0) + v);
    }
    const st = stateOf.get(k) || "Unknown";
    res.byState.set(st, (res.byState.get(st) ?? 0) + tm.saleAmount);
  }
  return res;
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

// Combine two label->amount maps into comparison rows, sorted by this-FY value.
function comparisonRows(
  thisMap: Map<string, number>,
  lastMap: Map<string, number>,
  totalThis: number,
  labelOf?: (key: string) => string,
): DeepRow[] {
  const keys = new Set<string>([...thisMap.keys(), ...lastMap.keys()]);
  const rows: DeepRow[] = [];
  for (const k of keys) {
    const thisFy = thisMap.get(k) ?? 0;
    const lastFy = lastMap.get(k) ?? 0;
    if (thisFy === 0 && lastFy === 0) continue;
    rows.push({
      label: labelOf ? labelOf(k) : k,
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

async function segmentToGroup(perSegment: Map<string, number>): Promise<Map<string, number>> {
  const index = await loadGroupIndex();
  const out = new Map<string, number>();
  for (const [seg, v] of perSegment) {
    const group = canonicalGroup(index, seg) ?? "Unmapped";
    out.set(group, (out.get(group) ?? 0) + v);
  }
  return out;
}

export type DeepDive = {
  fy: string;
  priorFy: string;
  repKey: string;
  repName: string;
  scope: "own" | "team";
  hasTeam: boolean;
  available: boolean;
  reason?: string;
  tiles: {
    netOrderBooked: number;
    netOrderBookedLast: number;
    growthPct: number | null;
    orders: number;
    activeRetailers: number;
    newRetailers: number;
    avgOrderValue: number | null;
    businessPerRetailer: number | null;
    target: number | null;
    achievementPct: number | null;
  };
  byState: DeepRow[];
  byGroup: DeepRow[];
  bySegment: DeepRow[];
  parties: {
    top: DeepRow[];
    bottom: DeepRow[];
    newTop: DeepRow[];
    churned: DeepRow[];
    newCount: number;
    oldCount: number;
    churnedCount: number;
  };
  movers: {
    partiesUp: DeepRow[];
    partiesDown: DeepRow[];
    segmentsUp: DeepRow[];
    segmentsDown: DeepRow[];
  };
};

function topMovers(rows: DeepRow[], up: boolean, n: number): DeepRow[] {
  const filtered = rows.filter((r) => (up ? r.diff > 0 : r.diff < 0));
  filtered.sort((a, b) => (up ? b.diff - a.diff : a.diff - b.diff));
  return filtered.slice(0, n);
}

export async function buildDeepDive(
  fy: string,
  repKey: string,
  scope: "own" | "team",
): Promise<DeepDive> {
  const prior = priorFy(fy);
  const [roster, thisAgg, lastAgg] = await Promise.all([
    loadRoster(),
    loadOrderFile(fy),
    loadOrderFile(prior),
  ]);
  const h = buildHierarchy(roster);
  const repName = h.nameOf.get(repKey) ?? repKey;
  const hasTeam = (h.childrenOf.get(repKey) ?? []).length > 0;
  const effectiveScope: "own" | "team" = scope === "team" && hasTeam ? "team" : "own";
  const keys =
    effectiveScope === "team" ? descendantMemberKeys(h, repKey) : [repKey];

  const empty = (): DeepDive => ({
    fy,
    priorFy: prior,
    repKey,
    repName,
    scope: effectiveScope,
    hasTeam,
    available: false,
    reason:
      getOrderLoadStatus(fy)?.detail ??
      `No secondary order booking data is available for ${fy} yet. Per-rep numbers appear once that file exists.`,
    tiles: {
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
    },
    byState: [],
    byGroup: [],
    bySegment: [],
    parties: { top: [], bottom: [], newTop: [], churned: [], newCount: 0, oldCount: 0, churnedCount: 0 },
    movers: { partiesUp: [], partiesDown: [], segmentsUp: [], segmentsDown: [] },
  });

  if (!thisAgg) return empty();

  const cur = aggregateKeys(thisAgg, keys, h.stateOf);
  const prev = aggregateKeys(lastAgg, keys, h.stateOf);

  // New / old / churned retailers, keyed on the global first-order date.
  const firstSeen = await loadRetailerFirstSeen(fy);
  const bounds = fyBoundsSerial(fy);
  const isNew = (rid: string): boolean => {
    const s = firstSeen.get(rid);
    return s != null && s >= bounds.start && s <= bounds.end;
  };
  let newCount = 0;
  let oldCount = 0;
  for (const rid of cur.retailers.keys()) {
    if (isNew(rid)) newCount++;
    else oldCount++;
  }

  const totalThis = cur.net;

  // By State / Group / Segment tables.
  const byState = comparisonRows(cur.byState, prev.byState, totalThis);
  const [thisGroups, lastGroups] = await Promise.all([
    segmentToGroup(cur.perSegment),
    segmentToGroup(prev.perSegment),
  ]);
  const byGroup = comparisonRows(thisGroups, lastGroups, totalThis);
  const bySegment = comparisonRows(cur.perSegment, prev.perSegment, totalThis);

  // By Party: keyed on retailer id, labelled with the retailer name.
  const nameOfRid = new Map<string, string>();
  for (const [rid, rs] of cur.retailers) nameOfRid.set(rid, rs.name || rid);
  for (const [rid, rs] of prev.retailers) if (!nameOfRid.has(rid)) nameOfRid.set(rid, rs.name || rid);
  const thisParty = new Map<string, number>();
  for (const [rid, rs] of cur.retailers) thisParty.set(rid, rs.amount);
  const lastParty = new Map<string, number>();
  for (const [rid, rs] of prev.retailers) lastParty.set(rid, rs.amount);
  // Flags (new/old/churned) are keyed per retailer id, so build the party rows
  // directly from the ids rather than round-tripping through display labels.
  const flagged: DeepRow[] = [];
  {
    const keysAll = new Set<string>([...thisParty.keys(), ...lastParty.keys()]);
    for (const rid of keysAll) {
      const thisFy = thisParty.get(rid) ?? 0;
      const lastFy = lastParty.get(rid) ?? 0;
      if (thisFy === 0 && lastFy === 0) continue;
      const flag: DeepRow["flag"] =
        thisFy === 0 ? "churned" : isNew(rid) ? "new" : "old";
      flagged.push({
        label: nameOfRid.get(rid) ?? rid,
        thisFy,
        lastFy,
        diff: thisFy - lastFy,
        growthPct: growth(thisFy, lastFy),
        sharePct: share(thisFy, totalThis),
        flag,
      });
    }
  }
  const activeRows = flagged.filter((r) => r.thisFy > 0);
  activeRows.sort((a, b) => b.thisFy - a.thisFy);
  // Bottom = the smallest active accounts (weakest current books), smallest first.
  const bottomRows = [...activeRows].reverse().slice(0, 10);
  const churnedRows = flagged.filter((r) => r.flag === "churned");
  churnedRows.sort((a, b) => b.lastFy - a.lastFy);
  const newTop = activeRows.filter((r) => r.flag === "new").slice(0, 10);

  // Movers over parties (active this or last) and segments.
  const partiesUp = topMovers(flagged, true, 5);
  const partiesDown = topMovers(flagged, false, 5);
  const segmentsUp = topMovers(bySegment, true, 5);
  const segmentsDown = topMovers(bySegment, false, 5);

  // Target + achievement from the Target Master (secondary order booking target).
  // FY26-27 shape: annual is null; quarterly targets live in monthly cells
  // (Apr/May/Jun).  Use Σ(non-null monthly values) when any monthly target is
  // present; fall back to the annual figure only when no monthly values exist.
  const targets = await loadTargetsForFy(fy);
  let target: number | null = null;
  for (const k of keys) {
    const row = targets.get(k);
    if (!row) continue;
    const hasMonthly = row.monthly.secondary.some((v) => v != null);
    const effectiveTgt = hasMonthly
      ? row.monthly.secondary.reduce<number>((a, v) => a + (v ?? 0), 0)
      : (row.annual.secondary ?? null);
    if (effectiveTgt != null) target = (target ?? 0) + effectiveTgt;
  }
  const netOrderBooked = cur.net;
  const orders = cur.orderIds.size;
  const activeRetailers = cur.retailers.size;

  return {
    fy,
    priorFy: prior,
    repKey,
    repName,
    scope: effectiveScope,
    hasTeam,
    available: true,
    tiles: {
      netOrderBooked,
      netOrderBookedLast: prev.net,
      growthPct: growth(netOrderBooked, prev.net),
      orders,
      activeRetailers,
      newRetailers: newCount,
      avgOrderValue: orders > 0 ? Math.round(netOrderBooked / orders) : null,
      businessPerRetailer:
        activeRetailers > 0 ? Math.round(netOrderBooked / activeRetailers) : null,
      target,
      achievementPct: target && target > 0 ? round1((netOrderBooked / target) * 100) : null,
    },
    byState,
    byGroup,
    bySegment,
    parties: {
      top: activeRows.slice(0, 10),
      bottom: bottomRows,
      newTop,
      churned: churnedRows.slice(0, 10),
      newCount,
      oldCount,
      churnedCount: churnedRows.length,
    },
    movers: { partiesUp, partiesDown, segmentsUp, segmentsDown },
  };
}

// -------------------------------------------------------------------------
// Verify / data health
// -------------------------------------------------------------------------

export type SalesVerifyHead = {
  name: string;
  repCount: number;
  repSaleTotal: number;
  nodeTeamNet: number;
  anchor: number | null;
  deltaPct: number | null;
  status: "pass" | "warn" | "fail";
  withinCrossFoot: boolean;
};

export type SalesVerify = {
  fy: string;
  available: boolean;
  reason?: string;
  rosterSource: Roster["source"];
  multiLevel: boolean;
  overall: "pass" | "warn" | "fail";
  companyTotal: number;
  attributedTotal: number;
  coveragePct: number | null;
  heads: SalesVerifyHead[];
  nameMatch: {
    rosterCount: number;
    fileNameCount: number;
    matchedCount: number;
    matchPct: number | null;
    unmatchedFileNames: string[];
    unmatchedRosterNames: string[];
  };
};

function moneyStatus(actual: number, expected: number, passPct = 1): "pass" | "warn" | "fail" {
  if (expected === 0) return actual === 0 ? "pass" : "warn";
  const pct = Math.abs((actual - expected) / expected) * 100;
  if (pct <= passPct) return "pass";
  if (pct <= passPct * 2) return "warn";
  return "fail";
}

export async function runSalesVerify(fy: string): Promise<SalesVerify> {
  const [roster, agg] = await Promise.all([loadRoster(), loadOrderFile(fy)]);
  if (!agg) {
    return {
      fy,
      available: false,
      reason:
        getOrderLoadStatus(fy)?.detail ??
        `The secondary order booking file for ${fy} could not be read, so there is nothing to verify.`,
      rosterSource: roster.source,
      multiLevel: false,
      overall: "fail",
      companyTotal: 0,
      attributedTotal: 0,
      coveragePct: null,
      heads: [],
      nameMatch: {
        rosterCount: roster.members.length,
        fileNameCount: 0,
        matchedCount: 0,
        matchPct: null,
        unmatchedFileNames: [],
        unmatchedRosterNames: [],
      },
    };
  }
  const h = buildHierarchy(roster);
  const seen = new Set<string>();
  const nodes = h.roots.map((r) => buildNode(h, agg, r, seen));
  const anchor = anchors.fy_anchors[fy];

  const rootNames = nodes.map((n) => n.name);
  const resolveHead = buildHeadResolver(rootNames);
  const nodeByName = new Map<string, RepNode>();
  for (const n of nodes) nodeByName.set(n.name, n);

  const heads: SalesVerifyHead[] = [];
  const usedAnchor = new Set<string>();
  for (const n of nodes) {
    // Cross-foot: Σ member nets under the head vs the tree's rolled-up team net.
    const memberNet = descendantMemberKeys(h, n.key).reduce(
      (a, k) => a + (agg.perTm.get(k)?.saleAmount ?? 0),
      0,
    );
    let anchorVal: number | null = null;
    if (anchor?.perHeadSale) {
      for (const [an, av] of Object.entries(anchor.perHeadSale)) {
        if ((resolveHead(an) ?? an) === n.name) {
          anchorVal = av;
          usedAnchor.add(an);
          break;
        }
      }
    }
    heads.push({
      name: n.name,
      repCount: descendantMemberKeys(h, n.key).length,
      repSaleTotal: memberNet,
      nodeTeamNet: n.teamNet,
      anchor: anchorVal,
      deltaPct: anchorVal ? round1(((memberNet - anchorVal) / anchorVal) * 100) : null,
      status: anchorVal != null ? moneyStatus(memberNet, anchorVal) : "pass",
      withinCrossFoot: Math.abs(memberNet - n.teamNet) <= 1,
    });
  }
  heads.sort((a, b) => b.repSaleTotal - a.repSaleTotal);

  // Name-match coverage between the file and the roster.
  const rosterKeys = h.memberKeys;
  const fileNames = [...agg.perTm.keys()];
  let matched = 0;
  const unmatchedFileNames: string[] = [];
  for (const k of fileNames) {
    if (rosterKeys.has(k)) matched++;
    else unmatchedFileNames.push(agg.perTm.get(k)?.displayName ?? k);
  }
  const unmatchedRosterNames: string[] = [];
  for (const k of rosterKeys) {
    if (!agg.perTm.has(k)) unmatchedRosterNames.push(h.nameOf.get(k) ?? k);
  }
  const attributedTotal = [...rosterKeys].reduce(
    (a, k) => a + (agg.perTm.get(k)?.saleAmount ?? 0),
    0,
  );
  const companyTotal = agg.totalSaleAmount;

  const anchorStatuses = heads.map((x) => x.status);
  const crossFootOk = heads.every((x) => x.withinCrossFoot);
  const overall: SalesVerify["overall"] = anchorStatuses.includes("fail") || !crossFootOk
    ? "fail"
    : anchorStatuses.includes("warn")
      ? "warn"
      : "pass";

  return {
    fy,
    available: true,
    rosterSource: roster.source,
    multiLevel: h.multiLevel,
    overall,
    companyTotal,
    attributedTotal,
    coveragePct: companyTotal > 0 ? round1((attributedTotal / companyTotal) * 100) : null,
    heads,
    nameMatch: {
      rosterCount: roster.members.length,
      fileNameCount: fileNames.length,
      matchedCount: matched,
      matchPct: fileNames.length > 0 ? round1((matched / fileNames.length) * 100) : null,
      unmatchedFileNames: unmatchedFileNames.slice(0, 50),
      unmatchedRosterNames: unmatchedRosterNames.slice(0, 50),
    },
  };
}

// Resolve a display/normalised name to a rep key present in the tree, for the
// analyze endpoint. Returns null when no roster member matches.
export async function resolveRepKey(raw: string): Promise<{ key: string; name: string } | null> {
  const roster = await loadRoster();
  const h = buildHierarchy(roster);
  const key = normName(raw);
  if (h.nameOf.has(key)) return { key, name: h.nameOf.get(key) ?? key };
  // substring fallback across member/head names
  for (const [k, name] of h.nameOf) {
    if (k.includes(key) || key.includes(k)) return { key: k, name };
  }
  return null;
}
