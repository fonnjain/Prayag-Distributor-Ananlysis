import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import {
  clearAiSchemesAnalyticsCache,
  getAiSchemesAnalytics,
} from "../src/lib/aiSchemesAnalytics.js";

async function main(): Promise<void> {
  clearAiSchemesAnalyticsCache();
  const result = await getAiSchemesAnalytics(["2025-26", "2026-27"]);
  const fy25 = result.reports.find((report) => report.fy === "2025-26");
  const fy26 = result.reports.find((report) => report.fy === "2026-27");

  assert(fy25, "Missing FY2025-26 AI Schemes report");
  assert.deepEqual(
    {
      positivePairs: fy25.pairMatrix.positivePairs,
      activeRetailers: fy25.pairMatrix.activeRetailers,
      skus: fy25.pairMatrix.skus,
      density: fy25.pairMatrix.pairDensityPct,
      median: fy25.pairMatrix.valueDistribution.median,
      bands: fy25.skuBands.filter((band) => band.band !== "DORMANT").map((band) => band.codes),
      marginSkus: [fy25.marginHeadroom.usableSecondarySkuCount, fy25.marginHeadroom.secondarySkuCount],
      marginValueCoverage: fy25.marginHeadroom.valueRepresentedPct,
    },
    {
      positivePairs: 238005,
      activeRetailers: 8898,
      skus: 4053,
      density: 0.66,
      median: 3468,
      bands: [111, 435, 1017, 1310, 2233],
      marginSkus: [3197, 4053],
      marginValueCoverage: 89.44,
    },
  );

  assert(fy26, "Missing FY2026-27 AI Schemes report");
  const fy26Actual = {
      positivePairs: fy26.pairMatrix.positivePairs,
      activeRetailers: fy26.pairMatrix.activeRetailers,
      skus: fy26.pairMatrix.skus,
      density: fy26.pairMatrix.pairDensityPct,
      median: fy26.pairMatrix.valueDistribution.median,
      marginSkus: [fy26.marginHeadroom.usableSecondarySkuCount, fy26.marginHeadroom.secondarySkuCount],
      marginValueCoverage: fy26.marginHeadroom.valueRepresentedPct,
      heldPeriods: [...fy26.coverage.heldPeriods].sort(),
      heldCategories: [...fy26.marginHeadroom.heldCategories].sort(),
    };
  assert.deepEqual(
    fy26Actual,
    {
      positivePairs: 98138,
      activeRetailers: 6194,
      skus: 3274,
      density: 0.4839,
      median: 3503,
      marginSkus: [2273, 3274],
      marginValueCoverage: 83.2,
      heldPeriods: ["Apr-26", "Aug-26"],
      heldCategories: ["PTMT"],
    },
  );

  const expectedOpenBands = [125, 441, 967, 1056, 1438];
  const currentOpenBands = fy26.skuBands
    .filter((band) => band.band !== "DORMANT")
    .map((band) => band.codes);
  if (JSON.stringify(currentOpenBands) !== JSON.stringify(expectedOpenBands)) {
    console.warn(JSON.stringify({
      warning: "FY2026-27 primary band distribution has moved from the Prompt 93 snapshot",
      expected: expectedOpenBands,
      current: currentOpenBands,
      primaryMonths: fy26.coverage.sourceMonths.primary,
    }));
  }

  console.log("AI Schemes anchors passed for FY2025-26 and FY2026-27.");
}

main()
  .finally(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });