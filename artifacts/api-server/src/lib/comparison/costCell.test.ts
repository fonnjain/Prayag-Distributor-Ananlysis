// Guard-regression unit test for the head cost-ratio contract:
// cost sums only members with recorded cost, but the DENOMINATOR (visits/OB/
// sales) must cover ALL active members. Live data currently has no head with
// partially missing cost, so this deterministic fixture is the enforcement
// point for that path (the live curl script cross-foots the all-recorded case).
import { describe, it, expect } from "vitest";
import { computeCostCell, type CostKpisLike } from "./comparison.js";

const member = (over: Partial<CostKpisLike>): CostKpisLike => ({
  ctcMonthly: null,
  elapsedMonthsFromSheet: null,
  elapsedMonths: null,
  taBillStCost: null,
  totalVisitsYtd: null,
  orderBooking: null,
  directDealersOrder: null,
  sale: null,
  ...over,
} as CostKpisLike);

// Fixture: 3 active members, ONE with missing cost but real OB/visits/sales.
// cost = A(10000×3+2000=32000) + B(20000×3+1000=61000) = 93000 (C excluded)
// full-team OB = 100000 + 200000 + 100000(C) = 400000 → ratio 23.25
// WRONG recorded-only OB = 300000 → ratio 31.00 (must NOT be returned)
const A = member({ ctcMonthly: 10000, elapsedMonthsFromSheet: 3, taBillStCost: 2000, orderBooking: 90000, directDealersOrder: 10000, totalVisitsYtd: 50, sale: 80000 });
const B = member({ ctcMonthly: 20000, elapsedMonths: 3, taBillStCost: 1000, orderBooking: 200000, totalVisitsYtd: 100, sale: 120000 });
const C = member({ ctcMonthly: null, orderBooking: 100000, totalVisitsYtd: 50, sale: 100000 }); // cost missing — NOT zero cost
const team = [A, B, C];

describe("computeCostCell — full-team denominator with partially missing cost", () => {
  it("costRatioOb divides by ALL members' OB, not just cost-recorded members", () => {
    const cell = computeCostCell("costRatioOb", team);
    expect(cell.value).toBe(23.25); // 93000 / 400000 × 100
    expect(cell.value).not.toBe(31.0); // the wrong recorded-only denominator
    expect(cell.note).toContain("cost missing for 1 of 3 members");
    expect(cell.note).toContain("the denominator still covers all members");
  });

  it("costPerVisit divides by ALL members' visits", () => {
    const cell = computeCostCell("costPerVisit", team);
    expect(cell.value).toBe(465); // 93000 / 200 visits (50+100+50), not /150
    expect(cell.note).toContain("cost missing for 1 of 3 members");
  });

  it("costRatioSales divides by ALL members' sales", () => {
    const cell = computeCostCell("costRatioSales", team);
    expect(cell.value).toBe(31.0); // 93000 / 300000 × 100 (80k+120k+100k), not /200000=46.5
    expect(cell.note).toContain("the denominator still covers all members");
  });

  it("omits the missing-cost wording when every member has recorded cost", () => {
    const cell = computeCostCell("costRatioOb", [A, B]);
    expect(cell.value).toBe(31.0);
    expect(cell.note).not.toContain("cost missing");
  });
});

describe("computeCostCell — zero/absent guards", () => {
  it("zero sales → UNDEFINED note, value null (never 0, never Infinity)", () => {
    const cell = computeCostCell("costRatioSales", [member({ ctcMonthly: 10000, elapsedMonths: 2, orderBooking: 50000, sale: 0 })]);
    expect(cell.value).toBeNull();
    expect(cell.note).toContain("UNDEFINED");
    expect(cell.note).toContain("costRatioOb");
  });

  it("zero OB → UNDEFINED note, value null", () => {
    const cell = computeCostCell("costRatioOb", [member({ ctcMonthly: 10000, elapsedMonths: 2, orderBooking: 0 })]);
    expect(cell.value).toBeNull();
    expect(cell.note).toContain("UNDEFINED");
  });

  it("no member has recorded cost → 'not recorded' (blank cost is not zero cost)", () => {
    const cell = computeCostCell("costRatioOb", [member({ orderBooking: 100000 }), member({ ctcMonthly: 10000, elapsedMonths: null })]);
    expect(cell.value).toBeNull();
    expect(cell.note).toContain("not recorded");
  });
});
