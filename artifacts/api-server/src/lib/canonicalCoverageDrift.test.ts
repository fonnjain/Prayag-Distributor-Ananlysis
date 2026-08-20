import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const buildCanonicalCoverageReport = vi.fn();
const buildCanonicalCoverageDriftCheck = vi.fn();
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("@workspace/db", () => ({ pool: { query } }));
vi.mock("./canonicalCoverageReport.js", () => ({
  buildCanonicalCoverageReport,
  buildCanonicalCoverageDriftCheck,
}));
vi.mock("./logger.js", () => ({ logger }));

const { recordCanonicalCoverageDriftCheck } = await import("./canonicalCoverageDrift.js");

const report = (passed: boolean) => ({
  passed,
  fy: "2025-26",
  reconciliation: {
    archivedLegacyRows: 260,
    canonicalCoverageRows: 300,
    mappingRows: 260,
    unmappedLegacyRows: 0,
  },
  derivedIntegrity: {
    attributionIssues: passed ? 0 : 1,
    coverageMismatches: passed ? 0 : 2,
    evidenceMismatches: passed ? 0 : 3,
    punjabGapMatches: true,
  },
  uncoveredGaps: [],
});

describe("recordCanonicalCoverageDriftCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
    buildCanonicalCoverageDriftCheck.mockResolvedValue({
      passed: true,
      issueCount: 0,
      issues: [],
      concentrationWarnings: [],
    });
  });

  it("records an ok event and never writes coverage when evidence still reconciles", async () => {
    buildCanonicalCoverageReport.mockResolvedValue(report(true));

    await recordCanonicalCoverageDriftCheck("2026-27");

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("canonical_coverage_drift_event");
    expect(String(query.mock.calls[0]?.[0])).not.toContain("person_state_coverage");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "2026-27",
      "register_sheets_sync",
      "2025-26",
      "ok",
      expect.any(String),
    ]);
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("records and warns about drift without rewriting coverage", async () => {
    buildCanonicalCoverageReport.mockResolvedValue(report(false));
    buildCanonicalCoverageDriftCheck.mockResolvedValue({
      passed: false,
      issueCount: 1,
      issues: [{
        kind: "coverage-mismatch",
        stateCanon: "TAMIL NADU",
        fiscalYear: "2026-27",
        customer: null,
        detail: { review: { coverageWasChanged: false } },
      }],
      concentrationWarnings: [],
    });

    await recordCanonicalCoverageDriftCheck("2026-27");

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]?.[3]).toBe("drift");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerFy: "2026-27",
        coverageMismatches: 2,
        issueCount: 1,
      }),
      expect.stringContaining("drift"),
    );
  });

  it("persists a validation error and keeps the sync path non-throwing", async () => {
    buildCanonicalCoverageReport.mockRejectedValue(new Error("coverage report unavailable"));

    await expect(recordCanonicalCoverageDriftCheck("2026-27")).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("'error'");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ triggerFy: "2026-27" }),
      expect.stringContaining("failed"),
    );
  });
});