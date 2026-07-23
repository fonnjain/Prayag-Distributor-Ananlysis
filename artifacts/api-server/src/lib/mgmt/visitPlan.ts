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
  coveragePct: number;   // totalVisitsDone / totalVisitsRequired × 100
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
};

export type VisitPattern = {
  totalVisitsDone: number;
  totalVisitsRequired: number;
  proRatedRequired: number;
  visitDeficit: number;
  visitedZeroOrderCount: number;
  visitedZeroOrderRetailers: string[];
  distanceBuckets: DistanceBucket[];
};

export type VisitCapacity = {
  fyStartDate: string;
  // Phase 3-C: data window = end of last complete fiscal month, NEVER today
  dataWindowEndDate: string;         // e.g. "2026-06-30" (Q1 end)
  dataCutoffWorkingDays: number;     // Mon-Sat days Apr 1 → dataWindowEnd (78)
  demonstratedVisitsPerDay: number;  // totalDone / dataCutoffWorkingDays (pace check only)
  // Capacity anchor from closed-year data (not a projection)
  annualCapacityAnchor: number;      // Most recent closed FY total visits
  anchorFy: string;                  // e.g. "2025-26"
  feasibleRemainingVisits: number;   // annualAnchor − visitsDone
  remainingRequired: number;         // totalRequired − visitsDone
  gap: number;                       // feasible − required (negative = shortfall)
  workingDaysRemaining: number;      // Mon-Sat days from dataWindow+1 to FY end
  monthlyCapacity: number;           // approx feasibleRemaining / remainingForwardMonths
};

export type VisitTarget = {
  name: string;
  district: string | null;
  distanceKm: number | null;
  ob: number;
  businessPlan: number | null;
  visitsDone: number;
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
};

export type VisitPlan = {
  pattern: VisitPattern;
  capacity: VisitCapacity;
  historicalFyCapacity: HistoricalFyCapacity[];
  monthPlans: MonthVisitPlan[];
  totalFeasible: number;   // sum of month capacities (may differ by 1–2 from feasibleRemaining due to rounding)
  totalRequired: number;   // = capacity.remainingRequired
  gap: number;             // = capacity.gap (anchor-based, not recomputed from totalFeasible)
};

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

// ── Visit-pattern analysis ─────────────────────────────────────────────────────

function computePattern(
  rows: RetailerRow[],
  elapsedMonths: number,
): VisitPattern {
  const totalVisitsDone     = rows.reduce((s, r) => s + (r.totalVisit ?? 0), 0);
  const totalVisitsRequired = rows.reduce(
    (s, r) => s + (r.visitsRequired ?? 0), 0,
  );
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
      const km = r.distanceKm ?? 20;
      return km >= b.minKm && (b.maxKm === null || km < b.maxKm);
    });
    const visitsDone = bucket.reduce((s, r) => s + (r.totalVisit ?? 0), 0);
    const totalOb    = bucket.reduce((s, r) => s + r.orderBooking, 0);
    return {
      label:      b.label,
      minKm:      b.minKm,
      maxKm:      b.maxKm,
      count:      bucket.length,
      visitsDone,
      avgVisits:
        bucket.length > 0
          ? Math.round((visitsDone / bucket.length) * 10) / 10
          : 0,
      avgOb:
        bucket.length > 0
          ? Math.round(totalOb / bucket.length)
          : 0,
      activeCount: bucket.filter((r) => r.isActive).length,
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
  };
}

// ── Capacity model (Phase 3-C corrected) ──────────────────────────────────────

function computeCapacity(
  rows: RetailerRow[],
  fy: string,
  historicalCapacity: HistoricalFyCapacity[],
  asOf: Date,
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
  const demonstratedRate      = totalVisitsDone / dataCutoffWorkingDays;

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
    dataCutoffWorkingDays,
    demonstratedVisitsPerDay: Math.round(demonstratedRate * 100) / 100,
    annualCapacityAnchor,
    anchorFy,
    feasibleRemainingVisits,
    remainingRequired,
    gap,
    workingDaysRemaining,
    monthlyCapacity,
  };
}

// ── Forward visit plan ─────────────────────────────────────────────────────────

function priorityScore(r: RetailerRow): number {
  const bp = r.businessPlan ?? 50_000;
  const km = Math.max(r.distanceKm ?? 20, 5);
  return bp / km;
}

function computeForwardPlan(
  rows: RetailerRow[],
  capacity: VisitCapacity,
  fy: string,
  asOf: Date,
): MonthVisitPlan[] {
  const end = fyEnd(fy);

  const active      = rows.filter((r) => r.isActive);
  const visitedNoOb = rows.filter(
    (r) => !r.isActive && (r.totalVisit ?? 0) > 0,
  );
  const untouched   = rows.filter(
    (r) => !r.isActive && (r.totalVisit ?? 0) === 0,
  );

  const developPool = [...untouched].sort(
    (a, b) => priorityScore(b) - priorityScore(a),
  );
  const reducePool  = [...visitedNoOb].sort(
    (a, b) => priorityScore(b) - priorityScore(a),
  );

  function monthlyCadence(r: RetailerRow): number {
    return Math.max(1, Math.round((r.visitsRequired ?? 12) / 12));
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
      targets.push({
        name:         r.name,
        district:     r.district,
        distanceKm:   r.distanceKm,
        ob:           r.orderBooking,
        businessPlan: r.businessPlan,
        visitsDone:   r.totalVisit ?? 0,
        priority:     "maintain",
        reason:       `Active · OB ${(r.orderBooking / 100_000).toFixed(1)} L`,
      });
    }

    const devSlots = Math.max(0, 10 - targets.length);
    const devCount = Math.min(developPool.length, devSlots);
    for (let i = 0; i < devCount; i++) {
      const r = developPool[i]!;
      targets.push({
        name:         r.name,
        district:     r.district,
        distanceKm:   r.distanceKm,
        ob:           r.orderBooking,
        businessPlan: r.businessPlan,
        visitsDone:   r.totalVisit ?? 0,
        priority:     "develop",
        reason:       `Dormant · Plan ${((r.businessPlan ?? 0) / 100_000).toFixed(1)} L`,
      });
    }

    if (targets.length < 10 && reducePool.length > 0) {
      const r = reducePool[0]!;
      targets.push({
        name:         r.name,
        district:     r.district,
        distanceKm:   r.distanceKm,
        ob:           r.orderBooking,
        businessPlan: r.businessPlan,
        visitsDone:   r.totalVisit ?? 0,
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
): VisitPlan {
  const now     = asOf ?? new Date();
  const start   = fyStart(fy);
  const elapsed = elapsedFractionalMonths(start, now);

  const pattern    = computePattern(rows, elapsed);
  const capacity   = computeCapacity(rows, fy, historicalCapacity, now);
  const monthPlans = computeForwardPlan(rows, capacity, fy, now);

  const totalFeasible = monthPlans.reduce((s, m) => s + m.capacity, 0);
  const totalRequired = capacity.remainingRequired;
  // Gap is anchor-based (from capacity model), not recomputed from rounding artifacts.
  const gap = capacity.gap;

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
  };
}
