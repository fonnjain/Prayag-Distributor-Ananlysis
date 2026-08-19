import { describe, expect, it } from "vitest";
import {
  evaluateSecondaryOrderUpload,
  type SecondaryOrderUploadMetrics,
} from "./uploadQuality";

function metrics(overrides: Partial<SecondaryOrderUploadMetrics> = {}): SecondaryOrderUploadMetrics {
  return {
    rowsScanned: 1_000,
    rowsParsed: 1_000,
    rowsRejected: 0,
    retailerResolution: { matched: 980, total: 1_000, rate: 0.98 },
    distributorResolution: { matched: 99, total: 100, rate: 0.99 },
    personResolution: { matched: 98, total: 100, rate: 0.98 },
    repeatedPairCount: 10,
    repeatedPairRows: 20,
    repeatedPairRate: 0.02,
    exactDuplicateRows: 0,
    exactDuplicateRate: 0,
    changedLineCollisionCount: 0,
    changedLineCollisionRate: 0,
    ...overrides,
  };
}

describe("secondary order upload quality", () => {
  it("keeps the first valid upload pending as the comparison baseline", () => {
    const result = evaluateSecondaryOrderUpload(metrics(), null);

    expect(result.assessment).toBe("PENDING_BASELINE");
    expect(result.analyticsStatus).toBe("ISOLATED_PENDING_RELIABILITY");
    expect(result.comparison.baselineUploadId).toBeNull();
  });

  it("surfaces a material stable-ID resolution regression", () => {
    const result = evaluateSecondaryOrderUpload(
      metrics({ retailerResolution: { matched: 940, total: 1_000, rate: 0.94 } }),
      { uploadId: 12, metrics: metrics() },
    );

    expect(result.assessment).toBe("MATERIAL_REGRESSION");
    expect(result.materialReasons.join(" ")).toContain("RET# retailer resolution");
    expect(result.comparison.retailerResolutionDeltaPoints).toBeCloseTo(-4);
  });

  it("never establishes a low-resolution upload as a usable baseline", () => {
    const unusable = metrics({
      retailerResolution: { matched: 0, total: 1_000, rate: 0 },
      distributorResolution: { matched: 0, total: 100, rate: 0 },
      personResolution: { matched: 0, total: 100, rate: 0 },
    });

    expect(evaluateSecondaryOrderUpload(unusable, null).assessment).toBe("MATERIAL_REGRESSION");
    expect(evaluateSecondaryOrderUpload(unusable, { uploadId: 15, metrics: unusable }).assessment)
      .toBe("MATERIAL_REGRESSION");
  });

  it("surfaces repeated pairs and changed identity lines before review", () => {
    const result = evaluateSecondaryOrderUpload(
      metrics({
        repeatedPairRate: 0.05,
        changedLineCollisionCount: 2,
        changedLineCollisionRate: 0.002,
      }),
      { uploadId: 13, metrics: metrics() },
    );

    expect(result.assessment).toBe("MATERIAL_REGRESSION");
    expect(result.materialReasons.join(" ")).toContain("Repeated order/product-pair rate");
    expect(result.materialReasons.join(" ")).toContain("changed-line identity collision");
  });

  it("marks a stable later upload ready for human review, not analytics", () => {
    const result = evaluateSecondaryOrderUpload(metrics(), { uploadId: 14, metrics: metrics() });

    expect(result.assessment).toBe("READY_FOR_REVIEW");
    expect(result.analyticsStatus).toBe("ISOLATED_PENDING_RELIABILITY");
    expect(result.materialReasons).toEqual([]);
  });
});