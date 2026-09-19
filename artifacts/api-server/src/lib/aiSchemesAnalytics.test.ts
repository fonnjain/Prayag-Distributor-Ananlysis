import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  breadthArithmetic,
  canonicalMarginCategory,
  aiSchemesHoldSignature,
  coveragePercent,
  makeSkuBands,
  pairDistribution,
} from "./aiSchemesAnalytics.js";

describe("AI Schemes E2/E3 arithmetic", () => {
  it("guards the production query seams for identity, signed pairs, bands, and margin coverage", () => {
    const source = readFileSync(new URL("./aiSchemesAnalytics.ts", import.meta.url), "utf8");
    expect(source).toContain("BTRIM(retailer_id)");
    expect(source).toContain("BTRIM(dealer_id)");
    expect(source).not.toContain("AND net_amount > 0");
    expect(source).toContain("HAVING SUM(value) > 0");
    expect(source).toContain("FROM secondary_order_line");
    expect(source).toContain("basic_order_value::numeric");
    expect(source).toContain("Product-Wise");
    expect(source).toContain("const soldCodes: CatalogueCode[] = primaryRows.rows");
    expect(source).toContain("const dormantCodes: CatalogueCode[] = catalogueCodes");
    expect(source).toContain("secondaryValue");
    expect(source).toContain("usableSecondaryValue");
    expect(source).toContain("GROUP BY mf.fy, BTRIM(mf.item_code)");
    expect(source).toContain("FROM item_master");
    expect(source).toContain("const categoryCodes = [...new Set([");
    expect(source).toContain("canonicalMarginCategory(itemGroupByCode.get(code), row.segment)");
    expect(source).toContain("const cacheKey = `${fy}:${holdSignature}`");
    expect(source).toContain("marginHoldFilter(holds, marginMonths)");
    expect(source).toContain('measure, product: hold.scopeProduct, requestedPeriods: [], strictFiscalYear: true');
    expect(source).toContain("const matchingHoldScopes = marginHeld.metadata");
    expect(source).toContain('const depth = marginTier === "RICH" ? 8 : marginTier === "MID" ? 6 : marginTier === "THIN" ? 4 : 0;');
    expect(source).toContain("AI Schemes monetary pair arithmetic is unavailable");
    expect(source).toContain("secondarySourceForMonth");
  });

  it("returns the full pair-value distribution and decile averages", () => {
    const distribution = pairDistribution([100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000]);
    expect(distribution.median).toBe(550);
    expect(distribution.p10).toBe(190);
    expect(distribution.p90).toBe(910);
    expect(distribution.bottomDecileAverage).toBe(100);
    expect(distribution.topDecileAverage).toBe(1_000);
  });

  it("keeps accepted secondary SKU/value coverage arithmetic stable", () => {
    expect(coveragePercent(6_943, 10_000)).toBe(69.43);
    expect(coveragePercent(8_320, 10_000)).toBe(83.2);
    expect(coveragePercent(0, 0)).toBe(0);
  });

  it("labels breadth arithmetic as arithmetic, not a forecast", () => {
    const arithmetic = breadthArithmetic(100, {
      p10: 10,
      p25: 20,
      median: 30,
      p75: 40,
      p90: 50,
      bottomDecileAverage: 5,
      topDecileAverage: 60,
    });
    expect(arithmetic.increments[1]).toMatchObject({
      additionalSkusPerRetailer: 2,
      lowValue: 2_000,
      medianValue: 6_000,
      highValue: 10_000,
    });
    expect(arithmetic.label).toMatch(/not a forecast/i);
  });

  it("keeps a code in the band where its cumulative revenue begins", () => {
    const result = makeSkuBands(
      [
        { code: "A", primaryValue: 50 },
        { code: "B", primaryValue: 30 },
        { code: "C", primaryValue: 20 },
        { code: "D", primaryValue: 0 },
      ],
      new Map([["A", 4], ["B", 2], ["C", 0]]),
    );
    expect(result.bands.find((band) => band.band === "VERY HIGH")?.codes).toBe(1);
    expect(result.bands.find((band) => band.band === "HIGH")?.codes).toBe(1);
    expect(result.bands.find((band) => band.band === "MEDIUM")?.codes).toBe(1);
    expect(result.bands.find((band) => band.band === "DORMANT")?.codes).toBe(1);
    expect(result.dormant.zeroPrimarySales).toBe(1);
  });

  it("uses genuine zero cash depth for BARE margin", () => {
    // The tier arithmetic is intentionally explicit in the production module:
    // BARE is a real 0% ceiling, not unavailable data.
    const source = readFileSync(new URL("./aiSchemesAnalytics.ts", import.meta.url), "utf8");
    expect(source).toContain('const depth = marginTier === "RICH" ? 8 : marginTier === "MID" ? 6 : marginTier === "THIN" ? 4 : 0;');
    expect(source).toContain("round(depth / grossMarginPct * 100)");
  });

  it("splits ERP pipe and fittings groups without name heuristics", () => {
    expect(canonicalMarginCategory("CPVC PIPE FG", "CPVC")).toBe("CPVC Pipe");
    expect(canonicalMarginCategory("CPVC Finished Goods", "CPVC")).toBe("CPVC Fittings");
    expect(canonicalMarginCategory("CPVC Trading Goods", "CPVC")).toBe("CPVC Fittings");
    expect(canonicalMarginCategory("AGRI PIPE FG", "AGRI")).toBe("AGRI Pipe");
    expect(canonicalMarginCategory("AGRI FG", "AGRI")).toBe("AGRI Fittings");
    expect(canonicalMarginCategory("AGRI TRADING", "AGRI")).toBe("AGRI Fittings");
    expect(canonicalMarginCategory("UPVC PIPE FG", "UPVC")).toBe("UPVC Pipe");
    expect(canonicalMarginCategory("UPVC Finished Goods", "UPVC")).toBe("UPVC Fittings");
    expect(canonicalMarginCategory("UPVC Trading Goods", "UPVC")).toBe("UPVC Fittings");
    expect(canonicalMarginCategory("SWR PIPE FG", "SWR")).toBe("SWR Pipe");
    expect(canonicalMarginCategory("SWR FG", "SWR")).toBe("SWR Fittings");
    expect(canonicalMarginCategory("SWR Trading Goods", "SWR")).toBe("SWR Fittings");
    expect(canonicalMarginCategory("CISTERN Finished Goods", "CISTERN")).toBe("Cistern");
    expect(canonicalMarginCategory("PTMT Finish Goods", "PTMT")).toBe("PTMT");
    expect(canonicalMarginCategory("PTMT Trading", "PTMT")).toBe("PTMT");
    expect(canonicalMarginCategory("SINK KITCHEN", "SINK")).toBe("Sink");
    expect(canonicalMarginCategory("CP ACCESSORIES", "CP")).toBe("CP");
  });

  it("uses the secondary source segment when item master is absent", () => {
    expect(canonicalMarginCategory(null, null, "PTMT")).toBe("PTMT");
    expect(canonicalMarginCategory(undefined, undefined, "Garden   Pipe")).toBe("Garden Pipe");
    expect(canonicalMarginCategory(undefined, undefined, "CP")).toBe("CP");
  });

  it("varies analytics cache input when calculation-relevant holds change", () => {
    const base = {
      id: "H1",
      type: "HOLD" as const,
      title: "ignored presentation text",
      scope: "PTMT",
      reason: "ignored presentation text",
      fiscalYear: "2026-27",
      month: "Jan-Apr 2026",
      scopeProduct: "PTMT master category",
      scopeMeasure: "gross contribution",
      resolutionUrl: "https://example.invalid/ignored",
    };
    const changed = { ...base, month: "Jan-May 2026" };
    const second = { ...base, id: "H2", month: "Aug-26", scopeMeasure: "secondary SKU" };
    expect(aiSchemesHoldSignature([base])).toBe(aiSchemesHoldSignature([{ ...base }]));
    expect(aiSchemesHoldSignature([base])).toBe(aiSchemesHoldSignature([{
      ...base,
      title: "edited title",
      reason: "edited reason",
      resolutionUrl: "https://example.invalid/edited",
    }]));
    expect(aiSchemesHoldSignature([base])).not.toBe(aiSchemesHoldSignature([changed]));
    expect(aiSchemesHoldSignature([base, second])).toBe(aiSchemesHoldSignature([second, base]));
  });

});