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

let headId: number;
let replacementId: number;
let holdingId: number;

const app = express();
app.use(express.json());
app.use("/api", masterOrgRouter);

async function cleanup() {
  await pool.query(`DELETE FROM customer_assignment WHERE customer_id = $1`, [CUST]);
  const ids = await pool.query(
    `SELECT person_id FROM person WHERE name LIKE 'ZZDEP %' OR name LIKE 'HOLDING — ZZDEP %'`,
  );
  const idList = ids.rows.map((r: any) => r.person_id);
  if (idList.length) {
    await pool.query(
      `DELETE FROM change_log WHERE entity_type = 'person' AND entity_id = ANY($1::text[])`,
      [idList.map(String)],
    );
    // Delete holding persons first (FK holding_for_person_id).
    await pool.query(`DELETE FROM person WHERE is_holding AND holding_for_person_id = ANY($1::int[])`, [idList]);
    await pool.query(`DELETE FROM person WHERE person_id = ANY($1::int[])`, [idList]);
  }
  await pool.query(`DELETE FROM customer WHERE customer_id = $1`, [CUST]);
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
      holding_for_person_id INTEGER REFERENCES person(person_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
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
    `INSERT INTO customer_assignment (customer_id, person_id, state_head_person_id, confidence, set_by)
     VALUES ($1, $2, $2, 'confirmed', 'departure-test')`,
    [CUST, headId],
  );
});

afterAll(async () => {
  await cleanup();
});

const departureBody = {
  left_date: "2026-08-01",
  departure_reason: "resigned",
  departure_note: "test",
  acknowledgedSubTree: 0,
  acknowledgedCustomers: 1,
  changed_by: "departure-test",
};

describe("departure lifecycle", () => {
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
    expect(res.status).toBe(200);
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

  it("rejects a repeated departure instead of overwriting the recorded one", async () => {
    const res = await request(app)
      .post(`/api/master/people/${headId}/departure`)
      .set("X-Admin-Secret", ADMIN)
      .send({ ...departureBody, left_date: "2026-08-10", acknowledgedCustomers: 0 });
    expect(res.status).toBe(400);
    const p = await pool.query(`SELECT left_date::text FROM person WHERE person_id = $1`, [headId]);
    expect(p.rows[0].left_date).toBe("2026-08-01");
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
});
