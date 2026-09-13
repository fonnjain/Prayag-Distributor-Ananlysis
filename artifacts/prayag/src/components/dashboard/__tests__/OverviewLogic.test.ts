import { describe, it, expect } from "vitest";
import { prepareChartData, formatGrowthLabel, getNarrativeSummary } from "../OverviewLogic";
import { OverviewPerformanceMonthState } from "@workspace/api-client-react";

describe("OverviewLogic", () => {
  describe("prepareChartData", () => {
    it("blanks out currentSalesInr for future months", () => {
      const result = prepareChartData([
        {
          monthLabel: "Oct",
          state: OverviewPerformanceMonthState.future,
          currentSalesInr: 100,
          priorSalesInr: 90,
          comparableGrowthPct: null,
          growthNumeratorInr: null,
          growthDenominatorInr: null,
        },
        {
          monthLabel: "Sep",
          state: OverviewPerformanceMonthState.partial,
          currentSalesInr: 100,
          priorSalesInr: 90,
          comparableGrowthPct: null,
          growthNumeratorInr: null,
          growthDenominatorInr: null,
        },
      ]);
      expect(result[0].currentSalesInr).toBeNull();
      expect(result[1].currentSalesInr).toBe(100);
    });
  });

  describe("formatGrowthLabel", () => {
    it("formats positive growth with a plus and one decimal", () => {
      expect(formatGrowthLabel(15.61)).toBe("+15.6%");
      expect(formatGrowthLabel(5.2)).toBe("+5.2%");
      expect(formatGrowthLabel(21.9)).toBe("+21.9%");
      expect(formatGrowthLabel(20.0)).toBe("+20.0%");
      expect(formatGrowthLabel(7.2)).toBe("+7.2%");
    });

    it("formats negative growth with a minus and one decimal", () => {
      expect(formatGrowthLabel(-13.0)).toBe("-13.0%");
      expect(formatGrowthLabel(-4.5)).toBe("-4.5%");
    });

    it("formats zero safely", () => {
      expect(formatGrowthLabel(0)).toBe("0.0%");
      expect(formatGrowthLabel(-0.01)).toBe("0.0%");
    });

    it("returns null for null", () => {
      expect(formatGrowthLabel(null)).toBeNull();
    });
  });

  describe("getNarrativeSummary", () => {
    it("returns unavailable when no closed comparable months exist", () => {
      const result = getNarrativeSummary([
        {
          monthLabel: "Sep",
          state: OverviewPerformanceMonthState.partial,
          currentSalesInr: 100,
          priorSalesInr: 90,
          comparableGrowthPct: null,
          growthNumeratorInr: null,
          growthDenominatorInr: null,
        }
      ]);
      expect(result.available).toBe(false);
    });

    it("calculates trajectory dynamically using difference numerator", () => {
      const result = getNarrativeSummary([
        {
          monthLabel: "Apr",
          state: OverviewPerformanceMonthState.closed,
          currentSalesInr: 110,
          priorSalesInr: 100,
          comparableGrowthPct: 10,
          growthNumeratorInr: 10,
          growthDenominatorInr: 100,
        },
        {
          monthLabel: "May",
          state: OverviewPerformanceMonthState.closed,
          currentSalesInr: 150,
          priorSalesInr: 100,
          comparableGrowthPct: 50,
          growthNumeratorInr: 50,
          growthDenominatorInr: 100,
        },
        {
          monthLabel: "Jun",
          state: OverviewPerformanceMonthState.closed,
          currentSalesInr: 90,
          priorSalesInr: 100,
          comparableGrowthPct: -10,
          growthNumeratorInr: -10,
          growthDenominatorInr: 100,
        }
      ]);
      expect(result.available).toBe(true);
      expect(result.closedCount).toBe(3);
      expect(result.strongest?.monthLabel).toBe("May");
      expect(result.weakest?.monthLabel).toBe("Jun");
      expect(result.totalNum).toBe(50); // 10 + 50 - 10
      expect(result.totalDen).toBe(300); // 100 + 100 + 100
      expect(result.trajectoryPct).toBeCloseTo(16.666, 2); // 50 / 300 * 100
    });
  });
});
