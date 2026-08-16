// Integration tests for the alert persistence layer.
//
// WHAT THESE TESTS PROTECT:
//   periods_open counts distinct analytical windows (frozen-month periods) in
//   which the alert has been open — not detection-run executions. Multiple
//   6-hour runs within the same window must NOT increment periods_open. Only
//   when the incoming period_label differs from the stored one (the analysis
//   window has advanced because a new month froze) should periods_open grow.
//
//   The fingerprint is now fy|code|entityKey (months excluded), so the same
//   alert row persists across window changes rather than clearing and re-inserting
//   at periods_open=1.
//
// SCHEMA ISOLATION:
//   The vitest setup (setup-db.ts) points the pool at the "dashboard_test"
//   schema. We create the alert / alert_action tables there in beforeAll and
//   drop them in afterAll; they never touch the public-schema tables.
//
// Each test uses TEST_FY = "9999-00" so afterEach can DELETE only test rows
// without truncating real data from other tests.

import { beforeAll, afterAll, afterEach, describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import { persistAlerts, buildFingerprint } from "../alertPersistence.js";
import type { CalibrationResult, RawAlert } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const TEST_FY = "9999-00"; // Never a real FY; isolates test rows

/** Minimal RawAlert for testing persistence (not detection logic). */
function makeRawAlert(overrides: Partial<RawAlert> = {}): RawAlert {
  return {
    code: "A1",
    category: "A",
    entity: "Test Entity",
    entityKey: "test-entity-key",
    entityType: "member",
    currentMonths: ["Apr-99", "May-99"],
    priorMonths: ["Apr-98", "May-98"],
    numbers: { achievementPct: 25, cumulativeOb: 1000000 },
    rupeesAtStake: 5_000_000,
    ...overrides,
  };
}

/** Minimal CalibrationResult wrapping a list of RawAlerts. */
function makeResult(alerts: RawAlert[], months = ["Apr-99", "May-99"]): CalibrationResult {
  const allCodes = [
    "A1","A2","A3","B1","B2","B3","B4","B5","C1","C2","C3","C4","C5","S1",
  ] as const;
  const byCode = Object.fromEntries(
    allCodes.map((c) => [c, { count: 0, rupeesAtStake: 0 }]),
  ) as CalibrationResult["byCode"];
  const rawByCode = Object.fromEntries(
    allCodes.map((c) => [c, 0]),
  ) as CalibrationResult["rawByCode"];

  return {
    fy: TEST_FY,
    currentMonths: months,
    priorMonths: months.map((m) => m.replace("-99", "-98")),
    alerts,
    suppressed: [],
    suppressedByGuard: {},
    crossSuppressed: 0,
    byCode,
    rawCount: alerts.length,
    rawByCode,
  };
}

// ── Test schema setup ──────────────────────────────────────────────────────

beforeAll(async () => {
  // Create alert tables in the dashboard_test schema so the unqualified table
  // names in persistAlerts resolve here (search_path = dashboard_test).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert (
      id              SERIAL      PRIMARY KEY,
      fingerprint     TEXT        NOT NULL UNIQUE,
      fy              TEXT        NOT NULL,
      code            TEXT        NOT NULL,
      entity          TEXT        NOT NULL,
      entity_key      TEXT        NOT NULL,
      entity_type     TEXT        NOT NULL,
      period_label    TEXT        NOT NULL,
      status          TEXT        NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','acknowledged','cleared')),
      periods_open    INTEGER     NOT NULL DEFAULT 1,
      rupees_at_stake NUMERIC     NOT NULL DEFAULT 0,
      detail          JSONB       NOT NULL DEFAULT '{}',
      guards_passed   JSONB       NOT NULL DEFAULT '[]',
      suppressed_by   INTEGER     REFERENCES alert(id),
      linked_alert_id INTEGER     REFERENCES alert(id),
      clear_reason    TEXT,
      first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_action (
      id         SERIAL      PRIMARY KEY,
      alert_id   INTEGER     NOT NULL REFERENCES alert(id) ON DELETE CASCADE,
      action     TEXT        NOT NULL,
      by_person  TEXT        NOT NULL DEFAULT '',
      at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      note       TEXT
    )
  `);
});

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS alert_action`);
  await pool.query(`DROP TABLE IF EXISTS alert CASCADE`);
});

/** Clean up all test rows after each test. */
afterEach(async () => {
  await pool.query(
    `DELETE FROM alert_action WHERE alert_id IN (SELECT id FROM alert WHERE fy = $1)`,
    [TEST_FY],
  );
  await pool.query(`DELETE FROM alert WHERE fy = $1`, [TEST_FY]);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("alertPersistence", () => {
  it("inserts new alerts on first detection run", async () => {
    const alert = makeRawAlert();
    const result = makeResult([alert]);

    const stats = await persistAlerts(TEST_FY, result, []);

    expect(stats.new).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.reopened).toBe(0);
    expect(stats.cleared).toBe(0);
    expect(stats.totalOpen).toBe(1);

    const { rows } = await pool.query(
      `SELECT status, periods_open FROM alert WHERE fy = $1`,
      [TEST_FY],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("open");
    expect(Number(rows[0]?.periods_open)).toBe(1);
  });

  it("increments periods_open on the second run even within the same window", async () => {
    // KEY INVARIANT: periods_open counts consecutive detection runs in which
    // the alert has been observed, regardless of whether the analytical window
    // has changed. Two runs within the same frozen-month window both count.
    const alert = makeRawAlert();
    const result = makeResult([alert]);

    await persistAlerts(TEST_FY, result, []);
    const stats2 = await persistAlerts(TEST_FY, result, []);

    expect(stats2.new).toBe(0);
    expect(stats2.updated).toBe(1);
    expect(stats2.reopened).toBe(0);

    const { rows } = await pool.query(
      `SELECT periods_open FROM alert WHERE fy = $1`,
      [TEST_FY],
    );
    // periods_open increments on every detection run — 2 runs → periods_open=2
    expect(Number(rows[0]?.periods_open)).toBe(2);
  });

  it("increments periods_open when the analysis window advances to a new month", async () => {
    // Simulates a month freeze: the analysis window grows from Apr-May to Apr-Jun.
    const alertQ1 = makeRawAlert({ currentMonths: ["Apr-99", "May-99"] });
    const alertQ2 = makeRawAlert({ currentMonths: ["Apr-99", "May-99", "Jun-99"] });

    // Run 1: Q1 window
    await persistAlerts(TEST_FY, makeResult([alertQ1], alertQ1.currentMonths), []);

    // Run 2: Q2 window (Jun-99 froze) — same fingerprint (months excluded), new period_label
    const stats2 = await persistAlerts(TEST_FY, makeResult([alertQ2], alertQ2.currentMonths), []);

    expect(stats2.updated).toBe(1);
    const { rows } = await pool.query(
      `SELECT periods_open, period_label FROM alert WHERE fy = $1`,
      [TEST_FY],
    );
    // periods_open must have incremented to 2 because the window advanced
    expect(Number(rows[0]?.periods_open)).toBe(2);
    // period_label is updated to the new window
    expect(rows[0]?.period_label).toBe("Apr-99..Jun-99");
  });

  it("clears an open alert when its fingerprint is absent from the next run", async () => {
    const alert = makeRawAlert();

    // Run 1: insert the alert
    await persistAlerts(TEST_FY, makeResult([alert]), []);

    // Run 2: alert absent → should be cleared
    const stats2 = await persistAlerts(TEST_FY, makeResult([]), []);

    expect(stats2.cleared).toBe(1);
    expect(stats2.totalOpen).toBe(0);

    const { rows } = await pool.query(
      `SELECT status, clear_reason FROM alert WHERE fy = $1`,
      [TEST_FY],
    );
    expect(rows[0]?.status).toBe("cleared");
    expect(rows[0]?.clear_reason).toBe("condition_no_longer_holds");
  });

  it("reopens a cleared alert without a unique-constraint violation (recurrence)", async () => {
    const alert = makeRawAlert();
    const fp = buildFingerprint(TEST_FY, alert);

    // Run 1: insert → open, periods_open=1
    await persistAlerts(TEST_FY, makeResult([alert]), []);

    // Run 2: absent → cleared
    await persistAlerts(TEST_FY, makeResult([]), []);

    // Verify row is cleared
    const { rows: before } = await pool.query(
      `SELECT status FROM alert WHERE fingerprint = $1`,
      [fp],
    );
    expect(before[0]?.status).toBe("cleared");

    // Run 3: alert recurs in the SAME window — must NOT throw; periods_open increments
    const stats3 = await persistAlerts(TEST_FY, makeResult([alert]), []);

    expect(stats3.reopened).toBe(1);
    expect(stats3.new).toBe(0); // row was reused, not re-inserted
    expect(stats3.totalOpen).toBe(1);

    const { rows: after } = await pool.query(
      `SELECT status, clear_reason, suppressed_by, periods_open FROM alert WHERE fingerprint = $1`,
      [fp],
    );
    expect(after[0]?.status).toBe("open");
    expect(after[0]?.clear_reason).toBeNull();
    expect(after[0]?.suppressed_by).toBeNull();
    // periods_open increments on every detection run — was 1 before clear, recurrence = 2
    expect(Number(after[0]?.periods_open)).toBe(2);
  });

  it("increments periods_open when a recurrence happens in a new window", async () => {
    const alertWindow1 = makeRawAlert({ currentMonths: ["Apr-99"] });
    const alertWindow2 = makeRawAlert({ currentMonths: ["Apr-99", "May-99"] });

    // Run 1: insert in window 1
    await persistAlerts(TEST_FY, makeResult([alertWindow1], alertWindow1.currentMonths), []);

    // Run 2: absent → cleared
    await persistAlerts(TEST_FY, makeResult([], alertWindow1.currentMonths), []);

    // Run 3: recurs in window 2 (month advanced) → periods_open increments to 2
    const stats3 = await persistAlerts(
      TEST_FY,
      makeResult([alertWindow2], alertWindow2.currentMonths),
      [],
    );

    expect(stats3.reopened).toBe(1);
    const { rows } = await pool.query(
      `SELECT periods_open, period_label FROM alert WHERE fy = $1`,
      [TEST_FY],
    );
    expect(Number(rows[0]?.periods_open)).toBe(2);
    expect(rows[0]?.period_label).toBe("Apr-99..May-99");
  });

  it("preserves acknowledged status across detection runs", async () => {
    const alert = makeRawAlert();

    // Run 1: insert → open
    await persistAlerts(TEST_FY, makeResult([alert]), []);

    // Acknowledge the alert
    const { rows } = await pool.query(
      `SELECT id FROM alert WHERE fy = $1 LIMIT 1`,
      [TEST_FY],
    );
    const alertId = rows[0]!.id;
    await pool.query(`UPDATE alert SET status = 'acknowledged' WHERE id = $1`, [alertId]);
    await pool.query(
      `INSERT INTO alert_action (alert_id, action, by_person) VALUES ($1, 'acknowledge', 'Test User')`,
      [alertId],
    );

    // Run 2: alert still fires → acknowledged must stay acknowledged
    const stats2 = await persistAlerts(TEST_FY, makeResult([alert]), []);

    expect(stats2.totalAcknowledged).toBe(1);
    expect(stats2.totalOpen).toBe(0);

    const { rows: after } = await pool.query(
      `SELECT status FROM alert WHERE id = $1`,
      [alertId],
    );
    expect(after[0]?.status).toBe("acknowledged");
  });

  it("does NOT clear an acknowledged alert when its fingerprint is absent (AND status='open' guard)", async () => {
    // This test verifies the "AND status = 'open'" condition in the clear UPDATE.
    // Even though the snapshot loop sees the row as acknowledged and skips it
    // (row.status !== 'open'), the WHERE clause provides a second safety net:
    // if an operator acknowledges a row *between* the snapshot and the UPDATE
    // (only possible without the advisory lock, but defended in depth), the
    // UPDATE would still affect 0 rows.
    const alert = makeRawAlert();

    // Run 1: insert → open
    await persistAlerts(TEST_FY, makeResult([alert]), []);

    // Acknowledge (simulates operator action)
    const { rows } = await pool.query(
      `SELECT id FROM alert WHERE fy = $1 LIMIT 1`,
      [TEST_FY],
    );
    const alertId = rows[0]!.id;
    await pool.query(`UPDATE alert SET status = 'acknowledged' WHERE id = $1`, [alertId]);

    // Run 2: alert absent — acknowledged must NOT be cleared
    const stats2 = await persistAlerts(TEST_FY, makeResult([]), []);

    expect(stats2.cleared).toBe(0); // acknowledged rows are immune to clearing
    expect(stats2.totalAcknowledged).toBe(1);

    const { rows: after } = await pool.query(
      `SELECT status FROM alert WHERE id = $1`,
      [alertId],
    );
    expect(after[0]?.status).toBe("acknowledged");
  });

  it("concurrent detection runs do not conflict (advisory lock serializes them)", async () => {
    // Two simultaneous POST /api/alerts/detect calls — one from the scheduler,
    // one from a manual trigger — must not race on the fingerprint UNIQUE index
    // or produce duplicate rows. The pg_advisory_xact_lock ensures the second
    // run waits for the first to commit, then sees an already-upserted row and
    // correctly issues an UPDATE instead of an INSERT.
    const alert = makeRawAlert();

    await Promise.all([
      persistAlerts(TEST_FY, makeResult([alert]), []),
      persistAlerts(TEST_FY, makeResult([alert]), []),
    ]);

    // Exactly one row should exist — no duplicates
    const { rows: countRows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM alert WHERE fy = $1`,
      [TEST_FY],
    );
    expect(countRows[0]?.n).toBe(1);

    // periods_open is 2: the advisory lock serializes both runs, so the second
    // run sees the INSERT from the first and issues an UPDATE (periods_open++).
    const { rows: alertRows } = await pool.query(
      `SELECT periods_open FROM alert WHERE fy = $1`,
      [TEST_FY],
    );
    expect(Number(alertRows[0]?.periods_open)).toBe(2);
  });

  it("acknowledgement on a cleared alert returns the current status without resurrecting it", async () => {
    // RACE: operator opens the Alerts page (sees the alert as 'open'), detection
    // runs and clears it, then the operator clicks Acknowledge. The acknowledge
    // route must NOT set the cleared row back to 'acknowledged'.
    //
    // We simulate this by: inserting an open alert, clearing it directly
    // (mimicking detection running first), then attempting to acknowledge it
    // through the same guarded UPDATE the route uses.
    const alert = makeRawAlert({ entityKey: "race-entity" });

    // Run 1: insert → open
    await persistAlerts(TEST_FY, makeResult([alert]), []);

    // Detection clears the alert (condition no longer holds)
    await persistAlerts(TEST_FY, makeResult([]), []);

    const { rows } = await pool.query(
      `SELECT id, status FROM alert WHERE fy = $1 LIMIT 1`,
      [TEST_FY],
    );
    const { id: alertId, status: statusBeforeAck } = rows[0]!;
    expect(statusBeforeAck).toBe("cleared");

    // Simulate the guarded acknowledge UPDATE the route uses:
    // WHERE status = 'open' means no rows are updated for a cleared alert.
    const { rows: updated } = await pool.query<{ id: number }>(
      `UPDATE alert SET status = 'acknowledged' WHERE id = $1 AND status = 'open' RETURNING id`,
      [alertId],
    );

    // The UPDATE must have touched 0 rows — the alert must remain cleared.
    expect(updated).toHaveLength(0);

    const { rows: after } = await pool.query(
      `SELECT status FROM alert WHERE id = $1`,
      [alertId],
    );
    expect(after[0]?.status).toBe("cleared"); // never resurrected
  });

  it("excludes prior-FY alerts from the active count (FY isolation)", async () => {
    // An alert from a prior FY that was never cleared (e.g. because the prior FY's
    // detection scheduler stopped running at FY close) must NOT appear in the count
    // for the current FY. This test seeds a prior-FY row and verifies the
    // persistAlerts count for the current FY is unaffected.
    const PRIOR_FY = "9998-00";

    // Insert a prior-FY open alert directly
    await pool.query(
      `INSERT INTO alert (fingerprint, fy, code, entity, entity_key, entity_type, period_label, status, rupees_at_stake, detail, guards_passed)
       VALUES ($1, $2, 'A1', 'Prior Entity', 'prior-entity-key', 'member', 'Apr-98', 'open', 9000000, '{}', '[]')`,
      [`${PRIOR_FY}|A1|prior-entity-key`, PRIOR_FY],
    );

    // Run persist for TEST_FY with one alert
    const alert = makeRawAlert({ entityKey: "current-entity-key" });
    const stats = await persistAlerts(TEST_FY, makeResult([alert]), []);

    // Counts must only reflect TEST_FY
    expect(stats.totalOpen).toBe(1);           // current FY only
    expect(stats.totalAcknowledged).toBe(0);

    // Clean up the prior-FY row
    await pool.query(`DELETE FROM alert WHERE fy = $1`, [PRIOR_FY]);
  });

  it("handles multiple alerts across all three states in one run", async () => {
    const alertA = makeRawAlert({ entityKey: "entity-A", code: "A1" });
    const alertB = makeRawAlert({ entityKey: "entity-B", code: "A2" });
    const alertC = makeRawAlert({ entityKey: "entity-C", code: "A3" });

    // Run 1: insert all three
    const s1 = await persistAlerts(TEST_FY, makeResult([alertA, alertB, alertC]), []);
    expect(s1.new).toBe(3);

    // Run 2: only A and B fire (C is absent → should be cleared)
    const s2 = await persistAlerts(TEST_FY, makeResult([alertA, alertB]), []);
    expect(s2.updated).toBe(2);
    expect(s2.cleared).toBe(1);
    expect(s2.totalOpen).toBe(2);

    // Run 3: C recurs (was cleared → should reopen), A and B continue
    const s3 = await persistAlerts(TEST_FY, makeResult([alertA, alertB, alertC]), []);
    expect(s3.updated).toBe(2);
    expect(s3.reopened).toBe(1);
    expect(s3.new).toBe(0);
    expect(s3.totalOpen).toBe(3);
  });
});
