import { describe, expect, it } from "vitest";
import seasonalConfig from "../../../config/seasonal_weights.json";
import {
  buildSeasonalCurveMath,
  compareSeasonalCurveToConfig,
} from "../seasonalCurveMath.js";

describe("versioned seasonal curve math", () => {
  it("matches the checked-in FY2025-26 rounding baseline and closes at 100%", () => {
    const configured = seasonalConfig.versions.find((version) => version.fy === "2025-26");
    expect(configured).toBeDefined();
    const curve = buildSeasonalCurveMath([
      {
        fy: "2025-26",
        rows: 999,
        monthlyNet: configured!.monthly.map((share) => share * 1_000_000),
      },
    ]);
    const comparison = compareSeasonalCurveToConfig(curve, configured!.monthly);

    expect(curve.monthWeights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 10);
    expect(curve.quarterWeights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 10);
    // The historic config is normalised at runtime; its displayed rounded
    // baseline remains Q1 20.9% / Q4 34.6%, with sub-0.1pp residue accepted.
    expect(curve.quarterWeights[0]).toBeCloseTo(20.9, 1);
    expect(curve.quarterWeights[3]).toBeCloseTo(34.6, 1);
    expect(comparison.maxAbsMonthDelta).toBeLessThan(0.001);
  });

  it("gives every frozen fiscal year one equal vote regardless of rupee volume", () => {
    const curve = buildSeasonalCurveMath([
      {
        fy: "2023-24",
        rows: 100,
        monthlyNet: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90],
      },
      {
        fy: "2024-25",
        rows: 100_000,
        monthlyNet: [900_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100_000],
      },
    ]);

    expect(curve.monthWeights[0]).toBeCloseTo(50, 10);
    expect(curve.monthWeights[11]).toBeCloseTo(50, 10);
    expect(curve.monthWeights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 10);
    expect(curve.monthRanges[0]).toEqual([10, 90]);
    expect(curve.monthShareStddev[0]).toBeCloseTo(40, 10);
  });

  it("changes only when a new completed year is appended", () => {
    const firstThree = [
      { fy: "2023-24", rows: 1, monthlyNet: [10, 10, 10, 10, 10, 10, 10, 10, 5, 5, 5, 5] },
      { fy: "2024-25", rows: 1, monthlyNet: [5, 5, 5, 5, 5, 5, 5, 5, 10, 10, 10, 10] },
      { fy: "2025-26", rows: 1, monthlyNet: [8, 8, 8, 8, 8, 8, 8, 8, 7, 7, 7, 7] },
    ];
    const v2 = buildSeasonalCurveMath(firstThree);
    const v3 = buildSeasonalCurveMath([
      ...firstThree,
      { fy: "2026-27", rows: 1, monthlyNet: [20, 20, 20, 20, 5, 5, 5, 5, 5, 5, 5, 5] },
    ]);

    expect(v2.fiscalYearsUsed).toEqual(["2023-24", "2024-25", "2025-26"]);
    expect(v3.fiscalYearsUsed).toEqual(["2023-24", "2024-25", "2025-26", "2026-27"]);
    expect(v3.monthWeights).not.toEqual(v2.monthWeights);
    expect(v3.monthWeights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 10);
  });
});