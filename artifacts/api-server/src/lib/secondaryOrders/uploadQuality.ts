/**
 * Per-upload reliability rules for the stable-ID secondary-order feed.
 *
 * This feed remains isolated from sales, SKU, margin, and alert analytics.
 * A healthy result means an operator may review another upload; it never
 * grants analytics approval on its own.
 */

export type StableIdResolution = {
  matched: number;
  total: number;
  rate: number;
};

export type SecondaryOrderUploadMetrics = {
  rowsScanned: number;
  rowsParsed: number;
  rowsRejected: number;
  retailerResolution: StableIdResolution;
  distributorResolution: StableIdResolution;
  personResolution: StableIdResolution;
  repeatedPairCount: number;
  repeatedPairRows: number;
  repeatedPairRate: number;
  exactDuplicateRows: number;
  exactDuplicateRate: number;
  changedLineCollisionCount: number;
  changedLineCollisionRate: number;
};

export type SecondaryOrderUploadComparison = {
  baselineUploadId: number | null;
  retailerResolutionDeltaPoints: number | null;
  distributorResolutionDeltaPoints: number | null;
  personResolutionDeltaPoints: number | null;
  repeatedPairRateDeltaPoints: number | null;
  exactDuplicateRateDeltaPoints: number | null;
  changedLineCollisionRateDeltaPoints: number | null;
};

export type SecondaryOrderUploadAssessment =
  | "PENDING_BASELINE"
  | "READY_FOR_REVIEW"
  | "MATERIAL_REGRESSION";

export type UploadQualityEvaluation = {
  assessment: SecondaryOrderUploadAssessment;
  materialReasons: string[];
  comparison: SecondaryOrderUploadComparison;
  analyticsStatus: "ISOLATED_PENDING_RELIABILITY";
};

export const UPLOAD_QUALITY_THRESHOLDS = {
  retailerResolutionMinRate: 0.95,
  distributorResolutionMinRate: 0.97,
  personResolutionMinRate: 0.95,
  resolutionDropPoints: 2,
  repeatedPairRateIncreasePoints: 2,
  exactDuplicateRateMaxPoints: 0.5,
  changedLineCollisionRateMaxPoints: 0.1,
  rejectedRowRateMaxPoints: 1,
} as const;

function rateDeltaPoints(current: number, baseline: number | null): number | null {
  return baseline == null ? null : (current - baseline) * 100;
}

function formatPoints(points: number): string {
  return `${points.toFixed(2)} percentage points`;
}

/**
 * Evaluates one source file against the latest earlier successful upload.
 * Rates are stored as fractions (0–1), but all operator-facing deltas are
 * percentage points to avoid ambiguous percentages of percentages.
 */
export function evaluateSecondaryOrderUpload(
  current: SecondaryOrderUploadMetrics,
  baseline: { uploadId: number; metrics: SecondaryOrderUploadMetrics } | null,
): UploadQualityEvaluation {
  const prior = baseline?.metrics ?? null;
  const comparison: SecondaryOrderUploadComparison = {
    baselineUploadId: baseline?.uploadId ?? null,
    retailerResolutionDeltaPoints: rateDeltaPoints(current.retailerResolution.rate, prior?.retailerResolution.rate ?? null),
    distributorResolutionDeltaPoints: rateDeltaPoints(current.distributorResolution.rate, prior?.distributorResolution.rate ?? null),
    personResolutionDeltaPoints: rateDeltaPoints(current.personResolution.rate, prior?.personResolution.rate ?? null),
    repeatedPairRateDeltaPoints: rateDeltaPoints(current.repeatedPairRate, prior?.repeatedPairRate ?? null),
    exactDuplicateRateDeltaPoints: rateDeltaPoints(current.exactDuplicateRate, prior?.exactDuplicateRate ?? null),
    changedLineCollisionRateDeltaPoints: rateDeltaPoints(
      current.changedLineCollisionRate,
      prior?.changedLineCollisionRate ?? null,
    ),
  };

  const reasons: string[] = [];
  const threshold = UPLOAD_QUALITY_THRESHOLDS;
  const absoluteResolutionChecks: Array<[string, StableIdResolution, number]> = [
    ["RET# retailer resolution", current.retailerResolution, threshold.retailerResolutionMinRate],
    ["DIST# distributor resolution", current.distributorResolution, threshold.distributorResolutionMinRate],
    ["salesperson resolution", current.personResolution, threshold.personResolutionMinRate],
  ];
  for (const [label, resolution, minimum] of absoluteResolutionChecks) {
    if (resolution.rate < minimum) {
      reasons.push(
        `${label} is ${(resolution.rate * 100).toFixed(2)}%, below the ${(minimum * 100).toFixed(2)}% minimum.`,
      );
    }
  }
  const resolutionChecks: Array<[string, number | null]> = [
    ["RET# retailer resolution", comparison.retailerResolutionDeltaPoints],
    ["DIST# distributor resolution", comparison.distributorResolutionDeltaPoints],
    ["salesperson resolution", comparison.personResolutionDeltaPoints],
  ];
  for (const [label, delta] of resolutionChecks) {
    if (delta != null && delta <= -threshold.resolutionDropPoints) {
      reasons.push(`${label} fell by ${formatPoints(Math.abs(delta))} from the prior upload.`);
    }
  }

  if (
    comparison.repeatedPairRateDeltaPoints != null &&
    comparison.repeatedPairRateDeltaPoints >= threshold.repeatedPairRateIncreasePoints
  ) {
    reasons.push(
      `Repeated order/product-pair rate rose by ${formatPoints(comparison.repeatedPairRateDeltaPoints)} from the prior upload.`,
    );
  }

  if (current.exactDuplicateRate * 100 > threshold.exactDuplicateRateMaxPoints) {
    reasons.push(
      `Exact duplicate export rows are ${(current.exactDuplicateRate * 100).toFixed(2)}%, above the ${threshold.exactDuplicateRateMaxPoints.toFixed(2)}% limit.`,
    );
  }

  if (current.changedLineCollisionRate * 100 >= threshold.changedLineCollisionRateMaxPoints) {
    reasons.push(
      `${current.changedLineCollisionCount} changed-line identity collision(s) affect ${(current.changedLineCollisionRate * 100).toFixed(2)}% of parsed rows.`,
    );
  }

  const rejectedRowRate = current.rowsScanned === 0 ? 0 : current.rowsRejected / current.rowsScanned;
  if (rejectedRowRate * 100 > threshold.rejectedRowRateMaxPoints) {
    reasons.push(
      `${current.rowsRejected} row(s) were rejected while parsing (${(rejectedRowRate * 100).toFixed(2)}% of scanned rows).`,
    );
  }

  return {
    assessment: reasons.length > 0
      ? "MATERIAL_REGRESSION"
      : baseline
        ? "READY_FOR_REVIEW"
        : "PENDING_BASELINE",
    materialReasons: reasons,
    comparison,
    analyticsStatus: "ISOLATED_PENDING_RELIABILITY",
  };
}