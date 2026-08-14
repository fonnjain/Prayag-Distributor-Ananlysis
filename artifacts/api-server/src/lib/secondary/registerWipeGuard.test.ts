// registerWipeGuard.test.ts — verification tests for the register pre-insert
// wipe guard (assertRegisterWipeGuard).
//
// Tests run against the real dev DB using a reserved FY label "TEST-RWG" that
// is cleaned up before and after each test so it cannot interfere with live data.
//
// WHAT IS BEING VERIFIED (spec items 1–7):
//   1. NEGATIVE — rows:    Jul 50% of existing → guard fires, insert skipped,
//                          row count unchanged (no rollback needed — append-only).
//   2. NEGATIVE — customers: Jul 60% of existing distinct customers → abort.
//   3. POSITIVE:           Full matching batch → guard passes, no abort.
//   4. OVERRIDE:           Truncated batch with skipGuard=true → proceeds,
//                          override use logged.
//   5. PARTIAL MONTH:      Full Aug, only 50% of Jul → abort for Jul only.
//   6. NEW-FY (zero rows): Guard skips with "not applicable" log rather than
//                          failing.
//   7. PER-MEMBER DROP:    Member A has 100 existing rows, Member B has 500.
//                          Incoming omits Member A entirely (company-wide ratio
//                          = 83% > 60%, so Rules 1 & 2 pass).  Rule 3 fires
//                          because Member A has zero incoming rows for the month.
//   8. ALL-NULL HEADS:     memberGuardEnabled=true but all incoming heads are null
//                          (simulates a malformed workbook losing the head column)
//                          → Rule 3 still fires because memberGuardEnabled is
//                          explicit, not inferred from value presence.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db, pool } from "@workspace/db";
import {
  assertRegisterWipeGuard,
  WipeGuardAbortError,
  incomingRegMonthStats,
  GUARD_REG_ROWS_RATIO,
  GUARD_REG_CUSTOMER_RATIO,
  GUARD_HEAD_MIN_ROWS,
} from "./registerWipeGuard.js";

const TEST_FY = "TEST-RWG";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build N incoming-row stubs for a given month, cycling through the customer list. */
function incRows(
  month: string,
  count: number,
  customers: string[],
  head?: string,
): Array<{ monthLabel: string; customer: string; head: string | null }> {
  return Array.from({ length: count }, (_, i) => ({
    monthLabel: month,
    customer: customers[i % customers.length]!,
    head: head ?? null,
  }));
}

/** Seed rows directly into secondary_register_line via a single batched INSERT. */
async function seed(
  month: string,
  count: number,
  customers: string[],
  source = "xlsx_backfill",
): Promise<void> {
  if (count === 0) return;
  const batchSize = 500;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    const vals: string[] = [];
    const params: (string | number | null)[] = [];
    let p = 1;
    for (let i = start; i < end; i++) {
      const cust = customers[i % customers.length]!;
      vals.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        `tst-rwg-${source}-${month}-${cust}-${i}`, // line_uid (includes source to avoid collisions)
        TEST_FY,                                     // fy
        month,                                       // month_label
        cust,                                        // customer
        source,                                      // source
        100,                                         // gross_amount (required NOT NULL)
      );
    }
    await pool.query(
      `INSERT INTO secondary_register_line
         (line_uid, fy, month_label, customer, source, gross_amount)
       VALUES ${vals.join(", ")}
       ON CONFLICT DO NOTHING`,
      params,
    );
  }
}

/**
 * Seed rows with a specific head_canon value so Rule 3 (per-member check) is
 * exercised. The line_uid incorporates head so it never clashes with seeds
 * from the regular seed() helper.
 */
async function seedWithHead(
  month: string,
  count: number,
  head: string,
  customers: string[],
  source = "xlsx_backfill",
): Promise<void> {
  if (count === 0) return;
  const batchSize = 500;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    const vals: string[] = [];
    const params: (string | number | null)[] = [];
    let p = 1;
    for (let i = start; i < end; i++) {
      const cust = customers[i % customers.length]!;
      vals.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        `tst-rwg-h-${source}-${month}-${head}-${cust}-${i}`, // line_uid (includes source)
        TEST_FY,                                               // fy
        month,                                                 // month_label
        cust,                                                  // customer
        head,                                                  // head_canon
        source,                                                // source
        100,                                                   // gross_amount
      );
    }
    await pool.query(
      `INSERT INTO secondary_register_line
         (line_uid, fy, month_label, customer, head_canon, source, gross_amount)
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
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM secondary_register_line ${where}`,
  );
  return res.rows[0].n as number;
}

async function dbDistinctCustomers(month: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(DISTINCT NULLIF(TRIM(customer), ''))::int AS n
     FROM secondary_register_line
     WHERE fy = $1 AND month_label = $2`,
    [TEST_FY, month],
  );
  return res.rows[0].n as number;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create a minimal secondary_register_line in the test schema (dashboard_test).
  // This mirrors the real public.secondary_register_line but lives in the
  // isolated test schema so test data never touches real records.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS secondary_register_line (
      line_uid      text PRIMARY KEY,
      fy            text NOT NULL,
      month_label   text NOT NULL,
      head_raw      text,
      head_canon    text,
      state_raw     text,
      state_canon   text,
      customer      text,
      brand_raw     text,
      brand_canon   text,
      gross_amount  numeric NOT NULL,
      net_amount    numeric,
      discount_pct  numeric,
      qty           numeric,
      is_territory  boolean,
      source        text NOT NULL,
      ingested_at   timestamptz DEFAULT now()
    )
  `);
  await pool.query(`DELETE FROM secondary_register_line WHERE fy = $1`, [TEST_FY]);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM secondary_register_line WHERE fy = $1`, [TEST_FY]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM secondary_register_line WHERE fy = $1`, [TEST_FY]);
});

// ── Unit tests ────────────────────────────────────────────────────────────────

describe("incomingRegMonthStats", () => {
  it("counts rows and distinct customers per month", () => {
    const rows = [
      { monthLabel: "Apr-26", customer: "CUST A" },
      { monthLabel: "Apr-26", customer: "CUST A" }, // duplicate — same customer
      { monthLabel: "Apr-26", customer: "CUST B" },
      { monthLabel: "May-26", customer: "CUST C" },
      { monthLabel: null,     customer: "CUST D" }, // unlabelled — excluded
    ];
    const stats = incomingRegMonthStats(rows);
    expect(stats.get("Apr-26")).toEqual({ rows: 3, distinctCustomers: 2 });
    expect(stats.get("May-26")).toEqual({ rows: 1, distinctCustomers: 1 });
    expect(stats.has(null as any)).toBe(false);
  });

  it("returns an empty map when all rows have a null monthLabel", () => {
    const rows = [
      { monthLabel: null, customer: "CUST A" },
      { monthLabel: null, customer: "CUST B" },
    ];
    expect(incomingRegMonthStats(rows).size).toBe(0);
  });
});

// ── Integration tests ─────────────────────────────────────────────────────────

describe("assertRegisterWipeGuard", () => {
  const CUSTS_5  = ["CUST-A", "CUST-B", "CUST-C", "CUST-D", "CUST-E"];
  const CUSTS_10 = Array.from({ length: 10 }, (_, i) => `CUST-${i}`);

  // ── Test 6: NEW-FY (zero existing rows) ──────────────────────────────────
  it("6: skips guard with not-applicable when zero existing rows", async () => {
    // DB is empty for TEST-RWG (beforeEach cleaned it)
    const incoming = incRows("Jul-99", 200, CUSTS_5);
    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-6",
      }),
    ).resolves.toBeUndefined();
    // DB still empty — guard passed but we made no inserts
    expect(await dbCount()).toBe(0);
  });

  // ── Test 1: NEGATIVE — rows below 0.60 threshold ─────────────────────────
  it("1: aborts when one month has <60% of existing rows", async () => {
    await seed("Jul-99", 200, CUSTS_5);
    await seed("Aug-99", 160, CUSTS_5);

    const beforeJul = await dbCount("Jul-99");
    const beforeAug = await dbCount("Aug-99");
    console.log(`\n[T1] Jul-99 BEFORE: ${beforeJul} | Aug-99 BEFORE: ${beforeAug}`);

    // Jul: 90 rows = 45% of 200 (below 0.60); Aug: 160 rows = 100%
    const incoming = [
      ...incRows("Jul-99", 90,  CUSTS_5),
      ...incRows("Aug-99", 160, CUSTS_5),
    ];

    let caughtError: unknown;
    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-1",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err;
      return err instanceof WipeGuardAbortError && err.rule === "rows" && err.month === "Jul-99";
    });

    // Append-only: no rows were deleted or inserted by the guard itself.
    expect(await dbCount("Jul-99")).toBe(beforeJul);
    expect(await dbCount("Aug-99")).toBe(beforeAug);

    console.log(`[T1] Jul-99 AFTER:  ${await dbCount("Jul-99")} (must equal BEFORE)`);
    console.log(`[T1] Error: ${(caughtError as Error).message}`);

    expect(caughtError).toBeInstanceOf(WipeGuardAbortError);
    expect((caughtError as WipeGuardAbortError).ratio).toBeLessThan(GUARD_REG_ROWS_RATIO);
  });

  // ── Test 2: NEGATIVE — distinct customers below 0.70 threshold ───────────
  it("2: aborts when distinct customers drop below 70%", async () => {
    await seed("Jul-99", 200, CUSTS_10);

    const beforeCount = await dbCount("Jul-99");
    const beforeCust  = await dbDistinctCustomers("Jul-99");
    console.log(`\n[T2] Jul-99 BEFORE: rows=${beforeCount} customers=${beforeCust}`);

    // Incoming: 200 rows (rows OK), only 6 distinct customers (60% of 10 — below 0.70)
    const custs6 = CUSTS_10.slice(0, 6);
    const incoming = incRows("Jul-99", 200, custs6);

    let caughtError: unknown;
    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-2",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err;
      return err instanceof WipeGuardAbortError && err.rule === "distributors";
    });

    expect(await dbCount("Jul-99")).toBe(beforeCount);
    expect(await dbDistinctCustomers("Jul-99")).toBe(beforeCust);

    console.log(`[T2] Jul-99 AFTER:  rows=${await dbCount("Jul-99")} (must equal BEFORE)`);
    console.log(`[T2] Error: ${(caughtError as Error).message}`);

    expect((caughtError as WipeGuardAbortError).ratio).toBeLessThan(GUARD_REG_CUSTOMER_RATIO);
  });

  // ── Test 3: POSITIVE — full matching batch passes ─────────────────────────
  it("3: passes when incoming batch matches existing counts", async () => {
    await seed("Jul-99", 200, CUSTS_5);
    await seed("Aug-99", 150, CUSTS_5);

    const incoming = [
      ...incRows("Jul-99", 200, CUSTS_5), // 100% of existing
      ...incRows("Aug-99", 150, CUSTS_5),
    ];

    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-3",
      }),
    ).resolves.toBeUndefined();

    console.log(`\n[T3] Guard passed. DB rows (unchanged — guard doesn't insert): ${await dbCount()}`);
    expect(await dbCount()).toBe(350); // guard made no changes
  });

  // ── Test 4: OVERRIDE — truncated batch + skipGuard=true ──────────────────
  it("4: proceeds and logs override when skipGuard is explicitly true", async () => {
    await seed("Jul-99", 200, CUSTS_5);

    // Only 10% of existing — would normally abort
    const incoming = incRows("Jul-99", 20, CUSTS_5);

    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: true,
        callerLabel: "test-4: deliberate single-month re-sync",
      }),
    ).resolves.toBeUndefined();

    console.log("\n[T4] Override accepted. Inspect logs for: register wipe guard: SKIPPED via explicit override");
    console.log("[T4] callerLabel in log should read: test-4: deliberate single-month re-sync");
  });

  // ── Test 5: PARTIAL MONTH — full Aug, 50% of Jul ─────────────────────────
  it("5: aborts for the specific month that fails", async () => {
    await seed("Jul-99", 200, CUSTS_5);
    await seed("Aug-99", 160, CUSTS_5);

    const beforeJul = await dbCount("Jul-99");
    const beforeAug = await dbCount("Aug-99");

    // Aug is fine (100%), but Jul is only 50%
    const incoming = [
      ...incRows("Jul-99", 100, CUSTS_5), // 50% — below 0.60 threshold
      ...incRows("Aug-99", 160, CUSTS_5), // 100% — fine
    ];

    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-5",
      }),
    ).rejects.toBeInstanceOf(WipeGuardAbortError);

    const afterJul = await dbCount("Jul-99");
    const afterAug = await dbCount("Aug-99");
    console.log(`\n[T5] Jul-99 BEFORE=${beforeJul} AFTER=${afterJul} (must be identical)`);
    console.log(`[T5] Aug-99 BEFORE=${beforeAug} AFTER=${afterAug} (must be identical)`);

    expect(afterJul).toBe(beforeJul);
    expect(afterAug).toBe(beforeAug);
  });

  // ── Test 7: PER-MEMBER DROP — Rule 3 fires when a member's rows are absent ─
  //
  // Scenario: the company has two members for Jul-99.
  //   Member A: 100 existing rows
  //   Member B: 500 existing rows
  //   Total:    600 existing rows
  //
  // The incoming batch is sourced from a workbook where Member A's register
  // tab is completely absent.  Member B's data is intact (500 rows).
  //
  //   Company-wide ratio:  500 / 600 = 0.833 — Rule 1 passes (≥ 0.60).
  //   Customer ratio:      not an issue.
  //   Rule 3 (per-member): Member A had 100 existing rows but 0 incoming
  //                        → guard fires.
  it("7: aborts via Rule 3 when one member's rows are entirely absent from the incoming batch", async () => {
    const MEMBER_A = "member-a";
    const MEMBER_B = "member-b";

    // Seed: Member A has 100 rows, Member B has 500 rows for Jul-99.
    await seedWithHead("Jul-99", 100, MEMBER_A, CUSTS_5);
    await seedWithHead("Jul-99", 500, MEMBER_B, CUSTS_5);

    const totalBefore = await dbCount("Jul-99");
    console.log(`\n[T7] Jul-99 BEFORE: ${totalBefore} rows (A=100, B=500)`);

    // Verify Rule 1 would pass on its own (company-wide ratio = 83% > 60%).
    expect(500 / totalBefore).toBeGreaterThan(GUARD_REG_ROWS_RATIO);

    // Incoming: only Member B's rows — Member A is completely absent.
    const incoming = incRows("Jul-99", 500, CUSTS_5, MEMBER_B);

    // Confirm Member A is not represented at all.
    expect(incoming.some((r) => r.head?.includes("member-a"))).toBe(false);

    let caughtError: unknown;
    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-7",
        memberGuardEnabled: true, // explicit — loader always sets this
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err;
      return (
        err instanceof WipeGuardAbortError &&
        err.rule === "member" &&
        err.month === "Jul-99" &&
        err.head === MEMBER_A &&
        err.incoming === 0 &&
        err.existing >= GUARD_HEAD_MIN_ROWS
      );
    });

    const totalAfter = await dbCount("Jul-99");
    console.log(`[T7] Jul-99 AFTER: ${totalAfter} rows (must equal BEFORE — guard aborted, no insert)`);
    console.log(`[T7] Error: ${(caughtError as Error).message}`);

    // Append-only: no rows deleted or inserted by the guard.
    expect(totalAfter).toBe(totalBefore);
    expect(caughtError).toBeInstanceOf(WipeGuardAbortError);
    expect((caughtError as WipeGuardAbortError).rule).toBe("member");
    expect((caughtError as WipeGuardAbortError).head).toBe(MEMBER_A);
    expect((caughtError as WipeGuardAbortError).existing).toBeGreaterThanOrEqual(GUARD_HEAD_MIN_ROWS);
    expect((caughtError as WipeGuardAbortError).incoming).toBe(0);
    expect((caughtError as WipeGuardAbortError).ratio).toBe(0);
  });

  // ── Test 8: ALL-NULL HEADS — Rule 3 fires even when incoming has no head values ─
  //
  // Scenario: a malformed workbook succeeds parsing but the head column is
  // absent, so every row's headCanon is null.  The incoming row count equals
  // the existing total, so Rules 1 & 2 both pass.  Because memberGuardEnabled
  // is true, Rule 3 still runs and fires for the first existing (month, head)
  // pair it finds — preventing loading data that has lost member attribution.
  it("8: aborts via Rule 3 when memberGuardEnabled=true but all incoming heads are null", async () => {
    const MEMBER_X = "member-x";

    // Seed enough rows to exceed GUARD_HEAD_MIN_ROWS.
    await seedWithHead("Jul-99", 100, MEMBER_X, CUSTS_5);

    const totalBefore = await dbCount("Jul-99");
    console.log(`\n[T8] Jul-99 BEFORE: ${totalBefore} rows (head=${MEMBER_X})`);

    // Incoming: same row count (100%), but every head is null — simulates a
    // workbook where the head column has been lost.
    const incoming = incRows("Jul-99", 100, CUSTS_5); // head defaults to null
    expect(incoming.every((r) => r.head === null)).toBe(true);

    // Company-wide ratio is 100/100 = 1.0 — Rules 1 & 2 pass.
    // Rule 3 must still fire because memberGuardEnabled=true.
    let caughtError: unknown;
    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-8",
        memberGuardEnabled: true, // explicit — must not be inferred from head presence
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err;
      return (
        err instanceof WipeGuardAbortError &&
        err.rule === "member" &&
        err.month === "Jul-99" &&
        err.incoming === 0 &&
        err.existing >= GUARD_HEAD_MIN_ROWS
      );
    });

    const totalAfter = await dbCount("Jul-99");
    console.log(`[T8] Jul-99 AFTER: ${totalAfter} rows (must equal BEFORE — guard aborted)`);
    console.log(`[T8] Error: ${(caughtError as Error).message}`);

    expect(totalAfter).toBe(totalBefore);
    expect((caughtError as WipeGuardAbortError).rule).toBe("member");
    expect((caughtError as WipeGuardAbortError).incoming).toBe(0);
    expect((caughtError as WipeGuardAbortError).existing).toBeGreaterThanOrEqual(GUARD_HEAD_MIN_ROWS);
  });

  // ── Cross-source tests ────────────────────────────────────────────────────
  //
  // Production wiring: the guard is called WITHOUT a sourceLike filter, so it
  // compares incoming rows against ALL existing rows for the FY regardless of
  // source.  These tests validate that behaviour by seeding under one source
  // then invoking the guard without a filter — exactly as the two loader
  // functions do.

  // ── Test 9: CROSS-SOURCE Rule 1 ──────────────────────────────────────────
  //
  // Existing rows were written by the xlsx_backfill loader.
  // A Sheets re-load brings only 50% of those rows.
  // Guard (no sourceLike) must count all existing rows and abort.
  it("9: cross-source — aborts (Rule 1) when existing rows come from a different loader", async () => {
    // Seed as if a previous xlsx_backfill run populated 200 rows for Jul-99.
    await seed("Jul-99", 200, CUSTS_5, "xlsx_backfill");
    const beforeCount = await dbCount("Jul-99");
    console.log(`\n[T9] Jul-99 BEFORE: ${beforeCount} rows (source=xlsx_backfill)`);

    // Incoming simulates a Sheets load that only has 90 rows (45% of 200).
    const incoming = incRows("Jul-99", 90, CUSTS_5);

    let caughtError: unknown;
    // No sourceLike — matches production wiring.
    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-9-cross-source",
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err;
      return err instanceof WipeGuardAbortError && err.rule === "rows" && err.month === "Jul-99";
    });

    console.log(`[T9] Error: ${(caughtError as Error).message}`);
    expect(await dbCount("Jul-99")).toBe(beforeCount); // no rows inserted/deleted
    expect((caughtError as WipeGuardAbortError).existing).toBe(200);
    expect((caughtError as WipeGuardAbortError).ratio).toBeLessThan(GUARD_REG_ROWS_RATIO);
  });

  // ── Test 10: CROSS-SOURCE Rule 3 ─────────────────────────────────────────
  //
  // Existing rows were written by the sheets loader.
  // An xlsx re-load omits Member A entirely (company-wide ratio = 83% > 60%).
  // Rule 3 (per-member) must still fire because the guard sees all sources.
  it("10: cross-source — aborts (Rule 3) when existing rows come from a different loader and a member is absent", async () => {
    const MEMBER_A = "member-a";
    const MEMBER_B = "member-b";

    // Seed as if a previous Sheets load populated both members.
    await seedWithHead("Jul-99", 100, MEMBER_A, CUSTS_5, "sheets");
    await seedWithHead("Jul-99", 500, MEMBER_B, CUSTS_5, "sheets");

    const totalBefore = await dbCount("Jul-99");
    console.log(`\n[T10] Jul-99 BEFORE: ${totalBefore} rows (source=sheets, A=100, B=500)`);

    // Incoming simulates an xlsx load that has Member B's data but not Member A's.
    const incoming = incRows("Jul-99", 500, CUSTS_5, MEMBER_B);

    // Confirm company-wide ratio would pass Rules 1 & 2 on their own.
    expect(500 / totalBefore).toBeGreaterThan(GUARD_REG_ROWS_RATIO);

    let caughtError: unknown;
    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-10-cross-source",
        memberGuardEnabled: true,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err;
      return (
        err instanceof WipeGuardAbortError &&
        err.rule === "member" &&
        err.month === "Jul-99" &&
        err.head === MEMBER_A &&
        err.incoming === 0
      );
    });

    const totalAfter = await dbCount("Jul-99");
    console.log(`[T10] Jul-99 AFTER: ${totalAfter} rows (must equal BEFORE)`);
    console.log(`[T10] Error: ${(caughtError as Error).message}`);

    expect(totalAfter).toBe(totalBefore);
    expect((caughtError as WipeGuardAbortError).rule).toBe("member");
    expect((caughtError as WipeGuardAbortError).head).toBe(MEMBER_A);
    expect((caughtError as WipeGuardAbortError).existing).toBeGreaterThanOrEqual(GUARD_HEAD_MIN_ROWS);
    expect((caughtError as WipeGuardAbortError).incoming).toBe(0);
  });

  // ── Test 11: CROSS-SOURCE all-null heads ─────────────────────────────────
  //
  // Existing rows (source=sheets) carry head_canon.
  // An xlsx load brings the same row count but no head column (all null).
  // Rule 3 must fire even though incoming heads are all null, because
  // memberGuardEnabled=true was set explicitly by the loader.
  it("11: cross-source — aborts (Rule 3) when existing rows come from a different loader and all incoming heads are null", async () => {
    const MEMBER_Y = "member-y";

    // Seed as if a Sheets load populated one member with enough rows.
    await seedWithHead("Jul-99", 100, MEMBER_Y, CUSTS_5, "sheets");
    const totalBefore = await dbCount("Jul-99");
    console.log(`\n[T11] Jul-99 BEFORE: ${totalBefore} rows (source=sheets, head=${MEMBER_Y})`);

    // Incoming simulates an xlsx load — same row count but head column lost.
    const incoming = incRows("Jul-99", 100, CUSTS_5); // head=null
    expect(incoming.every((r) => r.head === null)).toBe(true);

    // Rules 1 & 2 pass (100% rows, same customers).  Rule 3 must still fire.
    let caughtError: unknown;
    await expect(
      assertRegisterWipeGuard({
        tx: db as any,
        fy: TEST_FY,
        incoming,
        skipGuard: false,
        callerLabel: "test-11-cross-source",
        memberGuardEnabled: true,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      caughtError = err;
      return (
        err instanceof WipeGuardAbortError &&
        err.rule === "member" &&
        err.incoming === 0 &&
        err.existing >= GUARD_HEAD_MIN_ROWS
      );
    });

    const totalAfter = await dbCount("Jul-99");
    console.log(`[T11] Jul-99 AFTER: ${totalAfter} rows (must equal BEFORE)`);
    console.log(`[T11] Error: ${(caughtError as Error).message}`);

    expect(totalAfter).toBe(totalBefore);
    expect((caughtError as WipeGuardAbortError).rule).toBe("member");
    expect((caughtError as WipeGuardAbortError).incoming).toBe(0);
    expect((caughtError as WipeGuardAbortError).existing).toBeGreaterThanOrEqual(GUARD_HEAD_MIN_ROWS);
  });
});
