import { pool } from "@workspace/db";
import {
  buildCanonicalCoverageDriftCheck,
  buildCanonicalCoverageReport,
} from "./canonicalCoverageReport.js";
import { logger } from "./logger.js";

type DriftTrigger = "register_sheets_sync";

type DriftSummary = {
  reconciliation: {
    archivedLegacyRows: number;
    canonicalCoverageRows: number;
    mappingRows: number;
    unmappedLegacyRows: number;
  };
  derivedIntegrity: {
    attributionIssues: number;
    coverageMismatches: number;
    evidenceMismatches: number;
    punjabGapMatches: boolean;
  };
  uncoveredGaps: Array<{
    state_canon: string;
    fiscal_year: string;
    customer_count: number;
    net_amount: number;
    reason: string;
  }>;
};

function summaryFor(report: Awaited<ReturnType<typeof buildCanonicalCoverageReport>>): DriftSummary {
  return {
    reconciliation: report.reconciliation,
    derivedIntegrity: report.derivedIntegrity,
    uncoveredGaps: report.uncoveredGaps,
  };
}

/**
 * Revalidates sales evidence after a register write. It is deliberately
 * read-only with respect to coverage: an exception is persisted for review,
 * while person_state_coverage remains unchanged.
 */
export async function recordCanonicalCoverageDriftCheck(
  fy: string,
  trigger: DriftTrigger = "register_sheets_sync",
): Promise<void> {
  try {
    const [report, check] = await Promise.all([
      buildCanonicalCoverageReport(),
      buildCanonicalCoverageDriftCheck(fy),
    ]);
    const status = check.passed ? "ok" : "drift";
    const detail = {
      ...summaryFor(report),
      passed: check.passed,
      issueCount: check.issueCount,
      issues: check.issues,
      concentrationWarnings: check.concentrationWarnings,
    };

    await pool.query(
      `INSERT INTO canonical_coverage_drift_event
         (trigger_fy, trigger_source, report_fy, status, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [fy, trigger, report.fy, status, JSON.stringify(detail)],
    );

    const logContext = {
      triggerFy: fy,
      reportFy: report.fy,
      ...detail.derivedIntegrity,
      issueCount: check.issueCount,
      concentrationWarningCount: check.concentrationWarnings.length,
      uncoveredGapCount: detail.uncoveredGaps.length,
    };
    if (check.passed) {
      logger.info(logContext, "canonical coverage evidence check: ok");
    } else {
      logger.warn(
        logContext,
        "canonical coverage evidence drift detected — coverage was not changed",
      );
    }
  } catch (err) {
    const detail = {
      error: err instanceof Error ? err.message : String(err),
    };

    try {
      await pool.query(
        `INSERT INTO canonical_coverage_drift_event
           (trigger_fy, trigger_source, status, detail)
         VALUES ($1, $2, 'error', $3::jsonb)`,
        [fy, trigger, JSON.stringify(detail)],
      );
    } catch (recordErr) {
      logger.error(
        { triggerFy: fy, err: recordErr },
        "canonical coverage evidence check: could not persist failure",
      );
    }

    logger.warn(
      { triggerFy: fy, err },
      "canonical coverage evidence check failed — coverage was not changed",
    );
  }
}