import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildDistributorDeepDiveExport,
  buildDistributorDeepDiveWorkbook,
} from "./distributorDeepDiveExport.js";
import type { DistributorDeepDiveResult } from "./distributorDeepDive.js";
import { CANONICAL_MASTER_CATEGORIES } from "./distributorSkuSpread.js";

function result(): DistributorDeepDiveResult {
  return {
    fy: "2026-27",
    stateHeads: ["Test Head"],
    distributors: [{
      name: "Test Distributor",
      normKey: "TEST DISTRIBUTOR",
      retailerCount: 2,
      activeCount: 1,
      dormantCount: 1,
      orderBooking: 1250000,
      sale: 900000,
      visits: 4,
      obSharePct: 10,
      isConcentrationRisk: false,
      confirmedCount: 1,
      guessedCount: 1,
      retailers: [{
        name: "Retailer One", district: "D", city: "C", orderBooking: 800000,
        sale: 600000, visits: 2, isActive: true, confirmedHead: true, memberName: "Member One",
      }],
      flows: {
        hasPrimaryData: true, primaryDispatch: 700000, primaryOb: 800000,
        pendingValue: 100000, fillRate: 87.5, matchedCustomers: ["Test Distributor"],
        secondaryOut: 900000, secondarySource: "member_sheets", flowGap: -200000,
        period: "FY 2026-27 YTD", lastInvoiceDate: "2026-07-31", daysSinceLastOrder: 10,
        invoiceCount: 4, monthsActive: 3, ordersPerMonth: 1.33, yoyPeriod: "Apr-Jul",
        currentPeriodDispatch: 700000, priorPeriodDispatch: 600000, growthPct: 16.7,
      },
      skuSpread: {
        isLiveYear: false, totalMasterCategories: 6, totalBroadSegments: 6,
        totalNet: 1234567, distinctBrands: 4, masterCategoriesCovered: 3,
        netByMasterCategory: CANONICAL_MASTER_CATEGORIES.map((segment, i) => ({ segment, net: i < 3 ? 100000 : 0, pct: i < 3 ? 33.3 : 0 })),
        netBySourceSegment: [{ segment: "CPVC DURALIFE", net: 100000, pct: 100, masterCategory: "PLUMBING" }],
      },
    }],
    sharedRetailers: [{
      name: "Shared Retailer", rawDistributor: "Test Distributor",
      distributorParts: ["Test Distributor"], orderBooking: 100, sale: 50, visits: null,
      isActive: true, confirmedHead: true, memberName: "Member One",
    }],
    directDealer: null,
    noneAssigned: null,
    mappingQuality: {
      totalRetailers: 2, blankCount: 0, noneCount: 1, sharedCount: 0, malformedCount: 0,
      distributorCount: 1, noneVisits: 0, totalVisits: 4, noneVisitSharePct: 0, noneAllDormant: false,
    },
    partyObTotal: 1250000,
    membersLoaded: 1,
    membersNotMapped: 0,
    membersFailed: 0,
    whitespace: null,
    concentration: null,
    capacityCheck: null,
    byState: [],
    perMember: [],
    unassignedCorrelation: null,
    namingCandidates: [{ a: "Test Distributor", b: "Test Distributer", normA: "TEST DISTRIBUTOR", normB: "TEST DISTRIBUTER", similarity: 0.8 }],
    error: null,
  };
}

describe("Distributor Deep Dive workbook", () => {
  it("builds the six sheets in the approved order with source-labelled metrics", async () => {
    const workbook = buildDistributorDeepDiveWorkbook({
      result: result(),
      directoryCount: 191,
      identityCount: 269,
      stateHead: "Test Head",
      geoLabel: "West",
      months: ["Apr-26", "May-26"],
      periodLabel: "Apr–May 2026",
      provisionalMonths: "June–September 2026 are provisional.",
      activeHolds: ["H1: pending hold"],
      selectedStates: ["West"],
    });
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      "Summary", "Detail", "Retailers", "Mapping", "Working detail", "Info",
    ]);
    expect(workbook.getWorksheet("Detail")!.getRow(3).values).toContain("PLUMBING NET");
    expect(workbook.getWorksheet("Detail")!.getRow(3).values).toContain("Legacy source evidence");
    expect(workbook.getWorksheet("Summary")!.getColumn(4).values).toContain(1250000);
    expect(workbook.getWorksheet("Summary")!.getColumn(4).values).not.toContain(900000);
    const info = workbook.getWorksheet("Info")!;
    const infoText = info.getRows(1, info.rowCount)!.flatMap((r) => r.values as unknown[]).map(String).join(" | ");
    expect(infoText).toContain("191 of 269");
    expect(infoText).toContain("provisional");
    expect(infoText).toContain("Booking terminology");
    const mappingText = workbook.getWorksheet("Mapping")!.getRows(1, workbook.getWorksheet("Mapping")!.rowCount)!
      .flatMap((r) => r.values as unknown[]).map(String).join(" | ");
    expect(mappingText).toContain("Whole-head diagnostic (not selected-scope)");
    expect(workbook.getWorksheet("Retailers")!.getRows(1, workbook.getWorksheet("Retailers")!.rowCount)!
      .flatMap((r) => r.values as unknown[]).map(String).join(" | ")).toContain("Shared Retailer");
  });

  it("serializes a valid xlsx with six sheets", async () => {
    const bytes = await buildDistributorDeepDiveExport({ result: result() });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.worksheets).toHaveLength(6);
    expect(workbook.getWorksheet("Summary")!.getRow(4).getCell(4).numFmt).toContain("₹");
  });
});