import { describe, expect, it } from "vitest";
import { applyProductWiseMrp, productWiseMrpLookupKey } from "./productWiseMrpAdapter.js";

describe("Product-Wise effective MRP adapter", () => {
  it("derives gross and labels it derived without exposing observed gross", () => {
    const result = applyProductWiseMrp([{
      productCode: "P-1", month: "Aug-26", transactionDate: "2026-08-10",
      segment: "PTMT", discountPct: 20, basicOrderValueExGst: 800,
    }], new Map([["P-1", 1000]]));
    expect(result.rows[0]).toMatchObject({ mrp: 1000, gross: 1000, grossBasis: "derived", included: true });
    expect(result.observedGross).toBe(false);
  });

  it("treats missing MRP as not offered rather than zero", () => {
    const result = applyProductWiseMrp([{
      productCode: "P-2", month: "Aug-26", transactionDate: "2026-08-10",
      segment: null, discountPct: 10, basicOrderValueExGst: 250,
    }], new Map());
    expect(result.rows[0]).toMatchObject({ mrp: null, gross: null, included: false, exclusionReason: "missing_mrp" });
    expect(result.controls.missingMrpValue).toBe(250);
    expect(result.controls.valueCoveragePct).toBe(0);
  });

  it("rejects a zero discount denominator", () => {
    const result = applyProductWiseMrp([{
      productCode: "P-3", month: "Aug-26", transactionDate: "2026-08-10",
      segment: "PTMT", discountPct: 100, basicOrderValueExGst: 250,
    }], new Map([["P-3", 1000]]));
    expect(result.rows[0]?.exclusionReason).toBe("non_positive_denominator");
  });

  it("resolves effective MRP by code and transaction date", () => {
    const rows = [
      { productCode: "P-4", month: "Mar-26", transactionDate: "2026-03-10", segment: null, discountPct: 20, basicOrderValueExGst: 800 },
      { productCode: "P-4", month: "Aug-26", transactionDate: "2026-08-10", segment: null, discountPct: 20, basicOrderValueExGst: 960 },
    ];
    const result = applyProductWiseMrp(rows, new Map([
      [productWiseMrpLookupKey("P-4", "2026-03-10"), 1000],
      [productWiseMrpLookupKey("P-4", "2026-08-10"), 1200],
    ]));
    expect(result.rows.map((row) => ({ mrp: row.mrp, source: row.mrpSource }))).toEqual([
      { mrp: 1000, source: "mrp_history" },
      { mrp: 1200, source: "mrp_synced" },
    ]);
    expect(result.mrpSources).toEqual(["mrp_history", "mrp_synced"]);
  });
});