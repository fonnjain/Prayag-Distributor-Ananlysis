// Points every test at an isolated "dashboard_test" Postgres schema so tests
// can truncate and seed freely without touching the real dashboard_snapshots
// table in the public schema.
//
// This runs before any test file imports @workspace/db, so the pool is created
// with a connection whose search_path is the test schema.
import { afterAll } from "vitest";

const SCHEMA = "dashboard_test";

const base = process.env.DATABASE_URL;
if (!base) {
  throw new Error("DATABASE_URL must be set to run api-server tests");
}

const url = new URL(base);
url.searchParams.set("options", `-csearch_path=${SCHEMA}`);
process.env.DATABASE_URL = url.toString();

const { pool } = await import("@workspace/db");

await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
await pool.query(`
  CREATE TABLE IF NOT EXISTS ${SCHEMA}.dashboard_snapshots (
    id serial PRIMARY KEY,
    data jsonb NOT NULL,
    manifest jsonb NOT NULL,
    source_status text NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now()
  )
`);

// Safety check: refuse to run if the connection is not actually scoped to the
// test schema (otherwise truncates would hit the real table).
const { rows } = await pool.query("SHOW search_path");
if (!String(rows[0]?.search_path ?? "").includes(SCHEMA)) {
  throw new Error(
    `search_path is "${rows[0]?.search_path}", expected "${SCHEMA}"; refusing to run DB tests`,
  );
}

export async function truncateSnapshots(): Promise<void> {
  await pool.query(`TRUNCATE ${SCHEMA}.dashboard_snapshots RESTART IDENTITY`);
}

export async function snapshotCount(): Promise<number> {
  const res = await pool.query(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.dashboard_snapshots`,
  );
  return res.rows[0].n as number;
}

afterAll(async () => {
  await pool.end();
});
