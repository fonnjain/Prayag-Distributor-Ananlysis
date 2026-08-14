// Red Alert — MRP index builder for B1 real-growth calculation.
//
// Given a customer, prior period months, and current period months, computes:
//   mrpIndex       = Laspeyres price index using MRP changes
//   realisedIndex  = Laspeyres price index using realised avg-sale-rate changes
//
// Both use the prior period's basket (item codes × prior quantities) as weights.
// Ambiguous codes (same code in multiple segments) are resolved via the segment
// seen in sale_line_current — we match on (item_code, group_canon) as a proxy
// for segment, since group_canon in sale_line maps to the same taxonomy.
//
// Returns null when the basket is empty or MRP data is missing for enough codes.

import type { DetectionContext, MrpHistoryRow } from "./types.js";

export type MrpIndexResult = {
  mrpIncreasePct: number;       // (mrpIndex - 1) * 100
  realisedIncreasePct: number;  // (realisedIndex - 1) * 100
  basketSize: number;           // number of item codes in the basket
  coveredValue: number;         // prior value of basket codes with MRP data (₹)
  totalPriorValue: number;      // total prior value across all basket codes (₹)
  coveragePct: number;          // coveredValue / totalPriorValue * 100
};

// Find the MRP for an (item_code, segment) at a point in time.
// "Point in time" is the end of the prior period (last day of last prior month).
function findMrp(
  history: MrpHistoryRow[],
  itemCode: string,
  segment: string,
  asOf: string, // date string "YYYY-MM-DD"
): number | null {
  // Filter history rows for this (code, segment)
  const rows = history.filter((r) => r.itemCode === itemCode && r.segment === segment);
  if (rows.length === 0) return null;

  // Find the row effective at asOf:
  // effective_from <= asOf AND (effective_to IS NULL OR effective_to >= asOf)
  const matching = rows.filter((r) => {
    const fromOk = r.effectiveFrom <= asOf;
    const toOk = r.effectiveTo == null || r.effectiveTo >= asOf;
    return fromOk && toOk;
  });
  if (matching.length === 0) {
    // Fall back to the most recent row before asOf
    const before = rows.filter((r) => r.effectiveFrom <= asOf).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    return before[0]?.mrp ?? null;
  }
  // If multiple match, prefer the one with the latest effective_from
  matching.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return matching[0]!.mrp;
}

function findCurrentMrp(history: MrpHistoryRow[], itemCode: string, segment: string): number | null {
  const rows = history.filter((r) => r.itemCode === itemCode && r.segment === segment && r.isCurrent);
  if (rows.length === 0) return null;
  return rows[0]!.mrp;
}

// Convert month label "Apr-25" to approximate period-end date "2025-04-30"
function monthLabelToEndDate(label: string): string {
  const [mon, yr] = label.split("-") as [string, string];
  const monthMap: Record<string, number> = {
    Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12, Jan: 1, Feb: 2, Mar: 3,
  };
  const m = monthMap[mon] ?? 1;
  const y = 2000 + parseInt(yr, 10);
  // Last day of month
  const lastDay = new Date(Date.UTC(y, m, 0));
  return lastDay.toISOString().slice(0, 10);
}

// ── Retailer MRP index (value-weighted, secondary data) ──────────────────────
// secondary_sku_line carries net_amount but not qty; we therefore use a
// value-weighted Laspeyres price index rather than a quantity-weighted one.
// This is the standard approximation when only values are available.
// The realised-price component is omitted (requires avg_rate from qty).

export function computeRetailerMrpIndex(
  ctx: DetectionContext,
  retailer: string,
  priorMonths: string[],
  currentMonths: string[],
): MrpIndexResult | null {
  if (priorMonths.length === 0 || currentMonths.length === 0) return null;

  const priorMonthSet   = new Set(priorMonths);
  const currentMonthSet = new Set(currentMonths);
  const lastPriorMonth  = priorMonths[priorMonths.length - 1]!;
  const priorAsOf       = monthLabelToEndDate(lastPriorMonth);

  // Build value basket: item_code + segment → { priorValue, curValue }
  type REntry = { seg: string | null; priorValue: number; curValue: number };
  const basket = new Map<string, REntry>();

  for (const r of ctx.retailerSku) {
    if (r.retailer !== retailer) continue;
    const key = `${r.itemCode}|${r.segmentCanon ?? ""}`;
    if (priorMonthSet.has(r.monthLabel)) {
      const prev = basket.get(key) ?? { seg: r.segmentCanon, priorValue: 0, curValue: 0 };
      prev.priorValue += r.value;
      basket.set(key, prev);
    } else if (currentMonthSet.has(r.monthLabel)) {
      const prev = basket.get(key) ?? { seg: r.segmentCanon, priorValue: 0, curValue: 0 };
      prev.curValue += r.value;
      basket.set(key, prev);
    }
  }

  if (basket.size === 0) return null;

  // Value-weighted Laspeyres: Σ(priorValue × P_cur/P_pri) / Σ(priorValue)
  let mrpNumerator = 0;
  let mrpDenominator = 0;
  let coveredValue = 0;
  let totalPriorValue = 0;

  for (const [key, entry] of basket) {
    if (entry.priorValue <= 0) continue;
    totalPriorValue += entry.priorValue;

    const [code] = key.split("|") as [string, string];
    const seg    = entry.seg ?? "";

    const mrpThen = findMrp(ctx.mrpHistory, code, seg, priorAsOf);
    const mrpNow  = ctx.ambiguousCodes.has(code)
      ? findCurrentMrp(ctx.mrpHistory, code, seg)
      : ctx.mrpHistory.find((r) => r.itemCode === code && r.isCurrent)?.mrp ?? null;

    if (mrpThen != null && mrpNow != null && mrpThen > 0) {
      mrpNumerator   += entry.priorValue * mrpNow;
      mrpDenominator += entry.priorValue * mrpThen;
      coveredValue   += entry.priorValue;
    }
  }

  if (mrpDenominator === 0) return null;

  const mrpIndex     = mrpNumerator / mrpDenominator;
  const mrpIncreasePct = (mrpIndex - 1) * 100;

  return {
    mrpIncreasePct,
    realisedIncreasePct: mrpIncreasePct,   // no qty → use MRP figure conservatively
    basketSize: basket.size,
    coveredValue,
    totalPriorValue,
    coveragePct: totalPriorValue > 0 ? (coveredValue / totalPriorValue) * 100 : 0,
  };
}

export function computeMrpIndex(
  ctx: DetectionContext,
  customer: string,
  priorMonths: string[],  // prior period month labels
  currentMonths: string[], // current period month labels
): MrpIndexResult | null {
  if (priorMonths.length === 0 || currentMonths.length === 0) return null;

  // Build the basket: item_code → { priorQty, priorAvgRate, curAvgRate, priorValue, group }
  // Aggregated over all prior months.
  type BasketEntry = {
    priorQty: number;
    priorValue: number;
    priorAvgRate: number | null;
    curAvgRate: number | null;
    group: string | null;
  };

  const basket = new Map<string, BasketEntry>();

  for (const row of ctx.customerCode) {
    if (row.customer !== customer) continue;
    if (priorMonths.includes(row.monthLabel)) {
      const prev = basket.get(row.code) ?? { priorQty: 0, priorValue: 0, priorAvgRate: null, curAvgRate: null, group: row.groupCanon };
      prev.priorQty += row.qty;
      prev.priorValue += row.value;
      // Weighted average rate
      if (row.avgRate != null) {
        const prevWeight = prev.priorQty - row.qty;
        const newTotal = prevWeight > 0 ? (prev.priorAvgRate ?? 0) * prevWeight + row.avgRate * row.qty : row.avgRate * row.qty;
        prev.priorAvgRate = prev.priorQty > 0 ? newTotal / prev.priorQty : row.avgRate;
      }
      basket.set(row.code, prev);
    }
  }

  // Fill in current average rates
  for (const row of ctx.customerCode) {
    if (row.customer !== customer) continue;
    if (currentMonths.includes(row.monthLabel)) {
      const entry = basket.get(row.code);
      if (entry && row.avgRate != null) {
        // Simple average over current period
        const existing = entry.curAvgRate;
        entry.curAvgRate = existing == null ? row.avgRate : (existing + row.avgRate) / 2;
      }
    }
  }

  if (basket.size === 0) return null;

  // Determine the "as of" date for MRP-then lookup: end of the LAST prior month
  const lastPriorMonth = priorMonths[priorMonths.length - 1]!;
  const priorAsOf = monthLabelToEndDate(lastPriorMonth);

  // Compute Laspeyres MRP index
  let mrpNumerator = 0;
  let mrpDenominator = 0;
  let realisedNumerator = 0;
  let realisedDenominator = 0;
  let coveredValue = 0;
  let totalPriorValue = 0;

  for (const [code, entry] of basket) {
    if (entry.priorQty <= 0) continue;
    totalPriorValue += entry.priorValue;

    // Determine segment for MRP lookup
    // For ambiguous codes, use group_canon as the segment proxy
    const isAmbiguous = ctx.ambiguousCodes.has(code);
    const segment = entry.group ?? "";

    const mrpThen = findMrp(ctx.mrpHistory, code, segment, priorAsOf);
    const mrpNow = isAmbiguous
      ? findCurrentMrp(ctx.mrpHistory, code, segment)
      : ctx.mrpHistory.find((r) => r.itemCode === code && r.isCurrent)?.mrp ?? null;

    if (mrpThen != null && mrpNow != null && mrpThen > 0) {
      mrpNumerator += entry.priorQty * mrpNow;
      mrpDenominator += entry.priorQty * mrpThen;
      coveredValue += entry.priorValue;
    }

    // Realised-price index
    if (entry.priorAvgRate != null && entry.priorAvgRate > 0 && entry.curAvgRate != null) {
      realisedNumerator += entry.priorQty * entry.curAvgRate;
      realisedDenominator += entry.priorQty * entry.priorAvgRate;
    }
  }

  if (mrpDenominator === 0) return null;

  const mrpIndex = mrpNumerator / mrpDenominator;
  const mrpIncreasePct = (mrpIndex - 1) * 100;

  const realisedIndex = realisedDenominator > 0 ? realisedNumerator / realisedDenominator : 1;
  const realisedIncreasePct = (realisedIndex - 1) * 100;

  return {
    mrpIncreasePct,
    realisedIncreasePct,
    basketSize: basket.size,
    coveredValue,
    totalPriorValue,
    coveragePct: totalPriorValue > 0 ? (coveredValue / totalPriorValue) * 100 : 0,
  };
}
