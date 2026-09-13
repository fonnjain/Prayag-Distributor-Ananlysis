import { describe, expect, it } from "vitest";
import { classifySkuBrandMirror } from "./skuBrandMirror.js";

const SOURCE = "pscode3_xlsx";

describe("classifySkuBrandMirror", () => {
  it("skips historical rows when there is no protected dual-write provenance", () => {
    const result = classifySkuBrandMirror({
      provenance: [],
      monthlyTotals: [{
        monthLabel: "Jun-25", skuRows: 1, skuNet: 100, mirrorRows: 0, mirrorNet: 0,
      }],
      protectedSource: SOURCE,
    });

    expect(result).toMatchObject({
      status: "skip",
      authoritativeMonths: [],
      badMonths: [],
    });
  });

  it("ignores provenance from a different loader source", () => {
    const result = classifySkuBrandMirror({
      provenance: [{
        monthLabel: "Jul-26", source: "legacy_backfill", rowCount: 1, netAmount: 223,
      }],
      monthlyTotals: [{
        monthLabel: "Jul-26", skuRows: 1, skuNet: 223, mirrorRows: 0, mirrorNet: 0,
      }],
      protectedSource: SOURCE,
    });

    expect(result.status).toBe("skip");
  });

  it("fails complete dual-table data loss instead of passing 0 = 0", () => {
    const result = classifySkuBrandMirror({
      provenance: [{
        monthLabel: "Jul-26", source: SOURCE, rowCount: 2, netAmount: "223.50",
      }],
      monthlyTotals: [],
      protectedSource: SOURCE,
    });

    expect(result.status).toBe("fail");
    expect(result.badMonths).toEqual(["Jul-26"]);
    expect(result.detailMismatchMonths).toEqual(["Jul-26"]);
    expect(result.mirrorMismatchMonths).toEqual(["Jul-26"]);
    expect(result.skuTotal).toBe(0);
    expect(result.mirrorTotal).toBe(0);
  });

  it("fails when SKU detail differs from the provenance controls", () => {
    const result = classifySkuBrandMirror({
      provenance: [{ monthLabel: "Jul-26", source: SOURCE, rowCount: 2, netAmount: 100 }],
      monthlyTotals: [{
        monthLabel: "Jul-26", skuRows: 1, skuNet: 99, mirrorRows: 2, mirrorNet: 100,
      }],
      protectedSource: SOURCE,
    });

    expect(result.status).toBe("fail");
    expect(result.detailMismatchMonths).toEqual(["Jul-26"]);
    expect(result.mirrorMismatchMonths).toEqual(["Jul-26"]);
  });

  it("fails when the brand mirror differs from the provenance/detail controls", () => {
    const result = classifySkuBrandMirror({
      provenance: [{ monthLabel: "Jul-26", source: SOURCE, rowCount: 2, netAmount: 100 }],
      monthlyTotals: [{
        monthLabel: "Jul-26", skuRows: 2, skuNet: 100, mirrorRows: 1, mirrorNet: 98,
      }],
      protectedSource: SOURCE,
    });

    expect(result.status).toBe("fail");
    expect(result.detailMismatchMonths).toEqual([]);
    expect(result.mirrorMismatchMonths).toEqual(["Jul-26"]);
  });

  it("passes a valid dual-write match and allows one unit of NET rounding drift", () => {
    const result = classifySkuBrandMirror({
      provenance: [
        { monthLabel: "Jul-26", source: SOURCE, rowCount: 2, netAmount: 100 },
        { monthLabel: "Jun-25", source: "legacy_backfill", rowCount: 9, netAmount: 900 },
      ],
      monthlyTotals: [
        { monthLabel: "Jul-26", skuRows: 2, skuNet: 100, mirrorRows: 2, mirrorNet: 100.5 },
        { monthLabel: "Jun-25", skuRows: 9, skuNet: 900, mirrorRows: 0, mirrorNet: 0 },
      ],
      protectedSource: SOURCE,
    });

    expect(result).toMatchObject({
      status: "pass",
      authoritativeMonths: ["Jul-26"],
      badMonths: [],
      provenanceRows: 2,
      skuRows: 2,
      mirrorRows: 2,
      provenanceTotal: 100,
      skuTotal: 100,
      mirrorTotal: 100.5,
    });
  });
});