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

/**
 * A passing upload is evidence, not permission to reinterpret order bookings
 * as dispatch.  Approval requires a human review of an independent evidence
 * window, so this status deliberately stops at READY_FOR_MANUAL_APPROVAL.
 */
export type SecondaryOrderAnalyticsApprovalStatus =
  | "NOT_READY"
  | "READY_FOR_MANUAL_APPROVAL";

export type SecondaryOrderUploadEvidence = Pick<
  UploadQualityEvaluation,
  "assessment" | "materialReasons"
> & {
  uploadId: number;
  sourceSha256: string;
  loadedAt: string;
};

export type SecondaryOrderAnalyticsApproval = {
  status: SecondaryOrderAnalyticsApprovalStatus;
  basis: "ORDER BOOKING";
  analyticsStatus: "ISOLATED_PENDING_RELIABILITY";
  requiredVerifiedUploads: number;
  minimumEvidenceWindowDays: number;
  verifiedUploadCount: number;
  evidenceWindowDays: number | null;
  evidenceUploadIds: number[];
  unresolvedMaterialRegressionUploadIds: number[];
  mostRecentMaterialRegressionUploadId: number | null;
  duplicateSourceUploadIds: number[];
  reason: string;
  approverRoles: readonly string[];
};

/**
 * This is intentionally a manual-approval gate, not an automatic cutover.
 *
 * A source SHA is one piece of evidence regardless of how many times an
 * operator uploads it. A material regression is located in the complete
 * chronological ledger before any source-file de-duplication happens. The
 * evidence window must then contain three clean, independently sourced uploads
 * after that regression, spanning at least fourteen elapsed days.
 */
export const SECONDARY_ORDER_ANALYTICS_APPROVAL_POLICY = {
  requiredVerifiedUploads: 3,
  minimumEvidenceWindowDays: 14,
  approverRoles: [
    "Sales Operations owner (confirms the source is fit for the business use)",
    "Data/Engineering owner (confirms lineage, identity coverage, and reconciliation)",
  ],
  basis: "ORDER BOOKING",
  analyticsStatus: "ISOLATED_PENDING_RELIABILITY",
} as const;

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

function elapsedDays(start: string, end: string): number | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return (endMs - startMs) / 86_400_000;
}

/**
 * Determine whether the upload ledger has enough clean, independent evidence
 * to ask the named approvers for a decision.  No caller should treat the
 * READY_FOR_MANUAL_APPROVAL result as an analytics enablement flag.
 */
export function evaluateSecondaryOrderAnalyticsApproval(
  uploads: SecondaryOrderUploadEvidence[],
): SecondaryOrderAnalyticsApproval {
  const policy = SECONDARY_ORDER_ANALYTICS_APPROVAL_POLICY;
  const chronologicalUploads = [...uploads].sort(
    (a, b) => Date.parse(a.loadedAt) - Date.parse(b.loadedAt) || a.uploadId - b.uploadId,
  );
  let latestMaterialIndex = -1;
  for (let i = chronologicalUploads.length - 1; i >= 0; i--) {
    const upload = chronologicalUploads[i];
    if (upload.assessment === "MATERIAL_REGRESSION" || upload.materialReasons.length > 0) {
      latestMaterialIndex = i;
      break;
    }
  }
  const latestMaterial = latestMaterialIndex >= 0
    ? chronologicalUploads[latestMaterialIndex]
    : undefined;
  // Nothing uploaded before the latest material regression is eligible
  // evidence, even when it shares a SHA with a later clean re-upload.
  const cleanCandidates = chronologicalUploads
    .slice(latestMaterialIndex + 1)
    .filter((upload) => (
      upload.assessment !== "MATERIAL_REGRESSION" && upload.materialReasons.length === 0
    ));

  const bySource = new Map<string, SecondaryOrderUploadEvidence>();
  const duplicateSourceUploadIds: number[] = [];

  for (const upload of cleanCandidates) {
    const prior = bySource.get(upload.sourceSha256);
    if (prior) {
      duplicateSourceUploadIds.push(upload.uploadId);
      if (Date.parse(upload.loadedAt) >= Date.parse(prior.loadedAt)) {
        bySource.set(upload.sourceSha256, upload);
      }
    } else {
      bySource.set(upload.sourceSha256, upload);
    }
  }

  const cleanStreak = Array.from(bySource.values()).sort(
    (a, b) => Date.parse(a.loadedAt) - Date.parse(b.loadedAt) || a.uploadId - b.uploadId,
  );

  const evidenceUploadIds = cleanStreak.map((upload) => upload.uploadId);
  const evidenceWindowDays = cleanStreak.length >= 2
    ? elapsedDays(cleanStreak[0].loadedAt, cleanStreak[cleanStreak.length - 1].loadedAt)
    : null;
  // A later clean source starts a new evidence window. Keep the prior
  // regression visible for the approving humans, but only call it unresolved
  // when no clean upload follows it.
  const unresolvedMaterialRegressionUploadIds = latestMaterial && cleanStreak.length === 0
    ? [latestMaterial.uploadId]
    : [];
  const enoughUploads = cleanStreak.length >= policy.requiredVerifiedUploads;
  const enoughTime = (evidenceWindowDays ?? 0) >= policy.minimumEvidenceWindowDays;
  const ready = enoughUploads && enoughTime && unresolvedMaterialRegressionUploadIds.length === 0;

  let reason: string;
  if (ready) {
    reason =
      `The latest ${policy.requiredVerifiedUploads} distinct-source uploads are clean and span ` +
      `${evidenceWindowDays!.toFixed(1)} days. Obtain both named human approvals before any consumer changes.`;
  } else if (unresolvedMaterialRegressionUploadIds.length > 0) {
    reason =
      `Upload #${unresolvedMaterialRegressionUploadIds[0]} has a material regression; ` +
      "the clean evidence streak must restart after it.";
  } else if (!enoughUploads) {
    reason =
      `Need ${policy.requiredVerifiedUploads} clean uploads from distinct source files; ` +
      `only ${cleanStreak.length} are available in the current clean streak.`;
  } else {
    reason =
      `The clean evidence window spans ${(evidenceWindowDays ?? 0).toFixed(1)} days; ` +
      `it must span at least ${policy.minimumEvidenceWindowDays} days.`;
  }

  return {
    status: ready ? "READY_FOR_MANUAL_APPROVAL" : "NOT_READY",
    basis: policy.basis,
    analyticsStatus: policy.analyticsStatus,
    requiredVerifiedUploads: policy.requiredVerifiedUploads,
    minimumEvidenceWindowDays: policy.minimumEvidenceWindowDays,
    verifiedUploadCount: cleanStreak.length,
    evidenceWindowDays,
    evidenceUploadIds,
    unresolvedMaterialRegressionUploadIds,
    mostRecentMaterialRegressionUploadId: latestMaterial?.uploadId ?? null,
    duplicateSourceUploadIds: duplicateSourceUploadIds.sort((a, b) => a - b),
    reason,
    approverRoles: policy.approverRoles,
  };
}

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