// Integration tests for computeAnnualTracker.
//
// Verifies:
//  1. Returns an array (not an error) for a test FY
//  2. schemeId on every row equals ANNUAL_WB
//  3. Territory filter: only in-territory customers (WB) appear
//  4. Item-group filter: out-of-scope product customers are excluded
//  5. Dual audience (direct_dealer + sub_dealer): no customer-type restriction
//  6. Returns empty array when completeMonths is []
//
// All required tables (scheme, scheme_reward_slab, territory_group, scheme_item_group,
// sale_line_all) are created in the dashboard_test schema (via the search_path
// set by setup-db.ts) so queries from computeAnnualTracker resolve there.
// Tables are dropped in afterAll to leave no residue.
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import { computeAnnualTracker } from "../nudge.js";

const SCHEMA       = "dashboard_test";
const TEST_FY      = "1999-00"; // fictional FY — no real data interference
const MONTHS_1999  = ["Apr-99"];
const SLAB_THRESHOLD = 500000; // ₹5 L — low so fixture data qualifies

// Fixture customer names
const C_IN_TERR   = "TEST_ANN_IN_TERR_CUSTOMER";   // WEST BENGAL, CP → should appear
const C_OUT_TERR  = "TEST_ANN_OUT_TERR_CUSTOMER";  // UP (A), CP → should NOT appear
const C_OUT_SCOPE = "TEST_ANN_OUT_SCOPE_CUSTOMER";  // WEST BENGAL, WATER TANK → should NOT appear

beforeAll(async () => {
  // ── sale_line_all ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sale_line_all (
      line_uid       TEXT PRIMARY KEY,
      fy             TEXT NOT NULL,
      month_label    TEXT NOT NULL,
      customer       TEXT,
      head_canon     TEXT,
      state_canon    TEXT,
      group_raw      TEXT,
      amount         NUMERIC,
      version_status TEXT DEFAULT 'current',
      is_territory   BOOLEAN DEFAULT TRUE,
      invoice_no     TEXT,
      invoice_date   DATE,
      type_raw       TEXT
    )
  `);

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

  // ── Clean up any leftover rows from a previous interrupted run ────────────
  await pool.query(`DELETE FROM ${SCHEMA}.sale_line_all WHERE fy = $1`, [TEST_FY]);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme_reward_slab WHERE scheme_id = 'ANNUAL_WB'`);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme_item_group WHERE scheme_id = 'ANNUAL_WB'`);
  await pool.query(`DELETE FROM ${SCHEMA}.territory_group WHERE group_raw = 'WB_TEST_GROUP'`);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme WHERE scheme_id = 'ANNUAL_WB'`);

  // ── Seed ANNUAL_WB scheme ─────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme
      (scheme_id, name, audience, settlement, qualification_basis,
       territory_group, period_from, period_to)
    VALUES (
      'ANNUAL_WB',
      'Annual Scheme WB Test',
      ARRAY['direct_dealer', 'sub_dealer'],
      'pass_through',
      'cumulative_value',
      'WB_TEST_GROUP',
      '1999-04-01',
      '2000-03-31'
    )
  `);
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme_reward_slab (scheme_id, slab_order, threshold_from, rate, reward_status)
    VALUES
      ('ANNUAL_WB', 1, $1, 0.04, 'ok'),
      ('ANNUAL_WB', 2, 1500000, 0.06, 'ok')
  `, [SLAB_THRESHOLD]);

  // ── Seed territory group: WB only (abbreviation "WB" → "WEST BENGAL") ────
  await pool.query(`
    INSERT INTO ${SCHEMA}.territory_group (group_raw, label, states)
    VALUES ('WB_TEST_GROUP', 'West Bengal Test', ARRAY['WB'])
  `);

  // ── Seed item group: only CP is in-scope ─────────────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme_item_group (item_group, scheme_id)
    VALUES ('CP', 'ANNUAL_WB')
  `);

  // ── Seed sale_line_all rows ───────────────────────────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.sale_line_all
      (line_uid, fy, month_label, customer, state_canon, group_raw,
       amount, version_status, is_territory, invoice_no, invoice_date)
    VALUES
      -- In-territory (WEST BENGAL), in-scope (CP) → should appear
      ('TEST_ANN_1', $1, 'Apr-99', $2, 'WEST BENGAL', 'CP',
       600000, 'current', TRUE, 'ANN-001', '1999-04-15'),
      -- Out-of-territory (UP (A)), in-scope (CP) → should NOT appear
      ('TEST_ANN_2', $1, 'Apr-99', $3, 'UP (A)', 'CP',
       600000, 'current', TRUE, 'ANN-002', '1999-04-15'),
      -- In-territory (WEST BENGAL), out-of-scope (WATER TANK) → should NOT appear
      ('TEST_ANN_3', $1, 'Apr-99', $4, 'WEST BENGAL', 'WATER TANK',
       600000, 'current', TRUE, 'ANN-003', '1999-04-15')
  `, [TEST_FY, C_IN_TERR, C_OUT_TERR, C_OUT_SCOPE]);
}, 30_000);

afterAll(async () => {
  await pool.query(`DELETE FROM ${SCHEMA}.sale_line_all WHERE fy = $1`, [TEST_FY]);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme_reward_slab WHERE scheme_id = 'ANNUAL_WB'`);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme_item_group WHERE scheme_id = 'ANNUAL_WB'`);
  await pool.query(`DELETE FROM ${SCHEMA}.territory_group WHERE group_raw = 'WB_TEST_GROUP'`);
  await pool.query(`DELETE FROM ${SCHEMA}.scheme WHERE scheme_id = 'ANNUAL_WB'`);
}, 15_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computeAnnualTracker", () => {
  it("returns empty array when completeMonths is []", async () => {
    const rows = await computeAnnualTracker(TEST_FY, []);
    expect(rows).toHaveLength(0);
  });

  it("returns an array (not an error) for the test FY", async () => {
    const rows = await computeAnnualTracker(TEST_FY, MONTHS_1999);
    expect(Array.isArray(rows)).toBe(true);
  }, 20_000);

  it("every row has schemeId = ANNUAL_WB", async () => {
    const rows = await computeAnnualTracker(TEST_FY, MONTHS_1999);
    for (const row of rows) {
      expect(row.schemeId).toBe("ANNUAL_WB");
    }
  }, 20_000);

  it("territory filter: in-territory (WB) customer appears, out-of-territory (UP) does not", async () => {
    const rows = await computeAnnualTracker(TEST_FY, MONTHS_1999);
    const customers = rows.map((r) => r.customer);
    // C_IN_TERR is in WEST BENGAL (WB abbreviation) → must appear
    expect(customers).toContain(C_IN_TERR);
    // C_OUT_TERR is in UP (A) (WUP abbreviation, not WB) → must NOT appear
    expect(customers).not.toContain(C_OUT_TERR);
  }, 20_000);

  it("item-group filter: out-of-scope product (WATER TANK) customer does not appear", async () => {
    const rows = await computeAnnualTracker(TEST_FY, MONTHS_1999);
    const customers = rows.map((r) => r.customer);
    // C_OUT_SCOPE has WATER TANK (not in scheme_item_group) → must NOT appear
    expect(customers).not.toContain(C_OUT_SCOPE);
  }, 20_000);

  it("dual audience: no customer-type restriction — in-territory+in-scope customer appears", async () => {
    // ANNUAL_WB audience = ['direct_dealer','sub_dealer'] →
    // buildAudienceFilterSQL returns "" (no filter, both types allowed).
    // The qualifying customer should not be filtered out.
    const rows = await computeAnnualTracker(TEST_FY, MONTHS_1999);
    const customers = rows.map((r) => r.customer);
    expect(customers).toContain(C_IN_TERR);
  }, 20_000);

  it("fyTotal equals the seeded amount and maps to the correct slab", async () => {
    const rows = await computeAnnualTracker(TEST_FY, MONTHS_1999);
    const row = rows.find((r) => r.customer === C_IN_TERR);
    expect(row).toBeDefined();
    // Seeded 600000 → fyTotal ≈ 600000
    expect(row!.fyTotal).toBeCloseTo(600_000, 0);
    // 600000 ≥ slab 1 threshold (500000) but < slab 2 threshold (1500000)
    // → currentSlabIdx = 0
    expect(row!.currentSlabIdx).toBe(0);
  }, 20_000);
});
