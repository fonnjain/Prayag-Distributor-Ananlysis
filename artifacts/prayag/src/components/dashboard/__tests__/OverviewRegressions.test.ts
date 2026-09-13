import { describe, it, expect } from "vitest";
import { prepareChartData, formatGrowthLabel, getNarrativeSummary, getAchievementText, formatCroreExact, getAchievementDetails } from "../OverviewLogic";
import { OverviewPerformanceMonthState } from "@workspace/api-client-react";

describe("OverviewLogic Regressions", () => {
  describe("Formatting +7.2 YTD and fixed labels", () => {
    it("renders specifically requested exact 1-decimal formats", () => {
      expect(formatGrowthLabel(-13.0)).toBe("-13.0%");
      expect(formatGrowthLabel(-4.5)).toBe("-4.5%");
      expect(formatGrowthLabel(5.2)).toBe("+5.2%");
      expect(formatGrowthLabel(21.9)).toBe("+21.9%");
      expect(formatGrowthLabel(20.0)).toBe("+20.0%");
      expect(formatGrowthLabel(7.2)).toBe("+7.2%");
    });
  });

  describe("Exact Crore Formatting", () => {
    it("rounds the accepted headline ₹1,353,470,077.14 to exactly ₹135.35 Cr", () => {
      expect(formatCroreExact(1353470077.14)).toBe("₹135.35 Cr");
    });
    
    it("formats prior ₹126.25 Cr exactly", () => {
      expect(formatCroreExact(1262500000)).toBe("₹126.25 Cr");
    });

    it("handles negatives and null safely", () => {
      expect(formatCroreExact(-1353470077.14)).toBe("-₹135.35 Cr");
      expect(formatCroreExact(null)).toBe("—");
    });
  });

  describe("Narrative Basis and Partial/Future Exclusion", () => {
    it("safely ignores partial/future months and computes the correct total sum and percentages", () => {
      const months = [
        {
          monthLabel: "Apr",
          state: OverviewPerformanceMonthState.closed,
          currentSalesInr: 1072,
          priorSalesInr: 1000,
          comparableGrowthPct: 7.2,
          growthNumeratorInr: 72,
          growthDenominatorInr: 1000,
        },
        {
          monthLabel: "May",
          state: OverviewPerformanceMonthState.closed,
          currentSalesInr: 1219,
          priorSalesInr: 1000,
          comparableGrowthPct: 21.9,
          growthNumeratorInr: 219,
          growthDenominatorInr: 1000,
        },
        {
          monthLabel: "Jun",
          state: OverviewPerformanceMonthState.closed,
          currentSalesInr: 870,
          priorSalesInr: 1000,
          comparableGrowthPct: -13.0,
          growthNumeratorInr: -130,
          growthDenominatorInr: 1000,
        },
        {
          monthLabel: "Jul",
          state: OverviewPerformanceMonthState.closed,
          currentSalesInr: 955,
          priorSalesInr: 1000,
          comparableGrowthPct: -4.5,
          growthNumeratorInr: -45,
          growthDenominatorInr: 1000,
        },
        {
          monthLabel: "Aug",
          state: OverviewPerformanceMonthState.closed,
          currentSalesInr: 1200,
          priorSalesInr: 1000,
          comparableGrowthPct: 20.0,
          growthNumeratorInr: 200,
          growthDenominatorInr: 1000,
        },
        {
          monthLabel: "Sep",
          state: OverviewPerformanceMonthState.partial,
          currentSalesInr: 500,
          priorSalesInr: 1000,
          comparableGrowthPct: null,
          growthNumeratorInr: null,
          growthDenominatorInr: null,
        },
        {
          monthLabel: "Oct",
          state: OverviewPerformanceMonthState.future,
          currentSalesInr: null,
          priorSalesInr: 1000,
          comparableGrowthPct: null,
          growthNumeratorInr: null,
          growthDenominatorInr: null,
        },
      ];

      const narrative = getNarrativeSummary(months);
      const chartData = prepareChartData(months);

      // Verify exact 5 closed month labels
      expect(narrative.closedCount).toBe(5);
      
      // Calculate manual trajectory: (72 + 219 - 130 - 45 + 200) = 316
      // Total denominator = 5000
      // 316 / 5000 = 0.0632 => 6.32%
      expect(narrative.totalNum).toBe(316);
      expect(narrative.totalDen).toBe(5000);
      expect(narrative.trajectoryPct).toBeCloseTo(6.32, 2);

      expect(narrative.strongest?.monthLabel).toBe("May"); // +21.9%
      expect(narrative.weakest?.monthLabel).toBe("Jun"); // -13.0%

      // Verify exclusions in chart data
      const sep = chartData.find(m => m.monthLabel === "Sep");
      expect(sep?.currentSalesInr).toBe(500); // Partial still rendered in chart, just patterned
      
      const oct = chartData.find(m => m.monthLabel === "Oct");
      expect(oct?.currentSalesInr).toBeNull(); // Future blanked
    });
  });

  describe("Achievement Display Helpers", () => {
    describe("getAchievementText", () => {
      it("returns formatted percentage when available", () => {
        const ach = {
          actualInr: 100,
          targetToDateInr: 200,
          percentage: 50,
          coveredMonths: [],
          source: "Source",
          actualsAvailable: true,
          actualsError: null,
          actualsThroughDate: null,
          sourceLatestThroughDate: null,
        };
        expect(getAchievementText(ach)).toBe("50.0%");
      });

      it("returns error text when there is an actualsError", () => {
        const ach = {
          actualInr: null,
          targetToDateInr: 200,
          percentage: null,
          coveredMonths: [],
          source: "Source",
          actualsAvailable: false,
          actualsError: "Not mapped",
          actualsThroughDate: null,
          sourceLatestThroughDate: null,
        };
        expect(getAchievementText(ach)).toBe("Not mapped");
      });

      it("returns Unavailable when neither available nor error", () => {
        const ach = {
          actualInr: null,
          targetToDateInr: 200,
          percentage: null,
          coveredMonths: [],
          source: "Source",
          actualsAvailable: false,
          actualsError: null,
          actualsThroughDate: null,
          sourceLatestThroughDate: null,
        };
        expect(getAchievementText(ach)).toBe("Unavailable");
      });
    });

    describe("getAchievementDetails", () => {
      it("formats achievement details correctly distinguishing metric through and source latest through", () => {
        const ach = {
          actualInr: 50000000, // 5 Cr
          targetToDateInr: 100000000, // 10 Cr
          percentage: 50,
          coveredMonths: ["Apr", "May", "Jun", "Jul", "Aug"],
          source: "Primary",
          actualsAvailable: true,
          actualsError: null,
          actualsThroughDate: "2026-08-31", // Metric includes Apr-Aug
          sourceLatestThroughDate: "2026-09-15", // But source has partial Sep
        };

        const details = getAchievementDetails(ach, "Targets Master");

        expect(details).toEqual([
          "Target-to-date: ₹10.00 Cr",
          "Basis: ₹5.00 Cr / ₹10.00 Cr",
          "Source: Primary vs Targets Master",
          "Included metric through: 2026-08-31",
          "Source latest through: 2026-09-15",
        ]);
      });

      it("handles unavailable gracefully", () => {
        const ach = {
          actualInr: null,
          targetToDateInr: 100000000,
          percentage: null,
          coveredMonths: [],
          source: "Primary",
          actualsAvailable: false,
          actualsError: null,
          actualsThroughDate: null,
          sourceLatestThroughDate: null,
        };

        const details = getAchievementDetails(ach, "Targets Master");

        expect(details).toEqual([
          "Target-to-date: ₹10.00 Cr",
          "Basis: Unavailable",
          "Source: Primary vs Targets Master",
          "Included metric through: Unavailable",
          "Source latest through: Unavailable",
        ]);
      });
    });
  });
});
