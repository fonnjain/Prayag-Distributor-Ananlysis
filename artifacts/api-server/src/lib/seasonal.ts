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

import { pool } from "@workspace/db";
import seasonalWeightsConfig from "../../config/seasonal_weights.json";
import { logger } from "./logger.js";
import { fyMonthLabels } from "./fyAnchors.js";
import { getFrozenAnchors } from "./customers/freezeState.js";
import {
  buildSeasonalCurveMath,
  compareSeasonalCurveToConfig,
  curveInstabilityNote,
  FISCAL_MONTH_NAMES,
  selectSeasonalCurveActivation,
  type SeasonalCurveMath,
  type SeasonalSourceYear,
} from "./seasonalCurveMath.js";

const MONTH_NAMES = FISCAL_MONTH_NAMES;
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

type ActiveSeasonalCurve = {
  version: number | null;
  sourceFys: string[];
  monthWeightsPct: number[];
  quarterWeightsPct: number[];
  monthShareStddev: number[];
  monthRanges: [number, number][];
  builtFrom: "auto_rebuild" | "manual";
  builtAt: string | null;
  sourceRows: Record<string, number>;
  sourceNet: Record<string, number>;
  sourceBasis: Record<string, string>;
  instabilityNote: string | null;
};

function configuredRuntimeCurve(): ActiveSeasonalCurve {
  const version = resolveVersion();
  const monthly = normalise(version.monthly).map((value) => value * 100);
  const quarterly = [0, 1, 2, 3].map((quarter) =>
    monthly.slice(quarter * 3, quarter * 3 + 3).reduce((sum, value) => sum + value, 0),
  );
  return {
    version: null,
    sourceFys: [version.fy],
    monthWeightsPct: monthly,
    quarterWeightsPct: quarterly,
    monthShareStddev: Array(12).fill(0),
    monthRanges: monthly.map((value) => [value, value]),
    builtFrom: "manual",
    builtAt: null,
    sourceRows: {},
    sourceNet: {},
    sourceBasis: { [version.fy]: "approved_config" },
    instabilityNote: null,
  };
}

let activeCurve: ActiveSeasonalCurve = configuredRuntimeCurve();

function applyActiveCurve(curve: ActiveSeasonalCurve): void {
  activeCurve = curve;
  for (const [idx, month] of MONTH_NAMES.entries()) {
    SEASONAL_WEIGHTS_NAMED[month] = curve.monthWeightsPct[idx] ?? 0;
  }
}

function fractionWeights(calibrationFy?: string): number[] {
  if (calibrationFy) return normalise(resolveVersion(calibrationFy).monthly);
  return activeCurve.monthWeightsPct.map((value) => value / 100);
}

/** Monthly share for fiscal month index (Apr=0 … Mar=11), normalised to sum to 1. */
export function monthlyShare(monthIdx: number, calibrationFy?: string): number {
  return fractionWeights(calibrationFy)[monthIdx] ?? 0;
}

/** Sum of monthly shares for fiscal months [fromIdx, toIdx] inclusive (0-based). */
export function periodShare(fromIdx: number, toIdx: number, calibrationFy?: string): number {
  const normed = fractionWeights(calibrationFy);
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
export const SEASONAL_TOTAL_NAMED = 100;

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
  const fy = calibrationFy ?? activeCurve.sourceFys.at(-1) ?? config.default;
  const share = periodShare(fromIdx, toIdx, calibrationFy);
  const derived = annual * share;
  const numMonths = toIdx - fromIdx + 1;
  const flat = (annual / 12) * numMonths;
  const fromName = MONTH_NAMES[fromIdx] ?? `M${fromIdx + 1}`;
  const toName = MONTH_NAMES[toIdx] ?? `M${toIdx + 1}`;
  const period = fromIdx === toIdx ? fromName : `${fromName}-${toName}`;
  return (
    `${period} target ₹${(derived / 1e7).toFixed(2)} Cr — ` +
    `annual ₹${(annual / 1e7).toFixed(2)} Cr × ${(share * 100).toFixed(1)}% seasonal share ` +
    `(${calibrationFy ? `FY${fy} calibration` : activeCurveBasisLabel()}; flat ÷12×${numMonths} would be ₹${(flat / 1e7).toFixed(2)} Cr)`
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
  version: number | null;
  sourceFys: string[];
  sourceBasis: Record<string, string>;
  builtAt: string | null;
  monthShareStddev: number[];
  monthRanges: [number, number][];
  instabilityNote: string | null;
} {
  if (!calibrationFy) {
    return {
      fy: activeCurve.sourceFys.at(-1) ?? config.default,
      derivedFrom: activeCurveBasisLabel(),
      monthly: activeCurve.monthWeightsPct.map((value) => value / 100),
      quarterly: activeCurve.quarterWeightsPct.map((value) => value / 100),
      monthNames: MONTH_NAMES,
      version: activeCurve.version,
      sourceFys: [...activeCurve.sourceFys],
      sourceBasis: { ...activeCurve.sourceBasis },
      builtAt: activeCurve.builtAt,
      monthShareStddev: [...activeCurve.monthShareStddev],
      monthRanges: activeCurve.monthRanges.map(([min, max]) => [min, max]),
      instabilityNote: activeCurve.instabilityNote,
    };
  }
  const v = resolveVersion(calibrationFy);
  const normed = normalise(v.monthly);
  const qNorm = normedQuarterly(normed);
  return {
    fy: v.fy,
    derivedFrom: v.derivedFrom,
    monthly: normed,
    quarterly: qNorm,
    monthNames: MONTH_NAMES,
    version: null,
    sourceFys: [v.fy],
      sourceBasis: { [v.fy]: "approved_config" },
    builtAt: null,
    monthShareStddev: Array(12).fill(0),
    monthRanges: normed.map((value) => [value * 100, value * 100]),
    instabilityNote: null,
  };
}

function normedQuarterly(normedMonthly: number[]): number[] {
  const starts = [0, 3, 6, 9];
  return starts.map((s) => normedMonthly[s] + normedMonthly[s + 1] + normedMonthly[s + 2]);
}

function activeCurveBasisLabel(): string {
  if (activeCurve.version == null) {
    return `FY${activeCurve.sourceFys[0] ?? config.default} calibration`;
  }
  const first = activeCurve.sourceFys[0];
  const last = activeCurve.sourceFys.at(-1);
  const years = first === last ? `FY${first}` : `FY${first} to FY${last}`;
  const labels: Record<string, string> = {
    channel_retail: "retail channel",
    territory_true: "territory-attributed",
    legacy_unclassified: "legacy unclassified",
  };
  const sources = activeCurve.sourceFys
    .map((fy) => `FY${fy} ${labels[activeCurve.sourceBasis[fy] ?? ""] ?? "source"}`)
    .join(", ");
  return `Seasonal curve v${activeCurve.version} — built from ${years} (${sources})`;
}

type SeasonalCurveRow = {
  id: string | number;
  fiscal_years_used: string[];
  month_weights: Array<string | number>;
  quarter_weights: Array<string | number>;
  month_share_stddev: Array<string | number>;
  month_share_ranges: [Array<string | number>, Array<string | number>][];
  built_at: Date | string;
  built_from: "auto_rebuild" | "manual";
  is_active: boolean;
  source_rows: Record<string, number>;
  source_net: Record<string, number>;
  source_basis: Record<string, string>;
};

function numericArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item));
}

function jsonObject(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, Number(item)]),
  );
}

function jsonStringObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, String(item)]),
  );
}

function rowToActiveCurve(row: SeasonalCurveRow): ActiveSeasonalCurve {
  const monthWeightsPct = numericArray(row.month_weights);
  const quarterWeightsPct = numericArray(row.quarter_weights);
  const monthShareStddev = numericArray(row.month_share_stddev);
  const sourceFys = [...row.fiscal_years_used];
  return {
    version: Number(row.id),
    sourceFys,
    monthWeightsPct,
    quarterWeightsPct,
    monthShareStddev,
    monthRanges: Array.isArray(row.month_share_ranges)
      ? row.month_share_ranges.map(([min, max]) => [Number(min), Number(max)])
      : [],
    builtFrom: row.built_from,
    builtAt: new Date(row.built_at).toISOString(),
    sourceRows: jsonObject(row.source_rows),
    sourceNet: jsonObject(row.source_net),
    sourceBasis: jsonStringObject(row.source_basis),
    instabilityNote: null,
  };
}

async function readActiveCurve(client: { query: Function } = pool): Promise<SeasonalCurveRow | null> {
  const result = await client.query(
    `SELECT id, fiscal_years_used, month_weights, quarter_weights,
            month_share_stddev, month_share_ranges, built_at, built_from, source_rows, source_net,
            source_basis
       FROM seasonal_curve
      WHERE is_active = TRUE
      ORDER BY id DESC
      LIMIT 1`,
  );
  return (result.rows[0] as SeasonalCurveRow | undefined) ?? null;
}

function sameSourceInputs(
  row: SeasonalCurveRow,
  curve: SeasonalCurveMath,
): boolean {
  const rowYears = [...row.fiscal_years_used].sort();
  const curveYears = [...curve.fiscalYearsUsed].sort();
  if (JSON.stringify(rowYears) !== JSON.stringify(curveYears)) return false;
  return JSON.stringify(jsonObject(row.source_rows)) === JSON.stringify(curve.sourceRows) &&
    JSON.stringify(jsonObject(row.source_net)) === JSON.stringify(curve.sourceNet) &&
    JSON.stringify(jsonStringObject(row.source_basis)) === JSON.stringify(curve.sourceBasis);
}

async function loadFrozenSourceYears(): Promise<SeasonalSourceYear[]> {
  const fys = [...getFrozenAnchors().keys()].sort();
  if (fys.length === 0) {
    throw new Error("seasonal curve: no frozen fiscal years are configured");
  }
  const result = await pool.query<{
    fy: string;
    month_label: string;
    rows: string;
    net: string;
    source_basis: string;
  }>(
    `WITH attribution AS (
       SELECT fy,
               COUNT(*)::integer AS total_rows,
               COUNT(*) FILTER (WHERE NULLIF(BTRIM(channel), '') IS NOT NULL)::integer AS channel_rows,
               COUNT(*) FILTER (WHERE is_territory IS NOT NULL)::integer AS territory_rows
         FROM sale_line_current
        WHERE fy = ANY($1::text[])
        GROUP BY fy
     ),
     selected AS (
       SELECT sl.fy,
              sl.month_label,
              sl.amount,
              CASE
                 -- A source can be narrowed only when every row has an
                 -- authoritative classification. A partial label would
                 -- silently drop unclassified business and create a
                 -- commercially incomparable monthly shape.
                 WHEN a.channel_rows = a.total_rows THEN 'channel_retail'
                 WHEN a.channel_rows > 0 THEN 'channel_incomplete'
                 WHEN a.territory_rows = a.total_rows THEN 'territory_true'
                 WHEN a.territory_rows > 0 THEN 'territory_incomplete'
                ELSE 'legacy_unclassified'
              END AS source_basis
         FROM sale_line_current sl
         JOIN attribution a USING (fy)
         WHERE (a.channel_rows = a.total_rows AND sl.channel = 'Retail')
            OR (a.channel_rows < a.total_rows)
            OR (a.channel_rows = 0 AND a.territory_rows = a.total_rows AND sl.is_territory = TRUE)
     )
     SELECT fy, month_label, source_basis, COUNT(*)::text AS rows,
            COALESCE(SUM(amount::numeric), 0)::text AS net
       FROM selected
      GROUP BY fy, month_label, source_basis`,
    [fys],
  );
  const byFy = new Map<string, Map<string, { rows: number; net: number }>>();
  const sourceBasisByFy = new Map<string, string>();
  for (const row of result.rows) {
    const existingBasis = sourceBasisByFy.get(row.fy);
    if (existingBasis && existingBasis !== row.source_basis) {
      throw new Error(`seasonal curve: FY${row.fy} resolved to multiple source bases`);
    }
    sourceBasisByFy.set(row.fy, row.source_basis);
    const months = byFy.get(row.fy) ?? new Map();
    months.set(row.month_label, {
      rows: Number(row.rows),
      net: Number(row.net),
    });
    byFy.set(row.fy, months);
  }

  return fys.map((fy) => {
    const months = byFy.get(fy);
    const labels = fyMonthLabels(fy);
    if (!months || labels.some((label) => !months.has(label))) {
      throw new Error(
        `seasonal curve: frozen FY${fy} is incomplete in sale_line_current; ` +
        `expected all 12 fiscal months on its resolved seasonal basis`,
      );
    }
    const monthlyNet = labels.map((label) => months.get(label)?.net ?? 0);
    const rows = labels.reduce((sum, label) => sum + (months.get(label)?.rows ?? 0), 0);
    if (monthlyNet.reduce((sum, value) => sum + value, 0) <= 0) {
      throw new Error(`seasonal curve: frozen FY${fy} has no positive net on its resolved seasonal basis`);
    }
    return {
      fy,
      monthlyNet,
      rows,
      sourceBasis: sourceBasisByFy.get(fy) ?? "legacy_unclassified",
    };
  });
}

function materialBaselineFinding(
  sourceYears: SeasonalSourceYear[],
): ReturnType<typeof compareSeasonalCurveToConfig> {
  const baseline = sourceYears.find((source) => source.fy === "2025-26");
  if (!baseline) {
    throw new Error("seasonal curve: FY2025-26 is required for baseline verification");
  }
  if (baseline.sourceBasis !== "channel_retail") {
    throw new Error(
      `seasonal curve: FY2025-26 must be completely retail-classified before ` +
      `it can replace the approved config (got ${baseline.sourceBasis})`,
    );
  }
  const curve = buildSeasonalCurveMath([baseline]);
  const comparison = compareSeasonalCurveToConfig(curve, resolveVersion("2025-26").monthly);
  logger.info(
    {
      q1DeltaPp: comparison.q1Delta,
      q4DeltaPp: comparison.q4Delta,
      maxAbsMonthDeltaPp: comparison.maxAbsMonthDelta,
      monthDeltaPp: comparison.monthDelta,
    },
    "seasonal curve: FY2025-26 baseline verification",
  );
  if (comparison.maxAbsMonthDelta > 0.1) {
    throw new Error(
      `seasonal curve: FY2025-26 extraction differs materially from config ` +
      `(max monthly delta ${comparison.maxAbsMonthDelta.toFixed(2)}pp; ` +
      `Q1 ${comparison.q1Delta.toFixed(2)}pp, Q4 ${comparison.q4Delta.toFixed(2)}pp)`,
    );
  }
  return comparison;
}

function curveDelta(
  previous: SeasonalCurveRow | null,
  next: SeasonalCurveMath,
): Record<string, unknown> | null {
  if (!previous) return null;
  const oldMonths = numericArray(previous.month_weights);
  const oldQuarters = numericArray(previous.quarter_weights);
  return {
    monthPp: next.monthWeights.map((value, idx) => value - (oldMonths[idx] ?? 0)),
    quarterPp: next.quarterWeights.map((value, idx) => value - (oldQuarters[idx] ?? 0)),
  };
}

async function persistCurve(
  curve: SeasonalCurveMath,
  builtFrom: "auto_rebuild" | "manual",
  force: boolean,
): Promise<{ row: SeasonalCurveRow; rebuilt: boolean; delta: Record<string, unknown> | null }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('seasonal_curve_rebuild'))");
    const previous = await readActiveCurve(client);
    if (!force && previous && sameSourceInputs(previous, curve)) {
      await client.query("COMMIT");
      return { row: previous, rebuilt: false, delta: null };
    }
    const delta = curveDelta(previous, curve);
    if (previous) {
      await client.query("UPDATE seasonal_curve SET is_active = FALSE WHERE id = $1", [previous.id]);
    }
    const inserted = await client.query(
      `INSERT INTO seasonal_curve
         (fiscal_years_used, month_weights, quarter_weights, month_share_stddev, month_share_ranges,
          built_from, is_active, source_rows, source_net, source_basis, delta)
       VALUES ($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::jsonb,
                $6, TRUE, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
       RETURNING id, fiscal_years_used, month_weights, quarter_weights,
                  month_share_stddev, month_share_ranges, built_at, built_from, source_rows, source_net,
                  source_basis`,
      [
        curve.fiscalYearsUsed,
        curve.monthWeights,
        curve.quarterWeights,
        curve.monthShareStddev,
        JSON.stringify(curve.monthRanges),
        builtFrom,
        JSON.stringify(curve.sourceRows),
        JSON.stringify(curve.sourceNet),
        JSON.stringify(curve.sourceBasis),
        delta ? JSON.stringify(delta) : null,
      ],
    );
    await client.query("COMMIT");
    const row = inserted.rows[0] as SeasonalCurveRow;
    return { row, rebuilt: true, delta };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeSeasonalCurve(): Promise<void> {
  const sourceYears = await loadFrozenSourceYears();
  materialBaselineFinding(sourceYears);
  const existing = await readActiveCurve();
  const activation = selectSeasonalCurveActivation(sourceYears);

  // A fresh history always retains the reconciled FY2025-26 baseline before
  // any eligible multi-year curve is appended. Existing histories simply
  // reconcile the active row against the currently valid selection.
  if (!existing) {
    const baseline = buildSeasonalCurveMath([
      sourceYears.find((source) => source.fy === "2025-26")!,
    ]);
    const first = await persistCurve(baseline, "auto_rebuild", false);
    applyActiveCurve({
      ...rowToActiveCurve(first.row),
      monthRanges: baseline.monthRanges,
      instabilityNote: curveInstabilityNote(baseline),
    });
    logger.info(
      { version: first.row.id, sourceFys: baseline.fiscalYearsUsed },
      "seasonal curve: initialized verified baseline version",
    );
  }

  const active = await readActiveCurve();
  const selected = await persistCurve(activation.curve, "auto_rebuild", false);
  const activeRow = selected.row ?? active;
  applyActiveCurve({
    ...rowToActiveCurve(activeRow),
    monthRanges: activation.curve.monthRanges,
    instabilityNote: curveInstabilityNote(activation.curve),
  });

  if (activation.blockedFiscalYears.length > 0) {
    logger.warn(
      {
        version: activeRow.id,
        blockedFiscalYears: activation.blockedFiscalYears,
        activeSourceFys: activation.curve.fiscalYearsUsed,
      },
      "seasonal curve: multi-year activation withheld until every frozen year has comparable retail/territory attribution",
    );
  } else if (selected.rebuilt) {
    logger.info(
      {
        version: activeRow.id,
        sourceFys: activation.curve.fiscalYearsUsed,
        monthWeights: activation.curve.monthWeights,
        quarterWeights: activation.curve.quarterWeights,
        monthShareStddev: activation.curve.monthShareStddev,
        delta: selected.delta,
      },
      "seasonal curve: initialized equal-weight multi-year version",
    );
  }
}

export async function rebuildSeasonalCurve(options: {
  builtFrom?: "auto_rebuild" | "manual";
  force?: boolean;
} = {}): Promise<{
  version: number | null;
  rebuilt: boolean;
  sourceFys: string[];
  blockedFiscalYears: Array<{ fy: string; sourceBasis: string }>;
  delta: Record<string, unknown> | null;
}> {
  const sourceYears = await loadFrozenSourceYears();
  materialBaselineFinding(sourceYears);
  const activation = selectSeasonalCurveActivation(sourceYears);
  const curve = activation.curve;
  const result = await persistCurve(curve, options.builtFrom ?? "auto_rebuild", options.force ?? false);
  if (result.rebuilt) {
    applyActiveCurve({
      ...rowToActiveCurve(result.row),
      monthRanges: curve.monthRanges,
      instabilityNote: curveInstabilityNote(curve),
    });
    logger.info(
      {
        version: result.row.id,
        sourceFys: curve.fiscalYearsUsed,
        monthWeights: curve.monthWeights,
        quarterWeights: curve.quarterWeights,
        monthShareStddev: curve.monthShareStddev,
        delta: result.delta,
        builtFrom: options.builtFrom ?? "auto_rebuild",
      },
      "seasonal curve: rebuild complete",
    );
  }
  return {
    version: Number(result.row.id),
    rebuilt: result.rebuilt,
    sourceFys: curve.fiscalYearsUsed,
    blockedFiscalYears: activation.blockedFiscalYears,
    delta: result.delta,
  };
}

export async function previewSeasonalCurve(): Promise<{
  sourceYears: SeasonalSourceYear[];
  baseline: SeasonalCurveMath;
  multiYear: SeasonalCurveMath;
  activation: ReturnType<typeof selectSeasonalCurveActivation>;
  comparison: ReturnType<typeof compareSeasonalCurveToConfig>;
}> {
  const sourceYears = await loadFrozenSourceYears();
  const baselineSource = sourceYears.find((source) => source.fy === "2025-26");
  if (!baselineSource) {
    throw new Error("seasonal curve: FY2025-26 is required for baseline verification");
  }
  const baseline = buildSeasonalCurveMath([baselineSource]);
  return {
    sourceYears,
    baseline,
    multiYear: buildSeasonalCurveMath(sourceYears),
    activation: selectSeasonalCurveActivation(sourceYears),
    comparison: compareSeasonalCurveToConfig(
      baseline,
      resolveVersion("2025-26").monthly,
    ),
  };
}

function afterApril7(now: Date): boolean {
  const fiscalStartYear =
    now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return now.getTime() >= Date.UTC(fiscalStartYear, 3, 7);
}

export async function maybeRebuildSeasonalCurve(now = new Date(Date.now())): Promise<void> {
  if (!afterApril7(now)) return;
  const sourceYears = await loadFrozenSourceYears();
  const current = await readActiveCurve();
  const activation = selectSeasonalCurveActivation(sourceYears);
  if (!current || !sameSourceInputs(current, activation.curve)) {
    await rebuildSeasonalCurve({ builtFrom: "auto_rebuild" });
  }
}

let seasonalTimer: NodeJS.Timeout | null = null;

export function startSeasonalCurveScheduler(): void {
  if (seasonalTimer) return;
  void maybeRebuildSeasonalCurve().catch((err) =>
    logger.error({ err }, "seasonal curve: scheduled rebuild failed"),
  );
  seasonalTimer = setInterval(() => {
    void maybeRebuildSeasonalCurve().catch((err) =>
      logger.error({ err }, "seasonal curve: scheduled rebuild failed"),
    );
  }, 24 * 60 * 60 * 1000);
  seasonalTimer.unref();
}

export async function listSeasonalCurves(): Promise<SeasonalCurveRow[]> {
  const result = await pool.query(
    `SELECT id, fiscal_years_used, month_weights, quarter_weights,
            month_share_stddev, month_share_ranges, built_at, built_from, is_active,
             source_rows, source_net, source_basis, delta
       FROM seasonal_curve
      ORDER BY id DESC`,
  );
  return result.rows as SeasonalCurveRow[];
}
