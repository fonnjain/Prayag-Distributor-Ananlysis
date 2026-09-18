import { describe, expect, it } from "vitest";
import { resolveHoldExclusionsFromRows, type ResolutionHold, type ResolutionItemRow } from "./holdResolver.js";

const ptmtHold: ResolutionHold = {
  id: 88,
  type: "HOLD",
  title: "PTMT margin, Jan–Apr 2026",
  scope: "PTMT · margin, gross contribution, BOM cost · Jan–Apr 2026",
  reason: "Factory cost source is understated.",
  fiscalYear: "2025-26",
  month: "Jan-Apr 2026",
  scopeProduct: "PTMT",
  scopeMeasure: "margin,gross contribution,BOM cost",
  resolutionUrl: "/settings/resolution/88",
};

const pending: ResolutionItemRow = {
  ...ptmtHold,
  id: 89,
  type: "PENDING",
  title: "PTMT code confirmation",
};
const augSecondary: ResolutionHold = {
  ...ptmtHold,
  id: "H2",
  title: "AUGUST 2026 SECONDARY SKU",
  fiscalYear: "2026-27",
  month: "Aug-26 onward",
  scopeProduct: "secondary SKU",
  scopeMeasure: "secondary SKU, retailer-level secondary analysis, item-level secondary analysis",
};
const attributionHold: ResolutionHold = {
  ...ptmtHold,
  id: "H3",
  title: "FY2024-25 MONTHLY ATTRIBUTION",
  fiscalYear: "2024-25",
  month: "FY2024-25",
  scopeProduct: null,
  scopeMeasure: "monthly figures, quarterly figures",
};

describe("central resolution HOLD enforcement", () => {
  it("blocks only the named measure/product and reports Jan-Apr coverage", () => {
    const exclusions = resolveHoldExclusionsFromRows({
      measure: "gross contribution",
      product: "PTMT",
      requestedPeriods: ["Dec-25", "Jan-26", "Feb-26", "Mar-26", "Apr-26", "May-26"],
    }, [ptmtHold]);

    expect(exclusions).toHaveLength(1);
    expect(exclusions[0]).toMatchObject({
      value: null,
      availability: "unavailable",
      type: "HOLD",
      resolutionItemId: 88,
      holdId: 88,
      resolutionUrl: "/settings/resolution/88",
      scope: {
        fiscalYear: "2025-26",
        months: ["Jan-26", "Feb-26", "Mar-26", "Apr-26"],
        products: ["PTMT"],
        measures: ["margin", "gross contribution", "BOM cost"],
      },
      coverage: {
        requestedPeriods: ["Dec-25", "Jan-26", "Feb-26", "Mar-26", "Apr-26", "May-26"],
        heldPeriods: ["Jan-26", "Feb-26", "Mar-26", "Apr-26"],
        availablePeriods: ["Dec-25", "May-26"],
        requested: ["Dec-25", "Jan-26", "Feb-26", "Mar-26", "Apr-26", "May-26"],
        held: ["Jan-26", "Feb-26", "Mar-26", "Apr-26"],
        available: ["Dec-25", "May-26"],
      },
    });
    expect(resolveHoldExclusionsFromRows({
      measure: "margin",
      product: "PTMT",
      requestedPeriods: ["Jan-25"],
    }, [ptmtHold])).toEqual([]);
  });

  it("matches a canonical product inside a human scope label", () => {
    const scoped = { ...ptmtHold, scopeProduct: "PTMT master category" };
    expect(resolveHoldExclusionsFromRows({
      measure: "BOM cost",
      product: "PTMT",
      requestedPeriods: ["Jan-26"],
    }, [scoped])).toHaveLength(1);
  });

  it("does not block another measure or product", () => {
    expect(resolveHoldExclusionsFromRows({
      measure: "sales value",
      product: "PTMT",
      requestedPeriods: ["Jan-26", "Apr-26"],
    }, [ptmtHold])).toEqual([]);
    expect(resolveHoldExclusionsFromRows({
      measure: "margin",
      product: "CP",
      requestedPeriods: ["Jan-26"],
    }, [ptmtHold])).toEqual([]);
  });

  it("never lets a PENDING item block a figure", () => {
    expect(resolveHoldExclusionsFromRows({
      measure: "margin",
      product: "PTMT",
      requestedPeriods: ["Jan-26"],
    }, [pending])).toEqual([]);
  });

  it("blocks H2 from August onward, with explicit coverage", () => {
    const exclusion = resolveHoldExclusionsFromRows({
      measure: "secondary SKU",
      product: "secondary SKU",
      requestedPeriods: ["Jul-26", "Aug-26", "Sep-26"],
    }, [augSecondary])[0];
    expect(exclusion).toMatchObject({
      value: null,
      availability: "unavailable",
      type: "HOLD",
      resolutionItemId: "H2",
      coverage: {
        requestedPeriods: ["Jul-26", "Aug-26", "Sep-26"],
        heldPeriods: ["Aug-26", "Sep-26"],
        availablePeriods: ["Jul-26"],
      },
    });
  });

  it("treats an open-ended H2 hold as covering the open fiscal year", () => {
    expect(resolveHoldExclusionsFromRows({
      measure: "secondary SKU",
      product: "secondary SKU",
      requestedPeriods: ["2026-27"],
    }, [augSecondary])).toHaveLength(1);
    expect(resolveHoldExclusionsFromRows({
      measure: "secondary SKU",
      product: "secondary SKU",
      requestedPeriods: ["2025-26"],
    }, [augSecondary])).toEqual([]);
  });

  it("blocks H3 monthly/quarterly attribution but leaves annual requests unheld", () => {
    expect(resolveHoldExclusionsFromRows({
      measure: "monthly figures",
      requestedPeriods: ["FY2024-25"],
    }, [attributionHold])).toHaveLength(1);
    expect(resolveHoldExclusionsFromRows({
      measure: "annual totals",
      requestedPeriods: ["FY2024-25"],
    }, [attributionHold])).toEqual([]);
  });

  it("matches wraparound month ranges across the calendar-year boundary", () => {
    const wraparound = {
      ...ptmtHold,
      id: "WRAP",
      fiscalYear: "2025-26",
      month: "Nov-Feb 2025-26",
    };
    const exclusions = resolveHoldExclusionsFromRows({
      measure: "margin",
      product: "PTMT",
      requestedPeriods: ["Oct-25", "Nov-25", "Dec-25", "Jan-26", "Feb-26", "Mar-26"],
    }, [wraparound]);
    expect(exclusions[0]?.coverage.heldPeriods).toEqual(["Nov-25", "Dec-25", "Jan-26", "Feb-26"]);
  });

  it("matches FY-scoped attribution holds to comparison month labels", () => {
    expect(resolveHoldExclusionsFromRows({
      measure: "monthly figures",
      requestedPeriods: ["Jan-25"],
    }, [attributionHold])).toHaveLength(1);
    expect(resolveHoldExclusionsFromRows({
      measure: "monthly figures",
      requestedPeriods: ["Apr-25"],
    }, [attributionHold])).toEqual([]);
  });
});
