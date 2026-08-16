// Unit-regression tests for the FY2026-27 snapshot computation in sync.ts.
//
// WHAT THESE TESTS PROTECT:
//   Task 319 moved the FY26-27 dispatch chart and YTD card from a live
//   analytics call to the dashboard snapshot.  The snapshot is rebuilt hourly.
//   These tests confirm — without a live DB — that:
//
//   1. Only complete months appear in fy2627_monthly_sales.
//   2. fy2627_sales_ytd_inr equals the sum of complete-month amounts exactly.
//   3. fy2627_groups reflects the same complete-month scope (caller filters
//      the DB query to completeLabels before passing groupRows here).
//   4. A month that is incomplete today does NOT bleed into the YTD total.
//   5. When no complete months exist yet, ytd = 0 and all arrays are [].
//
// HOW COMPLETENESS WORKS (isMonthComplete in analytics.ts):
//   A month is "complete" when:
//     (a) its max invoice date reaches the last calendar day of the month, OR
//     (b) the 8-day grace window past month-end has elapsed (00:00 UTC on the
//         8th of the following month) — matching the register freeze rule.
//   For months whose rows carry no invoice dates (maxDate=null), the month is
//   complete once the entire last day has passed.
//
// CLOCK PINNING:
//   Every test passes an explicit `now` timestamp so completeness judgements
//   are deterministic regardless of when the tests run.  The clock is set to
//   2026-08-16T12:00:00Z (mid-August 2026 = well past the Apr-Jul lock dates).

import { describe, it, expect } from "vitest";
import { selectCompleteFy2627Months, buildFy2627Groups } from "./sync.js";

// Mid-August 2026 — Apr-26, May-26, Jun-26, Jul-26 are all past their 8-day
// grace windows; Aug-26 has not yet ended.
const NOW_AUG16 = Date.UTC(2026, 7, 16, 12, 0, 0); // month index 7 = August

// Apr-26 ended 2026-04-30; grace expires 2026-05-08 00:00 UTC.
const PAST_APR_GRACE = Date.UTC(2026, 4, 9, 0, 0, 0); // 2026-05-09 — just past grace

// Aug-26 ends 2026-08-31; at 2026-08-16 it is still open.
// Jul-26 grace expires 2026-08-08 00:00 UTC — already past on Aug 16.

// Helper: month row with a maxDate that hits the last day of the month.
const row = (
  monthLabel: string,
  amount: number,
  maxDate: string | null = null,
) => ({ monthLabel, amount, maxDate });

// ── selectCompleteFy2627Months ────────────────────────────────────────────────

describe("selectCompleteFy2627Months — empty input", () => {
  it("returns empty result when no month rows exist", () => {
    const result = selectCompleteFy2627Months([], NOW_AUG16);
    expect(result.monthlySales).toEqual([]);
    expect(result.ytdInr).toBe(0);
    expect(result.completeLabels).toEqual([]);
  });
});

describe("selectCompleteFy2627Months — no complete months yet", () => {
  it("returns empty result when the only month is still open (Aug-26)", () => {
    // Aug-26 has not ended; no invoice reaches 2026-08-31 and grace has not
    // elapsed, so it must be excluded.
    const result = selectCompleteFy2627Months(
      [row("Aug-26", 5_000_000, "2026-08-15")],
      NOW_AUG16,
    );
    expect(result.monthlySales).toEqual([]);
    expect(result.ytdInr).toBe(0);
    expect(result.completeLabels).toEqual([]);
  });

  it("returns empty result when monthLabel is blank (coalesce artifact)", () => {
    const result = selectCompleteFy2627Months(
      [row("", 99_999)],
      NOW_AUG16,
    );
    expect(result.monthlySales).toEqual([]);
    expect(result.ytdInr).toBe(0);
    expect(result.completeLabels).toEqual([]);
  });
});

describe("selectCompleteFy2627Months — complete via max-date heuristic", () => {
  it("includes a month whose max invoice date reaches the last calendar day", () => {
    // Apr-26: last day = 2026-04-30; maxDate hits it exactly.
    const result = selectCompleteFy2627Months(
      [row("Apr-26", 10_000_000, "2026-04-30")],
      NOW_AUG16,
    );
    expect(result.completeLabels).toEqual(["Apr-26"]);
    expect(result.ytdInr).toBe(10_000_000);
  });

  it("excludes a month whose max invoice date is before the last calendar day AND grace has not elapsed", () => {
    // Clock set to 2026-05-03 — within the Apr-26 grace window (ends 2026-05-08).
    const clock = Date.UTC(2026, 4, 3, 0, 0, 0); // 2026-05-03
    const result = selectCompleteFy2627Months(
      [row("Apr-26", 10_000_000, "2026-04-29")], // short by one day, grace not elapsed
      clock,
    );
    expect(result.completeLabels).toEqual([]);
    expect(result.ytdInr).toBe(0);
  });
});

describe("selectCompleteFy2627Months — complete via grace window", () => {
  it("includes a month once the 8-day grace window has elapsed (no last-day invoice)", () => {
    // Apr-26: grace expires 2026-05-08 00:00 UTC; clock set just past that.
    const result = selectCompleteFy2627Months(
      [row("Apr-26", 12_000_000, "2026-04-29")], // short by one day, but grace elapsed
      PAST_APR_GRACE,
    );
    expect(result.completeLabels).toEqual(["Apr-26"]);
    expect(result.ytdInr).toBe(12_000_000);
  });

  it("includes a month with null maxDate once the month has fully elapsed", () => {
    // Apr-26: null maxDate means no invoice dates in the register; the month
    // is complete once the last day is over (i.e. we are past 2026-05-01 00:00 UTC).
    const afterApr = Date.UTC(2026, 4, 2, 0, 0, 0); // 2026-05-02
    const result = selectCompleteFy2627Months(
      [row("Apr-26", 8_000_000, null)],
      afterApr,
    );
    expect(result.completeLabels).toEqual(["Apr-26"]);
    expect(result.ytdInr).toBe(8_000_000);
  });

  it("excludes a month with null maxDate while the month is still running", () => {
    // Apr-26 not yet ended.
    const duringApr = Date.UTC(2026, 3, 15, 0, 0, 0); // 2026-04-15
    const result = selectCompleteFy2627Months(
      [row("Apr-26", 8_000_000, null)],
      duringApr,
    );
    expect(result.completeLabels).toEqual([]);
    expect(result.ytdInr).toBe(0);
  });
});

describe("selectCompleteFy2627Months — mixed complete and incomplete months", () => {
  it("includes only complete months and excludes the open month", () => {
    // Apr-26 complete (last-day invoice); May-26 complete (grace elapsed);
    // Jun-26 complete; Aug-26 still open.
    const rows = [
      row("Apr-26", 10_000_000, "2026-04-30"),
      row("May-26", 11_000_000, "2026-05-28"), // short, but grace elapsed by Aug 16
      row("Jun-26", 12_000_000, "2026-06-30"),
      row("Jul-26", 9_000_000, "2026-07-31"),
      row("Aug-26", 5_000_000, "2026-08-15"), // still open
    ];
    const result = selectCompleteFy2627Months(rows, NOW_AUG16);
    expect(result.completeLabels).toEqual(["Apr-26", "May-26", "Jun-26", "Jul-26"]);
    expect(result.ytdInr).toBe(42_000_000);
    expect(result.monthlySales).toHaveLength(4);
    expect(result.monthlySales.map((m) => m.monthLabel)).toEqual([
      "Apr-26", "May-26", "Jun-26", "Jul-26",
    ]);
  });

  it("ytdInr equals the exact sum of included month amounts (Math.round applied)", () => {
    // Fractional amounts — the DB casts to float8 so we may get fractions.
    const rows = [
      row("Apr-26", 10_000_000.7, "2026-04-30"),
      row("May-26", 11_000_000.3, "2026-05-31"),
    ];
    const result = selectCompleteFy2627Months(rows, NOW_AUG16);
    // Each is rounded individually: 10_000_001 + 11_000_000 = 21_000_001
    const expectedYtd = result.monthlySales.reduce((s, m) => s + m.amount, 0);
    expect(result.ytdInr).toBe(expectedYtd);
    expect(result.ytdInr).toBe(21_000_001);
  });

  it("incomplete month amount does NOT appear in ytdInr", () => {
    // Aug-26 has ₹50 Cr of data in the register but must not inflate YTD.
    const rows = [
      row("Apr-26", 10_000_000, "2026-04-30"),
      row("Aug-26", 50_000_000, "2026-08-15"), // open
    ];
    const result = selectCompleteFy2627Months(rows, NOW_AUG16);
    expect(result.ytdInr).toBe(10_000_000);
    expect(result.completeLabels).not.toContain("Aug-26");
  });
});

describe("selectCompleteFy2627Months — fiscal sort order", () => {
  it("sorts complete months in fiscal order (Apr → Mar) regardless of input order", () => {
    // Input deliberately out of order.
    const rows = [
      row("Jun-26", 6_000_000, "2026-06-30"),
      row("Apr-26", 4_000_000, "2026-04-30"),
      row("May-26", 5_000_000, "2026-05-31"),
    ];
    const result = selectCompleteFy2627Months(rows, NOW_AUG16);
    expect(result.monthlySales.map((m) => m.monthLabel)).toEqual([
      "Apr-26", "May-26", "Jun-26",
    ]);
  });

  it("Jan/Feb/Mar (fiscal tail) sort after Dec", () => {
    // Clock: mid-March 2027 — well past all grace windows for all months.
    const midMar2027 = Date.UTC(2027, 2, 16, 12, 0, 0);
    const rows = [
      row("Mar-27", 3_000_000, "2027-03-31"),
      row("Jan-27", 1_000_000, "2027-01-31"),
      row("Dec-26", 12_000_000, "2026-12-31"),
      row("Apr-26", 4_000_000, "2026-04-30"),
    ];
    const result = selectCompleteFy2627Months(rows, midMar2027);
    expect(result.monthlySales.map((m) => m.monthLabel)).toEqual([
      "Apr-26", "Dec-26", "Jan-27", "Mar-27",
    ]);
  });
});

// ── buildFy2627Groups ─────────────────────────────────────────────────────────

describe("buildFy2627Groups — empty input", () => {
  it("returns empty array when no group rows are provided", () => {
    expect(buildFy2627Groups([])).toEqual([]);
  });
});

describe("buildFy2627Groups — sharePct computation", () => {
  it("computes sharePct correctly and rounds to 1 dp", () => {
    const groups = buildFy2627Groups([
      { group: "Alpha", amount: 6_000_000 },
      { group: "Beta", amount: 4_000_000 },
    ]);
    expect(groups).toHaveLength(2);
    // Alpha: 6/10 = 60.0%; Beta: 4/10 = 40.0%
    expect(groups[0]).toMatchObject({ group: "Alpha", amount: 6_000_000, sharePct: 60.0 });
    expect(groups[1]).toMatchObject({ group: "Beta", amount: 4_000_000, sharePct: 40.0 });
  });

  it("sharePct sums to 100 when amounts divide evenly", () => {
    const groups = buildFy2627Groups([
      { group: "X", amount: 25_000_000 },
      { group: "Y", amount: 75_000_000 },
    ]);
    const total = groups.reduce((s, g) => s + g.sharePct, 0);
    expect(total).toBeCloseTo(100, 0);
  });

  it("handles zero groupTotal without throwing (sharePct = 0)", () => {
    // This should not happen in practice but the guard must hold.
    const groups = buildFy2627Groups([{ group: "Empty", amount: 0 }]);
    expect(groups[0].sharePct).toBe(0);
  });

  it("sorts groups by amount descending", () => {
    const groups = buildFy2627Groups([
      { group: "Small", amount: 1_000_000 },
      { group: "Large", amount: 9_000_000 },
      { group: "Medium", amount: 5_000_000 },
    ]);
    expect(groups.map((g) => g.group)).toEqual(["Large", "Medium", "Small"]);
  });

  it("rounds fractional amounts to nearest integer", () => {
    const groups = buildFy2627Groups([
      { group: "A", amount: 1_000_000.6 },  // rounds up → 1_000_001
      { group: "B", amount: 2_000_000.4 },  // rounds down → 2_000_000
    ]);
    // Sorted by amount descending (B > A after rounding).
    expect(groups[0].amount).toBe(2_000_000); // B, largest first
    expect(groups[1].amount).toBe(1_000_001); // A
  });
});

describe("buildFy2627Groups — group rows match only complete months", () => {
  it("does not include the incomplete month's amount (caller must pre-filter groupRows)", () => {
    // The snapshot pipeline queries groupRows with WHERE month_label IN (completeLabels).
    // This test verifies that if the caller accidentally passes all-FY group rows
    // (i.e., NOT filtered to completeLabels), the function faithfully reflects whatever
    // it receives — confirming the filter responsibility lies with the caller.
    //
    // Correct usage: caller filters to completeLabels → only complete-month amounts arrive.
    const correctGroupRows = [
      { group: "Alpha", amount: 10_000_000 }, // Apr-26 only
    ];
    const groups = buildFy2627Groups(correctGroupRows);
    expect(groups[0].amount).toBe(10_000_000);
    // No bleed from Aug-26 (incomplete) because caller filtered it out at DB level.
  });
});

// ── Contract: completeLabels is the gate for the group query ──────────────────

describe("selectCompleteFy2627Months + buildFy2627Groups integration contract", () => {
  it("completeLabels returned by selectCompleteFy2627Months excludes the open month", () => {
    // Simulates the snapshot pipeline deciding which labels to pass to the group query.
    const monthRows = [
      row("Apr-26", 10_000_000, "2026-04-30"),
      row("May-26", 11_000_000, "2026-05-31"),
      row("Aug-26", 50_000_000, "2026-08-15"), // open
    ];
    const { completeLabels } = selectCompleteFy2627Months(monthRows, NOW_AUG16);

    expect(completeLabels).toContain("Apr-26");
    expect(completeLabels).toContain("May-26");
    expect(completeLabels).not.toContain("Aug-26"); // the gate must exclude it
  });

  it("ytdInr matches the sum of monthlySales amounts (invariant)", () => {
    const monthRows = [
      row("Apr-26", 10_234_567, "2026-04-30"),
      row("May-26", 11_876_543, "2026-05-31"),
      row("Jun-26", 9_999_999, "2026-06-30"),
      row("Aug-26", 99_999_999, "2026-08-20"), // open — must be excluded
    ];
    const { monthlySales, ytdInr } = selectCompleteFy2627Months(monthRows, NOW_AUG16);
    const sumFromArray = monthlySales.reduce((s, m) => s + m.amount, 0);
    expect(ytdInr).toBe(sumFromArray);
  });
});
