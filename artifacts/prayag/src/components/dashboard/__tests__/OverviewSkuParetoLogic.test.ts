import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareSkuParetoChartData } from "../OverviewSkuParetoLogic";

describe("overview SKU Pareto chart logic", () => {
  it("keeps rank order and labels top ten codes", () => {
    expect(prepareSkuParetoChartData([
      { rank: 1, code: "A", cumulativeSharePct: 42.5 },
      { rank: 11, code: "K", cumulativeSharePct: 88 },
    ])).toEqual([
      { rank: 1, label: "1: A", cumulativeSharePct: 42.5 },
      { rank: 11, label: "11", cumulativeSharePct: 88 },
    ]);
  });

  it("keeps B1 visible while B2 independently loads or fails", () => {
    const overview = readFileSync(fileURLToPath(new URL("../Overview.tsx", import.meta.url)), "utf8");
    expect(overview).toMatch(/useGetOverviewPerformance\(\)/);
    expect(overview).toMatch(/<SkuParetoBlock/);
    expect(overview).toMatch(/Performance KPIs and trend retain the existing open-FY Overview basis/);
    expect(overview).not.toMatch(/if\s*\(\s*skuPareto\.(isLoading|isError)/);
  });
});