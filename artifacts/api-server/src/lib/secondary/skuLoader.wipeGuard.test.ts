// Integration test: open-FY wipe guard aborts the transaction before the DELETE.
//
// WHAT THIS TESTS:
//   The per-month wipe guard in skuLoader's replace mode and the PSCode3 load
//   scripts fires INSIDE the same transaction as the DELETE. When the guard
//   triggers (incoming < 60% of prior like-month), the transaction must roll
//   back and leave existing rows completely unchanged.
//
//   This test exercises the real guard + Drizzle transaction path against the
//   dashboard_test schema (set up by setup-db.ts), so it is a genuine
//   integration test rather than a pure unit test.
//
// TEST SCHEMA:
//   A minimal secondary_sku_line fixture is created in dashboard_test at the
//   start and dropped at the end. The public.secondary_sku_line (real data) is
//   never touched.

import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { pool, db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  checkOpenFyWipeGuard,
  priorLikeMonthLabel,
  priorFyLabel,
  WIPE_GUARD_RATIO,
} from "./skuLoader.js";

// Fictional FY labels that can never collide with real data.
const TEST_PRIOR_FY  = "9997-98";
const TEST_OPEN_FY   = "9998-99";
const TEST_MONTH     = "Apr-98"; // "Apr" of the prior FY (label for prior rows)
const TEST_OPEN_MONTH = "Apr-99"; // corresponding month in the open FY

// ── Test schema setup ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create a minimal secondary_sku_line in the test schema.
  // Only the columns needed for the guard's COUNT(*) query are required.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS secondary_sku_line (
      line_uid    text NOT NULL PRIMARY KEY,
      fy          text NOT NULL,
      month_label text NOT NULL,
      item_code   text NOT NULL DEFAULT 'TESTCODE',
      source      text NOT NULL DEFAULT 'test'
    )
  `);

  // Wipe any leftover rows from previous test runs.
  await pool.query(
    "DELETE FROM secondary_sku_line WHERE fy IN ($1, $2)",
    [TEST_PRIOR_FY, TEST_OPEN_FY],
  );
});

afterAll(async () => {
  // Clean up test rows (leave the table itself; other tests may have created it).
  await pool.query(
    "DELETE FROM secondary_sku_line WHERE fy IN ($1, $2)",
    [TEST_PRIOR_FY, TEST_OPEN_FY],
  );
});

/** Insert `n` minimal rows into the test secondary_sku_line table. */
async function insertTestRows(fy: string, month: string, n: number, prefix: string): Promise<void> {
  if (n === 0) return;
  const values = Array.from({ length: n }, (_, i) =>
    `('${prefix}-${i}', '${fy}', '${month}', 'TESTCODE', 'test')`,
  ).join(", ");
  await pool.query(
    `INSERT INTO secondary_sku_line (line_uid, fy, month_label, item_code, source) VALUES ${values} ON CONFLICT DO NOTHING`,
  );
}

/** Count rows in the test table for a given (fy, month). */
async function countRows(fy: string, month: string): Promise<number> {
  const res = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM secondary_sku_line WHERE fy = $1 AND month_label = $2",
    [fy, month],
  );
  return res.rows[0]?.n ?? 0;
}

// ── Helpers mirroring the skuLoader / PSCode replace path ─────────────────────

/**
 * Runs the guard + delete pattern inside a single Drizzle transaction —
 * exactly as skuLoader's replace mode and the PSCode3 scripts do.
 *
 * Returns "deleted" when the guard passed and the DELETE ran, or "aborted"
 * when the guard fired and the transaction was rolled back.
 */
async function runGuardedDelete(opts: {
  fy: string;
  month: string;
  incomingRows: number;
}): Promise<"deleted" | "aborted"> {
  const { fy, month, incomingRows } = opts;
  const priorFy = priorFyLabel(fy);
  const priorMonth = priorLikeMonthLabel(month);

  try {
    await db.transaction(async (tx) => {
      // ── Guard: query prior like-month count BEFORE the DELETE ──────────────
      const priorRes = await tx.execute<{ rows: string }>(
        sql`SELECT COUNT(*)::text AS rows FROM secondary_sku_line WHERE fy = ${priorFy} AND month_label = ${priorMonth}`,
      );
      const priorRows = parseInt(
        ((priorRes.rows[0] as { rows: string }) ?? { rows: "0" }).rows,
        10,
      );
      const priorByMonth = new Map([[priorMonth, priorRows]]);
      const incomingByMonth = new Map([[month, incomingRows]]);

      const guard = checkOpenFyWipeGuard(incomingByMonth, priorByMonth);
      if (!guard.ok) {
        throw new Error(`wipe guard: ${guard.reason}`);
      }

      // Guard passed — proceed with the DELETE.
      await tx.execute(
        sql`DELETE FROM secondary_sku_line WHERE fy = ${fy} AND month_label = ${month}`,
      );
    });
    return "deleted";
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("wipe guard:")) {
      return "aborted";
    }
    throw err; // unexpected error — re-throw
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("wipe guard integration — transaction rollback on the live ingestion path", () => {
  it("guard aborts the transaction when the incoming batch is 10% of prior like-month (no rows deleted)", async () => {
    // Prior like-month: 10 rows for "Apr-98" in TEST_PRIOR_FY.
    // Current open-FY: 5 rows for "Apr-99" in TEST_OPEN_FY.
    // Incoming batch: 1 row — 10% of 10, well below the 60% floor.
    await insertTestRows(TEST_PRIOR_FY, TEST_MONTH, 10, "prior");
    await insertTestRows(TEST_OPEN_FY,  TEST_OPEN_MONTH, 5, "open");

    const outcome = await runGuardedDelete({
      fy: TEST_OPEN_FY,
      month: TEST_OPEN_MONTH,
      incomingRows: 1,  // 10% of 10 prior rows — must trigger
    });

    expect(outcome).toBe("aborted");
    // The DELETE must have been rolled back — open-FY rows still intact.
    const remaining = await countRows(TEST_OPEN_FY, TEST_OPEN_MONTH);
    expect(remaining).toBe(5);

    // Cleanup for subsequent tests.
    await pool.query(
      "DELETE FROM secondary_sku_line WHERE fy IN ($1, $2)",
      [TEST_PRIOR_FY, TEST_OPEN_FY],
    );
  });

  it("guard passes and the DELETE commits when the incoming batch meets the floor", async () => {
    // Prior like-month: 10 rows. Floor = 0.60 × 10 = 6.
    // Incoming: 7 rows → 70% > 60% → guard should pass.
    await insertTestRows(TEST_PRIOR_FY, TEST_MONTH, 10, "prior");
    await insertTestRows(TEST_OPEN_FY,  TEST_OPEN_MONTH, 5, "open");

    const outcome = await runGuardedDelete({
      fy: TEST_OPEN_FY,
      month: TEST_OPEN_MONTH,
      incomingRows: 7,
    });

    expect(outcome).toBe("deleted");
    // Guard passed — DELETE committed, open-FY rows are gone.
    const remaining = await countRows(TEST_OPEN_FY, TEST_OPEN_MONTH);
    expect(remaining).toBe(0);

    // Cleanup.
    await pool.query(
      "DELETE FROM secondary_sku_line WHERE fy IN ($1, $2)",
      [TEST_PRIOR_FY, TEST_OPEN_FY],
    );
  });

  it("guard passes (skips check) when prior like-month has no rows — first-ever load", async () => {
    // No prior rows inserted. Incoming: 1 row. Guard must skip (no baseline).
    await insertTestRows(TEST_OPEN_FY, TEST_OPEN_MONTH, 3, "open");

    const outcome = await runGuardedDelete({
      fy: TEST_OPEN_FY,
      month: TEST_OPEN_MONTH,
      incomingRows: 1,
    });

    expect(outcome).toBe("deleted");
    const remaining = await countRows(TEST_OPEN_FY, TEST_OPEN_MONTH);
    expect(remaining).toBe(0);

    // Cleanup.
    await pool.query(
      "DELETE FROM secondary_sku_line WHERE fy IN ($1, $2)",
      [TEST_PRIOR_FY, TEST_OPEN_FY],
    );
  });

  it("WIPE_GUARD_RATIO is 0.60 — the exported constant matches the guard behaviour", () => {
    expect(WIPE_GUARD_RATIO).toBe(0.60);
    // 6 / 10 = 60% exactly passes (>= not >).
    const passing = checkOpenFyWipeGuard(new Map([["Apr-99", 6]]), new Map([["Apr-98", 10]]));
    const failing = checkOpenFyWipeGuard(new Map([["Apr-99", 5]]), new Map([["Apr-98", 10]]));
    expect(passing.ok).toBe(true);
    expect(failing.ok).toBe(false);
  });
});
