// Unit tests for skuCanary.ts — pure helpers and the frozen-but-empty check.
//
// These run against NO real database. The pool is mocked to return
// pre-built rows so the tests are deterministic and fast.
//
// Live ratio-rule tests (Rules 1–3 against the actual DB) live in
// aiGrowthReport.activation.test.ts, which now imports from this module.

import { describe, it, expect } from "vitest";
import {
  completedMonthLabels,
  priorLikeMonth,
  priorFyOf,
  evalPerMonthRule,
  evalTotalRule,
  runFrozenButEmptyCheck,
  runSkuWipeCanary,
  RULE1_ROWS_RATIO,
  RULE2_TOTAL_RATIO,
  RULE3_DIST_RATIO,
  type CanaryPool,
} from "../skuCanary.js";

// ── completedMonthLabels ───────────────────────────────────────────────────────

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

// ── priorLikeMonth ────────────────────────────────────────────────────────────

describe("priorLikeMonth", () => {
  it("Apr-26 → Apr-25", () => expect(priorLikeMonth("Apr-26")).toBe("Apr-25"));
  it("Jan-27 → Jan-26", () => expect(priorLikeMonth("Jan-27")).toBe("Jan-26"));
  it("Mar-27 → Mar-26", () => expect(priorLikeMonth("Mar-27")).toBe("Mar-26"));
  it("Dec-26 → Dec-25", () => expect(priorLikeMonth("Dec-26")).toBe("Dec-25"));
});

// ── priorFyOf ─────────────────────────────────────────────────────────────────

describe("priorFyOf", () => {
  it("2026-27 → 2025-26", () => expect(priorFyOf("2026-27")).toBe("2025-26"));
  it("2025-26 → 2024-25", () => expect(priorFyOf("2025-26")).toBe("2024-25"));
  it("2024-25 → 2023-24", () => expect(priorFyOf("2024-25")).toBe("2023-24"));
});

// ── evalPerMonthRule ──────────────────────────────────────────────────────────

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

// ── evalTotalRule ─────────────────────────────────────────────────────────────

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

// ── runFrozenButEmptyCheck ────────────────────────────────────────────────────
//
// This is the specific failure mode that produced the July-26 false positives:
// register_month_state frozen (primary data locked) but secondary_sku_line
// has zero rows for the same month.
//
// The pool is mocked: we pre-compute which months the NOT EXISTS query would
// return (frozen − those present in secondary) and return those rows directly.

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

// ── runSkuWipeCanary (pure path — no DB) ─────────────────────────────────────
//
// Smoke-test the full canary with a mock pool that returns controlled stats.
// Detailed ratio assertions live in the live test (aiGrowthReport.activation.test.ts).

function makeCanaryPool(
  openFy: string,
  priorFy: string,
  openStats: Record<string, { rows: number; distributors: number }>,
  priorStats: Record<string, { rows: number; distributors: number }>,
): CanaryPool {
  return {
    async query(_sql: string, params?: unknown[]) {
      const fys = (params as [string[]])[0];
      const rows: Record<string, string>[] = [];
      for (const [month_label, s] of Object.entries(openStats)) {
        if (fys.includes(openFy)) {
          rows.push({ fy: openFy, month_label, rows: String(s.rows), distributors: String(s.distributors) });
        }
      }
      for (const [month_label, s] of Object.entries(priorStats)) {
        if (fys.includes(priorFy)) {
          rows.push({ fy: priorFy, month_label, rows: String(s.rows), distributors: String(s.distributors) });
        }
      }
      return { rows };
    },
  };
}

describe("runSkuWipeCanary", () => {
  it("passes R1 and R3 when open-FY rows and distributors meet ratio floors", async () => {
    const pool = makeCanaryPool(
      "2026-27", "2025-26",
      { "Apr-26": { rows: 1000, distributors: 50 } },
      { "Apr-25": { rows: 1000, distributors: 50 } },
    );
    const result = await runSkuWipeCanary(
      pool, "2026-27", "2025-26",
      new Date(Date.UTC(2026, 4, 1)), // May 1 — Apr-26 completed
    );
    expect(result.completedLabels).toEqual(["Apr-26"]);
    const r1 = result.rows.find((r) => r.rule === "R1_rows" && r.month === "Apr-26")!;
    expect(r1.pass).toBe(true);
    const r3 = result.rows.find((r) => r.rule === "R3_distributors" && r.month === "Apr-26")!;
    expect(r3.pass).toBe(true);
    expect(result.totalRow.pass).toBe(true);
  });

  it("fails R1 when a completed month has zero rows", async () => {
    const pool = makeCanaryPool(
      "2026-27", "2025-26",
      { "Apr-26": { rows: 0, distributors: 0 } },   // wiped
      { "Apr-25": { rows: 1200, distributors: 60 } },
    );
    const result = await runSkuWipeCanary(
      pool, "2026-27", "2025-26",
      new Date(Date.UTC(2026, 4, 1)),
    );
    const r1 = result.rows.find((r) => r.rule === "R1_rows")!;
    expect(r1.pass).toBe(false);
    expect(r1.skipped).toBe(false);
  });

  it("returns no rows and a skipped R2 when no months are completed yet", async () => {
    const pool = makeCanaryPool("2026-27", "2025-26", {}, {});
    const result = await runSkuWipeCanary(
      pool, "2026-27", "2025-26",
      new Date(Date.UTC(2026, 3, 15)), // mid-April — nothing completed
    );
    expect(result.completedLabels).toEqual([]);
    expect(result.rows).toHaveLength(0);
    expect(result.totalRow.skipped).toBe(true);
  });
});
