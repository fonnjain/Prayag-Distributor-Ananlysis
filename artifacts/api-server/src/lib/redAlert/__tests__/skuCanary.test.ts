// Unit tests for the shared SKU wipe canary module (src/lib/redAlert/skuCanary.ts).
//
// WHAT THESE TESTS PROTECT:
//   The canary module is the shared source of truth for wipe detection used by:
//     - The audit engine (Group 12)
//     - The alert detection scheduler (logged WARN after every detection run)
//     - The CI integration test (aiGrowthReport.activation.test.ts)
//
//   These unit tests mock the DB pool so they run without a real database and
//   focus on the correctness of Rule 4 (frozen month + zero secondary rows) —
//   the exact scenario that produced July-26 false-positive S1 alerts.
//
// FMV-* tests (Frozen Month Violation) mirror the pattern established in
// context.test.ts for the runtime Guard 3 cross-validation fix.
// FBE-* tests cover the runFrozenButEmptyCheck helper directly (per-FY variant).

import { describe, it, expect } from "vitest";
import {
  runSkuWipeCanary,
  runFrozenButEmptyCheck,
  completedMonthLabels,
  priorLikeMonth,
  priorFyOf,
  evalPerMonthRule,
  evalTotalRule,
  RULE1_ROWS_RATIO,
  RULE2_TOTAL_RATIO,
  RULE3_DIST_RATIO,
  type CanaryPool,
} from "../skuCanary.js";

// ── Mock pool factories ───────────────────────────────────────────────────────

type MockFrozenRow = { fy: string; month_label: string; frozen_at: string; secondary_rows: string };
type MockCanaryRow = { fy: string; month_label: string; rows: string; distributors: string };

/** Full canary pool mock: routes by SQL content. */
function makePool(opts: {
  canaryRows?: MockCanaryRow[];
  frozenRows?: MockFrozenRow[];
} = {}): CanaryPool {
  return {
    async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
      // WIPE_CANARY_STATS_SQL — identified by the "rows" alias on COUNT(*)
      if (sql.includes("COUNT(*)::text") && sql.includes("distributors") && sql.includes("month_label")) {
        return { rows: (opts.canaryRows ?? []) as Record<string, unknown>[] };
      }
      // FROZEN_EMPTY_SQL — identified by register_month_state JOIN with secondary_rows alias
      if (sql.includes("register_month_state") && sql.includes("secondary_rows")) {
        return { rows: (opts.frozenRows ?? []) as Record<string, unknown>[] };
      }
      return { rows: [] };
    },
  };
}

/**
 * FBE pool mock: pre-computes which frozen months are absent from secondary
 * and returns those rows directly (mirrors the NOT EXISTS SQL logic).
 */
function makeFBEPool(frozenInPrimary: string[], presentInSecondary: string[]): CanaryPool {
  const secondarySet = new Set(presentInSecondary);
  return {
    async query(_sql: string, params?: unknown[]) {
      const fy = (params as [string])[0];
      const missing = frozenInPrimary.filter((m) => !secondarySet.has(m));
      return { rows: missing.map((month_label) => ({ fy, month_label })) };
    },
  };
}

// Fixed clock: August 17 2026 (April–July are completed months)
const NOW_AUG_17_2026 = new Date(Date.UTC(2026, 7, 17));
const OPEN_FY_2627 = "2026-27";
const PRIOR_FY_2526 = "2025-26";

// ── Pure helper tests ─────────────────────────────────────────────────────────

describe("completedMonthLabels", () => {
  it("returns [] for Apr 1 — month has not elapsed yet", () => {
    expect(completedMonthLabels("2026-27", new Date(Date.UTC(2026, 3, 1)))).toEqual([]);
  });
  it("returns [] for Apr 30 — month still in progress", () => {
    expect(completedMonthLabels("2026-27", new Date(Date.UTC(2026, 3, 30)))).toEqual([]);
  });
  it("returns [Apr-26] on May 1 — first instant Apr has elapsed", () => {
    expect(completedMonthLabels("2026-27", new Date(Date.UTC(2026, 4, 1)))).toEqual(["Apr-26"]);
  });
  it("returns Apr–Jul on Aug 1", () => {
    expect(completedMonthLabels("2026-27", new Date(Date.UTC(2026, 7, 1)))).toEqual([
      "Apr-26", "May-26", "Jun-26", "Jul-26",
    ]);
  });
  it("handles the calendar-year rollover inside an FY", () => {
    const labels = completedMonthLabels("2026-27", new Date(Date.UTC(2027, 1, 1)));
    expect(labels).toContain("Jan-27");
    expect(labels).not.toContain("Feb-27");
    expect(labels[0]).toBe("Apr-26");
  });
  it("returns all 12 labels on Apr 1 of the next calendar year (FY fully elapsed)", () => {
    const labels = completedMonthLabels("2026-27", new Date(Date.UTC(2027, 3, 1)));
    expect(labels).toHaveLength(12);
    expect(labels[11]).toBe("Mar-27");
  });
});

describe("priorLikeMonth", () => {
  it("Apr-26 → Apr-25", () => expect(priorLikeMonth("Apr-26")).toBe("Apr-25"));
  it("Jan-27 → Jan-26", () => expect(priorLikeMonth("Jan-27")).toBe("Jan-26"));
  it("Mar-27 → Mar-26", () => expect(priorLikeMonth("Mar-27")).toBe("Mar-26"));
  it("Dec-26 → Dec-25", () => expect(priorLikeMonth("Dec-26")).toBe("Dec-25"));
});

describe("priorFyOf", () => {
  it("2026-27 → 2025-26", () => expect(priorFyOf("2026-27")).toBe("2025-26"));
  it("2025-26 → 2024-25", () => expect(priorFyOf("2025-26")).toBe("2024-25"));
  it("2024-25 → 2023-24", () => expect(priorFyOf("2024-25")).toBe("2023-24"));
});

describe("evalPerMonthRule", () => {
  it("passes when actual meets the floor", () => {
    const r = evalPerMonthRule("Apr-26", 720, 1200, RULE1_ROWS_RATIO);
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe(false);
    expect(r.floor).toBeCloseTo(720);
  });
  it("fails when actual is below the floor", () => {
    const r = evalPerMonthRule("Apr-26", 0, 1000, RULE1_ROWS_RATIO);
    expect(r.pass).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.actual).toBe(0);
  });
  it("skips (not fails) when prior denominator is zero — caller must fail on skipped", () => {
    const r = evalPerMonthRule("Apr-26", 500, 0, RULE1_ROWS_RATIO);
    expect(r.skipped).toBe(true);
    expect(r.pass).toBe(true); // skipped surfaces as pass=true; caller asserts skipped===false
  });
  it("Rule 3 — distributor ratio", () => {
    const r = evalPerMonthRule("Jul-26", 50, 100, RULE3_DIST_RATIO);
    expect(r.floor).toBeCloseTo(70);
    expect(r.pass).toBe(false);
  });
});

describe("evalTotalRule", () => {
  it("passes when total meets the floor", () => {
    const r = evalTotalRule(700, 1000, RULE2_TOTAL_RATIO);
    expect(r.pass).toBe(true);
    expect(r.floor).toBeCloseTo(700);
  });
  it("fails when total is below the floor", () => {
    const r = evalTotalRule(100, 1000, RULE2_TOTAL_RATIO);
    expect(r.pass).toBe(false);
  });
  it("skips when prior total is zero", () => {
    const r = evalTotalRule(0, 0, RULE2_TOTAL_RATIO);
    expect(r.skipped).toBe(true);
  });
});

// ── runFrozenButEmptyCheck (FBE-* tests) ─────────────────────────────────────
//
// This is the specific failure mode that produced the July-26 false positives:
// register_month_state frozen (primary data locked) but secondary_sku_line
// has zero rows for the same month.
//
// The pool is mocked: we pre-compute which months the NOT EXISTS query would
// return (frozen − those present in secondary) and return those rows directly.

describe("runFrozenButEmptyCheck", () => {
  it("FBE-1: returns [] when every frozen month has secondary rows", async () => {
    const pool = makeFBEPool(["Apr-26", "May-26", "Jul-26"], ["Apr-26", "May-26", "Jul-26"]);
    expect(await runFrozenButEmptyCheck(pool, "2026-27")).toEqual([]);
  });

  it("FBE-2: flags one frozen month with zero secondary rows — the July-26 scenario", async () => {
    const pool = makeFBEPool(
      ["Apr-26", "May-26", "Jun-26", "Jul-26"],
      ["Apr-26", "May-26", "Jun-26"],     // Jul-26 missing from secondary
    );
    const result = await runFrozenButEmptyCheck(pool, "2026-27");
    expect(result).toEqual([{ fy: "2026-27", month_label: "Jul-26" }]);
  });

  it("FBE-3: flags multiple missing months", async () => {
    const pool = makeFBEPool(
      ["Apr-26", "May-26", "Jun-26", "Jul-26"],
      ["Apr-26"],
    );
    const result = await runFrozenButEmptyCheck(pool, "2026-27");
    expect(result.map((r) => r.month_label)).toEqual(["May-26", "Jun-26", "Jul-26"]);
  });

  it("FBE-4: returns [] when no months are frozen (nothing to cross-check)", async () => {
    const pool = makeFBEPool([], []);
    expect(await runFrozenButEmptyCheck(pool, "2026-27")).toEqual([]);
  });

  it("FBE-5: secondary months beyond the frozen set are ignored", async () => {
    const pool = makeFBEPool(["Apr-26"], ["Apr-26", "May-26", "Jun-26"]);
    expect(await runFrozenButEmptyCheck(pool, "2026-27")).toEqual([]);
  });
});

// ── runSkuWipeCanary — FMV (Frozen Month Violation) tests ────────────────────
// These test the Rule 4 cross-check via the full canary runner.
// Mirror the FMV-* pattern from context.test.ts for Guard 3.

describe("skuCanary — Rule 4 (FMV): frozen month with zero secondary rows", () => {
  it("FMV-1: single frozen month with zero secondary rows → anyFail=true, rule flagged FAIL", async () => {
    const pool = makePool({
      canaryRows: [], // no ratio data — completed months empty in this clock state
      frozenRows: [
        {
          fy: "2026-27",
          month_label: "Jul-26",
          frozen_at: "2026-08-08T00:00:00",
          secondary_rows: "0", // zero rows — the July-26 false-positive scenario
        },
      ],
    });

    // Use a clock where no open-FY months are completed (avoids ratio checks)
    // so the only failure comes from R4.
    const result = await runSkuWipeCanary(pool, {
      environment: "dev",
      now: new Date(Date.UTC(2026, 3, 15)), // April 15 — no completed months
    });

    expect(result.anyFail).toBe(true);
    expect(result.frozenEmptyResults).toHaveLength(1);
    expect(result.frozenEmptyResults[0]!.pass).toBe(false);
    expect(result.frozenEmptyResults[0]!.secondaryRows).toBe(0);
    expect(result.frozenEmptyResults[0]!.fy).toBe("2026-27");
    expect(result.frozenEmptyResults[0]!.monthLabel).toBe("Jul-26");
  });

  it("FMV-2: frozen month with non-zero secondary rows → pass", async () => {
    const pool = makePool({
      canaryRows: [],
      frozenRows: [
        {
          fy: "2026-27",
          month_label: "Apr-26",
          frozen_at: "2026-05-08T00:00:00",
          secondary_rows: "42000", // data present — OK
        },
      ],
    });

    const result = await runSkuWipeCanary(pool, {
      environment: "dev",
      now: new Date(Date.UTC(2026, 3, 15)), // April — no ratio checks
    });

    expect(result.frozenEmptyResults).toHaveLength(1);
    expect(result.frozenEmptyResults[0]!.pass).toBe(true);
    expect(result.frozenEmptyResults[0]!.secondaryRows).toBe(42000);
    expect(result.anyFail).toBe(false);
  });

  it("FMV-3: multiple frozen months — only the zero-row month fails", async () => {
    const pool = makePool({
      canaryRows: [],
      frozenRows: [
        { fy: "2026-27", month_label: "Apr-26", frozen_at: "2026-05-08T00:00:00", secondary_rows: "38000" },
        { fy: "2026-27", month_label: "May-26", frozen_at: "2026-06-08T00:00:00", secondary_rows: "41000" },
        { fy: "2026-27", month_label: "Jun-26", frozen_at: "2026-07-08T00:00:00", secondary_rows: "0" }, // gap
      ],
    });

    const result = await runSkuWipeCanary(pool, {
      environment: "dev",
      now: new Date(Date.UTC(2026, 3, 15)),
    });

    expect(result.frozenEmptyResults).toHaveLength(3);
    expect(result.frozenEmptyResults.filter((r) => r.pass)).toHaveLength(2);
    expect(result.frozenEmptyResults.filter((r) => !r.pass)).toHaveLength(1);
    expect(result.frozenEmptyResults.find((r) => !r.pass)!.monthLabel).toBe("Jun-26");
    expect(result.anyFail).toBe(true);
  });

  it("FMV-4: no frozen months at all → R4 trivially passes", async () => {
    const pool = makePool({ canaryRows: [], frozenRows: [] });

    const result = await runSkuWipeCanary(pool, {
      environment: "dev",
      now: new Date(Date.UTC(2026, 3, 15)), // April — no completed months
    });

    expect(result.frozenEmptyResults).toHaveLength(0);
    expect(result.anyFail).toBe(false);
  });

  it("FMV-5: environment label is preserved in results", async () => {
    const pool = makePool({
      canaryRows: [],
      frozenRows: [
        { fy: "2026-27", month_label: "Jul-26", frozen_at: "2026-08-08T00:00:00", secondary_rows: "0" },
      ],
    });

    const result = await runSkuWipeCanary(pool, {
      environment: "dev",
      now: new Date(Date.UTC(2026, 3, 15)),
    });

    expect(result.environment).toBe("dev");
    expect(result.rule1Results.every((r) => r.environment === "dev")).toBe(true);
    expect(result.rule2Result.environment).toBe("dev");
  });
});

// ── Ratio rule tests with mock data (R1/R2/R3) ───────────────────────────────

describe("skuCanary — ratio rules with mock data", () => {
  // August 17 2026: Apr–Jul completed in open FY 2026-27
  const NOW = NOW_AUG_17_2026;

  it("R1/R2/R3 all pass when every completed month meets its floor", async () => {
    // Prior FY: 10000 rows / 50 dists each month
    // Open FY: Apr=6000/35, May=8000/40, Jun=8000/45, Jul=8000/36
    // R1 floor = 0.60×10000 = 6000 → all pass ✓
    // R2 total: 30000 ≥ 0.70×40000=28000 ✓
    // R3 floor = 0.70×50 = 35 → all pass ✓
    const pool = makePool({
      canaryRows: [
        { fy: PRIOR_FY_2526, month_label: "Apr-25", rows: "10000", distributors: "50" },
        { fy: PRIOR_FY_2526, month_label: "May-25", rows: "10000", distributors: "50" },
        { fy: PRIOR_FY_2526, month_label: "Jun-25", rows: "10000", distributors: "50" },
        { fy: PRIOR_FY_2526, month_label: "Jul-25", rows: "10000", distributors: "50" },
        { fy: OPEN_FY_2627,  month_label: "Apr-26", rows: "6000",  distributors: "35" },
        { fy: OPEN_FY_2627,  month_label: "May-26", rows: "8000",  distributors: "40" },
        { fy: OPEN_FY_2627,  month_label: "Jun-26", rows: "8000",  distributors: "45" },
        { fy: OPEN_FY_2627,  month_label: "Jul-26", rows: "8000",  distributors: "36" },
      ],
      frozenRows: [],
    });

    const result = await runSkuWipeCanary(pool, { environment: "dev", now: NOW });

    expect(result.completedMonths).toEqual(["Apr-26", "May-26", "Jun-26", "Jul-26"]);
    expect(result.rule1Results.every((r) => r.pass)).toBe(true);
    expect(result.rule2Result.pass).toBe(true);
    expect(result.rule3Results.every((r) => r.pass)).toBe(true);
    expect(result.anyFail).toBe(false);
  });

  it("R1 fails for a month that dropped below the 60% floor", async () => {
    // Jul-26 gets only 5000 rows vs 10000 in prior → floor=6000 → FAIL
    const pool = makePool({
      canaryRows: [
        { fy: PRIOR_FY_2526, month_label: "Apr-25", rows: "10000", distributors: "50" },
        { fy: PRIOR_FY_2526, month_label: "May-25", rows: "10000", distributors: "50" },
        { fy: PRIOR_FY_2526, month_label: "Jun-25", rows: "10000", distributors: "50" },
        { fy: PRIOR_FY_2526, month_label: "Jul-25", rows: "10000", distributors: "50" },
        { fy: OPEN_FY_2627,  month_label: "Apr-26", rows: "8000",  distributors: "45" },
        { fy: OPEN_FY_2627,  month_label: "May-26", rows: "8000",  distributors: "45" },
        { fy: OPEN_FY_2627,  month_label: "Jun-26", rows: "8000",  distributors: "45" },
        { fy: OPEN_FY_2627,  month_label: "Jul-26", rows: "5000",  distributors: "45" }, // below floor
      ],
      frozenRows: [],
    });

    const result = await runSkuWipeCanary(pool, { environment: "dev", now: NOW });

    const julResult = result.rule1Results.find((r) => r.monthLabel === "Jul-26");
    expect(julResult).toBeDefined();
    expect(julResult!.pass).toBe(false);
    expect(julResult!.actual).toBe(5000);
    expect(julResult!.floor).toBeCloseTo(6000);
    expect(result.anyFail).toBe(true);
  });

  it("combined: R1 fail + R4 frozen-empty both surface as anyFail=true", async () => {
    const pool = makePool({
      canaryRows: [
        { fy: PRIOR_FY_2526, month_label: "Apr-25", rows: "10000", distributors: "50" },
        { fy: OPEN_FY_2627,  month_label: "Apr-26", rows: "5000",  distributors: "30" }, // R1 fail
      ],
      frozenRows: [
        { fy: "2025-26", month_label: "Apr-25", frozen_at: "2025-05-08T00:00:00", secondary_rows: "0" }, // R4 fail
      ],
    });

    // Only April completed in this clock state
    const result = await runSkuWipeCanary(pool, {
      environment: "dev",
      now: new Date(Date.UTC(2026, 4, 15)), // May 15 — only Apr completed
    });

    expect(result.rule1Results.find((r) => r.monthLabel === "Apr-26" && !r.pass)).toBeDefined();
    expect(result.frozenEmptyResults.find((r) => !r.pass)).toBeDefined();
    expect(result.anyFail).toBe(true);
  });
});
