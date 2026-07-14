// Seasonal target splitting.
//
// ── KEY RULES ────────────────────────────────────────────────────────────────
//
// Rule 1 — Real data always wins.
//   This module is ONLY called when no monthly override exists in the Target
//   Master (i.e. only an annual figure is stored).  It must never overwrite a
//   genuine hand-entered plan.  Secondary plans from the STATE HEAD DASHBOARD
//   are real monthly figures and must never be touched by this code.
//
// Rule 2 — Retail/territorial basis only.
//   Do NOT apply seasonal splitting to institutional/tender business
//   (the "Non-territory" bucket).  That business is lumpy and tender-driven.
//
// Rule 5 — Same curve for projections.
//   The SEASONAL_WEIGHTS_NAMED export makes the same weights available to the
//   customer-analytics projection path so both use an identical calibration.
//
// ─────────────────────────────────────────────────────────────────────────────
//
// SINGLE-YEAR CALIBRATION CAVEAT
//   The weights below are derived from FY2025-26 actuals (a single year).
//   They have NOT yet been validated against a second year.  The client
//   intends to rebuild the table after FY2026-27 completes.  The JSON config
//   is versioned so each year's calibration is preserved and the default can
//   be updated without a code change.

import seasonalWeightsConfig from "../../config/seasonal_weights.json";

const MONTH_NAMES = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"] as const;
export type MonthName = (typeof MONTH_NAMES)[number];

type WeightVersion = {
  fy: string;
  derivedFrom: string;
  monthly: number[];   // 12 values, Apr=0 … Mar=11
  quarterly: number[]; // 4 values, Q1=0 … Q4=3
};

type SeasonalConfig = {
  _note: string;
  versions: WeightVersion[];
  default: string;
};

const config = seasonalWeightsConfig as SeasonalConfig;

function resolveVersion(calibrationFy?: string): WeightVersion {
  const fy = calibrationFy ?? config.default;
  const v = config.versions.find((w) => w.fy === fy);
  if (!v) throw new Error(`seasonal: no weights found for calibration FY ${fy}`);
  return v;
}

function normalise(monthly: number[]): number[] {
  const sum = monthly.reduce((a, b) => a + b, 0);
  return monthly.map((w) => (sum > 0 ? w / sum : 1 / monthly.length));
}

/** Monthly share for fiscal month index (Apr=0 … Mar=11), normalised to sum to 1. */
export function monthlyShare(monthIdx: number, calibrationFy?: string): number {
  return normalise(resolveVersion(calibrationFy).monthly)[monthIdx] ?? 0;
}

/** Sum of monthly shares for fiscal months [fromIdx, toIdx] inclusive (0-based). */
export function periodShare(fromIdx: number, toIdx: number, calibrationFy?: string): number {
  const normed = normalise(resolveVersion(calibrationFy).monthly);
  let sum = 0;
  for (let i = fromIdx; i <= toIdx; i++) sum += normed[i] ?? 0;
  return sum;
}

/**
 * Split an annual target into the amount attributable to a single fiscal month.
 *
 * IMPORTANT: Only call this when there is NO explicit monthly override stored
 * in the Target Master.  Real plan figures must never be replaced by a derived split.
 * Do NOT apply to institutional/Non-territory business.
 */
export function splitAnnualToMonth(
  annual: number | null,
  monthIdx: number,
  calibrationFy?: string,
): number | null {
  if (annual == null) return null;
  return annual * monthlyShare(monthIdx, calibrationFy);
}

/**
 * Split an annual target into the amount attributable to a period [fromIdx, toIdx].
 * Returns null when annual is null.
 */
export function splitAnnualToPeriod(
  annual: number | null,
  fromIdx: number,
  toIdx: number,
  calibrationFy?: string,
): number | null {
  if (annual == null) return null;
  return annual * periodShare(fromIdx, toIdx, calibrationFy);
}

/**
 * Named seasonal weights (Apr/May/…/Mar → share as a PERCENTAGE, e.g. 4.2 for Apr).
 * Used by the customer-analytics projection path (same format as the former inline table).
 * Normalised so the values sum to exactly 100.
 */
export const SEASONAL_WEIGHTS_NAMED: Record<string, number> = (() => {
  const normed = normalise(resolveVersion().monthly);
  return Object.fromEntries(MONTH_NAMES.map((m, i) => [m, normed[i] * 100]));
})();

/** Sum of SEASONAL_WEIGHTS_NAMED values (100.0 after normalisation). */
export const SEASONAL_TOTAL_NAMED: number = Object.values(SEASONAL_WEIGHTS_NAMED).reduce(
  (s, v) => s + v,
  0,
);

/**
 * Human-readable basis label for a seasonally-derived target.
 * Example output:
 *   "Q1 (Apr-Jun) target ₹20.9 Cr — annual ₹100 Cr × 20.9% seasonal share
 *    (FY2025-26 calibration; flat ÷12×3 would be ₹25.0 Cr)"
 */
export function seasonalPeriodLabel(
  fromIdx: number,
  toIdx: number,
  annual: number,
  calibrationFy?: string,
): string {
  const fy = calibrationFy ?? config.default;
  const share = periodShare(fromIdx, toIdx, fy);
  const derived = annual * share;
  const numMonths = toIdx - fromIdx + 1;
  const flat = (annual / 12) * numMonths;
  const fromName = MONTH_NAMES[fromIdx] ?? `M${fromIdx + 1}`;
  const toName = MONTH_NAMES[toIdx] ?? `M${toIdx + 1}`;
  const period = fromIdx === toIdx ? fromName : `${fromName}-${toName}`;
  return (
    `${period} target ₹${(derived / 1e7).toFixed(2)} Cr — ` +
    `annual ₹${(annual / 1e7).toFixed(2)} Cr × ${(share * 100).toFixed(1)}% seasonal share ` +
    `(FY${fy} calibration; flat ÷12×${numMonths} would be ₹${(flat / 1e7).toFixed(2)} Cr)`
  );
}

/**
 * Calibration metadata for a given calibration FY (or the default).
 * Include this in API responses so the frontend can show the basis and caveat.
 */
export function getSeasonalCalibration(calibrationFy?: string): {
  fy: string;
  derivedFrom: string;
  monthly: number[];    // normalised, Apr=0..Mar=11
  quarterly: number[];  // normalised quarterly shares
  monthNames: readonly string[];
} {
  const v = resolveVersion(calibrationFy);
  const normed = normalise(v.monthly);
  const qNorm = normedQuarterly(normed);
  return {
    fy: v.fy,
    derivedFrom: v.derivedFrom,
    monthly: normed,
    quarterly: qNorm,
    monthNames: MONTH_NAMES,
  };
}

function normedQuarterly(normedMonthly: number[]): number[] {
  const starts = [0, 3, 6, 9];
  return starts.map((s) => normedMonthly[s] + normedMonthly[s + 1] + normedMonthly[s + 2]);
}
