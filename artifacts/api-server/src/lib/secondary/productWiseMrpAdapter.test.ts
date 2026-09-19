import { describe, expect, it } from "vitest";
import {
  applyProductWiseMrp,
  normaliseMrpCode,
  productWiseMrpLookupKey,
} from "./productWiseMrpAdapter.js";

describe("Product-Wise effective MRP adapter", () => {
  it("derives gross and labels it derived without exposing observed gross", () => {
    const result = applyProductWiseMrp([{
      productCode: "P-1", month: "Aug-26", transactionDate: "2026-08-10",
      segment: "PTMT", qty: 2, discountPct: 20, basicOrderValueExGst: 1600,
    }], new Map([["P-1", 1000]]));
    expect(result.rows[0]).toMatchObject({
      mrp: 1000, grossMrp: 2000, grossCrm: 2000,
      observedCrmDiscount: 20, included: true,
    });
    expect(result.rows[0]?.discountMrp).toBeCloseTo(20, 10);
    expect(result.mrpBasis).toMatch(/published effective MRP.*Qty.*no GST conversion/i);
  });

  it("treats missing MRP as not offered rather than zero", () => {
    const result = applyProductWiseMrp([{
      productCode: "P-2", month: "Aug-26", transactionDate: "2026-08-10",
      segment: null, discountPct: 10, basicOrderValueExGst: 250,
    }], new Map());
    expect(result.rows[0]).toMatchObject({ mrp: null, grossMrp: null, discountMrp: null, included: false, exclusionReason: "missing_mrp" });
    expect(result.controls.missingMrpValue).toBe(250);
    expect(result.controls.valueCoveragePct).toBe(0);
  });

  it("rejects a zero discount denominator", () => {
    const result = applyProductWiseMrp([{
      productCode: "P-3", month: "Aug-26", transactionDate: "2026-08-10",
      segment: "PTMT", discountPct: 100, basicOrderValueExGst: 250,
    }], new Map([["P-3", 1000]]));
    expect(result.rows[0]?.exclusionReason).toBe("non_positive_denominator");
    expect(result.controls.nonPositiveDenominatorRows).toBe(1);
    expect(result.controls.nonPositiveDenominatorValue).toBe(250);
  });

  it("normalizes Product-Wise and MRP code keys and reports invalid discounts", () => {
    expect(normaliseMrpCode("  p-5 ")).toBe("P-5");
    const result = applyProductWiseMrp([{
      productCode: "  p-5 ", month: "Aug-26", transactionDate: "2026-08-10",
      segment: null, discountPct: null, basicOrderValueExGst: 125,
    }], new Map([["P-5", 1000]]));
    expect(result.rows[0]).toMatchObject({
      mrp: 1000,
      grossMrp: null,
      included: false,
      exclusionReason: "invalid_discount",
    });
    expect(result.controls.invalidDiscountRows).toBe(1);
    expect(result.controls.invalidDiscountValue).toBe(125);
    expect(result.controls.excludedCodes).toEqual(["P-5"]);
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
      { mrp: 1200, source: "mrp_history" },
    ]);
    expect(result.mrpSources).toEqual(["mrp_history"]);
  });

  it("uses the effective-history value first and synced only as a missing-history fallback", () => {
    const key = productWiseMrpLookupKey("P-6", "2026-08-10");
    const fallbackKey = productWiseMrpLookupKey("P-7", "2026-08-10");
    const result = applyProductWiseMrp([
      { productCode: "P-6", month: "Aug-26", transactionDate: "2026-08-10", segment: null, qty: 1, discountPct: 10, basicOrderValueExGst: 900 },
      { productCode: "P-7", month: "Aug-26", transactionDate: "2026-08-10", segment: null, qty: 1, discountPct: 10, basicOrderValueExGst: 900 },
    ], new Map([
      [key, 1000], [fallbackKey, 1100], [`${fallbackKey}\u0000source`, -1], ["P-6", 2000], ["P-7", 1100],
    ]));
    expect(result.rows.map((row) => [row.mrp, row.mrpSource])).toEqual([
      [1000, "mrp_history"], [1100, "mrp_synced"],
    ]);
  });

  it("flags code-level unit variation, excludes price-list measures, and counts value", () => {
    const rows = [
      { productCode: "UNIT", month: "Aug-26", transactionDate: "2026-08-01", segment: null, qty: 1, discountPct: 0, basicOrderValueExGst: 100 },
      { productCode: "UNIT", month: "Aug-26", transactionDate: "2026-08-02", segment: null, qty: 1, discountPct: 0, basicOrderValueExGst: 103 },
    ];
    const result = applyProductWiseMrp(rows, new Map([["UNIT", 100]]));
    expect(result.rows.every((row) => row.exclusionReason === "unit_mismatch" &&
      row.grossMrp === null && row.discountMrp === null)).toBe(true);
    expect(result.controls.unitMismatchRows).toBe(2);
    expect(result.controls.unitMismatchValue).toBe(203);
  });

  it("prioritizes UNIT_MISMATCH over missing MRP and excludes it from missing controls", () => {
    const rows = [
      { productCode: "MIXED", month: "Aug-26", transactionDate: "2026-08-01", segment: null, qty: 1, discountPct: 0, basicOrderValueExGst: 100 },
      { productCode: "MIXED", month: "Aug-26", transactionDate: "2026-08-02", segment: null, qty: 1, discountPct: 0, basicOrderValueExGst: 300 },
    ];
    const result = applyProductWiseMrp(rows, new Map([
      [productWiseMrpLookupKey("MIXED", "2026-08-01"), 100],
    ]));
    expect(result.controls.unitMismatchCodes).toBe(1);
    expect(result.controls.unitMismatchCodeList).toEqual(["MIXED"]);
    expect(result.rows.map((row) => row.exclusionReason)).toEqual(["unit_mismatch", "unit_mismatch"]);
    expect(result.controls.missingMrpRows).toBe(0);
  });

  it("reports code agreement buckets at 1%, 5%, and outside 5%", () => {
    const rows = [
      { productCode: "A1", month: "Aug-26", transactionDate: "2026-08-01", segment: null, qty: 1, discountPct: 0, basicOrderValueExGst: 100 },
      { productCode: "A5", month: "Aug-26", transactionDate: "2026-08-01", segment: null, qty: 1, discountPct: 0, basicOrderValueExGst: 103 },
      { productCode: "A6", month: "Aug-26", transactionDate: "2026-08-01", segment: null, qty: 1, discountPct: 0, basicOrderValueExGst: 110 },
    ];
    const result = applyProductWiseMrp(rows, new Map([["A1", 100], ["A5", 100], ["A6", 100]]));
    expect(result.controls.agreementWithin1Pct).toEqual({ codes: 1, value: 100 });
    expect(result.controls.agreementWithin5Pct).toEqual({ codes: 1, value: 103 });
    expect(result.controls.agreementOutside5Pct).toEqual({ codes: 1, value: 110 });
  });

  it("keeps CRM discount observed and flags disagreement above two points", () => {
    const result = applyProductWiseMrp([{
      productCode: "DISC", month: "Aug-26", transactionDate: "2026-08-01",
      segment: null, qty: 1, discountPct: 20, basicOrderValueExGst: 700,
    }], new Map([["DISC", 1000]]));
    expect(result.rows[0]).toMatchObject({ observedCrmDiscount: 20, discountDisagreement: true });
    expect(result.rows[0]?.discountMrp).toBeCloseTo(30, 10);
    expect(result.controls.disagreementRows).toBe(1);
    expect(result.controls.disagreementValue).toBe(700);
  });
});