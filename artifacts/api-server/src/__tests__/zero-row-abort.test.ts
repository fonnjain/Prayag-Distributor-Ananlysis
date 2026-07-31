// Demonstrates the zero-row abort guard in doSync().
// Mocks readRegisterFromSheets to never invoke the row callback (0 rows built),
// then verifies versionedSyncLines is never reached and phase is set to 'error'.
// No real DB or Sheets API connection required.

import { vi, it, expect, describe, beforeEach } from "vitest";

// ── Module mocks (hoisted before imports) ────────────────────────────────────
// All spy references are resolved via vi.mocked() AFTER imports to avoid the
// "cannot access before initialization" TDZ error from hoisting.

vi.mock("../lib/registers/sheetsRegister.js", () => ({
  readRegisterFromSheets: vi.fn().mockResolvedValue({ rowsScanned: 0, tabsRead: [] }),
}));

vi.mock("../lib/registers/ingest.js", () => ({
  versionedSyncLines: vi.fn(),
  tombstoneOrphans: vi.fn(),
  identityKey: vi.fn(),
  insertSaleLineBatches: vi.fn(),
  assertFyCounts: vi.fn(),
  assertUnmappedEmpty: vi.fn(),
  assertSumConsistency: vi.fn(),
  assertNoNegativeAmounts: vi.fn(),
  EXPECTED_FY_COUNTS: {},
  EXPECTED_TOTAL_LINES: 0,
  BATCH_SIZE: 1000,
  countExistingLineUids: vi.fn(),
  markSheetConfirmed: vi.fn(),
  recordIngestRun: vi.fn(),
}));

vi.mock("../lib/registers/normalize.js", () => ({
  OccurrenceCounter: class { count() { return 1; } },
  emptyUnmapped: () => ({ unmapped_groups: {}, unmapped_heads: {}, unmapped_states: {} }),
  parseRegisterRow: vi.fn(),
  toSaleLine: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [{ n: "1" }] }) },
  db: {},
  saleLines: {},
  itemMaster: {},
  ingestRuns: {},
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { runScheduledTick, getRegisterSyncState } from "../lib/customers/registerSync.js";
import { versionedSyncLines } from "../lib/registers/ingest.js";
import { logger } from "../lib/logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Poll until the open-FY sync reaches a terminal phase (max 10 s).
 *  doSync awaits the persisted-baseline load BEFORE setting phase='syncing',
 *  so the state can still read 'idle' briefly after the tick fires — treat
 *  both 'idle' and 'syncing' as in-progress. */
async function waitForSyncPhase(
  fy: string,
  _notPhase: string,
  timeoutMs = 10_000,
): Promise<{ phase: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = getRegisterSyncState(fy);
    if (state.phase !== "syncing" && state.phase !== "idle") return state;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for sync to reach a terminal phase`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("doSync zero-row abort guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(versionedSyncLines).mockResolvedValue({
      touched: 0, superseded: 0, inserted: 0, tombstoned: 0,
      revived: 0, incomingCountByFyMonth: new Map<string, number>(),
    });
  });

  it("aborts before versionedSyncLines and sets error phase when sheet returns 0 rows", async () => {
    // Trigger one scheduled tick. readRegisterFromSheets is mocked to return
    // immediately without calling the row callback → lines stays [].
    runScheduledTick();

    // Wait for doSync to complete (runs async via the inFlight Promise).
    const state = await waitForSyncPhase("2026-27", "syncing");

    // 1. versionedSyncLines must not have been called.
    expect(vi.mocked(versionedSyncLines)).not.toHaveBeenCalled();

    // 2. Phase must be 'error', not 'done'.
    expect(state.phase).toBe("error");

    // 3. Error message must name the abort reason (not a generic catch block).
    expect(state.error).toMatch(/zero rows/i);

    // 4. logger.error must have fired with the abort message.
    const errorCalls = vi.mocked(logger).error.mock.calls;
    const abortLog = errorCalls.find((args) => String(args[1]).includes("zero rows"));
    expect(abortLog).toBeDefined();

    console.log("\n── Zero-row abort evidence ─────────────────────────────────");
    console.log(`  phase:               ${state.phase}`);
    console.log(`  error:               ${state.error ?? "(none)"}`);
    console.log(`  versionedSyncLines:  called ${vi.mocked(versionedSyncLines).mock.calls.length}×  ← must be 0`);
    console.log(`  logger.error msg:    "${String(abortLog?.[1])}"`);
    console.log("────────────────────────────────────────────────────────────\n");
  });
});
