import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildDeepDiveExport,
  buildDeepDiveWorkbook,
  type DeepDiveExportInput,
} from "./deepDiveExport.js";
import type { MemberKpis } from "./deepDiveData.js";

function fixture(overrides: Partial<MemberKpis> = {}): MemberKpis {
  return {
    stateHead: "Test Head",
    name: "Monmon Paul",
    normKey: "monmon paul",
    hq: "HQ",
    designation: "Sales",
    contact: "000",
    primaryTarget: 100,
    secondaryTarget: 200,
    monthlyTarget: 50,
    primaryTargetMonthly: 10,
    secondaryTargetMonthly: 40,
    totalTargetToDate: 300,
    elapsedMonths: 6,
    elapsedMonthsFromSheet: 6,
    isLeft: false,
    orderBooking: 80,
    directDealersOrder: 20,
    newPartyOrderBooking: 10,
    sale: 90,
    achievementPct: 30,
    saleSource: "state_head_dashboard_data_tab",
    achievementSecondary: 40,
    achievementDirectDealer: 20,
    achievementTotal: 36.666666,
    achievementSale: 30,
    lastYearQ1: null,
    lastYearQ2: null,
    lastYearQ3: null,
    lastYearQ4: null,
    ctcMonthly: 0,
    ctcAnnual: 0,
    taBillStCost: null,
    costRatio: null,
    workingDaysActual: 0,
    totalOldRetailers: null,
    visitedRetailers: 0,
    nonVisitedRetailers: null,
    businessPerRetailer: null,
    totalRetailers: 0,
    directDealersCount: null,
    totalVisitsYtd: 0,
    extra: {},
    ...overrides,
  };
}

function input(overrides: Partial<DeepDiveExportInput> = {}): DeepDiveExportInput {
  return {
    fy: "2026-27",
    kpis: fixture(),
    monthlyRows: [],
    generatedAt: new Date("2026-08-01T00:00:00.000Z"),
    dataReadAt: Date.parse("2026-08-01T01:00:00.000Z"),
    provisionalMonths: "May 2026 is provisional and may change until it closes.",
    ...overrides,
  };
}

describe("Sales Deep Dive workbook builder", () => {
  it("serializes the Monmon no-monthly fixture without subordinate data", async () => {
    const bytes = await buildDeepDiveExport(input());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      "Info", "Summary", "Targets and achievement", "Coverage and visits",
      "Cost", "Missing Data",
    ]);
    const missing = workbook.getWorksheet("Missing Data")!;
    expect(missing.getColumn(2).values).toContain(
      "No monthly rows in secondary_head_month for this member. Monthly breakdown unavailable.",
    );
    expect(missing.getColumn(2).values).not.toContain("Subordinate");
    expect((workbook.getWorksheet("Info")!.views[0] as { ySplit?: number }).ySplit).toBe(2);
    expect(workbook.getWorksheet("Info")!.getColumn(1).values).toContain("Sale source");
    expect(workbook.getWorksheet("Info")!.getColumn(1).values).toContain("SKU / win-back source");
  });

  it("includes only the selected member's monthly rows and preserves zero/blank states", () => {
    const workbook = buildDeepDiveWorkbook(input({
      monthlyRows: [
        { monthLabel: "Apr-26", monthIdx: 0, planAmount: 100, orderedAmount: 0, receivedAmount: 40, achievementPct: 0.4, notYetRecorded: false },
        { monthLabel: "May-26", monthIdx: 1, planAmount: 100, orderedAmount: 250, receivedAmount: null, achievementPct: null, notYetRecorded: true },
      ],
    }));
    expect(workbook.worksheets.map((ws) => ws.name)).toContain("Monthly");
    const monthly = workbook.getWorksheet("Monthly")!;
    expect(monthly.getCell("B3").value).toBe(100);
    expect(monthly.getCell("C3").value).toBe(0);
    expect(monthly.getCell("D3").value).toBe(40);
    expect(monthly.getCell("E3").value).toBe(0.4);
    expect(monthly.getCell("E3").numFmt).toBe("0.00%");
    expect(monthly.getCell("B4").value).toBe(100);
    expect(monthly.getCell("C4").value).toBe(250);
    expect(monthly.getCell("D4").value).toBeNull();
    expect(monthly.getCell("E4").value).toBeNull();
    expect(monthly.getCell("C4").fill).not.toMatchObject({ fgColor: { argb: "FFE7E7E7" } });
    expect(monthly.getCell("B4").fill).not.toMatchObject({ fgColor: { argb: "FFE7E7E7" } });
    const targets = workbook.getWorksheet("Targets and achievement")!;
    // OB + new-party OB + DD OB = 80 + 10 + 20, not 80 + 20.
    expect(targets.getCell("C15").value).toBe(110);
    expect(targets.getCell("D15").value).toBe(300);
    expect(targets.getCell("E15").value).toBeCloseTo(0.36666666, 6);
    expect(targets.getCell("F3").value).toBe("value");
    expect(workbook.getWorksheet("Coverage and visits")!.getCell("B6").value).toBe(0);
    expect(workbook.getWorksheet("Summary")!.getCell("A10").value).toBe("Secondary OB achievement");
    expect(workbook.getWorksheet("Summary")!.getCell("A13").value).toBe("Sales achievement");
    expect(workbook.getWorksheet("Coverage and visits")!.getCell("A8").value).toBe("New-party order booking");
  });

  it("keeps period restriction explicit and renders all three Indian money scales", async () => {
    const workbook = buildDeepDiveWorkbook(input({
      periodMonths: [2],
      monthlyRows: [
        { monthLabel: "Apr-26", monthIdx: 0, planAmount: 100, orderedAmount: 100, receivedAmount: 100, achievementPct: 1, notYetRecorded: false },
      ],
      kpis: fixture({
        primaryTarget: 12_345_678,
        secondaryTarget: 123_456,
        monthlyTarget: 99_999,
        totalTargetToDate: 99_999,
      }),
    }));
    const monthly = workbook.getWorksheet("Monthly")!;
    expect(monthly.getCell("A3").value).toBe("No rows in selected period");
    expect(monthly.getCell("F3").value).toContain("selected period");
    const summary = workbook.getWorksheet("Summary")!;
    expect((summary.getCell("B3").value as { formula: string; result: number }).formula).toBe("12345678/10000000");
    expect((summary.getCell("B3").value as { result: number }).result).toBeCloseTo(1.2345678);
    expect((summary.getCell("B4").value as { formula: string; result: number }).formula).toBe("123456/100000");
    expect((summary.getCell("B4").value as { result: number }).result).toBeCloseTo(1.23456);
    expect(summary.getCell("B5").value).toBe(99_999);
    expect(summary.getCell("B5").numFmt).toContain("#,##,##0");
    // Genuine zero remains a literal numeric zero rather than a blank/formula.
    expect(workbook.getWorksheet("Cost")!.getCell("B3").value).toBe(0);
    const bytes = await buildDeepDiveExport(input({ kpis: fixture({ primaryTarget: 10_000_000 }) }));
    const reload = new ExcelJS.Workbook();
    await reload.xlsx.load(bytes as unknown as Parameters<typeof reload.xlsx.load>[0]);
    expect((reload.getWorksheet("Summary")!.getCell("B3").value as { formula: string }).formula).toBe("10000000/10000000");
    expect((reload.getWorksheet("Summary")!.getCell("B3").value as { result: number }).result).toBe(1);
  });

  it("preserves a legacy snapshot sale without falsely calling it unavailable", () => {
    const workbook = buildDeepDiveWorkbook(input({
      kpis: fixture({ sale: 90, saleSource: undefined }),
      fromDbSnapshot: true,
    }));
    const info = workbook.getWorksheet("Info")!;
    const saleSourceRow = info.getRows(3, info.rowCount - 2)!
      .find((row) => row.getCell(1).value === "Sale source");
    expect(saleSourceRow?.getCell(2).value).toContain(
      "legacy Deep Dive snapshot",
    );
    expect(saleSourceRow?.getCell(2).value).not.toContain(
      "unavailable from both",
    );
  });
});