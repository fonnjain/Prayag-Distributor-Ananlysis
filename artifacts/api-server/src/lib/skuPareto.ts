import { currentOpenFy, fyMonthLabels, closedReportingMonthCount } from "./fyAnchors.js";

export type SkuParetoRow = {
  code: string;
  amount: number;
  monthLabel: string;
};

export type SkuParetoEntry = {
  rank: number;
  code: string;
  revenueInr: number;
  sharePct: number;
  cumulativeSharePct: number;
};

export type SkuPareto = {
  fy: string;
  monthFrom: number;
  monthTo: number;
  periodLabel: string;
  totalRevenueInr: number;
  skuCount: number;
  source: string;
  basis: string;
  thresholds: {
    reach50Rank: number | null;
    reach80Rank: number | null;
    reach90Rank: number | null;
  };
  entries: SkuParetoEntry[];
  topTen: SkuParetoEntry[];
};

const SOURCE = "development database sale_line_current.amount";
const BASIS = "Raw sale_line_current.code; current rows only; no joins";

export class SkuParetoRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkuParetoRangeError";
  }
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

type RawParetoEntry = { rank: number; cumulativeSharePct: number };

function rawThresholdRank(entries: RawParetoEntry[], threshold: number): number | null {
  return entries.find((entry) => entry.cumulativeSharePct >= threshold * 100)?.rank ?? null;
}

export function buildSkuPareto(
  fy: string,
  rows: SkuParetoRow[],
  monthFrom = 1,
  monthTo = Math.min(
    12,
    closedReportingMonthCount(fy) + (fy === currentOpenFy() ? 1 : 0),
  ),
): SkuPareto {
  const labels = new Set(fyMonthLabels(fy).slice(monthFrom - 1, monthTo));
  const grouped = new Map<string, number>();

  for (const row of rows) {
    // Keep the raw code for grouping/display, while excluding whitespace-only
    // source values. No item-master or catalogue normalisation is performed.
    if (!row.code.trim() || !labels.has(row.monthLabel)) continue;
    grouped.set(row.code, (grouped.get(row.code) ?? 0) + Number(row.amount || 0));
  }

  const totalRevenueRaw = [...grouped.values()].reduce((sum, amount) => sum + amount, 0);
  const totalRevenueInr = round(totalRevenueRaw);
  const sorted = [...grouped.entries()]
    .sort(([codeA, amountA], [codeB, amountB]) =>
      amountB - amountA || (codeA < codeB ? -1 : codeA > codeB ? 1 : 0),
    );

  let cumulativeRaw = 0;
  const rawEntries: RawParetoEntry[] = [];
  const entries: SkuParetoEntry[] = sorted.map(([code, amount], index) => {
    const revenueInr = round(amount);
    const sharePct = totalRevenueRaw > 0
      ? round((amount / totalRevenueRaw) * 100, 4)
      : 0;
    cumulativeRaw += totalRevenueRaw > 0 ? (amount / totalRevenueRaw) * 100 : 0;
    rawEntries.push({ rank: index + 1, cumulativeSharePct: cumulativeRaw });
    return {
      rank: index + 1,
      code,
      revenueInr,
      sharePct,
      cumulativeSharePct: totalRevenueRaw > 0 ? round(cumulativeRaw, 4) : 0,
    };
  });

  return {
    fy,
    monthFrom,
    monthTo,
    periodLabel: monthFrom === 1 && monthTo === 12
      ? "Full Year"
      : `Fiscal months ${monthFrom}–${monthTo}`,
    totalRevenueInr,
    skuCount: entries.length,
    source: SOURCE,
    basis: BASIS,
    thresholds: {
      reach50Rank: totalRevenueRaw > 0 ? rawThresholdRank(rawEntries, 0.5) : null,
      reach80Rank: totalRevenueRaw > 0 ? rawThresholdRank(rawEntries, 0.8) : null,
      reach90Rank: totalRevenueRaw > 0 ? rawThresholdRank(rawEntries, 0.9) : null,
    },
    entries,
    topTen: entries.slice(0, 10),
  };
}

export function normalizeSkuParetoRange(
  fy: string,
  monthFrom?: number,
  monthTo?: number,
): { monthFrom: number; monthTo: number } {
  const from = monthFrom ?? 1;
  // Overview's primary-source YTD includes the current in-progress month for
  // the open FY; closed FYs resolve to the full year.
  const defaultTo = Math.min(
    12,
    closedReportingMonthCount(fy) + (fy === currentOpenFy() ? 1 : 0),
  );
  const to = monthTo ?? defaultTo;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 12 || from > to) {
    throw new SkuParetoRangeError("monthFrom and monthTo must be integers from 1 to 12 with monthFrom <= monthTo");
  }
  return { monthFrom: from, monthTo: to };
}

export { SOURCE as SKU_PARETO_SOURCE, BASIS as SKU_PARETO_BASIS };