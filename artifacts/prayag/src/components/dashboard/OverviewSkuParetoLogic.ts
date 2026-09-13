export type ParetoChartEntry = {
  rank: number;
  label: string;
  cumulativeSharePct: number;
};

export function prepareSkuParetoChartData(
  entries: Array<{ rank: number; code: string; cumulativeSharePct: number }>,
): ParetoChartEntry[] {
  return entries.map((entry) => ({
    rank: entry.rank,
    label: entry.rank <= 10 ? `${entry.rank}: ${entry.code}` : String(entry.rank),
    cumulativeSharePct: entry.cumulativeSharePct,
  }));
}