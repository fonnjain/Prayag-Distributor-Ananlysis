// Guard tests: the Sales People page must never collapse Quarter / YTD /
// Full Year selections back to one-month figures. These tests pin the
// range-aggregation contract of lib/periodRange.ts, the module the page uses.
import { describe, it, expect } from "vitest";
import { sumRange, achPct } from "../periodRange";
import { QUARTER_RANGES } from "@/data/global-filter-context";

// Representative open-FY monthly plan/sales arrays (fiscal 0=Apr … 11=Mar).
// Apr–Jul recorded; Aug is the open month (partial); Sep–Mar future (null).
const plan = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210];
const sales: (number | null)[] = [90, 105, 100, 125, 60, null, null, null, null, null, null, null];

describe("sumRange — period range aggregation", () => {
  it("Q1 sums exactly Apr–Jun (fiscal 0..2)", () => {
    const [f, t] = QUARTER_RANGES.q1;
    expect(sumRange(plan, f, t)).toBe(100 + 110 + 120);
    expect(sumRange(sales, f, t)).toBe(90 + 105 + 100);
    // Regression guard: a Q1 result must never equal any single month.
    expect(sumRange(sales, f, t)).not.toBe(sales[0]);
    expect(sumRange(sales, f, t)).not.toBe(sales[2]);
  });

  it("Q2/Q3/Q4 ranges cover their own three months", () => {
    expect(sumRange(plan, ...QUARTER_RANGES.q2)).toBe(130 + 140 + 150);
    expect(sumRange(plan, ...QUARTER_RANGES.q3)).toBe(160 + 170 + 180);
    expect(sumRange(plan, ...QUARTER_RANGES.q4)).toBe(190 + 200 + 210);
  });

  it("open-FY YTD sums Apr..last complete month", () => {
    // e.g. last complete month = Jul → idx 0..3
    expect(sumRange(sales, 0, 3)).toBe(90 + 105 + 100 + 125);
    expect(sumRange(plan, 0, 3)).toBe(100 + 110 + 120 + 130);
  });

  it("Full Year sums 1..12 ignoring null future-month slots (no manufactured zeros)", () => {
    expect(sumRange(sales, 0, 11)).toBe(90 + 105 + 100 + 125 + 60);
    expect(sumRange(plan, 0, 11)).toBe(plan.reduce((a, b) => a + b, 0));
  });

  it("all-null range → null (renders '—', never 0)", () => {
    // Future-only range on the sales array.
    expect(sumRange(sales, 6, 11)).toBeNull();
    expect(sumRange(Array(12).fill(null), 0, 11)).toBeNull();
    expect(sumRange(null, 0, 11)).toBeNull();
    expect(sumRange(undefined, 0, 11)).toBeNull();
  });

  it("single-month selection returns exactly that month's value", () => {
    expect(sumRange(sales, 3, 3)).toBe(125);
    expect(sumRange(plan, 7, 7)).toBe(170);
    // Unrecorded single month stays null — keeps open-month / "not recorded"
    // semantics (the page shows "Not recorded"/"In progress", not 0).
    expect(sumRange(sales, 5, 5)).toBeNull();
  });

  it("a recorded zero is a real value, not treated as missing", () => {
    const withZero = [0, null, 50];
    expect(sumRange(withZero, 0, 0)).toBe(0);
    expect(sumRange(withZero, 0, 2)).toBe(50);
  });

  it("handles undefined slots the same as null", () => {
    const sparse: (number | undefined)[] = [10, undefined, 30];
    expect(sumRange(sparse, 0, 2)).toBe(40);
    expect(sumRange(sparse, 1, 1)).toBeNull();
  });
});

describe("achPct — aggregate achievement", () => {
  it("achievement % = aggregate sales ÷ aggregate plan, never an average of monthly %s", () => {
    const p = [100, 200, 300];
    const s = [50, 100, 300]; // monthly %: 50, 50, 100 → avg 66.67 (WRONG)
    const agg = achPct(sumRange(s, 0, 2), sumRange(p, 0, 2));
    expect(agg).toBeCloseTo((450 / 600) * 100, 10); // 75, not 66.67
    const avgOfMonthly = (50 + 50 + 100) / 3;
    expect(agg).not.toBeCloseTo(avgOfMonthly, 1);
  });

  it("null when plan is missing or non-positive", () => {
    expect(achPct(100, null)).toBeNull();
    expect(achPct(100, 0)).toBeNull();
    expect(achPct(100, -5)).toBeNull();
  });

  it("null when sales is missing (all-null range)", () => {
    expect(achPct(null, 100)).toBeNull();
    expect(achPct(sumRange(sales, 6, 11), sumRange(plan, 6, 11))).toBeNull();
  });

  it("zero sales over positive plan is 0%, not null", () => {
    expect(achPct(0, 100)).toBe(0);
  });
});
