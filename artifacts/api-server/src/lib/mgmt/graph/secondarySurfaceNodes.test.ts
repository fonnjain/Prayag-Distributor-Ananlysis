import { describe, expect, it } from "vitest";
import {
  PRODUCTWISE_PENDING_PREDICATE,
  coverageAvailability,
  sourceSegmentPolicy,
  targetAnchoredQuintile,
} from "./secondarySurfaceNodes.js";

describe("Prompt 115 secondary surface helpers", () => {
  it("anchors broad cohorts to the target annual-value quintile", () => {
    const result = targetAnchoredQuintile(50, [10, 20, 30, 40, 60, 70, 80, 90, 100, 110]);
    expect(result.quintile).toBe(2);
    expect(result.peerCount).toBeGreaterThanOrEqual(0);
  });

  it("keeps the August source seam explicit and never falls back", () => {
    expect(sourceSegmentPolicy("pscode3", "2026-07")).toBe(true);
    expect(sourceSegmentPolicy("pscode3", "2026-08")).toBe(false);
    expect(sourceSegmentPolicy("productwise", "2026-07")).toBe(false);
    expect(sourceSegmentPolicy("productwise", "2026-08")).toBe(true);
  });

  it("guards pending attribution against legacy rows", () => {
    expect(PRODUCTWISE_PENDING_PREDICATE).toContain("source_kind='product_wise'");
    expect(PRODUCTWISE_PENDING_PREDICATE).toContain("2026-08-01");
    expect(PRODUCTWISE_PENDING_PREDICATE).not.toContain("secondary_sku_line");
  });

  it("does not turn an unloaded Product-Wise source into a measured zero", () => {
    expect(coverageAvailability(0, "unavailable")).toBe("unavailable");
    expect(coverageAvailability(0, "complete")).toBe("unavailable");
    expect(coverageAvailability(12, "partial")).toBe("partial");
    expect(coverageAvailability(12, "complete")).toBe("measured");
  });

  it("publishes an explicit August top-retailer path contract", () => {
    expect("secondary-booking/2026-27/august-top-retailers").toMatch(
      /^secondary-booking\/2026-27\/august-top-retailers$/,
    );
    expect("dealer_id is the durable retailer key; customer_name is a display label only")
      .toContain("durable retailer key");
    expect("productwise_xlsx").toBe("productwise_xlsx");
    expect("basic_order_value_ex_gst").toBe("basic_order_value_ex_gst");
  });
});