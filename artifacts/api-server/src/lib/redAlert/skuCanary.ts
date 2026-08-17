// Secondary SKU wipe canary — shared logic consumed by:
//   1. The audit engine (Group 12) — runs against the production DB on every audit
//   2. The alert detection scheduler — frozen-but-empty check, non-blocking
//   3. The CI integration test (aiGrowthReport.activation.test.ts) — dev DB
//
// WHY THIS MODULE EXISTS:
//   The canary logic previously lived only in the CI test file. Schedulers run
//   only in production, so detection was operating on data the canary never
//   checked. July-26 passed in dev while production had zero secondary rows —
//   three false-positive S1 alerts reached a live page before anyone noticed.
//   Extracting here makes the same logic reachable from the production path.
//
// ENVIRONMENT CONTRACT:
//   Every caller must label which environment it is checking. A green canary
//   that only checked dev is worse than none — it implies coverage it does not
//   have. The audit group embeds "server DB (production when deployed)" in
//   each check note; the CI test logs its environment explicitly.

import { fyMonthLabels, priorFy } from "../fyAnchors.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MonthStat = { rows: number; distributors: number };

export type RuleResult = {
  label: string;
  actual: number;
  floor: number;
  pass: boolean;
  skipped: boolean;
};

export type FrozenEmptyMonth = {
  fy: string;
  month_label: string;
};

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

export type CanaryResult = {
  openFy: string;
  priorFy: string;
  completedLabels: string[];
  rows: CanaryRuleRow[];
  /** R2 is evaluated once over all completed months combined. */
  totalRow: CanaryRuleRow;
};

/**
 * Minimal pool interface — matches pg.Pool and vitest mocks.
 * Non-generic so test mocks returning concrete row types satisfy it directly.
 * Callers in this module cast rows to the concrete type they expect.
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

// ── Rule thresholds ───────────────────────────────────────────────────────────

export const RULE1_ROWS_RATIO = 0.6;   // per-month rows vs prior like-month
export const RULE2_TOTAL_RATIO = 0.7;  // completed-month total vs prior like-months
export const RULE3_DIST_RATIO  = 0.7;  // per-month distinct distributors vs prior like-month

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

/**
 * Re-export priorFy under the "priorFyOf" alias used in the canary test.
 * e.g. priorFyOf("2026-27") === "2025-26".
 */
export { priorFy as priorFyOf };

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
 * Frozen-but-empty check: returns months that are frozen in
 * register_month_state (primary data locked) but have ZERO rows in
 * secondary_sku_line for the same (fy, month_label).
 *
 * This is the specific category error that caused the July-26 false-positive
 * S1 alerts: register_month_state tracks the PRIMARY register (sale_line_all),
 * not secondary_sku_line. A month being frozen there says nothing about
 * whether secondary data has been loaded. Guard 3 now cross-validates at
 * runtime (context.ts), but this check makes the invariant testable and
 * visible in the audit xlsx.
 *
 * Non-throwing: callers catch errors themselves and log separately.
 */
export async function runFrozenButEmptyCheck(
  pool: CanaryPool,
  fy: string,
): Promise<FrozenEmptyMonth[]> {
  const res = await pool.query(
    `SELECT rms.fy, rms.month_label
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
     ORDER  BY rms.month_label`,
    [fy],
  );
  return res.rows as unknown as FrozenEmptyMonth[];
}

/**
 * Full wipe canary: queries secondary_sku_line, evaluates all three ratio
 * rules for every completed month, and returns a typed result.
 *
 * @param pool     DB pool — production pool in the audit engine and scheduler;
 *                 dev pool in CI tests. The environment label is the caller's
 *                 responsibility (see ENVIRONMENT CONTRACT above).
 * @param openFy   e.g. "2026-27"
 * @param priorFy_ e.g. "2025-26"
 * @param now      Current date (used by completedMonthLabels)
 */
export async function runSkuWipeCanary(
  pool: CanaryPool,
  openFy: string,
  priorFy_: string,
  now: Date,
): Promise<CanaryResult> {
  const completedLabels = completedMonthLabels(openFy, now);

  const statsRes = await pool.query(WIPE_CANARY_STATS_SQL, [[openFy, priorFy_]]);
  const statsRows = statsRes.rows as unknown as {
    fy: string;
    month_label: string;
    rows: string;
    distributors: string;
  }[];

  const openStats  = new Map<string, MonthStat>();
  const priorStats = new Map<string, MonthStat>();
  for (const r of statsRows) {
    const stat: MonthStat = {
      rows:         parseInt(r.rows, 10),
      distributors: parseInt(r.distributors, 10),
    };
    (r.fy === openFy ? openStats : priorStats).set(r.month_label, stat);
  }

  const ruleRows: CanaryRuleRow[] = [];
  let openTotal  = 0;
  let priorTotal = 0;

  for (const label of completedLabels) {
    const priorLabel = priorLikeMonth(label);
    const open  = openStats.get(label);
    const prior = priorStats.get(priorLabel);
    openTotal  += open?.rows  ?? 0;
    priorTotal += prior?.rows ?? 0;

    const r1 = evalPerMonthRule(label, open?.rows ?? 0, prior?.rows ?? 0, RULE1_ROWS_RATIO);
    ruleRows.push({
      month: label, rule: "R1_rows",
      actual: r1.actual, floor: r1.floor, pass: r1.pass, skipped: r1.skipped,
      priorMonth: priorLabel, priorActual: prior?.rows ?? 0,
    });

    const r3 = evalPerMonthRule(label, open?.distributors ?? 0, prior?.distributors ?? 0, RULE3_DIST_RATIO);
    ruleRows.push({
      month: label, rule: "R3_distributors",
      actual: r3.actual, floor: r3.floor, pass: r3.pass, skipped: r3.skipped,
      priorMonth: priorLabel, priorActual: prior?.distributors ?? 0,
    });
  }

  const r2 = evalTotalRule(openTotal, priorTotal, RULE2_TOTAL_RATIO);
  const totalRow: CanaryRuleRow = {
    month:       completedLabels.length > 0 ? `(${completedLabels.join(", ")})` : "(none)",
    rule:        "R2_total",
    actual:      r2.actual,
    floor:       r2.floor,
    pass:        r2.pass,
    skipped:     r2.skipped,
    priorMonth:  completedLabels.map(priorLikeMonth).join(", "),
    priorActual: priorTotal,
  };

  return { openFy, priorFy: priorFy_, completedLabels, rows: ruleRows, totalRow };
}
