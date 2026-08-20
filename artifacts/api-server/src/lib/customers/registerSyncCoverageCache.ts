type MonthReplaceOutcome = { action: string };

/**
 * A derived open-FY drift result is stale only after register rows were committed.
 * Both normal replacements and final frozen-anchor writes delete and reinsert rows.
 */
export function hasSuccessfulOpenMonthReplacement(
  months: readonly MonthReplaceOutcome[],
): boolean {
  return months.some(
    (month) => month.action === "replaced" || month.action === "frozen-anchored",
  );
}