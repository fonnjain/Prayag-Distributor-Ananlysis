// Unit test pinning the state-head (deepDive) WIDEN sizing formula (Task 211).
//
// The deepDive WIDEN branch sizes each distributor's brand gap vs the peer
// median from d.skuSpread.distinctBrands:
//   perCodeQuarterly = (medianNet / max(1, months/3)) / peerMedianBrands
//   valueHigh        = gapBrands × perCodeQuarterly × rangeUptake
//   valueLow         = valueHigh / 2
//
// Verified at runtime 2026-08-08 against head "Anant Singh":
//   peer median 5 brands, gap 1 → valueHigh 15297.43 and gap N → N × that,
//   with valueLow = valueHigh / 2 on every entry.

import { describe, it, expect } from "vitest";
import { widenDeepDiveSizing } from "./aiGrowthReport.js";

describe("widenDeepDiveSizing (state-head WIDEN branch)", () => {
  it("computes valueHigh = gap × ((medianNet / (months/3)) / peerMedian) × uptake", () => {
    // 12-month period → 4 quarters; medianNet 400000; peer median 5; uptake 0.25
    const r = widenDeepDiveSizing(2, 5, 400_000, 12, 0.25);
    // perCodeQuarterly = (400000 / 4) / 5 = 20000; high = 2 × 20000 × 0.25 = 10000
    expect(r.valueHigh).toBeCloseTo(10_000, 6);
    expect(r.valueLow).toBeCloseTo(5_000, 6);
  });

  it("valueLow is always exactly half of valueHigh", () => {
    for (const [gap, median, net, months, uptake] of [
      [1, 5, 123_456.78, 12, 0.25],
      [3, 7, 999_999, 6, 0.5],
      [4, 5, 50_000, 1, 0.1],
    ] as const) {
      const r = widenDeepDiveSizing(gap, median, net, months, uptake);
      expect(r.valueLow).toBeCloseTo(r.valueHigh / 2, 9);
    }
  });

  it("scales linearly with the brand gap", () => {
    const g1 = widenDeepDiveSizing(1, 5, 400_000, 12, 0.25);
    const g3 = widenDeepDiveSizing(3, 5, 400_000, 12, 0.25);
    expect(g3.valueHigh).toBeCloseTo(3 * g1.valueHigh, 6);
  });

  it("clamps quarter count at 1 for short periods (months < 3)", () => {
    // months=1 → max(1, 1/3)=1 quarter, not a fractional blow-up
    const r = widenDeepDiveSizing(1, 5, 100_000, 1, 0.25);
    expect(r.valueHigh).toBeCloseTo((100_000 / 5) * 0.25, 6);
  });

  it("returns zero when peer median is zero or negative", () => {
    expect(widenDeepDiveSizing(2, 0, 400_000, 12, 0.25).valueHigh).toBe(0);
    expect(widenDeepDiveSizing(2, -1, 400_000, 12, 0.25).valueHigh).toBe(0);
  });
});
