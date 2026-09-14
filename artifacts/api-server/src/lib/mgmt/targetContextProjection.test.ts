import { describe, expect, it } from "vitest";
import { projectFromCompleteMonths } from "./targetContextProjection.js";

describe("projectFromCompleteMonths", () => {
  it("projects complete-month actuals through the seasonal curve, not linearly", () => {
    const projection = projectFromCompleteMonths(
      [
        { monthLabel: "Apr-26", fiscalMonthIndex: 0, amount: 10 },
        { monthLabel: "May-26", fiscalMonthIndex: 1, amount: 20 },
        { monthLabel: "Jun-26", fiscalMonthIndex: 2, amount: 30 },
        { monthLabel: "Jul-26", fiscalMonthIndex: 3, amount: 35 },
        { monthLabel: "Aug-26", fiscalMonthIndex: 4, amount: 40 },
      ],
      [0.0419, 0.08, 0.087, 0.072, 0.0686, 0.064, 0.064, 0.082, 0.095, 0.101, 0.109, 0.1355],
    );

    expect(projection?.seasonalShare).toBeCloseTo(0.3495, 8);
    expect(projection?.actualYtd).toBe(135);
    expect(projection?.projectedFullYear).toBeCloseTo(135 / 0.3495, 8);
    expect(projection?.projectedFullYear).not.toBe(135 * 12 / 5);
  });

  it("does not invent a projection when there are no complete months", () => {
    expect(projectFromCompleteMonths([], Array(12).fill(1 / 12))).toBeNull();
  });
});