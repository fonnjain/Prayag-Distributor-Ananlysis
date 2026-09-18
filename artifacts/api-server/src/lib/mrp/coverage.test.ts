import { describe, expect, it } from "vitest";
import {
  coverageSeverity,
  fiscalMonthCalendarStart,
  latestThreeCompleteFyMonths,
  rankSteadySellers,
} from "./coverage.js";

describe("MRP coverage period helpers", () => {
  it("orders the latest complete months chronologically on 18 Sep 2026", () => {
    expect(latestThreeCompleteFyMonths(
      ["Apr-26", "Jan-26", "Aug-26", "Mar-27", "Jul-26", "Jun-26"],
      new Date("2026-09-18T00:00:00Z"),
    )).toEqual(["Jun-26", "Jul-26", "Aug-26"]);
  });

  it("handles January through March labels as their stated calendar year", () => {
    expect(fiscalMonthCalendarStart("Jan-26")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(fiscalMonthCalendarStart("Mar-2027")?.toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  it("uses strict above-one and above-five percent thresholds", () => {
    expect(coverageSeverity(0.01)).toBe("current");
    expect(coverageSeverity(0.01001)).toBe("warning");
    expect(coverageSeverity(0.05)).toBe("warning");
    expect(coverageSeverity(0.05001)).toBe("critical");
    expect(coverageSeverity(0, true)).toBe("critical");
  });

  it("ranks steady sellers by value, with deterministic code tie-break", () => {
    expect(rankSteadySellers([
      { code: "B", value: 10, lastSold: "2026-08-01", soldInLatestThreeCompleteMonths: true },
      { code: "A", value: 10, lastSold: "2026-08-02", soldInLatestThreeCompleteMonths: true },
      { code: "C", value: 20, lastSold: "2026-08-03", soldInLatestThreeCompleteMonths: true },
    ]).map((x) => x.code)).toEqual(["C", "A", "B"]);
  });
});