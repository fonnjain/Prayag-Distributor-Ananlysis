import { describe, expect, it } from "vitest";
import {
  getOpenFiscalYearStructuralReasons,
  shouldReportCanonicalCoverageDriftIssue,
} from "./canonicalCoverageDriftPolicy.js";
import type { CanonicalCoverageDriftIssue } from "./canonicalCoverageReport.js";

function issue(
  fiscalYear: string,
  kind: CanonicalCoverageDriftIssue["kind"],
  detail: Record<string, unknown>,
): CanonicalCoverageDriftIssue {
  return {
    kind,
    fiscalYear,
    stateCanon: "MAHARASHTRA",
    customer: "Example Customer",
    detail,
  };
}

describe("open-FY canonical coverage drift policy", () => {
  it("suppresses a same-head, same-customer, same-date net-only difference in the open FY", () => {
    const valueOnly = issue("2026-27", "coverage-mismatch", {
      difference: { customerCount: 0, netAmount: 44_372, effectiveFromDays: 0, effectiveToDays: 0 },
      structural: { currentPersonName: "Lalan Kumar", persistedPersonName: "Lalan Kumar" },
    });

    expect(getOpenFiscalYearStructuralReasons(valueOnly)).toEqual([]);
    expect(shouldReportCanonicalCoverageDriftIssue(valueOnly)).toBe(false);
  });

  it("reports a customer moved between heads in the open FY", () => {
    const movedCustomer = issue("2026-27", "evidence-mismatch", {
      structural: {
        headChanged: true,
        customerPresenceChanged: false,
        currentPersonName: "New Head",
        persistedPersonName: "Prior Head",
      },
      difference: { netAmount: 0, fiscalYearChanged: false },
    });

    expect(getOpenFiscalYearStructuralReasons(movedCustomer)).toEqual(["customer-head-changed"]);
    expect(shouldReportCanonicalCoverageDriftIssue(movedCustomer)).toBe(true);
  });

  it("reports a null-to-date effective range change in the open FY", () => {
    const endedCoverage = issue("2026-27", "coverage-mismatch", {
      difference: {
        customerCount: 0,
        netAmount: 0,
        effectiveFromChanged: false,
        effectiveToChanged: true,
        effectiveToDays: null,
      },
      structural: { currentPersonName: "Lalan Kumar", persistedPersonName: "Lalan Kumar" },
    });

    expect(getOpenFiscalYearStructuralReasons(endedCoverage)).toEqual(["effective-date-range-changed"]);
    expect(shouldReportCanonicalCoverageDriftIssue(endedCoverage)).toBe(true);
  });

  it("keeps frozen FYs strict even when only net value changes", () => {
    const frozenValueOnly = issue("2025-26", "evidence-mismatch", {
      structural: {
        headChanged: false,
        customerPresenceChanged: false,
        currentPersonName: "Sandeep Dadheech",
        persistedPersonName: "Sandeep Dadheech",
      },
      difference: { netAmount: 38_810, fiscalYearChanged: false },
    });

    expect(getOpenFiscalYearStructuralReasons(frozenValueOnly)).toEqual([]);
    expect(shouldReportCanonicalCoverageDriftIssue(frozenValueOnly)).toBe(true);
  });
});