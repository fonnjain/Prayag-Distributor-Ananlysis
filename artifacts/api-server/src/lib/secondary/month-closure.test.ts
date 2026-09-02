import { describe, expect, it } from "vitest";
import { isMonthClosed as dashboardIsMonthClosed } from "../mgmt/stateDashboard.js";
import {
  fyMonthLastDayMs,
  isMonthClosed as rulesIsMonthClosed,
} from "./rules.js";
import { assertSecAllMonthsPresent } from "./validate.js";

const FY = "2026-27";
const AUGUST_INDEX = 4;

describe("IST month closure", () => {
  it("closes August at IST midnight, UTC+05:30", () => {
    expect(new Date(fyMonthLastDayMs(AUGUST_INDEX, FY)).toISOString()).toBe(
      "2026-08-31T18:30:00.000Z",
    );
  });

  it.each([
    ["2026-08-31T12:00:00.000Z", false],
    ["2026-08-31T18:29:59.000Z", false],
    ["2026-08-31T18:30:00.000Z", true],
    ["2026-09-01T00:00:00.000Z", true],
  ])("agrees across all three helpers at %s", (iso, expected) => {
    const nowMs = Date.parse(iso);
    expect(rulesIsMonthClosed(AUGUST_INDEX, FY, nowMs)).toBe(expected);
    expect(dashboardIsMonthClosed(AUGUST_INDEX, FY, nowMs)).toBe(expected);

    const validation = assertSecAllMonthsPresent(FY, new Set(), nowMs);
    const requiredMonths = expected ? 5 : 4;
    expect(validation.detail).toContain(`missing ${requiredMonths} month(s)`);
  });
});