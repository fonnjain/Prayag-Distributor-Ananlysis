import { describe, expect, it } from "vitest";
import { formatProductWiseMonthLabel } from "../productWiseMonthLabel";

describe("Product-Wise month labels", () => {
  it("formats a partial cutoff in Asia/Kolkata", () => {
    expect(formatProductWiseMonthLabel({
      month: "Sep-26",
      cutoff: "2026-09-17T18:30:00+05:30",
      completeness: "partial",
    })).toBe("Sep-26 (1–17 Sep, partial)");
  });

  it("keeps a complete month label unchanged", () => {
    expect(formatProductWiseMonthLabel({
      month: "Aug-26",
      cutoff: "2026-08-31T18:30:00+05:30",
      completeness: "complete",
    })).toBe("Aug-26");
  });
});