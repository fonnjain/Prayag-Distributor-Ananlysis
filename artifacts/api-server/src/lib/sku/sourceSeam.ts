export const AUG26_RETAILER_VIEW = {
  source: "Product-Wise CRM order booking, August 2026",
  valueBasis: "Basic Order Value, ex-GST",
  comparability: "Permanently not comparable with PSCode3 SKU NET: the CRM systems have no overlapping month",
} as const;

export type SourceSeamEntry = {
  source: string;
  valueBasis: string;
  completeness: "complete" | "partial" | "unavailable";
  identityCoverage: number | null;
  included: boolean;
  exclusionReason?: string;
};

export function paginateRows<T>(rows: T[], limit = 100, offset = 0): {
  rows: T[];
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
} {
  const boundedLimit = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.floor(limit))) : 100;
  const boundedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return {
    rows: rows.slice(boundedOffset, boundedOffset + boundedLimit),
    limit: boundedLimit,
    offset: boundedOffset,
    total: rows.length,
    hasMore: boundedOffset + boundedLimit < rows.length,
  };
}

/** A single-source Product-Wise period is usable; a mixed PSCode3/Product-Wise
 * aggregation is never usable because the CRM systems have no overlap. */
export function includedInStandardRetailerAnalytics(source: string, selectedSources: string[] = [source]): boolean {
  return !selectedSources.includes("productwise_xlsx") || selectedSources.every((entry) => entry === "productwise_xlsx");
}