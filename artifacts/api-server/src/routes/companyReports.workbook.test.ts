import { beforeAll, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import type { CompanyReportsPayload } from "../lib/companyReports.js";

vi.mock("../lib/exportInfo.js", () => ({
  provisionalMonthsExportInfo: async () => "No primary-register months are currently provisional.",
}));

let buildWorkbook: typeof import("./companyReports.js").buildWorkbook;
let resolveCustomerDistricts: typeof import("../lib/companyReports.js").resolveCustomerDistricts;
let c1ExportDataEnabled: typeof import("../lib/companyReports.js").c1ExportDataEnabled;

function validationAddresses(sheet: ExcelJS.Worksheet): string[] {
  // ExcelJS keeps this runtime field on a private worksheet member but omits
  // it from the public Worksheet type; inspect it through a narrow boundary
  // cast rather than reaching for an unsupported property directly.
  const internal = sheet as unknown as {
    dataValidations?: { model?: Record<string, unknown> };
  };
  return Object.keys(internal.dataValidations?.model ?? {});
}

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://localhost/company-reports-workbook-test";
  ({ buildWorkbook } = await import("./companyReports.js"));
  ({ resolveCustomerDistricts, c1ExportDataEnabled } = await import("../lib/companyReports.js"));
});

function fixture(): CompanyReportsPayload {
  return {
    fy: "2026-27",
    priorFy: "2025-26",
    likeMonths: ["Apr-26"],
    likeMonthsPrior: ["Apr-25"],
    asOfDate: "2026-07-13",
    r1r2_byState: [
      { label: "BIHAR", thisFy: 125_794_611, lastFy: 102_379_178, diff: 23_415_433, growthPct: 22.9, sharePct: 62.5 },
      { label: "ASSAM", thisFy: 75_000_000, lastFy: 60_000_000, diff: 15_000_000, growthPct: 25, sharePct: 37.5 },
    ],
    c1_byState: [
      { label: "BIHAR", thisFy: 125_794_611, lastFy: 102_379_178, diff: 23_415_433, growthPct: 22.9, sharePct: 62.5 },
      { label: "ASSAM", thisFy: 75_000_000, lastFy: 60_000_000, diff: 15_000_000, growthPct: 25, sharePct: 37.5 },
    ],
    r1_partyByCustomer: [
      { customer: "Party A", state: "BIHAR", head: "Head", district: "Patna", thisFy: 1_200_000, lastFy: 1_000_000, diff: 200_000 },
      { customer: "Party B", state: "ASSAM", head: "Head", district: "Guwahati", thisFy: 900_000, lastFy: 700_000, diff: 200_000 },
      { customer: "Party C", state: "ASSAM", head: "Head", district: "Dibrugarh", thisFy: 800_000, lastFy: 600_000, diff: 200_000 },
    ],
    r2_byStateMonth: [
      { state: "BIHAR", month: "Apr-26", thisFy: 1_200_000, lastFy: 1_000_000 },
      { state: "BIHAR", month: "May-26", thisFy: null, lastFy: 500_000 },
      { state: "ASSAM", month: "Apr-26", thisFy: 900_000, lastFy: 700_000 },
    ],
    r2_byPartyMonth: [
      { state: "BIHAR", customer: "Party A", district: "Patna", months: [
        { month: "Apr-26", thisFy: 1_200_000, lastFy: 1_000_000 },
        { month: "May-26", thisFy: null, lastFy: 500_000 },
      ] },
      { state: "ASSAM", customer: "Party B", district: "Guwahati", months: [{ month: "Apr-26", thisFy: 900_000, lastFy: 700_000 }] },
      { state: "ASSAM", customer: "Party C", district: "Dibrugarh", months: [{ month: "Apr-26", thisFy: 800_000, lastFy: 600_000 }] },
    ],
    r3_byGroup: [], r3a_byStateGroup: [], r3b_byPartyGroup: [], r3c_byGroupFull: [],
    r4_byGroupQty: [], r5_byCustomer: [], r5_collectionNote: "Source note",
    r6_byGroupFull: [],
    r7_asOf: { date: "2026-07-13", total: 1_200_000, byGroup: [], byState: [], invoiceCount: 1, customerCount: 1, note: "Source note" },
    monthlyPrimary: [],
  };
}

describe("Company Reports C1 workbook", () => {
  it("separates the sales-head workbook from working-data helpers", async () => {
    const wb = await buildWorkbook(fixture(), { states: ["BIHAR"] });
    const names = wb.worksheets.map((sheet) => sheet.name);
    expect(names).toEqual([
      "Info", "Report 1", "Report 2", "R3 By Group", "R3A State x Group",
      "R3B Party x Group", "R4 Quantity", "R5 By Customer", "R6 By Group (full prior)",
    ]);
    expect(names).not.toContain("R1-R2 Sale by State");
    expect(names).not.toContain("Export Data R1");
    expect(names).not.toContain("Export Data R2");
    expect(names).not.toContain("R7 As-of Snapshot");
  });

  it("places totals above headers, uses dropdowns, formulas, and formats", async () => {
    const wb = await buildWorkbook(fixture(), { states: ["BIHAR"] });
    const report1 = wb.getWorksheet("Report 1")!;
    const report2 = wb.getWorksheet("Report 2")!;
    expect(report1.getCell("A3").value).toBe("Grand Total / State");
    expect(report1.getCell("B3").value).toMatchObject({ formula: expect.stringContaining("SUM(C5") });
    expect(report1.getCell("G3").value).toBe("BIHAR");
    expect(validationAddresses(report1)).toHaveLength(0);
    expect(report1.getCell("B5").numFmt).toContain("#,##,##");
    expect(report1.getCell("E5").numFmt).toContain("%");
    expect(report2.getCell("A2").value).toBe("Grand Total / State");
    expect(report2.getCell("B2").value).toMatchObject({ formula: expect.stringContaining("SUM(C4") });
    expect(validationAddresses(report2)).toHaveLength(0);
    expect(report2.getCell("I2").value).toBeDefined();
  });

  it("leaves future month triplets blank and records source/decision notes", async () => {
    const wb = await buildWorkbook(fixture(), { states: ["BIHAR"] });
    const report2 = wb.getWorksheet("Report 2")!;
    // Apr is populated; future months are not rendered in the selected period.
    expect(report2.getCell("I2").value).toBe(1_000_000);
    expect(report2.columnCount).toBeLessThan(47);
    const info = wb.getWorksheet("Info")!;
    const notes = info.getColumn(2).values.map((value) => String(value ?? ""));
    expect(notes.some((value) => value.includes("customer_master"))).toBe(true);
    expect(notes.some((value) => value.includes("Water Tank"))).toBe(true);
  });

  it("uses bounded nth-match formulas so a second state is contiguous", async () => {
    const wb = await buildWorkbook(fixture(), { states: ["ASSAM"] });
    const report1 = wb.getWorksheet("Report 1")!;
    const report2 = wb.getWorksheet("Report 2")!;
    const report1PartyFormula = String((report1.getCell("H5").value as { formula?: string } | null)?.formula);
    const report2PartyFormula = String((report2.getCell("G4").value as { formula?: string } | null)?.formula);
    expect(report1PartyFormula).toBe("undefined");
    expect(report2PartyFormula).toBe("undefined");
    expect(report1.getCell("H5").value).toBe("Party B");
    expect(report2.getCell("G4").value).toBe("Party B");
    expect(wb.getWorksheet("Export Data R1")).toBeUndefined();
    expect(wb.getWorksheet("Export Data R2")).toBeUndefined();
  });

  it("resolves only unique nonblank normalized districts", () => {
    const districts = resolveCustomerDistricts([
      { company: " Party A ", district: "Patna" },
      { company: "PARTY  A", district: "Patna" },
      { company: "Party B", district: "One" },
      { company: "party b", district: "Two" },
      { company: "Party C", district: null },
    ]);
    expect(districts.get("PARTY A")).toBe("Patna");
    expect(districts.has("PARTY B")).toBe(false);
    expect(districts.has("PARTY C")).toBe(false);
  });

  it("keeps the default web mode free of C1 data work", () => {
    expect(c1ExportDataEnabled()).toBe(false);
    expect(c1ExportDataEnabled({ includeC1ExportData: false })).toBe(false);
    expect(c1ExportDataEnabled({ includeC1ExportData: true })).toBe(true);
  });

  it("preserves C1 structure, cached values, blanks, and notes after XLSX serialization", async () => {
    const wb = await buildWorkbook(fixture(), { states: ["BIHAR"] });
    const buffer = await wb.xlsx.writeBuffer();
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer as unknown as Parameters<typeof reloaded.xlsx.load>[0]);
    expect(reloaded.worksheets.map((sheet) => sheet.name))
      .toEqual(["Info", "Report 1", "Report 2", "R3 By Group", "R3A State x Group", "R3B Party x Group", "R4 Quantity", "R5 By Customer", "R6 By Group (full prior)"]);
    expect(reloaded.getWorksheet("Export Data R1")).toBeUndefined();
    expect(reloaded.getWorksheet("Export Data R2")).toBeUndefined();
    const report1 = reloaded.getWorksheet("Report 1")!;
    const report2 = reloaded.getWorksheet("Report 2")!;
    expect(validationAddresses(report1)).toHaveLength(0);
    expect(validationAddresses(report2)).toHaveLength(0);
    expect(String((report1.getCell("G5").value ?? "")).length).toBeGreaterThan(0);
    expect(report2.getCell("G4").value).toBe("Party A");
    expect(report1.getCell("H5").value).toBe("Party A");
    expect(report1.getCell("H6").value ?? "").toBe("");
    expect(report2.getCell("I2").value).toBe(1_000_000);
    expect(report2.getCell("G5").value ?? "").toBe("");
    for (const sheet of reloaded.worksheets) {
      sheet.eachRow((row) => row.eachCell((cell) => {
        const value = cell.value;
        if (value && typeof value === "object" && "formula" in value) {
          expect(String((value as { formula?: string }).formula)).not.toContain("Export Data");
        }
      }));
    }
    for (const sheet of reloaded.worksheets) {
      expect(validationAddresses(sheet)).toHaveLength(0);
    }
    const infoText = reloaded.getWorksheet("Info")!.getColumn(2).values.map((value) => String(value ?? "")).join("\n");
    expect(infoText).toContain("1,000");
    expect(infoText).toContain("sale_line");
    expect(infoText).toContain("Water Tank");
  });

  it("caps each state independently without losing a second state's details", async () => {
    const many = Array.from({ length: 1_001 }, (_, index) => ({
      customer: `Party A ${index}`,
      state: "BIHAR",
      head: "Head",
      district: "Patna",
      thisFy: 100,
      lastFy: 50,
      diff: 50,
    }));
    const small = {
      customer: "Party B",
      state: "ASSAM",
      head: "Head",
      district: "Guwahati",
      thisFy: 200,
      lastFy: 100,
      diff: 100,
    };
    const base = fixture();
    const large = {
      ...base,
      r1_partyByCustomer: [...many, small],
      r2_byPartyMonth: [...many, small].map((row) => ({
        state: row.state,
        customer: row.customer,
        district: row.district,
        months: [{ month: "Apr-26", thisFy: row.thisFy, lastFy: row.lastFy }],
      })),
    };
    const first = await buildWorkbook(large, { states: ["BIHAR"] });
    const firstReport = first.getWorksheet("Report 1")!;
    expect(firstReport.getRow(1004).getCell(8).value).toBeDefined();
    expect(firstReport.getRow(1005).getCell(8).value).toBeNull();
    const firstReport2 = first.getWorksheet("Report 2")!;
    expect(firstReport2.getRow(1003).getCell(7).value).toBeDefined();
    expect(firstReport2.getRow(1004).getCell(7).value).toBeNull();
    expect(first.getWorksheet("Export Data R1")).toBeUndefined();
    const second = await buildWorkbook(large, { states: ["ASSAM"] });
    expect(second.getWorksheet("Report 1")!.getCell("H5").value).toBe("Party B");
    expect(second.getWorksheet("Report 1")!.getRow(6).getCell(7).value ?? "").toBe("");
  });
});