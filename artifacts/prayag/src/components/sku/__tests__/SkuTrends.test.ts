import { describe, expect, it } from "vitest";
import { chronologicalMonthKey } from "../SkuTrends";

describe("SKU trend source metadata", () => {
  it("sorts month labels chronologically across financial years", () => {
    const months = ["Aug-26", "Mar-25", "Apr-24", "Jul-26", "Jan-26"];
    expect(months.sort((a, b) => chronologicalMonthKey(a) - chronologicalMonthKey(b))).toEqual([
      "Apr-24",
      "Mar-25",
      "Jan-26",
      "Jul-26",
      "Aug-26",
    ]);
  });
});