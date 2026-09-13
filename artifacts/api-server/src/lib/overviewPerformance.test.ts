import { describe, expect, it } from "vitest";
import {
  aggregatePerformanceMonths,
  buildCompanyAchievement,
  calculateClosedComparableSales,
  classifyPerformanceMonth,
  companyBookingActual,
  loadCompanyBookingActuals,
  selectBookingActualsThroughDate,
  selectComparablePriorMonths,
} from "./overviewPerformance.js";
import { GetOverviewPerformanceResponse } from "@workspace/api-zod";
import { parseOrderDateOnly } from "./mgmt/orderBookByState.js";

describe("overview performance period aggregation", () => {
  it("keeps a current partial month out of closed YTD and marks future months", () => {
    const now = Date.UTC(2026, 8, 15);
    const result = aggregatePerformanceMonths(
      "2026-27",
      [
        { monthLabel: "Apr-26", amount: 100, maxDate: "2026-04-30" },
        { monthLabel: "Aug-26", amount: 90, maxDate: "2026-08-31" },
        { monthLabel: "Sep-26", amount: 60, maxDate: "2026-09-14" },
      ],
      [
        { monthLabel: "Apr-25", amount: 80, maxDate: "2025-04-30" },
        { monthLabel: "Aug-25", amount: 70, maxDate: "2025-08-31" },
        { monthLabel: "Sep-25", amount: 50, maxDate: "2025-09-30" },
      ],
      now,
    );
    expect(result.closedLabels).toEqual(["Apr-26", "May-26", "Jun-26", "Jul-26", "Aug-26"]);
    expect(result.partialLabels).toEqual(["Sep-26"]);
    expect(result.futureLabels).toEqual(["Oct-26", "Nov-26", "Dec-26", "Jan-27", "Feb-27", "Mar-27"]);
    expect(result.months.find((m) => m.monthLabel === "Sep-26")).toMatchObject({
      state: "partial",
      currentSalesInr: 60,
      currentCoverageThrough: "2026-09-14",
      priorCoverageThrough: "2025-09-30",
      comparableGrowthPct: null,
      growthNumeratorInr: null,
      growthDenominatorInr: null,
    });
    expect(result.months.find((m) => m.monthLabel === "Oct-26")).toMatchObject({
      state: "future",
      currentSalesInr: null,
    });
    expect(result.throughDate).toBe("2026-08-31");
    expect(result.salesThroughDate).toBe("2026-09-14");
    expect(result.months.find((m) => m.monthLabel === "Apr-26")).toMatchObject({
      currentCoverageThrough: "2026-04-30",
      priorCoverageThrough: "2025-04-30",
    });
  });

  it("reports numerator, denominator, and percentage only for closed like-months", () => {
    const result = aggregatePerformanceMonths(
      "2026-27",
      [{ monthLabel: "Apr-26", amount: 120, maxDate: "2026-04-30" }],
      [{ monthLabel: "Apr-25", amount: 100, maxDate: "2025-04-30" }],
      Date.UTC(2026, 8, 15),
    );
    expect(result.months[0]).toMatchObject({
      comparableGrowthPct: 20,
      growthNumeratorInr: 20,
      growthDenominatorInr: 100,
    });
  });

  it("matches the accepted sales anchors while excluding partial and future months", () => {
    const currentRows = [
      { monthLabel: "Apr-26", amount: 1_353_470_077.14, maxDate: "2026-04-30" },
      { monthLabel: "Sep-26", amount: 10, maxDate: "2026-09-15" },
      { monthLabel: "Oct-26", amount: 20, maxDate: "2026-10-15" },
    ];
    const priorRows = [
      { monthLabel: "Apr-25", amount: 1_262_532_695.90, maxDate: "2025-04-30" },
    ];
    const aggregate = aggregatePerformanceMonths(
      "2026-27",
      currentRows,
      priorRows,
      Date.UTC(2026, 8, 15),
    );
    expect(
      calculateClosedComparableSales("2026-27", currentRows, priorRows, aggregate.closedLabels),
    ).toMatchObject({
      currentSalesInr: 1_353_470_077.14,
      priorSalesInr: 1_262_532_695.9,
      growthPct: 7.2,
    });
    expect(aggregate.months.find((row) => row.monthLabel === "Sep-26")).toMatchObject({
      state: "partial",
      currentSalesInr: 10,
    });
    expect(aggregate.months.filter((row) => row.monthLabel.startsWith("Oct") ||
      row.monthLabel.startsWith("Nov") || row.monthLabel.startsWith("Dec") ||
      row.monthLabel.startsWith("Jan") || row.monthLabel.startsWith("Feb") ||
      row.monthLabel.startsWith("Mar"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "future", currentSalesInr: null }),
      ]),
    );
  });

  it("matches the accepted achievement math fixture", () => {
    expect(
      buildCompanyAchievement(
        true,
        955_924_914.88,
        1_140_900_000,
        ["Apr-26", "May-26", "Jun-26", "Jul-26", "Aug-26"],
        "loadOrderBookByState",
        null,
        "2026-08-31",
        "2026-09-14",
      ),
    ).toMatchObject({
      actualInr: 955_924_914.88,
      targetToDateInr: 1_140_900_000,
      percentage: 83.79,
      actualsThroughDate: "2026-08-31",
      sourceLatestThroughDate: "2026-09-14",
    });
  });

  it("uses the shared month-completion rule", () => {
    expect(classifyPerformanceMonth("Sep-26", "2026-09-14", Date.UTC(2026, 8, 15))).toBe("partial");
    expect(classifyPerformanceMonth("Oct-26", null, Date.UTC(2026, 8, 15))).toBe("future");
    expect(classifyPerformanceMonth("Aug-26", null, Date.UTC(2026, 8, 15))).toBe("closed");
    expect(classifyPerformanceMonth("Sep-26", null, Date.UTC(2026, 8, 30, 23, 59))).toBe("partial");
  });

  it("does not turn unavailable order-book actuals into zero achievement", () => {
    expect(
      buildCompanyAchievement(
        false,
        null,
        1_000_000,
        ["Apr-26"],
        "loadOrderBookByState (unavailable)",
        "Sheets quota exceeded",
        null,
        null,
      ),
    ).toMatchObject({
      actualInr: null,
      targetToDateInr: 1_000_000,
      percentage: null,
      coveredMonths: ["Apr-26"],
      actualsAvailable: false,
      actualsError: "Sheets quota exceeded",
    });
  });

  it("keeps sales usable when order-book loading fails", async () => {
    const sales = calculateClosedComparableSales(
      "2026-27",
      [{ monthLabel: "Apr-26", amount: 1_353_470_077.14, maxDate: "2026-04-30" }],
      [{ monthLabel: "Apr-25", amount: 1_262_532_695.90, maxDate: "2025-04-30" }],
      ["Apr-26"],
    );
    const booking = await loadCompanyBookingActuals(async () => {
      throw new Error("Sheets quota exceeded");
    });
    expect(sales).toMatchObject({
      currentSalesInr: 1_353_470_077.14,
      priorSalesInr: 1_262_532_695.9,
      growthPct: 7.2,
    });
    expect(booking).toMatchObject({
      actualsAvailable: false,
      actualsError: "Sheets quota exceeded",
    });
    expect(
      buildCompanyAchievement(
        false,
        null,
        1_140_900_000,
        ["Apr-26"],
        booking.source,
        booking.actualsError,
        null,
        null,
      ),
    ).toMatchObject({ actualInr: null, percentage: null });
  });

  it("preserves the latest real booking source date", async () => {
    expect(parseOrderDateOnly("14-09-2026")).toBe("2026-09-14");
    expect(parseOrderDateOnly("not-a-date")).toBeNull();
    const booking = await loadCompanyBookingActuals(async () => ({
      amounts: new Map(),
      coveredThroughByMonth: new Map([
        ["Apr-26", "2026-04-30"],
        ["Aug-26", "2026-08-31"],
        ["Sep-26", "2026-09-14"],
      ]),
      sourceLatestThroughDate: "2026-09-14",
      error: null,
    }));
    expect(booking).toMatchObject({
      actualsAvailable: true,
      sourceLatestThroughDate: "2026-09-14",
      actualsError: null,
    });
    expect(selectBookingActualsThroughDate(
      ["Apr-26", "Aug-26"],
      booking.coveredThroughByMonth,
    )).toBe("2026-08-31");
    expect(selectBookingActualsThroughDate(
      ["Apr-26", "Aug-26", "Sep-26"],
      booking.coveredThroughByMonth,
    )).toBe("2026-09-14");
  });

  it("cross-foots mapped company booking states without duplicating DELHI", () => {
    const actual = companyBookingActual(
      ["Apr-26"],
      [{ stateHead: "Head One", state: "DELHI", monthLabel: "Apr-26", targetLakh: 1 }],
      new Map([
        ["headone|DELHI A|Apr-26", 12],
        ["headone|DELHI NCR|Apr-26", 18],
        ["headone|DELHI|Apr-26", 999],
      ]),
    );
    expect(actual).toBe(30);
  });

  it("does not claim unloaded prior months are closed-comparable", () => {
    expect(
      selectComparablePriorMonths(
        "2026-27",
        ["Apr-26", "May-26", "Jun-26"],
        [{ monthLabel: "Apr-25", amount: 1, maxDate: "2025-04-30" }],
      ),
    ).toEqual(["Apr-25"]);
  });

  it("keeps date-only fields as YYYY-MM-DD strings through response validation", () => {
    const parsed = GetOverviewPerformanceResponse.parse({
      fy: "2026-27",
      priorFy: "2025-26",
      months: [],
      closedComparableYtd: {
        currentSalesInr: 1,
        priorSalesInr: 1,
        growthPct: 0,
        growthNumeratorInr: 0,
        growthDenominatorInr: 1,
        throughDate: "2026-08-31",
      },
      companyAchievement: {
        actualInr: null,
        targetToDateInr: 1,
        percentage: null,
        coveredMonths: [],
        source: "test",
        actualsAvailable: false,
        actualsError: "unavailable",
        actualsThroughDate: null,
        sourceLatestThroughDate: null,
      },
      sources: { sales: "test", priorSales: "test", targets: "test", bookings: "test" },
      coverage: {
        currentClosedMonths: [],
        currentPartialMonths: [],
        currentFutureMonths: [],
        priorClosedMonths: [],
        salesThroughDate: "2026-08-31",
      },
    });
    expect(parsed.closedComparableYtd.throughDate).toBe("2026-08-31");
    expect(parsed.coverage.salesThroughDate).toBe("2026-08-31");
  });
});