import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

import { pool } from "@workspace/db";
import {
  auditCanonicalCoverageDrift,
  buildCanonicalCoverageDriftCheck,
  invalidateCanonicalCoverageDriftCache,
} from "./canonicalCoverageReport.js";

const query = vi.mocked(pool.query);

describe("canonical coverage drift check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCanonicalCoverageDriftCache();
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
            currentRegisterEvidence: { customerCount: 4, netAmount: 900 },
            persistedCoverageEvidence: { customerCount: 3, netAmount: 600 },
            difference: { customerCount: 1, netAmount: 300, effectiveToDays: 30 },
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
            structural: {
              headChanged: true,
              customerPresenceChanged: false,
              currentPersonName: "New Head",
              persistedPersonName: "Prior Head",
            },
          },
        },
      ],
    } as never).mockResolvedValueOnce({
      rows: [{
        fiscal_year: "2025-26",
        customer_name: "GRAHAA PRIYA ENTERPRISES",
        customer_count: "1",
        customer_net_amount: "94025777.70",
        state_net_amount: "94025777.70",
        share_percent: "100",
        coverage_rows: "1",
        coverage_people: ["Sandeep Dadheech"],
        responsible_heads: ["Sandeep Dadheech"],
      }],
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
    expect(check.issues[1]?.detail).toMatchObject({
      review: {
        canonicalLeaf: "TAMIL NADU",
        fiscalYear: "2026-27",
        currentRegisterEvidence: { customerCount: 4, netAmount: 900 },
        persistedEvidence: { customerCount: 3, netAmount: 600 },
        difference: { customerCount: 1, netAmount: 300, effectiveToDays: 30 },
        coverageWasChanged: false,
      },
    });
    expect(check.issues[2]?.detail).toMatchObject({
      structuralReasons: ["customer-head-changed"],
    });
    expect(check.concentrationWarnings).toMatchObject([{
      stateCanon: "TAMIL NADU",
      fiscalYear: "2025-26",
      customer: "GRAHAA PRIYA ENTERPRISES",
      sharePercent: 100,
      customerNetAmount: 94_025_777.70,
    }]);

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("has_unassigned");
    expect(sql).toContain("has_system");
    expect(sql).toContain("has_unresolved");
    expect(sql).toContain("effective_from");
    expect(sql).toContain("evidence_fiscal_year");
    expect(sql).toContain("sourceFiscalYear");
    expect(sql).toContain("currentRegisterEvidence");
    expect(sql).toContain("persistedCoverageEvidence");
    expect(sql).toContain("effectiveFromDays");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(params).toEqual(["2026-27"]);
    const [concentrationSql, concentrationParams] = query.mock.calls[1]!;
    expect(concentrationSql).toContain("TAMIL NADU");
    expect(concentrationSql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(concentrationParams).toEqual(["2026-27"]);
  });

  it("persists the reviewable result separately from coverage", async () => {
    query
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const check = await auditCanonicalCoverageDrift("register_sync", "2026-27");

    expect(check).toMatchObject({
      fiscalYear: "2026-27",
      passed: true,
      issueCount: 0,
      issues: [],
      concentrationWarnings: [],
    });
    expect(query).toHaveBeenCalledTimes(3);

    const [auditSql, auditParams] = query.mock.calls[2]!;
    expect(auditSql).toContain("INSERT INTO canonical_coverage_drift_event");
    expect(auditParams).toEqual([
      "2026-27",
      "register_sync",
      "2026-27",
      "ok",
      JSON.stringify({ passed: true, issueCount: 0, issues: [], concentrationWarnings: [] }),
    ]);
  });

  it("caches open-FY read evidence until an explicit register-sync invalidation", async () => {
    query.mockResolvedValue({ rows: [] } as never);

    await buildCanonicalCoverageDriftCheck("2026-27");
    await buildCanonicalCoverageDriftCheck("2026-27");
    expect(query).toHaveBeenCalledTimes(2);

    invalidateCanonicalCoverageDriftCache("2026-27");
    await buildCanonicalCoverageDriftCheck("2026-27");
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("keeps a value-only evidence difference visible for a frozen FY", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          issue_kind: "evidence-mismatch",
          fiscal_year: "2025-26",
          state_canon: "TAMIL NADU",
          customer: "Frozen FY Dealer",
          detail: {
            currentRegisterEvidence: { fiscalYear: "2025-26", netAmount: 940 },
            persistedEvidence: { evidenceFiscalYear: "2025-26", netAmount: 900 },
            structural: {
              headChanged: false,
              customerPresenceChanged: false,
              currentPersonName: "Sandeep Dadheech",
              persistedPersonName: "Sandeep Dadheech",
            },
            difference: { netAmount: 40, fiscalYearChanged: false },
          },
        }],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const check = await buildCanonicalCoverageDriftCheck("2025-26");

    expect(check).toMatchObject({
      fiscalYear: "2025-26",
      passed: false,
      issueCount: 1,
      issues: [{
        kind: "evidence-mismatch",
        customer: "Frozen FY Dealer",
        detail: {
          difference: { netAmount: 40 },
          structuralReasons: [],
        },
      }],
    });
  });
});