import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildCustomerExportWorkbook,
  customerExportEvidence,
} from "./customerExport.js";

describe("Organisation Customers export", () => {
  it("builds exactly four sheets and records Info evidence", async () => {
    const workbook = buildCustomerExportWorkbook({
      customers: [{
        customerId: "DIST#2",
        name: "Mapped Distributor",
        type: "distributor",
        distNumber: "DIST#2",
        cpCode: "DIST#2",
        stateHeadName: "Head A",
        memberName: "Member A",
        stateName: "Bihar",
        linked: true,
        confidence: "confirmed",
        source: "import",
        primarySalesValue: 0,
        orderBookingValue: null,
      }],
      unassigned: [
        {
          customerId: "DIST#1",
          name: "Largest coded distributor",
          type: "distributor",
          distNumber: "DIST#1",
          stateName: "Bihar",
          orderBookingValue: "1250000",
        },
        {
          customerId: "RET#1",
          name: "Genuinely zero retailer",
          type: "retailer",
          orderBookingValue: 0,
        },
        {
          customerId: "RET#2",
          name: "Value unavailable retailer",
          type: "retailer",
          orderBookingValue: null,
        },
      ],
      reviewQueue: [{
        queueId: 7,
        name: "Proposed retailer",
        type: "retailer",
        status: "pending",
        reason: "awaiting review",
      }],
      filters: { tab: "unassigned", type: "all" },
      generatedAt: "2026-09-14T10:00:00.000Z",
    });

    expect(customerExportEvidence(workbook)).toEqual({
      sheetCount: 4,
      sheets: [
        { name: "Customers", rows: 1 },
        { name: "Unassigned", rows: 3 },
        { name: "Review queue", rows: 1 },
        { name: "Info", rows: 16 },
      ],
      infoGenerated: true,
    });

    const unassigned = workbook.getWorksheet("Unassigned")!;
    expect(unassigned.getCell("A2").value).toBe("DIST#1");
    expect(unassigned.getCell("O2").value).toBe(1_250_000);
    expect(unassigned.getCell("T2").value).toBe("value");
    expect(unassigned.getCell("V2").value).toBe("value");
    expect(unassigned.getCell("O3").value).toBe(0);
    expect(unassigned.getCell("T3").value).toBe("zero");
    expect(unassigned.getCell("U3").value).toBe("Genuine zero in source");
    expect(unassigned.getCell("O4").value).toBeNull();
    expect(unassigned.getCell("O4").fill).toMatchObject({
      type: "pattern",
      fgColor: { argb: "FFE5E7EB" },
    });
    expect(unassigned.getCell("T4").value).toBe("unavailable");
    expect(unassigned.getCell("U4").value).toBe("No matching secondary_order_line booking value");
    expect(unassigned.getCell("V4").value).toBe("unavailable");
    expect(unassigned.getCell("W4").value).toBe("No primary sales or order-booking value available");
    expect(unassigned.getCell("Q4").value).toBe("no head; no state; no code");

    const info = workbook.getWorksheet("Info")!;
    const infoText = [info.getColumn(1), info.getColumn(2)]
      .flatMap((column) => column.values.map((value) => String(value ?? ""))).join("\n");
    expect(infoText).toContain("Link indicator");
    expect(infoText).toContain("Three-state figures");
    expect(infoText).toContain("numeric 0 is a genuine zero");
    expect(infoText).toContain("secondary_order_line.basic_order_value");
  });

  it("keeps sheet count and Info evidence after XLSX serialization", async () => {
    const workbook = buildCustomerExportWorkbook({
      customers: [],
      unassigned: [],
      reviewQueue: [],
      filters: {},
      generatedAt: "2026-09-14T10:00:00.000Z",
    });
    const bytes = await workbook.xlsx.writeBuffer();
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(bytes as unknown as Parameters<typeof reloaded.xlsx.load>[0]);
    const evidence = customerExportEvidence(reloaded);
    expect(evidence.sheetCount).toBe(4);
    expect(evidence.sheets.map((sheet) => sheet.name)).toEqual([
      "Customers", "Unassigned", "Review queue", "Info",
    ]);
    expect(evidence.infoGenerated).toBe(true);
  });
});