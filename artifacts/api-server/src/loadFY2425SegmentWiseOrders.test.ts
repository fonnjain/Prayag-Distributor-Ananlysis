import { describe, expect, it } from "vitest";
import anchorsConfig from "../config/secondary_order_anchors.json";
import {
  assertApprovedExclusions,
  inspectFY2425SourceRows,
} from "./loadFY2425SegmentWiseOrders.js";

const approved = anchorsConfig.years["2024-25"].approved_exclusions;

describe("FY2024-25 Segment Wise approved controls", () => {
  it("keeps the previous and restated anchors traceable", () => {
    const anchor = anchorsConfig.years["2024-25"];
    expect(anchor.previous_anchor).toEqual({
      physical_rows: 335258,
      source_subtotal_rupees: 2160011256,
    });
    expect(anchor.physical_rows).toBe(335254);
    expect(anchor.source_subtotal_rupees).toBe(2160005661.09);
    expect(anchor.parser_rows).toBe(335251);
    expect(anchor.parser_value_rupees).toBe(2159997061.09);
    expect(anchor.approved_source_sha256).toBe("aba2fbe451032aed3d63bee2f18553434b9b6731b20d030633ae16eb242d05b1");
    expect(anchor.approved_source_bytes).toBe(52214948);
  });

  it("accepts exactly the one approved blank-code exclusion", () => {
    expect(() => assertApprovedExclusions(approved)).not.toThrow();
  });

  it("fails closed if another blank-code row appears", () => {
    expect(() => assertApprovedExclusions([
      ...approved,
      {
        source_row_number: 260136,
        order_id: "SORD-49335",
        date: "2024-07-06",
        dealer_id: "RET#64697",
        product_code: "",
        value_rupees: 1,
        reason: "blank_product_code_explicitly_excluded",
      },
    ])).toThrow(/blank-code exclusions changed/);
  });

  it("reports blank-code value before the parser can drop it", () => {
    const excelSerial = (Date.UTC(2024, 6, 6) - Date.UTC(1899, 11, 30)) / 86_400_000;
    const result = inspectFY2425SourceRows([
      ["Date", "Order ID", "Retailer ID", "Cat.No", "Sub Total"],
      [excelSerial, "SORD-49334", "RET#64696", "", 8600],
    ]);
    expect(result).toEqual({
      datedRows: 1,
      sourceSubtotal: 8600,
      literalMinDate: "2024-07-06",
      literalMaxDate: "2024-07-06",
      literalOutsideFiscalYearRows: 0,
      exclusions: [{
        source_row_number: 2,
        order_id: "SORD-49334",
        date: "2024-07-06",
        dealer_id: "RET#64696",
        product_code: "",
        value_rupees: 8600,
        reason: "blank_product_code_explicitly_excluded",
      }],
    });
  });

  it("counts a literal date outside FY2024-25 so the guard can reject it", () => {
    const excelSerial = (Date.UTC(2025, 3, 1) - Date.UTC(1899, 11, 30)) / 86_400_000;
    const result = inspectFY2425SourceRows([
      ["Date", "Order ID", "Retailer ID", "Cat.No", "Sub Total"],
      [excelSerial, "SORD-OUTSIDE", "RET#1", "ITEM-1", 1],
    ]);
    expect(result.literalMinDate).toBe("2025-04-01");
    expect(result.literalMaxDate).toBe("2025-04-01");
    expect(result.literalOutsideFiscalYearRows).toBe(1);
    expect(result.datedRows).toBe(0);
  });
});