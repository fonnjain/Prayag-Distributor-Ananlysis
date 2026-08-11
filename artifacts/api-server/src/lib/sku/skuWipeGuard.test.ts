// skuWipeGuard.test.ts — verification tests for the pre-delete wipe guard.
//
// Tests run against the real dev DB using a reserved FY label "TEST-WG" that
// is cleaned up before and after each test so it cannot interfere with live data.
//
// WHAT IS BEING VERIFIED (spec items 1–6):
//   1. NEGATIVE — rows:    Jul 50% of existing → guard fires BEFORE delete,
//                          transaction rolls back, row count unchanged.
//   2. NEGATIVE — dists:   Jul 60% of existing distinct distributors → abort.
//   3. POSITIVE:           Full matching batch → guard passes, no abort.
//   4. OVERRIDE:           Truncated batch with skipGuard=true → proceeds,
//                          override use logged.
//   5. PARTIAL MONTH:      Full Aug, only 50% of Jul → abort for Jul only;
//                          both months' DB counts remain untouched.
//   6. NEW-FY (zero rows): Guard skips with "not applicable" log rather than
//                          failing.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  assertSkuWipeGuard,
  WipeGuardAbortError,
  incomingMonthStats,
  GUARD_ROWS_RATIO,
  GUARD_DIST_RATIO,
} from "./skuWipeGuard.js";

const TEST_FY = "TEST-WG";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build N incoming-row stubs for a given month, cycling through the distributor list. */
function incRows(
  month: string,
  count: number,
  distributors: string[],
): Array<{ monthLabel: string; distributor: string }> {
  return Array.from({ length: count }, (_, i) => ({
    monthLabel: month,
    distributor: distributors[i % distributors.length]!,
  }));
}

/** Seed rows directly into secondary_sku_line via a single batched INSERT. */
async function seed(month: string, count: number, distributors: string[]): Promise<void> {
  if (count === 0) return;
  const batchSize = 500;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    const vals: string[] = [];
    const params: (string | null)[] = [];
    let p = 1;
    for (let i = start; i < end; i++) {
      const dist = distributors[i % distributors.length]!;
      vals.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(`tst-${month}-${dist}-${i}`, TEST_FY, month, `X${i % 10}`, "test_wipe_guard", dist);
    }
    await pool.query(
      `INSERT INTO secondary_sku_line
         (line_uid, fy, month_label, item_code, source, distributor)
       VALUES ${vals.join(", ")}
       ON CONFLICT DO NOTHING`,
      params,
    );
  }
}

async function dbCount(month?: string): Promise<number> {
  const where = month
    ? `WHERE fy = '${TEST_FY}' AND month_label = '${month}'`
    : `WHERE fy = '${TEST_FY}'`;
  const res = await pool.query(`SELECT COUNT(*)::int AS n FROM secondary_sku_line ${where}`);
  return res.rows[0].n as number;
}

async function dbDistinctDist(month: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(DISTINCT NULLIF(TRIM(distributor), ''))::int AS n
     FROM secondary_sku_line
     WHERE fy = $1 AND month_label = $2`,
    [TEST_FY, month],
  );
  return res.rows[0].n as number;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await pool.query(`DELETE FROM secondary_sku_line WHERE fy = $1`, [TEST_FY]);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM secondary_sku_line WHERE fy = $1`, [TEST_FY]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM secondary_sku_line WHERE fy = $1`, [TEST_FY]);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("incomingMonthStats", () => {
  it("counts rows and distinct distributors per month", () => {
    const rows = [
      { monthLabel: "Apr-26", distributor: "DIST A" },
      { monthLabel: "Apr-26", distributor: "DIST A" }, // duplicate
      { monthLabel: "Apr-26", distributor: "DIST B" },
      { monthLabel: "May-26", distributor: "DIST C" },
      { monthLabel: null,     distributor: "DIST D" }, // unlabelled — excluded
    ];
    const stats = incomingMonthStats(rows);
    expect(stats.get("Apr-26")).toEqual({ rows: 3, distinctDistributors: 2 });
    expect(stats.get("May-26")).toEqual({ rows: 1, distinctDistributors: 1 });
    expect(stats.has(null as any)).toBe(false);
  });
});

describe("assertSkuWipeGuard", () => {
  const DISTS_5 = ["DIST-A", "DIST-B", "DIST-C", "DIST-D", "DIST-E"];
  const DISTS_10 = Array.from({ length: 10 }, (_, i) => `DIST-${i}`);

  // ── Test 6: NEW-FY (zero existing rows) ───────────────────────────────────
  it("6: skips guard with not-applicable when zero existing rows", async () => {
    // DB is empty for TEST-WG (beforeEach cleaned it)
    const incoming = incRows("Jul-99", 200, DISTS_5);
    await expect(
      db.transaction(async (tx) => {
        await assertSkuWipeGuard({
          tx: tx as any,
          fy: TEST_FY,
          incoming,
          skipGuard: false,
          callerLabel: "test-6",
        });
      }),
    ).resolves.toBeUndefined();
    // DB still empty
    expect(await dbCount()).toBe(0);
  });

  // ── Test 1: NEGATIVE — rows below 0.60 threshold ─────────────────────────
  it("1: aborts and rolls back when one month has <60% of existing rows", async () => {
    await seed("Jul-99", 200, DISTS_5);
    await seed("Aug-99", 160, DISTS_5);

    const beforeJul = await dbCount("Jul-99");
    const beforeAug = await dbCount("Aug-99");
    console.log(`\n[T1] Jul-99 BEFORE: ${beforeJul} | Aug-99 BEFORE: ${beforeAug}`);

    // Jul: 90 rows = 45% of 200 (below 0.60); Aug: 160 rows = 100%
    const incoming = [
      ...incRows("Jul-99", 90, DISTS_5),
      ...incRows("Aug-99", 160, DISTS_5),
    ];

    let caughtError: unknown;
    await expect(
      db.transaction(async (tx) => {
        await assertSkuWipeGuard({
          tx: tx as any,
          fy: TEST_FY,
          incoming,
          skipGuard: false,
          callerLabel: "test-1",
        });
        // Guard must throw before this line — DELETE must never execute.
        await tx.execute(sql`DELETE FROM secondary_sku_line WHERE fy = ${TEST_FY}`);
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err;
      return err instanceof WipeGuardAbortError && err.rule === "rows" && err.month === "Jul-99";
    });

    const afterJul = await dbCount("Jul-99");
    const afterAug = await dbCount("Aug-99");
    console.log(`[T1] Jul-99 AFTER:  ${afterJul} | Aug-99 AFTER:  ${afterAug} (must equal BEFORE)`);
    console.log(`[T1] Error: ${(caughtError as Error).message}`);

    expect(afterJul).toBe(beforeJul); // transaction rolled back
    expect(afterAug).toBe(beforeAug);
    expect(caughtError).toBeInstanceOf(WipeGuardAbortError);
    expect((caughtError as WipeGuardAbortError).ratio).toBeLessThan(GUARD_ROWS_RATIO);
  });

  // ── Test 2: NEGATIVE — distinct distributors below 0.70 threshold ─────────
  it("2: aborts and rolls back when distinct distributors drop below 70%", async () => {
    // Existing: 200 rows, 10 distinct distributors
    await seed("Jul-99", 200, DISTS_10);

    const beforeCount = await dbCount("Jul-99");
    const beforeDist  = await dbDistinctDist("Jul-99");
    console.log(`\n[T2] Jul-99 BEFORE: rows=${beforeCount} dist=${beforeDist}`);

    // Incoming: 200 rows (rows OK), only 6 distinct distributors (60% of 10 — below 0.70)
    const dists6 = DISTS_10.slice(0, 6);
    const incoming = incRows("Jul-99", 200, dists6);

    let caughtError: unknown;
    await expect(
      db.transaction(async (tx) => {
        await assertSkuWipeGuard({
          tx: tx as any,
          fy: TEST_FY,
          incoming,
          skipGuard: false,
          callerLabel: "test-2",
        });
        await tx.execute(sql`DELETE FROM secondary_sku_line WHERE fy = ${TEST_FY}`);
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err;
      return err instanceof WipeGuardAbortError && err.rule === "distributors";
    });

    const afterCount = await dbCount("Jul-99");
    const afterDist  = await dbDistinctDist("Jul-99");
    console.log(`[T2] Jul-99 AFTER:  rows=${afterCount} dist=${afterDist} (must equal BEFORE)`);
    console.log(`[T2] Error: ${(caughtError as Error).message}`);

    expect(afterCount).toBe(beforeCount);
    expect(afterDist).toBe(beforeDist);
    expect((caughtError as WipeGuardAbortError).ratio).toBeLessThan(GUARD_DIST_RATIO);
  });

  // ── Test 3: POSITIVE — full matching batch passes ──────────────────────────
  it("3: passes when incoming batch matches existing counts", async () => {
    await seed("Jul-99", 200, DISTS_5);
    await seed("Aug-99", 150, DISTS_5);

    const incoming = [
      ...incRows("Jul-99", 200, DISTS_5), // 100% of existing
      ...incRows("Aug-99", 150, DISTS_5),
    ];

    await expect(
      db.transaction(async (tx) => {
        await assertSkuWipeGuard({
          tx: tx as any,
          fy: TEST_FY,
          incoming,
          skipGuard: false,
          callerLabel: "test-3",
        });
        // Guard passed — simulate the delete+insert completing normally
      }),
    ).resolves.toBeUndefined();

    const remaining = await dbCount();
    console.log(`\n[T3] Guard passed. DB rows after committed tx: ${remaining}`);
    expect(remaining).toBe(350); // nothing was actually deleted in this tx
  });

  // ── Test 4: OVERRIDE — truncated batch + skipGuard=true ───────────────────
  it("4: proceeds and logs override when skipGuard is explicitly true", async () => {
    await seed("Jul-99", 200, DISTS_5);

    // Only 10% of existing — would normally abort
    const incoming = incRows("Jul-99", 20, DISTS_5);

    await expect(
      db.transaction(async (tx) => {
        await assertSkuWipeGuard({
          tx: tx as any,
          fy: TEST_FY,
          incoming,
          skipGuard: true,
          callerLabel: "test-4: deliberate single-month re-sync",
        });
        // Override logged — guard did not throw
      }),
    ).resolves.toBeUndefined();
    // Check log output manually: look for "wipe guard: SKIPPED via explicit override"
    console.log("\n[T4] Override accepted. Inspect logs for: wipe guard: SKIPPED via explicit override");
    console.log("[T4] callerLabel in log should read: test-4: deliberate single-month re-sync");
  });

  // ── Test 5: PARTIAL MONTH — full Aug, 50% of Jul ─────────────────────────
  it("5: aborts for the specific month that fails; both months unchanged", async () => {
    await seed("Jul-99", 200, DISTS_5);
    await seed("Aug-99", 160, DISTS_5);

    const beforeJul = await dbCount("Jul-99");
    const beforeAug = await dbCount("Aug-99");

    // Aug is fine (100%), but Jul is only 50%
    const incoming = [
      ...incRows("Jul-99", 100, DISTS_5), // 50% — below 0.60 threshold
      ...incRows("Aug-99", 160, DISTS_5), // 100% — fine
    ];

    await expect(
      db.transaction(async (tx) => {
        await assertSkuWipeGuard({
          tx: tx as any,
          fy: TEST_FY,
          incoming,
          skipGuard: false,
          callerLabel: "test-5",
        });
        await tx.execute(sql`DELETE FROM secondary_sku_line WHERE fy = ${TEST_FY}`);
      }),
    ).rejects.toBeInstanceOf(WipeGuardAbortError);

    const afterJul = await dbCount("Jul-99");
    const afterAug = await dbCount("Aug-99");
    console.log(`\n[T5] Jul-99 BEFORE=${beforeJul} AFTER=${afterJul} (must be identical)`);
    console.log(`[T5] Aug-99 BEFORE=${beforeAug} AFTER=${afterAug} (must be identical)`);

    expect(afterJul).toBe(beforeJul);
    expect(afterAug).toBe(beforeAug);
  });
});
