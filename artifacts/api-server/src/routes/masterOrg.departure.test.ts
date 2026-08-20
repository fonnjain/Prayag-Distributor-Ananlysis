// Integration tests: state-head departure lifecycle (real DB, real router).
//
// WHAT THIS GUARD PROTECTS:
//   1. Recording a departure never orphans customers — every open
//      customer_assignment involving the departed person is closed and
//      reopened against the auto-created holding person (same open count).
//   2. Repeated / concurrent departure submissions cannot overwrite the
//      recorded departure or re-date the holding moves (row lock + partial
//      unique index uq_person_holding_for).
//   3. Departed and holding persons cannot be reactivated via the plain
//      reactivate route — that would leave a person "active" yet departed
//      while their customers sit in holding.
//   4. Resolving a holding moves all assignments to the replacement and
//      deactivates the holding person; GET /master/holding then reports none.
//
// Fixtures use ZZDEP-prefixed sentinel values and are cleaned up in afterAll.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { pool } from "@workspace/db";
import masterOrgRouter from "./masterOrg.js";

const ADMIN = process.env.ADMIN_SECRET ?? "";
const CUST = "ZZDEP#1";
const VOID_CUST = "ZZDEP#VOID";

let headId: number;
let replacementId: number;
let holdingId: number;

const app = express();
app.use(express.json());
app.use("/api", masterOrgRouter);

async function cleanup() {
  await pool.query(`DELETE FROM customer_assignment WHERE customer_id LIKE 'ZZDEP#%'`);
  const ids = await pool.query(
    `SELECT person_id FROM person WHERE name LIKE 'ZZDEP %' OR name LIKE 'HOLDING — ZZDEP %'`,
  );
  const idList = ids.rows.map((r: any) => r.person_id);
  if (idList.length) {
    await pool.query(`DELETE FROM person_state_coverage WHERE person_id = ANY($1::int[]) OR state_head_person_id = ANY($1::int[])`, [idList]);
    await pool.query(
      `DELETE FROM change_log WHERE entity_type = 'person' AND entity_id = ANY($1::text[])`,
      [idList.map(String)],
    );
    // Delete holding persons first (FK holding_for_person_id).
    await pool.query(`DELETE FROM person WHERE is_holding AND holding_for_person_id = ANY($1::int[])`, [idList]);
    await pool.query(`DELETE FROM person WHERE person_id = ANY($1::int[])`, [idList]);
  }
  await pool.query(`DELETE FROM customer WHERE customer_id LIKE 'ZZDEP#%'`);
  await pool.query(`DELETE FROM state_hierarchy WHERE state_canon LIKE 'ZZDEP %'`);
}

beforeAll(async () => {
  // The dashboard_test schema is bare — create the master-org tables this
  // suite exercises (mirrors migrations 030/046/047 for the columns used).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS person (
      person_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      employee_code TEXT,
      designation_id INTEGER,
      reports_to_person_id INTEGER,
      state_head_person_id INTEGER,
      is_state_head BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      headquarter TEXT,
      order_type TEXT,
      source TEXT NOT NULL DEFAULT 'app_created',
      left_date DATE,
      departure_reason TEXT,
      departure_note TEXT,
      is_holding BOOLEAN NOT NULL DEFAULT false,
       is_system_coverage BOOLEAN NOT NULL DEFAULT false,
      holding_for_person_id INTEGER REFERENCES person(person_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
     ALTER TABLE person ADD COLUMN IF NOT EXISTS is_system_coverage BOOLEAN NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_person_holding_for
      ON person (holding_for_person_id) WHERE is_holding;
    CREATE TABLE IF NOT EXISTS customer (
      customer_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      source TEXT,
      territory_id INTEGER
    );
    ALTER TABLE customer ADD COLUMN IF NOT EXISTS territory_id INTEGER;
    CREATE TABLE IF NOT EXISTS customer_review_queue (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      proposed_territory_id INTEGER,
      proposed_person_id INTEGER,
      notes TEXT,
      submitted_by TEXT,
      review_status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      approved_customer_id TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS customer_assignment (
      id SERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL,
      person_id INTEGER,
      state_head_person_id INTEGER,
      confidence TEXT NOT NULL,
      effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
      effective_to DATE,
      set_by TEXT,
      former_person_name_raw TEXT
    );
    ALTER TABLE customer_assignment ADD COLUMN IF NOT EXISTS former_person_name_raw TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_assignment_open
      ON customer_assignment (customer_id) WHERE effective_to IS NULL;
    CREATE TABLE IF NOT EXISTS designation (
      designation_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      rank INTEGER
    );
    CREATE TABLE IF NOT EXISTS territory (
      territory_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      parent_territory_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS person_territory (
      person_id INTEGER NOT NULL,
      territory_id INTEGER NOT NULL,
      effective_from DATE,
      effective_to DATE
    );
     CREATE TABLE IF NOT EXISTS state_hierarchy (
       state_canon TEXT PRIMARY KEY,
       state_parent TEXT NOT NULL,
       is_split BOOLEAN NOT NULL DEFAULT false,
       picker_visible BOOLEAN NOT NULL DEFAULT true,
       display_order INTEGER NOT NULL DEFAULT 999
     );
     CREATE TABLE IF NOT EXISTS person_state_coverage (
       coverage_id BIGSERIAL PRIMARY KEY,
       person_id INTEGER NOT NULL,
       state_canon TEXT NOT NULL,
       state_head_person_id INTEGER NOT NULL,
       effective_from DATE NOT NULL,
       effective_to DATE,
       fiscal_year TEXT,
       evidence_customer_count INTEGER,
       evidence_net_amount NUMERIC,
       evidence_source TEXT,
       source TEXT NOT NULL DEFAULT 'migration',
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (person_id, state_canon, state_head_person_id, effective_from)
     );
     ALTER TABLE person_state_coverage
       ADD COLUMN IF NOT EXISTS fiscal_year TEXT,
       ADD COLUMN IF NOT EXISTS evidence_customer_count INTEGER,
       ADD COLUMN IF NOT EXISTS evidence_net_amount NUMERIC,
        ADD COLUMN IF NOT EXISTS evidence_source TEXT,
        ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voided_by TEXT,
        ADD COLUMN IF NOT EXISTS void_reason TEXT;
      ALTER TABLE customer_assignment
        ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voided_by TEXT,
        ADD COLUMN IF NOT EXISTS void_reason TEXT;
      DROP INDEX IF EXISTS uq_customer_assignment_open;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_assignment_open
        ON customer_assignment (customer_id)
        WHERE effective_to IS NULL AND voided_at IS NULL;
    CREATE TABLE IF NOT EXISTS change_log (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await cleanup();
  const h = await pool.query(
    `INSERT INTO person (name, is_state_head, source) VALUES ('ZZDEP Head', true, 'app_created') RETURNING person_id`,
  );
  headId = h.rows[0].person_id;
  const r = await pool.query(
    `INSERT INTO person (name, source) VALUES ('ZZDEP Replacement', 'app_created') RETURNING person_id`,
  );
  replacementId = r.rows[0].person_id;
  await pool.query(
    `INSERT INTO customer (customer_id, name, type, source) VALUES ($1, 'ZZDEP Customer', 'distributor', 'app_created')
     ON CONFLICT (customer_id) DO NOTHING`,
    [CUST],
  );
  await pool.query(
      `INSERT INTO customer_assignment
         (customer_id, person_id, state_head_person_id, confidence, effective_from, set_by)
       VALUES ($1, $2, $2, 'confirmed', DATE '2026-07-01', 'departure-test')`,
    [CUST, headId],
  );
});

afterAll(async () => {
  await cleanup();
});

const departureBody = {
  left_date: "2026-08-30",
  departure_reason: "resigned",
  departure_note: "test",
  acknowledgedSubTree: 0,
  acknowledgedCustomers: 1,
  changed_by: "departure-test",
};

describe("departure lifecycle", () => {
  it("serves canonical coverage with its head and effective dates, not legacy territory", async () => {
    await pool.query(`DELETE FROM state_hierarchy WHERE state_canon = 'ZZDEP CANONICAL LEAF'`);
    await pool.query(
      `INSERT INTO state_hierarchy (state_canon, state_parent, picker_visible, display_order)
       VALUES ('ZZDEP CANONICAL LEAF', 'ZZDEP', true, 1)`,
    );
    await pool.query(
      `INSERT INTO person_state_coverage
         (person_id, state_canon, state_head_person_id, effective_from, effective_to)
       VALUES ($1, 'ZZDEP CANONICAL LEAF', $1, DATE '2025-04-01', DATE '2026-03-31')`,
      [headId],
    );
    const res = await request(app).get(`/api/master/people/${headId}`);
    expect(res.status).toBe(200);
    expect(res.body.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state_canon: "ZZDEP CANONICAL LEAF",
        state_head_person_id: headId,
        state_head_name: "ZZDEP Head",
        effective_from: "2025-04-01",
        effective_to: "2026-03-31",
        alias_review_status: null,
        register_head_label: null,
      }),
    ]));
  });

  it("rejects departure with mismatched impact acknowledgment (409)", async () => {
    const res = await request(app)
      .post(`/api/master/people/${headId}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send({ ...departureBody, acknowledgedCustomers: 99 });
    expect(res.status).toBe(409);
  });

  it("records a departure and moves every open assignment to a holding person", async () => {
    const res = await request(app)
      .post(`/api/master/people/${headId}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send(departureBody);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.assignmentsMoved).toBe(1);
    holdingId = res.body.holdingPersonId;

    // No orphan: exactly one open row, owned by the holding person.
    const open = await pool.query(
      `SELECT person_id, state_head_person_id FROM customer_assignment
       WHERE customer_id = $1 AND effective_to IS NULL`,
      [CUST],
    );
    expect(open.rows.length).toBe(1);
    expect(open.rows[0].person_id).toBe(holdingId);
    expect(open.rows[0].state_head_person_id).toBe(holdingId);

    const p = await pool.query(`SELECT is_active, left_date FROM person WHERE person_id = $1`, [headId]);
    expect(p.rows[0].is_active).toBe(false);
    expect(p.rows[0].left_date).not.toBeNull();
  });

  it("voids assignments and coverage imported after departure into the unassigned queue", async () => {
    const postDepartureHead = await pool.query(
      `INSERT INTO person (name, is_state_head, source)
       VALUES ('ZZDEP Post-Departure Import', true, 'app_created')
       RETURNING person_id`,
    );
    const personId = postDepartureHead.rows[0].person_id;
    await pool.query(
      `INSERT INTO state_hierarchy (state_canon, state_parent, picker_visible, display_order)
       VALUES ('ZZDEP VOID LEAF', 'ZZDEP', true, 2)`,
    );
    await pool.query(
      `INSERT INTO person_state_coverage
         (person_id, state_canon, state_head_person_id, effective_from)
       VALUES ($1, 'ZZDEP VOID LEAF', $1, DATE '2026-08-15')`,
      [personId],
    );
    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source)
       VALUES ($1, 'ZZDEP Void Customer', 'retailer', 'app_created')`,
      [VOID_CUST],
    );
    await pool.query(
      `INSERT INTO customer_assignment
         (customer_id, person_id, state_head_person_id, confidence, effective_from, set_by)
       VALUES ($1, $2, $2, 'assign_user_chain', DATE '2026-08-15', 'seed_import')`,
      [VOID_CUST, personId],
    );

    const res = await request(app)
      .post(`/api/master/people/${personId}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send({
        left_date: "2026-03-31",
        departure_reason: "confirmed departure",
        departure_note: "Date inferred from the confirmed territory handover.",
        acknowledgedSubTree: 0,
        acknowledgedCustomers: 1,
        changed_by: "departure-test",
        voidPostDepartureImports: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.holdingPersonId).toBeNull();
    expect(res.body.assignmentsMoved).toBe(0);
    expect(res.body.assignmentsVoidedToUnassigned).toEqual([VOID_CUST]);
    expect(res.body.coverageVoided).toEqual([
      expect.objectContaining({ state_canon: "ZZDEP VOID LEAF" }),
    ]);

    const assignments = await pool.query(
      `SELECT person_id, former_person_name_raw, voided_at
       FROM customer_assignment
       WHERE customer_id = $1 ORDER BY id`,
      [VOID_CUST],
    );
    expect(assignments.rows).toEqual([
      expect.objectContaining({ person_id: personId, voided_at: expect.any(Date) }),
      expect.objectContaining({
        person_id: null,
        former_person_name_raw: "ZZDEP Post-Departure Import",
        voided_at: null,
      }),
    ]);

    const coverage = await pool.query(
      `SELECT voided_at, void_reason FROM person_state_coverage
       WHERE person_id = $1 AND state_canon = 'ZZDEP VOID LEAF'`,
      [personId],
    );
    expect(coverage.rows[0].voided_at).toBeInstanceOf(Date);
    expect(coverage.rows[0].void_reason).toContain("Imported after recorded departure");

    const detail = await request(app).get(`/api/master/people/${personId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.coverage).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ state_canon: "ZZDEP VOID LEAF" }),
    ]));

    const sourceBefore = await pool.query(
      `SELECT id, effective_to, voided_at
       FROM customer_assignment
       WHERE customer_id = $1 AND person_id = $2`,
      [VOID_CUST, personId],
    );
    const reassigned = await request(app)
      .patch(`/api/master/customers/${encodeURIComponent(VOID_CUST)}/assign`)
      .set("X-Admin-Secret", ADMIN)
      .send({
        person_id: replacementId,
        state_head_person_id: replacementId,
        confidence: "confirmed",
        changed_by: "departure-test",
      });
    expect(reassigned.status).toBe(200);
    const sourceAfter = await pool.query(
      `SELECT id, effective_to, voided_at
       FROM customer_assignment
       WHERE id = $1`,
      [sourceBefore.rows[0].id],
    );
    expect(sourceAfter.rows[0].effective_to).toBeNull();
    expect(sourceAfter.rows[0].voided_at).toEqual(sourceBefore.rows[0].voided_at);
  });

  it("rejects post-departure non-import rows instead of back-dating them", async () => {
    const head = await pool.query(
      `INSERT INTO person (name, is_state_head, source)
       VALUES ('ZZDEP Non-Import After Departure', true, 'app_created')
       RETURNING person_id`,
    );
    const personId = head.rows[0].person_id;
    await pool.query(
      `INSERT INTO state_hierarchy (state_canon, state_parent, picker_visible, display_order)
       VALUES ('ZZDEP MANUAL LEAF', 'ZZDEP', true, 3)`,
    );
    await pool.query(
      `INSERT INTO person_state_coverage
         (person_id, state_canon, state_head_person_id, effective_from, source)
       VALUES ($1, 'ZZDEP MANUAL LEAF', $1, DATE '2026-08-15', 'manual')`,
      [personId],
    );
    const customerId = "ZZDEP#MANUAL";
    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source)
       VALUES ($1, 'ZZDEP Manual Customer', 'retailer', 'app_created')`,
      [customerId],
    );
    await pool.query(
      `INSERT INTO customer_assignment
         (customer_id, person_id, state_head_person_id, confidence, effective_from, set_by)
       VALUES ($1, $2, $2, 'confirmed', DATE '2026-08-15', 'operator')`,
      [customerId, personId],
    );

    const res = await request(app)
      .post(`/api/master/people/${personId}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send({
        left_date: "2026-03-31",
        departure_reason: "confirmed departure",
        acknowledgedSubTree: 0,
        acknowledgedCustomers: 1,
        changed_by: "departure-test",
        voidPostDepartureImports: true,
      });

    expect(res.status).toBe(409);
    expect(res.body.postDepartureAssignments).toEqual([customerId]);
    expect(res.body.postDepartureCoverage).toEqual([
      expect.objectContaining({ state_canon: "ZZDEP MANUAL LEAF", source: "manual" }),
    ]);
    const [person, assignment, coverage] = await Promise.all([
      pool.query(`SELECT is_active, left_date FROM person WHERE person_id = $1`, [personId]),
      pool.query(`SELECT voided_at FROM customer_assignment WHERE customer_id = $1`, [customerId]),
      pool.query(
        `SELECT voided_at FROM person_state_coverage
         WHERE person_id = $1 AND state_canon = 'ZZDEP MANUAL LEAF'`,
        [personId],
      ),
    ]);
    expect(person.rows[0]).toMatchObject({ is_active: true, left_date: null });
    expect(assignment.rows[0].voided_at).toBeNull();
    expect(coverage.rows[0].voided_at).toBeNull();
  });

  it("rejects a repeated departure instead of overwriting the recorded one", async () => {
    const res = await request(app)
      .post(`/api/master/people/${headId}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send({ ...departureBody, left_date: "2026-08-10", acknowledgedCustomers: 0 });
    expect(res.status).toBe(400);
    const p = await pool.query(`SELECT left_date::text FROM person WHERE person_id = $1`, [headId]);
    expect(p.rows[0].left_date).toBe("2026-08-30");
  });

  it("DB enforces one holding person per departed head (partial unique index)", async () => {
    await expect(
      pool.query(
        `INSERT INTO person (name, is_holding, holding_for_person_id, source)
         VALUES ('HOLDING — ZZDEP Head dup', true, $1, 'app_created')`,
        [headId],
      ),
    ).rejects.toThrow(/uq_person_holding_for|duplicate key/);
  });

  it("blocks reactivation of a departed person", async () => {
    const res = await request(app)
      .post(`/api/master/people/${headId}/reactivate`)
      .set("X-Admin-Secret", ADMIN)
      .send({ changed_by: "departure-test" });
    expect(res.status).toBe(400);
    const p = await pool.query(`SELECT is_active FROM person WHERE person_id = $1`, [headId]);
    expect(p.rows[0].is_active).toBe(false);
  });

  it("blocks reactivation of a holding person", async () => {
    const res = await request(app)
      .post(`/api/master/people/${holdingId}/reactivate`)
      .set("X-Admin-Secret", ADMIN)
      .send({ changed_by: "departure-test" });
    expect(res.status).toBe(400);
  });

  it("lists the holding on GET /master/holding, redacting reason/note for non-admin", async () => {
    // Unauthenticated: operational status only, HR details redacted.
    const anon = await request(app).get(`/api/master/holding`);
    expect(anon.status).toBe(200);
    const anonMine = anon.body.holdings.find((h: any) => h.holding_person_id === holdingId);
    expect(anonMine).toBeTruthy();
    expect(Number(anonMine.open_customers)).toBe(1);
    expect(anonMine.departed_person_id).toBe(headId);
    expect(anonMine.departure_reason).toBeNull();
    expect(anonMine.departure_note).toBeNull();

    // Admin: full details.
    const adm = await request(app).get(`/api/master/holding`).set("X-Admin-Secret", ADMIN);
    const admMine = adm.body.holdings.find((h: any) => h.holding_person_id === holdingId);
    expect(admMine.departure_reason).toBe("resigned");
    expect(admMine.departure_note).toBe("test");
  });

  it("redacts departure reason/note on person routes for non-admin callers", async () => {
    const anonDetail = await request(app).get(`/api/master/people/${headId}`);
    expect(anonDetail.status).toBe(200);
    expect(anonDetail.body.person.departure_reason).toBeNull();
    expect(anonDetail.body.person.departure_note).toBeNull();

    const admDetail = await request(app)
      .get(`/api/master/people/${headId}`)
      .set("X-Admin-Secret", ADMIN);
    expect(admDetail.body.person.departure_reason).toBe("resigned");

    const anonList = await request(app).get(`/api/master/people?q=ZZDEP&active=false`);
    for (const p of anonList.body.people) expect(p.departure_reason).toBeNull();

    // The change log must not leak departure reason/note to non-admin callers…
    expect(JSON.stringify(anonDetail.body.changeLog)).not.toContain("resigned");
    expect(
      anonDetail.body.changeLog.some((c: any) =>
        String(c.field ?? "").startsWith("departure"),
      ),
    ).toBe(false);
    // …while admin callers still see the audit entries.
    expect(
      admDetail.body.changeLog.some(
        (c: any) => c.field === "departure_reason" && c.new_value === "resigned",
      ),
    ).toBe(true);
  });

  it("excludes holding persons from active person lists and totals server-side", async () => {
    const res = await request(app).get(`/api/master/people?q=ZZDEP&active=true&limit=200`);
    expect(res.status).toBe(200);
    expect(res.body.people.some((p: any) => p.is_holding)).toBe(false);
    expect(res.body.people.some((p: any) => p.person_id === holdingId)).toBe(false);
    // total must not count the (active) holding person either
    expect(res.body.total).toBe(res.body.people.length);
  });

  it("resolve moves assignments to the replacement and clears the holding", async () => {
    const res = await request(app)
      .post(`/api/master/holding/${holdingId}/resolve`)
      .set("X-Admin-Secret", ADMIN)
      .send({ new_head_person_id: replacementId, changed_by: "departure-test" });
    expect(res.status).toBe(200);
    expect(res.body.assignmentsMoved).toBe(1);

    const open = await pool.query(
      `SELECT person_id, state_head_person_id FROM customer_assignment
       WHERE customer_id = $1 AND effective_to IS NULL`,
      [CUST],
    );
    expect(open.rows.length).toBe(1);
    expect(open.rows[0].person_id).toBe(replacementId);

    const h = await pool.query(`SELECT is_active FROM person WHERE person_id = $1`, [holdingId]);
    expect(h.rows[0].is_active).toBe(false);

    const list = await request(app).get(`/api/master/holding`);
    expect(list.body.holdings.find((x: any) => x.holding_person_id === holdingId)).toBeUndefined();
  });

  it("truly parallel resolve requests cannot duplicate open assignments", async () => {
    // Fresh fixture: second head with one customer, departed → holding.
    const h2 = await pool.query(
      `INSERT INTO person (name, is_state_head, source) VALUES ('ZZDEP Head2', true, 'app_created') RETURNING person_id`,
    );
    const head2 = h2.rows[0].person_id;
    const CUST2 = "ZZDEP#2";
    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source) VALUES ($1,'ZZDEP Customer2','distributor','app_created')
       ON CONFLICT (customer_id) DO NOTHING`,
      [CUST2],
    );
    await pool.query(
      `INSERT INTO customer_assignment (customer_id, person_id, state_head_person_id, confidence, set_by)
       VALUES ($1, $2, $2, 'confirmed', 'departure-test')`,
      [CUST2, head2],
    );
    const dep = await request(app)
      .post(`/api/master/people/${head2}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send({ ...departureBody, changed_by: "departure-test" });
    expect(dep.status).toBe(200);
    const hold2 = dep.body.holdingPersonId;

    // Fire two resolves in parallel to DIFFERENT replacements.
    const r2 = await pool.query(
      `INSERT INTO person (name, source) VALUES ('ZZDEP Replacement2', 'app_created') RETURNING person_id`,
    );
    const [resA, resB] = await Promise.all([
      request(app)
        .post(`/api/master/holding/${hold2}/resolve`)
        .set("X-Admin-Secret", ADMIN)
        .send({ new_head_person_id: replacementId, changed_by: "departure-test" }),
      request(app)
        .post(`/api/master/holding/${hold2}/resolve`)
        .set("X-Admin-Secret", ADMIN)
        .send({ new_head_person_id: r2.rows[0].person_id, changed_by: "departure-test" }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]); // exactly one wins

    // Invariant: exactly one open assignment, owned by the winning replacement.
    const open = await pool.query(
      `SELECT person_id FROM customer_assignment WHERE customer_id = $1 AND effective_to IS NULL`,
      [CUST2],
    );
    expect(open.rows.length).toBe(1);

    // Cleanup fixture rows specific to this test.
    await pool.query(`DELETE FROM customer_assignment WHERE customer_id = $1`, [CUST2]);
    await pool.query(`DELETE FROM customer WHERE customer_id = $1`, [CUST2]);
  });

  it("rejects assigning a customer to a departed or holding person", async () => {
    const res = await request(app)
      .patch(`/api/master/customers/${encodeURIComponent(CUST)}/assign`)
      .set("X-Admin-Secret", ADMIN)
      .send({ person_id: headId, state_head_person_id: headId, changed_by: "departure-test" });
    expect(res.status).toBe(400);

    const res2 = await request(app)
      .patch(`/api/master/customers/${encodeURIComponent(CUST)}/assign`)
      .set("X-Admin-Secret", ADMIN)
      .send({ person_id: holdingId, state_head_person_id: null, changed_by: "departure-test" });
    expect(res2.status).toBe(400);
  });

  it("rejects bulk-assign whose state-head target is departed or holding", async () => {
    // Unassigned customer so bulk-assign Form A picks it up.
    const CUST3 = "ZZDEP#3";
    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source) VALUES ($1,'ZZDEP Customer3','distributor','app_created')
       ON CONFLICT (customer_id) DO NOTHING`,
      [CUST3],
    );
    await pool.query(
      `INSERT INTO customer_assignment (customer_id, person_id, state_head_person_id, confidence, set_by)
       VALUES ($1, NULL, NULL, 'guessed', 'departure-test')
       ON CONFLICT DO NOTHING`,
      [CUST3],
    );

    // Valid TM target but departed state-head target → 400
    const depSh = await request(app)
      .post(`/api/master/customers/bulk-assign`)
      .set("X-Admin-Secret", ADMIN)
      .send({
        customer_ids: [CUST3],
        to_person_id: replacementId,
        to_state_head_person_id: headId, // departed
        changed_by: "departure-test",
      });
    expect(depSh.status).toBe(400);

    // Holding state-head target → 400
    const holdSh = await request(app)
      .post(`/api/master/customers/bulk-assign`)
      .set("X-Admin-Secret", ADMIN)
      .send({
        customer_ids: [CUST3],
        to_person_id: replacementId,
        to_state_head_person_id: holdingId, // holding placeholder
        changed_by: "departure-test",
      });
    expect(holdSh.status).toBe(400);

    // Departed/holding as the TM target → 404 (pre-check) — also blocked
    const depTm = await request(app)
      .post(`/api/master/customers/bulk-assign`)
      .set("X-Admin-Secret", ADMIN)
      .send({ customer_ids: [CUST3], to_person_id: headId, changed_by: "departure-test" });
    expect([400, 404]).toContain(depTm.status);

    // No open assignment was disturbed by the rejected calls.
    const open = await pool.query(
      `SELECT person_id, state_head_person_id FROM customer_assignment
       WHERE customer_id = $1 AND effective_to IS NULL`,
      [CUST3],
    );
    expect(open.rows.length).toBe(1);
    expect(open.rows[0].person_id).toBeNull();

    await pool.query(`DELETE FROM customer_assignment WHERE customer_id = $1`, [CUST3]);
    await pool.query(`DELETE FROM customer WHERE customer_id = $1`, [CUST3]);
  });

  it("concurrent departure vs assignment cannot leave an open assignment to the departed person", async () => {
    // Fixture: active head with one customer assigned to them.
    const h = await pool.query(
      `INSERT INTO person (name, is_state_head, source) VALUES ('ZZDEP Head4', true, 'app_created') RETURNING person_id`,
    );
    const head4 = h.rows[0].person_id;
    const CUST4 = "ZZDEP#4";
    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source) VALUES ($1,'ZZDEP Customer4','distributor','app_created')
       ON CONFLICT (customer_id) DO NOTHING`,
      [CUST4],
    );
    await pool.query(
      `INSERT INTO customer_assignment (customer_id, person_id, state_head_person_id, confidence, set_by)
       VALUES ($1, $2, $2, 'confirmed', 'departure-test')`,
      [CUST4, head4],
    );

    // Fire departure of head4 and an assignment TO head4 concurrently.
    const [depRes, assignRes] = await Promise.all([
      request(app)
        .post(`/api/master/people/${head4}/departure`)
        .set("X-Admin-Secret", ADMIN)
        .send({ ...departureBody, changed_by: "departure-test" }),
      request(app)
        .patch(`/api/master/customers/${encodeURIComponent(CUST4)}/assign`)
        .set("X-Admin-Secret", ADMIN)
        .send({ person_id: head4, state_head_person_id: head4, changed_by: "departure-test" }),
    ]);
    expect(depRes.status).toBe(200);
    // Assignment either lost the race (400: target departed) or committed
    // first (200) — in which case the departure must have moved it to holding.
    expect([200, 400]).toContain(assignRes.status);

    const open = await pool.query(
      `SELECT person_id, state_head_person_id FROM customer_assignment
       WHERE customer_id = $1 AND effective_to IS NULL`,
      [CUST4],
    );
    // Invariant: exactly one open row, and never owned by the departed head.
    expect(open.rows.length).toBe(1);
    expect(open.rows[0].person_id).not.toBe(head4);
    expect(open.rows[0].state_head_person_id).not.toBe(head4);

    await pool.query(`DELETE FROM customer_assignment WHERE customer_id = $1`, [CUST4]);
    await pool.query(`DELETE FROM customer WHERE customer_id = $1`, [CUST4]);
  });

  it("review-queue approval rejects a departed or holding proposed person", async () => {
    const q1 = await pool.query(
      `INSERT INTO customer_review_queue (name, type, proposed_person_id, submitted_by)
       VALUES ('ZZDEP Queue Cust', 'distributor', $1, 'departure-test') RETURNING id`,
      [headId], // departed
    );
    const r1 = await request(app)
      .post(`/api/master/customers/review-queue/${q1.rows[0].id}/approve`)
      .set("X-Admin-Secret", ADMIN)
      .send({ reviewed_by: "departure-test" });
    expect(r1.status).toBe(400);
    // Item stays pending; no customer/assignment created.
    const still = await pool.query(
      `SELECT review_status FROM customer_review_queue WHERE id = $1`,
      [q1.rows[0].id],
    );
    expect(still.rows[0].review_status).toBe("pending");

    const q2 = await pool.query(
      `INSERT INTO customer_review_queue (name, type, proposed_person_id, submitted_by)
       VALUES ('ZZDEP Queue Cust2', 'distributor', $1, 'departure-test') RETURNING id`,
      [holdingId], // holding placeholder
    );
    const r2 = await request(app)
      .post(`/api/master/customers/review-queue/${q2.rows[0].id}/approve`)
      .set("X-Admin-Secret", ADMIN)
      .send({ reviewed_by: "departure-test" });
    expect(r2.status).toBe(400);

    await pool.query(`DELETE FROM customer_review_queue WHERE submitted_by = 'departure-test'`);
  });

  it("bulk-assign-suggested never suggests a holding or departed person", async () => {
    // Territory whose only current cover is the HOLDING person; the single
    // unassigned customer's state head is the DEPARTED head. Both candidate
    // rules must be excluded, so the customer is skipped, not assigned.
    const t = await pool.query(
      `INSERT INTO territory (name) VALUES ('ZZDEP Territory') RETURNING territory_id`,
    );
    const terrId = t.rows[0].territory_id;
    const CUST5 = "ZZDEP#5";
    const CUST6 = "ZZDEP#6";
    // Clear any leftovers from prior failed runs (customer rows too — an
    // ON CONFLICT DO NOTHING insert would keep a stale territory_id).
    await pool.query(`DELETE FROM customer_assignment WHERE customer_id IN ($1,$2)`, [CUST5, CUST6]);
    await pool.query(`DELETE FROM customer WHERE customer_id IN ($1,$2)`, [CUST5, CUST6]);
    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source, territory_id)
       VALUES ($1,'ZZDEP Covered','distributor','app_created',$3),
              ($2,'ZZDEP Unassigned','distributor','app_created',$3)`,
      [CUST5, CUST6, terrId],
    );
    // Majority cover held by the holding person.
    await pool.query(
      `INSERT INTO customer_assignment (customer_id, person_id, state_head_person_id, confidence, set_by)
       VALUES ($1, $2, $2, 'confirmed', 'departure-test')`,
      [CUST5, holdingId],
    );
    // Unassigned customer whose recorded state head is the departed head.
    await pool.query(
      `INSERT INTO customer_assignment (customer_id, person_id, state_head_person_id, confidence, set_by)
       VALUES ($1, NULL, $2, 'guessed', 'departure-test')`,
      [CUST6, headId],
    );

    const res = await request(app)
      .post(`/api/master/customers/bulk-assign-suggested`)
      .set("X-Admin-Secret", ADMIN)
      .send({ territory_id: terrId, changed_by: "departure-test" });
    expect(res.status).toBe(200);
    expect(res.body.moved).toBe(0);
    expect(res.body.skipped).toBe(1);

    // Still unassigned — never moved to holding/departed.
    const open = await pool.query(
      `SELECT person_id FROM customer_assignment WHERE customer_id = $1 AND effective_to IS NULL`,
      [CUST6],
    );
    expect(open.rows.length).toBe(1);
    expect(open.rows[0].person_id).toBeNull();

    await pool.query(`DELETE FROM customer_assignment WHERE customer_id IN ($1,$2)`, [CUST5, CUST6]);
    await pool.query(`DELETE FROM customer WHERE customer_id IN ($1,$2)`, [CUST5, CUST6]);
    await pool.query(`DELETE FROM territory WHERE territory_id = $1`, [terrId]);
  });

  // ── Individual-reassignment lazy-clear path ───────────────────────────────
  // Verifies that when every customer is moved off a holding person one at a
  // time (PATCH /master/customers/:id/assign), the next GET /master/holding
  // call triggers the lazy-deactivation UPDATE and excludes that holding
  // person from the response. The bulk-resolve path is covered elsewhere;
  // this test covers the individual path described in the route comment.

  it("individual reassignments lazy-deactivate the holding person once all customers are moved", async () => {
    // Fixture: a fresh departed head with 2 customers.
    const hx = await pool.query(
      `INSERT INTO person (name, is_state_head, source)
       VALUES ('ZZDEP Head7', true, 'app_created') RETURNING person_id`,
    );
    const head7 = hx.rows[0].person_id;
    const CUST7 = "ZZDEP#7";
    const CUST8 = "ZZDEP#8";

    // Clear any stale rows from a previous failed run.
    await pool.query(`DELETE FROM customer_assignment WHERE customer_id IN ($1,$2)`, [CUST7, CUST8]);
    await pool.query(`DELETE FROM customer WHERE customer_id IN ($1,$2)`, [CUST7, CUST8]);

    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source)
       VALUES ($1,'ZZDEP Customer7','distributor','app_created'),
              ($2,'ZZDEP Customer8','distributor','app_created')`,
      [CUST7, CUST8],
    );
    await pool.query(
      `INSERT INTO customer_assignment (customer_id, person_id, state_head_person_id, confidence, set_by)
       VALUES ($1, $2, $2, 'confirmed', 'departure-test'),
              ($3, $2, $2, 'confirmed', 'departure-test')`,
      [CUST7, head7, CUST8],
    );

    // Depart head7 — creates a holding person holding 2 open assignments.
    const depRes = await request(app)
      .post(`/api/master/people/${head7}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send({ ...departureBody, acknowledgedCustomers: 2, changed_by: "departure-test" });
    expect(depRes.status).toBe(200);
    const holdingId7: number = depRes.body.holdingPersonId;
    expect(depRes.body.assignmentsMoved).toBe(2);

    // GET /holding before any moves: holding person appears with 2 open customers.
    const before = await request(app).get(`/api/master/holding`);
    expect(before.status).toBe(200);
    const entryBefore = before.body.holdings.find((h: any) => h.holding_person_id === holdingId7);
    expect(entryBefore).toBeTruthy();
    expect(Number(entryBefore.open_customers)).toBe(2);

    // Move CUST7 individually to the replacement.
    const mv1 = await request(app)
      .patch(`/api/master/customers/${encodeURIComponent(CUST7)}/assign`)
      .set("X-Admin-Secret", ADMIN)
      .send({ person_id: replacementId, state_head_person_id: replacementId, changed_by: "departure-test" });
    expect(mv1.status).toBe(200);

    // After first move: holding still has 1 customer and is still active.
    const between = await request(app).get(`/api/master/holding`);
    const entryBetween = between.body.holdings.find((h: any) => h.holding_person_id === holdingId7);
    expect(entryBetween).toBeTruthy();
    expect(Number(entryBetween.open_customers)).toBe(1);
    const dbBetween = await pool.query(
      `SELECT is_active FROM person WHERE person_id = $1`, [holdingId7],
    );
    expect(dbBetween.rows[0].is_active).toBe(true);

    // Move CUST8 — now zero open assignments remain on the holding person.
    const mv2 = await request(app)
      .patch(`/api/master/customers/${encodeURIComponent(CUST8)}/assign`)
      .set("X-Admin-Secret", ADMIN)
      .send({ person_id: replacementId, state_head_person_id: replacementId, changed_by: "departure-test" });
    expect(mv2.status).toBe(200);

    // GET /holding: lazy-clear fires → holding person is deactivated and absent.
    const after = await request(app).get(`/api/master/holding`);
    expect(after.status).toBe(200);
    expect(after.body.holdings.find((h: any) => h.holding_person_id === holdingId7)).toBeUndefined();

    // DB: is_active must be false after the lazy-clear UPDATE.
    const dbFinal = await pool.query(
      `SELECT is_active FROM person WHERE person_id = $1`, [holdingId7],
    );
    expect(dbFinal.rows[0].is_active).toBe(false);

    // Both customers are now open-assigned to the replacement.
    const assigns = await pool.query(
      `SELECT customer_id, person_id FROM customer_assignment
       WHERE customer_id IN ($1,$2) AND effective_to IS NULL
       ORDER BY customer_id`,
      [CUST7, CUST8],
    );
    expect(assigns.rows.length).toBe(2);
    expect(assigns.rows.every((r: any) => r.person_id === replacementId)).toBe(true);

    // Cleanup.
    await pool.query(`DELETE FROM customer_assignment WHERE customer_id IN ($1,$2)`, [CUST7, CUST8]);
    await pool.query(`DELETE FROM customer WHERE customer_id IN ($1,$2)`, [CUST7, CUST8]);
  });

  // ── Rehire tests ──────────────────────────────────────────────────────────
  // These run last so headId is still departed (holding resolved, no open
  // assignments) when we test the success path.

  it("reactivate route mentions /rehire in its error message for departed persons", async () => {
    const res = await request(app)
      .post(`/api/master/people/${headId}/reactivate`)
      .set("X-Admin-Secret", ADMIN)
      .send({ changed_by: "departure-test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rehire/i);
  });

  it("rehire rejects a non-departed person", async () => {
    const res = await request(app)
      .post(`/api/master/people/${replacementId}/rehire`)
      .set("X-Admin-Secret", ADMIN)
      .send({ changed_by: "departure-test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no recorded departure/i);
  });

  it("rehire rejects when the holding person still has open assignments", async () => {
    // Create a fresh head with a customer so the holding person has open work.
    const hx = await pool.query(
      `INSERT INTO person (name, is_state_head, source) VALUES ('ZZDEP HeadX', true, 'app_created') RETURNING person_id`,
    );
    const headX = hx.rows[0].person_id;
    const CUSTX = "ZZDEP#X";
    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source) VALUES ($1,'ZZDEP CustX','distributor','app_created')
       ON CONFLICT (customer_id) DO NOTHING`,
      [CUSTX],
    );
    await pool.query(
      `INSERT INTO customer_assignment (customer_id, person_id, state_head_person_id, confidence, set_by)
       VALUES ($1, $2, $2, 'confirmed', 'departure-test')`,
      [CUSTX, headX],
    );
    // Depart headX (holding person will have the open assignment).
    const dep = await request(app)
      .post(`/api/master/people/${headX}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send({ ...departureBody, acknowledgedCustomers: 1, changed_by: "departure-test" });
    expect(dep.status).toBe(200);
    const holdX = dep.body.holdingPersonId;

    // Rehire must be blocked because the holding person still holds CUSTX.
    const rehireRes = await request(app)
      .post(`/api/master/people/${headX}/rehire`)
      .set("X-Admin-Secret", ADMIN)
      .send({ changed_by: "departure-test" });
    expect(rehireRes.status).toBe(400);
    expect(rehireRes.body.openAssignments).toBe(1);

    // headX is still departed.
    const p = await pool.query(
      `SELECT is_active, left_date FROM person WHERE person_id = $1`,
      [headX],
    );
    expect(p.rows[0].is_active).toBe(false);
    expect(p.rows[0].left_date).not.toBeNull();

    // Cleanup.
    await pool.query(`DELETE FROM customer_assignment WHERE customer_id = $1`, [CUSTX]);
    await pool.query(`DELETE FROM customer WHERE customer_id = $1`, [CUSTX]);
    await pool.query(`DELETE FROM person WHERE person_id = $1`, [holdX]);
    await pool.query(`DELETE FROM person WHERE person_id = $1`, [headX]);
  });

  it("rehire clears departure fields, reactivates, and deactivates the holding person", async () => {
    // headId was departed earlier; its holding person was resolved (no open
    // assignments remain), so rehire should succeed.
    const res = await request(app)
      .post(`/api/master/people/${headId}/rehire`)
      .set("X-Admin-Secret", ADMIN)
      .send({ changed_by: "departure-test" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const p = await pool.query(
      `SELECT is_active, left_date, departure_reason, departure_note FROM person WHERE person_id = $1`,
      [headId],
    );
    expect(p.rows[0].is_active).toBe(true);
    expect(p.rows[0].left_date).toBeNull();
    expect(p.rows[0].departure_reason).toBeNull();
    expect(p.rows[0].departure_note).toBeNull();

    // Holding person must have been deactivated.
    if (res.body.holdingDeactivated) {
      const h = await pool.query(
        `SELECT is_active FROM person WHERE person_id = $1`,
        [res.body.holdingDeactivated],
      );
      expect(h.rows[0]?.is_active).toBe(false);
    }

    // A change_log entry must record the rehire.
    const log = await pool.query(
      `SELECT field, old_value, new_value FROM change_log
       WHERE entity_type = 'person' AND entity_id = $1 AND field = 'rehire'
       ORDER BY changed_at DESC LIMIT 1`,
      [String(headId)],
    );
    expect(log.rows.length).toBe(1);
    expect(log.rows[0].old_value).toBe("departed");
    expect(log.rows[0].new_value).toBe("active");
  });

  it("rehired person is assignable again (lockAssignTargets passes)", async () => {
    // After rehire, the person must pass lockAssignTargets — visible via
    // customer assign accepting them as the TM target.
    const CUSTY = "ZZDEP#Y";
    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source) VALUES ($1,'ZZDEP CustY','distributor','app_created')
       ON CONFLICT (customer_id) DO NOTHING`,
      [CUSTY],
    );
    // Use replacementId as state head (active), headId as TM (re-hired).
    const res = await request(app)
      .patch(`/api/master/customers/${encodeURIComponent(CUSTY)}/assign`)
      .set("X-Admin-Secret", ADMIN)
      .send({ person_id: headId, state_head_person_id: replacementId, changed_by: "departure-test" });
    expect(res.status).toBe(200);

    await pool.query(`DELETE FROM customer_assignment WHERE customer_id = $1`, [CUSTY]);
    await pool.query(`DELETE FROM customer WHERE customer_id = $1`, [CUSTY]);
  });

  it("departure after rehire reactivates the old holding row and moves assignments onto it", async () => {
    // headId is active (re-hired above). Assign a fresh customer and depart
    // again — the existing (deactivated) holding person must be reactivated
    // atomically and must own the newly moved assignment.
    const CUSTZ = "ZZDEP#Z";
    // Clear any stale rows from a previous failed run before inserting.
    await pool.query(`DELETE FROM customer_assignment WHERE customer_id = $1`, [CUSTZ]);
    await pool.query(`DELETE FROM customer WHERE customer_id = $1`, [CUSTZ]);
    await pool.query(
      `INSERT INTO customer (customer_id, name, type, source) VALUES ($1,'ZZDEP CustZ','distributor','app_created')
       ON CONFLICT (customer_id) DO NOTHING`,
      [CUSTZ],
    );
    await pool.query(
      `INSERT INTO customer_assignment (customer_id, person_id, state_head_person_id, confidence, set_by)
       VALUES ($1, $2, $2, 'confirmed', 'departure-test')`,
      [CUSTZ, headId],
    );

    const dep2 = await request(app)
      .post(`/api/master/people/${headId}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send({ ...departureBody, acknowledgedCustomers: 1, changed_by: "departure-test" });
    expect(dep2.status).toBe(200);
    const hold2 = dep2.body.holdingPersonId;

    // The reused holding person must be active.
    const hRow = await pool.query(`SELECT is_active FROM person WHERE person_id = $1`, [hold2]);
    expect(hRow.rows[0].is_active).toBe(true);

    // The open assignment must be owned by the (now-active) holding person.
    const open = await pool.query(
      `SELECT person_id, state_head_person_id FROM customer_assignment
       WHERE customer_id = $1 AND effective_to IS NULL`,
      [CUSTZ],
    );
    expect(open.rows.length).toBe(1);
    expect(open.rows[0].person_id).toBe(hold2);
    expect(open.rows[0].state_head_person_id).toBe(hold2);

    // Cleanup.
    await pool.query(`DELETE FROM customer_assignment WHERE customer_id = $1`, [CUSTZ]);
    await pool.query(`DELETE FROM customer WHERE customer_id = $1`, [CUSTZ]);
  });
});
