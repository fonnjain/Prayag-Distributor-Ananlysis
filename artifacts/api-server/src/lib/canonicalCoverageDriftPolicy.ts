import { isFrozen } from "./customers/freezeState.js";
import type { CanonicalCoverageDriftIssue } from "./canonicalCoverageReport.js";

export type OpenFiscalYearStructuralReason =
  | "source-attribution"
  | "customer-head-changed"
  | "customer-appeared-or-disappeared"
  | "customer-count-changed"
  | "effective-date-range-changed"
  | "leaf-gained-or-lost-head"
  | "evidence-fiscal-year-changed";

type DriftDetail = {
  difference?: {
    customerCount?: number;
    effectiveFromDays?: number | null;
    effectiveToDays?: number | null;
    effectiveFromChanged?: boolean;
    effectiveToChanged?: boolean;
    fiscalYearChanged?: boolean;
  };
  structural?: {
    headChanged?: boolean;
    customerPresenceChanged?: boolean;
    currentPersonName?: string | null;
    persistedPersonName?: string | null;
  };
};

const SOURCE_ATTRIBUTION_KINDS = new Set([
  "mixed",
  "unassigned",
  "system-routed",
  "unresolved",
]);

/**
 * Open-FY drift is actionable only when the approved coverage structure changes.
 * Net-value movement alone is expected while the live register is still open.
 */
export function getOpenFiscalYearStructuralReasons(
  issue: CanonicalCoverageDriftIssue,
): OpenFiscalYearStructuralReason[] {
  const detail = issue.detail as DriftDetail;
  if (SOURCE_ATTRIBUTION_KINDS.has(issue.kind)) return ["source-attribution"];

  if (issue.kind === "coverage-mismatch") {
    const reasons: OpenFiscalYearStructuralReason[] = [];
    if (detail.difference?.customerCount !== 0 && detail.difference?.customerCount !== undefined) {
      reasons.push("customer-count-changed");
    }
    if (detail.difference?.effectiveFromChanged || detail.difference?.effectiveToChanged) {
      reasons.push("effective-date-range-changed");
    }
    if (
      detail.structural?.currentPersonName !== detail.structural?.persistedPersonName
      && (detail.structural?.currentPersonName != null || detail.structural?.persistedPersonName != null)
    ) {
      reasons.push("leaf-gained-or-lost-head");
    }
    return reasons;
  }

  if (issue.kind === "evidence-mismatch") {
    const reasons: OpenFiscalYearStructuralReason[] = [];
    if (detail.structural?.headChanged) reasons.push("customer-head-changed");
    if (detail.structural?.customerPresenceChanged) reasons.push("customer-appeared-or-disappeared");
    if (detail.difference?.fiscalYearChanged) reasons.push("evidence-fiscal-year-changed");
    return reasons;
  }

  return [];
}

/**
 * Frozen FYs remain strict: every discrepancy, including net value, is reported.
 * The frozen-register map is the single closed-period boundary used everywhere.
 */
export function shouldReportCanonicalCoverageDriftIssue(
  issue: CanonicalCoverageDriftIssue,
): boolean {
  return isFrozen(issue.fiscalYear) || getOpenFiscalYearStructuralReasons(issue).length > 0;
}