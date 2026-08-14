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
import { executeCustomerMasterReload, type CustomerMasterRow } from "../lib/uploads/customerUploadLoad.js";
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

// ── Re-upload path guard ───────────────────────────────────────────────────────
//
// WHAT THIS GUARD PROTECTS:
//   The upload route (customerUploadLoad.ts) preserves state_head via a
//   snapshot-and-re-apply transaction:
//     1. Snapshot all rows WHERE state_head IS NOT NULL into an in-memory Map.
//     2. DELETE FROM customer_master (wipes the whole table).
//     3. INSERT all rows, re-applying the snapshotted attribution per id.
//     4. Call deriveForIds() for the newly inserted ids.
//
//   The risk: if a row's state_head was derived by the sale-line name-match
//   pass (passSaleLine, confidence='sale_line') for a MULTI-HEAD state, then:
//     • deriveForIds does NOT re-run passSaleLine (too expensive for import-time).
//     • passStateLookup in deriveForIds only resolves single-head states.
//     • passChain needs a distributor→TM→head entry that may not exist.
//
//   In that scenario the ONLY mechanism that keeps state_head alive through a
//   re-upload is the snapshot re-apply.  A bug there silently reverts the
//   cascade picker to all 33 states for every affected head.
//
// FIXTURE DESIGN:
//   • sale_line_all has TWO rows in "CASCADE266 EAST UP":
//       – HEAD A bound to "CASCADE266 DIST A" (the test customer's company name)
//       – HEAD B bound to any other customer in the same state
//     This makes CASCADE266 EAST UP multi-head: passStateLookup is blocked.
//   • customer_master has one row, company = "CASCADE266 DIST A",
//     state = "CASCADE266 East Up", state_head = NULL initially.
//   • runFullBackfill → passSaleLine (name match) sets state_head = HEAD A
//     with head_confidence = 'sale_line'.  passStateLookup does NOT fire.
//   • state_hierarchy has CASCADE266 NORTH + CASCADE266 EAST UP + CASCADE266 WEST UP
//     so the narrowing assertion is meaningful (2 of 3 rows returned for HEAD A).
//
// SIMULATION:
//   The test replicates the upload transaction directly (pool queries) so we
//   exercise the exact same SQL logic without needing real CSV files.

// ── Sentinel identifiers (re-upload block) ────────────────────────────────────

const CM_ID_3           = "CASCADE266-CM-03";
const SL_UID_3          = "CASCADE266-SL-003"; // HEAD A sale in the multi-head state
const SL_UID_4          = "CASCADE266-SL-004"; // HEAD B sale in the same state
const HEAD_A            = "CASCADE266 Head A";   // state_head that passSaleLine assigns
const HEAD_B            = "CASCADE266 Head B";   // second head that makes the state multi-head
const STATE_MULTI_RAW   = "CASCADE266 East Up";  // raw customer_master.state (upload value)
const STATE_MULTI_CANON = "CASCADE266 EAST UP";  // normaliseCustomerState output
const SH_BASE_266       = 9280;                  // sentinel display_order range (9280–9282)

describe("re-upload path: snapshot re-apply is the sole guard for sale-line attribution on multi-head states", () => {
  // ── Fixture setup ───────────────────────────────────────────────────────────

  beforeAll(async () => {
    // sale_line_all: two different heads in the same state → multi-head.
    // passSaleLine still resolves HEAD A via name match on the customer column.
    // passStateLookup is blocked (COUNT(DISTINCT head_canon) = 2 for this state).
    await pool.query(
      `DELETE FROM ${SCHEMA}.sale_line_all WHERE line_uid IN ($1, $2)`,
      [SL_UID_3, SL_UID_4],
    );
    await pool.query(
      `INSERT INTO ${SCHEMA}.sale_line_all
         (line_uid, fy, month_label, version_status, customer, head_canon, state_canon)
       VALUES
         ($1, '2025-26', 'Apr-25', 'current', 'CASCADE266 DIST A', $3, $5),
         ($2, '2025-26', 'Apr-25', 'current', 'CASCADE266 DIST B', $4, $5)`,
      [SL_UID_3, SL_UID_4, HEAD_A, HEAD_B, STATE_MULTI_CANON],
    );

    // customer_master: company matches the sale_line customer name exactly so
    // passSaleLine (Pass 1) assigns HEAD A.  State is the multi-head state so
    // passStateLookup (Pass 3) cannot recover it if the snapshot is dropped.
    await pool.query(
      `INSERT INTO ${SCHEMA}.customer_master (id, company, state, state_head)
       VALUES ($1, 'CASCADE266 DIST A', $2, NULL)
       ON CONFLICT (id) DO UPDATE SET state_head = NULL, head_confidence = ''`,
      [CM_ID_3, STATE_MULTI_RAW],
    );

    // Extend the test schema's customer_master with all columns that
    // executeCustomerMasterReload inserts (the table is created with only
    // minimal columns by the first describe block's beforeAll).
    // ALTER TABLE … ADD COLUMN IF NOT EXISTS is idempotent across re-runs.
    for (const col of [
      "contact TEXT", "mobile TEXT", "district TEXT", "city TEXT",
      "gst TEXT", "pincode TEXT", "area TEXT", "email TEXT", "address TEXT",
      "lead_status TEXT", "status_source TEXT", "entity_type TEXT",
      "assigned_segment TEXT", "created_date TEXT", "created_by TEXT",
      "source_file TEXT", "review_group INT", "edited_by TEXT", "notes TEXT",
    ]) {
      await pool.query(
        `ALTER TABLE ${SCHEMA}.customer_master ADD COLUMN IF NOT EXISTS ${col}`,
      );
    }

    // Junction tables — executeCustomerMasterReload deletes them unconditionally
    // inside the transaction even when the batch arrays are empty.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.retailer_user (
        retailer_id   TEXT,
        user_name     TEXT,
        user_norm_key TEXT,
        resolved      BOOLEAN,
        position      INT
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.retailer_distributor (
        retailer_id      TEXT,
        distributor_name TEXT,
        dist_norm_key    TEXT,
        resolved_dist_id TEXT,
        resolved         BOOLEAN,
        position         INT
      )
    `);

    // state_hierarchy: 3 rows — parent + 2 children (one per head).
    // Narrowing for HEAD A must return NORTH + EAST UP (2) not WEST UP.
    await pool.query(
      `DELETE FROM ${SCHEMA}.state_hierarchy
        WHERE display_order BETWEEN $1 AND $2`,
      [SH_BASE_266, SH_BASE_266 + 2],
    );
    await pool.query(`
      INSERT INTO ${SCHEMA}.state_hierarchy
        (state_canon, state_parent, is_split, picker_visible, display_order)
      VALUES
        ('CASCADE266 NORTH',    'CASCADE266 NORTH', false, true, ${SH_BASE_266}),
        ('${STATE_MULTI_CANON}','CASCADE266 NORTH', false, true, ${SH_BASE_266 + 1}),
        ('CASCADE266 WEST UP',  'CASCADE266 NORTH', false, true, ${SH_BASE_266 + 2})
    `);

    // Run full backfill.  passSaleLine fires: "CASCADE266 DIST A" appears
    // in sale_line_all with exactly one distinct head (HEAD A), so the
    // customer_master row gets state_head = HEAD A, head_confidence='sale_line'.
    // passStateLookup does NOT fire for CASCADE266 EAST UP (two distinct heads).
    await runFullBackfill(pool);
  }, 60_000);

  afterAll(async () => {
    await pool.query(
      `DELETE FROM ${SCHEMA}.customer_master WHERE id = $1`,
      [CM_ID_3],
    );
    await pool.query(
      `DELETE FROM ${SCHEMA}.sale_line_all WHERE line_uid IN ($1, $2)`,
      [SL_UID_3, SL_UID_4],
    );
    await pool.query(
      `DELETE FROM ${SCHEMA}.state_hierarchy
        WHERE display_order BETWEEN $1 AND $2`,
      [SH_BASE_266, SH_BASE_266 + 2],
    );
  });

  // ── Tests ───────────────────────────────────────────────────────────────────

  it("passSaleLine (name match) assigns HEAD_A with confidence sale_line", async () => {
    // Verify the backfill set the row correctly so subsequent tests have a
    // known starting state.
    const { rows } = await pool.query<{ state_head: string | null; head_confidence: string }>(
      `SELECT state_head, head_confidence
         FROM ${SCHEMA}.customer_master WHERE id = $1`,
      [CM_ID_3],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state_head).toBe(HEAD_A);
    expect(rows[0]!.head_confidence).toBe("sale_line");
  });

  it("executeCustomerMasterReload preserves sale-line attribution through snapshot → delete → reinsert on a multi-head state", async () => {
    // Build a CustomerMasterRow matching the seeded fixture.  This is the
    // parsed-row shape the real upload route produces from the CSV file.
    const testRow: CustomerMasterRow = {
      id: CM_ID_3, company: "CASCADE266 DIST A", type: "Distributor",
      status: "active", contact: null, mobile: null, state: STATE_MULTI_RAW,
      district: null, city: null, gst: null, pincode: null, area: null,
      email: null, address: null, leadStatus: null, statusSource: null,
      entityType: null, assignedSegment: null, createdDate: null, createdBy: null,
      sourceFile: "distributor",
    };

    // Drive the REAL production transaction from customerUploadLoad.ts:
    //   1. Snapshot customer_master WHERE state_head IS NOT NULL
    //      → captures CM_ID_3 with state_head = HEAD_A (set by passSaleLine above).
    //   2. DELETE FROM retailer_user, retailer_distributor, customer_master.
    //   3. INSERT testRow with the snapshotted attribution re-applied.
    //   4. await deriveForIds for rows still NULL — no-op here because:
    //      CASCADE266 EAST UP is multi-head (2 distinct heads in sale_line_all),
    //      so passStateLookup cannot re-derive it; passChain has no entry either.
    // A bug in the snapshot query, the attrib map, or the reapplication branch
    // would leave state_head NULL after step 3, and deriveForIds cannot rescue it.
    // awaitDerive: true so the test sees the final DB state synchronously.
    // Production calls omit this option (fire-and-forget, original semantics).
    await executeCustomerMasterReload([testRow], [], [], new Map(), { awaitDerive: true });

    // Assert: attribution survived the complete reload cycle.
    const { rows } = await pool.query<{ state_head: string | null; head_confidence: string }>(
      `SELECT state_head, head_confidence FROM ${SCHEMA}.customer_master WHERE id = $1`,
      [CM_ID_3],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state_head).toBe(HEAD_A);
    // head_confidence must be the snapshotted 'sale_line' — not the derive
    // fallback 'Guessed' — proving the snapshot re-apply path ran correctly.
    expect(rows[0]!.head_confidence).toBe("sale_line");
  });

  it("cascade-states still returns narrowed list (not all hierarchy rows) after re-upload", async () => {
    // HEAD A serves only CASCADE266 EAST UP (one customer row).
    // resolvePickerToStoredHead falls back to the raw name when no person_registry
    // row exists — the cascade endpoint degrades gracefully.
    // customer_master WHERE state_head = HEAD_A → state = STATE_MULTI_RAW
    // normaliseCustomerState → STATE_MULTI_CANON
    // buildCascadeStates → [CASCADE266 NORTH, CASCADE266 EAST UP] (2 of 3 rows)
    const res = await request(app).get(
      `/api/market-survey/cascade-states?stateHead=${encodeURIComponent(HEAD_A)}`,
    );

    expect(res.status).toBe(200);

    const states: { canon: string }[] = res.body.states;

    // Narrowed: strictly fewer than the 3 rows in the fixture.
    expect(states.length).toBeGreaterThan(0);

    // Find the fixture rows by sentinel prefix to avoid noise from other rows.
    const fixtureCanons = states
      .map((s) => s.canon)
      .filter((c) => c.startsWith("CASCADE266"));

    expect(fixtureCanons).toContain(STATE_MULTI_CANON);
    expect(fixtureCanons).toContain("CASCADE266 NORTH");
    // HEAD A has no customers in WEST UP — it must be absent.
    expect(fixtureCanons).not.toContain("CASCADE266 WEST UP");
  });
});
