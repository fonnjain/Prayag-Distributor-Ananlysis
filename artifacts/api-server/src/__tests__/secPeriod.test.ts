import { describe, it, expect } from "vitest";
import { secPeriod } from "../routes/mgmt";
import type { SecMember } from "../lib/mgmt/stateDashboard";

// secPeriod slices sec.months[mFrom-1..mTo-1] (1-based fiscal months, 1 = Apr).
// Rules under test (task: Secondary tile must match the selected period):
//   • sales sums the monthly Sales columns for the selected range only
//   • planRecorded (achievement denominator) covers fully-recorded months only —
//     never the full period plan, so a full-FY selection early in the year does
//     not understate achievement.
//   • a period with zero fully-recorded months returns achievement null, not 0.

type MonthLike = {
  planAmount: number | null;
  orderedAmount: number | null;
  salesAmount: number | null;
  notYetRecorded: boolean;
};

function member(months: MonthLike[]): SecMember {
  // Pad to 12 fiscal months with future (unrecorded, no-actuals) months.
  const padded = [...months];
  while (padded.length < 12) {
    padded.push({ planAmount: 10, orderedAmount: null, salesAmount: null, notYetRecorded: true });
  }
  return { months: padded } as unknown as SecMember;
}

// Apr/May/Jun fully recorded; Jul+ carry a plan but no recorded sales.
const m = member([
  { planAmount: 100, orderedAmount: 90, salesAmount: 80, notYetRecorded: false },
  { planAmount: 100, orderedAmount: 95, salesAmount: 85, notYetRecorded: false },
  { planAmount: 100, orderedAmount: 98, salesAmount: 90, notYetRecorded: false },
]);

describe("secPeriod period filtering + achievement basis", () => {
  it("single month returns that month's figures only", () => {
    const p = secPeriod(m, 2, 2);
    expect(p.sales).toBe(85);
    expect(p.plan).toBe(100);
    expect(p.planRecorded).toBe(100);
    expect(p.achievement).toBeCloseTo(0.85);
  });

  it("Q1 sums Apr–Jun monthly sales", () => {
    const p = secPeriod(m, 1, 3);
    expect(p.sales).toBe(255);
    expect(p.plan).toBe(300);
    expect(p.planRecorded).toBe(300);
    expect(p.achievement).toBeCloseTo(255 / 300);
  });

  it("full-FY selection: sales stays recorded-months only; denominator excludes unrecorded months", () => {
    const p = secPeriod(m, 1, 12);
    expect(p.sales).toBe(255); // no phantom sales from Jul+ months
    expect(p.plan).toBe(300 + 9 * 10); // display plan includes future months
    expect(p.planRecorded).toBe(300); // achievement denominator does NOT
    expect(p.achievement).toBeCloseTo(255 / 300); // same as Q1, not diluted
  });

  it("period with zero fully-recorded months → achievement null, never 0%", () => {
    const p = secPeriod(m, 4, 6); // Jul–Sep: plan only, notYetRecorded
    expect(p.plan).toBe(30);
    expect(p.planRecorded).toBe(0);
    expect(p.sales).toBe(0);
    expect(p.achievement).toBeNull();
  });

  it("sales-lag month (OB entered, sales pending) counts OB but not plan/denominator", () => {
    const lag = member([
      { planAmount: 100, orderedAmount: 90, salesAmount: 80, notYetRecorded: false },
      { planAmount: 100, orderedAmount: 70, salesAmount: 0, notYetRecorded: true }, // lag
    ]);
    const p = secPeriod(lag, 1, 2);
    expect(p.ob).toBe(160);
    expect(p.sales).toBe(80);
    expect(p.planRecorded).toBe(100);
    expect(p.achievement).toBeCloseTo(0.8);
    expect(p.lagMonths).toBe(1);
  });
});
