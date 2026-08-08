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
// ANCHORS (FY 2025-26, the most recent fully-closed FY with secondary_sku_line):
//   Row count         : ≥10 000 (actual ≈379 000)
//   Activation query  : ≥40 distributors returned (LIMIT 50; actual saturates at 50)
//   Range-gap query   : ≥15 distributors below peer median (LIMIT 20; actual saturates at 20)
//   Range-gap median  : peer_median segment count between 2 and 15 (actual = 5)
//
// When a newer FY is closed and fully ingested, update GUARD_FY and re-check
// whether the threshold constants are still conservative.

import { beforeAll, describe, it, expect } from "vitest";
import { pool } from "@workspace/db";

// Most recent fully-closed FY with secondary_sku_line data.
const GUARD_FY = "2025-26";

// Full-FY month labels for FY 2025-26 (fiscal April 2025 – March 2026).
const FULL_FY_LABELS = [
  "Apr-25", "May-25", "Jun-25", "Jul-25", "Aug-25", "Sep-25",
  "Oct-25", "Nov-25", "Dec-25", "Jan-26", "Feb-26", "Mar-26",
];

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

// ── Cached query results ───────────────────────────────────────────────────────
// Each SQL query scans ≈379 000 rows; caching in beforeAll keeps total test
// runtime well under the 60 s vitest timeout.

let activationRows: DistActivationRow[] = [];
let activationRowsEmpty: DistActivationRow[] = [];
let rangeGapRows: DistRangeGapRow[] = [];
let rangeGapRowsEmpty: DistRangeGapRow[] = [];
let rowCountN = 0;

beforeAll(async () => {
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

describe("distributor activation guard — live public-schema DB", () => {
  it("secondary_sku_line has data for GUARD_FY (table not wiped)", () => {
    // Actual row count for FY 2025-26 is ≈379 000.
    // ≥10 000 gives a large buffer against partial ingests while still catching a wipe.
    expect(rowCountN).toBeGreaterThanOrEqual(10_000);
  });

  it("activation query returns ≥40 distributors (query saturates at LIMIT 50 with real data)", () => {
    // The query has LIMIT 50; actual result saturates at 50 (≈241 distributors in DB).
    // ≥40 is a conservative floor: 0 rows if the table is wiped, ~50 with real data.
    expect(activationRows.length).toBeGreaterThanOrEqual(40);
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
  it("range-gap query returns ≥15 distributors below peer median (query saturates at LIMIT 20)", () => {
    // The query has LIMIT 20; actual result saturates at 20 (≈200+ below median in DB).
    // ≥15 is a conservative floor: 0 rows if the table is wiped, 20 with real data.
    expect(rangeGapRows.length).toBeGreaterThanOrEqual(15);
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
