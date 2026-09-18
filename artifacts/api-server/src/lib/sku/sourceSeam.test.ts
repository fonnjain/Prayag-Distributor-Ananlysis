import { describe, expect, it } from "vitest";
import { AUG26_RETAILER_VIEW, includedInStandardRetailerAnalytics, paginateRows, type SourceSeamEntry } from "./sourceSeam.js";

describe("SKU source seam contract", () => {
  it("keeps the exact isolated August labels", () => {
    expect(AUG26_RETAILER_VIEW).toEqual({
      source: "Product-Wise CRM order booking, August 2026",
      valueBasis: "Basic Order Value, ex-GST",
      comparability: "Permanently not comparable with PSCode3 SKU NET: the CRM systems have no overlapping month",
    });
  });

  it("retains multiple sources for one month without overwriting", () => {
    const entries: SourceSeamEntry[] = [
      { source: "PSCode3 secondary SKU register", valueBasis: "SKU NET (Sub Total)", completeness: "complete", identityCoverage: 1, included: true },
      { source: "Product-Wise CRM order booking", valueBasis: "Basic Order Value, ex-GST", completeness: "partial", identityCoverage: 0.9, included: false, exclusionReason: "reconciliation required" },
    ];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.source)).toEqual([
      "PSCode3 secondary SKU register",
      "Product-Wise CRM order booking",
    ]);
    expect(entries[1]?.included).toBe(false);
  });

  it("bounds pagination to 500 and exposes total/hasMore", () => {
    const page = paginateRows(Array.from({ length: 1_001 }, (_, i) => i), 999, 500);
    expect(page.limit).toBe(500);
    expect(page.offset).toBe(500);
    expect(page.total).toBe(1_001);
    expect(page.rows).toHaveLength(500);
    expect(page.hasMore).toBe(true);
  });

  it("allows a Product-Wise-only period but refuses a mixed source selection", () => {
    expect(includedInStandardRetailerAnalytics("pscode3_xlsx")).toBe(true);
    expect(includedInStandardRetailerAnalytics("productwise_xlsx")).toBe(true);
    expect(includedInStandardRetailerAnalytics("productwise_xlsx", ["pscode3_xlsx", "productwise_xlsx"])).toBe(false);
  });
});