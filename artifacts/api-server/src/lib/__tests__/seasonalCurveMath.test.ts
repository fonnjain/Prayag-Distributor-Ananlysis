import { describe, expect, it } from "vitest";
import seasonalConfig from "../../../config/seasonal_weights.json";
import {
  buildSeasonalCurveMath,
  compareSeasonalCurveToConfig,
  selectSeasonalCurveActivation,
} from "../seasonalCurveMath.js";

describe("versioned seasonal curve math", () => {
  it("matches the checked-in FY2025-26 rounding baseline and closes at 100%", () => {
    const configured = seasonalConfig.versions.find((version) => version.fy === "2025-26");
    expect(configured).toBeDefined();
    const curve = buildSeasonalCurveMath([
      {
        fy: "2025-26",
        sourceBasis: "test",
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

  it("reproduces the FY2025-26 retail-channel extraction within rounding tolerance", () => {
    const configured = seasonalConfig.versions.find((version) => version.fy === "2025-26")!;
    const curve = buildSeasonalCurveMath([
      {
        fy: "2025-26",
        sourceBasis: "channel_retail",
        rows: 136_438,
        monthlyNet: [
          126_250_377.77, 243_574_543.82, 262_953_150.06, 217_162_338.89,
          210_175_997.02, 196_145_825.81, 195_255_794.08, 247_950_792.91,
          288_352_012.94, 305_161_455.36, 328_269_075.9, 412_527_187.36,
        ],
      },
    ]);
    const comparison = compareSeasonalCurveToConfig(curve, configured.monthly);

    expect(curve.sourceBasis).toEqual({ "2025-26": "channel_retail" });
    expect(comparison.maxAbsMonthDelta).toBeLessThanOrEqual(0.1);
    // The checked-in one-decimal config is normalised from 100.1 to 100.0
    // at runtime, so quarterly deltas are intentionally compared indirectly
    // through the exact monthly tolerance above.
  });

  it("gives every frozen fiscal year one equal vote regardless of rupee volume", () => {
    const curve = buildSeasonalCurveMath([
      {
        fy: "2023-24",
        sourceBasis: "test",
        rows: 100,
        monthlyNet: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90],
      },
      {
        fy: "2024-25",
        sourceBasis: "test",
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
      { fy: "2023-24", sourceBasis: "test", rows: 1, monthlyNet: [10, 10, 10, 10, 10, 10, 10, 10, 5, 5, 5, 5] },
      { fy: "2024-25", sourceBasis: "test", rows: 1, monthlyNet: [5, 5, 5, 5, 5, 5, 5, 5, 10, 10, 10, 10] },
      { fy: "2025-26", sourceBasis: "test", rows: 1, monthlyNet: [8, 8, 8, 8, 8, 8, 8, 8, 7, 7, 7, 7] },
    ];
    const v2 = buildSeasonalCurveMath(firstThree);
    const v3 = buildSeasonalCurveMath([
      ...firstThree,
      { fy: "2026-27", sourceBasis: "test", rows: 1, monthlyNet: [20, 20, 20, 20, 5, 5, 5, 5, 5, 5, 5, 5] },
    ]);

    expect(v2.fiscalYearsUsed).toEqual(["2023-24", "2024-25", "2025-26"]);
    expect(v3.fiscalYearsUsed).toEqual(["2023-24", "2024-25", "2025-26", "2026-27"]);
    expect(v3.monthWeights).not.toEqual(v2.monthWeights);
    expect(v3.monthWeights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 10);
  });

  it("keeps the verified baseline active rather than averaging an unclassified frozen year", () => {
    const activation = selectSeasonalCurveActivation([
      {
        fy: "2023-24",
        sourceBasis: "territory_true",
        rows: 10,
        monthlyNet: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90],
      },
      {
        fy: "2024-25",
        sourceBasis: "legacy_unclassified",
        rows: 10,
        monthlyNet: [90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10],
      },
      {
        fy: "2025-26",
        sourceBasis: "channel_retail",
        rows: 10,
        monthlyNet: [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80],
      },
    ]);

    expect(activation.mode).toBe("verified_baseline");
    expect(activation.curve.fiscalYearsUsed).toEqual(["2025-26"]);
    expect(activation.blockedFiscalYears).toEqual([
      { fy: "2024-25", sourceBasis: "legacy_unclassified" },
    ]);
  });

  it("rejects replacing the approved baseline when FY2025-26 is not fully retail-classified", () => {
    expect(() =>
      selectSeasonalCurveActivation([
        {
          fy: "2025-26",
          sourceBasis: "channel_incomplete",
          rows: 10,
          monthlyNet: [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80],
        },
      ]),
    ).toThrow("not fully retail-classified");
  });

  it("activates equal weighting only when every frozen year has comparable scope", () => {
    const activation = selectSeasonalCurveActivation([
      {
        fy: "2023-24",
        sourceBasis: "territory_true",
        rows: 10,
        monthlyNet: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90],
      },
      {
        fy: "2025-26",
        sourceBasis: "channel_retail",
        rows: 10,
        monthlyNet: [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80],
      },
    ]);

    expect(activation.mode).toBe("equal_weighted_multi_year");
    expect(activation.blockedFiscalYears).toEqual([]);
    expect(activation.curve.fiscalYearsUsed).toEqual(["2023-24", "2025-26"]);
  });
});