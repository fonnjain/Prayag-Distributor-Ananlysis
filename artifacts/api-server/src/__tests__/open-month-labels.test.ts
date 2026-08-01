// Rule-based sync scope: openMonthLabels must include every unfrozen month of
// the FY whose calendar month has started — including an empty current month —
// and exclude frozen and future months.
import { describe, it, expect } from "vitest";
import { openMonthLabels, isMonthFrozen, SHORT_READ_TOLERANCE } from "../lib/registers/monthlyReplace.js";

describe("openMonthLabels", () => {
  it("1–6 Aug: prior month (edit window) AND current month are both in scope", () => {
    const now = new Date(Date.UTC(2026, 7, 1, 12)); // 1 Aug 2026
    expect(openMonthLabels("2026-27", now)).toEqual(["Jul-26", "Aug-26"]);
  });

  it("7 Aug: July freezes, only August remains", () => {
    const now = new Date(Date.UTC(2026, 7, 7, 0, 0, 1)); // 7 Aug 2026
    expect(isMonthFrozen("Jul-26", now)).toBe(true);
    expect(openMonthLabels("2026-27", now)).toEqual(["Aug-26"]);
  });

  it("mid-month (20 Aug): only August", () => {
    const now = new Date(Date.UTC(2026, 7, 20));
    expect(openMonthLabels("2026-27", now)).toEqual(["Aug-26"]);
  });

  it("1 Sep: August (edit window) and September", () => {
    const now = new Date(Date.UTC(2026, 8, 1));
    expect(openMonthLabels("2026-27", now)).toEqual(["Aug-26", "Sep-26"]);
  });

  it("FY year boundary: 2 Jan 2027 gives Dec-26 and Jan-27", () => {
    const now = new Date(Date.UTC(2027, 0, 2));
    expect(openMonthLabels("2026-27", now)).toEqual(["Dec-26", "Jan-27"]);
  });

  it("closed FY: every month frozen, empty scope", () => {
    const now = new Date(Date.UTC(2026, 7, 1));
    expect(openMonthLabels("2025-26", now)).toEqual([]);
  });

  it("unparseable FY yields empty scope", () => {
    expect(openMonthLabels("garbage", new Date(Date.UTC(2026, 7, 1)))).toEqual([]);
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
