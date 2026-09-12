// Unit test pinning the state-head (deepDive) WIDEN sizing formula (Task 211).
//
// The deepDive WIDEN branch sizes each distributor's brand gap vs the peer
// median from d.skuSpread.distinctBrands:
//   perCodeQuarterly = (median secondary distributor NET / max(1, months/3))
//                      / peerMedianBrands
//   valueHigh        = gapBrands × perCodeQuarterly × rangeUptake
//   valueLow         = valueHigh / 2
//
// Verified at runtime 2026-08-08 against head "Anant Singh":
//   peer median 5 brands, gap 1 → valueHigh 15297.43 and gap N → N × that,
//   with valueLow = valueHigh / 2 on every entry.

import { describe, it, expect } from "vitest";
import {
  activateSecondarySizing,
  buildUnambiguousRetailerCohort,
  widenDeepDiveSizing,
} from "./aiGrowthReport.js";

describe("widenDeepDiveSizing (state-head WIDEN branch)", () => {
  it("computes valueHigh = gap × ((medianNet / (months/3)) / peerMedian) × uptake", () => {
    // 12-month period → 4 quarters; medianNet 400000; peer median 5; uptake 0.25
    const r = widenDeepDiveSizing(2, 5, 400_000, 12, 0.25);
    // perCodeQuarterly = (400000 / 4) / 5 = 20000; high = 2 × 20000 × 0.25 = 10000
    expect(r?.valueHigh).toBeCloseTo(10_000, 6);
    expect(r?.valueLow).toBeCloseTo(5_000, 6);
  });

  it("valueLow is always exactly half of valueHigh", () => {
    for (const [gap, median, net, months, uptake] of [
      [1, 5, 123_456.78, 12, 0.25],
      [3, 7, 999_999, 6, 0.5],
      [4, 5, 50_000, 1, 0.1],
    ] as const) {
      const r = widenDeepDiveSizing(gap, median, net, months, uptake);
      expect(r?.valueLow).toBeCloseTo((r?.valueHigh ?? 0) / 2, 9);
    }
  });

  it("scales linearly with the brand gap", () => {
    const g1 = widenDeepDiveSizing(1, 5, 400_000, 12, 0.25);
    const g3 = widenDeepDiveSizing(3, 5, 400_000, 12, 0.25);
    expect(g3?.valueHigh).toBeCloseTo(3 * (g1?.valueHigh ?? 0), 6);
  });

  it("clamps quarter count at 1 for short periods (months < 3)", () => {
    // months=1 → max(1, 1/3)=1 quarter, not a fractional blow-up
    const r = widenDeepDiveSizing(1, 5, 100_000, 1, 0.25);
    expect(r?.valueHigh).toBeCloseTo((100_000 / 5) * 0.25, 6);
  });

  it("uses actual loaded months for a partial FY", () => {
    const sixMonths = widenDeepDiveSizing(2, 5, 400_000, 6, 0.4);
    const twelveMonths = widenDeepDiveSizing(2, 5, 400_000, 12, 0.4);
    expect(sixMonths?.valueHigh).toBeCloseTo(2 * (twelveMonths?.valueHigh ?? 0), 6);
  });

  it("omits the estimate when its matched secondary basis is unavailable", () => {
    expect(widenDeepDiveSizing(2, 0, 400_000, 12, 0.25)).toBeNull();
    expect(widenDeepDiveSizing(2, 5, 0, 12, 0.25)).toBeNull();
  });
});

describe("buildUnambiguousRetailerCohort", () => {
  it("deduplicates repeated rows and excludes cross-distributor name ambiguity", () => {
    const cohort = buildUnambiguousRetailerCohort([
      {
        name: "Distributor A",
        retailers: [
          { name: "Retailer One", memberName: "Member A" },
          { name: "Retailer One", memberName: "Member A" },
          { name: "Shared Retailer", memberName: "Member A" },
        ],
      },
      {
        name: "Distributor B",
        retailers: [
          { name: "Retailer Two", memberName: "Member B" },
          { name: "Shared Retailer", memberName: "Member B" },
        ],
      },
    ]);

    expect(cohort.keysByDistributor.get("Distributor A")?.size).toBe(1);
    expect(cohort.keysByDistributor.get("Distributor B")?.size).toBe(1);
    expect(cohort.ownerByKey.get("sharedretailer")).toBeNull();
  });
});

describe("activateSecondarySizing", () => {
  it("uses a retailer-level secondary median", () => {
    const r = activateSecondarySizing(8, 120_000, 6, 0.25);
    expect(r?.valueHigh).toBeCloseTo(120_000, 6);
    expect(r?.valueLow).toBeCloseTo(60_000, 6);
  });

  it("omits the estimate when there is no retailer-level basis", () => {
    expect(activateSecondarySizing(8, 0, 6, 0.25)).toBeNull();
    expect(activateSecondarySizing(0, 120_000, 6, 0.25)).toBeNull();
  });
});
