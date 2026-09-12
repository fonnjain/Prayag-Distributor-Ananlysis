import { describe, expect, it } from "vitest";
import {
  aggregateSecondaryOrderLines,
  chooseOrderAggregate,
  type SecondaryOrderLineForAggregation,
} from "./orders.js";

const row = (
  overrides: Partial<SecondaryOrderLineForAggregation> = {},
): SecondaryOrderLineForAggregation => ({
  orderDatetime: new Date(Date.UTC(2026, 3, 10)),
  orderId: "ORD-1",
  salesUserName: "Ravi Kumar P (Off Roll)",
  customerName: "Alpha Traders",
  dealerId: "RET-1",
  cpName: "Direct",
  state: "Delhi",
  segmentCanon: "Hardware",
  categoryName: null,
  basicOrderValue: "125000",
  ...overrides,
});

describe("secondary_order_line management fallback aggregation", () => {
  it("keeps the existing normSecKey join and gives a real member zero only when no rows exist", () => {
    const agg = aggregateSecondaryOrderLines("2026-27", "secondary_order_line", [
      row(),
      row({
        orderId: "ORD-2",
        salesUserName: null,
        dealerId: "RET-BLANK",
        basicOrderValue: "50000",
      }),
    ]);

    // Parenthetical stripping is Section C, so this key intentionally retains
    // the annotation for now.
    expect([...agg.perTm.keys()]).toEqual(["ravikumarpoffroll"]);
    expect(agg.perTm.get("ravikumarpoffroll")?.amount).toBe(125000);
    // Rows with no member attribution do not affect the source total or
    // manufacture a synthetic member row.
    expect(agg.totalAmount).toBe(125000);
    expect(agg.retailerFirst.has("RET-BLANK")).toBe(false);
    expect(agg.spreadsheetId).toBe("secondary_order_line");
  });

  it("preserves a genuinely empty database source as an available zero source", () => {
    const agg = aggregateSecondaryOrderLines("2026-27", "secondary_order_line", []);
    expect(agg.perTm.size).toBe(0);
    expect(agg.totalAmount).toBe(0);
    expect(agg.rowsRead).toBe(0);
    expect(agg.spreadsheetId).toBe("secondary_order_line");
  });

  it("uses Drive evidence before considering a database result", () => {
    const drive = aggregateSecondaryOrderLines("2026-27", "drive-id", [row()]);
    const database = aggregateSecondaryOrderLines("2026-27", "secondary_order_line", [
      row({ basicOrderValue: "999999" }),
    ]);
    expect(chooseOrderAggregate(drive, database)).toBe(drive);
    expect(chooseOrderAggregate(null, database)).toBe(database);
  });
});