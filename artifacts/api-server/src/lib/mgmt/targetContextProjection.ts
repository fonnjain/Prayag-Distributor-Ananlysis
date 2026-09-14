export type SeasonalProjectionInput = {
  amount: number;
  fiscalMonthIndex: number;
  monthLabel: string;
};

export type SeasonalProjection = {
  actualYtd: number;
  projectedFullYear: number;
  seasonalShare: number;
  completeMonths: string[];
};

export function projectFromCompleteMonths(
  rows: SeasonalProjectionInput[],
  monthlyShares: number[],
): SeasonalProjection | null {
  if (rows.length === 0) return null;

  const fiscalMonths = new Set<number>();
  let actualYtd = 0;
  for (const row of rows) {
    if (
      !Number.isInteger(row.fiscalMonthIndex)
      || row.fiscalMonthIndex < 0
      || row.fiscalMonthIndex > 11
      || !Number.isFinite(row.amount)
    ) {
      return null;
    }
    fiscalMonths.add(row.fiscalMonthIndex);
    actualYtd += row.amount;
  }

  const seasonalShare = [...fiscalMonths].reduce(
    (sum, index) => sum + (monthlyShares[index] ?? 0),
    0,
  );
  if (!(seasonalShare > 0)) return null;

  return {
    actualYtd,
    projectedFullYear: actualYtd / seasonalShare,
    seasonalShare,
    completeMonths: rows
      .slice()
      .sort((a, b) => a.fiscalMonthIndex - b.fiscalMonthIndex)
      .map((row) => row.monthLabel),
  };
}