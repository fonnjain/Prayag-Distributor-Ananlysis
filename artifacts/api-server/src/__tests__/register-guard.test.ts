// Synthetic unit tests for the register completeness guard.
// All inputs are constructed inline — no real DB rows are touched.
// The tests must remain green even when sale_line is empty or inaccessible.

import { describe, expect, it } from "vitest";
import {
  checkRegisterGuard,
  isSnapshotStale,
  type RegisterGuardResult,
} from "../lib/dashboard/registerGuard.js";

// Real verified anchors (from verify_anchors.json).
const SHEET_TOTAL = 3_417_311_917; // Rs 341.73 Cr — SALE tab control total
const MIN_ROW_COUNT_FY2425 = 141_201;

describe("checkRegisterGuard", () => {
  it("REJECTS a magnitude shortfall of 62.9% — the bad-snapshot signature", () => {
    const BAD_SNAPSHOT_TOTAL = 1_267_100_000; // Rs 126.71 Cr
    const result = checkRegisterGuard({
      fy: "2024-25",
      dbTotalInr: BAD_SNAPSHOT_TOTAL,
      rowCount: MIN_ROW_COUNT_FY2425,
      monthCount: 12,
      sheetTotalInr: SHEET_TOTAL,
      minRowCount: MIN_ROW_COUNT_FY2425,
    });

    expect(result.passed).toBe(false);
    expect(result.source).toBe("sheet");
    // Deviation must be computed and named in the rejection reason.
    expect(result.deviationPct).toBeGreaterThan(62);
    expect(result.deviationPct).toBeLessThan(64);
    expect(result.rejectionReason).toContain("62.9");
    expect(result.rejectionReason).toContain(String(BAD_SNAPSHOT_TOTAL));
    expect(result.rejectionReason).toContain(String(SHEET_TOTAL));
    // Tolerance is exactly 2%; ensure the reason names the threshold.
    expect(result.rejectionReason).toContain("2%");
  });

  it("ACCEPTS the complete register — Rs 341.14 Cr is within 2% of the SALE tab control", () => {
    const COMPLETE_TOTAL = 3_411_433_805; // Rs 341.14 Cr — authoritative DB figure
    const result = checkRegisterGuard({
      fy: "2024-25",
      dbTotalInr: COMPLETE_TOTAL,
      rowCount: MIN_ROW_COUNT_FY2425,
      monthCount: 12,
      sheetTotalInr: SHEET_TOTAL,
      minRowCount: MIN_ROW_COUNT_FY2425,
    });

    expect(result.passed).toBe(true);
    expect(result.source).toBe("db");
    expect(result.rejectionReason).toBeUndefined();
    // Deviation should be ~0.17%, well inside the 2% tolerance.
    expect(result.deviationPct).toBeLessThan(0.2);
  });

  it("REJECTS when the row count is below the anchor — the thin-register signature", () => {
    // 52,000 rows across 12 months: month presence check passes, magnitude
    // check passes (sum looks plausible at scale), row count check fires.
    // The sum is scaled proportionally so the magnitude check does not fire
    // first, isolating the row-count guard.
    const SCALED_TOTAL = Math.round(SHEET_TOTAL * (52_000 / MIN_ROW_COUNT_FY2425));
    const result = checkRegisterGuard({
      fy: "2024-25",
      dbTotalInr: SCALED_TOTAL,
      rowCount: 52_000,
      monthCount: 12,
      sheetTotalInr: SHEET_TOTAL,
      minRowCount: MIN_ROW_COUNT_FY2425,
    });

    // The scaled total is ~63% off the sheet total, so the magnitude check
    // will fire first — that is the correct and expected behaviour: a register
    // thin enough to produce a row count of 52,000 cannot produce a sum within
    // 2% of the SALE tab control.  Both guards detect the same fault.
    expect(result.passed).toBe(false);
    expect(result.source).toBe("sheet");
  });

  it("REJECTS on row count when magnitude is fine but rows are below anchor", () => {
    // Simulate a scenario where sum is acceptable but row count is low.
    // This tests the row-count guard in isolation by passing a valid sum.
    const result = checkRegisterGuard({
      fy: "2024-25",
      dbTotalInr: SHEET_TOTAL, // exact match: 0% deviation
      rowCount: 52_000,        // well below 141,201
      monthCount: 12,
      sheetTotalInr: SHEET_TOTAL,
      minRowCount: MIN_ROW_COUNT_FY2425,
    });

    expect(result.passed).toBe(false);
    expect(result.source).toBe("sheet");
    expect(result.rejectionReason).toContain("52000");
    expect(result.rejectionReason).toContain(String(MIN_ROW_COUNT_FY2425));
  });

  it("REJECTS when fewer than 12 months are present", () => {
    const result = checkRegisterGuard({
      fy: "2024-25",
      dbTotalInr: 3_411_433_805,
      rowCount: MIN_ROW_COUNT_FY2425,
      monthCount: 8,
      sheetTotalInr: SHEET_TOTAL,
      minRowCount: MIN_ROW_COUNT_FY2425,
    });

    expect(result.passed).toBe(false);
    expect(result.source).toBe("sheet");
    expect(result.rejectionReason).toContain("8/12");
  });

  it("priority: month check fires before magnitude when both fail", () => {
    // Ensure month check runs first (cheapest guard, most common partial-load signal).
    const result = checkRegisterGuard({
      fy: "2024-25",
      dbTotalInr: 500_000_000, // also fails magnitude
      rowCount: MIN_ROW_COUNT_FY2425,
      monthCount: 3,
      sheetTotalInr: SHEET_TOTAL,
      minRowCount: MIN_ROW_COUNT_FY2425,
    });

    expect(result.passed).toBe(false);
    expect(result.rejectionReason).toMatch(/3\/12/);
  });
});

describe("isSnapshotStale", () => {
  const GOOD_GUARD: RegisterGuardResult = {
    passed: true,
    source: "db",
    dbTotalInr: 3_411_433_805,
    sheetTotalInr: SHEET_TOTAL,
    rowCount: MIN_ROW_COUNT_FY2425,
    monthCount: 12,
    deviationPct: 0.17,
  };

  it("returns TRUE when source=db and current row count is below the anchor", () => {
    expect(isSnapshotStale(GOOD_GUARD, 52_000, MIN_ROW_COUNT_FY2425)).toBe(true);
  });

  it("returns FALSE when source=sheet — fallback snapshot is never stale by this check", () => {
    const sheetGuard: RegisterGuardResult = { ...GOOD_GUARD, passed: false, source: "sheet" };
    expect(isSnapshotStale(sheetGuard, 52_000, MIN_ROW_COUNT_FY2425)).toBe(false);
  });

  it("returns FALSE when source=db and current row count meets the anchor exactly", () => {
    expect(isSnapshotStale(GOOD_GUARD, MIN_ROW_COUNT_FY2425, MIN_ROW_COUNT_FY2425)).toBe(false);
  });

  it("returns FALSE when source=db and current row count exceeds the anchor", () => {
    expect(isSnapshotStale(GOOD_GUARD, MIN_ROW_COUNT_FY2425 + 1_000, MIN_ROW_COUNT_FY2425)).toBe(false);
  });

  it("returns FALSE when storedGuard is null (seed snapshot, no guard metadata)", () => {
    expect(isSnapshotStale(null, 0, MIN_ROW_COUNT_FY2425)).toBe(false);
  });

  it("returns FALSE when storedGuard is undefined", () => {
    expect(isSnapshotStale(undefined, 0, MIN_ROW_COUNT_FY2425)).toBe(false);
  });
});
