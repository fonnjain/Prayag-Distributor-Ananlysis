import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildCanonicalCoverageWorkbook,
  type CanonicalCoverageReport,
} from "./canonicalCoverageReport.js";

function reportFixture(): CanonicalCoverageReport {
  return {
    passed: true,
    fy: "2025-26",
    reconciliation: { archivedLegacyRows: 0, canonicalCoverageRows: 0, mappingRows: 0, unmappedLegacyRows: 0 },
    sales: { expectedNet: 0, beforeNet: 0, afterNet: 0, variances: [] },
    zeroSalesLeaves: [],
    multiHeadLeaves: [],
    tamilNaduHandover: [],
    tamilNaduCoverageHandover: [],
    duplicateTerritoriesRemaining: [],
    nonAssignableCoverage: [],
    unassignedCoverage: [],
    hiteshRegisterRows: 0,
    derivedCoverage: [],
    uncoveredGaps: [],
    derivedIntegrity: {
      attributionIssues: 0,
      coverageMismatches: 0,
      evidenceMismatches: 0,
      punjabGapMatches: true,
    },
    mappings: [],
    reviewWarnings: {
      coverageIsReadOnly: true,
      unverifiedAliases: [],
      concentrationWarnings: [{
        state_canon: "TAMIL NADU",
        fiscal_years: ["2023-24", "2024-25"],
        responsible_head: "Sandeep Dadheech",
        coverage_person: "Taninki Ramesh Babu",
        register_head_labels: ["Historical Babu label"],
        coverage_rows: 2,
        customer_count: 27,
        net_amount: 102_966_864.06,
        message: "Review required; coverage was not changed.",
      }],
    },
  };
}

describe("canonical coverage review workbook", () => {
  it("uses registry-derived concentration labels in the review worksheet", async () => {
    const buffer = await buildCanonicalCoverageWorkbook(reportFixture());
    const workbook = new ExcelJS.Workbook();
    const data = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(data).set(buffer);
    await workbook.xlsx.load(data);
    const worksheet = workbook.getWorksheet("Coverage review warnings");

    expect(worksheet).toBeDefined();
    expect(worksheet?.getRow(2).getCell(6).value).toBe("Historical Babu label");
    expect(worksheet?.getRow(2).getCell(9).value).toBe("Review required; coverage was not changed.");
  });
});