// Unit tests for the Growth Report cache invalidation logic.
//
// Tests three things (no real DB or Anthropic connection required):
//   1. invalidateGrowthReportCache() with no argument clears the whole cache Map.
//   2. invalidateGrowthReportCache(fy) clears only entries for that FY.
//   3. The dynamic import that invalidateMgmtDataCache() uses resolves
//      invalidateGrowthReportCache as a callable function.

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Module mocks (hoisted before imports) ────────────────────────────────────
// Heavy dependencies that would require a real DB / Anthropic key are stubbed
// so the route module loads cleanly in the test environment.

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      create: vi.fn().mockResolvedValue({ content: [] }),
      stream: vi.fn(),
    },
  },
}));

vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn().mockResolvedValue({ rows: [] }) },
  sql: new Proxy({}, { get: () => vi.fn() }),
}));

vi.mock("../lib/mgmt/distributorDeepDive.js", () => ({
  loadDistributorDeepDive: vi.fn(),
  toPriorYearMonths: vi.fn().mockReturnValue([]),
}));

vi.mock("../lib/schemes/nudge.js", () => ({
  computeNudgeList: vi.fn().mockResolvedValue({ rows: [], blocked: 0, total: 0 }),
}));

vi.mock("../lib/schemes/dues.js", () => ({
  getBlockedCustomers: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/mgmt/primaryPeriod.js", () => ({
  fiscalMonthsToLabels: vi.fn().mockReturnValue([]),
}));

vi.mock("../lib/mgmt/report.js", () => ({
  assembleRows: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/mgmt/numericGuard.js", () => ({
  runNumericGuard: vi.fn().mockReturnValue({ checked: 0, flagged: 0, flags: [] }),
}));

vi.mock("../lib/customers/registerSync.js", () => ({
  isFrozen: vi.fn().mockReturnValue(false),
}));

// ─────────────────────────────────────────────────────────────────────────────

import {
  invalidateGrowthReportCache,
  _growthCacheForTest,
} from "../routes/aiGrowthReport.js";

// The cache key format (from the source):
//   growth-report|{fy}|{scope}|{stateHead}|{state}|{mFrom}|{mTo}|{dr}|{ar}|{ru}
const CACHE_PREFIX = "growth-report|";

function makeKey(fy: string, scope = "company", extra = ""): string {
  return `${CACHE_PREFIX}${fy}|${scope}||${extra}|1|12|0.25|0.35|0.4`;
}

function seedCache(): void {
  // Two entries for 2026-27, one for 2025-26.
  _growthCacheForTest.set(makeKey("2026-27", "company"),       { payload: { a: 1 }, until: null });
  _growthCacheForTest.set(makeKey("2026-27", "statehead", "Anant Singh"), { payload: { b: 2 }, until: null });
  _growthCacheForTest.set(makeKey("2025-26", "company"),       { payload: { c: 3 }, until: null });
}

beforeEach(() => {
  _growthCacheForTest.clear();
});

// ── 1. Full clear ─────────────────────────────────────────────────────────────

describe("invalidateGrowthReportCache() — no argument", () => {
  it("clears every entry in the cache", () => {
    seedCache();
    expect(_growthCacheForTest.size).toBe(3);

    invalidateGrowthReportCache();

    expect(_growthCacheForTest.size).toBe(0);
  });

  it("is safe to call on an already-empty cache", () => {
    expect(_growthCacheForTest.size).toBe(0);
    expect(() => invalidateGrowthReportCache()).not.toThrow();
    expect(_growthCacheForTest.size).toBe(0);
  });
});

// ── 2. Per-FY clear ───────────────────────────────────────────────────────────

describe("invalidateGrowthReportCache(fy) — with a specific FY", () => {
  it("removes only entries whose key starts with the FY prefix", () => {
    seedCache();

    invalidateGrowthReportCache("2026-27");

    // Both 2026-27 entries should be gone; the 2025-26 entry must remain.
    expect(_growthCacheForTest.size).toBe(1);
    const remainingKey = [..._growthCacheForTest.keys()][0]!;
    expect(remainingKey).toContain("2025-26|");
    expect(remainingKey).not.toContain("2026-27|");
  });

  it("does not touch entries for other FYs", () => {
    seedCache();

    invalidateGrowthReportCache("2025-26");

    expect(_growthCacheForTest.size).toBe(2);
    for (const k of _growthCacheForTest.keys()) {
      expect(k).toContain("2026-27|");
    }
  });

  it("is a no-op when the FY has no cached entries", () => {
    seedCache();

    invalidateGrowthReportCache("2024-25");

    expect(_growthCacheForTest.size).toBe(3);
  });

  it("does not partially match a shorter FY prefix inside a longer one", () => {
    // '2026' is a prefix of '2026-27'; make sure the guard checks the full key.
    _growthCacheForTest.set(makeKey("2026-27", "company"), { payload: {}, until: null });

    // Invalidating '2026-27' must clear it; invalidating '2026' must not.
    invalidateGrowthReportCache("2026");

    expect(_growthCacheForTest.size).toBe(1);
  });
});

// ── 3. Dynamic import chain ───────────────────────────────────────────────────

describe("dynamic import chain (as used by invalidateMgmtDataCache)", () => {
  it("resolves invalidateGrowthReportCache as a callable function", async () => {
    // This mirrors the exact import path in invalidateMgmtDataCache():
    //   void import("./aiGrowthReport.js").then((m) => m.invalidateGrowthReportCache(fy))
    const m = await import("../routes/aiGrowthReport.js");

    expect(typeof m.invalidateGrowthReportCache).toBe("function");
  });

  it("the resolved function can be called without an FY (full-clear path)", async () => {
    const m = await import("../routes/aiGrowthReport.js");
    seedCache();

    // Simulates the .then() handler that invalidateMgmtDataCache() fires.
    expect(() => m.invalidateGrowthReportCache()).not.toThrow();
    expect(_growthCacheForTest.size).toBe(0);
  });

  it("the resolved function can be called with an FY (scoped-clear path)", async () => {
    const m = await import("../routes/aiGrowthReport.js");
    seedCache();

    expect(() => m.invalidateGrowthReportCache("2026-27")).not.toThrow();
    expect(_growthCacheForTest.size).toBe(1);
  });
});
