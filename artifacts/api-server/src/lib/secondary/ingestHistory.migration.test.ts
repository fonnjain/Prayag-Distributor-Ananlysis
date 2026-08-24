// Executes migration 073 against a populated legacy-shaped table in the
// isolated test schema. This verifies the baseline migration itself rather
// than a lookalike fixture schema.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pool, runMigrations } from "@workspace/db";

const MIGRATION_ID = "073_secondary_head_month_history";

function migrationIdsBeforeHistory(): string[] {
  const candidates = [
    resolve(process.cwd(), "../../lib/db/src/runMigrations.ts"),
    resolve(process.cwd(), "lib/db/src/runMigrations.ts"),
  ];
  const file = candidates.find((candidate) => {
    try {
      readFileSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (!file) throw new Error("Could not locate runMigrations.ts");
  return [...readFileSync(file, "utf8").matchAll(/id:\s*"([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter((id) => id !== MIGRATION_ID);
}

beforeAll(async () => {
  // The vitest setup scopes this connection to dashboard_test, so these drops
  // cannot affect the development schema.
  await pool.query(`
    DROP TABLE IF EXISTS secondary_head_month_revision;
    DROP TABLE IF EXISTS secondary_head_month;
    DROP TABLE IF EXISTS secondary_ingest_run;
    DROP TABLE IF EXISTS schema_migrations;

    CREATE TABLE secondary_ingest_run (
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
    CREATE TABLE secondary_head_month (
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
      ingested_at timestamptz DEFAULT now(),
      -- Simulate Replit's publish-time schema diff: the schema object may
      -- already exist even though this app-managed migration has no ledger row.
      ingest_run_id integer,
      CONSTRAINT secondary_head_month_ingest_run_fk
        FOREIGN KEY (ingest_run_id) REFERENCES secondary_ingest_run(id),
      UNIQUE (fy, head_canon, month_label)
    );
    INSERT INTO secondary_head_month (
      fy, head_raw, head_canon, state_head, month_label, month_idx,
      plan_amount, ordered_amount, received_amount, achievement_pct,
      source_sheet_id
    ) VALUES
      ('TEST-LEGACY-HISTORY', 'Legacy One', 'legacyone', 'Legacy Head', 'Apr-99', 0, 100, 120, 90, 90, 'legacy-sheet'),
      ('TEST-LEGACY-HISTORY', 'Legacy Two', 'legacytwo', 'Legacy Head', 'May-99', 1, 200, 230, 180, 90, 'legacy-sheet');
    CREATE TABLE schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  for (const id of migrationIdsBeforeHistory()) {
    await pool.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [id]);
  }
  await runMigrations();
});

afterAll(async () => {
  await pool.query(`
    DROP TABLE IF EXISTS secondary_head_month_revision;
    DROP TABLE IF EXISTS secondary_head_month;
    DROP TABLE IF EXISTS secondary_ingest_run;
    DROP TABLE IF EXISTS schema_migrations;
  `);
});

describe("073 secondary head-month history migration", () => {
  it("creates one labelled legacy baseline and reconciles every pre-existing current row", async () => {
    const result = await pool.query<{
      current_rows: number;
      unprovenanced_rows: number;
      baseline_runs: number;
      baseline_rows: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM secondary_head_month) AS current_rows,
        (SELECT COUNT(*)::int FROM secondary_head_month WHERE ingest_run_id IS NULL) AS unprovenanced_rows,
        (SELECT COUNT(*)::int FROM secondary_ingest_run WHERE source = 'legacy_baseline') AS baseline_runs,
        (
          SELECT COUNT(*)::int
          FROM secondary_head_month_revision revision
          JOIN secondary_ingest_run run ON run.id = revision.ingest_run_id
          WHERE run.source = 'legacy_baseline'
        ) AS baseline_rows
    `);
    expect(result.rows[0]).toEqual({
      current_rows: 2,
      unprovenanced_rows: 0,
      baseline_runs: 1,
      baseline_rows: 2,
    });
  });

  it("does not fabricate a second legacy baseline on a subsequent migration pass", async () => {
    await runMigrations();
    const result = await pool.query<{ runs: number; revisions: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM secondary_ingest_run WHERE source = 'legacy_baseline') AS runs,
        (SELECT COUNT(*)::int FROM secondary_head_month_revision) AS revisions
    `);
    expect(result.rows[0]).toEqual({ runs: 1, revisions: 2 });
  });
});