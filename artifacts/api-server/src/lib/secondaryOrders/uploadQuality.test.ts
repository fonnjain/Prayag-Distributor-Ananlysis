import { describe, expect, it } from "vitest";
import {
  evaluateSecondaryOrderAnalyticsApproval,
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

function evidence(
  uploadId: number,
  loadedAt: string,
  sourceSha256 = `sha-${uploadId}`,
  assessment: "PENDING_BASELINE" | "READY_FOR_REVIEW" | "MATERIAL_REGRESSION" = "READY_FOR_REVIEW",
) {
  return {
    uploadId,
    loadedAt,
    sourceSha256,
    assessment,
    materialReasons: assessment === "MATERIAL_REGRESSION" ? ["material test regression"] : [],
  };
}

describe("secondary order analytics approval gate", () => {
  it("requires three distinct clean uploads spanning fourteen days", () => {
    const result = evaluateSecondaryOrderAnalyticsApproval([
      evidence(1, "2026-08-01T00:00:00Z", "sha-a", "PENDING_BASELINE"),
      evidence(2, "2026-08-08T00:00:00Z", "sha-b"),
      evidence(3, "2026-08-15T00:00:00Z", "sha-c"),
    ]);

    expect(result.status).toBe("READY_FOR_MANUAL_APPROVAL");
    expect(result.analyticsStatus).toBe("ISOLATED_PENDING_RELIABILITY");
    expect(result.basis).toBe("ORDER BOOKING");
    expect(result.evidenceUploadIds).toEqual([1, 2, 3]);
    expect(result.evidenceWindowDays).toBe(14);
  });

  it("does not count a duplicate source file as independent evidence", () => {
    const result = evaluateSecondaryOrderAnalyticsApproval([
      evidence(1, "2026-08-01T00:00:00Z", "sha-a", "PENDING_BASELINE"),
      evidence(2, "2026-08-08T00:00:00Z", "sha-a"),
      evidence(3, "2026-08-15T00:00:00Z", "sha-b"),
    ]);

    expect(result.status).toBe("NOT_READY");
    expect(result.verifiedUploadCount).toBe(2);
    expect(result.duplicateSourceUploadIds).toEqual([2]);
  });

  it("restarts the clean evidence streak after a material regression", () => {
    const result = evaluateSecondaryOrderAnalyticsApproval([
      evidence(1, "2026-07-01T00:00:00Z", "sha-a", "PENDING_BASELINE"),
      evidence(2, "2026-07-08T00:00:00Z", "sha-b"),
      evidence(3, "2026-07-15T00:00:00Z", "sha-c", "MATERIAL_REGRESSION"),
      evidence(4, "2026-07-22T00:00:00Z", "sha-d"),
      evidence(5, "2026-07-29T00:00:00Z", "sha-e"),
    ]);

    expect(result.status).toBe("NOT_READY");
    expect(result.evidenceUploadIds).toEqual([4, 5]);
    expect(result.unresolvedMaterialRegressionUploadIds).toEqual([]);
    expect(result.mostRecentMaterialRegressionUploadId).toBe(3);
  });

  it("blocks approval when the newest distinct source has a material regression", () => {
    const result = evaluateSecondaryOrderAnalyticsApproval([
      evidence(1, "2026-08-01T00:00:00Z", "sha-a", "PENDING_BASELINE"),
      evidence(2, "2026-08-08T00:00:00Z", "sha-b"),
      evidence(3, "2026-08-15T00:00:00Z", "sha-c", "MATERIAL_REGRESSION"),
    ]);

    expect(result.status).toBe("NOT_READY");
    expect(result.unresolvedMaterialRegressionUploadIds).toEqual([3]);
  });

  it("can become ready for manual approval only after a fresh complete clean window", () => {
    const result = evaluateSecondaryOrderAnalyticsApproval([
      evidence(1, "2026-07-01T00:00:00Z", "sha-a", "PENDING_BASELINE"),
      evidence(2, "2026-07-08T00:00:00Z", "sha-b", "MATERIAL_REGRESSION"),
      evidence(3, "2026-07-15T00:00:00Z", "sha-c"),
      evidence(4, "2026-07-22T00:00:00Z", "sha-d"),
      evidence(5, "2026-07-29T00:00:00Z", "sha-e"),
    ]);

    expect(result.status).toBe("READY_FOR_MANUAL_APPROVAL");
    expect(result.analyticsStatus).toBe("ISOLATED_PENDING_RELIABILITY");
    expect(result.mostRecentMaterialRegressionUploadId).toBe(2);
    expect(result.unresolvedMaterialRegressionUploadIds).toEqual([]);
  });

  it("does not let a clean re-upload erase a material regression boundary", () => {
    const beforeEnoughEvidence = evaluateSecondaryOrderAnalyticsApproval([
      evidence(1, "2026-07-01T00:00:00Z", "sha-a", "PENDING_BASELINE"),
      evidence(2, "2026-07-08T00:00:00Z", "sha-a", "MATERIAL_REGRESSION"),
      evidence(3, "2026-07-15T00:00:00Z", "sha-a"),
      evidence(4, "2026-07-22T00:00:00Z", "sha-b"),
    ]);

    expect(beforeEnoughEvidence.status).toBe("NOT_READY");
    expect(beforeEnoughEvidence.evidenceUploadIds).toEqual([3, 4]);
    expect(beforeEnoughEvidence.mostRecentMaterialRegressionUploadId).toBe(2);

    const afterEnoughEvidence = evaluateSecondaryOrderAnalyticsApproval([
      evidence(1, "2026-07-01T00:00:00Z", "sha-a", "PENDING_BASELINE"),
      evidence(2, "2026-07-08T00:00:00Z", "sha-a", "MATERIAL_REGRESSION"),
      evidence(3, "2026-07-15T00:00:00Z", "sha-a"),
      evidence(4, "2026-07-22T00:00:00Z", "sha-b"),
      evidence(5, "2026-07-29T00:00:00Z", "sha-c"),
    ]);

    expect(afterEnoughEvidence.status).toBe("READY_FOR_MANUAL_APPROVAL");
    expect(afterEnoughEvidence.evidenceUploadIds).toEqual([3, 4, 5]);
    expect(afterEnoughEvidence.evidenceWindowDays).toBe(14);
  });
});