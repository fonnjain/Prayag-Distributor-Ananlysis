import { describe, expect, it } from "vitest";
import {
  canReuseGrowthCacheForSecondaryCoverage,
  secondaryCoverageFingerprint,
  shouldSuppressSecondaryRegisterConclusions,
  suppressSecondaryRegisterFinalPayload,
} from "./aiGrowthReport.js";

describe("AI Growth H5 suppression decision", () => {
  const missing = ["Apr-26", "May-26", "Jun-26"];

  it("invalidates cached AI output when live H5 suppression changes", () => {
    expect(canReuseGrowthCacheForSecondaryCoverage(true, false)).toBe(false);
    expect(canReuseGrowthCacheForSecondaryCoverage(false, true)).toBe(false);
    expect(canReuseGrowthCacheForSecondaryCoverage(true, true)).toBe(true);
    expect(canReuseGrowthCacheForSecondaryCoverage(false, false)).toBe(true);
  });

  it("invalidates a still-suppressed cache entry when H5 coverage details change", () => {
    const base = {
      code: "H5" as const,
      id: 5,
      status: "open" as const,
      owner: "internal",
      resolutionUrl: "/settings/resolution/5",
      fiscalYear: "2026-27",
      targetMonths: ["Apr-26", "May-26", "Jun-26"],
      loadedMonths: ["Jul-26"],
      missingMonths: ["Apr-26", "May-26", "Jun-26"],
      missingRows: 89_179,
      missingNet: 590_203_202,
      message: "original",
    };
    const updated = {
      ...base,
      missingMonths: ["May-26", "Jun-26"],
      missingRows: 67_566,
      message: "updated",
    };
    expect(canReuseGrowthCacheForSecondaryCoverage(
      true,
      true,
      secondaryCoverageFingerprint(base),
      secondaryCoverageFingerprint(updated),
    )).toBe(false);
  });

  it("suppresses state-head secondary conclusions when requested labels overlap H5", () => {
    expect(shouldSuppressSecondaryRegisterConclusions("statehead", ["May-26"], missing)).toBe(true);
  });

  it("does not suppress a July-only state-head request", () => {
    expect(shouldSuppressSecondaryRegisterConclusions("statehead", ["Jul-26"], missing)).toBe(false);
  });

  it("does not suppress non-state-head paths", () => {
    expect(shouldSuppressSecondaryRegisterConclusions("company", ["May-26"], missing)).toBe(false);
    expect(shouldSuppressSecondaryRegisterConclusions("state", ["May-26"], missing)).toBe(false);
  });

  it("final payload contains no suppressed lever conclusions", () => {
    const payload = suppressSecondaryRegisterFinalPayload({
      activate: {
        totalDormantCount: 4,
        valueHigh: 100,
        lowActivationDistributors: [{ name: "D1" }],
        notAvailableReason: "ACTIVATE withheld under H5.",
      },
      widen: {
        valueHigh: 200,
        top20Distributors: [{ name: "D2" }],
        notAvailableReason: "WIDEN withheld under H5.",
      },
      opportunityLedger: {
        rows: [
          { lever: "ACTIVATE", entityName: "D1", valueHigh: 100 },
          { lever: "WIDEN", entityName: "D2", valueHigh: 200 },
          { lever: "RECOVER", entityName: "C1", valueHigh: 50 },
        ],
        omittedCount: 2,
        omittedValue: 25,
      },
      executiveSummary: {
        leverRanking: [
          { lever: "ACTIVATE", value: 100, entityCount: 1 },
          { lever: "WIDEN", value: 200, entityCount: 1 },
          { lever: "RECOVER", value: 50, entityCount: 1 },
        ],
      },
      narrative: { close: "valid close narrative", activate: "claim", widen: "claim" },
    });
    expect(payload.activate.valueHigh).toBeNull();
    expect(payload.widen.valueHigh).toBeNull();
    expect(payload.opportunityLedger.rows).toEqual([{ lever: "RECOVER", entityName: "C1", valueHigh: 50 }]);
    expect(payload.executiveSummary.leverRanking).toEqual([{ lever: "RECOVER", value: 50, entityCount: 1 }]);
    expect(payload.opportunityLedger.omittedCount).toBe(2);
    expect(payload.opportunityLedger.omittedValue).toBe(25);
    expect(payload.narrative).toEqual({
      close: "valid close narrative",
      activate: "ACTIVATE withheld under H5.",
      widen: "WIDEN withheld under H5.",
    });
  });
});