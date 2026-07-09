// Assembles the STATE HEAD DASHBOARD workbook (Management Reports).
//
// Layer 1: the full template is reproduced tab-for-tab. Columns whose source
// is connected (roster, secondary order booking) carry real values; columns
// whose source is not yet in Drive (targets, SFA visits, GPS, payroll,
// expenses, retailer-to-TM sale bridge) are left BLANK with a light grey fill
// and listed in the "Missing Data" tab. Never 0 for an unknown.
import ExcelJS from "exceljs";
import regionMapJson from "../../../config/region_map.json";
import { loadRoster, type RosterMember } from "./roster.js";
import {
  loadOrderFile,
  loadRetailerFirstSeen,
  getOrderLoadStatus,
  type OrderFileAgg,
  type OrderLoadStatus,
} from "./orders.js";
import { loadGroupIndex, canonicalGroup } from "./groups.js";
import {
  loadStateHeadRegisters,
  type StateHeadRegisters,
  type RegisterLoadStatus,
  type FyRegisterAgg,
} from "./stateHeadRegisters.js";
import { loadPartyBridge, lookupParty, type PartyBridge } from "./bridge.js";
import {
  fyBoundsSerial,
  fyShort,
  priorFy,
  fyStartYear,
  serialToDate,
  normState,
  normName,
  buildHeadResolver,
} from "./names.js";
import {
  loadTargetsForFy,
  type TargetRow,
  type TargetField,
} from "./targets.js";
import { logger } from "../logger.js";

export type ReportFilters = {
  fy: string;
  states: string[];
  regions: string[];
  monthFrom: number; // fiscal month 1..12 (Apr=1)
  monthTo: number;
  lowPerfPct: number;
};

export type RegionMap = Record<string, string[]>;

// Statically imported so esbuild bundles it — a cwd-relative read breaks in
// production, where the server does not run from the artifact directory.
export function regionMap(): RegionMap {
  return (regionMapJson as { regions: RegionMap }).regions;
}

// Missing-source registry. Keys tag columns; the Missing Data tab explains.
const MISSING_SOURCES: Record<string, string> = {
  target:
    "Target Master (primary/secondary/monthly targets and business plans live in scattered per-head plan sheets; needs one consolidated sheet)",
  sfa: "SFA field app export (visits, visited parties, lead counters, working days)",
  gps: "SFA field app export (GPS kilometres / distance)",
  payroll: "Payroll / CTC master (the HR roster has no CTC column)",
  expense: "Finance T.A. bill / expense export per team member per month",
  salebridge:
    "Party-to-team-member bridge for dispatched sale (the State-Head registers tag each row to State Head + Customer(party), not to a team member)",
  orders:
    "Secondary Order Booking Segment Wise workbook for the selected year (not found in the Drive folder yet)",
};

type OrderStats = {
  amount: number;
  monthAmount: number[];
  monthOrders: number[];
  orderCount: number;
  totalRetailers: number;
  oldRetailers: number;
  newRetailers: number;
  oldPartyAmount: number;
  newPartyAmount: number;
  oldPartiesWithBusiness: number;
  newPartiesWithBusiness: number;
  partiesWithBusiness: number;
  directAmount: number;
  directParties: number;
  distributorCount: number;
  directDealerCount: number;
  newPartyOrders: number;
  businessPerRetailer: number | null;
};

// Dispatched sale split down to member grain via the Party -> Team Member
// bridge. Present only when the bridge sheet exists AND the State-Head
// registers loaded; otherwise Sale renders at State-Head grain (Missing Data
// tab) and per-member Sale cells stay blank — never a guessed allocation.
export type MemberSale = {
  amount: number;
  priorAmount: number | null;
  monthAmount: number[];
  monthInvoices: number[];
};

export type MemberRow = {
  m: RosterMember;
  orders: OrderStats | null;
  priorAmount: number | null;
  oldNew: string;
  target: TargetRow | null;
  sale: MemberSale | null;
};

// Effective monthly target: explicit override, else an equal twelfth of the
// annual figure. Null when neither exists — blank must never read as zero.
function tgtMonthly(t: TargetRow, f: TargetField, monthIdx: number): number | null {
  const override = t.monthly[f][monthIdx];
  if (override != null) return override;
  const annual = t.annual[f];
  return annual == null ? null : annual / 12;
}

function tgtRange(
  r: MemberRow,
  f: TargetField,
  monthFrom: number,
  monthTo: number,
): number | null {
  if (!r.target) return null;
  let sum = 0;
  let any = false;
  for (let i = monthFrom - 1; i <= monthTo - 1; i++) {
    const v = tgtMonthly(r.target, f, i);
    if (v != null) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

function tgtAnnual(r: MemberRow, f: TargetField): number | null {
  return r.target ? r.target.annual[f] : null;
}

// Achievement ratio as a fraction (pct cells use a percent number format).
function achievement(num: number | null | undefined, den: number | null): number | null {
  if (num == null || den == null || den <= 0) return null;
  return num / den;
}

function computeOrderStats(
  member: RosterMember,
  fy: string,
  agg: OrderFileAgg,
  priorAgg: OrderFileAgg | null,
  firstSeen: Map<string, number>,
  monthFrom: number,
  monthTo: number,
): OrderStats | null {
  const tm = agg.perTm.get(member.normKey);
  const fyStart = fyBoundsSerial(fy).start;
  // Retailer census: retailers ordering this FY plus retailers attributed to
  // this member in the prior FY file (they exist even if silent this year).
  const census = new Set<string>();
  if (tm) for (const id of tm.retailers.keys()) census.add(id);
  const prevTm = priorAgg?.perTm.get(member.normKey);
  if (prevTm) for (const id of prevTm.retailers.keys()) census.add(id);
  if (!tm && census.size === 0) {
    return {
      amount: 0,
      monthAmount: new Array(12).fill(0) as number[],
      monthOrders: new Array(12).fill(0) as number[],
      orderCount: 0,
      totalRetailers: 0,
      oldRetailers: 0,
      newRetailers: 0,
      oldPartyAmount: 0,
      newPartyAmount: 0,
      oldPartiesWithBusiness: 0,
      newPartiesWithBusiness: 0,
      partiesWithBusiness: 0,
      directAmount: 0,
      directParties: 0,
      distributorCount: 0,
      directDealerCount: 0,
      newPartyOrders: 0,
      businessPerRetailer: null,
    };
  }
  let oldRetailers = 0;
  let newRetailers = 0;
  for (const id of census) {
    const first = firstSeen.get(id);
    if (first !== undefined && first >= fyStart) newRetailers++;
    else oldRetailers++;
  }
  let oldPartyAmount = 0;
  let newPartyAmount = 0;
  let oldWith = 0;
  let newWith = 0;
  let newPartyOrders = 0;
  if (tm) {
    for (const [id, rs] of tm.retailers) {
      const first = firstSeen.get(id);
      const isNew = first !== undefined && first >= fyStart;
      if (isNew) {
        newPartyAmount += rs.amount;
        newWith++;
        newPartyOrders += rs.orderIds.size;
      } else {
        oldPartyAmount += rs.amount;
        oldWith++;
      }
    }
  }
  const monthAmount = new Array(12).fill(0) as number[];
  const monthOrders = new Array(12).fill(0) as number[];
  let amount = 0;
  let orderCount = 0;
  if (tm) {
    for (let i = 0; i < 12; i++) {
      if (i + 1 < monthFrom || i + 1 > monthTo) continue;
      monthAmount[i] = tm.monthAmount[i];
      monthOrders[i] = tm.monthOrderIds[i].size;
      amount += tm.monthAmount[i];
      orderCount += tm.monthOrderIds[i].size;
    }
  }
  const partiesWithBusiness = oldWith + newWith;
  return {
    amount,
    monthAmount,
    monthOrders,
    orderCount,
    totalRetailers: oldRetailers + newRetailers,
    oldRetailers,
    newRetailers,
    oldPartyAmount,
    newPartyAmount,
    oldPartiesWithBusiness: oldWith,
    newPartiesWithBusiness: newWith,
    partiesWithBusiness,
    directAmount: tm?.directAmount ?? 0,
    directParties: tm?.directRetailers.size ?? 0,
    distributorCount: tm?.distributors.size ?? 0,
    directDealerCount: tm?.directRetailers.size ?? 0,
    newPartyOrders,
    businessPerRetailer:
      partiesWithBusiness > 0 ? amount / partiesWithBusiness : null,
  };
}

export function expandScope(filters: ReportFilters): Set<string> | null {
  const rm = regionMap();
  const picked = new Set<string>();
  for (const region of filters.regions) {
    for (const s of rm[region] ?? []) picked.add(normState(s));
  }
  for (const s of filters.states) picked.add(normState(s));
  return picked.size > 0 ? picked : null;
}

// Order-booking <-> roster name-match diagnostics for one FY file. Unmatched
// names are listed on the Missing Data tab, never dropped silently.
export type NameMatchInfo = {
  fy: string;
  fileNames: number;
  matched: number;
  matchRate: number; // matched / fileNames, 0..1
  unmatchedFromFile: string[]; // order-booking names with no roster match
  unmatchedFromRoster: string[]; // roster names with no rows in the file
};

// Raw segments whose INDEX-map lookup failed, with the amount at stake.
export type UnmappedSegment = { segment: string; amount: number };

export type SegmentCheck = {
  fy: string;
  segments: number;
  unmapped: UnmappedSegment[];
  indexError: string | null;
};

// Head-grain dispatched-sale summary for the Missing Data tab (used while
// the Party -> Team Member bridge does not exist).
export type HeadSaleSummary = {
  head: string;
  fyAmount: number | null;
  fyInvoices: number;
  fyParties: number;
  priorAmount: number | null;
  priorInvoices: number;
  priorParties: number;
};

// Per-head cross-foot when the bridge splits Sale to member grain:
// Σ(members' sale) + the head's Unassigned bucket must reproduce the head's
// register total within ₹1.
export type SaleCrossFoot = {
  head: string;
  headTotal: number;
  memberSum: number;
  unbridgedParties: number;
  unbridgedAmount: number;
};

// Bridge join diagnostics for the Missing Data tab: how much register revenue
// matched a team member, plus what fell into the Unassigned buckets.
export type UnassignedParty = { party: string; amount: number };
export type SaleMatchInfo = {
  fy: string;
  totalAmount: number;
  matchedAmount: number;
  matchedPct: number; // 0..1
  unassigned: Array<{
    head: string;
    amount: number;
    parties: number;
    topParties: UnassignedParty[];
  }>;
  bridgeMembersNotInRoster: string[];
};

// Display name for a bridge member key (falls back to the key itself).
function bridgeMemberName(bridge: PartyBridge, memberKey: string): string {
  for (const row of bridge.rows) {
    if (row.memberKey === memberKey) return row.memberName;
  }
  return memberKey;
}

// State head recorded in the bridge for a member key, if any.
function bridgeMemberHead(bridge: PartyBridge, memberKey: string): string {
  for (const row of bridge.rows) {
    if (row.memberKey === memberKey && row.stateHead) return row.stateHead;
  }
  return "";
}

// A synthetic roster spine for report rows that carry real register revenue
// but have no roster member: Unassigned buckets and bridge members missing
// from the roster. Every non-sale column stays blank on these rows.
function syntheticMember(name: string, stateHead: string): RosterMember {
  return {
    stateHead,
    state: "",
    name,
    normKey: normName(name),
    workingState: "",
    headquarter: "",
    dojSerial: null,
    contactNumber: "",
    weekOff: "",
    marketHours: "",
    monthlyCtc: null,
    leftDateSerial: null,
    activeLeft: "",
    channel: "",
  };
}

export async function assembleRows(
  filters: ReportFilters,
): Promise<{
  rows: MemberRow[];
  rosterSource: string;
  ordersAvailable: boolean;
  priorAvailable: boolean;
  targetsAvailable: boolean;
  orderStatus: OrderLoadStatus | null;
  priorStatus: OrderLoadStatus | null;
  nameMatches: NameMatchInfo[];
  segmentCheck: SegmentCheck | null;
  saleAvailable: boolean;
  bridge: PartyBridge;
  registers: StateHeadRegisters;
  headSales: HeadSaleSummary[];
  registerStatuses: RegisterLoadStatus[];
  registerGroupCheck: SegmentCheck | null;
  saleCrossFoot: SaleCrossFoot[];
  saleMatch: SaleMatchInfo | null;
}> {
  const roster = await loadRoster();
  const scope = expandScope(filters);
  const members = roster.members.filter(
    (m) => !scope || scope.has(normState(m.state)),
  );
  const [agg, prior, registers, bridge] = await Promise.all([
    loadOrderFile(filters.fy),
    loadOrderFile(priorFy(filters.fy)),
    loadStateHeadRegisters(),
    loadPartyBridge(),
  ]);
  const orderStatus = getOrderLoadStatus(filters.fy) ?? null;
  const priorStatus = getOrderLoadStatus(priorFy(filters.fy)) ?? null;
  const firstSeen = agg
    ? await loadRetailerFirstSeen(filters.fy)
    : new Map<string, number>();
  // Targets come from the writable Target Master sheet. A read failure only
  // downgrades the target columns to "missing" — it never blocks the report.
  let targetMap = new Map<string, TargetRow>();
  try {
    targetMap = await loadTargetsForFy(filters.fy);
  } catch (err) {
    logger.warn(
      { err, fy: filters.fy },
      "target master read failed; target columns left blank",
    );
  }
  // --- Dispatched sale (State-Head registers), split to member grain only
  // when the Party -> Team Member bridge exists. Without it, per-member Sale
  // stays blank and the head-grain totals go to the Missing Data tab.
  const pFy = priorFy(filters.fy);
  const saleAvailable = bridge.status === "ok" && registers.byHead.size > 0;
  const memberSales = new Map<string, MemberSale>();
  const saleCrossFoot: SaleCrossFoot[] = [];
  let saleMatch: SaleMatchInfo | null = null;
  // Register head spellings ("ANANT SINGH JI") and bridge head spellings
  // resolve to the roster's State Head display so Unassigned buckets and
  // synthetic rows group with the right head.
  const resolveHead = buildHeadResolver(
    roster.members.map((m) => m.stateHead).filter(Boolean),
  );
  // Per-head Unassigned bucket: revenue whose party has no bridge match.
  // It is never dropped — it becomes an "Unassigned (<Head>)" report row.
  type UnassignedBucket = {
    head: string;
    sale: MemberSale;
    parties: Map<string, number>;
  };
  const unassignedByHead = new Map<string, UnassignedBucket>();
  if (saleAvailable) {
    const memberSaleFor = (key: string): MemberSale => {
      let ms = memberSales.get(key);
      if (!ms) {
        ms = {
          amount: 0,
          priorAmount: null,
          monthAmount: new Array(12).fill(0) as number[],
          monthInvoices: new Array(12).fill(0) as number[],
        };
        memberSales.set(key, ms);
      }
      return ms;
    };
    const bucketFor = (headDisplay: string): UnassignedBucket => {
      let b = unassignedByHead.get(headDisplay);
      if (!b) {
        b = {
          head: headDisplay,
          sale: {
            amount: 0,
            priorAmount: null,
            monthAmount: new Array(12).fill(0) as number[],
            monthInvoices: new Array(12).fill(0) as number[],
          },
          parties: new Map(),
        };
        unassignedByHead.set(headDisplay, b);
      }
      return b;
    };
    let matchedAmount = 0;
    let totalAmount = 0;
    for (const head of registers.byHead.values()) {
      const fyAgg = head.byFy.get(filters.fy);
      const priorAgg = head.byFy.get(pFy);
      const headDisplay = resolveHead(head.headDisplay) ?? head.headDisplay;
      let memberSum = 0;
      let unbridgedParties = 0;
      let unbridgedAmount = 0;
      if (fyAgg) {
        for (const [party, pa] of fyAgg.parties) {
          totalAmount += pa.amount;
          const entry = lookupParty(bridge, party);
          if (!entry) {
            unbridgedParties++;
            unbridgedAmount += pa.amount;
            const b = bucketFor(headDisplay);
            b.sale.amount += pa.amount;
            b.parties.set(party, (b.parties.get(party) ?? 0) + pa.amount);
            for (let i = 0; i < 12; i++) {
              b.sale.monthAmount[i] += pa.monthAmount[i];
              b.sale.monthInvoices[i] += pa.monthInvoiceIds[i].size;
            }
            continue;
          }
          matchedAmount += pa.amount;
          const ms = memberSaleFor(entry.memberKey);
          ms.amount += pa.amount;
          memberSum += pa.amount;
          for (let i = 0; i < 12; i++) {
            ms.monthAmount[i] += pa.monthAmount[i];
            ms.monthInvoices[i] += pa.monthInvoiceIds[i].size;
          }
        }
        saleCrossFoot.push({
          head: headDisplay,
          headTotal: fyAgg.amount,
          memberSum: memberSum + unbridgedAmount,
          unbridgedParties,
          unbridgedAmount,
        });
      }
      if (priorAgg) {
        for (const [party, pa] of priorAgg.parties) {
          const entry = lookupParty(bridge, party);
          if (!entry) {
            const b = bucketFor(headDisplay);
            b.sale.priorAmount = (b.sale.priorAmount ?? 0) + pa.amount;
            continue;
          }
          const ms = memberSaleFor(entry.memberKey);
          ms.priorAmount = (ms.priorAmount ?? 0) + pa.amount;
        }
      }
    }
    // Cross-foot: member split + Unassigned bucket must reproduce the head
    // register total within ₹1. Unmatched parties are informational (they
    // live in the bucket), so only a genuine sum mismatch warns.
    for (const cf of saleCrossFoot) {
      const diff = Math.abs(cf.headTotal - cf.memberSum);
      if (diff > 1) {
        logger.warn(
          { ...cf, diff: Math.round(diff) },
          "dispatched-sale cross-foot: member split + Unassigned bucket does not reproduce the head register total",
        );
      } else {
        logger.info(
          {
            head: cf.head,
            headTotal: Math.round(cf.headTotal),
            unbridgedParties: cf.unbridgedParties,
            unbridgedAmount: Math.round(cf.unbridgedAmount),
          },
          "dispatched-sale cross-foot ok (members + Unassigned reproduce the head register total)",
        );
      }
    }
    // Bridge members with revenue but no roster row (logged + Missing Data;
    // their revenue gets a synthetic row below, never dropped).
    const rosterKeysAll = new Set(roster.members.map((m) => m.normKey));
    const bridgeMembersNotInRoster = [
      ...new Set(
        [...memberSales.keys()]
          .filter((k) => !rosterKeysAll.has(k))
          .map((k) => bridgeMemberName(bridge, k)),
      ),
    ].sort();
    const matchedPct = totalAmount > 0 ? matchedAmount / totalAmount : 1;
    saleMatch = {
      fy: filters.fy,
      totalAmount,
      matchedAmount,
      matchedPct,
      unassigned: [...unassignedByHead.values()]
        .map((b) => ({
          head: b.head,
          amount: b.sale.amount,
          parties: b.parties.size,
          topParties: [...b.parties.entries()]
            .map(([party, amount]) => ({ party, amount }))
            .sort((a, b2) => b2.amount - a.amount)
            .slice(0, 15),
        }))
        .sort((a, b2) => b2.amount - a.amount),
      bridgeMembersNotInRoster,
    };
    const matchLog = {
      fy: filters.fy,
      totalAmount: Math.round(totalAmount),
      matchedAmount: Math.round(matchedAmount),
      matchedPct: Math.round(matchedPct * 1000) / 10,
      unassignedHeads: unassignedByHead.size,
      bridgeMembersNotInRoster,
    };
    if (matchedPct < 0.9) {
      logger.warn(
        matchLog,
        "party-tm bridge matched-revenue below the 90% target — extend the bridge sheet or the name normaliser",
      );
    } else {
      logger.info(matchLog, "party-tm bridge matched-revenue");
    }
  }
  // Head-grain summary for the Missing Data tab (always computed so the
  // register numbers are visible even without a bridge).
  const headSales: HeadSaleSummary[] = [...registers.byHead.values()]
    .map((head) => {
      const fyAgg = head.byFy.get(filters.fy) ?? null;
      const priorAgg = head.byFy.get(pFy) ?? null;
      return {
        head: head.headDisplay,
        fyAmount: fyAgg ? fyAgg.amount : null,
        fyInvoices: fyAgg ? fyAgg.invoiceIds.size : 0,
        fyParties: fyAgg ? fyAgg.parties.size : 0,
        priorAmount: priorAgg ? priorAgg.amount : null,
        priorInvoices: priorAgg ? priorAgg.invoiceIds.size : 0,
        priorParties: priorAgg ? priorAgg.parties.size : 0,
      };
    })
    .sort((a, b) => (b.fyAmount ?? 0) - (a.fyAmount ?? 0));
  const registerTotal = headSales.reduce((a, h) => a + (h.fyAmount ?? 0), 0);
  if (registers.byHead.size > 0) {
    logger.info(
      {
        fy: filters.fy,
        heads: registers.byHead.size,
        registerTotal: Math.round(registerTotal),
        bridge: bridge.status,
      },
      "state-head register totals assembled for the report",
    );
  }
  const fyStart = fyBoundsSerial(filters.fy).start;
  const rows: MemberRow[] = members.map((m) => ({
    m,
    orders: agg
      ? computeOrderStats(
          m,
          filters.fy,
          agg,
          prior,
          firstSeen,
          filters.monthFrom,
          filters.monthTo,
        )
      : null,
    priorAmount: prior ? (prior.perTm.get(m.normKey)?.amount ?? 0) : null,
    oldNew: m.dojSerial != null && m.dojSerial >= fyStart ? "New" : "Old",
    target: targetMap.get(m.normKey) ?? null,
    sale: saleAvailable ? (memberSales.get(m.normKey) ?? null) : null,
  }));
  // Synthetic rows so register revenue is never dropped from a full report:
  // bridge members missing from the roster, and per-head Unassigned buckets.
  // Scoped (state/region-filtered) reports skip them — buckets are not
  // state-scoped, and the Missing Data tab covers them either way.
  if (saleAvailable && scope == null) {
    const rosterKeysAll = new Set(roster.members.map((m) => m.normKey));
    const synthRow = (m: RosterMember, sale: MemberSale): MemberRow => ({
      m,
      orders: null,
      priorAmount: null,
      oldNew: "",
      target: null,
      sale,
    });
    for (const [key, ms] of memberSales) {
      if (rosterKeysAll.has(key)) continue;
      const head = bridgeMemberHead(bridge, key);
      rows.push(
        synthRow(
          syntheticMember(
            bridgeMemberName(bridge, key),
            resolveHead(head) ?? head,
          ),
          ms,
        ),
      );
    }
    for (const b of unassignedByHead.values()) {
      rows.push(synthRow(syntheticMember(`Unassigned (${b.head})`, b.head), b.sale));
    }
  }
  // Name-match diagnostics against the FULL roster (not the filtered scope)
  // for every order file that feeds columns in this report.
  const rosterKeys = new Set(roster.members.map((m) => m.normKey));
  const nameMatches: NameMatchInfo[] = [];
  for (const fileAgg of [agg, prior]) {
    if (!fileAgg) continue;
    const unmatchedFromFile = [...fileAgg.perTm.entries()]
      .filter(([key]) => !rosterKeys.has(key))
      .map(([, v]) => v.displayName)
      .sort();
    const matched = fileAgg.perTm.size - unmatchedFromFile.length;
    const unmatchedFromRoster = roster.members
      .filter((m) => !fileAgg.perTm.has(m.normKey))
      .map((m) => m.name)
      .sort();
    const info: NameMatchInfo = {
      fy: fileAgg.fy,
      fileNames: fileAgg.perTm.size,
      matched,
      matchRate: fileAgg.perTm.size > 0 ? matched / fileAgg.perTm.size : 1,
      unmatchedFromFile,
      unmatchedFromRoster,
    };
    nameMatches.push(info);
    const logPayload = {
      fy: fileAgg.fy,
      fileNames: info.fileNames,
      matched,
      matchRatePct: Math.round(info.matchRate * 1000) / 10,
      unmatchedFromFile,
      rosterWithoutRows: unmatchedFromRoster.length,
    };
    // A prior-year file legitimately carries sellers who have since left, so
    // the <95% warning only applies to the report-FY file.
    if (info.matchRate < 0.95 && fileAgg.fy === filters.fy) {
      logger.warn(
        logPayload,
        "order booking team-member match rate below 95% — check the name normaliser",
      );
    } else {
      logger.info(logPayload, "order booking team-member name match");
    }
  }
  // Cross-foot: the sum of matched members' order booking vs the total read
  // from the file. Differences come from unmatched names or a month filter.
  if (agg) {
    let memberSum = 0;
    for (const r of rows) memberSum += r.orders?.amount ?? 0;
    logger.info(
      {
        fy: filters.fy,
        fileTotal: Math.round(agg.totalAmount),
        memberSum: Math.round(memberSum),
        scoped: scope != null,
        monthFrom: filters.monthFrom,
        monthTo: filters.monthTo,
      },
      "order booking cross-foot (file total vs member sum)",
    );
  }
  // Segment split reconciliation through the INDEX map for the file that
  // feeds this report's order columns (report FY, else prior FY).
  const segSource = agg ?? prior;
  let segmentCheck: SegmentCheck | null = null;
  if (segSource) {
    try {
      const index = await loadGroupIndex();
      const unmapped: UnmappedSegment[] = [];
      for (const [segment, amount] of segSource.segmentTotals) {
        if (canonicalGroup(index, segment) == null) {
          unmapped.push({ segment, amount: Math.round(amount) });
        }
      }
      unmapped.sort((a, b) => b.amount - a.amount);
      segmentCheck = {
        fy: segSource.fy,
        segments: segSource.segmentTotals.size,
        unmapped,
        indexError: null,
      };
      if (unmapped.length > 0) {
        logger.warn(
          { fy: segSource.fy, unmapped },
          "order booking segments missing from the INDEX map",
        );
      } else {
        logger.info(
          { fy: segSource.fy, segments: segSource.segmentTotals.size },
          "all order booking segments mapped through the INDEX map",
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      segmentCheck = {
        fy: segSource.fy,
        segments: segSource.segmentTotals.size,
        unmapped: [],
        indexError: detail,
      };
      logger.warn(
        { err, fy: segSource.fy },
        "INDEX map read failed; segment mapping not verified",
      );
    }
  }
  // Register Group column reconciliation through the same INDEX map that
  // governs order-booking segments — unmapped groups surface, never vanish.
  let registerGroupCheck: SegmentCheck | null = null;
  if (registers.byHead.size > 0) {
    const groupTotals = new Map<string, number>();
    for (const head of registers.byHead.values()) {
      const fyAgg: FyRegisterAgg | undefined = head.byFy.get(filters.fy);
      if (!fyAgg) continue;
      for (const [g, a] of fyAgg.groupAmount) {
        groupTotals.set(g, (groupTotals.get(g) ?? 0) + a);
      }
    }
    if (groupTotals.size > 0) {
      try {
        const index = await loadGroupIndex();
        const unmapped: UnmappedSegment[] = [];
        for (const [segment, amount] of groupTotals) {
          if (canonicalGroup(index, segment) == null) {
            unmapped.push({ segment, amount: Math.round(amount) });
          }
        }
        unmapped.sort((a, b) => b.amount - a.amount);
        registerGroupCheck = {
          fy: filters.fy,
          segments: groupTotals.size,
          unmapped,
          indexError: null,
        };
        if (unmapped.length > 0) {
          logger.warn(
            { fy: filters.fy, unmapped },
            "state-head register groups missing from the INDEX map",
          );
        } else {
          logger.info(
            { fy: filters.fy, groups: groupTotals.size },
            "all state-head register groups mapped through the INDEX map",
          );
        }
      } catch (err) {
        registerGroupCheck = {
          fy: filters.fy,
          segments: groupTotals.size,
          unmapped: [],
          indexError: err instanceof Error ? err.message : String(err),
        };
        logger.warn(
          { err, fy: filters.fy },
          "INDEX map read failed; register group mapping not verified",
        );
      }
    }
  }
  return {
    rows,
    rosterSource: roster.source,
    ordersAvailable: agg != null,
    priorAvailable: prior != null,
    targetsAvailable: targetMap.size > 0,
    orderStatus,
    priorStatus,
    nameMatches,
    segmentCheck,
    saleAvailable,
    bridge,
    registers,
    headSales,
    registerStatuses: registers.statuses,
    registerGroupCheck,
    saleCrossFoot,
    saleMatch,
  };
}

// ---------------------------------------------------------------------------
// Workbook building
// ---------------------------------------------------------------------------

const GREY_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFE7E6E6" },
};
const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD9E1F2" },
};
const TOTAL_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFCE4D6" },
};
const FMT_INT = "#,##0";
const FMT_DATE = "dd-mm-yyyy";

type ColKind = "text" | "int" | "money" | "date" | "pct";

type ColSpec = {
  header: string;
  kind: ColKind;
  // Present when the column is fed by a connected source.
  get?: (r: MemberRow) => unknown;
  // Present when the column's source is missing (key into MISSING_SOURCES).
  missing?: string;
  // Sum this column into the TOTAL row.
  total?: boolean;
  width?: number;
};

function dateVal(serial: number | null): Date | null {
  return serial == null ? null : serialToDate(serial);
}

function ord(
  r: MemberRow,
  pick: (o: OrderStats) => unknown,
): unknown {
  return r.orders == null ? null : pick(r.orders);
}

function summaryCols(
  filters: ReportFilters,
  ordersMissingKey: string | null,
  targetsMissingKey: string | null,
  saleMissingKey: string | null,
): ColSpec[] {
  const fy = filters.fy;
  const s = fyShort(fy);
  const p = fyShort(priorFy(fy));
  const om = ordersMissingKey ?? undefined;
  const tm = targetsMissingKey ?? undefined;
  const sm = saleMissingKey ?? undefined;
  // Sale columns: real values only when the register + bridge are both live.
  const sale = (
    header: string,
    kind: ColKind,
    get: (r: MemberRow) => unknown,
    total = kind === "money",
  ): ColSpec =>
    sm ? { header, kind, missing: sm, total: false } : { header, kind, get, total };
  const o = (
    header: string,
    kind: ColKind,
    pick: (x: OrderStats) => unknown,
    total = true,
  ): ColSpec =>
    om
      ? { header, kind, missing: om, total: false }
      : { header, kind, get: (r) => ord(r, pick), total };
  const t = (
    header: string,
    kind: ColKind,
    get: (r: MemberRow) => unknown,
    total = kind === "money",
  ): ColSpec =>
    tm
      ? { header, kind, missing: tm, total: false }
      : { header, kind, get, total };
  const { monthFrom, monthTo } = filters;
  return [
    { header: "State Head", kind: "text", get: (r) => r.m.stateHead, width: 18 },
    { header: "State", kind: "text", get: (r) => r.m.state, width: 14 },
    { header: "Name", kind: "text", get: (r) => r.m.name, width: 22 },
    { header: "Headquarter", kind: "text", get: (r) => r.m.headquarter, width: 14 },
    { header: "D.O.J", kind: "date", get: (r) => dateVal(r.m.dojSerial), width: 12 },
    { header: "Working State", kind: "text", get: (r) => r.m.workingState, width: 14 },
    {
      header: `Total Order ${p}`,
      kind: "money",
      get: (r) => r.priorAmount,
      total: true,
      width: 14,
    },
    sale(`Sale ${p}`, "money", (r) => r.sale?.priorAmount ?? null),
    { header: "CTC Monthly", kind: "money", missing: "payroll" },
    t("Target monthly", "money", (r) => {
      const a = tgtAnnual(r, "secondary");
      return a == null ? null : a / 12;
    }),
    t("Direct Dealer Target", "money", (r) => tgtAnnual(r, "directDealer")),
    t("Secondary Target", "money", (r) => tgtAnnual(r, "secondary")),
    o("Order Booking", "money", (x) => x.amount),
    o("Direct Dealers Order", "money", (x) => x.directAmount),
    sale(`Sale Report ${s}`, "money", (r) => r.sale?.amount ?? null),
    t("Target Achievement (%)", "pct", (r) =>
      achievement(r.orders?.amount, tgtRange(r, "secondary", monthFrom, monthTo)),
    ),
    t("Direct Dealer/Primary target achievement (%)", "pct", (r) =>
      achievement(
        r.orders?.directAmount,
        tgtRange(r, "directDealer", monthFrom, monthTo) ??
          tgtRange(r, "primary", monthFrom, monthTo),
      ),
    ),
    // Needs dispatched-sale-per-member data AND targets.
    sm || tm
      ? {
          header: "Target Achievement (%) (Sale)",
          kind: "pct",
          missing: sm ?? tm,
          total: false,
        }
      : {
          header: "Target Achievement (%) (Sale)",
          kind: "pct",
          get: (r) =>
            achievement(r.sale?.amount, tgtRange(r, "secondary", monthFrom, monthTo)),
          total: false,
        },
    o("Total Old Retailers", "int", (x) => x.oldRetailers),
    { header: "Visited Parties", kind: "int", missing: "sfa" },
    o("New Retailers", "int", (x) => x.newRetailers),
    o(
      "Number of New Retailers Orders Received",
      "int",
      (x) => x.newPartiesWithBusiness,
    ),
    o("Total Retailers", "int", (x) => x.totalRetailers),
    { header: "Non Visited Retailers", kind: "int", missing: "sfa" },
    o("Old Party Business Order Booking", "money", (x) => x.oldPartyAmount),
    o("New Party Order Booking", "money", (x) => x.newPartyAmount),
    o(
      "Business Achieved By No. of Old Parties",
      "int",
      (x) => x.oldPartiesWithBusiness,
    ),
    o(
      "Business Achieved By No. of New Parties",
      "int",
      (x) => x.newPartiesWithBusiness,
    ),
    o("Business Achieved By", "int", (x) => x.partiesWithBusiness),
    o("Business Achieved By Direct Dealer", "int", (x) => x.directParties),
    { header: "Total Lead Counters", kind: "int", missing: "sfa" },
    { header: "Total Lead Visits", kind: "int", missing: "sfa" },
    { header: "Total Non Lead Visits", kind: "int", missing: "sfa" },
    o("Distributor Counter", "int", (x) => x.distributorCount),
    { header: "Distributor Visits", kind: "int", missing: "sfa" },
    o("Direct Dealer Counter", "int", (x) => x.directDealerCount),
    { header: "Direct Dealer Visits", kind: "int", missing: "sfa" },
    { header: "Distributor/Direct Dealer Lead Counter", kind: "int", missing: "sfa" },
    { header: "Distributor/Direct Dealer Lead Visits", kind: "int", missing: "sfa" },
    { header: "Active Parties Visits", kind: "int", missing: "sfa" },
    { header: "Total Visits", kind: "int", missing: "sfa" },
    { header: "Working Days", kind: "int", missing: "sfa" },
    { header: "Average Order Per Day", kind: "money", missing: "sfa" },
    { header: "Average Visit Per Day", kind: "int", missing: "sfa" },
    { header: "CTC", kind: "money", missing: "payroll" },
    { header: "T.A. Bill ST. Cost", kind: "money", missing: "expense" },
    { header: "Cost Ratio (%)", kind: "pct", missing: "expense" },
    o("Business Per Retailer", "money", (x) => x.businessPerRetailer, false),
    o("No of Orders", "int", (x) => x.orderCount),
    { header: "Total Working Hours", kind: "int", missing: "sfa" },
    { header: "Total GPS KM", kind: "int", missing: "gps" },
    { header: "Avg Distance (KM)", kind: "int", missing: "gps" },
    { header: "Business Received Parties Visits", kind: "int", missing: "sfa" },
    { header: "Visited But No Business Received", kind: "int", missing: "sfa" },
    { header: "No Visit No Business Received", kind: "int", missing: "sfa" },
    {
      header: "Left Date",
      kind: "date",
      get: (r) => dateVal(r.m.leftDateSerial),
    },
    { header: "REMARKS", kind: "text", get: () => null, width: 16 },
  ];
}

function dataCols(
  filters: ReportFilters,
  ordersMissingKey: string | null,
  targetsMissingKey: string | null,
  saleMissingKey: string | null,
): ColSpec[] {
  const fy = filters.fy;
  const s = fyShort(fy);
  const om = ordersMissingKey ?? undefined;
  const tmk = targetsMissingKey ?? undefined;
  const sm = saleMissingKey ?? undefined;
  const o = (
    header: string,
    kind: ColKind,
    pick: (x: OrderStats) => unknown,
    total = true,
  ): ColSpec =>
    om
      ? { header, kind, missing: om, total: false }
      : { header, kind, get: (r) => ord(r, pick), total };
  const t = (
    header: string,
    kind: ColKind,
    get: (r: MemberRow) => unknown,
    total = kind === "money",
  ): ColSpec =>
    tmk
      ? { header, kind, missing: tmk, total: false }
      : { header, kind, get, total };
  const { monthFrom, monthTo } = filters;
  const secondaryAchievement = (r: MemberRow): number | null =>
    achievement(r.orders?.amount, tgtRange(r, "secondary", monthFrom, monthTo));
  return [
    { header: "State Head", kind: "text", get: (r) => r.m.stateHead, width: 18 },
    { header: "State", kind: "text", get: (r) => r.m.state, width: 14 },
    { header: "Name", kind: "text", get: (r) => r.m.name, width: 22 },
    { header: "Working State", kind: "text", get: (r) => r.m.workingState, width: 14 },
    { header: "Headquarter", kind: "text", get: (r) => r.m.headquarter, width: 14 },
    { header: "D.O.J", kind: "date", get: (r) => dateVal(r.m.dojSerial), width: 12 },
    t("Primary Target", "money", (r) => tgtAnnual(r, "primary")),
    t("Target", "money", (r) => tgtRange(r, "secondary", monthFrom, monthTo)),
    o("Achievement", "money", (x) => x.amount),
    o("Direct Dealers order", "money", (x) => x.directAmount),
    o("Total Old Retailers", "int", (x) => x.oldRetailers),
    { header: "Visited in a Month", kind: "int", missing: "sfa" },
    o("New Retailers", "int", (x) => x.newRetailers),
    o("Total Retailers", "int", (x) => x.totalRetailers),
    { header: "Non Visited Retailers", kind: "int", missing: "sfa" },
    o("Old Party Business Order Booking", "money", (x) => x.oldPartyAmount),
    o("New Party Order Booking", "money", (x) => x.newPartyAmount),
    o(
      "Business Achived By No. of Old Parties",
      "int",
      (x) => x.oldPartiesWithBusiness,
    ),
    o(
      "Business Achived By No. of New Parties",
      "int",
      (x) => x.newPartiesWithBusiness,
    ),
    o("Business Achieved By", "int", (x) => x.partiesWithBusiness),
    o("Business Achieved By Direct Dealer", "int", (x) => x.directParties),
    { header: "Total Lead Counters", kind: "int", missing: "sfa" },
    { header: "Total Lead Visits", kind: "int", missing: "sfa" },
    { header: "Total Non Lead Visits", kind: "int", missing: "sfa" },
    o("Distributor Counter", "int", (x) => x.distributorCount),
    { header: "Distributor Visits", kind: "int", missing: "sfa" },
    o("Direct Dealer Counter", "int", (x) => x.directDealerCount),
    { header: "Direct Dealer Visits", kind: "int", missing: "sfa" },
    { header: "Distributor/Direct Dealer Lead Counter", kind: "int", missing: "sfa" },
    { header: "Distributor/Direct Dealer Lead Visits", kind: "int", missing: "sfa" },
    { header: "Active Parties Visits", kind: "int", missing: "sfa" },
    { header: "Total Visits", kind: "int", missing: "sfa" },
    { header: "Working Days", kind: "int", missing: "sfa" },
    { header: "Average Sales Per Day", kind: "money", missing: "sfa" },
    { header: "Average Visit Per Day", kind: "int", missing: "sfa" },
    { header: "CTC Monthly", kind: "money", missing: "payroll" },
    { header: "CTC", kind: "money", missing: "payroll" },
    { header: "T.A. Bill ST. Cost", kind: "money", missing: "expense" },
    { header: "Cost Ratio (%)", kind: "pct", missing: "expense" },
    o("Business Per Retailer", "money", (x) => x.businessPerRetailer, false),
    t("Target Achievement (%)", "pct", secondaryAchievement, false),
    t(
      "Direct Dealer/Primary target achievement (%)",
      "pct",
      (r) =>
        achievement(
          r.orders?.directAmount,
          tgtRange(r, "directDealer", monthFrom, monthTo) ??
            tgtRange(r, "primary", monthFrom, monthTo),
        ),
      false,
    ),
    o("No of Orders", "int", (x) => x.orderCount),
    { header: "Total Working Hours", kind: "int", missing: "sfa" },
    { header: "Total GPS KM", kind: "int", missing: "gps" },
    o("New Party Orders", "int", (x) => x.newPartyOrders),
    { header: "Avg Distance (KM)", kind: "int", missing: "gps" },
    { header: "Business Received Parties Visits", kind: "int", missing: "sfa" },
    { header: "Visited But No Business Received", kind: "int", missing: "sfa" },
    { header: "No Visit No Business Received", kind: "int", missing: "sfa" },
    sm
      ? { header: `Sale Report ${s}`, kind: "money", missing: sm, total: false }
      : {
          header: `Sale Report ${s}`,
          kind: "money",
          get: (r) => r.sale?.amount ?? null,
          total: true,
        },
    {
      header: "Left Date",
      kind: "date",
      get: (r) => dateVal(r.m.leftDateSerial),
    },
    { header: "Active/ Left", kind: "text", get: (r) => r.m.activeLeft || null },
    { header: "old new", kind: "text", get: (r) => r.oldNew },
    t(
      "Target range",
      "text",
      (r) => {
        const a = secondaryAchievement(r);
        if (a == null) return null;
        if (a < 0.5) return "Below 50%";
        if (a < 0.75) return "50-75%";
        if (a < 1) return "75-100%";
        return "Above 100%";
      },
      false,
    ),
  ];
}

function kindFmt(kind: ColKind): string | null {
  switch (kind) {
    case "int":
      return FMT_INT;
    case "money":
      return FMT_INT;
    case "date":
      return FMT_DATE;
    case "pct":
      return "0.0%";
    default:
      return null;
  }
}

function writeCell(
  ws: ExcelJS.Worksheet,
  rowNum: number,
  colNum: number,
  spec: ColSpec,
  r: MemberRow,
): void {
  const cell = ws.getCell(rowNum, colNum);
  const fmt = kindFmt(spec.kind);
  if (fmt) cell.numFmt = fmt;
  if (spec.missing) {
    cell.fill = GREY_FILL;
    return;
  }
  const v = spec.get ? spec.get(r) : null;
  if (v == null || v === "") {
    if (spec.kind !== "text") cell.fill = GREY_FILL;
    return;
  }
  cell.value = v as ExcelJS.CellValue;
}

function writeGrid(
  ws: ExcelJS.Worksheet,
  cols: ColSpec[],
  rows: MemberRow[],
  headerRow: number,
  totalRow: number | null,
  startCol = 1,
): void {
  cols.forEach((c, i) => {
    const cell = ws.getCell(headerRow, startCol + i);
    cell.value = c.header;
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, size: 9 };
    cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
    ws.getColumn(startCol + i).width = c.width ?? 12;
  });
  rows.forEach((r, ri) => {
    cols.forEach((c, ci) => {
      writeCell(ws, headerRow + 1 + ri, startCol + ci, c, r);
    });
  });
  if (totalRow != null) {
    cols.forEach((c, ci) => {
      const cell = ws.getCell(totalRow, startCol + ci);
      cell.fill = c.missing ? GREY_FILL : TOTAL_FILL;
      cell.font = { bold: true };
      const fmt = kindFmt(c.kind);
      if (fmt) cell.numFmt = fmt;
      if (c.missing || !c.total || !c.get) return;
      let sum = 0;
      let any = false;
      for (const r of rows) {
        const v = c.get(r);
        if (typeof v === "number") {
          sum += v;
          any = true;
        }
      }
      if (any) cell.value = sum;
    });
    const label = ws.getCell(totalRow, startCol + 2);
    if (label.value == null) label.value = "TOTAL";
    label.font = { bold: true };
  }
}

type MissingUsed = Map<string, Set<string>>;

function note(missing: MissingUsed, missingKey: string, where: string): void {
  let set = missing.get(missingKey);
  if (!set) {
    set = new Set();
    missing.set(missingKey, set);
  }
  set.add(where);
}

function collectMissing(missing: MissingUsed, cols: ColSpec[], tabName: string): void {
  for (const c of cols) {
    if (c.missing) note(missing, c.missing, `${tabName}: ${c.header}`);
  }
}

export async function buildManagementWorkbook(
  filters: ReportFilters,
): Promise<{ workbook: ExcelJS.Workbook; memberCount: number }> {
  // Request-scoped: parallel report builds must not share missing-data state.
  const missing: MissingUsed = new Map();
  const {
    rows,
    rosterSource,
    ordersAvailable,
    targetsAvailable,
    orderStatus,
    priorStatus,
    nameMatches,
    segmentCheck,
    saleAvailable,
    bridge,
    registers,
    headSales,
    registerStatuses,
    registerGroupCheck,
    saleCrossFoot,
    saleMatch,
  } = await assembleRows(filters);
  const fy = filters.fy;
  const s = fyShort(fy);
  // Exact reason the report-FY order columns are blank (not a generic
  // "source needed"): file missing from the folder, 403 not shared, etc.
  const ordersReason = ordersAvailable
    ? null
    : (() => {
        const base =
          orderStatus?.detail ??
          `The ${fy} Secondary Order Booking workbook could not be read.`;
        const priorNote =
          priorStatus?.status === "ok"
            ? ` The ${priorFy(fy)} file was still read (${priorStatus.rowsRead ?? 0} rows) for the prior-year comparison columns.`
            : "";
        return `${base}${priorNote}`;
      })();
  const ordersMissingKey = ordersAvailable ? null : "orders";
  const targetsMissingKey = targetsAvailable ? null : "target";
  const saleMissingKey = saleAvailable ? null : "salebridge";
  // Exact reason the per-member Sale columns are blank: bridge sheet missing
  // (with head-grain totals available below), a bridge read failure, or the
  // registers themselves failing to load.
  const saleReason = saleAvailable
    ? null
    : registers.byHead.size === 0
      ? (registers.folderError ??
        "None of the State-Head sale register workbooks could be read; see the register load failures below.")
      : bridge.detail;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Prayag Sales Intelligence";
  wb.created = new Date();

  // --- Tab 1: SECONDARY ORDER BOOKING REPORT (trailing space as in template)
  {
    const ws = wb.addWorksheet(`SECONDARY ORDER BOOKING REPORT `);
    ws.views = [{ state: "frozen", xSplit: 3, ySplit: 6 }];
    const fixed: ColSpec[] = [
      { header: "State Head", kind: "text", get: (r) => r.m.stateHead, width: 18 },
      { header: "Team Member", kind: "text", get: (r) => r.m.name, width: 22 },
      { header: "H.Q", kind: "text", get: (r) => r.m.headquarter, width: 14 },
      { header: "Contact Number", kind: "text", get: (r) => r.m.contactNumber || null, width: 13 },
      { header: "DOJ", kind: "date", get: (r) => dateVal(r.m.dojSerial), width: 11 },
      { header: "Week Off", kind: "text", get: (r) => r.m.weekOff || null, width: 10 },
      { header: "Market Hours", kind: "text", get: (r) => r.m.marketHours || null, width: 11 },
      { header: `Monthly CTC ${fyShort(priorFy(fy))}`, kind: "money", missing: "payroll" },
      targetsMissingKey
        ? { header: `Monthly Target ${s}`, kind: "money", missing: targetsMissingKey }
        : {
            header: `Monthly Target ${s}`,
            kind: "money",
            get: (r) => {
              const a = tgtAnnual(r, "secondary");
              return a == null ? null : a / 12;
            },
            total: true,
          },
      ordersMissingKey
        ? { header: `Total Dealer ${s}`, kind: "int", missing: ordersMissingKey }
        : { header: `Total Dealer ${s}`, kind: "int", get: (r) => ord(r, (x) => x.totalRetailers), total: true },
      targetsMissingKey
        ? { header: `Business Plan ${s}`, kind: "money", missing: targetsMissingKey }
        : {
            header: `Business Plan ${s}`,
            kind: "money",
            get: (r) => tgtAnnual(r, "businessPlan"),
            total: true,
          },
      ordersMissingKey
        ? { header: `Order Booked ${s}`, kind: "money", missing: ordersMissingKey }
        : { header: `Order Booked ${s}`, kind: "money", get: (r) => ord(r, (x) => x.amount), total: true },
      targetsMissingKey
        ? { header: "Final Achievement", kind: "pct", missing: targetsMissingKey }
        : {
            header: "Final Achievement",
            kind: "pct",
            get: (r) =>
              achievement(
                r.orders?.amount,
                tgtRange(r, "secondary", filters.monthFrom, filters.monthTo),
              ),
          },
      saleMissingKey
        ? { header: `Sales ${s}`, kind: "money", missing: saleMissingKey }
        : {
            header: `Sales ${s}`,
            kind: "money",
            get: (r) => r.sale?.amount ?? null,
            total: true,
          },
    ];
    collectMissing(missing, fixed, ws.name.trim());
    // Title band rows 1-2.
    ws.mergeCells(1, 2, 2, 99);
    const title = ws.getCell(1, 2);
    title.value = `SECONDARY ORDER BOOKING REPORT ${fy}`;
    title.font = { bold: true, size: 14 };
    title.alignment = { vertical: "middle", horizontal: "center" };
    // Header band rows 4-6: fixed cols merged vertically.
    fixed.forEach((c, i) => {
      const col = 2 + i;
      ws.mergeCells(4, col, 6, col);
      const cell = ws.getCell(4, col);
      cell.value = c.header;
      cell.fill = HEADER_FILL;
      cell.font = { bold: true, size: 9 };
      cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
      ws.getColumn(col).width = c.width ?? 12;
    });
    // Monthly blocks Apr..Mar, 7 columns each, starting col 16.
    const startYear = fyStartYear(fy);
    const subgroups: Array<{ label: string; span: number; leaves: string[] }> = [
      { label: "Plan", span: 2, leaves: ["Amount", "Count"] },
      { label: "Order Booked", span: 2, leaves: ["Amount", "Count"] },
      { label: "% of Achievement", span: 1, leaves: ["% of Achievement"] },
      { label: "Sales Received", span: 2, leaves: ["Amount", "Count"] },
    ];
    for (let mIdx = 0; mIdx < 12; mIdx++) {
      const base = 16 + mIdx * 7;
      ws.mergeCells(4, base, 4, base + 6);
      const mCell = ws.getCell(4, base);
      mCell.value = new Date(Date.UTC(startYear + Math.floor((mIdx + 3) / 12), (mIdx + 3) % 12, 1));
      mCell.numFmt = "mmm-yy";
      mCell.fill = HEADER_FILL;
      mCell.font = { bold: true };
      mCell.alignment = { horizontal: "center" };
      let cursor = base;
      for (const g of subgroups) {
        if (g.span > 1) ws.mergeCells(5, cursor, 5, cursor + g.span - 1);
        const gCell = ws.getCell(5, cursor);
        gCell.value = g.label;
        gCell.fill = HEADER_FILL;
        gCell.font = { bold: true, size: 9 };
        gCell.alignment = { horizontal: "center", wrapText: true };
        g.leaves.forEach((leaf, li) => {
          const lCell = ws.getCell(6, cursor + li);
          lCell.value = leaf;
          lCell.fill = HEADER_FILL;
          lCell.font = { bold: true, size: 8 };
          lCell.alignment = { horizontal: "center" };
          ws.getColumn(cursor + li).width = 11;
        });
        cursor += g.span;
      }
    }
    if (targetsMissingKey) {
      note(missing, "target", `${ws.name.trim()}: monthly Plan Amount/Count, % of Achievement`);
    } else {
      note(missing, "target", `${ws.name.trim()}: monthly Plan Count (the Target Master holds amounts, not order counts)`);
    }
    if (saleMissingKey) {
      note(missing, "salebridge", `${ws.name.trim()}: monthly Sales Received Amount/Count`);
    }
    if (ordersMissingKey) {
      note(missing, "orders", `${ws.name.trim()}: monthly Order Booked Amount/Count`);
    }
    // Data rows from row 7.
    rows.forEach((r, ri) => {
      const rowNum = 7 + ri;
      fixed.forEach((c, ci) => writeCell(ws, rowNum, 2 + ci, c, r));
      for (let mIdx = 0; mIdx < 12; mIdx++) {
        const base = 16 + mIdx * 7;
        const inRange = mIdx + 1 >= filters.monthFrom && mIdx + 1 <= filters.monthTo;
        // Plan Amount from the Target Master; Plan Count has no source.
        const planA = ws.getCell(rowNum, base);
        const plan = r.target ? tgtMonthly(r.target, "secondary", mIdx) : null;
        if (!targetsMissingKey && plan != null) {
          planA.value = plan;
          planA.numFmt = FMT_INT;
        } else {
          planA.fill = GREY_FILL;
        }
        ws.getCell(rowNum, base + 1).fill = GREY_FILL;
        // Order Booked Amount/Count
        const obA = ws.getCell(rowNum, base + 2);
        const obC = ws.getCell(rowNum, base + 3);
        obA.numFmt = FMT_INT;
        obC.numFmt = FMT_INT;
        if (r.orders && inRange) {
          obA.value = r.orders.monthAmount[mIdx];
          obC.value = r.orders.monthOrders[mIdx];
        } else if (!r.orders) {
          obA.fill = GREY_FILL;
          obC.fill = GREY_FILL;
        }
        // % of Achievement = month order booking vs month plan.
        const achCell = ws.getCell(rowNum, base + 4);
        const monthAch =
          !targetsMissingKey && r.orders && inRange
            ? achievement(r.orders.monthAmount[mIdx], plan)
            : null;
        if (monthAch != null) {
          achCell.value = monthAch;
          achCell.numFmt = "0.0%";
        } else {
          achCell.fill = GREY_FILL;
        }
        // Sales Received: dispatched sale per member per month, only when
        // the register + Party->TM bridge are both live.
        const srA = ws.getCell(rowNum, base + 5);
        const srC = ws.getCell(rowNum, base + 6);
        if (!saleMissingKey && r.sale && inRange) {
          srA.value = r.sale.monthAmount[mIdx];
          srC.value = r.sale.monthInvoices[mIdx];
          srA.numFmt = FMT_INT;
          srC.numFmt = FMT_INT;
        } else {
          srA.fill = GREY_FILL;
          srC.fill = GREY_FILL;
        }
      }
    });
    // TOTAL row 3.
    const totalRow = 3;
    ws.getCell(totalRow, 3).value = "TOTAL";
    ws.getCell(totalRow, 3).font = { bold: true };
    fixed.forEach((c, ci) => {
      const cell = ws.getCell(totalRow, 2 + ci);
      cell.font = { bold: true };
      if (c.missing) {
        cell.fill = GREY_FILL;
        return;
      }
      if (!c.total || !c.get) return;
      let sum = 0;
      for (const r of rows) {
        const v = c.get(r);
        if (typeof v === "number") sum += v;
      }
      cell.value = sum;
      cell.numFmt = FMT_INT;
      cell.fill = TOTAL_FILL;
    });
    for (let mIdx = 0; mIdx < 12; mIdx++) {
      const base = 16 + mIdx * 7;
      const planTotal = ws.getCell(totalRow, base);
      if (!targetsMissingKey && rows.some((r) => r.target)) {
        let sum = 0;
        for (const r of rows) {
          const v = r.target ? tgtMonthly(r.target, "secondary", mIdx) : null;
          if (v != null) sum += v;
        }
        planTotal.value = sum;
        planTotal.numFmt = FMT_INT;
        planTotal.fill = TOTAL_FILL;
        planTotal.font = { bold: true };
      } else {
        planTotal.fill = GREY_FILL;
      }
      ws.getCell(totalRow, base + 1).fill = GREY_FILL;
      const obA = ws.getCell(totalRow, base + 2);
      const obC = ws.getCell(totalRow, base + 3);
      if (rows.some((r) => r.orders)) {
        obA.value = rows.reduce((a, r) => a + (r.orders?.monthAmount[mIdx] ?? 0), 0);
        obC.value = rows.reduce((a, r) => a + (r.orders?.monthOrders[mIdx] ?? 0), 0);
        obA.numFmt = FMT_INT;
        obC.numFmt = FMT_INT;
        obA.fill = TOTAL_FILL;
        obC.fill = TOTAL_FILL;
        obA.font = { bold: true };
        obC.font = { bold: true };
      } else {
        obA.fill = GREY_FILL;
        obC.fill = GREY_FILL;
      }
      ws.getCell(totalRow, base + 4).fill = GREY_FILL;
      const srA = ws.getCell(totalRow, base + 5);
      const srC = ws.getCell(totalRow, base + 6);
      if (!saleMissingKey && rows.some((r) => r.sale)) {
        srA.value = rows.reduce((a, r) => a + (r.sale?.monthAmount[mIdx] ?? 0), 0);
        srC.value = rows.reduce((a, r) => a + (r.sale?.monthInvoices[mIdx] ?? 0), 0);
        srA.numFmt = FMT_INT;
        srC.numFmt = FMT_INT;
        srA.fill = TOTAL_FILL;
        srC.fill = TOTAL_FILL;
        srA.font = { bold: true };
        srC.font = { bold: true };
      } else {
        srA.fill = GREY_FILL;
        srC.fill = GREY_FILL;
      }
    }
  }

  // --- Tab 2: Primary Team Members
  {
    const ws = wb.addWorksheet(`Primary Team Members ${fy}`);
    const primary = rows.filter(
      (r) => r.m.channel.toLowerCase() === "primary",
    );
    const cols: ColSpec[] = [
      { header: "Reporting Head", kind: "text", get: (r) => r.m.stateHead, width: 18 },
      { header: "Team Member", kind: "text", get: (r) => r.m.name, width: 22 },
      { header: "H.Q", kind: "text", get: (r) => r.m.headquarter, width: 14 },
      { header: "Contact Number", kind: "text", get: (r) => r.m.contactNumber || null, width: 13 },
      { header: "DOJ", kind: "date", get: (r) => dateVal(r.m.dojSerial), width: 11 },
      { header: "Week Off", kind: "text", get: (r) => r.m.weekOff || null, width: 10 },
      { header: "Market Hours", kind: "text", get: (r) => r.m.marketHours || null, width: 11 },
      { header: `Monthly CTC ${fyShort(priorFy(fy))}`, kind: "money", missing: "payroll" },
      ordersMissingKey
        ? { header: `Distributor ${s}`, kind: "int", missing: ordersMissingKey }
        : { header: `Distributor ${s}`, kind: "int", get: (r) => ord(r, (x) => x.distributorCount), total: true },
      ordersMissingKey
        ? { header: `Direct Dealers ${s}`, kind: "int", missing: ordersMissingKey }
        : { header: `Direct Dealers ${s}`, kind: "int", get: (r) => ord(r, (x) => x.directDealerCount), total: true },
      { header: "Distributor & Direct Dealer Visit", kind: "int", missing: "sfa" },
      ordersMissingKey
        ? { header: `Retailers ${s}`, kind: "int", missing: ordersMissingKey }
        : { header: `Retailers ${s}`, kind: "int", get: (r) => ord(r, (x) => x.totalRetailers), total: true },
      { header: "Retailers Visit", kind: "int", missing: "sfa" },
      ordersMissingKey
        ? { header: `Secondary Order Booked ${s}`, kind: "money", missing: ordersMissingKey }
        : { header: `Secondary Order Booked ${s}`, kind: "money", get: (r) => ord(r, (x) => x.amount), total: true },
    ];
    collectMissing(missing, cols, ws.name);
    ws.mergeCells(1, 2, 2, 15);
    const title = ws.getCell(1, 2);
    title.value = `Primary Team Members ${fy}`;
    title.font = { bold: true, size: 14 };
    title.alignment = { vertical: "middle", horizontal: "center" };
    // Header rows 4-5 merged vertically, TOTAL row 3, data from row 6.
    cols.forEach((c, i) => {
      const col = 2 + i;
      ws.mergeCells(4, col, 5, col);
      const cell = ws.getCell(4, col);
      cell.value = c.header;
      cell.fill = HEADER_FILL;
      cell.font = { bold: true, size: 9 };
      cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
      ws.getColumn(col).width = c.width ?? 12;
    });
    primary.forEach((r, ri) => {
      cols.forEach((c, ci) => writeCell(ws, 6 + ri, 2 + ci, c, r));
    });
    ws.getCell(3, 2).value = primary.length;
    ws.getCell(3, 2).font = { bold: true };
    ws.getCell(3, 3).value = "TOTAL";
    ws.getCell(3, 3).font = { bold: true };
    cols.forEach((c, ci) => {
      const cell = ws.getCell(3, 2 + ci);
      if (c.missing) {
        cell.fill = GREY_FILL;
        return;
      }
      if (!c.total || !c.get) return;
      let sum = 0;
      for (const r of primary) {
        const v = c.get(r);
        if (typeof v === "number") sum += v;
      }
      cell.value = sum;
      cell.numFmt = FMT_INT;
      cell.fill = TOTAL_FILL;
      cell.font = { bold: true };
    });
  }

  // --- Tab 3: Low Performers (flagged from Target Master achievement)
  {
    const ws = wb.addWorksheet(`Low Performers `);
    const cols = summaryCols(filters, ordersMissingKey, targetsMissingKey, saleMissingKey);
    ws.mergeCells(1, 2, 1, 6);
    const title = ws.getCell(1, 2);
    title.value = `Below ${filters.lowPerfPct}% Acheivement & Cost Ratio Above 5%`;
    title.font = { bold: true, size: 12 };
    ws.getCell(1, 7).value = fy;
    ws.getCell(2, 2).value = "Count";
    ws.getCell(2, 2).font = { bold: true };
    const lowRows = targetsMissingKey
      ? []
      : rows.filter((r) => {
          const a = achievement(
            r.orders?.amount,
            tgtRange(r, "secondary", filters.monthFrom, filters.monthTo),
          );
          return a != null && a < filters.lowPerfPct / 100;
        });
    ws.getCell(2, 3).value = lowRows.length;
    cols.forEach((c, i) => {
      const cell = ws.getCell(3, 1 + i);
      cell.value = c.header;
      cell.fill = HEADER_FILL;
      cell.font = { bold: true, size: 9 };
      cell.alignment = { wrapText: true, vertical: "middle", horizontal: "center" };
      ws.getColumn(1 + i).width = c.width ?? 12;
    });
    lowRows.forEach((r, ri) => {
      cols.forEach((c, ci) => writeCell(ws, 4 + ri, 1 + ci, c, r));
    });
    if (targetsMissingKey) {
      note(
        missing,
        "target",
        "Low Performers: achievement % cannot be computed until a Target Master is connected, so no members can be flagged",
      );
    }
  }

  // --- Tab 4: Summary
  {
    const ws = wb.addWorksheet(`Summary ${s}`);
    ws.views = [{ state: "frozen", xSplit: 3, ySplit: 6 }];
    const cols = summaryCols(filters, ordersMissingKey, targetsMissingKey, saleMissingKey);
    collectMissing(missing, cols, ws.name);
    const fyStart = fyBoundsSerial(fy).start;
    const newMembers = rows.filter(
      (r) => r.m.dojSerial != null && r.m.dojSerial >= fyStart,
    ).length;
    const leftMembers = rows.filter(
      (r) => r.m.leftDateSerial != null || r.m.activeLeft.toLowerCase() === "left",
    ).length;
    ws.getCell(4, 2).value = "New Team Members";
    ws.getCell(4, 3).value = "No. Of Active Team Members";
    ws.getCell(4, 4).value = "Left Team Members";
    ws.getCell(4, 5).value = "Total";
    for (let c = 2; c <= 5; c++) {
      ws.getCell(4, c).font = { bold: true, size: 9 };
      ws.getCell(4, c).fill = HEADER_FILL;
      ws.getCell(4, c).alignment = { wrapText: true };
    }
    ws.getCell(5, 2).value = newMembers;
    ws.getCell(5, 3).value = rows.length - leftMembers;
    ws.getCell(5, 4).value = leftMembers;
    ws.getCell(5, 5).value = rows.length;
    writeGrid(ws, cols, rows, 6, 5);
  }

  // --- Tab 5: Data
  {
    const ws = wb.addWorksheet("Data");
    ws.views = [{ state: "frozen", xSplit: 3, ySplit: 3 }];
    const cols = dataCols(filters, ordersMissingKey, targetsMissingKey, saleMissingKey);
    collectMissing(missing, cols, ws.name);
    writeGrid(ws, cols, rows, 3, null);
  }

  // --- Tab 6: Missing Data
  {
    const ws = wb.addWorksheet("Missing Data");
    ws.getColumn(1).width = 60;
    ws.getColumn(2).width = 90;
    const h1 = ws.getCell(1, 1);
    h1.value = "Columns left blank (light grey) in this workbook";
    h1.font = { bold: true, size: 12 };
    ws.getCell(2, 1).value =
      "These values are unknown, not zero. Each block lists the source that will fill them automatically once connected.";
    ws.getCell(2, 1).font = { italic: true, size: 9 };
    let rowNum = 4;
    const keys = [...missing.keys()].sort();
    for (const key of keys) {
      const src = ws.getCell(rowNum, 1);
      // The orders block carries the exact load failure (file not in the
      // folder, 403 not shared, 404 wrong id) instead of a generic source.
      src.value =
        key === "orders" && ordersReason
          ? ordersReason
          : key === "salebridge" && saleReason
            ? saleReason
            : `Source needed: ${MISSING_SOURCES[key] ?? key}`;
      src.font = { bold: true };
      src.fill = HEADER_FILL;
      src.alignment = { wrapText: true, vertical: "top" };
      ws.getCell(rowNum, 2).fill = HEADER_FILL;
      rowNum++;
      for (const where of [...(missing.get(key) ?? [])].sort()) {
        ws.getCell(rowNum, 2).value = where;
        rowNum++;
      }
      rowNum++;
    }
    // Team-member name matching between the order files and the roster.
    for (const nm of nameMatches) {
      const head = ws.getCell(rowNum, 1);
      head.value = `Team member name matching — ${nm.fy} order booking vs roster: ${nm.matched}/${nm.fileNames} names matched (${(nm.matchRate * 100).toFixed(1)}%)`;
      head.font = { bold: true };
      head.fill = HEADER_FILL;
      ws.getCell(rowNum, 2).fill = HEADER_FILL;
      rowNum++;
      for (const name of nm.unmatchedFromFile) {
        ws.getCell(rowNum, 2).value =
          `unmatched team member (in ${nm.fy} order file, not in roster): ${name}`;
        rowNum++;
      }
      for (const name of nm.unmatchedFromRoster) {
        ws.getCell(rowNum, 2).value =
          `unmatched team member (in roster, no ${nm.fy} order rows): ${name}`;
        rowNum++;
      }
      if (nm.unmatchedFromFile.length === 0 && nm.unmatchedFromRoster.length === 0) {
        ws.getCell(rowNum, 2).value = "All names matched.";
        rowNum++;
      }
      rowNum++;
    }
    // Segment-to-group mapping through the INDEX file.
    if (segmentCheck) {
      const head = ws.getCell(rowNum, 1);
      head.value = segmentCheck.indexError
        ? `Segment mapping (${segmentCheck.fy}): INDEX map could not be read — ${segmentCheck.indexError}`
        : segmentCheck.unmapped.length > 0
          ? `Segment mapping (${segmentCheck.fy}): ${segmentCheck.unmapped.length} of ${segmentCheck.segments} segments missing from the INDEX map`
          : `Segment mapping (${segmentCheck.fy}): all ${segmentCheck.segments} segments mapped through the INDEX file`;
      head.font = { bold: true };
      head.fill = HEADER_FILL;
      head.alignment = { wrapText: true, vertical: "top" };
      ws.getCell(rowNum, 2).fill = HEADER_FILL;
      rowNum++;
      for (const u of segmentCheck.unmapped) {
        ws.getCell(rowNum, 2).value = `unmapped segment: ${u.segment} (${u.amount})`;
        rowNum++;
      }
      rowNum++;
    }
    // Dispatched sale registers: head-grain totals (real numbers, readable
    // today) so the register data is never invisible just because the
    // Party -> Team Member bridge does not exist yet.
    if (headSales.length > 0) {
      const inr = (v: number): string => Math.round(v).toLocaleString("en-IN");
      const head = ws.getCell(rowNum, 1);
      head.value = `Dispatched sale — State-Head register totals (${fy} and ${priorFy(fy)}): ${headSales.length} heads read from the State Heads folder`;
      head.font = { bold: true };
      head.fill = HEADER_FILL;
      head.alignment = { wrapText: true, vertical: "top" };
      ws.getCell(rowNum, 2).fill = HEADER_FILL;
      rowNum++;
      for (const h of headSales) {
        const fyPart =
          h.fyAmount != null
            ? `${fy} Sale ${inr(h.fyAmount)} (${h.fyInvoices} invoices, ${h.fyParties} parties)`
            : `${fy}: no rows`;
        const priorPart =
          h.priorAmount != null
            ? `${priorFy(fy)} Sale ${inr(h.priorAmount)} (${h.priorInvoices} invoices, ${h.priorParties} parties)`
            : `${priorFy(fy)}: no rows`;
        ws.getCell(rowNum, 2).value = `${h.head} — ${fyPart}; ${priorPart}`;
        rowNum++;
      }
      const totalFy = headSales.reduce((a, h) => a + (h.fyAmount ?? 0), 0);
      const totalPrior = headSales.reduce((a, h) => a + (h.priorAmount ?? 0), 0);
      const tCell = ws.getCell(rowNum, 2);
      tCell.value = `TOTAL — ${fy} Sale ${inr(totalFy)}; ${priorFy(fy)} Sale ${inr(totalPrior)}`;
      tCell.font = { bold: true };
      rowNum += 2;
    }
    // Register workbooks that could not be read (403 / 404 / no register tab).
    const registerFailures = registerStatuses.filter((st) => st.status === "error");
    if (registers.folderError || registerFailures.length > 0) {
      const head = ws.getCell(rowNum, 1);
      head.value = registers.folderError
        ? `State-Head sale registers could not be loaded`
        : `State-Head sale register workbooks that could not be read (${registerFailures.length} of ${registerStatuses.length})`;
      head.font = { bold: true };
      head.fill = HEADER_FILL;
      head.alignment = { wrapText: true, vertical: "top" };
      ws.getCell(rowNum, 2).fill = HEADER_FILL;
      rowNum++;
      if (registers.folderError) {
        ws.getCell(rowNum, 2).value = registers.folderError;
        ws.getCell(rowNum, 2).alignment = { wrapText: true, vertical: "top" };
        rowNum++;
      }
      for (const st of registerFailures) {
        ws.getCell(rowNum, 2).value = st.detail;
        ws.getCell(rowNum, 2).alignment = { wrapText: true, vertical: "top" };
        rowNum++;
      }
      rowNum++;
    }
    // Register Group column reconciliation through the INDEX map.
    if (registerGroupCheck) {
      const head = ws.getCell(rowNum, 1);
      head.value = registerGroupCheck.indexError
        ? `Register group mapping (${registerGroupCheck.fy}): INDEX map could not be read — ${registerGroupCheck.indexError}`
        : registerGroupCheck.unmapped.length > 0
          ? `Register group mapping (${registerGroupCheck.fy}): ${registerGroupCheck.unmapped.length} of ${registerGroupCheck.segments} register groups missing from the INDEX map`
          : `Register group mapping (${registerGroupCheck.fy}): all ${registerGroupCheck.segments} register groups mapped through the INDEX file`;
      head.font = { bold: true };
      head.fill = HEADER_FILL;
      head.alignment = { wrapText: true, vertical: "top" };
      ws.getCell(rowNum, 2).fill = HEADER_FILL;
      rowNum++;
      for (const u of registerGroupCheck.unmapped) {
        ws.getCell(rowNum, 2).value = `unmapped register group: ${u.segment} (${u.amount})`;
        rowNum++;
      }
      rowNum++;
    }
    // Cross-foot check when the bridge splits Sale to member grain. The
    // Unassigned bucket is part of the member split, so only a genuine sum
    // mismatch counts as a problem.
    if (saleAvailable && saleCrossFoot.length > 0) {
      const problems = saleCrossFoot.filter(
        (cf) => Math.abs(cf.headTotal - cf.memberSum) > 1,
      );
      const head = ws.getCell(rowNum, 1);
      head.value =
        problems.length > 0
          ? `Sale cross-foot (${fy}): ${problems.length} of ${saleCrossFoot.length} heads where the member split (incl. Unassigned) does not reproduce the register total`
          : `Sale cross-foot (${fy}): all ${saleCrossFoot.length} heads reproduce their register totals within 1 (member split incl. Unassigned rows)`;
      head.font = { bold: true };
      head.fill = HEADER_FILL;
      head.alignment = { wrapText: true, vertical: "top" };
      ws.getCell(rowNum, 2).fill = HEADER_FILL;
      rowNum++;
      for (const cf of problems) {
        ws.getCell(rowNum, 2).value =
          `${cf.head}: register total ${Math.round(cf.headTotal).toLocaleString("en-IN")}, ` +
          `member split ${Math.round(cf.memberSum).toLocaleString("en-IN")}`;
        ws.getCell(rowNum, 2).alignment = { wrapText: true, vertical: "top" };
        rowNum++;
      }
      rowNum++;
    }
    // Bridge match quality: how much register revenue joined to a member,
    // what sits in the Unassigned buckets, and bridge hygiene findings.
    if (saleAvailable && saleMatch) {
      const pct = Math.round(saleMatch.matchedPct * 1000) / 10;
      const head = ws.getCell(rowNum, 1);
      head.value =
        `Party TM Map match (${fy}): ${pct}% of register revenue ` +
        `(${Math.round(saleMatch.matchedAmount).toLocaleString("en-IN")} of ` +
        `${Math.round(saleMatch.totalAmount).toLocaleString("en-IN")}) is assigned to a team member` +
        (pct < 90 ? " — below the 90% target" : "");
      head.font = { bold: true };
      head.fill = HEADER_FILL;
      head.alignment = { wrapText: true, vertical: "top" };
      ws.getCell(rowNum, 2).fill = HEADER_FILL;
      rowNum++;
      for (const u of saleMatch.unassigned) {
        ws.getCell(rowNum, 2).value =
          `Unassigned (${u.head}): ${Math.round(u.amount).toLocaleString("en-IN")} across ` +
          `${u.parties} parties. Top parties: ` +
          u.topParties
            .map((p) => `${p.party} (${Math.round(p.amount).toLocaleString("en-IN")})`)
            .join("; ") +
          ". Add these to the Party TM Map sheet to assign them.";
        ws.getCell(rowNum, 2).alignment = { wrapText: true, vertical: "top" };
        rowNum++;
      }
      if (saleMatch.bridgeMembersNotInRoster.length > 0) {
        ws.getCell(rowNum, 2).value =
          `Bridge team members not found in the roster (their sale is shown on synthetic rows): ` +
          saleMatch.bridgeMembersNotInRoster.join(", ");
        ws.getCell(rowNum, 2).alignment = { wrapText: true, vertical: "top" };
        rowNum++;
      }
      if (bridge.conflicts.length > 0) {
        ws.getCell(rowNum, 2).value =
          `Party TM Map conflicts (same party mapped to several members; the first listed won): ` +
          bridge.conflicts
            .slice(0, 20)
            .map((c) => `${c.party}${c.partyId ? ` [${c.partyId}]` : ""}: ${c.members.join(" / ")} -> ${c.kept}`)
            .join("; ");
        ws.getCell(rowNum, 2).alignment = { wrapText: true, vertical: "top" };
        rowNum++;
      }
      rowNum++;
    }
    if (rosterSource === "state_head_dashboard") {
      const cell = ws.getCell(rowNum + 1, 1);
      cell.value =
        "Note: the Team Member Details (HR) workbook is not shared with the connected Google account yet; the roster spine currently comes from the live STATE HEAD DASHBOARD workbook's identity columns.";
      cell.font = { italic: true, size: 9 };
    }
  }

  return { workbook: wb, memberCount: rows.length };
}
