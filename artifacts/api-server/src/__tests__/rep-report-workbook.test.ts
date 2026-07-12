// Integration test for buildRepReportWorkbook: exercises every sheet builder
// in repReports.ts against a fixture DeepDive-shaped payload. No DB or Sheets
// connection required — the function is pure (ExcelJS only).
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { buildRepReportWorkbook } from "../lib/mgmt/repReports.js";
import type { SalesRepReport } from "../lib/mgmt/salesReports.js";

// -------------------------------------------------------------------------
// Fixture helpers
// -------------------------------------------------------------------------

function deepRow(
  label: string,
  thisFy = 1_000_000,
  lastFy = 900_000,
): import("../lib/mgmt/salespeople.js").DeepRow {
  const diff = thisFy - lastFy;
  return {
    label,
    thisFy,
    lastFy,
    diff,
    growthPct: lastFy > 0 ? (diff / lastFy) * 100 : null,
    sharePct: 25.0,
  };
}

function makeFixtureReport(): SalesRepReport {
  return {
    fy: "2026-27",
    priorFy: "2025-26",
    repKey: "test-rep",
    repName: "Test Rep",
    scope: "own",
    hasTeam: false,
    available: true,
    basis: "secondary",

    monthly: [
      { month: "Apr-26", orderAmount: 500_000, orders: 12, saleAmount: 450_000 },
      { month: "May-26", orderAmount: 600_000, orders: 15, saleAmount: 550_000 },
      { month: "Jun-26", orderAmount: 700_000, orders: 18, saleAmount: 650_000 },
    ],

    stateOptions: ["MADHYA PRADESH", "RAJASTHAN"],

    secondary: {
      tiles: {
        netOrderBooked: 1_800_000,
        netOrderBookedLast: 1_650_000,
        growthPct: 9.09,
        orders: 45,
        activeRetailers: 30,
        newRetailers: 5,
        avgOrderValue: 40_000,
        businessPerRetailer: 60_000,
        target: 2_000_000,
        achievementPct: 90.0,
      },
      byState: [
        deepRow("MADHYA PRADESH", 1_200_000, 1_000_000),
        deepRow("RAJASTHAN", 600_000, 650_000),
      ],
      partyByState: {
        "MADHYA PRADESH": [
          { id: "p1", name: "Party Alpha", amount: 700_000, priorAmount: 600_000 },
          { id: "p2", name: "Party Beta", amount: 500_000, priorAmount: 400_000 },
        ],
        "RAJASTHAN": [
          { id: "p3", name: "Party Gamma", amount: 600_000, priorAmount: 650_000 },
        ],
      },
      segmentByState: {
        "MADHYA PRADESH": [deepRow("HEALTH CARE", 900_000, 800_000)],
        "RAJASTHAN": [deepRow("NUTRACEUTICALS", 600_000, 650_000)],
      },
      byGroup: [
        deepRow("OTC", 1_000_000, 900_000),
        deepRow("ETHICAL", 800_000, 750_000),
      ],
      bySegment: [
        deepRow("HEALTH CARE", 900_000, 800_000),
        deepRow("NUTRACEUTICALS", 900_000, 850_000),
      ],
      parties: {
        top: [
          deepRow("Party Alpha", 700_000, 600_000),
          deepRow("Party Beta", 500_000, 400_000),
        ],
        newTop: [{ ...deepRow("Party New", 200_000, 0), growthPct: null }],
        churned: [{ ...deepRow("Party Gone", 0, 150_000), flag: "churned" as const }],
        newCount: 1,
        churnedCount: 1,
      },
      movers: {
        partiesUp: [deepRow("Party Alpha", 700_000, 600_000)],
        partiesDown: [deepRow("Party Beta", 500_000, 600_000)],
        segmentsUp: [deepRow("HEALTH CARE", 900_000, 800_000)],
        segmentsDown: [deepRow("NUTRACEUTICALS", 400_000, 450_000)],
      },
      saleCollection: { sale: 1_650_000, saleLast: 1_500_000, collection: null },
    },

    primary: {
      available: false,
      reason: "No primary data available for this rep.",
      headTotal: 0,
      bridgedToAnyTmAmount: 0,
      totalBridged: 0,
      bridgeCoverage: 0,
      bridgedParties: [],
      unbridgedParties: [],
      byItemCode: [],
    },

    reconciliation: {
      secondary: {
        repTotal: 1_800_000,
        fileTotal: 1_800_000,
        delta: 0,
        ok: true,
        note: "Cross-foot OK: rep total 18.00 L matches file total 18.00 L (delta 0)",
      },
      primary: {
        bridgedAmount: 0,
        unbridgedAmount: 0,
        headTotal: 0,
        delta: 0,
        ok: true,
        note: "Primary data not available.",
      },
    },
  };
}

function makePrimaryReport(): SalesRepReport {
  const base = makeFixtureReport();
  return {
    ...base,
    basis: "primary",
    primary: {
      available: true,
      headTotal: 2_000_000,
      bridgedToAnyTmAmount: 1_800_000,
      totalBridged: 1_800_000,
      bridgeCoverage: 0.9,
      bridgedParties: [
        { party: "Bridged Party A", amount: 1_100_000 },
        { party: "Bridged Party B", amount: 700_000 },
      ],
      unbridgedParties: [
        { party: "Unbridged Party X", amount: 200_000 },
      ],
      byItemCode: [
        { code: "PC001", description: "Product One", amount: 800_000 },
        { code: "PC002", description: "Product Two", amount: 600_000 },
        { code: "PC003", description: "Product Three", amount: 400_000 },
      ],
    },
    reconciliation: {
      ...base.reconciliation,
      primary: {
        bridgedAmount: 1_800_000,
        unbridgedAmount: 200_000,
        headTotal: 2_000_000,
        delta: 0,
        ok: true,
        note: "Cross-foot OK: bridged 18.00 L + unbridged 2.00 L = head total 20.00 L (delta 0)",
      },
    },
  };
}

// -------------------------------------------------------------------------
// Sheet name constants (what buildRepReportWorkbook must produce)
// -------------------------------------------------------------------------

const CORE_SHEETS = [
  "Cover",
  "Monthly Booking",
  "By State",
  "By Party",
  "By Segment",
  "Item Code",
  "By Group",
  "Parties",
  "Movers",
  "Sale & Collection",
];

// -------------------------------------------------------------------------
// Helpers to inspect the output workbook
// -------------------------------------------------------------------------

async function wbFromBuffer(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

function sheetNames(wb: ExcelJS.Workbook): string[] {
  return wb.worksheets.map((ws) => ws.name);
}

function rowCount(wb: ExcelJS.Workbook, name: string): number {
  const ws = wb.getWorksheet(name);
  if (!ws) return 0;
  let count = 0;
  ws.eachRow(() => { count++; });
  return count;
}

function cellValue(wb: ExcelJS.Workbook, name: string, row: number, col: number): ExcelJS.CellValue {
  const ws = wb.getWorksheet(name);
  return ws ? ws.getCell(row, col).value : null;
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe("buildRepReportWorkbook — secondary basis", () => {
  let wb: ExcelJS.Workbook;
  let buf: Buffer;

  it("builds without throwing", async () => {
    const report = makeFixtureReport();
    const result = await buildRepReportWorkbook(report, "secondary");
    buf = (await result.xlsx.writeBuffer()) as unknown as Buffer;
    wb = await wbFromBuffer(buf);
  });

  it("produces a non-zero xlsx buffer", () => {
    expect(buf.byteLength).toBeGreaterThan(1_000);
  });

  it("contains all 10 core sheet names in order", () => {
    const names = sheetNames(wb);
    for (const expected of CORE_SHEETS) {
      expect(names).toContain(expected);
    }
    expect(names.slice(0, CORE_SHEETS.length)).toEqual(CORE_SHEETS);
  });

  it("does not add Primary sheets when basis is secondary", () => {
    const names = sheetNames(wb);
    expect(names).not.toContain("Primary — Bridged");
    expect(names).not.toContain("Primary — Unbridged");
    expect(names).not.toContain("Primary Sale");
  });

  it("Cover sheet has the rep name in row 2", () => {
    const v = cellValue(wb, "Cover", 2, 2);
    expect(String(v)).toContain("Test Rep");
  });

  it("Cover sheet has the FY label in row 3", () => {
    const v = cellValue(wb, "Cover", 3, 2);
    expect(String(v)).toContain("2026-27");
  });

  it("Monthly Booking has header + 3 data rows + total row (5 rows)", () => {
    expect(rowCount(wb, "Monthly Booking")).toBe(5);
  });

  it("Monthly Booking first data row has correct month label", () => {
    expect(cellValue(wb, "Monthly Booking", 2, 1)).toBe("Apr-26");
  });

  it("By State has header + 2 data rows + total row (4 rows)", () => {
    expect(rowCount(wb, "By State")).toBe(4);
  });

  it("By Group has header + 2 data rows + total row (4 rows)", () => {
    expect(rowCount(wb, "By Group")).toBe(4);
  });

  it("By Segment has header + 2 data rows + total row (4 rows)", () => {
    expect(rowCount(wb, "By Segment")).toBe(4);
  });

  it("Item Code sheet has 'not available on Secondary' message", () => {
    const v = cellValue(wb, "Item Code", 2, 1);
    expect(String(v)).toMatch(/not available on Secondary/i);
  });

  it("By Party sheet has state header rows and party rows", () => {
    expect(rowCount(wb, "By Party")).toBeGreaterThan(4);
  });

  it("Parties sheet has section headers and party rows", () => {
    expect(rowCount(wb, "Parties")).toBeGreaterThan(5);
  });

  it("Movers sheet has section headers and mover rows", () => {
    expect(rowCount(wb, "Movers")).toBeGreaterThan(4);
  });

  it("Sale & Collection sheet has header + 2 rows (sale + collection)", () => {
    expect(rowCount(wb, "Sale & Collection")).toBeGreaterThanOrEqual(3);
  });

  it("reconciliation note appears on Cover", () => {
    const v = cellValue(wb, "Cover", 14, 3);
    expect(String(v)).toMatch(/cross-foot/i);
  });
});

describe("buildRepReportWorkbook — primary basis with primary data", () => {
  let wb: ExcelJS.Workbook;
  let buf: Buffer;

  it("builds without throwing", async () => {
    const report = makePrimaryReport();
    const result = await buildRepReportWorkbook(report, "primary");
    buf = (await result.xlsx.writeBuffer()) as unknown as Buffer;
    wb = await wbFromBuffer(buf);
  });

  it("produces a non-zero xlsx buffer", () => {
    expect(buf.byteLength).toBeGreaterThan(1_000);
  });

  it("contains all 10 core sheets plus the two Primary sheets", () => {
    const names = sheetNames(wb);
    for (const expected of CORE_SHEETS) {
      expect(names).toContain(expected);
    }
    expect(names).toContain("Primary — Bridged");
    expect(names).toContain("Primary — Unbridged");
  });

  it("Item Code sheet has 3 data rows + header + total (5 rows)", () => {
    expect(rowCount(wb, "Item Code")).toBe(5);
  });

  it("Primary — Bridged has header + 2 party rows + total (4 rows)", () => {
    expect(rowCount(wb, "Primary — Bridged")).toBe(4);
  });

  it("Primary — Unbridged has header + 1 party row + total (3 rows)", () => {
    expect(rowCount(wb, "Primary — Unbridged")).toBe(3);
  });
});

describe("buildRepReportWorkbook — primary basis without primary data", () => {
  let wb: ExcelJS.Workbook;

  it("builds without throwing", async () => {
    const report = makeFixtureReport();
    const result = await buildRepReportWorkbook(report, "primary");
    const buf = (await result.xlsx.writeBuffer()) as unknown as Buffer;
    wb = await wbFromBuffer(buf);
  });

  it("adds a 'Primary Sale' sheet with the unavailability message", () => {
    const names = sheetNames(wb);
    expect(names).toContain("Primary Sale");
    expect(names).not.toContain("Primary — Bridged");
  });

  it("Primary Sale sheet cell contains the reason text", () => {
    const v = cellValue(wb, "Primary Sale", 1, 1);
    expect(String(v)).toContain("No primary data available");
  });
});

describe("buildRepReportWorkbook — edge cases", () => {
  it("handles empty monthly array without throwing", async () => {
    const report: SalesRepReport = {
      ...makeFixtureReport(),
      monthly: [],
    };
    await expect(buildRepReportWorkbook(report, "secondary")).resolves.toBeInstanceOf(
      ExcelJS.Workbook,
    );
  });

  it("handles empty byState array without throwing", async () => {
    const report: SalesRepReport = {
      ...makeFixtureReport(),
      secondary: {
        ...makeFixtureReport().secondary,
        byState: [],
      },
    };
    await expect(buildRepReportWorkbook(report, "secondary")).resolves.toBeInstanceOf(
      ExcelJS.Workbook,
    );
  });

  it("handles empty partyByState without throwing", async () => {
    const report: SalesRepReport = {
      ...makeFixtureReport(),
      stateOptions: [],
      secondary: {
        ...makeFixtureReport().secondary,
        partyByState: {},
      },
    };
    await expect(buildRepReportWorkbook(report, "secondary")).resolves.toBeInstanceOf(
      ExcelJS.Workbook,
    );
  });

  it("handles team scope label on Cover", async () => {
    const report: SalesRepReport = {
      ...makeFixtureReport(),
      scope: "team",
      hasTeam: true,
    };
    const wb = await buildRepReportWorkbook(report, "secondary");
    const buf = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    const loaded = await wbFromBuffer(buf);
    const v = cellValue(loaded, "Cover", 3, 2);
    expect(String(v)).toContain("Own + Team");
  });
});
