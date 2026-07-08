// Integration test for the Sheets -> aggregate transform against known fixture
// workbooks (snapshots of the live Google Sheets). If the tab/column mapping
// drifts or the cell coercion helpers regress, the control totals here break.
import { describe, expect, it } from "vitest";
import { buildFy2425, buildFromOrders } from "../lib/dashboard/transform.js";
import {
  EXPECTED_ORDERS_YTD_CR,
  FY2425_CONTROL_TOTAL,
  ITEMWISE_FIXTURE,
  ORDER_BOOK_FIXTURE,
  loadFixtureWorkbook,
} from "./helpers.js";

describe("buildFy2425 (item-wise SALE tab)", () => {
  it("reproduces the exact FY24-25 control total", async () => {
    const workbook = await loadFixtureWorkbook(ITEMWISE_FIXTURE);
    const fy2425 = buildFy2425(workbook);

    expect(fy2425.grand_total).toBe(FY2425_CONTROL_TOTAL);
    // Monthly breakdown must be internally consistent with the grand total.
    expect(fy2425.grand_monthly).toHaveLength(12);
    expect(fy2425.grand_monthly.reduce((a, b) => a + b, 0)).toBe(
      FY2425_CONTROL_TOTAL,
    );
    // Product and group rollups must also sum to the control total.
    expect(fy2425.products.length).toBeGreaterThan(0);
    expect(fy2425.products.reduce((a, p) => a + p.annual, 0)).toBe(
      FY2425_CONTROL_TOTAL,
    );
    expect(fy2425.groups.reduce((a, g) => a + g.annual, 0)).toBe(
      FY2425_CONTROL_TOTAL,
    );
  });
});

describe("buildFromOrders (monthly order tabs)", () => {
  it("produces the expected orders YTD from the monthly tabs", async () => {
    const workbook = await loadFixtureWorkbook(ORDER_BOOK_FIXTURE);
    const orders = buildFromOrders(workbook);

    expect(orders.orders_ytd_cr).toBe(EXPECTED_ORDERS_YTD_CR);
    // YTD must equal the sum of the per-month values it is derived from.
    expect(
      Number(
        orders.orders_fy2627.monthly
          .reduce((a, m) => a + m.value_cr, 0)
          .toFixed(2),
      ),
    ).toBe(orders.orders_ytd_cr);
    expect(orders.orders_fy2627.monthly.length).toBeGreaterThan(0);
    expect(orders.order_customers).toBeGreaterThan(0);
    expect(orders.by_state.length).toBeGreaterThan(0);
    expect(orders.heads_retail.length).toBeGreaterThan(0);
    expect(orders.top_retailers.length).toBeGreaterThan(0);
  });
});
