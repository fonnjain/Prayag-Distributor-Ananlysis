// Shared SKU wipe canary logic.
//
// Extracted so the audit engine (Group 12), the alert detection scheduler,
// and the CI integration test can all consume the same rules without
// duplicating SQL or evaluation logic.
//
// RULES:
//   R1  per-month open-FY rows   >= 0.60 × prior like-month rows
//   R2  completed-month total    >= 0.70 × prior like-month total (aggregate)
//   R3  per-month distinct dists >= 0.70 × prior like-month distinct dists
//   R4  frozen months in register_month_state must have > 0 secondary_sku_line rows
//       (the exact scenario that produced July-26 false-positive S1 alerts)
//
// Rules 1 and 3 are per-month because Rule 2 alone cannot catch a single-month
// wipe.  Rule 4 is a structural cross-check independent of ratios.
//
// ENVIRONMENT CONTRACT:
//   Every caller labels which environment it is checking. A green canary that
//   only checked dev implies coverage it does not have. The audit group embeds
//   "server DB (production when deployed)" in each check note; the CI test logs
//   its environment explicitly.

import { fyMonthLabels, fyStartYear } from "../fyAnchors.js";

// ── Pool types ────────────────────────────────────────────────────────────────

/**
 * Minimal pool interface used by all canary functions.
 * Non-generic so test mocks returning concrete row types satisfy it directly.
 * Compatible with pg.Pool and the DbPool type from types.ts.
 */
export type CanaryPool = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

// ── SQL ───────────────────────────────────────────────────────────────────────

/**
 * Row/distributor counts per (fy, month_label). Pass both openFy and priorFy
 * in the $1 array to retrieve stats for both in one query.
 * Table is qualified as public.secondary_sku_line so it resolves correctly
 * even when the connection has a non-public search_path (e.g. CI test setup).
 */
export const WIPE_CANARY_STATS_SQL = `
    SELECT fy,
           month_label,
           COUNT(*)::text                                        AS rows,
           COUNT(DISTINCT NULLIF(TRIM(distributor), ''))::text   AS distributors
    FROM   public.secondary_sku_line
    WHERE  fy = ANY($1::text[])
    GROUP  BY fy, month_label
`;

/** Frozen-month cross-check SQL (Rule 4).
 *  Returns every frozen month alongside how many secondary_sku_line rows it has. */
const FROZEN_EMPTY_SQL = `
    SELECT rms.fy,
           rms.month_label,
           rms.frozen_at::text         AS frozen_at,
           COUNT(ssl.*)::text           AS secondary_rows
    FROM   register_month_state rms
    LEFT   JOIN public.secondary_sku_line ssl
           ON  ssl.fy          = rms.fy
           AND ssl.month_label = rms.month_label
    WHERE  rms.frozen_at IS NOT NULL
    GROUP  BY rms.fy, rms.month_label, rms.frozen_at
`;

/** Per-FY frozen-but-empty query (Rule 4, per-FY variant).
 *  Returns months frozen in register_month_state that have ZERO secondary rows.
 *  Used by runFrozenButEmptyCheck. */
const FROZEN_BUT_EMPTY_SQL = `
    SELECT rms.fy, rms.month_label
    FROM   register_month_state rms
    WHERE  rms.frozen_at IS NOT NULL
      AND  rms.fy = $1
      AND  NOT EXISTS (
             SELECT 1
             FROM   secondary_sku_line ssl
             WHERE  ssl.fy         = rms.fy
               AND  ssl.month_label = rms.month_label
             LIMIT  1
           )
    ORDER  BY rms.month_label
`;

// ── Rule thresholds ───────────────────────────────────────────────────────────

export const RULE1_ROWS_RATIO = 0.6;   // per-month rows vs prior like-month
export const RULE2_TOTAL_RATIO = 0.7;  // completed-month total vs prior like-months
export const RULE3_DIST_RATIO  = 0.7;  // per-month distinct distributors vs prior like-month

// ── Types ─────────────────────────────────────────────────────────────────────

export type MonthStat = { rows: number; distributors: number };

/** Evaluation result returned by the pure evaluators. */
export type RuleResult = {
  label: string;
  actual: number;
  floor: number;
  pass: boolean;
  skipped: boolean;
};

/** One result row as surfaced in the audit group and scheduler log. */
export type CanaryRuleResult = {
  fy: string;
  monthLabel: string;
  rule: string;
  actual: number;
  floor: number;
  pass: boolean;
  skipped: boolean;
  environment: string;
};

/** One frozen-month cross-check result (R4). */
export type FrozenEmptyResult = {
  fy: string;
  monthLabel: string;
  frozenAt: string;
  secondaryRows: number;
  /** false when frozen_at IS NOT NULL but secondary rows == 0. */
  pass: boolean;
};

/** Frozen-but-empty month identifier (used by runFrozenButEmptyCheck). */
export type FrozenEmptyMonth = {
  fy: string;
  month_label: string;
};

/** Per-month rule row used by the CanaryResult (legacy / audit-compat) API. */
export type CanaryRuleRow = {
  month: string;
  rule: "R1_rows" | "R2_total" | "R3_distributors";
  actual: number;
  floor: number;
  pass: boolean;
  skipped: boolean;
  priorMonth: string;
  priorActual: number;
};

/** Result type returned by the positional-argument runSkuWipeCanary overload. */
export type CanaryResult = {
  openFy: string;
  priorFy: string;
  completedLabels: string[];
  rows: CanaryRuleRow[];
  /** R2 is evaluated once over all completed months combined. */
  totalRow: CanaryRuleRow;
};

/** Full canary run output (returned by the opts-style runSkuWipeCanary). */
export type CanaryRunResult = {
  environment: string;
  openFy: string;
  priorFy: string;
  completedMonths: string[];
  rule1Results: CanaryRuleResult[];
  rule2Result: CanaryRuleResult;
  rule3Results: CanaryRuleResult[];
  frozenEmptyResults: FrozenEmptyResult[];
  anyFail: boolean;
};

// ── Calendar helpers ──────────────────────────────────────────────────────────

/**
 * Month labels of `fy` whose calendar month has fully elapsed before `now`.
 * Derived from the calendar only — NOT from register_month_state — so this
 * applies to secondary data completeness regardless of primary freeze state.
 */
export function completedMonthLabels(fy: string, now: Date): string[] {
  const startYear = parseInt(fy.slice(0, 4), 10);
  return fyMonthLabels(fy).filter((_, i) => {
    const monthIdx = (3 + i) % 12;           // Apr=3 … Mar=2
    const year = startYear + (monthIdx < 3 ? 1 : 0);
    const monthEnd = Date.UTC(year, monthIdx + 1, 1); // first instant of next month
    return monthEnd <= now.getTime();
  });
}

/** "Apr-26" → "Apr-25": same month name one FY earlier. */
export function priorLikeMonth(label: string): string {
  const [mon, yy] = label.split("-");
  return `${mon}-${String(parseInt(yy!, 10) - 1).padStart(2, "0")}`;
}

/** "2026-27" → "2025-26" */
export function priorFyOf(fy: string): string {
  const start = parseInt(fy.slice(0, 4), 10) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// ── Pure rule evaluators ──────────────────────────────────────────────────────

/**
 * Rule 1 / Rule 3 per-month evaluation.
 * Zero prior denominator → skipped=true. Callers must treat skipped as a
 * failure: a wiped prior FY must not silently disarm the canary.
 */
export function evalPerMonthRule(
  label: string,
  actual: number,
  priorDenominator: number,
  ratio: number,
): RuleResult {
  if (priorDenominator <= 0) {
    return { label, actual, floor: 0, pass: true, skipped: true };
  }
  const floor = ratio * priorDenominator;
  return { label, actual, floor, pass: actual >= floor, skipped: false };
}

/** Rule 2: total rows across all completed months vs prior like-month total. */
export function evalTotalRule(
  openTotal: number,
  priorTotal: number,
  ratio: number,
): RuleResult {
  if (priorTotal <= 0) {
    return { label: "total", actual: openTotal, floor: 0, pass: true, skipped: true };
  }
  const floor = ratio * priorTotal;
  return { label: "total", actual: openTotal, floor, pass: openTotal >= floor, skipped: false };
}

// ── DB-backed checks ──────────────────────────────────────────────────────────

/**
 * Frozen-but-empty check (Rule 4, per-FY variant).
 *
 * Returns months that are frozen in register_month_state (primary data locked)
 * but have ZERO rows in secondary_sku_line for the same (fy, month_label).
 *
 * This is the specific category error that caused the July-26 false-positive
 * S1 alerts: register_month_state tracks the PRIMARY register (sale_line_all),
 * not secondary_sku_line. A month being frozen there says nothing about whether
 * secondary data has been loaded. Guard 3 now cross-validates at runtime
 * (context.ts), but this check makes the invariant testable and visible in the
 * audit xlsx.
 *
 * Non-throwing: callers catch errors themselves and log separately.
 */
export async function runFrozenButEmptyCheck(
  pool: CanaryPool,
  fy: string,
): Promise<FrozenEmptyMonth[]> {
  const res = await pool.query(FROZEN_BUT_EMPTY_SQL, [fy]);
  return res.rows as unknown as FrozenEmptyMonth[];
}

// ── Main canary runner ────────────────────────────────────────────────────────

/**
 * Run the full SKU wipe canary (R1–R4) against the given pool.
 *
 * The open FY is derived from opts.now (defaults to Date.now()), so callers
 * do not need to compute it themselves. The production alert scheduler and the
 * audit engine both use this API.
 *
 * @param pool - DB pool (production pool in the audit engine and scheduler;
 *   dev pool in CI tests).
 * @param opts.environment - Label embedded in every result row ("dev" / "production").
 * @param opts.now - Clock override for testing.
 */
export async function runSkuWipeCanary(
  pool: CanaryPool,
  opts: { environment?: string; now?: Date } = {},
): Promise<CanaryRunResult> {
  const environment = opts.environment ?? "production";
  const now = opts.now ?? new Date(Date.now());

  const openStart = fyStartYear(now);
  const openFy = `${openStart}-${String((openStart + 1) % 100).padStart(2, "0")}`;
  const priorFy = priorFyOf(openFy);
  const completedMonths = completedMonthLabels(openFy, now);

  // ── Load open + prior FY stats in one query ────────────────────────────────
  const canaryRes = await pool.query(WIPE_CANARY_STATS_SQL, [[openFy, priorFy]]);
  const statsRows = canaryRes.rows as unknown as {
    fy: string; month_label: string; rows: string; distributors: string;
  }[];

  const openMonthStats = new Map<string, MonthStat>();
  const priorMonthStats = new Map<string, MonthStat>();
  for (const r of statsRows) {
    const stat: MonthStat = {
      rows: parseInt(r.rows, 10),
      distributors: parseInt(r.distributors, 10),
    };
    (r.fy === openFy ? openMonthStats : priorMonthStats).set(r.month_label, stat);
  }

  // ── Rule 1: per-month rows ratio ───────────────────────────────────────────
  const rule1Results: CanaryRuleResult[] = [];
  for (const label of completedMonths) {
    const prior = priorMonthStats.get(priorLikeMonth(label));
    const open = openMonthStats.get(label);
    const r = evalPerMonthRule(label, open?.rows ?? 0, prior?.rows ?? 0, RULE1_ROWS_RATIO);
    rule1Results.push({
      fy: openFy, monthLabel: label, rule: "R1:rows_ratio",
      actual: r.actual, floor: r.floor, pass: r.pass, skipped: r.skipped, environment,
    });
  }

  // ── Rule 2: completed-month total ratio ────────────────────────────────────
  let openTotal = 0;
  let priorTotal = 0;
  for (const label of completedMonths) {
    openTotal += openMonthStats.get(label)?.rows ?? 0;
    priorTotal += priorMonthStats.get(priorLikeMonth(label))?.rows ?? 0;
  }
  const r2 = evalTotalRule(openTotal, priorTotal, RULE2_TOTAL_RATIO);
  const rule2Result: CanaryRuleResult = {
    fy: openFy, monthLabel: "total", rule: "R2:total_ratio",
    actual: r2.actual, floor: r2.floor, pass: r2.pass, skipped: r2.skipped, environment,
  };

  // ── Rule 3: per-month distinct-distributor ratio ───────────────────────────
  const rule3Results: CanaryRuleResult[] = [];
  for (const label of completedMonths) {
    const prior = priorMonthStats.get(priorLikeMonth(label));
    const open = openMonthStats.get(label);
    const r = evalPerMonthRule(
      label, open?.distributors ?? 0, prior?.distributors ?? 0, RULE3_DIST_RATIO,
    );
    rule3Results.push({
      fy: openFy, monthLabel: label, rule: "R3:dist_ratio",
      actual: r.actual, floor: r.floor, pass: r.pass, skipped: r.skipped, environment,
    });
  }

  // ── Rule 4: frozen months with zero secondary rows ─────────────────────────
  const frozenRes = await pool.query(FROZEN_EMPTY_SQL, []);
  const frozenRows = frozenRes.rows as unknown as {
    fy: string; month_label: string; frozen_at: string; secondary_rows: string;
  }[];

  const frozenEmptyResults: FrozenEmptyResult[] = frozenRows.map((row) => ({
    fy: row.fy,
    monthLabel: row.month_label,
    frozenAt: row.frozen_at,
    secondaryRows: parseInt(row.secondary_rows, 10),
    pass: parseInt(row.secondary_rows, 10) > 0,
  }));

  // ── Aggregate pass/fail ────────────────────────────────────────────────────
  const anyFail =
    rule1Results.some((r) => !r.pass && !r.skipped) ||
    (!rule2Result.skipped && !rule2Result.pass) ||
    rule3Results.some((r) => !r.pass && !r.skipped) ||
    frozenEmptyResults.some((r) => !r.pass);

  return {
    environment,
    openFy,
    priorFy,
    completedMonths,
    rule1Results,
    rule2Result,
    rule3Results,
    frozenEmptyResults,
    anyFail,
  };
}
