import { describe, expect, it } from "vitest";
import {
  assertSecondaryAggregationAllowed,
  assertSecondarySourceMonth,
  secondarySeam,
  secondarySourceForMonth,
} from "./sourceContract.js";

describe("secondary source contract", () => {
  it("assigns PSCode3 through July and Product-Wise from August", () => {
    expect(secondarySourceForMonth("Jul-26")).toBe("pscode3_xlsx");
    expect(secondarySourceForMonth("Aug-26")).toBe("productwise_xlsx");
  });

  it("rejects source-month and value-basis mismatches", () => {
    expect(() => assertSecondarySourceMonth({
      source: "productwise_xlsx", value_basis: "basic_order_value_ex_gst",
      month: "Jul-26", cutoff: "independent", completeness: "complete",
    })).toThrow("source-month mismatch");
    expect(() => assertSecondarySourceMonth({
      source: "pscode3_xlsx", value_basis: "basic_order_value_ex_gst",
      month: "Jul-26", cutoff: "archive", completeness: "complete",
    })).toThrow("value basis mismatch");
  });

  it("refuses silent seam aggregation and emits explicit seam disclosure", () => {
    const july = { source: "pscode3_xlsx" as const, value_basis: "net_amount" as const, month: "Jul-26", cutoff: "archive", completeness: "complete" as const };
    const august = { source: "productwise_xlsx" as const, value_basis: "basic_order_value_ex_gst" as const, month: "Aug-26", cutoff: "CRM export", completeness: "complete" as const };
    expect(() => assertSecondaryAggregationAllowed([july, august])).toThrow("aggregation refused");
    expect(secondarySeam(july, august)).toMatchObject({
      crmOverlapExists: false,
      comparability: "unprovable_from_crm",
    });
    expect(secondarySeam(july, august).disclosure).toContain("permanently not comparable");
    expect(() => assertSecondaryAggregationAllowed([july, august])).toThrow("No overlapping CRM month exists");
  });
});