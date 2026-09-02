import { describe, expect, it } from "vitest";
import {
  fiscalYearForLiteralDate,
  literalParseOrderDate,
  parseLegacyV1Rows,
} from "../legacyV1Parser.js";

describe("Prompt 56 legacy v1 parser", () => {
  it("uses literal DD-MM dates and derives fiscal year", () => {
    const date = literalParseOrderDate("01-04-2025");
    expect(date?.toISOString().slice(0, 10)).toBe("2025-04-01");
    expect(fiscalYearForLiteralDate(date!)).toBe("2025-26");
    expect(literalParseOrderDate("04-31-2025")).toBeNull();
  });

  it("forward-fills CRM order blocks and takes the team member from filename", () => {
    const parsed = parseLegacyV1Rows([
      ["Date", "Order ID", "Retailer ID", "Product Code", "Sub Total"],
      ["15-07-2026", "SORD-12", "RET-1", "P-1", "101"],
      ["", "", "", "P-2", "202"],
    ], { kind: "filename", teamMember: "Asha" });
    expect(parsed.lines).toMatchObject([
      { orderId: "SORD-12", productCode: "P-1", salesUserName: "Asha", fiscalYear: "2026-27", basicOrderValue: 101 },
      { orderId: "SORD-12", productCode: "P-2", salesUserName: "Asha", fiscalYear: "2026-27", basicOrderValue: 202 },
    ]);
  });
});