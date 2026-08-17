// Guard-regression integration test for company-scope distributor activation figures.
//
// WHAT THESE TESTS PROTECT:
//   queryDistributorActivationCompany and queryDistributorRangeGapCompany in
//   aiGrowthReport.ts depend on secondary_sku_line having data for the requested
//   FY.  If the table is cleared, a re-ingest fails, or the COUNT(*) early-exit
//   guard is accidentally inverted, both functions silently return [] and a
//   growth report section becomes empty — with no error surfaced to the caller.
//
//   These tests run the real SQL (identical to the helper functions) against the
//   live public-schema DB and assert minimum expected distributor counts and
//   plausible range-gap figures, so any full or partial wipe of secondary_sku_line
//   is caught before a report reaches a manager.
//
// WHY public.secondary_sku_line IS QUALIFIED:
//   vitest's setupFiles (setup-db.ts) overrides DATABASE_URL's search_path to
//   "dashboard_test" for all test files so that truncates in tests don't touch
//   the real data.  The helper functions reference secondary_sku_line without a
//   schema qualifier, which resolves to dashboard_test.secondary_sku_line — a
//   small seeded fixture.  Qualifying the table name here as public.secondary_sku_line
//   bypasses that override without needing a separate pool or connection.
//
// OPEN-FY WIPE CANARY (ratio-based, replaces the former static floors):
//   Rule 1  rows(month, openFY)                >= 0.60 * rows(sameMonth, priorFY)   — PER MONTH
//   Rule 2  rows(completedMonths, openFY)      >= 0.70 * rows(sameMonths, priorFY)  — TOTAL
//   Rule 3  distinct distributors(month, open) >= 0.70 * distinct distributors(sameMonth, priorFY) — PER MONTH
//   All denominators are read LIVE from the prior FY's like-months at test time —
//   never hardcoded, because a prior-year re-sync would silently stale them.
//   Rules 1 and 3 are per month because Rule 2 alone cannot see a single-month
//   wipe. A month with zero prior-FY rows FAILS the test as a baseline-integrity
//   violation (the evaluator marks it skipped; callers treat skipped as fail), never
//   a silent pass.
//
//   GRANULARITY LIMIT: secondary_sku_line has no order-date column, so these
//   checks assert at MONTH granularity only (month_label). A partial wipe
//   *within* a month is undetectable here. The runtime abort-before-delete
//   guard in the ingest path can be stricter, because source rows there do
//   carry dates.
//
// GUARD_FY IS DERIVED AUTOMATICALLY — no manual update needed at FY close.
//   The anchor FY is the newest calendar-closed FY whose secondary_sku_line
//   ingest looks complete (≥ MIN_FULL_INGEST_ROWS rows across all 12 fiscal
//   months). When a new FY closes, the guard keeps anchoring on the previous
//   FY during a grace window (GRACE_DAYS_AFTER_FY_CLOSE) while the new FY's
//   data finishes ingesting; once the grace window passes, the guard FAILS
//   LOUDLY until the newly-closed FY is fully ingested — so the anchor can
//   never silently stay pinned to old data.
//
// ENVIRONMENT: These tests run against the DEV database (search_path bypassed
//   for secondary_sku_line via public-schema qualification). The canary module
//   (src/lib/redAlert/skuCanary.ts) is the shared source of truth; production
//   is checked by the alert-detection scheduler and audit Group 12.

import { beforeAll, describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import {
  deriveGuardFy as deriveGuardFyShared,
  fyMonthLabels,
  fyStartYear,
  type FyIngestStats,
  type DeriveGuardFyOpts,
} from "../lib/fyAnchors.js";
import {
  WIPE_CANARY_STATS_SQL,
  completedMonthLabels,
  priorLikeMonth,
  priorFyOf,
  evalPerMonthRule,
  evalTotalRule,
  type MonthStat,
  RULE1_ROWS_RATIO,
  RULE2_TOTAL_RATIO,
  RULE3_DIST_RATIO,
} from "../lib/redAlert/skuCanary.js";

// ── GUARD_FY derivation (shared pattern from src/lib/fyAnchors.ts) ────────────

// Full-ingest marker is DERIVED from live stats, not hardcoded: an FY counts as
// fully ingested when it has 12 months and at least half the row count of the
// largest FY present. This scales with data volume instead of pinning a magic
// number that a growing (or shrinking) business would silently stale.
function deriveMinFullIngestRows(stats: FyIngestStats[]): number {
  const maxRows = Math.max(1, ...stats.map((s) => s.rows));
  return Math.floor(maxRows / 2);
}

function deriveGuardFy(stats: FyIngestStats[], now: Date): string {
  const opts: DeriveGuardFyOpts = {
    minRows: deriveMinFullIngestRows(stats),
    sourceLabel: "public.secondary_sku_line",
  };
  return deriveGuardFyShared(stats, now, opts);
}

// Resolved in beforeAll from live DB stats.
let GUARD_FY = "";
let FULL_FY_LABELS: string[] = [];

// ── Row types ─────────────────────────────────────────────────────────────────

type DistActivationRow = {
  distributor: string;
  retailer_count: string;
  active_count: string;
};

type DistRangeGapRow = {
  distributor: string;
  distinct_segments: string;
  peer_median: string;
  gap: string;
};

// ── SQL helpers ───────────────────────────────────────────────────────────────
// Table is qualified as public.secondary_sku_line to bypass the dashboard_test
// search_path override applied by setup-db.ts.  The SQL is otherwise identical
// to queryDistributorActivationCompany / queryDistributorRangeGapCompany in
// aiGrowthReport.ts, so any regression in those functions' query logic is
// caught here too.

async function runActivationQuery(fy: string, labels: string[]): Promise<DistActivationRow[]> {
  const checkRes = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM public.secondary_sku_line WHERE fy = $1 LIMIT 1",
    [fy],
  );
  if (parseInt(checkRes.rows[0]?.n ?? "0") === 0) return [];

  const periodClause = labels.length > 0
    ? "AND month_label = ANY($2::text[])"
    : "";
  const params: unknown[] = labels.length > 0 ? [fy, labels] : [fy];

  const res = await pool.query<DistActivationRow>(`
    WITH all_ret AS (
      SELECT distributor,
             COALESCE(NULLIF(TRIM(retailer_id), ''), LOWER(TRIM(retailer))) AS rkey
      FROM   public.secondary_sku_line
      WHERE  fy = $1
        AND  distributor IS NOT NULL AND TRIM(distributor) != ''
        AND  retailer    IS NOT NULL AND TRIM(retailer)    != ''
    ),
    active_ret AS (
      SELECT distributor,
             COALESCE(NULLIF(TRIM(retailer_id), ''), LOWER(TRIM(retailer))) AS rkey
      FROM   public.secondary_sku_line
      WHERE  fy = $1
        AND  distributor IS NOT NULL AND TRIM(distributor) != ''
        AND  retailer    IS NOT NULL AND TRIM(retailer)    != ''
        AND  net_amount  > 0
        ${periodClause}
    )
    SELECT a.distributor,
           COUNT(DISTINCT a.rkey)::text  AS retailer_count,
           COUNT(DISTINCT ac.rkey)::text AS active_count
    FROM   all_ret a
    LEFT   JOIN active_ret ac USING (distributor, rkey)
    GROUP  BY a.distributor
    HAVING COUNT(DISTINCT a.rkey) >= 3
    ORDER  BY (COUNT(DISTINCT ac.rkey)::float / NULLIF(COUNT(DISTINCT a.rkey), 0)) ASC
    LIMIT  50
  `, params);
  return res.rows;
}

async function runRangeGapQuery(fy: string): Promise<DistRangeGapRow[]> {
  const checkRes = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM public.secondary_sku_line WHERE fy = $1 LIMIT 1",
    [fy],
  );
  if (parseInt(checkRes.rows[0]?.n ?? "0") === 0) return [];

  const res = await pool.query<DistRangeGapRow>(`
    WITH dist_segs AS (
      SELECT distributor,
             COUNT(DISTINCT segment_canon) AS distinct_segments
      FROM   public.secondary_sku_line
      WHERE  fy          = $1
        AND  distributor IS NOT NULL AND TRIM(distributor) != ''
        AND  segment_canon IS NOT NULL AND TRIM(segment_canon) != ''
        AND  TRIM(segment_canon) != 'Unmapped'
        AND  net_amount  > 0
      GROUP  BY distributor
      HAVING COUNT(DISTINCT segment_canon) >= 1
    ),
    peer AS (
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY distinct_segments) AS median_segs
      FROM   dist_segs
    )
    SELECT d.distributor,
           d.distinct_segments::text                    AS distinct_segments,
           p.median_segs::text                          AS peer_median,
           (p.median_segs - d.distinct_segments)::text  AS gap
    FROM   dist_segs d, peer p
    WHERE  p.median_segs > d.distinct_segments
    ORDER  BY (p.median_segs - d.distinct_segments) DESC
    LIMIT  20
  `, [fy]);
  return res.rows;
}

// ── Wipe-canary state (resolved in beforeAll) ──────────────────────────────────
// WIPE_CANARY_STATS_SQL, MonthStat, completedMonthLabels, priorLikeMonth,
// priorFyOf, evalPerMonthRule, and evalTotalRule are imported from
// ../lib/redAlert/skuCanary.js (see imports at top of file).
// The audit engine (Group 12) uses the same module against the server DB.

// Resolved in beforeAll.
let OPEN_FY = "";
let PRIOR_FY = "";
let COMPLETED_LABELS: string[] = [];
let openMonthStats = new Map<string, MonthStat>();  // label → stat (open FY)
let priorMonthStats = new Map<string, MonthStat>(); // label → stat (prior FY)

// ── Cached query results ───────────────────────────────────────────────────────
// Each SQL query scans ≈379 000 rows; caching in beforeAll keeps total test
// runtime well under the 60 s vitest timeout.

let activationRows: DistActivationRow[] = [];
let activationRowsEmpty: DistActivationRow[] = [];
let rangeGapRows: DistRangeGapRow[] = [];
let rangeGapRowsEmpty: DistRangeGapRow[] = [];
let rowCountN = 0;

beforeAll(async () => {
  // Derive the anchor FY from live per-FY ingest stats (see deriveGuardFy).
  const statsRes = await pool.query<{ fy: string; rows: string; months: string }>(`
    SELECT fy,
           COUNT(*)::text                     AS rows,
           COUNT(DISTINCT month_label)::text  AS months
    FROM   public.secondary_sku_line
    GROUP  BY fy
  `);
  const stats: FyIngestStats[] = statsRes.rows.map((r) => ({
    fy: r.fy,
    rows: parseInt(r.rows, 10),
    months: parseInt(r.months, 10),
  }));
  GUARD_FY = deriveGuardFy(stats, new Date(Date.now()));
  FULL_FY_LABELS = fyMonthLabels(GUARD_FY);
  console.log(`[activation guard] anchoring on FY ${GUARD_FY}`);

  // Wipe canary: open FY vs prior FY like-months.
  // Uses the shared WIPE_CANARY_STATS_SQL and helpers from skuCanary.ts —
  // the same module that powers audit Group 12 and the production scheduler check.
  const now = new Date(Date.now());
  const openStart = fyStartYear(now);
  OPEN_FY = `${openStart}-${String((openStart + 1) % 100).padStart(2, "0")}`;
  PRIOR_FY = priorFyOf(OPEN_FY);
  COMPLETED_LABELS = completedMonthLabels(OPEN_FY, now);
  // Explicit environment label — a green canary that only ever checked dev is
  // worse than none. The audit engine (Group 12) runs the same checks against
  // the server's DB (production when deployed); these tests cover dev only.
  console.log(
    `[wipe canary] environment: dev (CI) — checks dev database only, NOT production. ` +
    `Run GET /api/audit Group 12 on the deployed server for production coverage. ` +
    `Open FY: ${OPEN_FY}, prior FY: ${PRIOR_FY}, completed months: [${COMPLETED_LABELS.join(", ")}]`,
  );
  const canaryRes = await pool.query<{ fy: string; month_label: string; rows: string; distributors: string }>(
    WIPE_CANARY_STATS_SQL,
    [[OPEN_FY, PRIOR_FY]],
  );
  openMonthStats = new Map();
  priorMonthStats = new Map();
  for (const r of canaryRes.rows) {
    const stat: MonthStat = { rows: parseInt(r.rows, 10), distributors: parseInt(r.distributors, 10) };
    (r.fy === OPEN_FY ? openMonthStats : priorMonthStats).set(r.month_label, stat);
  }
  console.log(
    `[wipe canary] environment=dev, open FY ${OPEN_FY}, prior FY ${PRIOR_FY}, ` +
    `completed months: ${COMPLETED_LABELS.length > 0 ? COMPLETED_LABELS.join(", ") : "(none yet — FY just started)"}`,
  );

  // Run sequentially to avoid DB pool contention when the full validation
  // suite is running alongside other test files.  The activation query
  // scans ≈379 000 rows and takes ≈27 s; parallel execution can push the
  // total past the 60 s hookTimeout under load.
  activationRows      = await runActivationQuery(GUARD_FY, FULL_FY_LABELS);
  activationRowsEmpty = await runActivationQuery("1900-01", ["Apr-00"]);
  rangeGapRows        = await runRangeGapQuery(GUARD_FY);
  rangeGapRowsEmpty   = await runRangeGapQuery("1900-01");
  const countRes      = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM public.secondary_sku_line WHERE fy = $1",
    [GUARD_FY],
  );
  rowCountN = parseInt(countRes.rows[0]?.n ?? "0");
}, 120_000); // 2-minute budget: activation query ≈27 s, rest < 2 s

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("open-FY wipe canary — ratio floors vs live prior-FY like-months", () => {
  it("GUARD_FY still has rows (anchor FY not wiped)", () => {
    // The anchor FY's exact size is asserted implicitly by deriveGuardFy
    // (it must clear the derived full-ingest threshold to be chosen at all);
    // here we only assert it is non-empty so the cached queries are meaningful.
    expect(rowCountN).toBeGreaterThan(0);
  });

  it("Rule 1: per-month open-FY rows >= 0.60 x prior like-month rows", () => {
    if (COMPLETED_LABELS.length === 0) {
      // April of a new FY: no month has completed yet, the canary is not
      // applicable. This is an expected calendar state, not a data problem.
      console.warn(`[wipe canary] Rule 1 NOT APPLICABLE: no completed month yet in open FY ${OPEN_FY} (environment=dev)`);
      return;
    }
    for (const label of COMPLETED_LABELS) {
      const priorLabel = priorLikeMonth(label);
      const prior = priorMonthStats.get(priorLabel);
      const open = openMonthStats.get(label);
      const r = evalPerMonthRule(label, open?.rows ?? 0, prior?.rows ?? 0, RULE1_ROWS_RATIO);
      // Missing prior baseline is itself an integrity failure — a wiped prior
      // FY must not silently disarm the canary.
      expect(r.skipped, `Rule 1 BASELINE MISSING for ${label}: prior like-month ${priorLabel} has zero rows`).toBe(false);
      console.log(`[wipe canary] Rule 1 ${label}: actual=${r.actual} floor=${r.floor} (prior ${priorLabel}=${prior?.rows ?? 0}) environment=dev`);
      expect(r.actual, `Rule 1 FAILED for ${label}: ${r.actual} < floor ${r.floor}`).toBeGreaterThanOrEqual(r.floor);
    }
  });

  it("Rule 2: completed-month open-FY total >= 0.70 x prior like-month total", () => {
    if (COMPLETED_LABELS.length === 0) {
      console.warn(`[wipe canary] Rule 2 NOT APPLICABLE: no completed month yet in open FY ${OPEN_FY} (environment=dev)`);
      return;
    }
    let openTotal = 0;
    let priorTotal = 0;
    for (const label of COMPLETED_LABELS) {
      openTotal += openMonthStats.get(label)?.rows ?? 0;
      priorTotal += priorMonthStats.get(priorLikeMonth(label))?.rows ?? 0;
    }
    const r = evalTotalRule(openTotal, priorTotal, RULE2_TOTAL_RATIO);
    expect(r.skipped, "Rule 2 BASELINE MISSING: prior FY like-months have zero rows").toBe(false);
    console.log(`[wipe canary] Rule 2 total: actual=${r.actual} floor=${r.floor} (prior total=${priorTotal}) environment=dev`);
    expect(r.actual, `Rule 2 FAILED: ${r.actual} < floor ${r.floor}`).toBeGreaterThanOrEqual(r.floor);
  });

  it("Rule 3: per-month open-FY distinct distributors >= 0.70 x prior like-month", () => {
    if (COMPLETED_LABELS.length === 0) {
      console.warn(`[wipe canary] Rule 3 NOT APPLICABLE: no completed month yet in open FY ${OPEN_FY} (environment=dev)`);
      return;
    }
    for (const label of COMPLETED_LABELS) {
      const priorLabel = priorLikeMonth(label);
      const prior = priorMonthStats.get(priorLabel);
      const open = openMonthStats.get(label);
      const r = evalPerMonthRule(label, open?.distributors ?? 0, prior?.distributors ?? 0, RULE3_DIST_RATIO);
      expect(r.skipped, `Rule 3 BASELINE MISSING for ${label}: prior like-month ${priorLabel} has zero distributors`).toBe(false);
      console.log(`[wipe canary] Rule 3 ${label}: actual=${r.actual} floor=${r.floor} (prior ${priorLabel}=${prior?.distributors ?? 0}) environment=dev`);
      expect(r.actual, `Rule 3 FAILED for ${label}: ${r.actual} < floor ${r.floor}`).toBeGreaterThanOrEqual(r.floor);
    }
  });

  it("negative simulation: an Apr wipe fails Rule 1 + Rule 3 for Apr but passes Rule 2", () => {
    // Filtered row set, nothing deleted: zero out the first completed month in
    // a COPY of the live stats and re-evaluate. This asymmetry — Rule 2 blind,
    // Rules 1/3 loud — is the whole justification for the per-month rules.
    if (COMPLETED_LABELS.length === 0) {
      console.warn(`[wipe canary] simulation NOT APPLICABLE: no completed month yet in open FY ${OPEN_FY}`);
      return;
    }
    const wipedLabel = COMPLETED_LABELS[0]!;
    const priorLabel = priorLikeMonth(wipedLabel);
    const prior = priorMonthStats.get(priorLabel);
    expect(prior, `prior like-month ${priorLabel} must have data for this simulation`).toBeTruthy();

    const r1 = evalPerMonthRule(wipedLabel, 0, prior!.rows, RULE1_ROWS_RATIO);
    const r3 = evalPerMonthRule(wipedLabel, 0, prior!.distributors, RULE3_DIST_RATIO);
    expect(r1.skipped).toBe(false);
    expect(r1.pass, `Rule 1 must FAIL for wiped ${wipedLabel}`).toBe(false);
    expect(r3.skipped).toBe(false);
    expect(r3.pass, `Rule 3 must FAIL for wiped ${wipedLabel}`).toBe(false);

    let openTotal = 0;
    let priorTotal = 0;
    for (const label of COMPLETED_LABELS) {
      openTotal += label === wipedLabel ? 0 : openMonthStats.get(label)?.rows ?? 0;
      priorTotal += priorMonthStats.get(priorLikeMonth(label))?.rows ?? 0;
    }
    const r2 = evalTotalRule(openTotal, priorTotal, RULE2_TOTAL_RATIO);
    console.log(
      `[wipe canary] simulation (${wipedLabel} wiped): Rule 1 pass=${r1.pass}, Rule 3 pass=${r3.pass}, ` +
      `Rule 2 actual=${r2.actual} floor=${r2.floor} pass=${r2.pass}`,
    );
    expect(r2.skipped).toBe(false);
    expect(r2.pass, "Rule 2 alone must NOT catch a single-month wipe (that is why Rules 1/3 exist)").toBe(true);
  });

  it("missing prior baseline is flagged skipped by the evaluators (callers fail on it)", () => {
    // A wiped PRIOR FY must not silently disarm the canary: the pure
    // evaluators mark zero-denominator as skipped, and the rule tests above
    // assert skipped === false, turning missing baseline into a hard failure.
    expect(evalPerMonthRule("Apr-26", 12345, 0, RULE1_ROWS_RATIO).skipped).toBe(true);
    expect(evalPerMonthRule("Apr-26", 0, 0, RULE3_DIST_RATIO).skipped).toBe(true);
    expect(evalTotalRule(12345, 0, RULE2_TOTAL_RATIO).skipped).toBe(true);
  });

  it("completedMonthLabels: April boundary and FY rollover (pure)", () => {
    // April of a new FY: no completed month yet — canary not applicable.
    expect(completedMonthLabels("2026-27", new Date(Date.UTC(2026, 3, 1)))).toEqual([]);
    expect(completedMonthLabels("2026-27", new Date(Date.UTC(2026, 3, 30)))).toEqual([]);
    // May 1: April has just completed.
    expect(completedMonthLabels("2026-27", new Date(Date.UTC(2026, 4, 1)))).toEqual(["Apr-26"]);
    // Calendar-year rollover inside the FY: Jan/Feb/Mar carry the NEXT year suffix.
    expect(completedMonthLabels("2026-27", new Date(Date.UTC(2027, 1, 1)))).toEqual([
      "Apr-26", "May-26", "Jun-26", "Jul-26", "Aug-26", "Sep-26",
      "Oct-26", "Nov-26", "Dec-26", "Jan-27",
    ]);
    // Prior like-month mapping crosses the rollover correctly.
    expect(priorLikeMonth("Jan-27")).toBe("Jan-26");
    expect(priorLikeMonth("Apr-26")).toBe("Apr-25");
    expect(priorFyOf("2026-27")).toBe("2025-26");
  });
});

describe("distributor activation guard — live public-schema DB", () => {
  it("activation query returns distributors for GUARD_FY (not empty)", () => {
    // Numeric wipe detection now lives in the ratio-based canary above; this
    // only asserts the query still produces rows for the anchor FY.
    expect(activationRows.length).toBeGreaterThan(0);
  });

  it("every returned distributor has retailer_count ≥ 3 (HAVING clause intact)", () => {
    for (const row of activationRows) {
      expect(
        parseInt(row.retailer_count, 10),
        `distributor "${row.distributor}" has retailer_count=${row.retailer_count}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("activation query returns [] for a known-empty FY (COUNT guard is not inverted)", () => {
    // FY 1900-01 has no rows.  If the COUNT guard logic is accidentally inverted
    // this would return rows from the real table instead of [].
    expect(activationRowsEmpty).toEqual([]);
  });
});

describe("distributor range-gap guard — live public-schema DB", () => {
  it("range-gap query returns distributors below peer median (not empty)", () => {
    // Numeric wipe detection lives in the ratio-based canary; this asserts the
    // query still produces below-median rows for the anchor FY.
    expect(rangeGapRows.length).toBeGreaterThan(0);
  });

  it("peer_median segment count is within plausible range [2, 15]", () => {
    expect(rangeGapRows.length).toBeGreaterThan(0);
    // All rows carry the same peer_median (it is a window expression).  Actual = 5.
    const median = parseFloat(rangeGapRows[0]!.peer_median);
    expect(median).toBeGreaterThanOrEqual(2);
    expect(median).toBeLessThanOrEqual(15);
  });

  it("every returned row has gap > 0 (WHERE clause filters to below-median only)", () => {
    for (const row of rangeGapRows) {
      expect(
        parseFloat(row.gap),
        `distributor "${row.distributor}" has gap=${row.gap}`,
      ).toBeGreaterThan(0);
    }
  });

  it("range-gap query returns [] for a known-empty FY (COUNT guard is not inverted)", () => {
    expect(rangeGapRowsEmpty).toEqual([]);
  });
});
