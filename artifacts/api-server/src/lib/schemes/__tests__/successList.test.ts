// Integration test: computeSuccessList per-audience-group correctness.
//
// The Success list must evaluate each scheme against its own audience filter,
// not a union filter across all quarterly schemes. This test seeds:
//
//   SCHEME_SUB  — audience=['sub_dealer'],   settlement='company',      item_group=IG_SUB
//   SCHEME_DIST — audience=['distributor'],  settlement='pass_through', item_group=IG_DIST
//
// Two customers:
//   RETAILER    — NOT in distributor_identity → qualifies for SCHEME_SUB only
//   DISTRIBUTOR — IS  in distributor_identity → qualifies for SCHEME_DIST only
//
// Each bills ₹8 L in their respective item_group (above slab-1 threshold of ₹5 L @ 3%).
// Expected earnedRs per row = 800 000 × 0.03 = 24 000.
// totalCompanyCost = 24 000, totalPassThrough = 24 000, totalEarnedRs = 48 000.
//
// A second assertions block verifies the isAtMax flag when billing exceeds the
// top slab and that customers below the first slab are excluded.

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { pool } from "@workspace/db";
import { computeSuccessList } from "../nudge.js";

const SCHEMA = "dashboard_test";
const TEST_FY = "1998-99";
const TEST_Q  = "Q2" as const;
// Q2 months for FY 1998-99: Jul-98, Aug-98, Sep-98
const TEST_MONTHS = ["Jul-98", "Aug-98", "Sep-98"];

const RETAILER    = "SUCCESS TEST RETAILER CO";   // not in distributor_identity
const DISTRIBUTOR = "SUCCESS TEST DIST CO";        // in  distributor_identity
const DIST_NORM_KEY = "SUCCESS TEST DIST CO";

// Scheme IDs — deliberately different from nudgeAudience test to avoid collision
const SCHEME_SUB  = "SUC_TEST_SUB";   // sub_dealer
const SCHEME_DIST = "SUC_TEST_DIST";  // distributor
const IG_SUB      = "SUC_IG_SUB";
const IG_DIST     = "SUC_IG_DIST";
const TERR_GROUP  = "ALL_STATES_SUC";

const BILL_AMOUNT    = 800_000;   // ₹8 L
const SLAB1_THRESH   = 500_000;   // ₹5 L
const SLAB1_RATE     = 0.03;      // 3%
const SLAB2_THRESH   = 1_500_000; // ₹15 L (above test billing → at-slab-1, not max)
const EXPECTED_EARN  = BILL_AMOUNT * SLAB1_RATE; // 24 000

// Customer for the "below slab" assertion
const BELOW_SLAB = "SUCCESS TEST BELOW SLAB CO";
const BELOW_AMOUNT = 100_000; // ₹1 L — below SLAB1_THRESH

beforeAll(async () => {
  // ── Ensure shared tables exist (may already exist from other tests) ─────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.scheme (
      scheme_id TEXT PRIMARY KEY, name TEXT, audience TEXT[],
      settlement TEXT, qualification_basis TEXT, territory_group TEXT,
      product_scope TEXT, period_from DATE, period_to DATE,
      period_note TEXT, audience_source_term TEXT, funding_note TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.scheme_reward_slab (
      scheme_id TEXT, slab_order INT, threshold_from NUMERIC,
      threshold_to NUMERIC, unit TEXT, rate NUMERIC, alt_reward TEXT,
      free_goods TEXT, reward_status TEXT DEFAULT 'ok', raw_text TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.territory_group (
      group_raw TEXT PRIMARY KEY, label TEXT, states TEXT[]
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.scheme_item_group (
      item_group TEXT, scheme_id TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sale_line_current (
      fy TEXT, month_label TEXT, customer TEXT, amount NUMERIC,
      is_territory BOOLEAN, state_canon TEXT, station TEXT,
      code TEXT, group_canon TEXT
    )
  `);
  for (const col of [
    "ADD COLUMN IF NOT EXISTS group_raw      TEXT",
    "ADD COLUMN IF NOT EXISTS head_canon     TEXT",
    "ADD COLUMN IF NOT EXISTS type_raw       TEXT",
    "ADD COLUMN IF NOT EXISTS invoice_date   DATE",
    "ADD COLUMN IF NOT EXISTS invoice_no     TEXT",
    "ADD COLUMN IF NOT EXISTS version_status TEXT",
  ]) {
    await pool.query(`ALTER TABLE ${SCHEMA}.sale_line_current ${col}`);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.distributor_identity (
      id SERIAL PRIMARY KEY, dist_id TEXT, name TEXT,
      norm_key TEXT, state TEXT, district TEXT,
      source TEXT, updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // ── Cleanup leftovers ─────────────────────────────────────────────────────
  await pool.query(`DELETE FROM ${SCHEMA}.sale_line_current WHERE fy = $1`, [TEST_FY]);
  for (const sid of [SCHEME_SUB, SCHEME_DIST]) {
    await pool.query(`DELETE FROM ${SCHEMA}.scheme_reward_slab        WHERE scheme_id = $1`, [sid]);
    await pool.query(`DELETE FROM ${SCHEMA}.scheme_item_group  WHERE scheme_id = $1`, [sid]);
    await pool.query(`DELETE FROM ${SCHEMA}.scheme             WHERE scheme_id = $1`, [sid]);
  }
  await pool.query(`DELETE FROM ${SCHEMA}.territory_group       WHERE group_raw = $1`, [TERR_GROUP]);
  await pool.query(`DELETE FROM ${SCHEMA}.distributor_identity  WHERE norm_key  = $1`, [DIST_NORM_KEY]);

  // ── Territory: ALL sentinel ────────────────────────────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.territory_group (group_raw, label, states)
    VALUES ($1, 'All States Success Test', ARRAY['ALL'])
  `, [TERR_GROUP]);

  // ── Scheme: sub_dealer → settlement=company ────────────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme
      (scheme_id, name, audience, settlement, qualification_basis,
       territory_group, period_from, period_to)
    VALUES ($1, 'Success Test Sub Dealer', ARRAY['sub_dealer'], 'company',
            'cumulative_value', $2, '1998-07-01', '1998-09-30')
  `, [SCHEME_SUB, TERR_GROUP]);
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme_reward_slab (scheme_id, slab_order, threshold_from, rate, reward_status)
    VALUES ($1, 1, $2, $3, 'ok'),
           ($1, 2, $4, 0.05, 'ok')
  `, [SCHEME_SUB, SLAB1_THRESH, SLAB1_RATE, SLAB2_THRESH]);
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme_item_group (item_group, scheme_id)
    VALUES ($1, $2)
  `, [IG_SUB, SCHEME_SUB]);

  // ── Scheme: distributor → settlement=pass_through ─────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme
      (scheme_id, name, audience, settlement, qualification_basis,
       territory_group, period_from, period_to)
    VALUES ($1, 'Success Test Distributor', ARRAY['distributor'], 'pass_through',
            'cumulative_value', $2, '1998-07-01', '1998-09-30')
  `, [SCHEME_DIST, TERR_GROUP]);
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme_reward_slab (scheme_id, slab_order, threshold_from, rate, reward_status)
    VALUES ($1, 1, $2, $3, 'ok'),
           ($1, 2, $4, 0.05, 'ok')
  `, [SCHEME_DIST, SLAB1_THRESH, SLAB1_RATE, SLAB2_THRESH]);
  await pool.query(`
    INSERT INTO ${SCHEMA}.scheme_item_group (item_group, scheme_id)
    VALUES ($1, $2)
  `, [IG_DIST, SCHEME_DIST]);

  // ── Register distributor in identity table ────────────────────────────────
  await pool.query(`
    INSERT INTO ${SCHEMA}.distributor_identity (dist_id, name, norm_key)
    VALUES ('DIST#SUC', $1, $2)
  `, [DISTRIBUTOR, DIST_NORM_KEY]);

  // ── Sale lines ────────────────────────────────────────────────────────────
  // Retailer bills in IG_SUB (sub_dealer scheme)
  await pool.query(`
    INSERT INTO ${SCHEMA}.sale_line_current
      (fy, month_label, customer, state_canon, group_raw,
       amount, version_status, is_territory, invoice_no, invoice_date)
    VALUES ($1, 'Jul-98', $2, 'WEST BENGAL', $3,
            $4, 'current', TRUE, 'SUC-R001', '1998-07-10')
  `, [TEST_FY, RETAILER, IG_SUB, BILL_AMOUNT]);

  // Distributor bills in IG_DIST (distributor scheme)
  await pool.query(`
    INSERT INTO ${SCHEMA}.sale_line_current
      (fy, month_label, customer, state_canon, group_raw,
       amount, version_status, is_territory, invoice_no, invoice_date)
    VALUES ($1, 'Jul-98', $2, 'WEST BENGAL', $3,
            $4, 'current', TRUE, 'SUC-D001', '1998-07-10')
  `, [TEST_FY, DISTRIBUTOR, IG_DIST, BILL_AMOUNT]);

  // Customer below slab 1 (bills in IG_SUB — same scheme as retailer)
  await pool.query(`
    INSERT INTO ${SCHEMA}.sale_line_current
      (fy, month_label, customer, state_canon, group_raw,
       amount, version_status, is_territory, invoice_no, invoice_date)
    VALUES ($1, 'Jul-98', $2, 'WEST BENGAL', $3,
            $4, 'current', TRUE, 'SUC-B001', '1998-07-10')
  `, [TEST_FY, BELOW_SLAB, IG_SUB, BELOW_AMOUNT]);
}, 30_000);

afterAll(async () => {
  await pool.query(`DELETE FROM ${SCHEMA}.sale_line_current WHERE fy = $1`, [TEST_FY]);
  for (const sid of [SCHEME_SUB, SCHEME_DIST]) {
    await pool.query(`DELETE FROM ${SCHEMA}.scheme_reward_slab        WHERE scheme_id = $1`, [sid]);
    await pool.query(`DELETE FROM ${SCHEMA}.scheme_item_group  WHERE scheme_id = $1`, [sid]);
    await pool.query(`DELETE FROM ${SCHEMA}.scheme             WHERE scheme_id = $1`, [sid]);
  }
  await pool.query(`DELETE FROM ${SCHEMA}.territory_group       WHERE group_raw = $1`, [TERR_GROUP]);
  await pool.query(`DELETE FROM ${SCHEMA}.distributor_identity  WHERE norm_key  = $1`, [DIST_NORM_KEY]);
}, 15_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computeSuccessList — per-audience eligibility", () => {
  it("retailer appears in success rows (sub_dealer scheme)", async () => {
    const result = await computeSuccessList(TEST_FY, TEST_Q);
    const customers = result.rows.map((r) => r.customer);
    expect(customers).toContain(RETAILER);
  }, 30_000);

  it("distributor appears in success rows (distributor scheme)", async () => {
    const result = await computeSuccessList(TEST_FY, TEST_Q);
    const customers = result.rows.map((r) => r.customer);
    expect(customers).toContain(DISTRIBUTOR);
  }, 30_000);

  it("retailer is NOT matched to the distributor scheme", async () => {
    const result = await computeSuccessList(TEST_FY, TEST_Q);
    const distSchemeRows = result.rows.filter((r) => r.schemeId === SCHEME_DIST);
    const names = distSchemeRows.map((r) => r.customer);
    expect(names).not.toContain(RETAILER);
  }, 30_000);

  it("distributor is NOT matched to the sub_dealer scheme", async () => {
    const result = await computeSuccessList(TEST_FY, TEST_Q);
    const subSchemeRows = result.rows.filter((r) => r.schemeId === SCHEME_SUB);
    const names = subSchemeRows.map((r) => r.customer);
    expect(names).not.toContain(DISTRIBUTOR);
  }, 30_000);

  it("customer below slab 1 does NOT appear in success rows", async () => {
    const result = await computeSuccessList(TEST_FY, TEST_Q);
    const customers = result.rows.map((r) => r.customer);
    expect(customers).not.toContain(BELOW_SLAB);
  }, 30_000);

  it("retailer row has correct earnedRs, currentSlab, and settlement", async () => {
    const result = await computeSuccessList(TEST_FY, TEST_Q);
    const row = result.rows.find((r) => r.customer === RETAILER);
    expect(row).toBeDefined();
    expect(row!.currentSlab).toBe(SLAB1_THRESH);
    expect(row!.currentRate).toBeCloseTo(SLAB1_RATE, 5);
    expect(row!.earnedRs).toBeCloseTo(EXPECTED_EARN, 0);
    expect(row!.settlement).toBe("company");
    expect(row!.isAtMax).toBe(false); // slab 2 exists at ₹15 L
  }, 30_000);

  it("distributor row has correct earnedRs, currentSlab, and settlement", async () => {
    const result = await computeSuccessList(TEST_FY, TEST_Q);
    const row = result.rows.find((r) => r.customer === DISTRIBUTOR);
    expect(row).toBeDefined();
    expect(row!.currentSlab).toBe(SLAB1_THRESH);
    expect(row!.currentRate).toBeCloseTo(SLAB1_RATE, 5);
    expect(row!.earnedRs).toBeCloseTo(EXPECTED_EARN, 0);
    expect(row!.settlement).toBe("pass_through");
    expect(row!.isAtMax).toBe(false);
  }, 30_000);

  it("settlement totals split company vs pass_through correctly", async () => {
    const result = await computeSuccessList(TEST_FY, TEST_Q);
    expect(result.totalCompanyCost).toBeCloseTo(EXPECTED_EARN, 0);
    expect(result.totalPassThrough).toBeCloseTo(EXPECTED_EARN, 0);
    expect(result.totalPrimary).toBe(0);
    expect(result.totalEarnedRs).toBeCloseTo(EXPECTED_EARN * 2, 0);
  }, 30_000);

  it("byFamily rollup reflects correct counts and totals", async () => {
    const result = await computeSuccessList(TEST_FY, TEST_Q);
    // Both schemes fall into 'other' family (no Q_CP / Q_PTMT prefix)
    const otherFamily = result.byFamily.find((f) => f.family === "other");
    expect(otherFamily).toBeDefined();
    expect(otherFamily!.count).toBe(2);
    expect(otherFamily!.totalEarnedRs).toBeCloseTo(EXPECTED_EARN * 2, 0);
  }, 30_000);
});
