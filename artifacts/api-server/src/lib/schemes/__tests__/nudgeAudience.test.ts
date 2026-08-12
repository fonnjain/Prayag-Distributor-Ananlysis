// Integration test: computeNudgeList audience filter.
//
// Verifies that a known distributor (present in distributor_identity) does NOT
// appear in the nudge list when all quarterly schemes have audience=['sub_dealer'],
// while an otherwise-identical sub-dealer (retailer, not in distributor_identity)
// DOES appear and receives a nudge.
//
// DB setup:
//  - Temp tables for scheme, scheme_reward_slab, territory_group, scheme_item_group
//    in the dashboard_test schema
//  - Temp sale_line_current table (one distributor row, one retailer row, same
//    amount and item_group so both would qualify if audience were ignored)
//  - distributor_identity row for the distributor customer's norm_key
//
// The test does NOT create a `scheme_def` or `scheme_reward_slab` with old-style
// integer PKs — only the new text-PK scheme tables.
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import { computeNudgeList } from "../nudge.js";

const SCHEMA = "dashboard_test";
const TEST_FY = "1999-00";
const TEST_Q = "Q1" as const;
// Q1 months for FY 1999-00: Apr-99, May-99, Jun-99
const TEST_MONTHS = ["Apr-99", "May-99", "Jun-99"];

// Fixture customers — names use only letters/spaces so norm_key = UPPER(TRIM(name))
// (no special chars to strip, so the normalisation is identity for these names).
const RETAILER    = "TEST NUDGE RETAILER CO";    // NOT in distributor_identity → sub_dealer
const DISTRIBUTOR = "TEST NUDGE DIST CO";        // IS in distributor_identity → must be excluded

// Distributor norm_key: UPPER(REGEXP_REPLACE(TRIM(name), '[^A-Z0-9 ]', '', 'g'))
// Since the name is already uppercase letters+spaces only, norm_key = name.
const DIST_NORM_KEY = "TEST NUDGE DIST CO";

// Each test customer has ₹8 L billing in CP (July scheme threshold for slab 1 is lower)
const BILL_AMOUNT = 800000;
const SCHEME_ID = "CP_NUDGE_TEST";
const TERR_GROUP = "ALL_STATES_TEST";

beforeAll(async () => {
  // ── scheme tables ─────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.scheme (
      scheme_id           TEXT PRIMARY KEY,
      name                TEXT,
      audience            TEXT[],
      settlement          TEXT,
      qualification_basis TEXT,
      territory_group     TEXT,
      product_scope       TEXT,
      period_from         DATE,
      period_to           DATE,
      period_note         TEXT,
      audience_source_term TEXT,
      funding_note        TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.scheme_reward_slab (
      scheme_id      TEXT,
      slab_order     INT,
      threshold_from NUMERIC,
      threshold_to   NUMERIC,
      unit           TEXT,
      rate           NUMERIC,
      alt_reward     TEXT,
      free_goods     TEXT,
      reward_status  TEXT DEFAULT 'ok',
      raw_text       TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.territory_group (
      group_raw TEXT PRIMARY KEY,
      label     TEXT,
      states    TEXT[]
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.scheme_item_group (
      item_group TEXT,
      scheme_id  TEXT
    )
  `);

  // ── sale_line_current table ───────────────────────────────────────────────
  // The table may already exist from another test file (distributorTabs.test.ts).
  // Create it if missing, then ensure the columns we need exist.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sale_line_current (
      fy          TEXT,
      month_label TEXT,
      customer    TEXT,
      amount      NUMERIC,
      is_territory BOOLEAN,
      state_canon TEXT,
      station     TEXT,
      code        TEXT,
      group_canon TEXT
    )
  `);
  // Add missing columns (IF NOT EXISTS is supported in PG 9.6+)
  for (const col of [
    "ADD COLUMN IF NOT EXISTS group_raw TEXT",
    "ADD COLUMN IF NOT EXISTS head_canon TEXT",
    "ADD COLUMN IF NOT EXISTS type_raw TEXT",
    "ADD COLUMN IF NOT EXISTS invoice_date DATE",
    "ADD COLUMN IF NOT EXISTS invoice_no TEXT",
    "ADD COLUMN IF NOT EXISTS version_status TEXT",
    "ADD COLUMN IF NOT EXISTS channel TEXT",
  ]) {
    await pool.query(`ALTER TABLE ${SCHEMA}.sale_line_current ${col}`);
  }

  // ── distributor_identity (must already exist; add test row) ─────────────
  // distributor_identity exists in the real DB but may not in test schema.
  // Create it if missing so the audience filter subquery can run.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.distributor_identity (
      id          SERIAL PRIMARY KEY,
      dist_id     TEXT,
      name        TEXT,
      norm_key    TEXT,
      state       TEXT,
      district    TEXT,
      source      TEXT,
      updated_at  TIMESTAMPTZ DEFAULT now()
    )
  `);

  // ── Clean up leftovers ────────────────────────────────────────────────────
  await pool.query(`DELETE FROM ${SCHEMA}.sale_line_current WHERE fy = $1`, [TEST_FY]);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme_reward_slab WHERE scheme_id = $1`, [SCHEME_ID]);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme_item_group WHERE scheme_id = $1`, [SCHEME_ID]);
  await pool.query(`DELETE FROM ${SCHEMA}.territory_group WHERE group_raw = $1`, [TERR_GROUP]);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme WHERE scheme_id = $1`, [SCHEME_ID]);
  await pool.query(`DELETE FROM ${SCHEMA}.distributor_identity WHERE norm_key = $1`, [DIST_NORM_KEY]);

  // ── Seed scheme (sub_dealer only, covering all states, Q1 dates) ─────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme
      (scheme_id, name, audience, settlement, qualification_basis,
       territory_group, period_from, period_to)
    VALUES ($1, 'Test CP Scheme', ARRAY['sub_dealer'], 'distributor', 'cumulative_value',
            $2, '1999-04-01', '1999-06-30')
  `, [SCHEME_ID, TERR_GROUP]);
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme_reward_slab (scheme_id, slab_order, threshold_from, rate, reward_status)
    VALUES ($1, 1, 500000, 0.03, 'ok'),
           ($1, 2, 1000000, 0.05, 'ok')
  `, [SCHEME_ID]);

  // ── Territory: "All States" (sentinel ALL) ────────────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.territory_group (group_raw, label, states)
    VALUES ($1, 'All States Test', ARRAY['ALL'])
  `, [TERR_GROUP]);

  // ── Item group: CP → test scheme ─────────────────────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme_item_group (item_group, scheme_id)
    VALUES ('CP', $1)
  `, [SCHEME_ID]);

  // ── Seed: distributor in identity table ───────────────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.distributor_identity (dist_id, name, norm_key)
    VALUES ('DIST#TEST', $1, $2)
  `, [DISTRIBUTOR, DIST_NORM_KEY]);

  // ── Seed: sale_line_current rows for both customers ───────────────────────
  for (const [customer, invNo] of [
    [RETAILER,    "ND-R001"],
    [DISTRIBUTOR, "ND-D001"],
  ] as [string, string][]) {
    await pool.query(`
      INSERT INTO ${SCHEMA}.sale_line_current
        (fy, month_label, customer, state_canon, group_raw,
         amount, version_status, is_territory, invoice_no, invoice_date)
      VALUES ($1, 'Apr-99', $2, 'WEST BENGAL', 'CP',
              $3, 'current', TRUE, $4, '1999-04-15')
    `, [TEST_FY, customer, BILL_AMOUNT, invNo]);
  }
}, 30_000);

afterAll(async () => {
  // Clean up test rows (don't drop sale_line_current — it's shared with other tests)
  await pool.query(`DELETE FROM ${SCHEMA}.sale_line_current WHERE fy = $1`, [TEST_FY]);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme_reward_slab WHERE scheme_id = $1`, [SCHEME_ID]);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme_item_group WHERE scheme_id = $1`, [SCHEME_ID]);
  await pool.query(`DELETE FROM ${SCHEMA}.territory_group WHERE group_raw = $1`, [TERR_GROUP]);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme WHERE scheme_id = $1`, [SCHEME_ID]);
  await pool.query(`DELETE FROM ${SCHEMA}.distributor_identity WHERE norm_key = $1`, [DIST_NORM_KEY]);
}, 15_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computeNudgeList — sub_dealer audience filter", () => {
  it("retailer customer appears in the nudge list", async () => {
    const result = await computeNudgeList(TEST_FY, TEST_Q, new Set(), false);
    const customers = result.nudges.map((n) => n.customer);
    expect(customers).toContain(RETAILER);
  }, 30_000);

  it("distributor customer (in distributor_identity) does NOT appear in the nudge list", async () => {
    const result = await computeNudgeList(TEST_FY, TEST_Q, new Set(), false);
    const customers = result.nudges.map((n) => n.customer);
    expect(customers).not.toContain(DISTRIBUTOR);
  }, 30_000);

  it("both retailer billedSoFar is positive and at correct slab", async () => {
    const result = await computeNudgeList(TEST_FY, TEST_Q, new Set(), false);
    const nudge = result.nudges.find((n) => n.customer === RETAILER);
    expect(nudge).toBeDefined();
    // 800000 ≥ slab1 (500000), < slab2 (1000000)
    expect(nudge!.billedSoFar).toBeCloseTo(BILL_AMOUNT, 0);
    expect(nudge!.currentSlab).toBe(500000);
  }, 30_000);
});
