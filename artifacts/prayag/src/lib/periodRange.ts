// periodRange — range aggregation helpers for monthly (fiscal Apr-indexed)
// plan / OB / sales arrays. Extracted from SalesPeople.tsx so the logic is
// unit-testable: a regression that collapses Quarter/YTD/Full Year back to a
// single month's figures is silent on screen (numbers look plausible).
//
// Contract:
// - Arrays are 12-slot monthly values indexed by fiscal month (0=Apr…11=Mar);
//   future / unrecorded months hold null (never manufactured zeros).
// - sumRange sums the inclusive [idxFrom, idxTo] slice; when NO month in the
//   range carries a value it returns null so the UI renders "—", not 0.
// - Achievement % must always be aggregate sales ÷ aggregate plan — never an
//   average of monthly percentages.

/**
 * Sum a monthly array over the inclusive 0-based fiscal index range.
 * Returns null when the array is missing or no month in range has a value.
 */
export function sumRange(
  arr: (number | null | undefined)[] | null | undefined,
  idxFrom: number,
  idxTo: number,
): number | null {
  if (!arr) return null;
  let sum = 0;
  let seen = false;
  for (let i = idxFrom; i <= idxTo; i++) {
    const v = arr[i];
    if (v != null) { sum += v; seen = true; }
  }
  return seen ? sum : null;
}

/**
 * Achievement % = sales ÷ plan × 100. Null when plan is missing/non-positive
 * or sales is missing. Never computed as an average of monthly percentages.
 */
export function achPct(sales: number | null, plan: number | null): number | null {
  if (plan == null || plan <= 0) return null;
  if (sales == null) return null;
  return (sales / plan) * 100;
}
