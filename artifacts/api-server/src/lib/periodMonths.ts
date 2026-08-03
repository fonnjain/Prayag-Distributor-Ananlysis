// Shared parsing/validation for the `months` query param used by the global
// sub-year period filter (Products / Growth / Momentum exports).
//
// A label is only accepted when it belongs to the requested fiscal year's
// Apr–Mar calendar (e.g. fy=2026-27 accepts Apr-26 … Mar-27). Cross-FY labels
// like Apr-25 are rejected rather than silently remapped. Duplicates are
// removed, order is normalised to fiscal order.

const NAMES = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

/** The 12 month labels of a fiscal year, in fiscal order (Apr first). */
export function fyMonthLabels(fy: string): string[] {
  const start = parseInt(fy.slice(0, 4), 10);
  return NAMES.map((n, i) => `${n}-${String(i < 9 ? start : start + 1).slice(-2)}`);
}

export type MonthsParamResult =
  | { ok: true; months: string[] | undefined }
  | { ok: false; error: string };

/**
 * Parse a comma-separated `months` query value against a fiscal year.
 * Returns undefined months when the param is absent/empty (= full FY).
 */
export function parseMonthsParam(raw: unknown, fy: string): MonthsParamResult {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: true, months: undefined };
  const labels = raw.split(",").map((m) => m.trim()).filter(Boolean);
  const valid = fyMonthLabels(fy);
  const bad = labels.find((l) => !valid.includes(l));
  if (bad != null) {
    return {
      ok: false,
      error: `Invalid months — "${bad}" is not a month of FY ${fy} (expected labels like ${valid[0]}).`,
    };
  }
  // Dedupe and normalise to fiscal order.
  const set = new Set(labels);
  const months = valid.filter((l) => set.has(l));
  return { ok: true, months: months.length > 0 ? months : undefined };
}
