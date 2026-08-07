// Acceptance tests for new-tab detection (pure functions — no Sheets, no DB):
//   • a simulated new tab named 'Sep' with the correct shape is PROPOSED,
//     never auto-included
//   • a simulated new tab named 'Scratch' is ignored
//   • Sheet11's real shape (Bill From / Item Code / Quantity / Taxable Value /
//     WEIGHT — no invoice number, no date) is IGNORED with the reason
//   • month names are matched by PARSING, not a hardcoded list
import { describe, expect, it } from "vitest";
import { classifyTabName, decideTabStatus, testRegisterShape } from "./tabAudit.js";
import type { CellValue } from "./normalize.js";

const NOW = new Date(Date.UTC(2026, 7, 7)); // 7 Aug 2026
const FY = "2026-27";

// Schema-A style month tab header: invoice no + date + taxable value present.
const MONTH_TAB_HEADER: CellValue[][] = [
  ["InvoiceNo", "Date", "Bill From", "CustomerName", "City", "ItemCode", "Color", "Qty", "MRP", "SaleRate", "TaxableValue", "GROUP", "STATE", "STATE HEAD", "MONTH"],
  ["INV-1", 46203, "X", "CUST", "C", "A1", "WHT", 2, 100, 90, 180, "G", "DELHI", "H", "Aug-26"],
];

// Sheet11's actual shape: header-ish (Item Code + Quantity + Taxable Value)
// but NO invoice number and NO date column.
const SHEET11_ROWS: CellValue[][] = [
  ["Bill From", "Item Code", "Quantity", "Taxable Value", "GROUP", "MAIN GROUP", "WEIGHT", "TOTAL WEIGHT"],
  ["X", "A1", 5, 900, "G", "MG", 1.2, 6],
];

const NO_HEADER_ROWS: CellValue[][] = [["random", "scratch", "notes"], [1, 2, 3]];

describe("classifyTabName — months by parsing, not a hardcoded list", () => {
  it("recognises started months in any spelling", () => {
    for (const t of ["Aug", "Aug-26", "August", "Apr", "July"]) {
      expect(classifyTabName(t, FY, NOW).kind).toBe("month-started");
    }
  });
  it("flags future months (Sep..Mar) as month-future on 7 Aug", () => {
    for (const t of ["Sep", "Sep-26", "October", "Mar-27"]) {
      expect(classifyTabName(t, FY, NOW).kind).toBe("month-future");
    }
  });
  it("never parses scratch/lookup/person names as months", () => {
    for (const t of ["Sheet11", "WT", "INDEX", "Combined", "--report", "LAST MONTH ORDER", "ANUJ SHARMA", "Scratch"]) {
      expect(classifyTabName(t, FY, NOW).kind).toBe("not-month");
    }
  });
});

describe("decideTabStatus — propose vs ignore", () => {
  it("PROPOSES a new 'Sep' tab with the correct shape (not auto-included)", () => {
    const d = decideTabStatus(classifyTabName("Sep", FY, NOW), testRegisterShape(MONTH_TAB_HEADER));
    expect(d.status).toBe("proposed");
    expect(d.reason).toMatch(/NOT auto-included/);
  });
  it("ignores a 'Scratch' tab", () => {
    const d = decideTabStatus(classifyTabName("Scratch", FY, NOW), testRegisterShape(NO_HEADER_ROWS));
    expect(d.status).toBe("ignored");
  });
  it("ignores Sheet11 with the concrete missing-column reason", () => {
    const shape = testRegisterShape(SHEET11_ROWS);
    expect(shape.headerFound).toBe(true);
    expect(shape.ok).toBe(false);
    const d = decideTabStatus(classifyTabName("Sheet11", FY, NOW), shape);
    expect(d.status).toBe("ignored");
    expect(d.reason).toMatch(/invoice-number/);
    expect(d.reason).toMatch(/date/);
  });
  it("ignores a future month tab with a wrong shape", () => {
    const d = decideTabStatus(classifyTabName("Sep", FY, NOW), testRegisterShape(SHEET11_ROWS));
    expect(d.status).toBe("ignored");
  });
});
