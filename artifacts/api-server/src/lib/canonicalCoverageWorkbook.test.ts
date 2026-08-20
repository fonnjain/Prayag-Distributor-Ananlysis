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
        fiscal_years: ["2025-26"],
        responsible_head: "Sandeep Dadheech",
        coverage_person: "Sandeep Dadheech",
        register_head_labels: [],
        coverage_rows: 1,
        customer_count: 1,
        net_amount: 94_025_777.70,
        customer_name: "GRAHAA PRIYA ENTERPRISES",
        state_net_amount: 94_025_777.70,
        share_percent: 100,
        message: "GRAHAA PRIYA ENTERPRISES accounts for 100.0% of Tamil Nadu coverage evidence.",
      }],
    },
  };
}

describe("canonical coverage review workbook", () => {
  it("includes alias-independent concentration evidence in the review worksheet", async () => {
    const buffer = await buildCanonicalCoverageWorkbook(reportFixture());
    const workbook = new ExcelJS.Workbook();
    const data = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(data).set(buffer);
    await workbook.xlsx.load(data);
    const worksheet = workbook.getWorksheet("Coverage review warnings");

    expect(worksheet).toBeDefined();
    expect(worksheet?.getRow(2).getCell(6).value).toBe("GRAHAA PRIYA ENTERPRISES");
    expect(worksheet?.getRow(2).getCell(9).value).toBe("GRAHAA PRIYA ENTERPRISES accounts for 100.0% of Tamil Nadu coverage evidence.");
  });
});