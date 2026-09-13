import { OverviewPerformanceAchievement, OverviewPerformanceMonth } from "@workspace/api-client-react";
import { formatCompact } from "@/data/dataset";

export function prepareChartData(months: OverviewPerformanceMonth[]) {
  return months.map((m) => ({
    monthLabel: m.monthLabel,
    // Oct-Mar current year blank (or any future month)
    currentSalesInr: m.state === "future" ? null : m.currentSalesInr,
    priorSalesInr: m.priorSalesInr,
    state: m.state,
    comparableGrowthPct: m.comparableGrowthPct,
    growthNumeratorInr: m.growthNumeratorInr,
    growthDenominatorInr: m.growthDenominatorInr,
    currentCoverageThrough: (m as any).currentCoverageThrough as string | undefined,
    priorCoverageThrough: (m as any).priorCoverageThrough as string | undefined,
  }));
}

export function formatGrowthLabel(val: number | null): string | null {
  if (val == null) return null;
  const isPositive = val > 0;
  // Use strictly 1 decimal place, taking absolute to control the sign explicitly.
  const absFixed = Math.abs(val).toFixed(1);
  if (absFixed === "0.0") return "0.0%"; // Neutral for exactly or effectively zero
  return `${isPositive ? "+" : "-"}${absFixed}%`;
}

export function formatCroreExact(value: number | null): string {
  if (value == null) return "—";
  const isNegative = value < 0;
  const absCr = Math.abs(value) / 10000000;
  const rounded = Math.round(absCr * 100) / 100;
  const fixed = rounded.toFixed(2);
  return `${isNegative ? "-" : ""}₹${fixed} Cr`;
}

export function getAchievementText(ach: OverviewPerformanceAchievement): string {
  if (ach.actualsAvailable && ach.percentage != null) {
    return formatGrowthLabel(ach.percentage)?.replace("+", "") || "Unavailable";
  }
  if (ach.actualsError) {
    return ach.actualsError;
  }
  return "Unavailable";
}

export function getAchievementDetails(ach: OverviewPerformanceAchievement, targetsSource: string): string[] {
  return [
    `Target-to-date: ${formatCompact(ach.targetToDateInr)}`,
    ach.actualsAvailable
      ? `Basis: ${ach.actualInr != null ? formatCompact(ach.actualInr) : "—"} / ${formatCompact(ach.targetToDateInr)}`
      : "Basis: Unavailable",
    `Source: ${ach.source} vs ${targetsSource}`,
    ach.actualsThroughDate ? `Included metric through: ${ach.actualsThroughDate}` : "Included metric through: Unavailable",
    ach.sourceLatestThroughDate ? `Source latest through: ${ach.sourceLatestThroughDate}` : "Source latest through: Unavailable",
  ];
}

export interface ClosedMonthStat {
  monthLabel: string;
  pct: number;
  num: number;
  den: number;
}

export interface NarrativeSummary {
  available: boolean;
  trajectoryPct: number | null;
  totalNum: number;
  totalDen: number;
  strongest: ClosedMonthStat | null;
  weakest: ClosedMonthStat | null;
  closedCount: number;
}

export function getNarrativeSummary(months: OverviewPerformanceMonth[]): NarrativeSummary {
  const closed = months.filter(
    (m) =>
      m.state === "closed" &&
      m.comparableGrowthPct != null &&
      m.growthNumeratorInr != null &&
      m.growthDenominatorInr != null
  );

  if (closed.length === 0) {
    return {
      available: false,
      trajectoryPct: null,
      totalNum: 0,
      totalDen: 0,
      strongest: null,
      weakest: null,
      closedCount: 0,
    };
  }

  let totalNum = 0; // In the API, this is the difference (current - prior)
  let totalDen = 0; // Prior
  let strongest: ClosedMonthStat | null = null;
  let weakest: ClosedMonthStat | null = null;

  for (const m of closed) {
    const num = m.growthNumeratorInr!;
    const den = m.growthDenominatorInr!;
    const pct = m.comparableGrowthPct!;

    totalNum += num;
    totalDen += den;

    const stat = { monthLabel: m.monthLabel, pct, num, den };

    if (!strongest || pct > strongest.pct) strongest = stat;
    if (!weakest || pct < weakest.pct) weakest = stat;
  }

  // Calculate trajectory based on API convention: growthNumeratorInr means current-minus-prior
  const trajectoryPct = totalDen !== 0 ? (totalNum / totalDen) * 100 : null;

  return {
    available: true,
    trajectoryPct,
    totalNum,
    totalDen,
    strongest,
    weakest,
    closedCount: closed.length,
  };
}
