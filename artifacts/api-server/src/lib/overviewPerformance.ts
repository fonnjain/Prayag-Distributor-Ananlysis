import { and, eq, sql } from "drizzle-orm";
import { db, primaryStateTargets, saleLines } from "@workspace/db";
import { currentOpenFy, fyMonthLabels, priorFy } from "./fyAnchors.js";
import { isMonthComplete } from "./analytics/analytics.js";
import { resolveHeadKey } from "./mgmt/names.js";
import { loadOrderBookByState } from "./mgmt/orderBookByState.js";
import { STATE_REGISTER_MAP } from "./mgmt/primaryStateTargetSemantics.js";

const MONTH_NAMES = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
] as const;

export type PerformanceState = "closed" | "partial" | "future";

export type PerformanceMonth = {
  monthLabel: string;
  currentSalesInr: number | null;
  priorSalesInr: number | null;
  currentCoverageThrough: string | null;
  priorCoverageThrough: string | null;
  state: PerformanceState;
  comparableGrowthPct: number | null;
  growthNumeratorInr: number | null;
  growthDenominatorInr: number | null;
};

export type OverviewPerformance = {
  fy: string;
  priorFy: string;
  months: PerformanceMonth[];
  closedComparableYtd: {
    currentSalesInr: number;
    priorSalesInr: number;
    growthPct: number | null;
    growthNumeratorInr: number | null;
    growthDenominatorInr: number | null;
    throughDate: string | null;
  };
  companyAchievement: {
    actualInr: number | null;
    targetToDateInr: number;
    percentage: number | null;
    coveredMonths: string[];
    source: string;
    actualsAvailable: boolean;
    actualsError: string | null;
    actualsThroughDate: string | null;
    sourceLatestThroughDate: string | null;
  };
  sources: {
    sales: string;
    priorSales: string;
    targets: string;
    bookings: string;
  };
  coverage: {
    currentClosedMonths: string[];
    currentPartialMonths: string[];
    currentFutureMonths: string[];
    priorClosedMonths: string[];
    salesThroughDate: string | null;
  };
};

type SalesRow = {
  monthLabel: string;
  amount: number;
  maxDate: string | null;
};

type BookingLoadResult = Awaited<ReturnType<typeof loadOrderBookByState>>;

export type CompanyBookingActuals = {
  amounts: Map<string, number>;
  coveredThroughByMonth: Map<string, string>;
  sourceLatestThroughDate: string | null;
  actualsAvailable: boolean;
  actualsError: string | null;
  source: string;
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function growth(current: number | null, prior: number | null): {
  pct: number | null;
  numerator: number | null;
  denominator: number | null;
} {
  if (current == null || prior == null || prior === 0) {
    return { pct: null, numerator: null, denominator: null };
  }
  const numerator = round(current - prior);
  return {
    pct: round((numerator / prior) * 100),
    numerator,
    denominator: round(prior),
  };
}

function dateForMonth(monthLabel: string): {
  start: number;
  end: number;
  endExclusive: number;
} | null {
  const monthIndex = MONTH_NAMES.indexOf(monthLabel.slice(0, 3) as (typeof MONTH_NAMES)[number]);
  const yy = Number(monthLabel.slice(4));
  if (monthIndex < 0 || !Number.isFinite(yy)) return null;
  const year = 2000 + yy;
  const calendarMonth = (3 + monthIndex) % 12;
  const calendarYear = monthIndex >= 9 ? year : year;
  const start = Date.UTC(calendarYear, calendarMonth, 1);
  const end = Date.UTC(calendarYear, calendarMonth + 1, 0);
  const endExclusive = Date.UTC(calendarYear, calendarMonth + 1, 1);
  return { start, end, endExclusive };
}

function dateOnly(value: string): string | null {
  const candidate = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

export function classifyPerformanceMonth(
  monthLabel: string,
  maxDate: string | null,
  now: number = Date.now(),
): PerformanceState {
  const dates = dateForMonth(monthLabel);
  if (dates && dates.start > now) return "future";
  // The live calendar month remains partial until its calendar end. This
  // prevents a future-dated/early-complete-looking row from moving the open
  // month into closed YTD.
  if (dates && now < dates.endExclusive) return "partial";
  if (isMonthComplete(monthLabel, maxDate, now)) return "closed";
  return "partial";
}

export function aggregatePerformanceMonths(
  fy: string,
  currentRows: SalesRow[],
  priorRows: SalesRow[],
  now: number = Date.now(),
): {
  months: PerformanceMonth[];
  closedLabels: string[];
  partialLabels: string[];
  futureLabels: string[];
  throughDate: string | null;
  salesThroughDate: string | null;
} {
  const currentByMonth = new Map(currentRows.map((row) => [row.monthLabel, row]));
  const priorByMonth = new Map(priorRows.map((row) => [row.monthLabel, row]));
  const labels = fyMonthLabels(fy);
  const priorLabels = fyMonthLabels(priorFy(fy));
  const months: PerformanceMonth[] = [];
  const closedLabels: string[] = [];
  const partialLabels: string[] = [];
  const futureLabels: string[] = [];
  const closedDates: string[] = [];
  const salesDates: string[] = [];

  for (const [monthIndex, monthLabel] of labels.entries()) {
    const current = currentByMonth.get(monthLabel);
    const priorLabel = priorLabels[monthIndex];
    const prior = priorByMonth.get(priorLabel);
    const state = classifyPerformanceMonth(monthLabel, current?.maxDate ?? null, now);
    if (state === "closed") closedLabels.push(monthLabel);
    else if (state === "partial") partialLabels.push(monthLabel);
    else futureLabels.push(monthLabel);

    // Future months are deliberately null even if a source has stray rows
    // ahead of the reporting cutoff.
    const currentAmount =
      state === "future" || current == null ? null : round(Number(current.amount));
    const priorAmount = prior == null ? null : round(Number(prior.amount));
    const currentCoverageThrough = current?.maxDate
      ? dateOnly(current.maxDate)
      : null;
    const priorCoverageThrough = prior?.maxDate
      ? dateOnly(prior.maxDate)
      : null;
    const comparable = state === "closed" ? growth(currentAmount, priorAmount) : {
      pct: null,
      numerator: null,
      denominator: null,
    };
    if (currentCoverageThrough != null && state !== "future") {
      salesDates.push(currentCoverageThrough);
    }
    if (currentCoverageThrough != null && state === "closed") {
      closedDates.push(currentCoverageThrough);
    }
    months.push({
      monthLabel,
      currentSalesInr: currentAmount,
      priorSalesInr: priorAmount,
      currentCoverageThrough,
      priorCoverageThrough,
      state,
      comparableGrowthPct: comparable.pct,
      growthNumeratorInr: comparable.numerator,
      growthDenominatorInr: comparable.denominator,
    });
  }

  return {
    months,
    closedLabels,
    partialLabels,
    futureLabels,
    throughDate: closedDates.length > 0 ? closedDates.sort().at(-1)! : null,
    salesThroughDate: salesDates.length > 0 ? salesDates.sort().at(-1)! : null,
  };
}

async function loadSales(fy: string): Promise<SalesRow[]> {
  const rows = await db
    .select({
      monthLabel: sql<string>`coalesce(${saleLines.monthLabel}, '')`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
      maxDate: sql<string | null>`max(${saleLines.invoiceDate})::text`,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")))
    .groupBy(sql`1`);
  return rows.filter((row) => row.monthLabel !== "").map((row) => ({
    monthLabel: row.monthLabel,
    amount: Number(row.amount ?? 0),
    maxDate: row.maxDate,
  }));
}

export function companyBookingActual(
  coveredMonths: string[],
  targets: Array<{ stateHead: string; state: string; monthLabel: string; targetLakh: number }>,
  amounts: Map<string, number>,
): number {
  let actual = 0;
  for (const target of targets) {
    if (!coveredMonths.includes(target.monthLabel)) continue;
    const headKey = resolveHeadKey(target.stateHead);
    const registerStates = STATE_REGISTER_MAP[target.state] ?? [target.state];
    for (const registerState of registerStates) {
      actual += amounts.get(`${headKey}|${registerState}|${target.monthLabel}`) ?? 0;
    }
  }
  return actual;
}

export async function loadCompanyBookingActuals(
  loader: () => Promise<BookingLoadResult> = loadOrderBookByState,
): Promise<CompanyBookingActuals> {
  try {
    const booking = await loader();
    const actualsAvailable = booking.error == null;
    return {
      amounts: booking.amounts,
      coveredThroughByMonth: booking.coveredThroughByMonth ?? new Map(),
      sourceLatestThroughDate: booking.sourceLatestThroughDate ?? booking.coveredThrough ?? null,
      actualsAvailable,
      actualsError: booking.error,
      source: actualsAvailable
        ? "loadOrderBookByState (Order Book FY2627, state/head mapped)"
        : `loadOrderBookByState (unavailable: ${booking.error})`,
    };
  } catch (err) {
    const actualsError = err instanceof Error ? err.message : String(err);
    return {
      amounts: new Map(),
      coveredThroughByMonth: new Map(),
      sourceLatestThroughDate: null,
      actualsAvailable: false,
      actualsError,
      source: `loadOrderBookByState (unavailable: ${actualsError})`,
    };
  }
}

export function selectBookingActualsThroughDate(
  coveredMonths: string[],
  coveredThroughByMonth: ReadonlyMap<string, string>,
): string | null {
  const dates = coveredMonths
    .map((month) => coveredThroughByMonth.get(month) ?? null)
    .filter((date): date is string => date != null && dateOnly(date) != null)
    .map((date) => dateOnly(date)!);
  return dates.length > 0 ? dates.sort().at(-1)! : null;
}

export function calculateClosedComparableSales(
  fy: string,
  currentRows: SalesRow[],
  priorRows: SalesRow[],
  closedLabels: string[],
): {
  currentSalesInr: number;
  priorSalesInr: number;
  growthPct: number | null;
  growthNumeratorInr: number | null;
  growthDenominatorInr: number | null;
} {
  const labels = fyMonthLabels(fy);
  const priorLabels = fyMonthLabels(priorFy(fy));
  const currentByMonth = new Map(currentRows.map((row) => [row.monthLabel, row]));
  const priorByMonth = new Map(priorRows.map((row) => [row.monthLabel, row]));
  const currentSalesInr = round(
    closedLabels.reduce((sum, label) => sum + (currentByMonth.get(label)?.amount ?? 0), 0),
  );
  const priorSalesInr = round(
    closedLabels.reduce((sum, label) => {
      const labelInPrior = priorLabels[labels.indexOf(label)] ?? label;
      return sum + (priorByMonth.get(labelInPrior)?.amount ?? 0);
    }, 0),
  );
  const result = growth(currentSalesInr, priorSalesInr);
  return {
    currentSalesInr,
    priorSalesInr,
    growthPct: result.pct,
    growthNumeratorInr: result.numerator,
    growthDenominatorInr: result.denominator,
  };
}

export function selectComparablePriorMonths(
  fy: string,
  closedLabels: string[],
  priorRows: SalesRow[],
): string[] {
  const labels = fyMonthLabels(fy);
  const priorLabels = fyMonthLabels(priorFy(fy));
  const priorByMonth = new Map(priorRows.map((row) => [row.monthLabel, row]));
  return closedLabels.flatMap((label) => {
    const labelInPrior = priorLabels[labels.indexOf(label)] ?? label;
    return priorByMonth.has(labelInPrior) ? [labelInPrior] : [];
  });
}

export function buildCompanyAchievement(
  actualsAvailable: boolean,
  actualInr: number | null,
  targetToDateInr: number,
  coveredMonths: string[],
  source: string,
  actualsError: string | null,
  actualsThroughDate: string | null,
  sourceLatestThroughDate: string | null,
): OverviewPerformance["companyAchievement"] {
  return {
    actualInr: actualsAvailable && actualInr != null ? round(actualInr) : null,
    targetToDateInr: round(targetToDateInr),
    percentage:
      actualsAvailable && actualInr != null && targetToDateInr > 0
        ? round((actualInr / targetToDateInr) * 100)
        : null,
    coveredMonths,
    source,
    actualsAvailable,
    actualsError,
    actualsThroughDate,
    sourceLatestThroughDate,
  };
}

export async function buildOverviewPerformance(
  fy: string = currentOpenFy(),
  now: number = Date.now(),
): Promise<OverviewPerformance> {
  const compareFy = priorFy(fy);
  const [currentRows, priorRows, targetRows] = await Promise.all([
    loadSales(fy),
    loadSales(compareFy),
    db.select({
      stateHead: primaryStateTargets.stateHead,
      state: primaryStateTargets.state,
      monthLabel: primaryStateTargets.monthLabel,
      targetLakh: primaryStateTargets.targetLakh,
    }).from(primaryStateTargets).where(eq(primaryStateTargets.fy, fy)),
  ]);
  const aggregate = aggregatePerformanceMonths(fy, currentRows, priorRows, now);
  const ytd = calculateClosedComparableSales(fy, currentRows, priorRows, aggregate.closedLabels);
  const priorClosedMonths = selectComparablePriorMonths(fy, aggregate.closedLabels, priorRows);
  const targetToDate = targetRows
    .filter((row) => aggregate.closedLabels.includes(row.monthLabel))
    .reduce((sum, row) => sum + Number(row.targetLakh) * 100000, 0);

  let bookingAmounts = new Map<string, number>();
  let bookingCoveredThroughByMonth = new Map<string, string>();
  let bookingSourceLatestThroughDate: string | null = null;
  let bookingSource = "loadOrderBookByState (unavailable)";
  let actualsAvailable = false;
  let actualsError: string | null = "Order-book actuals are only available for the open FY.";
  if (fy === currentOpenFy()) {
    const booking = await loadCompanyBookingActuals();
    bookingAmounts = booking.amounts;
    bookingCoveredThroughByMonth = booking.coveredThroughByMonth;
    bookingSourceLatestThroughDate = booking.sourceLatestThroughDate;
    actualsAvailable = booking.actualsAvailable;
    actualsError = booking.actualsError;
    bookingSource = booking.source;
  }
  const actual = actualsAvailable
    ? companyBookingActual(aggregate.closedLabels, targetRows, bookingAmounts)
    : null;
  return {
    fy,
    priorFy: compareFy,
    months: aggregate.months,
    closedComparableYtd: {
      currentSalesInr: ytd.currentSalesInr,
      priorSalesInr: ytd.priorSalesInr,
      growthPct: ytd.growthPct,
      growthNumeratorInr: ytd.growthNumeratorInr,
      growthDenominatorInr: ytd.growthDenominatorInr,
      throughDate: aggregate.throughDate,
    },
    companyAchievement: buildCompanyAchievement(
      actualsAvailable,
      actual,
      targetToDate,
      aggregate.closedLabels,
      `${bookingSource}; primary_state_targets.target_lakh`,
      actualsError,
      actualsAvailable
        ? selectBookingActualsThroughDate(aggregate.closedLabels, bookingCoveredThroughByMonth)
        : null,
      actualsAvailable ? bookingSourceLatestThroughDate : null,
    ),
    sources: {
      sales: "sale_line_current.amount grouped by fiscal month",
      priorSales: "sale_line_current.amount grouped by fiscal month",
      targets: "primary_state_targets.target_lakh (Lakh converted to INR)",
      bookings: bookingSource,
    },
    coverage: {
      currentClosedMonths: aggregate.closedLabels,
      currentPartialMonths: aggregate.partialLabels,
      currentFutureMonths: aggregate.futureLabels,
      priorClosedMonths,
      salesThroughDate: aggregate.salesThroughDate,
    },
  };
}