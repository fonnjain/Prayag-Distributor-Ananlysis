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

import { db, customerMaster, saleLines, primaryOrderLines, distributorTierOverrideTable } from "@workspace/db";
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
import verifyAnchorsJson from "../../../config/verify_anchors.json" assert { type: "json" };

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
  orderBooking: number;
  sale: number;
  visits: number | null;
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
  whitespace:     TerritoryWhitespace | null;
  concentration:  CustomerConcentration | null;
  capacityCheck:  CapacityCheck | null;
  error: string | null;
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
const _anchors = verifyAnchorsJson as AnchorShape;

/** Return the list of closed month labels for a given FY, e.g. ["Apr-26","May-26","Jun-26"]. */
function closedMonthsForFy(fy: string): string[] {
  const a = _anchors.primary_anchors?.[fy];
  if (!a || typeof a !== "object") return [];
  return (a as { closedMonths?: string[] }).closedMonths ?? [];
}

/** "2026-27" → "2025-26" */
function prevFyLabel(fy: string): string {
  const p = fy.split("-");
  if (p.length !== 2) return fy;
  const start = parseInt(p[0], 10);
  return `${start - 1}-${String(start).slice(-2)}`;
}

/** Map closed months of current FY to same calendar months in prior FY.
 *  e.g. ["Apr-26","Jun-26"] → ["Apr-25","Jun-25"] */
function toPriorYearMonths(months: string[]): string[] {
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
    partyObTotal: 0, membersLoaded: 0, membersNotMapped: 0,
    whitespace: null, concentration: null, capacityCheck: null, error: null,
  });

  if (!selectedStateHead || !members.length) return empty();

  // Step 2: Load all member working sheets in parallel.
  const TIMEOUT_MS = 20_000;
  const sheetResults = await Promise.allSettled(
    members.map((m) =>
      Promise.race([
        loadMemberSheet(m.normKey, m.name, fy),
        new Promise<{ status: "error"; error: string }>((resolve) =>
          setTimeout(
            () => resolve({ status: "error", error: "timeout after 20s" }),
            TIMEOUT_MS,
          ),
        ),
      ]),
    ),
  );

  type RichRow = RetailerRow & { memberName: string };
  const allRows: RichRow[] = [];
  let membersLoaded = 0;
  let membersNotMapped = 0;
  // D4: member spreads for cost-per-visit (keyed by display name — matches memberName on rows)
  const memberSpreads = new Map<string, RetailerSpread>();

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const res = sheetResults[i];
    if (res.status === "rejected") {
      logger.warn({ member: m.name, err: res.reason }, "distributorDeepDive: sheet load rejected");
      continue;
    }
    const sheet = res.value;
    if (sheet.status === "not-mapped") { membersNotMapped++; continue; }
    if (sheet.status !== "ok") {
      logger.warn({ member: m.name, status: sheet.status }, "distributorDeepDive: sheet not ok");
      continue;
    }
    membersLoaded++;
    memberSpreads.set(m.name, sheet.spread);   // capture spread for D4
    for (const row of sheet.rows) {
      allRows.push({ ...row, memberName: m.name });
    }
  }

  if (!allRows.length) {
    return {
      ...empty(),
      membersLoaded, membersNotMapped,
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
    switch (cls.type) {
      case "blank":       directDealerRows.push(row); break;
      case "none":        noneRows.push(row);         break;
      case "malformed":   malformedRows.push(row);    break;
      case "shared":      sharedRows.push(row);       break;
      case "distributor": {
        const existing = distMap.get(cls.normKey);
        if (existing) { existing.rawNames.push(cls.raw); existing.rows.push(row); }
        else          { distMap.set(cls.normKey, { rawNames: [cls.raw], rows: [row] }); }
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
  const ddActive  = directDealerRows.filter((r) => r.isActive);
  const ddVArr    = directDealerRows.map((r) => r.totalVisit).filter((v): v is number => v !== null);
  const directDealer: DirectDealerSummary | null = directDealerRows.length > 0
    ? {
        retailerCount: directDealerRows.length,
        activeCount:   ddActive.length,
        dormantCount:  directDealerRows.length - ddActive.length,
        orderBooking:  directDealerRows.reduce((s, r) => s + r.orderBooking, 0),
        sale:          directDealerRows.reduce((s, r) => s + r.sale, 0),
        visits:        ddVArr.length > 0 ? ddVArr.reduce((s, v) => s + v, 0) : null,
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
      noneCount:      noneRows.length,
      sharedCount:    sharedRows.length,
      malformedCount: malformedRows.length,
    },
    "distributorDeepDive D1: aggregation complete",
  );

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
    whitespace,
    concentration,
    capacityCheck,
    error: null,
  };
}
