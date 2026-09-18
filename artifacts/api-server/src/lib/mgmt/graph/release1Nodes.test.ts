import { describe, expect, it } from "vitest";
import { selectMarginPeriodSlices } from "./release1Nodes.js";
import { resolveHoldExclusions } from "../../resolution/holdResolver.js";

describe("margin calendar fiscal slicing", () => {
  it("maps Mar-26-Apr-26 to exactly the two requested fiscal/month slices", () => {
    expect(selectMarginPeriodSlices("Mar-26-Apr-26", "2025-26")).toEqual([
      { fiscalYear: "2025-26", monthLabels: ["Mar-26"] },
      { fiscalYear: "2026-27", monthLabels: ["Apr-26"] },
    ]);
  });

  it("matches the registered H1 margin scope for PTMT Jan-Apr 2026", async () => {
    const exclusions = await resolveHoldExclusions({
      measure: "margin",
      product: "PTMT",
      requestedPeriods: ["January-April 2026"],
      strictFiscalYear: true,
      holds: [{
        id: 1,
        code: "H1",
        type: "HOLD",
        title: "PTMT MARGIN, JAN-APR 2026",
        scope: "PTMT master category · margin, gross contribution, BOM cost · Jan-Apr 2026",
        reason: "Factory cost is understated.",
        fiscalYear: null,
        month: "Jan-Apr 2026",
        scopeProduct: "PTMT master category",
        scopeMeasure: "margin, gross contribution, BOM cost",
        resolutionUrl: "/resolution",
      }],
    });

    expect(exclusions).toHaveLength(1);
    expect(exclusions[0]).toMatchObject({
      type: "HOLD",
      scopeProduct: "PTMT master category",
      scopeMeasure: "margin, gross contribution, BOM cost",
    });
  });
});