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
  sourceBasis: string;
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
  sourceBasis: Record<string, string>;
  sourceMonthlyShares: Record<string, number[]>;
};

export const COMPARABLE_SEASONAL_SOURCE_BASES = new Set([
  "channel_retail",
  "territory_true",
]);

export type SeasonalCurveActivation = {
  curve: SeasonalCurveMath;
  /**
   * Frozen years which cannot safely have an equal vote yet. Their raw values
   * remain visible in verification, but an all-channel historical shape must
   * not be blended into a retail/territory curve.
   */
  blockedFiscalYears: Array<{ fy: string; sourceBasis: string }>;
  mode: "verified_baseline" | "equal_weighted_multi_year";
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
    sourceBasis: Object.fromEntries(
      sorted.map((source) => [source.fy, source.sourceBasis]),
    ),
    sourceMonthlyShares,
  };
}

/**
 * A multi-year curve is valid only when every completed frozen year has the
 * same commercial scope. If any year remains all-channel / unclassified, keep
 * the independently reconciled FY2025-26 retail baseline active instead of
 * creating a more recent but mixed-basis denominator.
 */
export function selectSeasonalCurveActivation(
  sourceYears: SeasonalSourceYear[],
): SeasonalCurveActivation {
  const baseline = sourceYears.find((source) => source.fy === "2025-26");
  if (!baseline) {
    throw new Error("seasonal curve: FY2025-26 verified retail baseline is required");
  }
  if (baseline.sourceBasis !== "channel_retail") {
    throw new Error(
      `seasonal curve: FY2025-26 baseline is not fully retail-classified (got ${baseline.sourceBasis})`,
    );
  }

  const blockedFiscalYears = sourceYears
    .filter((source) => !COMPARABLE_SEASONAL_SOURCE_BASES.has(source.sourceBasis))
    .map(({ fy, sourceBasis }) => ({ fy, sourceBasis }));

  if (blockedFiscalYears.length > 0) {
    return {
      curve: buildSeasonalCurveMath([baseline]),
      blockedFiscalYears,
      mode: "verified_baseline",
    };
  }

  return {
    curve: buildSeasonalCurveMath(sourceYears),
    blockedFiscalYears: [],
    mode: "equal_weighted_multi_year",
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