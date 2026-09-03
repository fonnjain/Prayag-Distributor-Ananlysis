import { describe, expect, it } from "vitest";
import { sumFiscalMonthAmount } from "../report.js";

describe("prior booking period basis", () => {
  const months = [
    802659, 1054749, 1642560, 1297273, 806671,
    1000000, 1100000, 1200000, 1300000, 1400000, 1500000, 1600000,
  ];

  it("uses Apr-Aug for the Apr-Aug comparison window", () => {
    expect(sumFiscalMonthAmount(months, 1, 5)).toBe(5603912);
  });

  it("uses all twelve months when Full Year is selected", () => {
    expect(sumFiscalMonthAmount(months, 1, 12)).toBe(
      months.reduce((total, amount) => total + amount, 0),
    );
  });
});