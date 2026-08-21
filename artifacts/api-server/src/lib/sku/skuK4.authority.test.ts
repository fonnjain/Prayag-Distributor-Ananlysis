import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("K4 authoritative MRP source isolation", () => {
  it("does not read uploaded item_master MRP in either K4 price path", () => {
    const source = readFileSync(new URL("./skuK4.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bim\.mrp\b/);
    expect(source).not.toMatch(/item_master.*mrp/s);
    expect(source).toContain("authoritativeCurrentMrpRows");
    expect(source).toContain("mrp_history");
  });

  it("selects the active source only for the open FY and an as-of history otherwise", () => {
    const source = readFileSync(new URL("./skuK4.ts", import.meta.url), "utf8");
    expect(source).toContain("fy === currentOpenFy()");
    expect(source).toContain("SELECT item_code, segment, mrp FROM current_mrp");
    expect(source).toContain("SELECT item_code, segment, mrp FROM historical_mrp");
    expect(source).toContain("h.effective_from <= ${historicalAsOf}");
  });

  it("keeps a multi-division source product to one current price row per item and segment", () => {
    const source = readFileSync(new URL("./catalogueAuthority.ts", import.meta.url), "utf8");
    expect(source).toMatch(/SELECT DISTINCT\s+s\.item_code,\s+d\.app_segment AS segment,\s+s\.mrp/s);

    // Two source divisions can map to one app segment. Without the SQL DISTINCT,
    // K4's period_mrp join would repeat this same sale and inflate its net/coverage.
    const joinedSourceRows = [
      { itemCode: "WT-100", segment: "Water Tank", mrp: 1_000, sourceDivision: "QUAA" },
      { itemCode: "WT-100", segment: "Water Tank", mrp: 1_000, sourceDivision: "FERN" },
    ];
    const currentMrpRows = [...new Map(
      joinedSourceRows.map((row) => [`${row.itemCode}|${row.segment}|${row.mrp}`, row]),
    ).values()];
    const saleNet = 700;
    const k4NetAfterPriceJoin = currentMrpRows.reduce((sum) => sum + saleNet, 0);

    expect(currentMrpRows).toHaveLength(1);
    expect(k4NetAfterPriceJoin).toBe(saleNet);
  });
});