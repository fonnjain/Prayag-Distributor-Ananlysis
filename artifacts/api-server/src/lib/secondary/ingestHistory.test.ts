// Database-level regression coverage for the append-only secondary dashboard
// ledger. Uses a reserved FY in the isolated dashboard_test schema.
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import {
  BATCH_SIZE,
  buildSecIngestRun,
  persistValidatedSecHeadMonths,
  type ValidatedSecHeadMonthInput,
} from "./ingest.js";
import historyRouter from "../../routes/secondaryHistory.js";

const TEST_FY = "TEST-SECONDARY-HISTORY";
const TEST_HEAD = "auditmember";
const TEST_MONTH = "Apr-99";

function row(receivedAmount = "90"): ValidatedSecHeadMonthInput {
  return {
    fy: TEST_FY,
    headRaw: "Audit Member",
    headCanon: TEST_HEAD,
    stateHead: "Audit Head",
    monthLabel: TEST_MONTH,
    monthIdx: 0,
    planAmount: "100",
    orderedAmount: "120",
    receivedAmount,
    achievementPct: String((Number(receivedAmount) / 100) * 100),
    isAnomaly: false,
    notYetRecorded: false,
    sourceSheetId: "test-secondary-dashboard",
  };
}

function run() {
  return buildSecIngestRun({
    source: "state_head_dashboard",
    fy: TEST_FY,
    rowsRead: 1,
    rowsInserted: 1,
    rowsSkipped: 0,
    unmapped: {},
    assertions: [{ name: "test_validation", passed: true, detail: "test fixture" }],
    status: "ok",
  });
}

async function clearFixture(): Promise<void> {
  await pool.query(`ALTER TABLE secondary_head_month_revision DISABLE TRIGGER secondary_head_month_revision_immutable`);
  try {
    await pool.query(`DELETE FROM secondary_head_month_revision WHERE fy = $1`, [TEST_FY]);
    await pool.query(`DELETE FROM secondary_head_month WHERE fy = $1`, [TEST_FY]);
    await pool.query(`DELETE FROM secondary_ingest_run WHERE fy = $1`, [TEST_FY]);
  } finally {
    await pool.query(`ALTER TABLE secondary_head_month_revision ENABLE TRIGGER secondary_head_month_revision_immutable`);
  }
}

async function counts(): Promise<{ runs: number; revisions: number; current: number }> {
  const [runs, revisions, current] = await Promise.all([
    pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM secondary_ingest_run WHERE fy = $1`, [TEST_FY]),
    pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM secondary_head_month_revision WHERE fy = $1`, [TEST_FY]),
    pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM secondary_head_month WHERE fy = $1`, [TEST_FY]),
  ]);
  return {
    runs: runs.rows[0]!.n,
    revisions: revisions.rows[0]!.n,
    current: current.rows[0]!.n,
  };
}

beforeAll(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS secondary_ingest_run (
      id serial PRIMARY KEY,
      started_at timestamptz,
      source text,
      fy text,
      rows_read integer,
      rows_inserted integer,
      rows_skipped integer,
      unmapped jsonb,
      assertions jsonb,
      status text
    );
    CREATE TABLE IF NOT EXISTS secondary_head_month (
      id serial PRIMARY KEY,
      fy text NOT NULL,
      head_raw text,
      head_canon text NOT NULL,
      state_head text,
      month_label text NOT NULL,
      month_idx integer NOT NULL,
      plan_amount numeric,
      ordered_amount numeric,
      received_amount numeric,
      achievement_pct numeric,
      is_anomaly boolean NOT NULL DEFAULT false,
      not_yet_recorded boolean NOT NULL DEFAULT false,
      source_sheet_id text,
      ingest_run_id integer NOT NULL REFERENCES secondary_ingest_run(id),
      ingested_at timestamptz DEFAULT now(),
      UNIQUE (fy, head_canon, month_label)
    );
    CREATE TABLE IF NOT EXISTS secondary_head_month_revision (
      id serial PRIMARY KEY,
      ingest_run_id integer NOT NULL REFERENCES secondary_ingest_run(id),
      fy text NOT NULL,
      head_raw text,
      head_canon text NOT NULL,
      state_head text,
      month_label text NOT NULL,
      month_idx integer NOT NULL,
      plan_amount numeric,
      ordered_amount numeric,
      received_amount numeric,
      achievement_pct numeric,
      is_anomaly boolean NOT NULL DEFAULT false,
      not_yet_recorded boolean NOT NULL DEFAULT false,
      source_sheet_id text,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (ingest_run_id, fy, head_canon, month_label)
    );
    CREATE OR REPLACE FUNCTION prevent_secondary_head_month_revision_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'secondary_head_month_revision is append-only';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS secondary_head_month_revision_immutable
      ON secondary_head_month_revision;
    CREATE TRIGGER secondary_head_month_revision_immutable
      BEFORE UPDATE OR DELETE ON secondary_head_month_revision
      FOR EACH ROW
      EXECUTE FUNCTION prevent_secondary_head_month_revision_mutation();
  `);
  await clearFixture();
});

beforeEach(clearFixture);
afterAll(clearFixture);

describe("persistValidatedSecHeadMonths", () => {
  it("records every unchanged successful load while current provenance moves to the latest run", async () => {
    const first = await persistValidatedSecHeadMonths([row()], run());
    const second = await persistValidatedSecHeadMonths([row()], run());

    expect(first.revisionsInserted).toBe(1);
    expect(second.revisionsInserted).toBe(1);
    expect(await counts()).toEqual({ runs: 2, revisions: 2, current: 1 });

    const current = await pool.query<{ ingest_run_id: number }>(
      `SELECT ingest_run_id FROM secondary_head_month WHERE fy = $1`,
      [TEST_FY],
    );
    expect(current.rows[0]!.ingest_run_id).toBe(second.ingestRunId);
  });

  it("preserves the prior source value and exposes numeric movement after a changed load", async () => {
    await persistValidatedSecHeadMonths([row("90")], run());
    const changed = await persistValidatedSecHeadMonths([row("115")], run());

    const result = await pool.query<{
      received_amount: string;
      previous_received: string | null;
    }>(`
      SELECT
        received_amount,
        LAG(received_amount) OVER (ORDER BY id) AS previous_received
      FROM secondary_head_month_revision
      WHERE fy = $1 AND head_canon = $2 AND month_label = $3
      ORDER BY id
    `, [TEST_FY, TEST_HEAD, TEST_MONTH]);
    expect(result.rows).toEqual([
      { received_amount: "90", previous_received: null },
      { received_amount: "115", previous_received: "90" },
    ]);

    const current = await pool.query<{ received_amount: string; ingest_run_id: number }>(
      `SELECT received_amount, ingest_run_id FROM secondary_head_month WHERE fy = $1`,
      [TEST_FY],
    );
    expect(current.rows[0]).toEqual({ received_amount: "115", ingest_run_id: changed.ingestRunId });
  });

  it("rolls back the run, revisions, and current write together when persistence fails", async () => {
    const firstBatch = Array.from({ length: BATCH_SIZE }, (_, index) => ({
      ...row(),
      headRaw: `Audit Member ${index}`,
      headCanon: `auditmember${index}`,
    }));

    await expect(
      persistValidatedSecHeadMonths(
        [...firstBatch, { ...row("101"), headCanon: "auditmemberinvalid", monthIdx: null as unknown as number }],
        run(),
      ),
    ).rejects.toThrow();

    expect(await counts()).toEqual({ runs: 0, revisions: 0, current: 0 });
  });

  it("leaves no partial evidence after a failed attempt, so retry creates exactly one complete run", async () => {
    await expect(
      persistValidatedSecHeadMonths(
        [{ ...row(), monthIdx: null as unknown as number }],
        run(),
      ),
    ).rejects.toThrow();
    expect(await counts()).toEqual({ runs: 0, revisions: 0, current: 0 });

    const retry = await persistValidatedSecHeadMonths([row()], run());
    expect(await counts()).toEqual({ runs: 1, revisions: 1, current: 1 });
    expect(retry.revisionsInserted).toBe(1);
  });

  it("rejects mutations of previously recorded source evidence", async () => {
    await persistValidatedSecHeadMonths([row()], run());
    await expect(
      pool.query(
        `UPDATE secondary_head_month_revision
         SET received_amount = 999
         WHERE fy = $1`,
        [TEST_FY],
      ),
    ).rejects.toThrow("append-only");
  });
});

describe("GET /admin/secondary/head-month-history", () => {
  const app = express();
  app.use(historyRouter);

  it("returns prior and current values, source runs, and numeric movement", async () => {
    process.env.ADMIN_SECRET = "secondary-history-test-secret";
    await persistValidatedSecHeadMonths([row("90")], run());
    await persistValidatedSecHeadMonths([row("115")], run());

    const response = await request(app)
      .get(`/admin/secondary/head-month-history?fy=${TEST_FY}&headCanon=${TEST_HEAD}&monthLabel=${TEST_MONTH}`)
      .set("X-Admin-Secret", "secondary-history-test-secret");

    expect(response.status).toBe(200);
    expect(response.body.current.values.receivedAmount).toBe(115);
    expect(response.body.revisions).toHaveLength(2);
    expect(response.body.revisions[1].before.receivedAmount).toBe(90);
    expect(response.body.revisions[1].after.receivedAmount).toBe(115);
    expect(response.body.revisions[1].movement.receivedAmount).toBe(25);
    expect(response.body.revisions[1].sourceRun.id).toBeTruthy();
  });
});