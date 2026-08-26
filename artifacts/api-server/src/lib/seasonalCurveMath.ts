export const FISCAL_MONTH_NAMES = [
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
  "Jan",
  "Feb",
  "Mar",
] as const;

export type SeasonalSourceYear = {
  fy: string;
  monthlyNet: number[];
  rows: number;
};

export type SeasonalCurveMath = {
  fiscalYearsUsed: string[];
  monthWeights: number[];
  quarterWeights: number[];
  monthShareStddev: number[];
  monthRanges: [number, number][];
  quarterRanges: [number, number][];
  sourceRows: Record<string, number>;
  sourceNet: Record<string, number>;
  sourceMonthlyShares: Record<string, number[]>;
};

function percentNormalise(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("seasonal curve: source year has no positive net");
  }
  const percentages = values.map((value) => (value / total) * 100);
  // Keep the stored curve mathematically closed at 100 rather than letting
  // floating point residue accumulate as new source years are added.
  percentages[percentages.length - 1] =
    100 - percentages.slice(0, -1).reduce((sum, value) => sum + value, 0);
  return percentages;
}

function populationStddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function ranges(values: number[][]): [number, number][] {
  return FISCAL_MONTH_NAMES.map((_, monthIdx) => {
    const monthValues = values.map((year) => year[monthIdx] ?? 0);
    return [Math.min(...monthValues), Math.max(...monthValues)];
  });
}

function quarterValues(monthly: number[]): number[] {
  return [0, 1, 2, 3].map((quarter) =>
    monthly
      .slice(quarter * 3, quarter * 3 + 3)
      .reduce((sum, value) => sum + value, 0),
  );
}

export function buildSeasonalCurveMath(
  sourceYears: SeasonalSourceYear[],
): SeasonalCurveMath {
  if (sourceYears.length === 0) {
    throw new Error("seasonal curve: at least one source year is required");
  }

  const sorted = [...sourceYears].sort((a, b) => a.fy.localeCompare(b.fy));
  const sourceMonthlyShares = Object.fromEntries(
    sorted.map((source) => [source.fy, percentNormalise(source.monthlyNet)]),
  );
  const yearlyShares = sorted.map((source) => sourceMonthlyShares[source.fy]);
  const meanMonths = FISCAL_MONTH_NAMES.map((_, monthIdx) =>
    yearlyShares.reduce((sum, shares) => sum + (shares[monthIdx] ?? 0), 0) /
    yearlyShares.length,
  );
  const closedMonthWeights = percentNormalise(meanMonths);
  const quarterWeights = quarterValues(closedMonthWeights);
  const monthShareStddev = FISCAL_MONTH_NAMES.map((_, monthIdx) =>
    populationStddev(yearlyShares.map((shares) => shares[monthIdx] ?? 0)),
  );

  const sourceQuarterShares = yearlyShares.map(quarterValues);
  const quarterRanges = [0, 1, 2, 3].map((quarter) => {
    const values = sourceQuarterShares.map((shares) => shares[quarter] ?? 0);
    return [Math.min(...values), Math.max(...values)] as [number, number];
  });

  return {
    fiscalYearsUsed: sorted.map((source) => source.fy),
    monthWeights: closedMonthWeights,
    quarterWeights,
    monthShareStddev,
    monthRanges: ranges(yearlyShares),
    quarterRanges,
    sourceRows: Object.fromEntries(sorted.map((source) => [source.fy, source.rows])),
    sourceNet: Object.fromEntries(
      sorted.map((source) => [
        source.fy,
        source.monthlyNet.reduce((sum, value) => sum + value, 0),
      ]),
    ),
    sourceMonthlyShares,
  };
}

export function compareSeasonalCurveToConfig(
  curve: SeasonalCurveMath,
  configuredMonthlyFractions: number[],
): {
  monthDelta: number[];
  quarterDelta: number[];
  maxAbsMonthDelta: number;
  q1Delta: number;
  q4Delta: number;
} {
  const configured = percentNormalise(configuredMonthlyFractions);
  const configuredQuarter = quarterValues(configured);
  const monthDelta = curve.monthWeights.map(
    (value, idx) => value - (configured[idx] ?? 0),
  );
  const quarterDelta = curve.quarterWeights.map(
    (value, idx) => value - (configuredQuarter[idx] ?? 0),
  );
  return {
    monthDelta,
    quarterDelta,
    maxAbsMonthDelta: Math.max(...monthDelta.map((value) => Math.abs(value))),
    q1Delta: quarterDelta[0] ?? 0,
    q4Delta: quarterDelta[3] ?? 0,
  };
}

export function curveInstabilityNote(curve: SeasonalCurveMath): string | null {
  const unstable = curve.monthRanges
    .map((range, idx) => ({ range, idx }))
    .filter(({ range }) => range[1] - range[0] > 3);
  if (unstable.length === 0) return null;
  const labels = unstable.map(
    ({ range, idx }) =>
      `${FISCAL_MONTH_NAMES[idx]} ${range[0].toFixed(1)}–${range[1].toFixed(1)}%`,
  );
  return `${labels.join(", ")} share has varied by more than 3 points across ${curve.fiscalYearsUsed.length} years.`;
}