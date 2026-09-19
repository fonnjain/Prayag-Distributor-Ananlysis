import { describe, expect, it } from "vitest";
import { chronologicalMonthKey, hasJulAugSourceSeam } from "../SkuTrends";

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

  it("keeps the source seam between July and August, not August and September", () => {
    const monthly = [
      { fy: "2026-27", fyMonth: "Jul-26", monthIdx: 4, segment: "CP", codesBought: 1, net: 10 },
      { fy: "2026-27", fyMonth: "Aug-26", monthIdx: 5, segment: "CP", codesBought: 2, net: null },
      { fy: "2026-27", fyMonth: "Sep-26", monthIdx: 6, segment: "CP", codesBought: 3, net: null },
    ];
    expect(hasJulAugSourceSeam("retailer", monthly)).toBe(true);
    expect(hasJulAugSourceSeam("project", monthly)).toBe(false);
    expect(hasJulAugSourceSeam("retailer", monthly.filter((row) => row.fyMonth !== "Jul-26"))).toBe(false);
  });
});