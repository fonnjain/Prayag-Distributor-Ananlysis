// Integration test: cascade-states endpoint full HTTP round-trip with real DB.
//
// WHAT THIS GUARD PROTECTS:
//   Task 260 added unit tests that validate the pure filter logic in isolation
//   (normaliseCustomerState, resolvePickerToStoredHead mock, buildCascadeStates).
//   This test adds the integration layer that was missing: it exercises the entire
//   chain through the REAL production route handler at its production path:
//
//     picker name → resolvePickerToStoredHead (DB query in marketSurvey.ts)
//     → customer_master query → buildCascadeStates → JSON response
//
//   The actual router from marketSurvey.ts is imported and mounted, so any
//   regression in alias resolution, the DB query, the normalisation map, or the
//   filter is caught by the same code that runs in production.
//
// DB SETUP (dashboard_test schema, set by setup-db.ts):
//   The test seeds a minimal fixture using stable sentinel IDs/values that are
//   unique to this test.  Cleanup deletes only those rows — it never truncates
//   or drops shared schema tables so other test files in the same vitest run
//   are unaffected regardless of execution order.
//
//   • person_registry   – one state head with canonical_name ≠ alias_secondary
//   • customer_master   – two customers in Rajasthan (raw upload state value),
//                         state_head = NULL initially
//   • sale_line_all     – rows so passStateLookup assigns Pawan Sharma to RAJASTHAN
//   • state_hierarchy   – 6 picker-visible rows covering 2 regions (NORTH/WEST)
//                         (inserted with stable sentinel display_order values in
//                          the 9000 range to avoid collisions with real rows)
//
// BACKFILL PATH USED:
//   runFullBackfill(pool) is called directly in beforeAll as test harness setup.
//   passStateLookup (Pass 3) fires: sale_line_all has Pawan Sharma as the sole
//   head for RAJASTHAN.  The two customer_master rows carry state='Rajasthan';
//   normaliseCustomerState maps that to 'RAJASTHAN' → state_head set.
//   Passes 1 and 2 find nothing (no name match, no distributorTmMap entry).
//
// ASSERTIONS:
//   1. After backfill, customer_master rows carry state_head = 'Pawan Sharma'.
//   2. GET /api/market-survey/cascade-states?stateHead=Pawan+Kumar+Sharma
//      returns HTTP 200 with a narrowed list (< 6 rows from the fixture).
//   3. The narrowed list contains RAJASTHAN and its parent NORTH.
//   4. States from the other region (GUJARAT, MAHARASHTRA, WEST) are absent.
//   5. Passing the stored alias_secondary directly yields the same result.
//   6. An unknown stateHead returns all 6 rows (graceful fallback).
//   7. No stateHead param returns all 6 rows (no filtering applied).

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { pool } from "@workspace/db";
import { runFullBackfill } from "../lib/customerStateHead.js";
import marketSurveyRouter from "./marketSurvey.js";

const SCHEMA = "dashboard_test";

// ── Sentinel identifiers ──────────────────────────────────────────────────────
//
// All fixture rows are tagged with these stable values so cleanup can target
// them precisely without affecting rows owned by other test files.

const HEAD_CANONICAL = "CASCADE265 Pawan Kumar Sharma"; // unique to this test
const HEAD_ALIAS     = "CASCADE265 Pawan Sharma";
const HEAD_NORM_KEY  = "CASCADE265 PAWAN KUMAR SHARMA";
const CM_ID_1        = "CASCADE265-CM-01";
const CM_ID_2        = "CASCADE265-CM-02";
const SL_UID_1       = "CASCADE265-SL-001";
const SL_UID_2       = "CASCADE265-SL-002";
// display_order values in the 9000 range are outside real data (0–200 range).
const SH_BASE_ORDER  = 9265;

// ── Minimal in-process test server ───────────────────────────────────────────
//
// The REAL marketSurveyRouter is mounted at /api/market-survey so the
// production route handler (not a duplicate) processes each request.  The
// cascade-states handler catches its own errors and does not use req.log,
// so no pino-http middleware is required.

// In the real app, marketSurveyRouter is mounted at /api (no sub-path):
//   router.use(marketSurveyRouter)  → app.use("/api", router)
// The route registers itself as "/market-survey/cascade-states" so the full
// production path is /api/market-survey/cascade-states.
const app = express();
app.use(express.json());
app.use("/api", marketSurveyRouter);

// ── Table setup ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  // ── person_registry ───────────────────────────────────────────────────────
  // The table already exists in dashboard_test (created by other test files).
  // Insert only this test's sentinel row; do not truncate.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.person_registry (
      canonical_name  TEXT,
      alias_secondary TEXT,
      is_state_head   BOOLEAN DEFAULT false,
      norm_key        TEXT,
      state_head      TEXT,
      is_person       BOOLEAN DEFAULT true
    )
  `);
  // Upsert-style: remove any leftover from a previous failed run, then insert.
  await pool.query(
    `DELETE FROM ${SCHEMA}.person_registry WHERE norm_key = $1`,
    [HEAD_NORM_KEY],
  );
  // canonical_name ≠ alias_secondary — this is the alias-mismatch scenario
  // that originally caused the picker to return all 33 states.
  await pool.query(
    `INSERT INTO ${SCHEMA}.person_registry
       (canonical_name, alias_secondary, is_state_head, norm_key, is_person)
     VALUES ($1, $2, true, $3, true)`,
    [HEAD_CANONICAL, HEAD_ALIAS, HEAD_NORM_KEY],
  );

  // ── sale_line_all ─────────────────────────────────────────────────────────
  // The table already exists in dashboard_test with line_uid/fy/month_label
  // as NOT NULL.  Insert only this test's two sentinel rows.
  await pool.query(
    `DELETE FROM ${SCHEMA}.sale_line_all WHERE line_uid IN ($1, $2)`,
    [SL_UID_1, SL_UID_2],
  );
  // Pawan Sharma is the SOLE head for RAJASTHAN in the fixture so
  // passStateLookup will assign him to every customer in that state.
  await pool.query(`
    INSERT INTO ${SCHEMA}.sale_line_all
      (line_uid, fy, month_label, version_status, customer, head_canon, state_canon)
    VALUES
      ($1, '2025-26', 'Apr-25', 'current', 'CASCADE265 DIST 1', $3, 'RAJASTHAN'),
      ($2, '2025-26', 'Apr-25', 'current', 'CASCADE265 DIST 2', $3, 'RAJASTHAN')`,
    [SL_UID_1, SL_UID_2, HEAD_ALIAS],
  );

  // ── customer_master ───────────────────────────────────────────────────────
  // The table does not yet exist in dashboard_test; create it with the minimal
  // NOT NULL columns matching the real public.customer_master constraints.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.customer_master (
      id              TEXT PRIMARY KEY,
      company         TEXT NOT NULL,
      state           TEXT,
      state_head      TEXT,
      head_confidence TEXT NOT NULL DEFAULT '',
      type            TEXT DEFAULT 'Distributor',
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Upsert: if a previous failed run left these rows, reset them.
  await pool.query(
    `INSERT INTO ${SCHEMA}.customer_master (id, company, state, state_head)
     VALUES
       ($1, 'CASCADE265 Raj Distributors', 'Rajasthan', NULL),
       ($2, 'CASCADE265 Jaipur Traders',   'Rajasthan', NULL)
     ON CONFLICT (id) DO UPDATE
       SET state_head = NULL, head_confidence = ''`,
    [CM_ID_1, CM_ID_2],
  );

  // ── state_hierarchy ───────────────────────────────────────────────────────
  // The real cascade-states route queries state_hierarchy.  In production the
  // table lives in the public schema (no schema qualifier in the query), which
  // the dashboard_test search_path shadows.  Create a fixture version with 6
  // picker-visible rows across two regions so the narrowing assertion is
  // meaningful.  Use sentinel display_order values (9265–9270) to avoid
  // colliding with real rows if the table already has data from another test.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.state_hierarchy (
      state_canon    TEXT,
      state_parent   TEXT,
      is_split       BOOLEAN DEFAULT false,
      picker_visible BOOLEAN DEFAULT true,
      display_order  INT
    )
  `);
  // Remove any stale sentinel rows from a previous run.
  await pool.query(
    `DELETE FROM ${SCHEMA}.state_hierarchy
      WHERE display_order BETWEEN $1 AND $2`,
    [SH_BASE_ORDER, SH_BASE_ORDER + 5],
  );
  // Use real-vocabulary state names so normaliseCustomerState("Rajasthan")
  // → "RAJASTHAN" matches the state_canon in the fixture.  The sentinel
  // display_order values (9265–9270) ensure these rows don't collide with any
  // real rows even if state_hierarchy already has data from another test.
  await pool.query(`
    INSERT INTO ${SCHEMA}.state_hierarchy
      (state_canon, state_parent, is_split, picker_visible, display_order)
    VALUES
      ('NORTH',       'NORTH', false, true, ${SH_BASE_ORDER}),
      ('RAJASTHAN',   'NORTH', false, true, ${SH_BASE_ORDER + 1}),
      ('DELHI',       'NORTH', false, true, ${SH_BASE_ORDER + 2}),
      ('WEST',        'WEST',  false, true, ${SH_BASE_ORDER + 3}),
      ('GUJARAT',     'WEST',  false, true, ${SH_BASE_ORDER + 4}),
      ('MAHARASHTRA', 'WEST',  false, true, ${SH_BASE_ORDER + 5})
  `);

  // ── Run backfill ──────────────────────────────────────────────────────────
  // runFullBackfill is called directly here as test-harness setup; the HTTP
  // POST /api/admin/backfill-customer-state-head exercises the same function.
  // passStateLookup will find Pawan Sharma is the sole head for RAJASTHAN and
  // set state_head on the two CASCADE265 customer rows.
  await runFullBackfill(pool);
}, 60_000);

afterAll(async () => {
  // Delete only the sentinel rows this test introduced — never truncate or
  // drop shared schema tables so other test files are not affected.
  await pool.query(
    `DELETE FROM ${SCHEMA}.person_registry WHERE norm_key = $1`,
    [HEAD_NORM_KEY],
  );
  await pool.query(
    `DELETE FROM ${SCHEMA}.customer_master WHERE id IN ($1, $2)`,
    [CM_ID_1, CM_ID_2],
  );
  await pool.query(
    `DELETE FROM ${SCHEMA}.sale_line_all WHERE line_uid IN ($1, $2)`,
    [SL_UID_1, SL_UID_2],
  );
  await pool.query(
    `DELETE FROM ${SCHEMA}.state_hierarchy
      WHERE display_order BETWEEN $1 AND $2`,
    [SH_BASE_ORDER, SH_BASE_ORDER + 5],
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cascade-states HTTP round-trip via real production router", () => {
  it("backfill populates state_head on the sentinel customer rows", async () => {
    const { rows } = await pool.query<{ state_head: string | null }>(
      `SELECT state_head FROM ${SCHEMA}.customer_master WHERE id IN ($1, $2)`,
      [CM_ID_1, CM_ID_2],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state_head === HEAD_ALIAS)).toBe(true);
  });

  it("GET cascade-states with canonical_name returns narrowed list (not all 6 rows)", async () => {
    // The picker sends the canonical_name ("Pawan Kumar Sharma" form); the route
    // must resolve it to the stored alias_secondary ("Pawan Sharma" form) before
    // querying customer_master, otherwise no rows are found and the response
    // falls back to all states.
    const res = await request(app).get(
      `/api/market-survey/cascade-states?stateHead=${encodeURIComponent(HEAD_CANONICAL)}`,
    );

    expect(res.status).toBe(200);

    const states: { canon: string; parent: string; isSplit: boolean }[] = res.body.states;

    // Narrowed: strictly fewer than the 6 fixture rows.
    expect(states.length).toBeGreaterThan(0);
    expect(states.length).toBeLessThan(6);

    // His territory: RAJASTHAN leaf and NORTH parent must appear.
    const canons = states.map((s) => s.canon);
    expect(canons).toContain("RAJASTHAN");
    expect(canons).toContain("NORTH");

    // The other region must be absent.
    expect(canons).not.toContain("GUJARAT");
    expect(canons).not.toContain("MAHARASHTRA");
    expect(canons).not.toContain("WEST");

    // DELHI shares NORTH with RAJASTHAN but Pawan Sharma has no customers
    // there — the cascade filter must exclude it.
    expect(canons).not.toContain("DELHI");
  });

  it("GET cascade-states with alias_secondary (stored form) also returns narrowed list", async () => {
    // Passing alias_secondary directly also resolves correctly via
    // resolvePickerToStoredHead (the WHERE clause covers both canonical_name
    // and alias_secondary), so the picker works regardless of which name
    // variant the frontend sends.
    const res = await request(app).get(
      `/api/market-survey/cascade-states?stateHead=${encodeURIComponent(HEAD_ALIAS)}`,
    );

    expect(res.status).toBe(200);
    const canons: string[] = res.body.states.map(
      (s: { canon: string }) => s.canon,
    );
    expect(canons).toContain("RAJASTHAN");
    expect(canons).toContain("NORTH");
    expect(canons).not.toContain("GUJARAT");
  });

  it("GET cascade-states with unknown stateHead falls back to all fixture rows", async () => {
    // No customer_master rows exist for this name → zero rows in headStates →
    // the route returns all picker-visible states (graceful fallback).
    const res = await request(app).get(
      "/api/market-survey/cascade-states?stateHead=Completely+Unknown+Person+XYZ",
    );

    expect(res.status).toBe(200);
    // All 6 fixture rows returned (plus any real rows if running against a
    // populated DB — compare by checking it is NOT narrowed to fewer than 6).
    const states: unknown[] = res.body.states;
    expect(states.length).toBeGreaterThanOrEqual(6);
  });

  it("GET cascade-states with no stateHead param returns all fixture rows (no filter)", async () => {
    const res = await request(app).get("/api/market-survey/cascade-states");

    expect(res.status).toBe(200);
    const states: unknown[] = res.body.states;
    expect(states.length).toBeGreaterThanOrEqual(6);
  });
});
