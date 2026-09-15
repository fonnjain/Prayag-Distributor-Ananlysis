// Phase 3 / Phase 3-C: Visit-pattern analysis and forward visit plan.
//
// Phase 3-C correction (capacity model):
//   The data window must match the data, not today's date.
//   Prasun's visit data ends June 30 (Q1 complete). Dividing Q1 visits by
//   97 days (Apr 1 → Jul 23) understated the rate and inflated the gap.
//   Fix: use end-of-last-complete-fiscal-month as the window boundary.
//
//   Capacity anchor change: a quarterly rate projected annually ignores leave,
//   festivals and dead weeks. Demonstrated ANNUAL capacity from closed years
//   already embeds all of that. Use the most recent closed FY's total visits
//   as the anchor; the daily rate is kept as a pace-check only.
//
// Working-day model: Mon-Sat (6-day Indian field sales week; Sundays excluded).
// FY boundary: April 1 (start year) to March 31 (following year).
//
// Capacity model (Phase 3-C):
//   dataCutoff     = end of last complete fiscal month (NEVER today's raw date)
//   dataCutoffWorkingDays = Mon-Sat days from FY start to dataCutoff (78 for Q1)
//   demonstratedVisitsPerDay = totalDone / dataCutoffWorkingDays   (pace check)
//   annualCapacityAnchor = totalVisitsDone from most recent closed FY
//   feasibleRemainingVisits = annualAnchor - visitsDone
//   gap = feasibleRemainingVisits - remainingRequired
//
// Forward plan: one MonthVisitPlan per remaining complete month.
//   Monthly capacity allocated proportionally by working days over the remaining
//   capacity (annualAnchor - done), not by rate × working days.
//   Each month lists up to 10 target retailers, prioritised:
//     maintain → active retailers at monthly cadence (OB or sale > 0)
//     develop  → untouched dormant sorted by businessPlan / max(km,5) desc
//     reduce   → visited-but-zero-order (reduce frequency; surfaced explicitly)
//
// Rules:
//   Never console.log; use logger.
//   No writes to Google Drive.
//   Never hardcode −281; gap must be computed from historical data reads.

import type { RetailerRow } from "./memberSheet.js";
import { logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type HistoricalFyCapacity = {
  fy: string;
  totalRetailers: number;
  totalVisitsRequired: number;
  totalVisitsDone: number;
  coveragePct: number | null;   // null when totalVisitsRequired === 0 (no requirement recorded)
};

export type DistanceBucket = {
  label: string;
  minKm: number;
  maxKm: number | null;
  count: number;
  visitsDone: number;
  avgVisits: number;
  avgOb: number;
  activeCount: number;
  defaultedDistanceCount: number;
  visitsAvailableCount: number;
  unavailableVisitsCount: number;
};

export type VisitPattern = {
  totalVisitsDone: number;
  totalVisitsRequired: number;
  proRatedRequired: number;
  visitDeficit: number;
  visitedZeroOrderCount: number;
  visitedZeroOrderRetailers: string[];
  distanceBuckets: DistanceBucket[];
  unavailableTotalVisitRows: number;
  unavailableVisitsRequiredRows: number;
};

export type VisitCapacity = {
  fyStartDate: string;
  // Phase 3-C: data window = end of last complete fiscal month, NEVER today
  dataWindowEndDate: string;         // e.g. "2026-06-30" (Q1 end)
  dataCutoffWorkingDays: number | null; // null when Dashboard AG denominator is used
  demonstratedVisitsPerDay: number;  // totalDone / effective denominator
  demonstratedRateDenominator?: number;
  demonstratedRateDenominatorAuthority?: "Dashboard AG" | "calendar fallback";
  // Capacity anchor from closed-year data (not a projection)
  annualCapacityAnchor: number;      // Most recent closed FY total visits
  anchorFy: string;                  // e.g. "2025-26"
  feasibleRemainingVisits: number;   // annualAnchor − visitsDone
  remainingRequired: number;         // totalRequired − visitsDone
  gap: number;                       // feasible − required (negative = shortfall)
  workingDaysRemaining: number;      // Mon-Sat days from dataWindow+1 to FY end
  monthlyCapacity: number;           // approx feasibleRemaining / remainingForwardMonths
  unavailableTotalVisitRows: number;
  unavailableVisitsRequiredRows: number;
};

export type VisitTarget = {
  name: string;
  district: string | null;
  distanceKm: number | null;
  ob: number;
  businessPlan: number | null;
  visitsDone: number;
  /** Raw totalVisit when recorded; null is never rendered as a genuine zero. */
  visitsDoneRecorded: number | null;
  effectiveInputs: {
    businessPlan: number;
    distanceKm: number;
    visitsRequired: number;
  };
  /** Every input is either measured, unavailable (with a reason), or a real zero. */
  inputStates: {
    businessPlan: "recorded" | "unavailable";
    distanceKm: "recorded" | "unavailable";
    visitsRequired: "recorded" | "unavailable";
    totalVisit: "recorded" | "unavailable";
  };
  inputReasons: Partial<Record<"businessPlan" | "distanceKm" | "visitsRequired" | "totalVisit", string>>;
  defaultedInputs: Array<"businessPlan" | "distanceKm" | "visitsRequired">;
  priorityScore: number;
  priority: "maintain" | "develop" | "reduce";
  reason: string;
};

export type MonthVisitPlan = {
  month: string;
  workingDays: number;
  capacity: number;           // proportional share of feasibleRemainingVisits
  maintenanceVisits: number;
  developmentVisits: number;
  targets: VisitTarget[];
  poolExhausted: boolean;     // true when no develop-pool retailers remain for this month
};

export type VisitPlan = {
  pattern: VisitPattern;
  capacity: VisitCapacity;
  historicalFyCapacity: HistoricalFyCapacity[];
  monthPlans: MonthVisitPlan[];
  totalFeasible: number;   // sum of month capacities (may differ by 1–2 from feasibleRemaining due to rounding)
  totalRequired: number;   // = capacity.remainingRequired
  gap: number;             // = capacity.gap (anchor-based, not recomputed from totalFeasible)
  unassignedExcluded: number; // retailers with no distributor — excluded from forward scheduling
  /** Counts describe recorded rows only; defaults never enter a count total. */
  unavailableCounts: {
    totalVisit: number;
    visitsRequired: number;
    businessPlan: number;
    distanceKm: number;
  };
  defaultedTargetCount: number;
  defaultedRankCount: number;
};

export type VisitInputState = "recorded" | "unavailable";

export function inputState(value: number | null): VisitInputState {
  return value === null ? "unavailable" : "recorded";
}

function recordedSum(rows: RetailerRow[], field: "totalVisit" | "visitsRequired"): number {
  return rows.reduce((sum, row) => {
    const value = row[field];
    return value === null ? sum : sum + value;
  }, 0);
}

function unavailableCount(rows: RetailerRow[], field: "totalVisit" | "visitsRequired" | "businessPlan" | "distanceKm"): number {
  return rows.filter((row) => row[field] === null).length;
}

// ── Calendar helpers ───────────────────────────────────────────────────────────

function countWorkingDays(from: Date, to: Date): number {
  let count = 0;
  const d   = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(),   to.getMonth(),   to.getDate());
  while (d <= end) {
    if (d.getDay() !== 0) count++;  // 0 = Sunday
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function workingDaysForMonth(year: number, month0: number): number {
  const from = new Date(year, month0, 1);
  const to   = new Date(year, month0 + 1, 0);
  return countWorkingDays(from, to);
}

function fyStartYear(fy: string): number {
  return parseInt(fy.split("-")[0]!, 10);
}

function fyStart(fy: string): Date {
  return new Date(fyStartYear(fy), 3, 1);  // April 1
}

function fyEnd(fy: string): Date {
  return new Date(fyStartYear(fy) + 1, 2, 31);  // March 31
}

function isoDate(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Number of whole fiscal months that have ENDED before asOf.
// Example: FY2026-27, asOf = Jul 23 → Apr, May, Jun complete → 3.
// July is in-progress and does NOT count.
// This is derived from calendar month boundaries, not from today's raw date.
function completeFiscalMonths(fy: string, asOf: Date): number {
  const startYear = fyStartYear(fy);
  const fyStartMonth = 3;  // April = 3 (0-indexed)
  const months =
    (asOf.getFullYear() - startYear) * 12 +
    (asOf.getMonth() - fyStartMonth);
  return Math.max(0, Math.min(12, months));
}

// Elapsed fractional months since FY start (day-accurate, for pro-rated target).
function elapsedFractionalMonths(start: Date, asOf: Date): number {
  const daysInMonth = new Date(
    asOf.getFullYear(), asOf.getMonth() + 1, 0,
  ).getDate();
  const months =
    (asOf.getFullYear() - start.getFullYear()) * 12 +
    (asOf.getMonth()    - start.getMonth()) +
    asOf.getDate() / daysInMonth;
  return Math.max(0, months);
}

const MONTH_LABELS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

/** Canonical persisted/display label used by every visit-plan API. */
export function canonicalMonthLabel(fy: string, value: string): string | null {
  const match = value.trim().match(/^([A-Za-z]{3,9})[\s-]+(\d{2}|\d{4})$/);
  if (!match) return null;
  const monthIndex = MONTH_LABELS.findIndex((label) =>
    label.toLowerCase() === match[1]!.slice(0, 3).toLowerCase());
  if (monthIndex < 0) return null;
  const startYear = fyStartYear(fy);
  const yearValue = Number(match[2]);
  const year = match[2]!.length === 2
    ? (yearValue >= 70 ? 1900 + yearValue : 2000 + yearValue)
    : yearValue;
  const expectedYear = monthIndex >= 3 ? startYear : startYear + 1;
  return year === expectedYear ? `${MONTH_LABELS[monthIndex]} ${String(year).slice(-2)}` : null;
}

export function forwardMonthChoices(fy: string, asOf = new Date()): string[] {
  const end = fyEnd(fy);
  const choices: string[] = [];
  let year = asOf.getFullYear();
  let month = asOf.getMonth() + 1;
  if (month > 11) { month = 0; year++; }
  while (new Date(year, month, 1) <= end) {
    choices.push(`${MONTH_LABELS[month]} ${String(year).slice(-2)}`);
    month++;
    if (month > 11) { month = 0; year++; }
  }
  // A future FY should expose all twelve months, while an ended FY exposes
  // none. Do not silently expose dates outside the requested fiscal year.
  return choices.filter((label) => canonicalMonthLabel(fy, label) !== null);
}

// ── Visit-pattern analysis ─────────────────────────────────────────────────────

function computePattern(
  rows: RetailerRow[],
  elapsedMonths: number,
): VisitPattern {
  const totalVisitsDone     = recordedSum(rows, "totalVisit");
  const totalVisitsRequired = recordedSum(rows, "visitsRequired");
  const proRatedRequired = Math.round(
    totalVisitsRequired * (elapsedMonths / 12),
  );
  const visitDeficit = proRatedRequired - totalVisitsDone;

  const zeroOrder = rows.filter(
    (r) => (r.totalVisit ?? 0) > 0 && r.orderBooking === 0 && r.sale === 0,
  );

  const BUCKETS: { label: string; minKm: number; maxKm: number | null }[] = [
    { label: "Near (<=15 km)", minKm: 0,  maxKm: 15 },
    { label: "Mid (15-40 km)", minKm: 15, maxKm: 40 },
    { label: "Far (>40 km)",   minKm: 40, maxKm: null },
  ];

  const distanceBuckets: DistanceBucket[] = BUCKETS.map((b) => {
    const bucket = rows.filter((r) => {
      // A missing distance is not a measured 20 km. The fallback is used only
      // to keep a target rank useful and is exposed on the target below.
      const km = r.distanceKm ?? 20;
      return km >= b.minKm && (b.maxKm === null || km < b.maxKm);
    });
    const visitsDone = bucket.reduce((s, r) => s + (r.totalVisit ?? 0), 0);
    const visitsAvailable = bucket.filter((r) => r.totalVisit !== null);
    const totalOb    = bucket.reduce((s, r) => s + r.orderBooking, 0);
    return {
      label:      b.label,
      minKm:      b.minKm,
      maxKm:      b.maxKm,
      count:      bucket.length,
      visitsDone,
      avgVisits:
        visitsAvailable.length > 0
          ? Math.round((visitsDone / visitsAvailable.length) * 10) / 10
          : 0,
      avgOb:
        bucket.length > 0
          ? Math.round(totalOb / bucket.length)
          : 0,
      activeCount: bucket.filter((r) => r.isActive).length,
      defaultedDistanceCount: bucket.filter((r) => r.distanceKm === null).length,
      visitsAvailableCount: visitsAvailable.length,
      unavailableVisitsCount: bucket.length - visitsAvailable.length,
    };
  });

  return {
    totalVisitsDone,
    totalVisitsRequired,
    proRatedRequired,
    visitDeficit,
    visitedZeroOrderCount: zeroOrder.length,
    visitedZeroOrderRetailers: zeroOrder.map((r) => r.name).slice(0, 30),
    distanceBuckets,
    unavailableTotalVisitRows: unavailableCount(rows, "totalVisit"),
    unavailableVisitsRequiredRows: unavailableCount(rows, "visitsRequired"),
  };
}

// ── Capacity model (Phase 3-C corrected) ──────────────────────────────────────

function computeCapacity(
  rows: RetailerRow[],
  fy: string,
  historicalCapacity: HistoricalFyCapacity[],
  asOf: Date,
  workingDaysActual?: number, // AG col from dashboard — member's own working days
): VisitCapacity {
  const start = fyStart(fy);
  const end   = fyEnd(fy);

  // Data window = end of last complete fiscal month.
  // This is a month-boundary inference, NOT today's raw date.
  const completedMonths = completeFiscalMonths(fy, asOf);
  const startYear = fyStartYear(fy);
  // Day-0 of month (3 + completedMonths + 1) = last day of month (3 + completedMonths)
  const dataCutoff = new Date(startYear, 3 + completedMonths, 0);

  const dataCutoffWorkingDays = Math.max(1, countWorkingDays(start, dataCutoff));
  const totalVisitsDone       = rows.reduce((s, r) => s + (r.totalVisit ?? 0), 0);
  // A4-B: use member's own dashboard working days when available (AG col).
  // Fall back to calendar working days so memberSheet.ts callers stay unchanged.
  const effectiveWorkingDays  = workingDaysActual && workingDaysActual > 0
    ? workingDaysActual
    : dataCutoffWorkingDays;
  const demonstratedRate      = totalVisitsDone / effectiveWorkingDays;

  // Annual capacity anchor: most recent closed FY's actual total visits.
  // Sorted descending so [0] = most recent.
  const sortedHist = [...historicalCapacity].sort((a, b) =>
    b.fy.localeCompare(a.fy),
  );
  const anchorEntry = sortedHist[0];

  // Fallback if no closed-year history: project demonstrated rate across full FY.
  const totalFyWorkingDays = countWorkingDays(start, end);
  const annualCapacityAnchor = anchorEntry
    ? anchorEntry.totalVisitsDone
    : Math.round(demonstratedRate * totalFyWorkingDays);
  const anchorFy = anchorEntry?.fy ?? "estimate";

  const totalVisitsRequired      = rows.reduce((s, r) => s + (r.visitsRequired ?? 0), 0);
  const feasibleRemainingVisits  = Math.max(0, annualCapacityAnchor - totalVisitsDone);
  const remainingRequired        = Math.max(0, totalVisitsRequired - totalVisitsDone);
  const gap                      = feasibleRemainingVisits - remainingRequired;

  // Working days remaining (from day after dataCutoff to FY end) — for reference.
  const nextDay = new Date(dataCutoff);
  nextDay.setDate(nextDay.getDate() + 1);
  const workingDaysRemaining = nextDay <= end
    ? countWorkingDays(nextDay, end)
    : 0;

  // Remaining complete months (from asOf + 1 → FY end) for forward plan.
  let remainingForwardMonths = 0;
  const cur = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 1);
  while (cur <= end) {
    remainingForwardMonths++;
    cur.setMonth(cur.getMonth() + 1);
  }
  const monthlyCapacity =
    remainingForwardMonths > 0
      ? Math.round(feasibleRemainingVisits / remainingForwardMonths)
      : 0;

  return {
    fyStartDate:              isoDate(start),
    dataWindowEndDate:        isoDate(dataCutoff),
    dataCutoffWorkingDays: workingDaysActual && workingDaysActual > 0 ? null : dataCutoffWorkingDays,
    demonstratedRateDenominator: effectiveWorkingDays,
    demonstratedRateDenominatorAuthority: workingDaysActual && workingDaysActual > 0
      ? "Dashboard AG"
      : "calendar fallback",
    demonstratedVisitsPerDay: Math.round(demonstratedRate * 100) / 100,
    annualCapacityAnchor,
    anchorFy,
    feasibleRemainingVisits,
    remainingRequired,
    gap,
    workingDaysRemaining,
    monthlyCapacity,
    unavailableTotalVisitRows: unavailableCount(rows, "totalVisit"),
    unavailableVisitsRequiredRows: unavailableCount(rows, "visitsRequired"),
  };
}

// ── Forward visit plan ─────────────────────────────────────────────────────────

export const VISIT_PLAN_DEFAULTS = {
  businessPlan: 50_000,
  distanceKm: 20,
  visitsRequired: 12,
} as const;

export function plannerPriorityScore(r: RetailerRow): number {
  const bp = r.businessPlan ?? VISIT_PLAN_DEFAULTS.businessPlan;
  const km = Math.max(r.distanceKm ?? VISIT_PLAN_DEFAULTS.distanceKm, 5);
  return bp / km;
}

export function plannerTargetInputMetadata(r: RetailerRow) {
  const defaultedInputs = [
    ...(r.businessPlan === null ? ["businessPlan" as const] : []),
    ...(r.distanceKm === null ? ["distanceKm" as const] : []),
    ...(r.visitsRequired === null ? ["visitsRequired" as const] : []),
  ];
  return {
    priorityScore: plannerPriorityScore(r),
    defaultedInputs,
    inputStates: {
      businessPlan: inputState(r.businessPlan),
      distanceKm: inputState(r.distanceKm),
      visitsRequired: inputState(r.visitsRequired),
      totalVisit: inputState(r.totalVisit),
    },
    inputReasons: {
      ...(r.businessPlan === null ? { businessPlan: "not recorded in member sheet" } : {}),
      ...(r.distanceKm === null ? { distanceKm: "not recorded in member sheet; 20 km ranking fallback used" } : {}),
      ...(r.visitsRequired === null ? { visitsRequired: "not recorded in member sheet; 12 visit planning fallback used" } : {}),
      ...(r.totalVisit === null ? { totalVisit: "not recorded in member sheet; completion cannot be inferred" } : {}),
    },
    effectiveInputs: {
      businessPlan: r.businessPlan ?? VISIT_PLAN_DEFAULTS.businessPlan,
      distanceKm: r.distanceKm ?? VISIT_PLAN_DEFAULTS.distanceKm,
      visitsRequired: r.visitsRequired ?? VISIT_PLAN_DEFAULTS.visitsRequired,
    },
  };
}

export type StateHeadMonthPaceRecord = {
  stateHead: string | null;
  month: string;
  sourceSnapshotHash: string | null;
  pattern: { totalVisitsDone?: number; proRatedRequired?: number };
  capacity: {
    gap?: number;
    demonstratedRateDenominator?: number;
    demonstratedRateDenominatorAuthority?: "Dashboard AG" | "calendar fallback";
    dataWindowEndDate?: string;
  };
};

export function aggregateStateHeadMonthPace(records: StateHeadMonthPaceRecord[]) {
  const grouped = new Map<string, {
    stateHead: string; month: string; visitsDone: number; proRatedRequired: number;
    capacityGap: number; numerator: number; denominator: number;
    authorities: Set<string>; snapshots: Set<string>; cutoffs: Set<string>;
  }>();
  for (const record of records) {
    const stateHead = record.stateHead ?? "Unassigned";
    const key = `${stateHead}\u0000${record.month}`;
    const current = grouped.get(key) ?? {
      stateHead, month: record.month, visitsDone: 0, proRatedRequired: 0,
      capacityGap: 0, numerator: 0, denominator: 0,
      authorities: new Set<string>(), snapshots: new Set<string>(), cutoffs: new Set<string>(),
    };
    const done = Number(record.pattern.totalVisitsDone ?? 0);
    current.visitsDone += done;
    current.proRatedRequired += Number(record.pattern.proRatedRequired ?? 0);
    current.capacityGap += Number(record.capacity.gap ?? 0);
    current.numerator += done;
    current.denominator += Number(record.capacity.demonstratedRateDenominator ?? 0);
    current.authorities.add(record.capacity.demonstratedRateDenominatorAuthority ?? "calendar fallback");
    if (record.sourceSnapshotHash) current.snapshots.add(record.sourceSnapshotHash);
    if (record.capacity.dataWindowEndDate) current.cutoffs.add(record.capacity.dataWindowEndDate);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((current) => ({
    stateHead: current.stateHead,
    month: current.month,
    paceVisitsDone: current.visitsDone,
    paceProRatedRequired: current.proRatedRequired,
    paceDeficit: current.proRatedRequired - current.visitsDone,
    capacityGap: current.capacityGap,
    demonstratedRateNumerator: current.numerator,
    demonstratedRateDenominator: current.denominator,
    demonstratedRate: current.denominator > 0 ? current.numerator / current.denominator : null,
    demonstratedRateAuthority: current.authorities.size === 1
      ? [...current.authorities][0]
      : "mixed: Dashboard AG + calendar fallback",
    authorityMix: [...current.authorities],
    sourceSnapshotDisclosure: {
      mixed: current.snapshots.size > 1 || current.cutoffs.size > 1,
      sourceSnapshotHashes: [...current.snapshots],
      cutoffDates: [...current.cutoffs],
    },
  }));
}

function computeForwardPlan(
  rows: RetailerRow[],
  capacity: VisitCapacity,
  fy: string,
  asOf: Date,
): MonthVisitPlan[] {
  const end = fyEnd(fy);

  // A4-B: retailers with no distributor cannot place orders — exclude from all
  // forward scheduling. Active retailers are maintained regardless (their
  // existing orders prove a supply path; null distributor column is a data gap).
  const schedulableDormant = rows.filter((r) => !r.isActive && !!r.distributor);

  const active      = rows.filter((r) => r.isActive);
  const visitedNoOb = schedulableDormant.filter((r) => (r.totalVisit ?? 0) > 0);
  // A real recorded zero means "never tried". An unavailable totalVisit is
  // deliberately kept in the development pool, but is not counted as zero.
  // Only a recorded zero proves "never visited". An unavailable count is not
  // eligible for the never-visited development pool and remains visible via
  // the source-state metadata instead.
  const untouched   = schedulableDormant.filter((r) => r.totalVisit === 0);

  // A4-B: developPool must DECREMENT — splice removes each batch from the pool
  // so later months draw the next tranche and never repeat names. When the pool
  // is empty, poolExhausted = true is signalled rather than looping.
  const developPool = [...untouched].sort(
    (a, b) => plannerPriorityScore(b) - plannerPriorityScore(a),
  );
  const reducePool  = [...visitedNoOb].sort(
    (a, b) => plannerPriorityScore(b) - plannerPriorityScore(a),
  );

  function monthlyCadence(r: RetailerRow): number {
    return Math.max(1, Math.round((r.visitsRequired ?? VISIT_PLAN_DEFAULTS.visitsRequired) / 12));
  }
  const totalMonthlyCadence = active.reduce(
    (s, r) => s + monthlyCadence(r), 0,
  );

  // Collect all remaining complete months first (needed for proportional allocation).
  const monthsInfo: { year: number; month0: number; wd: number }[] = [];
  let curYear  = asOf.getFullYear();
  let curMonth = asOf.getMonth() + 1;
  if (curMonth > 11) { curMonth = 0; curYear++; }

  while (true) {
    const monthStart = new Date(curYear, curMonth, 1);
    if (monthStart > end) break;
    monthsInfo.push({
      year:   curYear,
      month0: curMonth,
      wd:     workingDaysForMonth(curYear, curMonth),
    });
    curMonth++;
    if (curMonth > 11) { curMonth = 0; curYear++; }
  }

  // Total remaining working days — denominator for proportional distribution.
  const totalRemainingWd = monthsInfo.reduce((s, m) => s + m.wd, 0);
  const feasible = capacity.feasibleRemainingVisits;

  const plans: MonthVisitPlan[] = [];

  for (const { year, month0, wd } of monthsInfo) {
    // Proportional share of the annual-anchor-derived remaining capacity.
    const cap      = totalRemainingWd > 0
      ? Math.round(feasible * wd / totalRemainingWd)
      : 0;
    const maintain = Math.min(cap, totalMonthlyCadence);
    const devBudget = Math.max(0, cap - maintain);

    const monthLabel = `${MONTH_LABELS[month0]} ${String(year).slice(-2)}`;

    const targets: VisitTarget[] = [];

    const topActive = [...active]
      .sort((a, b) => b.orderBooking - a.orderBooking)
      .slice(0, 5);
    for (const r of topActive) {
      const defaultedInputs = [
        ...(r.businessPlan === null ? ["businessPlan" as const] : []),
        ...(r.distanceKm === null ? ["distanceKm" as const] : []),
        ...(r.visitsRequired === null ? ["visitsRequired" as const] : []),
      ];
      targets.push({
        name:         r.name,
        district:     r.district,
        distanceKm:   r.distanceKm,
        ob:           r.orderBooking,
        businessPlan: r.businessPlan,
        visitsDone:   r.totalVisit ?? 0,
        visitsDoneRecorded: r.totalVisit,
        effectiveInputs: {
          businessPlan: r.businessPlan ?? VISIT_PLAN_DEFAULTS.businessPlan,
          distanceKm: r.distanceKm ?? VISIT_PLAN_DEFAULTS.distanceKm,
          visitsRequired: r.visitsRequired ?? VISIT_PLAN_DEFAULTS.visitsRequired,
        },
        inputStates: {
          businessPlan: inputState(r.businessPlan),
          distanceKm: inputState(r.distanceKm),
          visitsRequired: inputState(r.visitsRequired),
          totalVisit: inputState(r.totalVisit),
        },
        inputReasons: {
          ...(r.businessPlan === null ? { businessPlan: "not recorded in member sheet" } : {}),
          ...(r.distanceKm === null ? { distanceKm: "not recorded in member sheet; 20 km ranking fallback used" } : {}),
          ...(r.visitsRequired === null ? { visitsRequired: "not recorded in member sheet; 12 visit planning fallback used" } : {}),
          ...(r.totalVisit === null ? { totalVisit: "not recorded in member sheet; completion cannot be inferred" } : {}),
        },
        defaultedInputs,
        priorityScore: plannerPriorityScore(r),
        priority:     "maintain",
        reason:       `Active · OB ${(r.orderBooking / 100_000).toFixed(1)} L`,
      });
    }

    const devSlots = Math.max(0, 10 - targets.length);
    // A4-B: splice removes the drawn batch so each month draws the NEXT tranche.
    // poolExhausted = true when we want development slots but the pool is empty.
    const poolExhausted = devSlots > 0 && developPool.length === 0;
    const devBatch = developPool.splice(0, Math.min(developPool.length, devSlots));
    for (const r of devBatch) {
      const defaultedInputs = [
        ...(r.businessPlan === null ? ["businessPlan" as const] : []),
        ...(r.distanceKm === null ? ["distanceKm" as const] : []),
        ...(r.visitsRequired === null ? ["visitsRequired" as const] : []),
      ];
      targets.push({
        name:         r.name,
        district:     r.district,
        distanceKm:   r.distanceKm,
        ob:           r.orderBooking,
        businessPlan: r.businessPlan,
        visitsDone:   r.totalVisit ?? 0,
        visitsDoneRecorded: r.totalVisit,
        effectiveInputs: {
          businessPlan: r.businessPlan ?? VISIT_PLAN_DEFAULTS.businessPlan,
          distanceKm: r.distanceKm ?? VISIT_PLAN_DEFAULTS.distanceKm,
          visitsRequired: r.visitsRequired ?? VISIT_PLAN_DEFAULTS.visitsRequired,
        },
        inputStates: {
          businessPlan: inputState(r.businessPlan),
          distanceKm: inputState(r.distanceKm),
          visitsRequired: inputState(r.visitsRequired),
          totalVisit: inputState(r.totalVisit),
        },
        inputReasons: {
          ...(r.businessPlan === null ? { businessPlan: "not recorded in member sheet" } : {}),
          ...(r.distanceKm === null ? { distanceKm: "not recorded in member sheet; 20 km ranking fallback used" } : {}),
          ...(r.visitsRequired === null ? { visitsRequired: "not recorded in member sheet; 12 visit planning fallback used" } : {}),
          ...(r.totalVisit === null ? { totalVisit: "not recorded in member sheet; completion cannot be inferred" } : {}),
        },
        defaultedInputs,
        priorityScore: plannerPriorityScore(r),
        priority:     "develop",
        reason:       `Dormant · Plan ${((r.businessPlan ?? 0) / 100_000).toFixed(1)} L`,
      });
    }

    if (targets.length < 10 && reducePool.length > 0) {
      const r = reducePool[0]!;
      const defaultedInputs = [
        ...(r.businessPlan === null ? ["businessPlan" as const] : []),
        ...(r.distanceKm === null ? ["distanceKm" as const] : []),
        ...(r.visitsRequired === null ? ["visitsRequired" as const] : []),
      ];
      targets.push({
        name:         r.name,
        district:     r.district,
        distanceKm:   r.distanceKm,
        ob:           r.orderBooking,
        businessPlan: r.businessPlan,
        visitsDone:   r.totalVisit ?? 0,
        visitsDoneRecorded: r.totalVisit,
        effectiveInputs: {
          businessPlan: r.businessPlan ?? VISIT_PLAN_DEFAULTS.businessPlan,
          distanceKm: r.distanceKm ?? VISIT_PLAN_DEFAULTS.distanceKm,
          visitsRequired: r.visitsRequired ?? VISIT_PLAN_DEFAULTS.visitsRequired,
        },
        inputStates: {
          businessPlan: inputState(r.businessPlan),
          distanceKm: inputState(r.distanceKm),
          visitsRequired: inputState(r.visitsRequired),
          totalVisit: inputState(r.totalVisit),
        },
        inputReasons: {
          ...(r.businessPlan === null ? { businessPlan: "not recorded in member sheet" } : {}),
          ...(r.distanceKm === null ? { distanceKm: "not recorded in member sheet; 20 km ranking fallback used" } : {}),
          ...(r.visitsRequired === null ? { visitsRequired: "not recorded in member sheet; 12 visit planning fallback used" } : {}),
          ...(r.totalVisit === null ? { totalVisit: "not recorded in member sheet; completion cannot be inferred" } : {}),
        },
        defaultedInputs,
        priorityScore: plannerPriorityScore(r),
        priority:     "reduce",
        reason:       `Visited ${r.totalVisit ?? 0}x · zero OB · deprioritise`,
      });
    }

    targets.sort((a, b) => {
      const da = a.district ?? "\uFFFF";
      const db = b.district ?? "\uFFFF";
      if (da !== db) return da.localeCompare(db);
      return (a.distanceKm ?? 999) - (b.distanceKm ?? 999);
    });

    plans.push({
      month:             monthLabel,
      workingDays:       wd,
      capacity:          cap,
      maintenanceVisits: maintain,
      developmentVisits: devBudget,
      targets,
      poolExhausted,
    });
  }

  return plans;
}

// ── Public entry point ─────────────────────────────────────────────────────────

export function computeVisitPlan(
  rows: RetailerRow[],
  fy: string,
  historicalCapacity: HistoricalFyCapacity[],
  asOf?: Date,
  workingDaysActual?: number, // A4-B: member's own dashboard working days (AG col)
): VisitPlan {
  const now     = asOf ?? new Date();
  const start   = fyStart(fy);
  const elapsed = elapsedFractionalMonths(start, now);

  // A4-B: count retailers excluded from forward scheduling (no distributor).
  const unassignedExcluded = rows.filter((r) => !r.distributor).length;

  const pattern    = computePattern(rows, elapsed);
  const capacity   = computeCapacity(rows, fy, historicalCapacity, now, workingDaysActual);
  const monthPlans = computeForwardPlan(rows, capacity, fy, now);

  const totalFeasible = monthPlans.reduce((s, m) => s + m.capacity, 0);
  const totalRequired = capacity.remainingRequired;
  // Gap is anchor-based (from capacity model), not recomputed from rounding artifacts.
  const gap = capacity.gap;
  const selectedTargets = monthPlans.flatMap((month) => month.targets);
  const defaultedTargetCount = selectedTargets.filter((target) => target.defaultedInputs.length > 0).length;
  const defaultedRankCount = selectedTargets.filter(
    (target) => target.defaultedInputs.includes("businessPlan") && target.defaultedInputs.includes("distanceKm"),
  ).length;

  logger.info(
    {
      fy,
      dataWindowEndDate:        capacity.dataWindowEndDate,
      dataCutoffWorkingDays:    capacity.dataCutoffWorkingDays,
      totalVisitsDone:          pattern.totalVisitsDone,
      totalVisitsRequired:      pattern.totalVisitsRequired,
      demonstratedVisitsPerDay: capacity.demonstratedVisitsPerDay,
      anchorFy:                 capacity.anchorFy,
      annualCapacityAnchor:     capacity.annualCapacityAnchor,
      feasibleRemainingVisits:  capacity.feasibleRemainingVisits,
      remainingRequired:        totalRequired,
      gap,
      monthsPlanned:            monthPlans.length,
      historicalFys:            historicalCapacity.map((h) => `${h.fy}:${h.totalVisitsDone}`),
      unavailableCounts: {
        totalVisit: unavailableCount(rows, "totalVisit"),
        visitsRequired: unavailableCount(rows, "visitsRequired"),
        businessPlan: unavailableCount(rows, "businessPlan"),
        distanceKm: unavailableCount(rows, "distanceKm"),
      },
      defaultedTargetCount,
      defaultedRankCount,
    },
    "visitPlan: computed — verify against acceptance criteria",
  );

  return {
    pattern,
    capacity,
    historicalFyCapacity: historicalCapacity,
    monthPlans,
    totalFeasible,
    totalRequired,
    gap,
    unassignedExcluded,
    unavailableCounts: {
      totalVisit: unavailableCount(rows, "totalVisit"),
      visitsRequired: unavailableCount(rows, "visitsRequired"),
      businessPlan: unavailableCount(rows, "businessPlan"),
      distanceKm: unavailableCount(rows, "distanceKm"),
    },
    defaultedTargetCount,
    defaultedRankCount,
  };
}
