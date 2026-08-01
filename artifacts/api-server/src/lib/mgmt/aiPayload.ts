// Phase A1 — verified metrics payload.
//
// NO ANTHROPIC API CALL in this module. Zero. Every figure is computed by the
// app from already-loaded Deep Dive data. Claude receives this payload and
// writes narrative on top of it — it never does arithmetic that reaches a report.
//
// Architecture: the payload is the only thing Claude ever sees.
//   app = numbers.  Claude = judgement.
//
// Sources (in dependency order):
//   1. kpis       — MemberKpis from the State Head Dashboard Data tab.
//   2. spread     — RetailerSpread + RetailerRow[] from the member's own sheet.
//   3. visitPlan  — VisitPlan computed from the same rows.
//   4. roiCost    — RoiCost from roiCost.ts (pure computation on spread + kpis).
//   5. skuSpread  — SkuSpread from secondary_register_line (DB, closed FYs only).
//
// Rules:
//   Never console.log — use logger.
//   Never write to Google Drive.
//   No new Sheets reads — only already-loaded data.
//   Never hand raw retailer rows to Claude.

import { getMemberFileId } from "./memberSheet.js";
import type { MemberKpis } from "./deepDiveData.js";
import type { MemberSheetData, RetailerRow, RetailerSpread } from "./memberSheet.js";
import type { VisitPlan } from "./visitPlan.js";
import type { RoiCost } from "./roiCost.js";
import type { SkuSpread } from "./skuSpread.js";

// ── Calendar helpers (duplicated from visitPlan.ts to avoid circular deps) ─────

function fyStartYear(fy: string): number {
  return parseInt(fy.split("-")[0]!, 10);
}

function currentFy(): string {
  const now = new Date();
  const yr = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const fyStart = mo >= 3 ? yr : yr - 1;
  return `${fyStart}-${String(fyStart + 1).slice(-2)}`;
}

function isClosedFy(fy: string): boolean {
  return fyStartYear(fy) < fyStartYear(currentFy());
}

// Count Mon–Sat working days between two dates (inclusive).
function countWorkingDays(from: Date, to: Date): number {
  let count = 0;
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (d <= end) {
    if (d.getDay() !== 0) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// End of the last complete fiscal month (dataCutoff).
function computeDataCutoff(fy: string, asOf: Date): Date {
  const startYear = fyStartYear(fy);
  const fyStartMonth = 3; // April = 3 (0-indexed)
  const completedMonths = Math.max(
    0,
    Math.min(
      12,
      (asOf.getFullYear() - startYear) * 12 + (asOf.getMonth() - fyStartMonth),
    ),
  );
  // Last day of the last complete fiscal month.
  return new Date(startYear, 3 + completedMonths, 0);
}

function isoDate(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type DataQualityFlag = {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  fields: string[];
};

export type CustomerStateGroup = {
  count: number;
  obThisYear: number;
  obLastYear: number | null;
  visits: number;
  businessPerVisit: number | null;
};

export type CustomerStates = {
  retained: CustomerStateGroup;
  reactivated: CustomerStateGroup;
  atRisk: CustomerStateGroup;
  never: CustomerStateGroup;
};

export type TopCustomerEntry = {
  name: string;
  ob: number;
  sharePct: number;
  visits: number | null;
  channel: string;
};

export type PriorYearEntry = {
  fy: string;
  ob: number | null;
  sale: number | null;
  visitsDone: number | null;
  visitsRequired: number | null;
  coveragePct: number | null;
};

export type ProjectionScenario = {
  scenario: string;
  annual: number;
  remaining: number;
  gap: number;
};

// ── Period coverage computation ───────────────────────────────────────────────
// All AI reports use year-to-date data from the start of the FY (April).
// Derives a human-readable coverage label and a filename-safe short form from
// the data cutoff date.

export type PeriodCoverage = {
  periodCoveredLabel: string;   // "year to date, April to June 2026"
  periodCoveredShort: string;   // "YTD-Apr-Jun-2026"
  periodFromFiscalMonth: number; // always 1 (April = fiscal month 1)
  periodToFiscalMonth: number;   // e.g. 3 for June
};

const CAL_MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const FISCAL_MONTH_SHORT = [
  "Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar",
];

/**
 * Returns true only when the selected period resolves to a DIFFERENT month range
 * than the actual coverage window [1, coveredTo].
 *
 * - "ytd"          → [1, coveredTo]        — always the same, never a mismatch
 * - "q1"           → [1, 3]
 * - "q2"           → [4, 6]
 * - "q3"           → [7, 9]
 * - "q4"           → [10, 12]
 * - anything else  → treat as no mismatch (conservative)
 *
 * Example: cutoff = 30 June → coveredTo = 3. Selecting "q1" → [1,3] == [1,3]. No mismatch.
 *          Selecting "q2" → [4,6] ≠ [1,3]. Mismatch.
 */
export function isPeriodMismatch(selectedPeriod: string, coveredTo: number): boolean {
  const QUARTER: Record<string, [number, number]> = {
    q1: [1, 3], q2: [4, 6], q3: [7, 9], q4: [10, 12],
  };
  if (selectedPeriod === "ytd") return false;
  const range = QUARTER[selectedPeriod];
  if (!range) return false; // unknown, conservative
  return range[0] !== 1 || range[1] !== coveredTo;
}

export function computePeriodCovered(cutoffDate: Date): PeriodCoverage {
  const cutoffCalMonth = cutoffDate.getMonth(); // 0=Jan..11=Dec
  const cutoffYear = cutoffDate.getFullYear();

  // Fiscal month index (0-based): 0=April, 1=May, ..., 11=March
  const toFiscalIdx = (cutoffCalMonth - 3 + 12) % 12;
  const toFiscalMonth = toFiscalIdx + 1; // 1-based

  const toMonthName  = CAL_MONTH_NAMES[cutoffCalMonth];
  const toMonthShort = FISCAL_MONTH_SHORT[toFiscalIdx];

  // When the cutoff is the fiscal year end (March), the coverage IS the full
  // year — never label a closed year "year to date".
  if (toFiscalMonth === 12) {
    return {
      periodCoveredLabel: `full fiscal year, April ${cutoffYear - 1} to March ${cutoffYear}`,
      periodCoveredShort: `FY-Apr-Mar-${cutoffYear}`,
      periodFromFiscalMonth: 1,
      periodToFiscalMonth: 12,
    };
  }

  return {
    periodCoveredLabel: `year to date, April to ${toMonthName} ${cutoffYear}`,
    periodCoveredShort: `YTD-Apr-${toMonthShort}-${cutoffYear}`,
    periodFromFiscalMonth: 1,
    periodToFiscalMonth: toFiscalMonth,
  };
}

export type AiPayload = {
  identity: {
    fy: string;
    stateHead: string | null;
    member: string | null;
    hq: string | null;
    period: string;
    dataCutoff: string;
    elapsedMonths: number;
    workingDays: number | null;
    isClosedFy: boolean;
    generatedAt: string;
    summaryTabName: string | null;
    summaryTabCanonical: string | null;
    periodCoveredLabel: string;
    periodCoveredShort: string;
    periodFromFiscalMonth: number;
    periodToFiscalMonth: number;
  };
  targets: {
    monthlyTotal: number | null;
    monthlyPrimary: number | null;
    monthlySecondary: number | null;
    beBasis: "TOTAL" | "SECONDARY" | "FALLBACK";
    toDateSecondary: number | null;
    toDatePrimary: number | null;
    toDateTotal: number | null;
    annualSecondary: number | null;
    annualPrimary: number | null;
    annualTotal: number | null;
    businessPlan: number | null;
  };
  performance: {
    secondaryOB: number | null;
    directDealerOB: number | null;
    totalOB: number | null;
    salesReceived: number | null;
    /** Sheet column / data source for every figure in this object. */
    sources: {
      secondaryOB: string;
      directDealerOB: string;
      salesReceived: string;
    };
  };
  achievement: {
    totalOBPct: number | null;
    secondaryOBPct: number | null;
    directDealerPct: number | null;
    salePct: number | null;
    annualProgressPct: number | null;
  };
  coverage: {
    retailersTotal: number | null;
    active: number | null;
    dormant: number | null;
    removed: number | null;   // "Removed Parties" section row count (win-back candidates)
    visited: number | null;
    nonVisited: number | null;
    newRetailers: number | null;
    /** Sheet column / data source for every count in this object. */
    sources: {
      retailersTotal: string;
      active: string | null;
      dormant: string | null;
      removed: string | null;
      visited: string;
      visits: string | null;
    };
  };
  formerRetailers: {
    count: number;
    // Retailers grouped by their LAST ACTIVE year (the last FY in which they
    // had non-zero OB or Sale in the working sheet).
    // NOTE: this is NOT the year of removal. The sheet has no removal date.
    // A retailer last active in 2022-23 may have been removed at any point
    // after that. Clusters most likely reflect a cleanup pass, not a loss event.
    // Sorted chronologically oldest → newest.
    byLastActiveYear: Array<{
      lastActiveYear: string;  // e.g. "2022-23"
      count: number;
      totalSale: number;       // sum of lastYearSale for retailers in this bucket
      retailers: string[];
    }>;
  } | null;
  customerStates: CustomerStates | null;
  topCustomers: {
    top5: TopCustomerEntry[];
    top10: TopCustomerEntry[];
  } | null;
  concentration: {
    top5SharePct: number | null;
    top10SharePct: number | null;
    hhi: number | null;
    effectiveRetailers: number | null;
  } | null;
  visits: {
    done: number | null;
    required: number | null;
    coveragePct: number | null;
    visitedNoOrder: number | null;
    distanceBands: Array<{
      label: string;
      count: number;
      visitsDone: number;
      avgVisits: number;
      avgOb: number;
      activeCount: number;
    }>;
  } | null;
  capacity: {
    demonstratedRatePerDay: number | null;
    rateWindow: string | null;
    rateWorkingDays: number | null;
    demonstratedAnnualCapacity: Array<{ fy: string; visits: number }>;
    remainingRequired: number | null;
    feasibleRemaining: number | null;
    shortfall: number | null;
    projectionBand: ProjectionScenario[];
  } | null;
  cost: {
    ctcMonthly: number | null;
    ctcToDate: number | null;
    taBill: number | null;
    totalCost: number | null;
    costRatioOB: number | null;
    costRatioSale: number | null;
    revenueToCostOB: number | null;
    revenueToCostSale: number | null;
    costPerRetailer: number | null;
    costPerVisit: number | null;
    costPerActiveRetailer: number | null;
    marginRoiAvailable: false;
  } | null;
  productSpread: {
    segmentsSold: number;
    segmentsTotal: number;
    skuCount: number;
    netBySegment: Array<{ segment: string; net: number; sharePct: number }>;
    available: boolean;
  } | null;
  priorYears: PriorYearEntry[];
  dataQuality: DataQualityFlag[];
  provenance: Record<string, string>;
  teamSummary?: {
    memberCount: number;
    membersWithSheet: number;
    membersWithoutSheet: number;
  };
};

// ── beBasis ───────────────────────────────────────────────────────────────────

function computeBeBasis(k: MemberKpis): "TOTAL" | "SECONDARY" | "FALLBACK" {
  if (k.monthlyTarget == null) return "FALLBACK";
  if (k.primaryTargetMonthly == null) return "SECONDARY";
  const sec = k.secondaryTargetMonthly ?? 0;
  const expected = sec + k.primaryTargetMonthly;
  return Math.abs(k.monthlyTarget - expected) < 100 ? "TOTAL" : "FALLBACK";
}

// ── Customer states ───────────────────────────────────────────────────────────
// Classification uses businessPlan (> 0 → had a plan set from last year's
// activity) and totalVisit (> 0 → was visited this year) as proxies for
// prior-year status. Per-retailer prior-year OB is not in RetailerRow, so
// obLastYear is always null until a future phase adds it.
//
// retained    : active this year AND businessPlan > 0 (plan implies last-year activity)
// reactivated : active this year AND no business plan (unexpected activity)
// atRisk      : dormant this year AND (was visited OR has a plan = was expected to order)
// never       : dormant, not visited, no plan — no evidence of any prior activity

function makeGroup(rows: RetailerRow[]): CustomerStateGroup {
  const obThisYear = rows.reduce((s, r) => s + r.orderBooking, 0);
  const visits = rows.reduce((s, r) => s + (r.totalVisit ?? 0), 0);
  const bpv = visits > 0 ? obThisYear / visits : null;
  return {
    count: rows.length,
    obThisYear,
    obLastYear: null,
    visits,
    businessPerVisit: bpv,
  };
}

function computeCustomerStates(rows: RetailerRow[]): CustomerStates {
  const active  = rows.filter((r) => r.isActive);
  const dormant = rows.filter((r) => !r.isActive);

  const retained    = active.filter((r) => (r.businessPlan ?? 0) > 0);
  const reactivated = active.filter((r) => !((r.businessPlan ?? 0) > 0));

  // atRisk  = dormant AND visited AND has a business plan.
  //           Interpretation: this was a known, tracked account that the field rep
  //           visited this year but could not convert to an order. The combination
  //           of a visit (rep effort) + plan (management expectation) makes the
  //           dormancy actionable — someone needs to follow up.
  // never   = everyone else among dormant — either no visit, no plan, or both.
  //           Includes exploratory visits to new retailers (visited but no plan):
  //           one visit alone does not establish a relationship.
  const atRisk = dormant.filter(
    (r) => (r.totalVisit ?? 0) > 0 && (r.businessPlan ?? 0) > 0,
  );
  const never = dormant.filter(
    (r) => !((r.totalVisit ?? 0) > 0 && (r.businessPlan ?? 0) > 0),
  );

  return {
    retained:    makeGroup(retained),
    reactivated: makeGroup(reactivated),
    atRisk:      makeGroup(atRisk),
    never:       makeGroup(never),
  };
}

// ── Top customers ─────────────────────────────────────────────────────────────

function computeTopCustomers(
  rows: RetailerRow[],
  totalOB: number,
): { top5: TopCustomerEntry[]; top10: TopCustomerEntry[] } {
  const sorted = [...rows]
    .filter((r) => r.orderBooking > 0)
    .sort((a, b) => b.orderBooking - a.orderBooking);

  const toEntry = (r: RetailerRow): TopCustomerEntry => {
    const raw = (r.distributor ?? "").trim();
    const channel =
      !raw || raw === "--" ? "directDealer" : `distributor:${raw}`;
    return {
      name: r.name,
      ob: r.orderBooking,
      sharePct: totalOB > 0 ? (r.orderBooking / totalOB) * 100 : 0,
      visits: r.totalVisit,
      channel,
    };
  };

  return {
    top5:  sorted.slice(0, 5).map(toEntry),
    top10: sorted.slice(0, 10).map(toEntry),
  };
}

// ── Data quality flags ────────────────────────────────────────────────────────

function computeDataQualityFlags(
  kpis: MemberKpis | null,
  retailerDetail: MemberSheetData | null,
  rows: RetailerRow[],
  spread: RetailerSpread | null,
  skuSpread: SkuSpread | null,
  fy: string,
  beBasis: "TOTAL" | "SECONDARY" | "FALLBACK",
  dataCutoffDate: Date,
): DataQualityFlag[] {
  const flags: DataQualityFlag[] = [];
  const today = new Date();

  // NO_MEMBER_SHEET — no working sheet mapped.
  if (retailerDetail?.status === "not-mapped") {
    flags.push({
      code: "NO_MEMBER_SHEET",
      message:
        "No working sheet is mapped for this member. Retailer, visit, and distributor detail is unavailable; only the State Head Dashboard headline KPIs are shown.",
      severity: "warning",
      fields: ["retailersTotal", "active", "dormant", "visits", "concentration", "customerStates"],
    });
  }

  // UNASSIGNED_RETAILERS — retailers with no distributor mapping.
  if (rows.length > 0) {
    const unassigned = rows.filter(
      (r) => !r.distributor || r.distributor.trim() === "" || r.distributor.trim() === "--",
    );
    if (unassigned.length > 0) {
      flags.push({
        code: "UNASSIGNED_RETAILERS",
        message: `${unassigned.length} retailer${unassigned.length === 1 ? "" : "s"} have no distributor mapped. Their dormancy reflects a supply-mapping gap, not an effort shortfall. They cannot place orders until a distributor is assigned.`,
        severity: "warning",
        fields: ["coverage", "concentration", "customerStates"],
      });
    }
  }

  // ZERO_SALE_WITH_OB — OB present but sale exactly zero (sale column may be unmaintained).
  if (kpis && (kpis.orderBooking ?? 0) > 0 && (kpis.sale ?? 0) === 0) {
    flags.push({
      code: "ZERO_SALE_WITH_OB",
      message:
        "Order booking is present but sales received is exactly zero. The 'Sale Report' column in the State Head Dashboard may be unmaintained for this member.",
      severity: "warning",
      fields: ["performance.salesReceived", "achievement.salePct"],
    });
  }

  // PARTIAL_TENURE — working days materially below the expected Q (72 is a normal full-quarter value).
  if (kpis?.workingDaysActual != null && kpis.workingDaysActual < 55) {
    flags.push({
      code: "PARTIAL_TENURE",
      message: `Working days (${kpis.workingDaysActual}) are well below the team norm for this period. Targets and achievement ratios are not comparable at face value — pro-rated figures should be used.`,
      severity: "info",
      fields: ["achievement", "targets"],
    });
  }

  // BE_BASIS_ANOMALY — monthly target not on the total (secondary + primary) basis.
  if (beBasis === "FALLBACK") {
    flags.push({
      code: "BE_BASIS_ANOMALY",
      message:
        "The monthly target (BE) does not sum to the secondary + primary components. The combined achievement % may be misleading.",
      severity: "info",
      fields: ["targets.beBasis", "achievement.totalOBPct"],
    });
  }

  // PARTIAL_LIVE_REGISTER — FY2026-27 brand-level register covers Apr–Jun 2026
  // only (PSCode_3 backfill into secondary_register_line). Months after June
  // remain unavailable until a fresh export is loaded.
  if (skuSpread?.isLiveYear || fy === "2026-27") {
    flags.push({
      code: "PARTIAL_LIVE_REGISTER",
      message:
        "The FY2026-27 secondary register covers Apr–Jun 2026 only (PSCode_3 drop). Product-segment spread and related views reflect those three months; later months are unavailable until a fresh export is loaded.",
      severity: "info",
      fields: ["productSpread"],
    });
  }

  // GUESSED_MAPPING — distributor-to-retailer mappings that are estimated.
  if (rows.length > 0) {
    const guessed = rows.filter(
      (r) => typeof r.distributor === "string" && r.distributor.toLowerCase().includes("guess"),
    );
    if (guessed.length > 0) {
      const pct = Math.round((guessed.length / rows.length) * 100);
      flags.push({
        code: "GUESSED_MAPPING",
        message: `${guessed.length} retailer${guessed.length === 1 ? "" : "s"} (${pct}%) have a guessed distributor mapping. Distributor-level concentration figures may be approximate.`,
        severity: "info",
        fields: ["concentration", "topCustomers"],
      });
    }
  }

  // CUTOFF_LAG — data cutoff is materially older than today (>45 days).
  const lagDays = Math.round(
    (today.getTime() - dataCutoffDate.getTime()) / 86400000,
  );
  if (lagDays > 45) {
    flags.push({
      code: "CUTOFF_LAG",
      message: `Data cutoff (${isoDate(dataCutoffDate)}) is ${lagDays} days ago. Figures may not reflect recent activity.`,
      severity: "info",
      fields: ["identity.dataCutoff"],
    });
  }

  return flags;
}

// ── State Head aggregate flags ────────────────────────────────────────────────

function computeTeamQualityFlags(
  members: MemberKpis[],
  fy: string,
): DataQualityFlag[] {
  const flags: DataQualityFlag[] = [];

  const noSheet = members.filter((m) => !getMemberFileId(m.normKey));
  if (noSheet.length > 0) {
    flags.push({
      code: "NO_MEMBER_SHEET",
      message: `${noSheet.length} of ${members.length} members have no working sheet mapped: ${noSheet.map((m) => m.name).join(", ")}. Retailer, visit, and distributor detail is unavailable for these members.`,
      severity: "warning",
      fields: ["retailersTotal", "visits", "concentration"],
    });
  }

  if (fy === "2026-27") {
    flags.push({
      code: "PARTIAL_LIVE_REGISTER",
      message:
        "The FY2026-27 secondary register covers Apr–Jun 2026 only (PSCode_3 brand-level backfill). Product-segment spread reflects those three months; later months are unavailable until a fresh export is loaded.",
      severity: "info",
      fields: ["productSpread"],
    });
  }

  return flags;
}

// ── priorYears ────────────────────────────────────────────────────────────────

function computePriorYears(
  kpis: MemberKpis,
  visitPlan: VisitPlan | null,
): PriorYearEntry[] {
  const histMap = new Map<string, { visitsDone: number; visitsRequired: number; coveragePct: number | null }>();
  if (visitPlan) {
    for (const h of visitPlan.historicalFyCapacity) {
      histMap.set(h.fy, {
        visitsDone: h.totalVisitsDone,
        visitsRequired: h.totalVisitsRequired,
        coveragePct: h.coveragePct,
      });
    }
  }

  // Build a set of all FYs mentioned in historicalCapacity + lastYear quarters.
  const fys = new Set<string>(histMap.keys());

  // Derive the "last year" FY string from the current FY implied by kpis.
  // We don't have fy in scope here, so we infer from the histMap if possible.
  // If histMap is empty, we can't compute priorYears from visit data.
  const entries: PriorYearEntry[] = [];

  // Sort FYs descending (most recent first).
  const sorted = [...fys].sort((a, b) => b.localeCompare(a));

  // Assign Q1-Q4 sums to the most recent prior FY when columns are present.
  let q1234Assigned = false;
  for (const fy of sorted) {
    const hist = histMap.get(fy);
    let ob: number | null = null;
    let sale: number | null = null;

    if (!q1234Assigned) {
      const q1 = kpis.lastYearQ1;
      const q2 = kpis.lastYearQ2;
      const q3 = kpis.lastYearQ3;
      const q4 = kpis.lastYearQ4;
      const anyQ = q1 != null || q2 != null || q3 != null || q4 != null;
      if (anyQ) {
        ob = (q1 ?? 0) + (q2 ?? 0) + (q3 ?? 0) + (q4 ?? 0);
        q1234Assigned = true;
      }
    }

    entries.push({
      fy,
      ob,
      sale,
      visitsDone: hist?.visitsDone ?? null,
      visitsRequired: hist?.visitsRequired ?? null,
      coveragePct: hist?.coveragePct != null ? Math.round(hist.coveragePct * 10) / 10 : null,
    });
  }

  return entries;
}

// ── Main builder: single member ───────────────────────────────────────────────

export function buildMemberPayload(
  fy: string,
  stateHead: string | null,
  period: string,
  kpis: MemberKpis,
  retailerDetail: MemberSheetData | null,
  roiCost: RoiCost | null,
  skuSpread: SkuSpread | null,
): AiPayload {
  const now = new Date();
  const cutoffDate = computeDataCutoff(fy, now);
  const dataCutoff = isoDate(cutoffDate);
  const workingDays = countWorkingDays(
    new Date(fyStartYear(fy), 3, 1), // Apr 1
    cutoffDate,
  );

  // Prefer the member's own Data-tab working days over the calendar count.
  const actualWorkingDays = kpis.workingDaysActual ?? null;

  const rows: RetailerRow[] =
    retailerDetail?.status === "ok" ? retailerDetail.rows : [];
  const removedRows: RetailerRow[] =
    retailerDetail?.status === "ok" ? retailerDetail.removedRows : [];
  const spread: RetailerSpread | null =
    retailerDetail?.status === "ok" ? retailerDetail.spread : null;
  const visitPlan: VisitPlan | null =
    retailerDetail?.status === "ok" ? retailerDetail.visitPlan : null;

  // ── targets ────────────────────────────────────────────────────────────────
  const beBasis = computeBeBasis(kpis);
  const monthlyTotal     = kpis.monthlyTarget;
  const monthlyPrimary   = kpis.primaryTargetMonthly;
  const monthlySecondary = kpis.secondaryTargetMonthly;
  const annualSecondary  = monthlySecondary != null ? monthlySecondary * 12 : null;
  const annualPrimary    = monthlyPrimary   != null ? monthlyPrimary   * 12 : null;
  const annualTotal      = monthlyTotal     != null ? monthlyTotal     * 12 : null;

  // ── performance ────────────────────────────────────────────────────────────
  // secondaryOB = old-party OB + new-party OB (both are secondary/retailer bookings).
  // directDealerOB = primary direct-dealer bookings.  totalOB = all three.
  // The dashboard ACHIEVEMENT column = secondaryOB + directDealerOB (= totalOB here).
  const secondaryOB =
    kpis.orderBooking != null || kpis.newPartyOrderBooking != null
      ? (kpis.orderBooking ?? 0) + (kpis.newPartyOrderBooking ?? 0)
      : null;
  const directDealerOB = kpis.directDealersOrder;
  const totalOB =
    secondaryOB != null || directDealerOB != null
      ? (secondaryOB ?? 0) + (directDealerOB ?? 0)
      : null;
  const salesReceived = kpis.sale;

  // ── achievement ────────────────────────────────────────────────────────────
  const toDateTotal    = kpis.totalTargetToDate;
  const toDateSecondary = kpis.secondaryTarget;
  const toDatePrimary  = kpis.primaryTarget;

  const totalOBPct =
    totalOB != null && toDateTotal != null && toDateTotal > 0
      ? (totalOB / toDateTotal) * 100 : null;
  const secondaryOBPct =
    secondaryOB != null && toDateSecondary != null && toDateSecondary > 0
      ? (secondaryOB / toDateSecondary) * 100 : null;
  const directDealerPct =
    directDealerOB != null && toDatePrimary != null && toDatePrimary > 0
      ? (directDealerOB / toDatePrimary) * 100 : null;
  const salePct =
    salesReceived != null && toDateTotal != null && toDateTotal > 0
      ? (salesReceived / toDateTotal) * 100 : null;

  // annualProgressPct = totalOB / annualBusinessPlan × 100
  const businessPlan = spread?.annualBusinessPlan ?? null;
  const annualProgressPct =
    totalOB != null && businessPlan != null && businessPlan > 0
      ? (totalOB / businessPlan) * 100 : null;

  // ── elapsedMonths ──────────────────────────────────────────────────────────
  const elapsedMonths =
    kpis.elapsedMonths ??
    (() => {
      const startYear = fyStartYear(fy);
      const fyMo = 3;
      return Math.max(
        0,
        Math.min(12, (now.getFullYear() - startYear) * 12 + (now.getMonth() - fyMo)),
      );
    })();

  // ── coverage ───────────────────────────────────────────────────────────────
  const retailersTotal = spread?.totalRetailers ?? kpis.totalRetailers;
  const active         = spread?.activeRetailers ?? null;
  const dormant        = spread?.dormantRetailers ?? null;
  // removed: rows from the "Removed Parties" section — excluded from active/dormant
  // counts; captured for win-back. Only available when sheet is loaded.
  const removed        = spread?.removedRetailers ?? null;
  const visited        = kpis.visitedRetailers;
  const nonVisited     = kpis.nonVisitedRetailers;
  const newRetailers   =
    kpis.newPartyOrderBooking != null && kpis.businessPerRetailer != null
      ? null // count not directly available; leave null
      : null;

  // ── customer states ────────────────────────────────────────────────────────
  const customerStates = rows.length > 0 ? computeCustomerStates(rows) : null;

  // ── top customers ──────────────────────────────────────────────────────────
  const totalOBForShare = spread?.totalOrderBooking ?? 0;
  const topCustomers =
    rows.length > 0
      ? computeTopCustomers(rows, totalOBForShare)
      : null;

  // ── concentration ──────────────────────────────────────────────────────────
  const hhi = spread?.concentrationIndex ?? null;
  const concentration = spread
    ? {
        top5SharePct:       spread.top5ObShare,
        top10SharePct:      spread.top10ObShare,
        hhi,
        effectiveRetailers: hhi != null && hhi > 0 ? 10000 / hhi : null,
      }
    : null;

  // ── visits ─────────────────────────────────────────────────────────────────
  const pattern = visitPlan?.pattern;
  const vDone     = pattern?.totalVisitsDone ?? null;
  const vRequired = pattern?.totalVisitsRequired ?? null;
  const visitCoverage =
    vDone != null && vRequired != null && vRequired > 0
      ? (vDone / vRequired) * 100 : null;
  const visits = pattern
    ? {
        done:          vDone,
        required:      vRequired,
        coveragePct:   visitCoverage,
        visitedNoOrder: pattern.visitedZeroOrderCount,
        distanceBands: pattern.distanceBuckets.map((b) => ({
          label:       b.label,
          count:       b.count,
          visitsDone:  b.visitsDone,
          avgVisits:   b.avgVisits,
          avgOb:       b.avgOb,
          activeCount: b.activeCount,
        })),
      }
    : null;

  // ── capacity ───────────────────────────────────────────────────────────────
  const cap = visitPlan?.capacity;
  const hist = visitPlan?.historicalFyCapacity ?? [];
  const capacity = cap
    ? {
        demonstratedRatePerDay: cap.demonstratedVisitsPerDay,
        rateWindow:             cap.dataWindowEndDate,
        rateWorkingDays:        cap.dataCutoffWorkingDays,
        demonstratedAnnualCapacity: hist
          .sort((a, b) => b.fy.localeCompare(a.fy))
          .map((h) => ({ fy: h.fy, visits: h.totalVisitsDone })),
        remainingRequired: cap.remainingRequired,
        feasibleRemaining: cap.feasibleRemainingVisits,
        shortfall:         cap.gap < 0 ? -cap.gap : 0,
        projectionBand: [
          {
            scenario: "pessimistic",
            annual:   Math.round(cap.feasibleRemainingVisits * 0.8 + (vDone ?? 0)),
            remaining: Math.round(cap.feasibleRemainingVisits * 0.8),
            gap:       Math.round(cap.feasibleRemainingVisits * 0.8) - cap.remainingRequired,
          },
          {
            scenario: "base",
            annual:   (vDone ?? 0) + cap.feasibleRemainingVisits,
            remaining: cap.feasibleRemainingVisits,
            gap:       cap.gap,
          },
          {
            scenario: "optimistic",
            annual:   Math.round((vDone ?? 0) + cap.feasibleRemainingVisits * 1.2),
            remaining: Math.round(cap.feasibleRemainingVisits * 1.2),
            gap:       Math.round(cap.feasibleRemainingVisits * 1.2) - cap.remainingRequired,
          },
        ],
      }
    : null;

  // ── cost ───────────────────────────────────────────────────────────────────
  const cost = roiCost
    ? {
        ctcMonthly:           roiCost.ctcMonthly,
        ctcToDate:            roiCost.ctcCostYtd,
        taBill:               roiCost.taBillYtd,
        totalCost:            roiCost.totalCost,
        costRatioOB:          roiCost.costRatioPct,
        costRatioSale:        roiCost.saleToCostMultiple != null
          ? (1 / roiCost.saleToCostMultiple) * 100 : null,
        revenueToCostOB:      roiCost.obToCostMultiple,
        revenueToCostSale:    roiCost.saleToCostMultiple,
        costPerRetailer:      roiCost.costPerRetailer,
        costPerVisit:         roiCost.costPerVisit,
        costPerActiveRetailer: roiCost.costPerActiveRetailer,
        marginRoiAvailable:   false as const,
      }
    : null;

  // ── product spread ─────────────────────────────────────────────────────────
  const productSpread =
    skuSpread
      ? {
          segmentsSold:   skuSpread.distinctSegments ?? 0,
          segmentsTotal:  skuSpread.totalKnownSegments ?? 0,
          skuCount:       skuSpread.totalRows ?? 0,
          netBySegment:   (skuSpread.netBySegment ?? []).map((s) => ({
            segment:  s.segment,
            net:      s.net,
            sharePct: s.pct,
          })),
          available: !skuSpread.isLiveYear,
        }
      : { segmentsSold: 0, segmentsTotal: 0, skuCount: 0, netBySegment: [], available: false };

  // ── prior years ────────────────────────────────────────────────────────────
  const priorYears = computePriorYears(kpis, visitPlan);

  // ── data quality ───────────────────────────────────────────────────────────
  const dataQuality = computeDataQualityFlags(
    kpis, retailerDetail, rows, spread, skuSpread, fy, beBasis, cutoffDate,
  );

  // ── provenance ─────────────────────────────────────────────────────────────
  const provenance: Record<string, string> = {
    identity:       "computed (FY calendar + Data tab elapsedMonths)",
    targets:        "STATE HEAD DASHBOARD — Data tab (columns G, H, BE, BK, BM)",
    performance:    "STATE HEAD DASHBOARD — Data tab (NET = Sub Total, not Order Total)",
    achievement:    "recomputed by app (never read from sheet % cell)",
    coverage:       spread
      ? "member sheet — Summary Report tab (retailer rows)"
      : "STATE HEAD DASHBOARD — Data tab (totalOldRetailers, visitedRetailers)",
    customerStates: rows.length > 0
      ? "member sheet — Summary Report tab (businessPlan proxy for prior-year activity)"
      : "not available (no member sheet mapped)",
    topCustomers:   rows.length > 0
      ? "member sheet — Summary Report tab (orderBooking DESC)"
      : "not available",
    concentration:  spread ? "member sheet — spread computation (HHI, top-N share)" : "not available",
    visits:         visitPlan ? "member sheet — Summary Report tab (totalVisit column)" : "not available",
    capacity:       visitPlan ? "member sheet — historical Summary Report tabs (closed-FY visit anchors)" : "not available",
    cost:           roiCost ? "Data tab (CTC, TA Bill) + member sheet (spread)" : "not available (CTC missing from Data tab)",
    productSpread:  skuSpread?.isLiveYear !== false ? "not available" : "secondary_register_line (DB; FY2026-27 = PSCode_3 brand-level backfill, Apr–Jun 2026)",
    priorYears:     hist.length > 0 ? "member sheet — historical Summary Report tabs" : "not available",
    dataQuality:    "app-computed from all available sources",
  };

  const periodCoverage = computePeriodCovered(cutoffDate);

  return {
    identity: {
      fy,
      stateHead,
      member: kpis.name,
      hq: kpis.hq,
      period,
      dataCutoff,
      elapsedMonths,
      workingDays: actualWorkingDays ?? workingDays,
      isClosedFy: isClosedFy(fy),
      generatedAt: now.toISOString(),
      // Which Summary Report tab was actually read — null if the sheet had no
      // exact "Summary Report <short-FY>" tab.  Used to verify tab resolution.
      summaryTabName: retailerDetail?.status === "ok" ? retailerDetail.tabName : null,
      summaryTabCanonical: retailerDetail?.status === "ok" ? retailerDetail.canonicalName : null,
      ...periodCoverage,
    },
    targets: {
      monthlyTotal,
      monthlyPrimary,
      monthlySecondary,
      beBasis,
      toDateSecondary,
      toDatePrimary,
      toDateTotal,
      annualSecondary,
      annualPrimary,
      annualTotal,
      businessPlan,
    },
    performance: {
      secondaryOB,
      directDealerOB,
      totalOB,
      salesReceived,
      // Source labels for every count — the AI must cite these, not invent sources.
      sources: {
        secondaryOB:    "data_tab_subtotal_col",
        directDealerOB: "data_tab_directdealer_col",
        salesReceived:  "data_tab_salereport2627",  // SALEREPORT2627 column; may be overridden by stateDashboard ytdSalesReceived
      },
    },
    achievement: { totalOBPct, secondaryOBPct, directDealerPct, salePct, annualProgressPct },
    coverage: {
      retailersTotal,
      active,
      dormant,
      removed,
      visited,
      nonVisited,
      newRetailers,
      // Source labels: tells the AI (and any human reading the payload) exactly
      // which sheet and column each count comes from.
      sources: {
        retailersTotal: spread?.totalRetailers != null
          ? "member_working_file_summary_tab"
          : "data_tab_col_n",
        active:   spread?.activeRetailers   != null ? "member_working_file_summary_tab" : null,
        dormant:  spread?.dormantRetailers  != null ? "member_working_file_summary_tab" : null,
        removed:  spread?.removedRetailers  != null ? "member_working_file_removed_section" : null,
        visited:  "data_tab_visitedinamonth",   // kpis.visitedRetailers — unique retailers visited per VISITEDINAMONTH col
        visits:   pattern != null ? "member_working_file_summary_tab" : null,
      },
    },
    formerRetailers: removedRows.length > 0
      ? (() => {
          // Group by last active year (NOT year of removal — the sheet has no
          // removal date; clusters reflect cleanup passes, not loss events).
          const bucketMap = new Map<string, { totalSale: number; retailers: string[] }>();
          for (const r of removedRows) {
            const key = r.lastActiveYear ?? "unknown";
            const entry = bucketMap.get(key) ?? { totalSale: 0, retailers: [] };
            entry.totalSale += r.lastYearSale ?? 0;
            entry.retailers.push(r.name);
            bucketMap.set(key, entry);
          }
          const byLastActiveYear = [...bucketMap.entries()]
            .map(([lastActiveYear, e]) => ({ lastActiveYear, count: e.retailers.length, totalSale: e.totalSale, retailers: e.retailers }))
            .sort((a, b) => a.lastActiveYear.localeCompare(b.lastActiveYear));
          return { count: removedRows.length, byLastActiveYear };
        })()
      : null,
    customerStates,
    topCustomers,
    concentration,
    visits,
    capacity,
    cost,
    productSpread,
    priorYears,
    dataQuality,
    provenance,
  };
}

// ── Main builder: State Head aggregate (no member selected) ───────────────────

export function buildStateHeadPayload(
  fy: string,
  stateHead: string,
  period: string,
  members: MemberKpis[],
): AiPayload {
  const now = new Date();
  const cutoffDate = computeDataCutoff(fy, now);
  const dataCutoff = isoDate(cutoffDate);
  const calWorkingDays = countWorkingDays(
    new Date(fyStartYear(fy), 3, 1),
    cutoffDate,
  );

  const elapsedMonths = Math.max(
    0,
    Math.min(
      12,
      (now.getFullYear() - fyStartYear(fy)) * 12 + (now.getMonth() - 3),
    ),
  );

  // Sum performance across all members.
  // secondaryOB = old-party + new-party OB (both are retailer/secondary bookings).
  const secondaryOB    = members.reduce(
    (s, m) => s + (m.orderBooking ?? 0) + (m.newPartyOrderBooking ?? 0), 0,
  );
  const directDealerOB = members.reduce((s, m) => s + (m.directDealersOrder ?? 0), 0);
  const totalOB        = secondaryOB + directDealerOB;
  const salesReceived  = members.reduce((s, m) => s + (m.sale ?? 0), 0);

  // Sum targets.
  const toDateTotal    = members.reduce((s, m) => s + (m.totalTargetToDate ?? 0), 0) || null;
  const toDateSecondary = members.reduce((s, m) => s + (m.secondaryTarget ?? 0), 0) || null;
  const toDatePrimary  = members.reduce((s, m) => s + (m.primaryTarget ?? 0), 0) || null;
  const monthlyTotal   = members.reduce((s, m) => s + (m.monthlyTarget ?? 0), 0) || null;
  const monthlyPrimary = members.reduce((s, m) => s + (m.primaryTargetMonthly ?? 0), 0) || null;
  const monthlySecondary = monthlyTotal != null && monthlyPrimary != null
    ? monthlyTotal - monthlyPrimary : null;

  // Coverage from Data tab.
  // retailersTotal: uses totalRetailers (dashboard total, old + new party) — matches dashboard 748.
  //   Do NOT use totalOldRetailers here; that column gives only old-party retailers (679).
  const retailersTotal = members.reduce((s, m) => s + (m.totalRetailers ?? 0), 0) || null;
  // visited: uses totalVisitsYtd (dashboard col AF, all visit types: retailer + distributor + DD + leads)
  //   = 4,522 for Anant Singh active-10.  Distinct from:
  //   - visitedRetailers (VISITEDINAMONTH, unique retailers visited that month) = 665
  //   - working-sheet visits.done (retailer-only YTD visits from Summary Report) = 2,819
  const visited        = members.reduce(
    (s, m) => s + (m.totalVisitsYtd ?? m.visitedRetailers ?? 0), 0,
  ) || null;
  const nonVisited     = members.reduce((s, m) => s + (m.nonVisitedRetailers ?? 0), 0) || null;

  // Achievement.
  const totalOBPct     = toDateTotal && toDateTotal > 0 ? (totalOB / toDateTotal) * 100 : null;
  const secondaryOBPct = toDateSecondary && toDateSecondary > 0 ? (secondaryOB / toDateSecondary) * 100 : null;
  const directDealerPct = toDatePrimary && toDatePrimary > 0 ? (directDealerOB / toDatePrimary) * 100 : null;
  const salePct        = toDateTotal && toDateTotal > 0 ? (salesReceived / toDateTotal) * 100 : null;

  // Team quality flags.
  const dataQuality = computeTeamQualityFlags(members, fy);

  const membersWithSheet = members.filter((m) => getMemberFileId(m.normKey)).length;
  const membersWithoutSheet = members.length - membersWithSheet;

  const periodCoverage = computePeriodCovered(cutoffDate);

  return {
    identity: {
      fy,
      stateHead,
      member: null,
      hq: null,
      period,
      dataCutoff,
      elapsedMonths,
      workingDays: calWorkingDays,
      isClosedFy: isClosedFy(fy),
      generatedAt: now.toISOString(),
      summaryTabName: null,     // aggregate — no single member sheet
      summaryTabCanonical: null,
      ...periodCoverage,
    },
    targets: {
      monthlyTotal,
      monthlyPrimary,
      monthlySecondary,
      beBasis: "TOTAL",
      toDateSecondary,
      toDatePrimary,
      toDateTotal,
      annualSecondary: monthlySecondary != null ? monthlySecondary * 12 : null,
      annualPrimary:   monthlyPrimary   != null ? monthlyPrimary   * 12 : null,
      annualTotal:     monthlyTotal     != null ? monthlyTotal     * 12 : null,
      businessPlan: null,
    },
    performance: {
      secondaryOB,
      directDealerOB,
      totalOB,
      salesReceived,
      sources: {
        secondaryOB:    "data_tab_subtotal_col_sum_team",
        directDealerOB: "data_tab_directdealer_col_sum_team",
        salesReceived:  "data_tab_salereport2627_sum_team",
      },
    },
    achievement: { totalOBPct, secondaryOBPct, directDealerPct, salePct, annualProgressPct: null },
    coverage: {
      retailersTotal,
      active: null,
      dormant: null,
      removed: null,
      visited,
      nonVisited,
      newRetailers: null,
      sources: {
        retailersTotal: "data_tab_col_n_sum_team",
        active:   null,
        dormant:  null,
        removed:  null,
        visited:  "data_tab_visitedinamonth_sum_team",
        visits:   null,
      },
    },
    customerStates: null,
    topCustomers: null,
    concentration: null,
    visits: {
      done: visited,
      required: null,
      coveragePct: null,
      visitedNoOrder: null,
      distanceBands: [],
    },
    capacity: null,
    cost: null,
    productSpread: { segmentsSold: 0, segmentsTotal: 0, skuCount: 0, netBySegment: [], available: false },
    priorYears: [],
    formerRetailers: null, // state-head aggregate — per-member removed sections not summed here
    dataQuality,
    provenance: {
      identity:    "computed (FY calendar)",
      targets:     "STATE HEAD DASHBOARD — Data tab (summed across team members)",
      performance: "STATE HEAD DASHBOARD — Data tab (NET = Sub Total, summed across team)",
      achievement: "recomputed by app from team sums",
      coverage:    "STATE HEAD DASHBOARD — Data tab (totalOldRetailers, visitedRetailers summed)",
      dataQuality: "app-computed (member sheet map + register availability)",
    },
    teamSummary: {
      memberCount: members.length,
      membersWithSheet,
      membersWithoutSheet,
    },
  };
}
