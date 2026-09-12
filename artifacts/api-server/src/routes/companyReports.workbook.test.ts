import { beforeAll, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import type { CompanyReportsPayload } from "../lib/companyReports.js";

vi.mock("../lib/exportInfo.js", () => ({
  provisionalMonthsExportInfo: async () => "No primary-register months are currently provisional.",
}));

let buildWorkbook: typeof import("./companyReports.js").buildWorkbook;
let resolveCustomerDistricts: typeof import("../lib/companyReports.js").resolveCustomerDistricts;
let c1ExportDataEnabled: typeof import("../lib/companyReports.js").c1ExportDataEnabled;

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
  it("separates Report 1 and Report 2 and keeps helpers hidden", async () => {
    const wb = await buildWorkbook(fixture(), { states: ["BIHAR"] });
    const names = wb.worksheets.map((sheet) => sheet.name);
    expect(names.slice(0, 3)).toEqual(["Info", "Report 1", "Report 2"]);
    expect(names).not.toContain("R1-R2 Sale by State");
    expect(wb.getWorksheet("Export Data R1")?.state).toBe("veryHidden");
    expect(wb.getWorksheet("Export Data R2")?.state).toBe("veryHidden");
  });

  it("places totals above headers, uses dropdowns, formulas, and formats", async () => {
    const wb = await buildWorkbook(fixture(), { states: ["BIHAR"] });
    const report1 = wb.getWorksheet("Report 1")!;
    const report2 = wb.getWorksheet("Report 2")!;
    expect(report1.getCell("B3").value).toBeNull();
    expect(report1.getCell("C3").value).toMatchObject({ formula: expect.stringContaining("SUM(C5") });
    expect(report1.getCell("J3").value).toBe("BIHAR");
    expect(report1.getCell("J3").dataValidation?.type).toBe("list");
    expect(report1.getCell("C5").numFmt).toContain("#,##,##");
    expect(report1.getCell("F5").numFmt).toContain("%");
    expect(report2.getCell("B2").value).toBeNull();
    expect(report2.getCell("C2").value).toMatchObject({ formula: expect.stringContaining("SUM(C4") });
    expect(report2.getCell("K2").dataValidation?.type).toBe("list");
    expect(report2.getCell("L2").value).toMatchObject({ formula: expect.stringContaining("COUNTIFS") });
  });

  it("leaves future month triplets blank and records source/decision notes", async () => {
    const wb = await buildWorkbook(fixture(), { states: ["BIHAR"] });
    const report2 = wb.getWorksheet("Report 2")!;
    // Apr is populated; May is not in the complete-month payload.
    expect((report2.getCell("L2").value as { result?: unknown }).result).toBe(1_000_000);
    expect((report2.getCell("O2").value as { result?: unknown }).result ?? "").toBe("");
    expect((report2.getCell("P2").value as { result?: unknown }).result ?? "").toBe("");
    expect((report2.getCell("O4").value as { result?: unknown }).result ?? "").toBe("");
    expect((report2.getCell("P4").value as { result?: unknown }).result ?? "").toBe("");
    expect((report2.getCell("R4").value as { result?: unknown }).result ?? "").toBe("");
    expect((report2.getCell("S4").value as { result?: unknown }).result ?? "").toBe("");
    expect((report2.getCell("Q2").value as { result?: unknown }).result ?? "").toBe("");
    const info = wb.getWorksheet("Info")!;
    const notes = info.getColumn(2).values.map((value) => String(value ?? ""));
    expect(notes.some((value) => value.includes("customer_master"))).toBe(true);
    expect(notes.some((value) => value.includes("Water Tank"))).toBe(true);
  });

  it("uses bounded nth-match formulas so a second state is contiguous", async () => {
    const wb = await buildWorkbook(fixture(), { states: ["ASSAM"] });
    const report1 = wb.getWorksheet("Report 1")!;
    const report2 = wb.getWorksheet("Report 2")!;
    const report1PartyFormula = String((report1.getCell("K5").value as { formula?: string }).formula);
    const report2PartyFormula = String((report2.getCell("J4").value as { formula?: string }).formula);
    expect(report1PartyFormula).toContain("INDEX");
    expect(report1PartyFormula).toContain("AGGREGATE");
    expect(report1PartyFormula).toContain("$J$3");
    expect(report1PartyFormula).not.toContain("IF($J$3='Export Data R1'!$D$2");
    expect(report2PartyFormula).toContain("INDEX");
    expect(report2PartyFormula).toContain("AGGREGATE");
    expect(report2PartyFormula).toContain("$K$2");
    expect(report2PartyFormula).not.toContain("IF($K$2='Export Data R2'!$G$2");
    expect((report1.getCell("K5").value as { result?: unknown }).result).toBe("Party B");
    expect((report2.getCell("J4").value as { result?: unknown }).result).toBe("Party B");
    expect(wb.getWorksheet("Export Data R1")?.state).toBe("veryHidden");
    expect(wb.getWorksheet("Export Data R2")?.state).toBe("veryHidden");
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
    expect(reloaded.worksheets.slice(0, 3).map((sheet) => sheet.name))
      .toEqual(["Info", "Report 1", "Report 2"]);
    expect(reloaded.getWorksheet("Export Data R1")?.state).toBe("veryHidden");
    expect(reloaded.getWorksheet("Export Data R2")?.state).toBe("veryHidden");
    const report1 = reloaded.getWorksheet("Report 1")!;
    const report2 = reloaded.getWorksheet("Report 2")!;
    expect(report1.getCell("J3").dataValidation?.type).toBe("list");
    expect(report2.getCell("K2").dataValidation?.type).toBe("list");
    expect(String((report1.getCell("K5").value as { formula?: string }).formula)).toContain("AGGREGATE");
    expect(String((report1.getCell("K6").value as { formula?: string }).formula)).toContain("AGGREGATE");
    expect(String((report2.getCell("L2").value as { formula?: string }).formula)).toContain("COUNTIFS");
    expect(String((report2.getCell("J5").value as { formula?: string }).formula)).toContain("AGGREGATE");
    expect((report1.getCell("K5").value as { result?: unknown }).result).toBe("Party A");
    expect((report1.getCell("K6").value as { result?: unknown }).result ?? "").toBe("");
    expect((report2.getCell("L2").value as { result?: unknown }).result).toBe(1_000_000);
    expect((report2.getCell("J5").value as { result?: unknown }).result ?? "").toBe("");
    expect((report2.getCell("O2").value as { result?: unknown }).result ?? "").toBe("");
    expect((report2.getCell("P2").value as { result?: unknown }).result ?? "").toBe("");
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
    expect(firstReport.getRow(1004).getCell(11).value).toBeDefined();
    expect(firstReport.getRow(1005).getCell(11).value).toBeNull();
    const firstReport2 = first.getWorksheet("Report 2")!;
    expect(firstReport2.getRow(1003).getCell(10).value).toBeDefined();
    expect(firstReport2.getRow(1004).getCell(10).value).toBeNull();
    expect(first.getWorksheet("Export Data R1")!.rowCount).toBe(1_002);
    const second = await buildWorkbook(large, { states: ["ASSAM"] });
    expect((second.getWorksheet("Report 1")!.getCell("K5").value as { result?: unknown }).result).toBe("Party B");
    expect(String((second.getWorksheet("Report 1")!.getRow(6).getCell(11).value as { formula?: string }).formula)).toContain("AGGREGATE");
    expect((second.getWorksheet("Report 1")!.getRow(6).getCell(11).value as { result?: unknown }).result ?? "").toBe("");
  });
});