// Rule-based sync scope: openMonthLabels must include every unfrozen month of
// the FY whose calendar month has started — including an empty current month —
// and exclude frozen and future months.
import { describe, it, expect } from "vitest";
import {
  openMonthLabels,
  isMonthFrozen,
  isEffectivelyFrozen,
  monthFreezeAt,
  OPEN_WINDOW_PRIOR_MONTHS,
  SHORT_READ_TOLERANCE,
} from "../lib/registers/monthlyReplace.js";

describe("openMonthLabels", () => {
  it("keeps the current month plus three prior open", () => {
    const now = new Date(Date.UTC(2026, 7, 1, 12)); // 1 Aug 2026
    expect(OPEN_WINDOW_PRIOR_MONTHS).toBe(3);
    expect(openMonthLabels("2026-27", now)).toEqual(["May-26", "Jun-26", "Jul-26", "Aug-26"]);
  });

  it("freezes at IST midnight on the first day four months later", () => {
    const justBefore = new Date("2026-09-30T18:29:59.999Z");
    const atFreeze = new Date("2026-09-30T18:30:00.000Z");
    expect(monthFreezeAt("Jun-26")?.toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(isMonthFrozen("Jun-26", justBefore)).toBe(false);
    expect(isMonthFrozen("Jun-26", atFreeze)).toBe(true);
    expect(openMonthLabels("2026-27", justBefore)).toEqual(["Jun-26", "Jul-26", "Aug-26", "Sep-26"]);
    expect(openMonthLabels("2026-27", atFreeze)).toEqual(["Jul-26", "Aug-26", "Sep-26", "Oct-26"]);
  });

  it("1 Sep IST: June through September are in scope", () => {
    const now = new Date(Date.UTC(2026, 8, 1));
    expect(openMonthLabels("2026-27", now)).toEqual(["Jun-26", "Jul-26", "Aug-26", "Sep-26"]);
  });

  it("FY year boundary: 2 Jan 2027 gives Oct-26 through Jan-27", () => {
    const now = new Date(Date.UTC(2027, 0, 2));
    expect(openMonthLabels("2026-27", now)).toEqual(["Oct-26", "Nov-26", "Dec-26", "Jan-27"]);
  });

  it("closed FY: every month frozen, empty scope", () => {
    const now = new Date(Date.UTC(2026, 7, 1));
    expect(openMonthLabels("2025-26", now)).toEqual([]);
  });

  it("unparseable FY yields empty scope", () => {
    expect(openMonthLabels("garbage", new Date(Date.UTC(2026, 7, 1)))).toEqual([]);
  });

  it("persisted frozen state remains authoritative when the clock widens", () => {
    const now = new Date("2026-09-08T00:00:00.000Z");
    expect(isMonthFrozen("Jun-26", now)).toBe(false);
    expect(isEffectivelyFrozen(false, new Date("2026-08-01T07:46:31.526Z"))).toBe(true);
  });
});

describe("empty-month guard arithmetic", () => {
  // Mirrors the guard condition in processOneMonth.
  const guardFires = (lastGood: number | null, sheetRows: number) =>
    lastGood != null &&
    lastGood > 0 &&
    (sheetRows === 0 || sheetRows < Math.floor(lastGood * SHORT_READ_TOLERANCE));

  it("a 0 baseline never trips the guard — empty months are normal no-ops", () => {
    expect(guardFires(0, 0)).toBe(false);
    expect(guardFires(0, 500)).toBe(false);
    expect(guardFires(null, 0)).toBe(false);
  });

  it("an empty read against ANY positive baseline aborts, even 1 row (floor rounding gap)", () => {
    expect(guardFires(1, 0)).toBe(true);
    expect(guardFires(50, 0)).toBe(true);
    expect(guardFires(11848, 0)).toBe(true);
  });

  it("materially-short positive reads abort; within-tolerance reads pass", () => {
    expect(guardFires(11848, 11000)).toBe(true);   // below 98%
    expect(guardFires(11848, 11700)).toBe(false);  // within tolerance
  });
});

describe("strict freeze-transition guard arithmetic", () => {
  // Mirrors the strict condition in processOneMonth: at the freeze transition
  // even a ONE-row shortfall vs the last good read must abort the freeze.
  const freezeAborts = (lastGood: number | null, sheetRows: number) =>
    lastGood != null && sheetRows < lastGood;

  it("aborts a freeze on any shortfall, even one row", () => {
    expect(freezeAborts(13803, 13802)).toBe(true);
    expect(freezeAborts(13803, 13783)).toBe(true); // the July 2026 incident: 0.14% short, inside the 98% daily tolerance
  });
  it("allows a freeze at parity or growth", () => {
    expect(freezeAborts(13803, 13803)).toBe(false);
    expect(freezeAborts(13803, 13850)).toBe(false);
    expect(freezeAborts(null, 0)).toBe(false); // never-read month cannot abort
  });
});
