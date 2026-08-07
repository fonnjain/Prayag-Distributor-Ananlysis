// Distributor Deep Dive — Phase D1 + D2 + D3
//
// Phase D1: Groups retailer rows from member working sheets by Assigned
//   Distributor field. Four distinct field states:
//     blank / null   → direct dealer  (parallel branch, NOT a child of any dist)
//     '--' / '-'     → no distributor assigned  (mapping problem — flag it)
//     'A, B' comma   → shared distributor  (model as relation, not a string)
//     numeric        → malformed row  (exclude)
//     other          → normalize name → assign to distributor group
//
// Phase D2: Adds the two flows a distributor sits between.
//   Primary in-flow  = what the distributor BUYS from Prayag (sale_line,
//                      customer matched to the distributor name).
//   Secondary out    = what the distributor SELLS to retailers (member sheets
//                      for the live year; secondary_register_line for closed).
//   Flow gap         = primary in minus secondary out.  A positive gap may
//                      indicate stock building or business moving outside the
//                      attributed channel.  Reported as an observation only —
//                      the two interpretations are indistinguishable from data.
//   Pending          = primary OB (primary_order_line) minus dispatch
//                      (sale_line).  Institutional orders are excluded from OB
//                      because they are dispatched without being booked first.
//   Recency/frequency: days since last dispatch, invoices per month.
//   Growth: closed-month dispatch this FY vs same calendar months prior FY.
//
// Rules:
//  - Never publish a distributor total without Confirmed/Guessed split.
//  - Direct dealers are a PARALLEL branch — never a child of any distributor.
//  - normDistKey: TRADERS → TRADE, ENTERPRISES → ENTERPRISE — applied to
//    both member-sheet distributor names AND sale_line customer names so the
//    two sides join on the same key.
//  - "no primary data" when no sale_line rows match — never show a zero.
//  - NET = Sub Total (sale_line.amount) throughout.
//  - Never console.log — use logger.

import { db, customerMaster, saleLines, primaryOrderLines, distributorTierOverrideTable, routePayloadSnapshots } from "@workspace/db";
import { eq, and, sql, inArray, or, isNull } from "drizzle-orm";
import { logger } from "../logger.js";
import { loadDeepDiveData } from "./deepDiveData.js";
import { loadMemberSheet, type RetailerRow, type RetailerSpread } from "./memberSheet.js";
import {
  loadDistributorSkuSpread,
  type DistributorSkuSpread,
} from "./distributorSkuSpread.js";
import {
  loadDistributorInvestment,
  buildTierActions,
  type DistributorInvestment,
} from "./distributorInvestment.js";
import { computeRoiCost } from "./roiCost.js";
import {
  computeCustomerConcentration,
  type CustomerConcentration,
  type D6RetailerInput,
} from "./distributorCustomerConcentration.js";
import {
  computeTerritoryWhitespace,
  type WhitespaceRow,
  type TerritoryWhitespace,
} from "./distributorWhitespace.js";
import { readVerifyAnchors } from "../config/verifyAnchors.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DistributorRetailerRow = {
  name: string;
  district: string | null;
  city: string | null;
  orderBooking: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
  confirmedHead: boolean;
  memberName: string;
};

/** D2: per-distributor flow comparison (primary in vs secondary out). */
export type DistributorFlows = {
  // ── Primary in-flow (Prayag → Distributor) ──────────────────────────
  hasPrimaryData: boolean;
  primaryDispatch: number;        // sum(sale_line.amount), FY to date
  primaryOb: number | null;       // sum(primary_order_line.taxable_value), non-institutional
  pendingValue: number | null;    // primaryOb - primaryDispatch
  fillRate: number | null;        // primaryDispatch / primaryOb × 100
  matchedCustomers: string[];     // which sale_line.customer values matched
  // ── Secondary out-flow (Distributor → Retailers) ─────────────────────
  secondaryOut: number;           // DistributorGroup.sale (member sheets, FY to date)
  secondarySource: "member_sheets";
  // ── Flow gap ──────────────────────────────────────────────────────────
  flowGap: number | null;         // primaryDispatch - secondaryOut; null = no primary data
  // ── Period ────────────────────────────────────────────────────────────
  period: string;                 // e.g. "FY 2026-27 YTD"
  // ── Recency & frequency (from sale_line) ──────────────────────────────
  lastInvoiceDate: string | null;
  daysSinceLastOrder: number | null;
  invoiceCount: number;           // distinct invoices, FY to date
  monthsActive: number;           // distinct months with any dispatch
  ordersPerMonth: number | null;  // invoiceCount / monthsActive
  // ── YoY growth (closed-months comparison) ────────────────────────────
  yoyPeriod: string;              // e.g. "Apr-26 – Jun-26 vs Apr-25 – Jun-25"
  currentPeriodDispatch: number | null;  // closed months, this FY
  priorPeriodDispatch: number | null;    // same calendar months, prior FY
  growthPct: number | null;       // (current - prior) / prior × 100
};

/** D7: per-distributor retailer concentration (its own top-5 / top-10, direct dealers excluded). */
export type RetailerConcentration = {
  totalOb: number;
  top5Ob: number;
  top5SharePct: number | null;
  top10Ob: number;
  top10SharePct: number | null;
  topRetailerName: string | null;
  topRetailerOb: number | null;
  topRetailerSharePct: number | null;
};

export type DistributorGroup = {
  name: string;              // canonical display name (most common raw form)
  normKey: string;           // stable grouping key
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  orderBooking: number;
  sale: number;
  visits: number | null;
  obSharePct: number | null;        // share of party OB
  isConcentrationRisk: boolean;     // obSharePct >= 60 %
  confirmedCount: number;
  guessedCount: number;
  retailers: DistributorRetailerRow[];
  flows: DistributorFlows | null;       // D2: null until loadDistributorFlows runs
  skuSpread?: DistributorSkuSpread;     // D3: set by loadDistributorSkuSpread
  investment?: DistributorInvestment;   // D4: set by loadDistributorInvestment
  retailerConcentration?: RetailerConcentration; // D7: set by Step 15
};

export type SharedRetailerEntry = {
  name: string;
  rawDistributor: string;
  distributorParts: string[];      // split on comma
  orderBooking: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
  confirmedHead: boolean;
  memberName: string;
};

export type DirectDealerSummary = {
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  /** Secondary OB from blank-distributor retailer rows in working sheets (often 0 — DD
   *  business is a primary channel and is not re-reported in secondary row OB). */
  orderBooking: number;
  sale: number;
  visits: number | null;
  /** Authoritative DD OB from Data-tab directDealersOrder column. */
  dashboardOb: number | null;
  /** Member whose directDealersOrder > 0 in the Data tab. */
  dashboardMember: string | null;
};

/** SD2: per-state classification and activity summary. */
export type StateDistributorRow = {
  state: string;
  memberCount: number;
  retailerCount: number;
  visitCount: number | null;
  namedCount: number;
  noneCount: number;
  blankCount: number;
  sharedCount: number;
  malformedCount: number;
  namedActiveCount: number;
  namedActivePct: number | null;
  noneActiveCount: number;
  noneActivePct: number | null;
  noneVisits: number | null;
  noneVisitSharePct: number | null;
  /** Top distributor (by secondary OB) in this state. */
  topDistributorNormKey: string | null;
  topDistributorName: string | null;
  /** topDistributor OB as % of all named-OB in this state. */
  topDistributorObPct: number | null;
  /** SD4: concentration both ways as effective counts (10,000 / HHI on OB shares).
   *  Never a raw HHI gauge — an effective count of N reads as "equivalent to N
   *  equally-sized players". Null when the state has no positive OB. */
  effectiveDistributors: number | null;
  effectiveRetailers: number | null;
  /** SD4: whitespace split per state (mirrors the territory-total filters —
   *  coverage counts gapType "both" districts, assignment counts "assignment"). */
  coverageGapDistricts: number;
  coverageGapRetailers: number;
  coverageGapPriorYearOb: number;
  assignmentGapDistricts: number;
  assignmentGapRetailers: number;
  assignmentGapPriorYearOb: number;
};

/** SD2: per-member unassigned analysis for cross-member correlation. */
export type MemberDistributorRow = {
  name: string;
  normKey: string;
  state: string;
  isLeft: boolean;
  totalRetailers: number;
  removedCount: number;
  namedCount: number;
  noneCount: number;
  blankCount: number;
  sharedCount: number;
  /** SD4: order booking on this member's blank-distributor (direct dealer) rows —
   *  lets the ₹ direct-dealer total be reconciled member by member. */
  blankOb: number;
  noneSharePct: number | null;
  namedActivePct: number | null;
  noneActivePct: number | null;
  noneVisits: number | null;
  noneVisitSharePct: number | null;
  /** From Data tab — paired with noneSharePct for correlation. */
  achievementTotal: number | null;
};

/** SD2: near-duplicate distributor name pair detected via Jaccard trigram similarity. */
export type NamingCandidate = {
  /** Canonical name of distributor A (most-common raw spelling). */
  a: string;
  /** Canonical name of distributor B. */
  b: string;
  normA: string;
  normB: string;
  similarity: number;   // 0–1 Jaccard trigram
};

export type NoneAssignedSummary = {
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  orderBooking: number;
  sale: number;
  visits: number | null;
  visitSharePct: number | null;   // of the member's total visits
  allDormant: boolean;
};

export type MappingQuality = {
  totalRetailers: number;
  blankCount: number;
  noneCount: number;
  sharedCount: number;
  malformedCount: number;
  distributorCount: number;
  noneVisits: number | null;
  totalVisits: number | null;
  noneVisitSharePct: number | null;
  noneAllDormant: boolean;
};

/** D7: territory-level visit capacity check. */
export type CapacityCheck = {
  availablePerMonth: number | null;   // YTD visits / elapsed months (null = no visit data)
  demandedPerMonth: number;           // sum of tier retailer cadences across all distributors
  shortfallPerMonth: number | null;   // demanded - available if positive, else null
  hasShortfall: boolean;
  breakdown: Array<{
    normKey: string;
    name: string;
    tier: "A" | "B" | "C";
    demandedRetailerVisitsPerMonth: number;
  }>;
};

export type DistributorDeepDiveResult = {
  fy: string;
  stateHeads: string[];
  distributors: DistributorGroup[];
  sharedRetailers: SharedRetailerEntry[];
  directDealer: DirectDealerSummary | null;
  noneAssigned: NoneAssignedSummary | null;
  mappingQuality: MappingQuality | null;
  partyObTotal: number;
  membersLoaded: number;
  membersNotMapped: number;
  /** Mapped member working sheets whose Sheets read failed or timed out this
   *  build. > 0 marks the live payload as incomplete (degraded load). */
  membersFailed: number;
  whitespace:     TerritoryWhitespace | null;
  concentration:  CustomerConcentration | null;
  capacityCheck:  CapacityCheck | null;
  /** SD2: per-state classification and activity breakdown. */
  byState: StateDistributorRow[];
  /** SD2: per-member unassigned analysis (includes LEFT members for completeness). */
  perMember: MemberDistributorRow[];
  /** SD2: Pearson r between noneSharePct and achievementTotal across active members.
   *  Null when fewer than 3 active members have both values. */
  unassignedCorrelation: number | null;
  /** SD2: candidate near-duplicate distributor name pairs (Jaccard trigram sim > 0.6).
   *  Never auto-merged — listed for human confirmation only. */
  namingCandidates: NamingCandidate[];
  error: string | null;
  /** True when the live build failed transiently and the last saved snapshot
   *  was served instead — figures may be slightly out of date. */
  stale?: boolean;
  /** True when a saved snapshot was served immediately (fast path) while a
   *  background rebuild refreshes it — figures update on the next visit. */
  refreshing?: boolean;
};

// ── Distributor field classification ─────────────────────────────────────────

type DistClass =
  | { type: "blank" }
  | { type: "none" }
  | { type: "malformed" }
  | { type: "shared"; parts: string[] }
  | { type: "distributor"; raw: string; normKey: string };

/**
 * Normalize a raw distributor name to a stable grouping key.
 * Merges common spelling variants so 'Jagdamba Traders' and
 * 'Jagdamba Trade' both collapse to 'JAGDAMBA TRADE'.
 * Applied to BOTH member-sheet distributor names AND sale_line customer
 * names so the two data sources join on the same key.
 */
export function normDistKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\bTRADERS?\b/g, "TRADE")           // Traders / Trader → TRADE
    .replace(/\bENTERPRISES?\b/g, "ENTERPRISE")   // Enterprises → ENTERPRISE
    .replace(/\bINDUSTRIES\b/g, "INDUSTRY")
    .replace(/\bPVT\.?\s*LTD\.?\b/g, "PVTLTD")
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyDist(raw: string | null): DistClass {
  if (!raw || raw.trim() === "") return { type: "blank" };
  const t = raw.trim();
  // Numeric-only cell → malformed, exclude
  if (/^\d+(\.\d+)?$/.test(t)) return { type: "malformed" };
  // None-assigned markers
  if (t === "--" || t === "-" || t === "—" || t === "–") return { type: "none" };
  // Comma-separated → shared distributor relationship
  if (t.includes(",")) {
    const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
    return { type: "shared", parts };
  }
  return { type: "distributor", raw: t, normKey: normDistKey(t) };
}

// ── D2: helpers ───────────────────────────────────────────────────────────────

type AnchorShape = {
  primary_anchors?: Record<string, { closedMonths?: string[] } | string | number>;
};
/** Return the list of closed month labels for a given FY, e.g. ["Apr-26","May-26","Jun-26"]. */
export function closedMonthsForFy(fy: string): string[] {
  const a = readVerifyAnchors<AnchorShape>().primary_anchors?.[fy];
  if (!a || typeof a !== "object") return [];
  return (a as { closedMonths?: string[] }).closedMonths ?? [];
}

/** "2026-27" → "2025-26" */
export function prevFyLabel(fy: string): string {
  const p = fy.split("-");
  if (p.length !== 2) return fy;
  const start = parseInt(p[0], 10);
  return `${start - 1}-${String(start).slice(-2)}`;
}

/** Map closed months of current FY to same calendar months in prior FY.
 *  e.g. ["Apr-26","Jun-26"] → ["Apr-25","Jun-25"] */
export function toPriorYearMonths(months: string[]): string[] {
  return months.map((m) => {
    const parts = m.split("-");
    if (parts.length !== 2) return m;
    const yr = parseInt(parts[1], 10);
    return `${parts[0]}-${String(yr - 1).padStart(2, "0")}`;
  });
}

function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function computeGrowth(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

/** Row returned by the sale_line customer+month query. */
type SlMonthRow = {
  customer: string;
  monthLabel: string;
  dispatch: number;
  invoiceCount: number;
  lastInvoiceDate: string | null;
};

/** Row returned by the primary_order_line customer query (OB, non-institutional). */
type ObCustomerRow = {
  customer: string;
  ob: number;
};

/** Aggregated primary data for one customer (after grouping by normKey). */
type PrimaryAgg = {
  fyTotal: number;
  fyInvoiceCount: number;
  fyMonthsActive: number;
  fyLastDate: string | null;
  closedTotal: number;            // closed months of current FY only
  rawNames: string[];
};

/**
 * D2: Compute and attach flow data to each DistributorGroup in place.
 * Called after D1 aggregation is complete.
 */
async function loadDistributorFlows(
  fy: string,
  stateHead: string,
  distGroups: DistributorGroup[],
): Promise<void> {
  if (!distGroups.length) return;

  const closedMonths = closedMonthsForFy(fy);
  const prevFy = prevFyLabel(fy);
  const priorMonths = toPriorYearMonths(closedMonths);
  const today = new Date();

  // ── Batch DB queries ────────────────────────────────────────────────────────
  let slRows: SlMonthRow[];
  let obRows: ObCustomerRow[];
  let priorSlRows: SlMonthRow[];

  try {
    [slRows, obRows, priorSlRows] = await Promise.all([
      // Current FY: all months, grouped by (customer, month_label)
      db
        .select({
          customer:        sql<string>`coalesce(${saleLines.customer}, '')`,
          monthLabel:      sql<string>`coalesce(${saleLines.monthLabel}, '')`,
          dispatch:        sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
          invoiceCount:    sql<number>`count(distinct ${saleLines.invoiceNo})::int`,
          lastInvoiceDate: sql<string | null>`max(${saleLines.invoiceDate})::text`,
        })
        .from(saleLines)
        .where(and(
          eq(saleLines.fy, fy),
          eq(saleLines.headCanon, stateHead),
          eq(saleLines.versionStatus, "current"),
        ))
        .groupBy(saleLines.customer, saleLines.monthLabel),

      // Current FY: OB per customer, non-institutional only
      db
        .select({
          customer: sql<string>`coalesce(${primaryOrderLines.customer}, '')`,
          ob:       sql<number>`coalesce(sum(${primaryOrderLines.taxableValue}), 0)::float8`,
        })
        .from(primaryOrderLines)
        .where(and(
          eq(primaryOrderLines.fy, fy),
          eq(primaryOrderLines.headCanon, stateHead),
          // Exclude institutional: channel IS NULL (territory) or channel != 'Govt'
          or(
            isNull(primaryOrderLines.channel),
            sql`${primaryOrderLines.channel} != 'Govt'`,
          ),
        ))
        .groupBy(primaryOrderLines.customer),

      // Prior FY: closed-month equivalents (for YoY)
      priorMonths.length > 0
        ? db
            .select({
              customer:        sql<string>`coalesce(${saleLines.customer}, '')`,
              monthLabel:      sql<string>`coalesce(${saleLines.monthLabel}, '')`,
              dispatch:        sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
              invoiceCount:    sql<number>`count(distinct ${saleLines.invoiceNo})::int`,
              lastInvoiceDate: sql<string | null>`max(${saleLines.invoiceDate})::text`,
            })
            .from(saleLines)
            .where(and(
              eq(saleLines.fy, prevFy),
              eq(saleLines.headCanon, stateHead),
              eq(saleLines.versionStatus, "current"),
              inArray(saleLines.monthLabel, priorMonths),
            ))
            .groupBy(saleLines.customer, saleLines.monthLabel)
        : Promise.resolve([] as SlMonthRow[]),
    ]);
  } catch (err) {
    logger.warn({ err }, "distributorDeepDive D2: DB query failed — flows will be null");
    return;
  }

  // ── Build maps keyed by normDistKey(customer) ─────────────────────────────

  const closedSet = new Set(closedMonths);

  /** Aggregate sale_line rows into a Map<normKey → PrimaryAgg>. */
  function buildPrimaryMap(rows: SlMonthRow[], filterMonths?: Set<string>): Map<string, PrimaryAgg> {
    const m = new Map<string, PrimaryAgg>();
    for (const r of rows) {
      if (filterMonths && !filterMonths.has(r.monthLabel)) continue;
      const nk = normDistKey(r.customer);
      const ex = m.get(nk);
      if (ex) {
        ex.fyTotal       += r.dispatch;
        ex.fyInvoiceCount += r.invoiceCount;
        ex.fyMonthsActive = ex.fyMonthsActive; // updated below
        ex.fyLastDate    = laterDate(ex.fyLastDate, r.lastInvoiceDate);
        ex.rawNames.push(r.customer);
      } else {
        m.set(nk, {
          fyTotal:        r.dispatch,
          fyInvoiceCount: r.invoiceCount,
          fyMonthsActive: 0,              // counted separately
          fyLastDate:     r.lastInvoiceDate,
          closedTotal:    0,
          rawNames:       [r.customer],
        });
      }
    }
    return m;
  }

  // Build full-FY map first (all months), then annotate closedTotal and monthsActive.
  const fyMap = new Map<string, PrimaryAgg>();
  const monthsActiveMap = new Map<string, Set<string>>();  // normKey → set of month labels

  for (const r of slRows) {
    const nk = normDistKey(r.customer);
    const ex = fyMap.get(nk);
    if (ex) {
      ex.fyTotal        += r.dispatch;
      ex.fyInvoiceCount += r.invoiceCount;
      ex.fyLastDate      = laterDate(ex.fyLastDate, r.lastInvoiceDate);
      if (closedSet.has(r.monthLabel)) ex.closedTotal += r.dispatch;
      // rawNames: keep unique
      if (!ex.rawNames.includes(r.customer)) ex.rawNames.push(r.customer);
    } else {
      fyMap.set(nk, {
        fyTotal:        r.dispatch,
        fyInvoiceCount: r.invoiceCount,
        fyMonthsActive: 0,
        fyLastDate:     r.lastInvoiceDate,
        closedTotal:    closedSet.has(r.monthLabel) ? r.dispatch : 0,
        rawNames:       [r.customer],
      });
    }
    const ms = monthsActiveMap.get(nk) ?? new Set<string>();
    ms.add(r.monthLabel);
    monthsActiveMap.set(nk, ms);
  }
  for (const [nk, agg] of fyMap) {
    agg.fyMonthsActive = monthsActiveMap.get(nk)?.size ?? 0;
  }

  // OB map
  const obMap = new Map<string, number>();
  for (const r of obRows) {
    const nk = normDistKey(r.customer);
    obMap.set(nk, (obMap.get(nk) ?? 0) + r.ob);
  }

  // Prior-year map (only closed-month equivalents)
  const priorMap = buildPrimaryMap(priorSlRows);

  // YoY period label
  const yoyPeriod = closedMonths.length > 0
    ? `${closedMonths[0]} – ${closedMonths[closedMonths.length - 1]} vs ` +
      `${priorMonths[0]} – ${priorMonths[priorMonths.length - 1]}`
    : "insufficient closed months for YoY";

  const fyPeriod = `FY ${fy} YTD`;

  // ── Attach flows to each distGroup ────────────────────────────────────────
  for (const g of distGroups) {
    const agg  = fyMap.get(g.normKey);
    const ob   = obMap.get(g.normKey) ?? null;
    const prior = priorMap.get(g.normKey);

    if (!agg || agg.fyTotal === 0) {
      // No matching primary dispatch data.
      g.flows = {
        hasPrimaryData:         false,
        primaryDispatch:        0,
        primaryOb:              ob,
        pendingValue:           null,
        fillRate:               null,
        matchedCustomers:       agg?.rawNames ?? [],
        secondaryOut:           g.sale,
        secondarySource:        "member_sheets",
        flowGap:                null,
        period:                 fyPeriod,
        lastInvoiceDate:        null,
        daysSinceLastOrder:     null,
        invoiceCount:           0,
        monthsActive:           0,
        ordersPerMonth:         null,
        yoyPeriod,
        currentPeriodDispatch:  agg?.closedTotal ?? null,
        priorPeriodDispatch:    prior?.fyTotal ?? null,
        growthPct:              computeGrowth(agg?.closedTotal ?? null, prior?.fyTotal ?? null),
      };
      continue;
    }

    const dispatch     = agg.fyTotal;
    const pendingValue = ob !== null ? ob - dispatch : null;
    const fillRate     = ob !== null && ob > 0 ? (dispatch / ob) * 100 : null;
    const daysSince    = agg.fyLastDate
      ? Math.floor((today.getTime() - new Date(agg.fyLastDate).getTime()) / 86_400_000)
      : null;
    const ordersPerMonth = agg.fyMonthsActive > 0
      ? agg.fyInvoiceCount / agg.fyMonthsActive
      : null;
    const flowGap = dispatch - g.sale;

    const currentD = agg.closedTotal > 0 ? agg.closedTotal : null;
    const priorD   = prior && prior.fyTotal > 0 ? prior.fyTotal : null;

    g.flows = {
      hasPrimaryData:        true,
      primaryDispatch:       dispatch,
      primaryOb:             ob,
      pendingValue,
      fillRate,
      matchedCustomers:      agg.rawNames,
      secondaryOut:          g.sale,
      secondarySource:       "member_sheets",
      flowGap,
      period:                fyPeriod,
      lastInvoiceDate:       agg.fyLastDate,
      daysSinceLastOrder:    daysSince,
      invoiceCount:          agg.fyInvoiceCount,
      monthsActive:          agg.fyMonthsActive,
      ordersPerMonth,
      yoyPeriod,
      currentPeriodDispatch: currentD,
      priorPeriodDispatch:   priorD,
      growthPct:             computeGrowth(currentD, priorD),
    };
  }

  logger.info(
    {
      fy, stateHead,
      distributorsWithPrimaryData: distGroups.filter((g) => g.flows?.hasPrimaryData).length,
      distributorsWithNoData:      distGroups.filter((g) => g.flows && !g.flows.hasPrimaryData).length,
    },
    "distributorDeepDive D2: flow computation complete",
  );
}

// ── SD2 helper functions ───────────────────────────────────────────────────────

/** Pearson correlation coefficient.  Returns null when n < 3 or denominator = 0. */
function pearsonR(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? null : +(num / denom).toFixed(4);
}

function trigramsOf(s: string): Set<string> {
  const norm = s.toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(3, "\0");
  const out = new Set<string>();
  for (let i = 0; i <= norm.length - 3; i++) out.add(norm.slice(i, i + 3));
  return out;
}

/** Jaccard similarity on character trigrams of two normDistKey strings. */
function jaccardTrigram(a: string, b: string): number {
  const sa = trigramsOf(a), sb = trigramsOf(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Return up to 30 near-duplicate distributor name pairs (Jaccard trigram > 0.6).
 * Never auto-merges — the list is for human review only.
 */
function computeNamingCandidates(groups: DistributorGroup[]): NamingCandidate[] {
  const cands: NamingCandidate[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const g1 = groups[i], g2 = groups[j];
      if (g1.normKey === g2.normKey) continue;
      const sim = jaccardTrigram(g1.normKey, g2.normKey);
      if (sim > 0.6 && sim < 1) {
        cands.push({ a: g1.name, b: g2.name, normA: g1.normKey, normB: g2.normKey, similarity: +sim.toFixed(3) });
      }
    }
  }
  return cands.sort((a, b) => b.similarity - a.similarity).slice(0, 30);
}

// ── D1 main function ───────────────────────────────────────────────────────────

export async function loadDistributorDeepDive(
  fy: string,
  selectedStateHead?: string,
): Promise<DistributorDeepDiveResult> {
  // Step 1: Load member list via the deepDiveData cache (avoids a second
  // Sheets read for the Data tab; the result is already cached or loading).
  const ddResult = await loadDeepDiveData(fy, selectedStateHead, undefined);
  const { stateHeads, members } = ddResult;

  const empty = (): DistributorDeepDiveResult => ({
    fy, stateHeads, distributors: [], sharedRetailers: [],
    directDealer: null, noneAssigned: null, mappingQuality: null,
    partyObTotal: 0, membersLoaded: 0, membersNotMapped: 0, membersFailed: 0,
    whitespace: null, concentration: null, capacityCheck: null,
    byState: [], perMember: [], unassignedCorrelation: null, namingCandidates: [],
    error: null,
  });

  if (!selectedStateHead || !members.length) return empty();

  // Step 2: Load member working sheets with BOUNDED concurrency. A fully
  // parallel load of a 74-member team fires ~150 Sheets reads in one burst and
  // reliably trips the per-minute read quota in production (429), so the load
  // degrades and no snapshot is ever saved — which is exactly why the page
  // "worked for Anant Singh only" in prod. A small worker pool keeps the read
  // rate under the quota while warm-cache loads stay fast (cached sheets
  // resolve instantly regardless of pool size).
  const TIMEOUT_MS = 60_000;
  const SHEET_CONCURRENCY = 4;
  const sheetResults: PromiseSettledResult<
    Awaited<ReturnType<typeof loadMemberSheet>> | { status: "error"; error: string }
  >[] = new Array(members.length);
  {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < members.length) {
        const i = next++;
        const m = members[i];
        try {
          const v = await Promise.race([
            loadMemberSheet(m.normKey, m.name, fy),
            new Promise<{ status: "error"; error: string }>((resolve) =>
              setTimeout(
                () => resolve({ status: "error", error: `timeout after ${TIMEOUT_MS / 1000}s` }),
                TIMEOUT_MS,
              ),
            ),
          ]);
          sheetResults[i] = { status: "fulfilled", value: v };
        } catch (err) {
          sheetResults[i] = { status: "rejected", reason: err };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SHEET_CONCURRENCY, members.length) }, () => worker()),
    );
  }

  type RichRow = RetailerRow & { memberName: string; memberState: string };
  // SD2: per-member accumulator — populated during classification (Step 4).
  type PerMemberAcc = {
    named: RichRow[]; none: RichRow[]; blank: RichRow[];
    shared: RichRow[]; malformed: RichRow[];
  };
  const perMemberAcc        = new Map<string, PerMemberAcc>();
  const memberRemovedCounts = new Map<string, number>();
  const memberStateMap      = new Map<string, string>(
    members.map((m) => [m.name, m.state ?? "Unknown"] as const),
  );
  const allRows: RichRow[] = [];
  let membersLoaded = 0;
  let membersNotMapped = 0;
  let membersFailed = 0;
  // D4: member spreads for cost-per-visit (keyed by display name — matches memberName on rows)
  const memberSpreads = new Map<string, RetailerSpread>();

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const res = sheetResults[i];
    if (res.status === "rejected") {
      logger.warn({ member: m.name, err: res.reason }, "distributorDeepDive: sheet load rejected");
      membersFailed++;
      continue;
    }
    const sheet = res.value;
    if (sheet.status === "not-mapped") { membersNotMapped++; continue; }
    if (sheet.status !== "ok") {
      logger.warn({ member: m.name, status: sheet.status }, "distributorDeepDive: sheet not ok");
      membersFailed++;
      continue;
    }
    membersLoaded++;
    memberSpreads.set(m.name, sheet.spread);   // capture spread for D4
    memberRemovedCounts.set(m.name, (sheet as any).removedRows?.length ?? 0);
    for (const row of sheet.rows) {
      allRows.push({ ...row, memberName: m.name, memberState: memberStateMap.get(m.name) ?? "Unknown" });
    }
  }

  if (!allRows.length) {
    return {
      ...empty(),
      membersLoaded, membersNotMapped, membersFailed,
      error: membersLoaded === 0
        ? "No working sheets could be loaded for this state head."
        : null,
    };
  }

  // D4 pre-computation: member cost per visit, using the same formula as Sales
  // Deep Dive Phase 4: (ctcMonthly × elapsed months + taBillYtd) / totalVisits.
  // CTC comes from the deepDiveData kpis; totalVisits from the member's spread.
  // We use the first member with data (typically only one per state head in this period).
  const memberNameToNormKey = new Map(members.map((m) => [m.name, m.normKey] as const));
  let d4MemberCostPerVisit: number | null = null;
  // D6 dashboard stats (new retailer data) — captured from the first member kpis available.
  let d6NewPartyOb:     number | null = null;
  let d6NewRetailers:   number | null = null;

  for (const [memberName, spread] of memberSpreads.entries()) {
    const normKey = memberNameToNormKey.get(memberName);
    if (!normKey) continue;
    try {
      const mDd = await loadDeepDiveData(fy, selectedStateHead, normKey);
      const kpis = mDd.kpis;

      // D6: capture new-party stats from the first member that has kpis.
      if (kpis && d6NewPartyOb === null) {
        d6NewPartyOb = kpis.newPartyOrderBooking ?? null;
        const oldR   = kpis.totalOldRetailers ?? null;
        const totalR = kpis.totalRetailers    ?? null;
        if (oldR !== null && totalR !== null && totalR >= oldR) {
          d6NewRetailers = totalR - oldR;
        }
      }

      if (kpis?.ctcMonthly != null) {
        const roi = computeRoiCost(kpis.ctcMonthly, kpis.taBillStCost ?? null, fy, spread);
        if (roi?.costPerVisit != null) {
          d4MemberCostPerVisit = roi.costPerVisit;
          logger.info(
            { memberName, normKey, costPerVisit: roi.costPerVisit.toFixed(0), fy },
            "distributorDeepDive D4: memberCostPerVisit computed",
          );
          break;
        }
      }
    } catch (_) { /* graceful fallback — costToServe will be null */ }
  }

  // Step 3: Query customer_master for Confirmed/Guessed attribution confidence.
  const confidenceMap = new Map<string, "Confirmed" | "Guessed">();
  try {
    const cmRows = await db
      .select({ company: customerMaster.company, headConfidence: customerMaster.headConfidence })
      .from(customerMaster)
      .where(eq(customerMaster.stateHead, selectedStateHead));
    for (const r of cmRows) {
      const k = r.company.toLowerCase().replace(/\s+/g, " ").trim();
      confidenceMap.set(k, r.headConfidence.startsWith("Confirmed") ? "Confirmed" : "Guessed");
    }
  } catch (err) {
    logger.warn({ err }, "distributorDeepDive: customer_master query failed — confidence will default to Guessed");
  }

  function conf(name: string): "Confirmed" | "Guessed" {
    return confidenceMap.get(name.toLowerCase().replace(/\s+/g, " ").trim()) ?? "Guessed";
  }

  // Step 4: Classify all retailer rows.
  const distMap = new Map<string, { rawNames: string[]; rows: RichRow[] }>();
  const sharedRows: RichRow[] = [];
  const directDealerRows: RichRow[] = [];
  const noneRows: RichRow[] = [];
  const malformedRows: RichRow[] = [];

  let totalVisitSum = 0;
  let hasAnyVisit = false;

  for (const row of allRows) {
    if (row.totalVisit !== null) { totalVisitSum += row.totalVisit; hasAnyVisit = true; }
    const cls = classifyDist(row.distributor);
    // SD2: per-member accumulator for unassigned analysis.
    let pma = perMemberAcc.get(row.memberName);
    if (!pma) { pma = { named:[], none:[], blank:[], shared:[], malformed:[] }; perMemberAcc.set(row.memberName, pma); }
    switch (cls.type) {
      case "blank":       directDealerRows.push(row); pma.blank.push(row);     break;
      case "none":        noneRows.push(row);         pma.none.push(row);      break;
      case "malformed":   malformedRows.push(row);    pma.malformed.push(row); break;
      case "shared":      sharedRows.push(row);       pma.shared.push(row);    break;
      case "distributor": {
        const existing = distMap.get(cls.normKey);
        if (existing) { existing.rawNames.push(cls.raw); existing.rows.push(row); }
        else          { distMap.set(cls.normKey, { rawNames: [cls.raw], rows: [row] }); }
        pma.named.push(row);
        break;
      }
    }
  }

  // Step 5: Build shared retailer entries.
  const sharedRetailers: SharedRetailerEntry[] = sharedRows.map((row) => {
    const cls = classifyDist(row.distributor) as { type: "shared"; parts: string[] };
    return {
      name: row.name,
      rawDistributor: row.distributor ?? "",
      distributorParts: cls.parts,
      orderBooking: row.orderBooking,
      sale: row.sale,
      visits: row.totalVisit,
      isActive: row.isActive,
      confirmedHead: conf(row.name) === "Confirmed",
      memberName: row.memberName,
    };
  });

  const sharedOb = sharedRetailers.reduce((s, r) => s + r.orderBooking, 0);

  // Step 6: Build distributor groups (flows initialised to null; D2 fills them below).
  let totalDistOb = 0;
  const distGroups: DistributorGroup[] = Array.from(distMap.entries()).map(
    ([normKey, { rawNames, rows }]) => {
      const freq = new Map<string, number>();
      for (const n of rawNames) freq.set(n, (freq.get(n) ?? 0) + 1);
      const canonicalName =
        [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? rawNames[0];

      const retailerRows: DistributorRetailerRow[] = rows
        .map((row) => ({
          name: row.name,
          district: row.district,
          city: row.city,
          orderBooking: row.orderBooking,
          sale: row.sale,
          visits: row.totalVisit,
          isActive: row.isActive,
          confirmedHead: conf(row.name) === "Confirmed",
          memberName: row.memberName,
        }))
        .sort((a, b) => b.orderBooking - a.orderBooking);

      const active   = rows.filter((r) => r.isActive);
      const ob       = rows.reduce((s, r) => s + r.orderBooking, 0);
      const sale     = rows.reduce((s, r) => s + r.sale, 0);
      const vArr     = rows.map((r) => r.totalVisit).filter((v): v is number => v !== null);
      const visits   = vArr.length > 0 ? vArr.reduce((s, v) => s + v, 0) : null;
      const confCnt  = rows.filter((r) => conf(r.name) === "Confirmed").length;

      totalDistOb += ob;

      return {
        name: canonicalName, normKey,
        retailerCount: rows.length,
        activeCount:   active.length,
        dormantCount:  rows.length - active.length,
        orderBooking: ob, sale, visits,
        obSharePct:          null,  // filled below
        isConcentrationRisk: false, // filled below
        confirmedCount: confCnt,
        guessedCount:   rows.length - confCnt,
        retailers: retailerRows,
        flows: null,                // D2: filled by loadDistributorFlows()
      };
    },
  );

  // party OB = distributor OB + shared OB
  const partyObTotal = totalDistOb + sharedOb;

  for (const g of distGroups) {
    g.obSharePct         = partyObTotal > 0 ? (g.orderBooking / partyObTotal) * 100 : null;
    g.isConcentrationRisk = (g.obSharePct ?? 0) >= 60;
  }
  distGroups.sort((a, b) => b.orderBooking - a.orderBooking);

  // Step 7: Direct dealer summary.
  // dashboardOb comes from the Data-tab directDealersOrder column (primary channel — the
  // secondary-channel row OB on blank-distributor rows is typically 0 for DD business).
  const ddActive      = directDealerRows.filter((r) => r.isActive);
  const ddVArr        = directDealerRows.map((r) => r.totalVisit).filter((v): v is number => v !== null);
  const ddTabMembers  = members
    .filter((m) => (m.directDealerOb ?? 0) > 0)
    .sort((a, b) => (b.directDealerOb ?? 0) - (a.directDealerOb ?? 0));
  const dashboardDdOb     = ddTabMembers[0]?.directDealerOb ?? null;
  const dashboardDdMember = ddTabMembers[0]?.name ?? null;
  const directDealer: DirectDealerSummary | null =
    directDealerRows.length > 0 || dashboardDdOb !== null
      ? {
          retailerCount:   directDealerRows.length,
          activeCount:     ddActive.length,
          dormantCount:    directDealerRows.length - ddActive.length,
          orderBooking:    directDealerRows.reduce((s, r) => s + r.orderBooking, 0),
          sale:            directDealerRows.reduce((s, r) => s + r.sale, 0),
          visits:          ddVArr.length > 0 ? ddVArr.reduce((s, v) => s + v, 0) : null,
          dashboardOb:     dashboardDdOb,
          dashboardMember: dashboardDdMember,
        }
      : null;

  // Step 8: None-assigned summary.
  const noneActive = noneRows.filter((r) => r.isActive);
  const noneVArr   = noneRows.map((r) => r.totalVisit).filter((v): v is number => v !== null);
  const noneVTotal = noneVArr.length > 0 ? noneVArr.reduce((s, v) => s + v, 0) : null;
  const noneAssigned: NoneAssignedSummary | null = noneRows.length > 0
    ? {
        retailerCount: noneRows.length,
        activeCount:   noneActive.length,
        dormantCount:  noneRows.length - noneActive.length,
        orderBooking:  noneRows.reduce((s, r) => s + r.orderBooking, 0),
        sale:          noneRows.reduce((s, r) => s + r.sale, 0),
        visits:        noneVTotal,
        visitSharePct:
          hasAnyVisit && totalVisitSum > 0 && noneVTotal !== null
            ? (noneVTotal / totalVisitSum) * 100
            : null,
        allDormant: noneActive.length === 0,
      }
    : null;

  // Step 9: Mapping quality panel.
  const mappingQuality: MappingQuality = {
    totalRetailers: allRows.length,
    blankCount:     directDealerRows.length,
    noneCount:      noneRows.length,
    sharedCount:    sharedRows.length,
    malformedCount: malformedRows.length,
    distributorCount:
      allRows.length
      - directDealerRows.length
      - noneRows.length
      - sharedRows.length
      - malformedRows.length,
    noneVisits:        noneVTotal,
    totalVisits:       hasAnyVisit ? totalVisitSum : null,
    noneVisitSharePct:
      hasAnyVisit && totalVisitSum > 0 && noneVTotal !== null
        ? (noneVTotal / totalVisitSum) * 100
        : null,
    noneAllDormant: noneActive.length === 0,
  };

  logger.info(
    {
      fy, selectedStateHead, membersLoaded, membersNotMapped,
      totalRetailers: allRows.length,
      distributors:   distGroups.length,
      partyObTotal,
      directDealerOb: directDealer?.orderBooking ?? null,
      dashboardDdOb:  directDealer?.dashboardOb ?? null,
      noneCount:      noneRows.length,
      sharedCount:    sharedRows.length,
      malformedCount: malformedRows.length,
    },
    "distributorDeepDive D1: aggregation complete",
  );

  // ── SD2: per-member, per-state, correlation, naming candidates ────────────────

  // Step 9b: Per-member unassigned analysis.
  const perMember: MemberDistributorRow[] = members.map((m) => {
    const acc = perMemberAcc.get(m.name) ?? { named:[], none:[], blank:[], shared:[], malformed:[] };
    const total = acc.named.length + acc.none.length + acc.blank.length + acc.shared.length + acc.malformed.length;
    const namedActive = acc.named.filter((r) => r.isActive).length;
    const noneActive  = acc.none.filter((r) => r.isActive).length;
    const noneVisArr  = acc.none.map((r) => r.totalVisit).filter((v): v is number => v !== null);
    const allVisArr   = [...acc.named, ...acc.none, ...acc.blank, ...acc.shared]
      .map((r) => r.totalVisit).filter((v): v is number => v !== null);
    const noneVis  = noneVisArr.length > 0 ? noneVisArr.reduce((s, v) => s + v, 0) : null;
    const totalVis = allVisArr.length  > 0 ? allVisArr.reduce((s, v)  => s + v, 0) : 0;
    return {
      name:             m.name,
      normKey:          m.normKey,
      state:            m.state ?? "Unknown",
      isLeft:           m.isLeft,
      totalRetailers:   total,
      removedCount:     memberRemovedCounts.get(m.name) ?? 0,
      namedCount:       acc.named.length,
      noneCount:        acc.none.length,
      blankCount:       acc.blank.length,
      blankOb:          acc.blank.reduce((s, r) => s + r.orderBooking, 0),
      sharedCount:      acc.shared.length,
      noneSharePct:     total > 0 ? (acc.none.length / total) * 100 : null,
      namedActivePct:   acc.named.length > 0 ? (namedActive / acc.named.length) * 100 : null,
      noneActivePct:    acc.none.length  > 0 ? (noneActive  / acc.none.length)  * 100 : null,
      noneVisits:       noneVis,
      noneVisitSharePct: totalVis > 0 && noneVis !== null ? (noneVis / totalVis) * 100 : null,
      achievementTotal: m.achievementTotal ?? null,
    };
  });

  // Step 9c: Per-state breakdown.
  type StateAcc = {
    memberNames: Set<string>;
    named: RichRow[]; none: RichRow[]; blank: RichRow[];
    shared: RichRow[]; malformed: RichRow[];
  };
  const stateAccMap = new Map<string, StateAcc>();
  for (const row of allRows) {
    const st = row.memberState;
    let s = stateAccMap.get(st);
    if (!s) {
      s = { memberNames: new Set(), named:[], none:[], blank:[], shared:[], malformed:[] };
      stateAccMap.set(st, s);
    }
    s.memberNames.add(row.memberName);
    const clsType = classifyDist(row.distributor).type;
    if      (clsType === "distributor") s.named.push(row);
    else if (clsType === "none")        s.none.push(row);
    else if (clsType === "blank")       s.blank.push(row);
    else if (clsType === "shared")      s.shared.push(row);
    else                                s.malformed.push(row);
  }
  // Top distributor per state by secondary OB on named retailer rows.
  const distStateOb = new Map<string, Map<string, number>>();  // state → normKey → OB
  for (const [normKey, { rows }] of distMap) {
    for (const row of rows) {
      const st = row.memberState;
      let inner = distStateOb.get(st);
      if (!inner) { inner = new Map(); distStateOb.set(st, inner); }
      inner.set(normKey, (inner.get(normKey) ?? 0) + row.orderBooking);
    }
  }
  const distCanonName = new Map<string, string>(distGroups.map((g) => [g.normKey, g.name]));

  const byState: StateDistributorRow[] = Array.from(stateAccMap.entries())
    .sort((a, b) => {
      const ca = a[1].named.length + a[1].none.length + a[1].blank.length + a[1].shared.length + a[1].malformed.length;
      const cb = b[1].named.length + b[1].none.length + b[1].blank.length + b[1].shared.length + b[1].malformed.length;
      return cb - ca;
    })
    .map(([state, s]) => {
      const retailerCount = s.named.length + s.none.length + s.blank.length + s.shared.length + s.malformed.length;
      const namedActive   = s.named.filter((r) => r.isActive).length;
      const noneActive    = s.none.filter((r) => r.isActive).length;
      const noneVisArr    = s.none.map((r) => r.totalVisit).filter((v): v is number => v !== null);
      const allVisArr     = [...s.named, ...s.none, ...s.blank, ...s.shared]
        .map((r) => r.totalVisit).filter((v): v is number => v !== null);
      const noneVis  = noneVisArr.length > 0 ? noneVisArr.reduce((a, v) => a + v, 0) : null;
      const totalVis = allVisArr.length  > 0 ? allVisArr.reduce((a, v)  => a + v, 0) : null;
      const stateOb = distStateOb.get(state);
      let topNormKey: string | null = null, topOb = 0, totalNamedOb = 0;
      if (stateOb) {
        for (const [nk, ob] of stateOb) {
          totalNamedOb += ob;
          if (ob > topOb) { topOb = ob; topNormKey = nk; }
        }
      }
      // SD4: effective counts (10,000 / HHI, HHI = Σ share%² over positive OB).
      const effCount = (values: number[]): number | null => {
        const pos = values.filter((v) => v > 0);
        const tot = pos.reduce((a, v) => a + v, 0);
        if (tot <= 0) return null;
        const hhi = pos.reduce((a, v) => a + ((v / tot) * 100) ** 2, 0);
        return hhi > 0 ? 10_000 / hhi : null;
      };
      const effectiveDistributors = effCount(stateOb ? [...stateOb.values()] : []);
      const effectiveRetailers = effCount(
        [...s.named, ...s.none, ...s.blank, ...s.shared, ...s.malformed].map((r) => r.orderBooking),
      );
      return {
        state,
        memberCount:      s.memberNames.size,
        retailerCount,
        visitCount:       totalVis,
        namedCount:       s.named.length,
        noneCount:        s.none.length,
        blankCount:       s.blank.length,
        sharedCount:      s.shared.length,
        malformedCount:   s.malformed.length,
        namedActiveCount: namedActive,
        namedActivePct:   s.named.length > 0 ? (namedActive / s.named.length) * 100 : null,
        noneActiveCount:  noneActive,
        noneActivePct:    s.none.length  > 0 ? (noneActive  / s.none.length)  * 100 : null,
        noneVisits:       noneVis,
        noneVisitSharePct:
          totalVis !== null && totalVis > 0 && noneVis !== null ? (noneVis / totalVis) * 100 : null,
        topDistributorNormKey: topNormKey,
        topDistributorName:    topNormKey ? (distCanonName.get(topNormKey) ?? topNormKey) : null,
        topDistributorObPct:   topNormKey && totalNamedOb > 0 ? (topOb / totalNamedOb) * 100 : null,
        effectiveDistributors,
        effectiveRetailers,
        // Filled from whitespace districtStats after Step 13.
        coverageGapDistricts: 0, coverageGapRetailers: 0, coverageGapPriorYearOb: 0,
        assignmentGapDistricts: 0, assignmentGapRetailers: 0, assignmentGapPriorYearOb: 0,
      };
    });

  // Step 9d: Pearson r — unassigned share vs achievement (SD2).
  const corrPts = perMember.filter(
    (m) => !m.isLeft && m.noneSharePct !== null && m.achievementTotal !== null && m.totalRetailers > 0,
  );
  const unassignedCorrelation = pearsonR(
    corrPts.map((m) => m.noneSharePct!),
    corrPts.map((m) => m.achievementTotal!),
  );
  logger.info(
    { n: corrPts.length, r: unassignedCorrelation?.toFixed(3) ?? "n/a", stateHead: selectedStateHead },
    "distributorDeepDive SD2: unassigned-vs-achievement correlation",
  );

  // Step 9e: Near-duplicate distributor name candidates (SD2).
  const namingCandidates = computeNamingCandidates(distGroups);
  logger.info({ count: namingCandidates.length }, "distributorDeepDive SD2: naming candidates");

  // Step 10 (D2): Attach primary flow data to each distributor group.
  await loadDistributorFlows(fy, selectedStateHead, distGroups);

  // Step 11 (D3): Attach SKU/segment spread from secondary_register_line.
  await loadDistributorSkuSpread(fy, distGroups);

  // Step 12 (D4): Attach investment, ROI and tier per distributor.
  await loadDistributorInvestment(fy, distGroups, d4MemberCostPerVisit);

  // Step 13 (D5): Territory whitespace and channel overlap — pure sync, no I/O.
  const toWRow = (r: RichRow): WhitespaceRow => ({
    name:         r.name,
    district:     r.district,
    city:         r.city,
    orderBooking: r.orderBooking,
    sale:         r.sale,
    visits:       r.totalVisit,
    isActive:     r.isActive,
    memberName:   r.memberName,
  });
  const whitespace = allRows.length > 0
    ? computeTerritoryWhitespace(
        distGroups,
        directDealerRows.map(toWRow),
        noneRows.map(toWRow),
      )
    : null;

  // SD4: split the whitespace gap totals per state.  District → state via
  // majority vote over the retailer rows that named the district (a district
  // practically belongs to a single member state).  Mirrors the territory-total
  // filters exactly: assignment = gapType "assignment", coverage = gapType "both".
  if (whitespace) {
    const districtStateVotes = new Map<string, Map<string, number>>();
    for (const row of allRows) {
      const d = row.district ?? "Unknown";
      let votes = districtStateVotes.get(d);
      if (!votes) { votes = new Map(); districtStateVotes.set(d, votes); }
      votes.set(row.memberState, (votes.get(row.memberState) ?? 0) + 1);
    }
    const districtToState = new Map<string, string>();
    for (const [d, votes] of districtStateVotes) {
      let best = "Unknown", bestN = -1;
      for (const [st, n] of votes) if (n > bestN) { best = st; bestN = n; }
      districtToState.set(d, best);
    }
    const byStateMap = new Map(byState.map((s) => [s.state, s] as const));
    for (const ds of whitespace.districtStats) {
      const st = byStateMap.get(districtToState.get(ds.district) ?? "Unknown");
      if (!st) continue;
      if (ds.gapType === "assignment") {
        st.assignmentGapDistricts += 1;
        st.assignmentGapRetailers += ds.noneCount;
        st.assignmentGapPriorYearOb += ds.priorYearOb;
      } else if (ds.gapType === "both") {
        st.coverageGapDistricts += 1;
        st.coverageGapRetailers += ds.directCount + ds.noneCount;
        st.coverageGapPriorYearOb += ds.priorYearOb;
      }
    }
  }

  // Step 14 (D6): Customer concentration and new vs. repeat — pure sync, no I/O.
  // Build a unified D6RetailerInput[] with channel labels from the three row sets.
  let concentration: CustomerConcentration | null = null;
  if (allRows.length > 0) {
    const d6Rows: D6RetailerInput[] = [];
    for (const g of distGroups) {
      for (const r of g.retailers) {
        d6Rows.push({
          name:           r.name,
          orderBooking:   r.orderBooking,
          sale:           r.sale,
          visits:         r.visits,
          channel:        g.name,
          isDirectDealer: false,
        });
      }
    }
    for (const r of directDealerRows) {
      d6Rows.push({
        name:           r.name,
        orderBooking:   r.orderBooking,
        sale:           r.sale,
        visits:         r.totalVisit,
        channel:        "Direct Dealer",
        isDirectDealer: true,
      });
    }
    for (const r of noneRows) {
      d6Rows.push({
        name:           r.name,
        orderBooking:   r.orderBooking,
        sale:           r.sale,
        visits:         r.totalVisit,
        channel:        "Unassigned",
        isDirectDealer: false,
      });
    }
    concentration = computeCustomerConcentration(
      d6Rows, fy, d6NewPartyOb, d6NewRetailers,
    );
  }

  // ── Step 15: D7 — retailer concentration, tier overrides, capacity check ───

  // 15a: per-distributor retailer concentration (top-5 / top-10 of own retailers)
  for (const g of distGroups) {
    const sorted = [...g.retailers].sort((a, b) => b.orderBooking - a.orderBooking);
    const top5Ob      = sorted.slice(0, 5).reduce((s, r) => s + r.orderBooking, 0);
    const top10Ob     = sorted.slice(0, 10).reduce((s, r) => s + r.orderBooking, 0);
    const totalOb     = g.orderBooking;
    const topRetailer = sorted[0] ?? null;
    g.retailerConcentration = {
      totalOb,
      top5Ob,
      top5SharePct:        totalOb > 0 ? (top5Ob / totalOb) * 100 : null,
      top10Ob,
      top10SharePct:       totalOb > 0 ? (top10Ob / totalOb) * 100 : null,
      topRetailerName:     topRetailer?.name ?? null,
      topRetailerOb:       topRetailer?.orderBooking ?? null,
      topRetailerSharePct: totalOb > 0 && topRetailer
        ? (topRetailer.orderBooking / totalOb) * 100
        : null,
    };
  }

  // 15b: load tier overrides from DB and apply them
  let overrideRows: Array<{ normKey: string; tier: string; reason: string }> = [];
  try {
    overrideRows = await db
      .select({
        normKey: distributorTierOverrideTable.normKey,
        tier:    distributorTierOverrideTable.tier,
        reason:  distributorTierOverrideTable.reason,
      })
      .from(distributorTierOverrideTable)
      .where(
        and(
          eq(distributorTierOverrideTable.stateHead, selectedStateHead),
          eq(distributorTierOverrideTable.fy, fy),
        ),
      );
  } catch (overrideErr) {
    logger.warn({ overrideErr }, "Step 15: could not load tier overrides — applying none");
  }
  const overrideMap = new Map(overrideRows.map((r) => [r.normKey, r]));
  for (const g of distGroups) {
    if (!g.investment) continue;
    const ov = overrideMap.get(g.normKey);
    if (!ov) continue;
    const newTier = ov.tier as "A" | "B" | "C";
    const actions = buildTierActions(newTier, g.activeCount);
    g.investment = {
      ...g.investment,
      tier: {
        ...g.investment.tier,
        ...actions,
        tier:           newTier,
        isOverridden:   true,
        overrideReason: ov.reason,
      },
    };
  }

  // 15c: territory-level capacity check
  const elapsedMonths = concentration?.dataCutoffMonthsElapsed ?? null;
  const breakdown = distGroups
    .filter((g) => g.investment != null)
    .map((g) => ({
      normKey:                        g.normKey,
      name:                           g.name,
      tier:                           g.investment!.tier.tier,
      demandedRetailerVisitsPerMonth: g.investment!.tier.cadenceRetailerPerMonth,
    }));
  const demandedPerMonth = breakdown.reduce((s, b) => s + b.demandedRetailerVisitsPerMonth, 0);
  let availablePerMonth: number | null = null;
  if (elapsedMonths && elapsedMonths > 0) {
    const totalYtdVisits = Array.from(memberSpreads.values()).reduce(
      (s, sp) => s + (sp.totalVisits ?? 0), 0,
    );
    availablePerMonth = totalYtdVisits > 0 ? totalYtdVisits / elapsedMonths : null;
  }
  const shortfall = availablePerMonth != null && demandedPerMonth > availablePerMonth
    ? demandedPerMonth - availablePerMonth
    : null;
  const capacityCheck: CapacityCheck = {
    availablePerMonth,
    demandedPerMonth,
    shortfallPerMonth: shortfall,
    hasShortfall:      shortfall != null,
    breakdown,
  };

  return {
    fy, stateHeads,
    distributors: distGroups,
    sharedRetailers,
    directDealer,
    noneAssigned,
    mappingQuality,
    partyObTotal,
    membersLoaded,
    membersNotMapped,
    membersFailed,
    byState,
    perMember,
    unassignedCorrelation,
    namingCandidates,
    whitespace,
    concentration,
    capacityCheck,
    error: null,
  };
}

// ── Stale-snapshot fallback (mirrors deepDiveData.ts) ─────────────────────────
//
// When the live build fails transiently (Sheets quota / cold start), the last
// successful payload — persisted in route_payload_snapshot after every good
// build — is served with a `stale` flag instead of a hard 500.  A short
// in-memory window (STALE_SERVE_MS) avoids re-reading the DB on every request
// while Sheets recovers; once it expires the live build is retried.

const STALE_SERVE_MS = 60_000;
const _staleFallback = new Map<string, { payload: DistributorDeepDiveResult; until: number }>();
const DIST_DD_SNAP_PREFIX = "dist-deep-dive|";

function distDdSnapKey(fy: string, stateHead: string | undefined): string {
  return `${DIST_DD_SNAP_PREFIX}${fy}|${(stateHead ?? "").trim().toUpperCase()}`;
}

/** Strip response-only transport flags so they are never persisted into a
 *  snapshot (and never re-served from one). */
function stripTransportFlags(p: DistributorDeepDiveResult): DistributorDeepDiveResult {
  const { stale: _s, refreshing: _r, ...clean } = p;
  return clean;
}

async function saveDistDdSnapshot(key: string, payload: DistributorDeepDiveResult): Promise<void> {
  try {
    const clean = stripTransportFlags(payload);
    await db
      .insert(routePayloadSnapshots)
      .values({ key, payload: clean as unknown as Record<string, unknown> })
      .onConflictDoUpdate({
        target: routePayloadSnapshots.key,
        set: { payload: payload as unknown as Record<string, unknown>, savedAt: new Date() },
      });
  } catch (err) {
    logger.warn({ err, key }, "distributorDeepDive: snapshot save failed (non-fatal)");
  }
}

/** Snapshot-first read for cross-head consumers (distributor directory):
 *  returns the last saved payload without attempting a live Sheets build.
 *  Null when this head has never completed a build. */
export async function loadDistDdSnapshotOnly(
  fy: string,
  stateHead: string,
): Promise<DistributorDeepDiveResult | null> {
  return (await loadDistDdSnapshot(distDdSnapKey(fy, stateHead)))?.payload ?? null;
}

export type DistDdSnapMeta = { payload: DistributorDeepDiveResult; savedAt: number };

async function loadDistDdSnapshot(key: string): Promise<DistDdSnapMeta | null> {
  try {
    const rows = await db
      .select({ payload: routePayloadSnapshots.payload, savedAt: routePayloadSnapshots.savedAt })
      .from(routePayloadSnapshots)
      .where(eq(routePayloadSnapshots.key, key))
      .limit(1);
    if (rows.length === 0) return null;
    return {
      payload: rows[0].payload as unknown as DistributorDeepDiveResult,
      savedAt: rows[0].savedAt instanceof Date ? rows[0].savedAt.getTime() : Number(rows[0].savedAt ?? 0),
    };
  } catch (err) {
    logger.warn({ err, key }, "distributorDeepDive: snapshot load failed");
    return null;
  }
}

/** A live load is complete when at least one member sheet loaded and no mapped
 *  sheet failed or timed out — only such payloads may replace the snapshot. */
export function isCompleteLoad(r: Pick<DistributorDeepDiveResult, "error" | "membersLoaded" | "membersFailed">): boolean {
  return r.error === null && r.membersLoaded > 0 && r.membersFailed === 0;
}

/** A live load is degraded when any mapped member sheet failed/timed out, or
 *  when nothing loaded at all and the payload carries an error. Member-sheet
 *  Sheets failures never throw (loadMemberSheet catches and Promise.allSettled
 *  absorbs the rest), so THIS — not an exception — is the primary transient
 *  failure signal for this route. */
export function isDegradedLoad(r: Pick<DistributorDeepDiveResult, "error" | "membersLoaded" | "membersFailed">): boolean {
  return r.membersFailed > 0 || (r.membersLoaded === 0 && r.error !== null);
}

/** Injectable dependencies so the fallback decision logic is unit-testable. */
export type ResilientDeps = {
  build: (fy: string, stateHead?: string) => Promise<DistributorDeepDiveResult>;
  loadSnap: (key: string) => Promise<DistDdSnapMeta | null>;
  saveSnap: (key: string, payload: DistributorDeepDiveResult) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  staleMap: Map<string, { payload: DistributorDeepDiveResult; until: number }>;
  /** Keys with a background refresh in flight (dedupe). */
  refreshInFlight: Set<string>;
};

const defaultDeps: ResilientDeps = {
  build: loadDistributorDeepDive,
  loadSnap: loadDistDdSnapshot,
  saveSnap: saveDistDdSnapshot,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  staleMap: _staleFallback,
  refreshInFlight: new Set<string>(),
};

// ── Snapshot-first serving (stale-while-revalidate) ───────────────────────────
// A state-head-filtered request used to trigger a full live build (~10 member
// working-sheet reads at concurrency 4 — minutes when cold) even though the
// background warmer keeps a per-head snapshot fresh. Now: a snapshot younger
// than SNAP_SERVE_MAX_AGE_MS is served immediately; if it is older than
// SNAP_REFRESH_AGE_MS, ONE background rebuild is kicked off (deduped per key)
// and, on a complete load, replaces the snapshot for the next visit.
const SNAP_SERVE_MAX_AGE_MS = 6.5 * 3_600_000; // warmer cadence (6h) + margin
const SNAP_REFRESH_AGE_MS = 15 * 60_000; // matches the member-sheet cache TTL

export async function loadDistributorDeepDiveResilientWith(
  fy: string,
  selectedStateHead: string | undefined,
  deps: ResilientDeps,
  opts?: { bypassSnapshot?: boolean },
): Promise<DistributorDeepDiveResult> {
  const key = distDdSnapKey(fy, selectedStateHead);

  // ── Fast path: serve the saved snapshot immediately (stale-while-revalidate).
  // Skipped when opts.bypassSnapshot (the background warmer must build live,
  // otherwise it would read back its own snapshot and never refresh anything).
  let preloadedSnap: DistDdSnapMeta | null | undefined;
  if (selectedStateHead && !opts?.bypassSnapshot) {
    preloadedSnap = await deps.loadSnap(key);
    if (preloadedSnap) {
      const age = deps.now() - preloadedSnap.savedAt;
      if (age <= SNAP_SERVE_MAX_AGE_MS) {
        if (age > SNAP_REFRESH_AGE_MS && !deps.refreshInFlight.has(key)) {
          deps.refreshInFlight.add(key);
          void (async () => {
            try {
              const r = await deps.build(fy, selectedStateHead);
              if (isCompleteLoad(r)) {
                deps.staleMap.delete(key);
                await deps.saveSnap(key, r);
              }
            } catch (err) {
              logger.warn({ err, fy, stateHead: selectedStateHead }, "distributorDeepDive: background snapshot refresh failed");
            } finally {
              deps.refreshInFlight.delete(key);
            }
          })();
          return { ...stripTransportFlags(preloadedSnap.payload), refreshing: true };
        }
        return stripTransportFlags(preloadedSnap.payload);
      }
      // Snapshot too old to serve blind — fall through to a live build, but
      // keep it as the failure fallback without a second DB read.
    }
  }

  const serveSnapshot = async (reason: string): Promise<DistributorDeepDiveResult | null> => {
    const cached = deps.staleMap.get(key);
    if (cached && deps.now() < cached.until) return { ...cached.payload, stale: true };
    const snap = preloadedSnap !== undefined ? preloadedSnap : await deps.loadSnap(key);
    if (!snap) return null;
    logger.warn(
      { fy, stateHead: selectedStateHead, reason },
      "distributorDeepDive: live build unusable — serving stale snapshot",
    );
    deps.staleMap.set(key, { payload: snap.payload, until: deps.now() + STALE_SERVE_MS });
    return { ...snap.payload, stale: true };
  };

  let result: DistributorDeepDiveResult | null = null;
  let buildErr: unknown = null;
  try {
    result = await deps.build(fy, selectedStateHead);
  } catch (err) {
    buildErr = err;
  }

  if (result) {
    if (!selectedStateHead) return result; // state-head list only — nothing to snapshot
    if (isCompleteLoad(result)) {
      // Only a demonstrably complete load may replace the last known-good
      // snapshot — a partial Sheets outage must never overwrite it.
      deps.staleMap.delete(key);
      void deps.saveSnap(key, result);
      return result;
    }
    if (!isDegradedLoad(result)) return result; // e.g. no sheets mapped yet
    // Degraded (some/all member sheets failed) → prefer the last saved snapshot.
    const snap = await serveSnapshot(`degraded: ${result.membersFailed} sheet(s) failed, ${result.membersLoaded} loaded`);
    if (snap) return snap;
    // No snapshot yet (first-ever load of this head) — retry the live build
    // once after a short pause; a cold quota burst often clears immediately.
    // Without this, a first visit can render "0 sheets loaded" and look like
    // a mapping fault when it is a transient Sheets failure.
    logger.warn(
      { fy, stateHead: selectedStateHead, failed: result.membersFailed, loaded: result.membersLoaded },
      "distributorDeepDive: degraded load with no snapshot — retrying once",
    );
    await deps.sleep(2_000);
    let retry: DistributorDeepDiveResult | null = null;
    try {
      retry = await deps.build(fy, selectedStateHead);
    } catch {
      /* fall through to the original partial payload */
    }
    if (retry && isCompleteLoad(retry)) {
      deps.staleMap.delete(key);
      void deps.saveSnap(key, retry);
      return retry;
    }
    // Serve whichever partial pass read more sheets.
    if (retry && retry.membersLoaded > result.membersLoaded) return retry;
    return result;
  }

  // The build itself threw (e.g. the Data-tab read failed hard).
  const snap = await serveSnapshot(buildErr instanceof Error ? buildErr.message : String(buildErr));
  if (snap) return snap;

  // No snapshot at all (first-ever load) — retry the live build once after a
  // short pause before surfacing the error to the route handler.
  logger.warn(
    { err: buildErr, fy, stateHead: selectedStateHead },
    "distributorDeepDive: live build failed with no snapshot — retrying once",
  );
  await deps.sleep(1_500);
  return deps.build(fy, selectedStateHead);
}

/**
 * Resilient entry point for GET /api/mgmt/distributor-deep-dive.
 * Complete live build → persist snapshot; transient failure (thrown OR a
 * degraded 200 payload with failed member sheets) → serve the last saved
 * snapshot with stale=true; no snapshot at all → one retry after a short
 * pause, then let the error propagate to the route's hard-error handler.
 */
export async function loadDistributorDeepDiveResilient(
  fy: string,
  selectedStateHead?: string,
  opts?: { bypassSnapshot?: boolean },
): Promise<DistributorDeepDiveResult> {
  return loadDistributorDeepDiveResilientWith(fy, selectedStateHead, defaultDeps, opts);
}
