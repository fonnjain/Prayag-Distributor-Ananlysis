import { describe, expect, it } from "vitest";
import { classifySecondaryOpenCoverage } from "./customers.js";

const NOW = new Date("2026-09-17T12:00:00Z");

describe("secondary open coverage", () => {
  it("reports an August source that is partial through the 19th", () => {
    const result = classifySecondaryOpenCoverage(
      [{ month_number: 8, max_order_date: "2026-08-19", has_partial: true, has_complete: false }],
      "2026-27",
      NOW,
    );
    expect(result.openWindowMonths).toEqual(["Jun-26", "Jul-26", "Aug-26", "Sep-26"]);
    expect(result.partialMonths).toEqual([
      { month: "Aug-26", through: "2026-08-19T00:00:00.000Z" },
    ]);
    expect(result.unavailableMonths).toContain("Sep-26");
  });

  it("does not mark a complete August source through the 31st partial", () => {
    const result = classifySecondaryOpenCoverage(
      [{ month_number: 8, max_order_date: "2026-08-31", has_partial: false, has_complete: true }],
      "2026-27",
      NOW,
    );
    expect(result.partialMonths).toEqual([]);
    expect(result.unavailableMonths).toContain("Sep-26");
  });

  it("marks September unavailable when the source has no September rows", () => {
    const result = classifySecondaryOpenCoverage(
      [{ month_number: 8, max_order_date: "2026-08-31", has_partial: false, has_complete: true }],
      "2026-27",
      NOW,
    );
    expect(result.unavailableMonths).toContain("Sep-26");
  });
});