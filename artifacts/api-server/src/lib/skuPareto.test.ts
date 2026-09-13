import { describe, expect, it } from "vitest";
import { buildSkuPareto, normalizeSkuParetoRange } from "./skuPareto.js";
import { currentOpenFy, priorFy, closedReportingMonthCount } from "./fyAnchors.js";

const row = (code: string, amount: number, monthLabel = "Apr-26") => ({
  code, amount, monthLabel,
});

describe("SKU Pareto builder", () => {
  it("recomputes grouping for the selected fiscal month range", () => {
    const result = buildSkuPareto("2026-27", [
      row("A", 10, "Apr-26"),
      row("A", 20, "May-26"),
      row("B", 100, "Jun-26"),
    ], 1, 2);
    expect(result.totalRevenueInr).toBe(30);
    expect(result.entries.map((entry) => entry.code)).toEqual(["A"]);
  });

  it("uses deterministic code order for equal revenue", () => {
    const result = buildSkuPareto("2026-27", [
      row("B", 10), row("A", 10), row("C", 10),
    ], 1, 1);
    expect(result.entries.map((entry) => entry.code)).toEqual(["A", "B", "C"]);
  });

  it("keeps ties deterministic at threshold and top-ten cutoff", () => {
    const result = buildSkuPareto("2026-27", Array.from({ length: 11 }, (_, index) =>
      row(String.fromCharCode(75 - index), 1),
    ), 1, 1);
    expect(result.thresholds.reach50Rank).toBe(6);
    expect(result.topTen.map((entry) => entry.code)).toEqual([
      "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
    ]);
    expect(result.entries[10].code).toBe("K");
  });

  it("excludes blank and whitespace-only raw codes", () => {
    const result = buildSkuPareto("2026-27", [
      row("", 99), row("   ", 50), row("A", 10),
    ], 1, 1);
    expect(result.skuCount).toBe(1);
    expect(result.entries[0].code).toBe("A");
  });

  it("returns zero shares and unavailable thresholds for zero total", () => {
    const result = buildSkuPareto("2026-27", [row("A", 0), row("B", 0)], 1, 1);
    expect(result.totalRevenueInr).toBe(0);
    expect(result.entries.every((entry) => entry.sharePct === 0 && entry.cumulativeSharePct === 0)).toBe(true);
    expect(result.thresholds).toEqual({ reach50Rank: null, reach80Rank: null, reach90Rank: null });
  });

  it("counts the first rank whose cumulative share reaches each threshold", () => {
    const result = buildSkuPareto("2026-27", [
      row("A", 50), row("B", 30), row("C", 20), row("D", 0),
    ], 1, 1);
    expect(result.thresholds).toEqual({ reach50Rank: 1, reach80Rank: 2, reach90Rank: 3 });
    expect(result.topTen).toHaveLength(4);
  });

  it("uses unrounded totals at exact threshold boundaries", () => {
    // Rounding total 100.001 to 100 would incorrectly make A appear to
    // reach 50%; the raw cumulative share is just below the boundary.
    const result = buildSkuPareto("2026-27", [
      row("A", 49.9996), row("B", 49.9996), row("C", 0.001),
    ], 1, 1);
    expect(result.totalRevenueInr).toBe(100);
    expect(result.entries[0].cumulativeSharePct).toBe(49.9995);
    expect(result.thresholds.reach50Rank).toBe(2);
  });

  it("defaults open FY to the primary YTD end and closed FY to full year", () => {
    const openFy = currentOpenFy();
    expect(normalizeSkuParetoRange(openFy)).toEqual({
      monthFrom: 1,
      monthTo: Math.min(12, closedReportingMonthCount(openFy) + 1),
    });
    expect(normalizeSkuParetoRange(priorFy(openFy))).toEqual({
      monthFrom: 1,
      monthTo: 12,
    });
  });
});