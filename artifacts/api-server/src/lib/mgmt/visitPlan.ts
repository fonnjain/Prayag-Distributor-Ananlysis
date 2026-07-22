// Phase 3: Visit-pattern analysis and forward visit plan.
//
// Pure computation — no Sheets reads. All inputs come from the RetailerRow[]
// already loaded by memberSheet.ts (source B).
//
// Working-day model: Mon-Sat (6-day Indian field sales week; Sundays excluded).
// FY boundary: April 1 (start year) to March 31 (following year).
//
// Capacity model:
//   demonstratedVisitsPerDay = totalVisitsDone / workingDaysElapsed
//   feasibleRemainingVisits  = demonstratedRate x workingDaysRemaining
//   gap = feasibleRemainingVisits - remainingRequired  (negative = shortfall)
//
// Forward plan: one MonthVisitPlan per remaining complete month.
// Each month lists up to 10 target retailers, prioritised:
//   maintain -> active retailers at monthly cadence (OB or sale > 0)
//   develop  -> untouched dormant sorted by businessPlan / max(km,5) desc
//   reduce   -> visited-but-zero-order (reduce frequency; surfaced explicitly)
// Targets are batched by district then distanceKm for efficient routing.
//
// Rules:
//   Never console.log; use logger.
//   No writes to Google Drive.

import type { RetailerRow } from "./memberSheet.js";
import { logger } from "../logger.js";

// ── Types ──────────────────────────────────────────────────────────────────────

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
  // Pro-rated target for the elapsed portion of the FY.
  proRatedRequired: number;
  // positive = behind schedule; negative = ahead.
  visitDeficit: number;
  visitedZeroOrderCount: number;
  visitedZeroOrderRetailers: string[];  // capped at 30
  distanceBuckets: DistanceBucket[];
};

export type VisitCapacity = {
  fyStartDate: string;           // "2026-04-01"
  asOfDate: string;
  workingDaysElapsed: number;    // Mon-Sat since FY start
  demonstratedVisitsPerDay: number;
  workingDaysRemaining: number;  // Mon-Sat from tomorrow to FY end
  feasibleRemainingVisits: number;
  remainingRequired: number;     // totalRequired - done
  gap: number;                   // feasible - required (negative = shortfall)
  monthlyCapacity: number;       // avg visits across remaining complete months
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
  month: string;              // "Aug 26"
  workingDays: number;        // Mon-Sat count for this month
  capacity: number;           // demonstratedRate x workingDays (rounded)
  maintenanceVisits: number;  // sum of monthly cadences for active retailers
  developmentVisits: number;  // remaining capacity directed at dormant
  targets: VisitTarget[];     // top 10, batched by district+km
};

export type VisitPlan = {
  pattern: VisitPattern;
  capacity: VisitCapacity;
  monthPlans: MonthVisitPlan[];
  totalFeasible: number;      // sum of capacity across all monthPlans
  totalRequired: number;      // = capacity.remainingRequired
  gap: number;                // totalFeasible - totalRequired
};

// ── Calendar helpers ───────────────────────────────────────────────────────────

// Count Mon-Sat days between from and to (inclusive).
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
  const to   = new Date(year, month0 + 1, 0); // last calendar day of month
  return countWorkingDays(from, to);
}

function fyStartYear(fy: string): number {
  return parseInt(fy.split("-")[0], 10);
}

function fyStart(fy: string): Date {
  return new Date(fyStartYear(fy), 3, 1); // April 1
}

function fyEnd(fy: string): Date {
  return new Date(fyStartYear(fy) + 1, 2, 31); // March 31
}

function isoDate(d: Date): string {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// Elapsed fractional months since FY start (day-accurate).
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
  const totalVisitsDone    = rows.reduce((s, r) => s + (r.totalVisit ?? 0), 0);
  const totalVisitsRequired = rows.reduce(
    (s, r) => s + (r.visitsRequired ?? 0), 0,
  );
  const proRatedRequired = Math.round(
    totalVisitsRequired * (elapsedMonths / 12),
  );
  const visitDeficit = proRatedRequired - totalVisitsDone;

  // Visited but produced zero OB and zero sale.
  const zeroOrder = rows.filter(
    (r) => (r.totalVisit ?? 0) > 0 && r.orderBooking === 0 && r.sale === 0,
  );

  // Distance buckets: Near <=15 km, Mid 15-40 km, Far >40 km.
  // Null distanceKm falls into Mid by default.
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
      label:       b.label,
      minKm:       b.minKm,
      maxKm:       b.maxKm,
      count:       bucket.length,
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

// ── Capacity model ─────────────────────────────────────────────────────────────

function computeCapacity(
  rows: RetailerRow[],
  fy: string,
  asOf: Date,
): VisitCapacity {
  const start = fyStart(fy);
  const end   = fyEnd(fy);

  const workingDaysElapsed = Math.max(1, countWorkingDays(start, asOf));
  const totalVisitsDone    = rows.reduce((s, r) => s + (r.totalVisit ?? 0), 0);
  const demonstratedRate   = totalVisitsDone / workingDaysElapsed;

  const tomorrow = new Date(asOf);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const workingDaysRemaining =
    tomorrow <= end ? countWorkingDays(tomorrow, end) : 0;

  const feasibleRemainingVisits = Math.round(
    demonstratedRate * workingDaysRemaining,
  );
  const totalVisitsRequired = rows.reduce(
    (s, r) => s + (r.visitsRequired ?? 0), 0,
  );
  const remainingRequired = Math.max(0, totalVisitsRequired - totalVisitsDone);
  const gap               = feasibleRemainingVisits - remainingRequired;

  // Count remaining complete months (next full month after asOf to FY end).
  let remainingMonthCount = 0;
  const cur = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 1);
  while (cur <= end) {
    remainingMonthCount++;
    cur.setMonth(cur.getMonth() + 1);
  }
  const monthlyCapacity =
    remainingMonthCount > 0
      ? Math.round(feasibleRemainingVisits / remainingMonthCount)
      : 0;

  return {
    fyStartDate:              isoDate(start),
    asOfDate:                 isoDate(asOf),
    workingDaysElapsed,
    demonstratedVisitsPerDay: Math.round(demonstratedRate * 100) / 100,
    workingDaysRemaining,
    feasibleRemainingVisits,
    remainingRequired,
    gap,
    monthlyCapacity,
  };
}

// ── Forward visit plan ─────────────────────────────────────────────────────────

// Business potential per km — higher score = develop first.
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
  const end  = fyEnd(fy);
  const rate = capacity.demonstratedVisitsPerDay;

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

  // Monthly visit cadence per active retailer (at least 1/month).
  function monthlyCadence(r: RetailerRow): number {
    return Math.max(1, Math.round((r.visitsRequired ?? 12) / 12));
  }
  const totalMonthlyCadence = active.reduce(
    (s, r) => s + monthlyCadence(r), 0,
  );

  const plans: MonthVisitPlan[] = [];

  // Enumerate remaining complete months after asOf.
  let curYear  = asOf.getFullYear();
  let curMonth = asOf.getMonth() + 1; // 0-indexed month of next complete month
  if (curMonth > 11) { curMonth = 0; curYear++; }

  while (true) {
    const monthStart = new Date(curYear, curMonth, 1);
    if (monthStart > end) break;

    const wd       = workingDaysForMonth(curYear, curMonth);
    const cap      = Math.round(rate * wd);
    const maintain = Math.min(cap, totalMonthlyCadence);
    const devBudget = Math.max(0, cap - maintain);

    const monthLabel = `${MONTH_LABELS[curMonth]} ${String(curYear).slice(-2)}`;

    // Build target list (capped at 10): active first, then develop, then reduce.
    const targets: VisitTarget[] = [];

    // Maintain: top 5 active retailers by OB descending.
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

    // Develop: fill remaining slots from development pool.
    const devSlots = Math.max(0, 10 - targets.length);
    const devCount = Math.min(developPool.length, devSlots);
    for (let i = 0; i < devCount; i++) {
      const r = developPool[i];
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

    // Reduce: 1 candidate shown explicitly if there is still a slot.
    if (targets.length < 10 && reducePool.length > 0) {
      const r = reducePool[0];
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

    // Batch by district then distance for efficient routing.
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

    curMonth++;
    if (curMonth > 11) { curMonth = 0; curYear++; }
  }

  return plans;
}

// ── Public entry point ─────────────────────────────────────────────────────────

export function computeVisitPlan(
  rows: RetailerRow[],
  fy: string,
  asOf?: Date,
): VisitPlan {
  const now     = asOf ?? new Date();
  const start   = fyStart(fy);
  const elapsed = elapsedFractionalMonths(start, now);

  const pattern    = computePattern(rows, elapsed);
  const capacity   = computeCapacity(rows, fy, now);
  const monthPlans = computeForwardPlan(rows, capacity, fy, now);

  const totalFeasible = monthPlans.reduce((s, m) => s + m.capacity, 0);
  const totalRequired = capacity.remainingRequired;
  const gap           = totalFeasible - totalRequired;

  logger.info(
    {
      fy,
      asOf:                     isoDate(now),
      totalVisitsDone:          pattern.totalVisitsDone,
      totalVisitsRequired:      pattern.totalVisitsRequired,
      proRatedRequired:         pattern.proRatedRequired,
      visitDeficit:             pattern.visitDeficit,
      visitedZeroOrderCount:    pattern.visitedZeroOrderCount,
      workingDaysElapsed:       capacity.workingDaysElapsed,
      demonstratedVisitsPerDay: capacity.demonstratedVisitsPerDay,
      workingDaysRemaining:     capacity.workingDaysRemaining,
      feasibleRemainingVisits:  capacity.feasibleRemainingVisits,
      remainingRequired:        totalRequired,
      gap,
      monthsPlanned:            monthPlans.length,
    },
    "visitPlan: computed — verify against acceptance criteria",
  );

  return { pattern, capacity, monthPlans, totalFeasible, totalRequired, gap };
}
