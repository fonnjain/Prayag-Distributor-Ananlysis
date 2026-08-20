import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

import { pool } from "@workspace/db";
import {
  auditCanonicalCoverageDrift,
  buildCanonicalCoverageDriftCheck,
} from "./canonicalCoverageReport.js";

const query = vi.mocked(pool.query);

describe("canonical coverage drift check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns clear customer-level attribution exceptions without changing coverage", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          issue_kind: "mixed",
          state_canon: "TAMIL NADU",
          fiscal_year: "2026-27",
          customer: "Example Dealer",
          detail: {
            registerHeads: ["Babu", "Sandeep Dadheech"],
            realHeadCount: 2,
            hasUnassigned: false,
            hasSystem: false,
            hasUnresolved: false,
          },
        },
        {
          issue_kind: "coverage-mismatch",
          state_canon: "TAMIL NADU",
          fiscal_year: "2026-27",
          customer: null,
          detail: {
            expected: { customerCount: 4, effectiveTo: "2026-06-30" },
            coverage: { customerCount: 3, effectiveTo: "2026-05-31" },
          },
        },
        {
          issue_kind: "evidence-mismatch",
          state_canon: "TAMIL NADU",
          fiscal_year: "2026-27",
          customer: "Fiscal-Year Dealer",
          detail: {
            sourceFiscalYear: "2026-27",
            evidenceFiscalYear: "2025-26",
            expectedNetAmount: 500,
            evidenceNetAmount: 500,
          },
        },
      ],
    } as never);

    const check = await buildCanonicalCoverageDriftCheck("2026-27");

    expect(check).toMatchObject({
      fiscalYear: "2026-27",
      passed: false,
      issueCount: 3,
      issues: [
        { kind: "mixed", customer: "Example Dealer" },
        { kind: "coverage-mismatch", customer: null },
        { kind: "evidence-mismatch", customer: "Fiscal-Year Dealer" },
      ],
    });

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("has_unassigned");
    expect(sql).toContain("has_system");
    expect(sql).toContain("has_unresolved");
    expect(sql).toContain("effective_from");
    expect(sql).toContain("evidence_fiscal_year");
    expect(sql).toContain("sourceFiscalYear");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(params).toEqual(["2026-27"]);
  });

  it("persists the reviewable result separately from coverage", async () => {
    query
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const check = await auditCanonicalCoverageDrift("register_sync", "2026-27");

    expect(check).toMatchObject({
      fiscalYear: "2026-27",
      passed: true,
      issueCount: 0,
      issues: [],
    });
    expect(query).toHaveBeenCalledTimes(2);

    const [auditSql, auditParams] = query.mock.calls[1]!;
    expect(auditSql).toContain("INSERT INTO canonical_coverage_drift_event");
    expect(auditParams).toEqual([
      "2026-27",
      "register_sync",
      "2026-27",
      "ok",
      JSON.stringify({ passed: true, issueCount: 0, issues: [] }),
    ]);
  });
});