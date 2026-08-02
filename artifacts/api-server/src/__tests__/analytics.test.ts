// Unit tests for the month-completeness rule used by all YoY/trend analytics.
import { describe, it, expect } from "vitest";
import { isMonthComplete, priorFy } from "../lib/analytics/analytics.js";

// Fixed "now": 2026-07-08 (mid-July FY26-27).
const NOW = Date.UTC(2026, 6, 8);

describe("isMonthComplete", () => {
  it("is complete when max invoice date reaches the month's last day", () => {
    expect(isMonthComplete("Jun-26", "2026-06-30", NOW)).toBe(true);
    expect(isMonthComplete("Apr-26", "2026-04-30", NOW)).toBe(true);
  });

  it("is incomplete when invoice dates stop before month end and the lock grace window has not passed", () => {
    expect(isMonthComplete("Jul-26", "2026-07-06", NOW)).toBe(false);
    // Jun-26 with dates stopping mid-month: still incomplete just before the
    // lock instant (00:00 UTC on the 7th of the following month)…
    expect(
      isMonthComplete("Jun-26", "2026-06-15", Date.UTC(2026, 6, 6, 23, 59)),
    ).toBe(false);
  });

  it("is complete at the month-lock instant (00:00 on the 7th of the following month), even without a last-day invoice", () => {
    // Register months freeze at 00:00 UTC on the 7th of the following month —
    // after that the data cannot change, so the month is complete regardless
    // of where its invoices stop (e.g. Oct-24's last invoice was Oct-30).
    expect(isMonthComplete("Jun-26", "2026-06-15", Date.UTC(2026, 6, 7))).toBe(true);
    expect(isMonthComplete("Jun-26", "2026-06-15", NOW)).toBe(true); // NOW = Jul-8
    expect(isMonthComplete("Oct-24", "2024-10-30", NOW)).toBe(true);
    // Year boundary: Dec-25 with partial dates locks at 00:00 on Jan 7 2026.
    expect(isMonthComplete("Dec-25", "2025-12-28", Date.UTC(2026, 0, 6, 23, 59))).toBe(false);
    expect(isMonthComplete("Dec-25", "2025-12-28", Date.UTC(2026, 0, 7))).toBe(true);
  });

  it("falls back to the calendar when a month has no invoice dates (historical registers without a DATE column)", () => {
    // Fully elapsed months count as complete even with null dates.
    expect(isMonthComplete("Apr-25", null, NOW)).toBe(true);
    expect(isMonthComplete("Mar-26", null, NOW)).toBe(true);
    expect(isMonthComplete("Jun-26", null, NOW)).toBe(true);
    // The current (still-running) month never counts as complete.
    expect(isMonthComplete("Jul-26", null, NOW)).toBe(false);
    // Future months never count as complete.
    expect(isMonthComplete("Aug-26", null, NOW)).toBe(false);
  });

  it("calendar fallback only completes once the whole last day has elapsed", () => {
    // Start of the last day: still incomplete.
    expect(isMonthComplete("Jul-26", null, Date.UTC(2026, 6, 31))).toBe(false);
    // Midday on the last day: still incomplete.
    expect(isMonthComplete("Jul-26", null, Date.UTC(2026, 6, 31, 12))).toBe(
      false,
    );
    // First moment of the following month: complete.
    expect(isMonthComplete("Jul-26", null, Date.UTC(2026, 7, 1))).toBe(true);
  });

  it("returns false for unparseable month labels", () => {
    expect(isMonthComplete("", "2026-06-30", NOW)).toBe(false);
    expect(isMonthComplete("nonsense", null, NOW)).toBe(false);
  });
});

describe("priorFy", () => {
  it("computes the previous fiscal year label", () => {
    expect(priorFy("2026-27")).toBe("2025-26");
    expect(priorFy("2024-25")).toBe("2023-24");
  });
});
