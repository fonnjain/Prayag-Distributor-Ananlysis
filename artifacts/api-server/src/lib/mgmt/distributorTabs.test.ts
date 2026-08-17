// Guard-regression tests for the distributor-tab period-filter contract.
//
// WHAT THESE TESTS PROTECT:
//   monthCond() in distributorTabs.ts appends "AND month_label IN (...)" to
//   every DB query when a months selection is passed. If that clause is silently
//   dropped, filtered requests widen back to the full FY and the regression is
//   invisible to API callers.
//
//   Tests are divided into three groups:
//
//   1. Pure-function tests (no DB) — sortMonths ordering, MONTH_LABEL_RE format
//      validation, toPriorYearMonths baseline shift.  These import directly from
//      the implementation so any change to the exported regex or function
//      behaviour is immediately caught here.
//
//   2. monthCond isolation DB tests — seed known rows into
//      dashboard_test.secondary_sku_line, execute the real monthCond SQL fragment
//      against those rows, assert the clause restricts output to selected months.
//      Deterministic; no Sheets dependency.
//
//   3. Full tab-builder integration tests — seed the same test rows and call
//      buildSecondaryTab / buildSkuEvolution directly (with the distributor
//      directory module mocked to return a single controlled entry).  These
//      exercise every ${monthCond(months)} call site inside the actual tab
//      builders, not just the helper in isolation.  A regression that removes
//      monthCond from only ONE of the four query sites inside buildSecondaryTab
//      would still be caught here.
//
//   HTTP-level assertions (400 on invalid months, live API filter checks) live
//   in scripts/distributor-tab-guard-check.mjs.

import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  sortMonths,
  MONTH_LABEL_RE,
  monthCond,
  buildSecondaryTab,
  buildSkuEvolution,
  buildPushTab,
} from "./distributorTabs.js";
import { toPriorYearMonths, loadDistDdSnapshotOnly } from "./distributorDeepDive.js";
import { loadDistributorDirectory } from "./distributorDirectory.js";

// ── Directory mock ────────────────────────────────────────────────────────────
// Hoisted by vitest before any imports so distributorTabs.ts receives the mock
// when it calls loadDistributorDirectory.
//
// normDistKey("MOCK TEST DISTRIBUTOR"):
//   .toUpperCase() → "MOCK TEST DISTRIBUTOR" (already upper)
//   no TRADERS/ENTERPRISES/INDUSTRIES/PVTLTD matches
//   .replace(/[^A-Z0-9 ]/g, "") → "MOCK TEST DISTRIBUTOR" (spaces kept)
//   .replace(/\s+/g, " ").trim() → "MOCK TEST DISTRIBUTOR"
// So distKey === raw (preserved exactly).
vi.mock("./distributorDirectory.js", () => ({
  loadDistributorDirectory: vi.fn().mockResolvedValue({
    fy: "1900-01",
    basis: "distributor-own-state",
    basisLabel: "mock",
    states: [],
    heads: [],
    distributors: [
      {
        name: "MOCK TEST DISTRIBUTOR",
        distKey: "MOCK TEST DISTRIBUTOR",
        states: [],
        heads: [],
        retailerCount: 0,
        activeCount: 0,
        orderBooking: 0,
        sale: 0,
      },
      {
        // Isolated fixture distributor for the RET# identity regression tests
        // (keeps their rows out of the month-filter total assertions above).
        name: "MOCK RETID DISTRIBUTOR",
        distKey: "MOCK RETID DISTRIBUTOR",
        states: [],
        heads: [],
        retailerCount: 0,
        activeCount: 0,
        orderBooking: 0,
        sale: 0,
      },
    ],
    builtAt: 0,
  }),
}));

// ── Deep-dive snapshot mock ───────────────────────────────────────────────────
// Preserves the real toPriorYearMonths and prevFyLabel implementations so the
// existing section 4 tests continue to work.  loadDistDdSnapshotOnly is stubbed
// to null by default; individual describe blocks override it as needed.
vi.mock("./distributorDeepDive.js", async (importActual) => {
  const actual = await importActual<typeof import("./distributorDeepDive.js")>();
  return {
    ...actual,
    loadDistDdSnapshotOnly: vi.fn().mockResolvedValue(null),
  };
});

// ── Test fixtures ─────────────────────────────────────────────────────────────
const SCHEMA = "dashboard_test";
const TEST_DIST = "MOCK TEST DISTRIBUTOR";  // raw name = distKey for this fixture
const RETID_DIST = "MOCK RETID DISTRIBUTOR"; // isolated RET# identity fixtures
const CUR_FY  = "1900-01";                  // current FY — no real data at this key
const BASE_FY = "1899-00";                  // prevFyLabel(CUR_FY) — baseline FY

// Seeded secondary_sku_line data for CUR_FY:
//   Apr-26: CODE1=1000 + CODE2=500 = 1500
//   May-26: CODE1=800              =  800
//   Jun-26: CODE1=1200             = 1200   ← outside Apr+May selection
//   FY total:                        3500
//
// Seeded secondary_sku_line data for BASE_FY:
//   Apr-25: CODE1=700
//   May-25: CODE1=300
//   Base total for toPriorYearMonths(["Apr-26","May-26"]) = ["Apr-25","May-25"]: 1000

beforeAll(async () => {
  // Minimal secondary_sku_line table in the test schema.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.secondary_sku_line (
      line_uid      text PRIMARY KEY,
      fy            text NOT NULL,
      month_label   text NOT NULL,
      distributor   text,
      retailer      text,
      item_code     text NOT NULL,
      segment_canon text,
      head_canon    text,
      qty           numeric,
      net_amount    numeric,
      gross_amount  numeric,
      discount_pct  numeric,
      source        text NOT NULL DEFAULT 'test'
    )
  `);
  // Older test schemas predate the RET# identity column.
  await pool.query(
    `ALTER TABLE ${SCHEMA}.secondary_sku_line ADD COLUMN IF NOT EXISTS retailer_id text`,
  );

  // Minimal sale_line_current table — empty; primary queries return no rows
  // (buildSecondaryTab proceeds with primaryMatched=false, which is valid).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sale_line_current (
      fy          text,
      month_label text,
      customer    text,
      amount      numeric,
      is_territory boolean,
      state_canon text,
      station     text,
      code        text,
      group_canon text
    )
  `);

  // Remove leftovers from any previous interrupted run.
  await pool.query(
    `DELETE FROM ${SCHEMA}.secondary_sku_line WHERE fy IN ($1, $2)`,
    [CUR_FY, BASE_FY],
  );

  // Seed current FY rows.
  await pool.query(
    `INSERT INTO ${SCHEMA}.secondary_sku_line
       (line_uid, fy, month_label, distributor, item_code, segment_canon,
        net_amount, gross_amount, source)
     VALUES
       ('g-c1', $1, 'Apr-26', $2, 'CODE1', 'SegA', 1000, 1100, 'test'),
       ('g-c2', $1, 'Apr-26', $2, 'CODE2', 'SegA',  500,  550, 'test'),
       ('g-c3', $1, 'May-26', $2, 'CODE1', 'SegA',  800,  880, 'test'),
       ('g-c4', $1, 'Jun-26', $2, 'CODE1', 'SegA', 1200, 1320, 'test')`,
    [CUR_FY, TEST_DIST],
  );

  // Seed baseline FY rows (toPriorYearMonths(["Apr-26","May-26"]) = ["Apr-25","May-25"]).
  await pool.query(
    `INSERT INTO ${SCHEMA}.secondary_sku_line
       (line_uid, fy, month_label, distributor, item_code, segment_canon,
        net_amount, gross_amount, source)
     VALUES
       ('g-b1', $1, 'Apr-25', $2, 'CODE1', 'SegA', 700, 770, 'test'),
       ('g-b2', $1, 'May-25', $2, 'CODE1', 'SegA', 300, 330, 'test')`,
    [BASE_FY, TEST_DIST],
  );

  // Seed retailer rows for the push-tab dormant-retailer test.
  //
  // BASE_FY retailer data:
  //   RETAILER-A: active in Apr-25 (inside toPriorYearMonths(["Apr-26","May-26"]))
  //   RETAILER-C: active in Jun-25 ONLY (OUTSIDE toPriorYearMonths(["Apr-26","May-26"]))
  //
  // Neither retailer has any CUR_FY activity in Apr-26/May-26, so the
  // dormancy condition (COALESCE(cur.v,0)=0) holds for both.
  //
  // The regression invariant:
  //   With months=["Apr-26","May-26"], priorMonths=["Apr-25","May-25"] →
  //   RETAILER-A appears (Apr-25 is in prior months) but RETAILER-C does not
  //   (Jun-25 is NOT in prior months).
  //   If the months argument is silently dropped from the prior-FY query,
  //   RETAILER-C would appear — and the "not.toContain" assertion below fails.
  await pool.query(
    `INSERT INTO ${SCHEMA}.secondary_sku_line
       (line_uid, fy, month_label, distributor, retailer, item_code, segment_canon,
        net_amount, gross_amount, source)
     VALUES
       ('g-p-b1', $1, 'Apr-25', $2, 'RETAILER-A', 'CODE1', 'SegA', 700, 770, 'test'),
       ('g-p-b2', $1, 'Jun-25', $2, 'RETAILER-C', 'CODE1', 'SegA', 500, 550, 'test')`,
    [BASE_FY, TEST_DIST],
  );

  // ── RET# identity regression fixtures ──────────────────────────────────────
  // Two DIFFERENT retailers sharing the identical display name "TWIN STORES":
  //   RET#111 — active in CUR_FY Apr-26 (net 400)
  //   RET#222 — active in CUR_FY Apr-26 (net 250)
  // If retailer aggregation keys on the name, they'd collapse into one 650
  // entry. RET#-keyed aggregation must keep them distinct.
  //
  // Dormancy pair: display name "GHOST MART" —
  //   RET#333 had BASE_FY Apr-25 sales and NOTHING in CUR_FY → dormant.
  //   RET#444 (same name!) is active in CUR_FY Apr-26.
  // A name-keyed prior⋈cur join would let RET#444's activity mask RET#333's
  // dormancy; the RET#-keyed join must still report GHOST MART as dormant.
  await pool.query(
    `INSERT INTO ${SCHEMA}.secondary_sku_line
       (line_uid, fy, month_label, distributor, retailer, retailer_id, item_code, segment_canon,
        net_amount, gross_amount, source)
     VALUES
       ('g-r-c1', $1, 'Apr-26', $3, 'TWIN STORES', 'RET#111', 'CODE1', 'SegA', 400, 440, 'test'),
       ('g-r-c2', $1, 'Apr-26', $3, 'TWIN STORES', 'RET#222', 'CODE1', 'SegA', 250, 275, 'test'),
       ('g-r-c3', $1, 'Apr-26', $3, 'GHOST MART',  'RET#444', 'CODE2', 'SegA', 100, 110, 'test'),
       ('g-r-b1', $2, 'Apr-25', $3, 'GHOST MART',  'RET#333', 'CODE1', 'SegA', 900, 990, 'test')`,
    [CUR_FY, BASE_FY, RETID_DIST],
  );

  // Asymmetric ID coverage across FYs (must NOT be reported dormant):
  //   LEGACY SHOP — prior FY row HAS RET#555, current FY row has NO id but is
  //                 active. A coalesce-key join would miss the match.
  //   NEWID SHOP  — prior FY row has NO id, current FY row HAS RET#666 and is
  //                 active. Same trap in the other direction.
  await pool.query(
    `INSERT INTO ${SCHEMA}.secondary_sku_line
       (line_uid, fy, month_label, distributor, retailer, retailer_id, item_code, segment_canon,
        net_amount, gross_amount, source)
     VALUES
       ('g-a-b1', $2, 'Apr-25', $3, 'LEGACY SHOP', 'RET#555', 'CODE1', 'SegA', 600, 660, 'test'),
       ('g-a-c1', $1, 'Apr-26', $3, 'LEGACY SHOP', NULL,      'CODE1', 'SegA', 150, 165, 'test'),
       ('g-a-b2', $2, 'Apr-25', $3, 'NEWID SHOP',  NULL,      'CODE1', 'SegA', 450, 495, 'test'),
       ('g-a-c2', $1, 'Apr-26', $3, 'NEWID SHOP',  'RET#666', 'CODE1', 'SegA', 120, 132, 'test')`,
    [CUR_FY, BASE_FY, RETID_DIST],
  );
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM ${SCHEMA}.secondary_sku_line WHERE fy IN ($1, $2)`,
    [CUR_FY, BASE_FY],
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PURE-FUNCTION TESTS (no DB)
// ═══════════════════════════════════════════════════════════════════════════════

describe("MONTH_LABEL_RE — month-label format (imported from distributorTabs.ts)", () => {
  it("accepts well-formed labels for each fiscal-year boundary month", () => {
    expect(MONTH_LABEL_RE.test("Apr-26")).toBe(true);
    expect(MONTH_LABEL_RE.test("Mar-27")).toBe(true);
    expect(MONTH_LABEL_RE.test("Jan-27")).toBe(true);
  });
  it("rejects all-lowercase month abbreviation", () => {
    expect(MONTH_LABEL_RE.test("apr-26")).toBe(false);
  });
  it("rejects all-uppercase month abbreviation", () => {
    expect(MONTH_LABEL_RE.test("APR-26")).toBe(false);
  });
  it("rejects a label with a four-digit year (would bypass the filter silently)", () => {
    expect(MONTH_LABEL_RE.test("Apr-2026")).toBe(false);
  });
  it("rejects a FY-style string that would silently widen the filter", () => {
    expect(MONTH_LABEL_RE.test("2026-27")).toBe(false);
  });
  it("rejects numeric month abbreviation", () => {
    expect(MONTH_LABEL_RE.test("04-26")).toBe(false);
  });
  it("rejects a label with no year suffix", () => {
    expect(MONTH_LABEL_RE.test("Apr")).toBe(false);
  });
  it("rejects an empty string", () => {
    expect(MONTH_LABEL_RE.test("")).toBe(false);
  });
  it("rejects a label with trailing whitespace", () => {
    expect(MONTH_LABEL_RE.test("Apr-26 ")).toBe(false);
  });
});

describe("sortMonths — fiscal-year order (Apr first, Mar last)", () => {
  it("sorts Apr before May", () => {
    expect(sortMonths(["May-26", "Apr-26"])).toEqual(["Apr-26", "May-26"]);
  });
  it("places Jan–Mar after Dec", () => {
    expect(sortMonths(["Jan-27", "Dec-26", "Apr-26"])).toEqual(["Apr-26", "Dec-26", "Jan-27"]);
  });
  it("deduplicates identical labels", () => {
    expect(sortMonths(["Apr-26", "Apr-26", "May-26"])).toEqual(["Apr-26", "May-26"]);
  });
  it("returns an empty array for empty input", () => {
    expect(sortMonths([])).toEqual([]);
  });
});

describe("toPriorYearMonths — SKU baseline shift", () => {
  it("shifts a single month back by one year", () => {
    expect(toPriorYearMonths(["Apr-26"])).toEqual(["Apr-25"]);
  });
  it("shifts Jan correctly (calendar crossover inside a FY)", () => {
    expect(toPriorYearMonths(["Jan-27"])).toEqual(["Jan-26"]);
  });
  it("shifts a Q1 selection to last year's Q1", () => {
    expect(toPriorYearMonths(["Apr-26", "May-26", "Jun-26"]))
      .toEqual(["Apr-25", "May-25", "Jun-25"]);
  });
  it("preserves the length of the selection (no silent widening)", () => {
    const cur = ["Apr-26", "May-26", "Jun-26", "Jul-26"];
    expect(toPriorYearMonths(cur).length).toBe(cur.length);
  });
  it("returns an empty array for empty input", () => {
    expect(toPriorYearMonths([])).toEqual([]);
  });
});

describe("SKU evolution baseline invariant", () => {
  it("a Q1 selection produces a Q1 baseline, not a Q2 baseline", () => {
    expect(toPriorYearMonths(["Apr-26", "May-26", "Jun-26"]))
      .not.toEqual(toPriorYearMonths(["Jul-26", "Aug-26", "Sep-26"]));
  });
  it("baseline month count matches current month count", () => {
    for (const sel of [["Apr-26"], ["Apr-26", "May-26"], ["Apr-26", "May-26", "Jun-26"]]) {
      expect(toPriorYearMonths(sel).length).toBe(sel.length);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. monthCond ISOLATION DB TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("monthCond — SQL filter correctness (seeded DB)", () => {
  it("restricts results to selected months — Jun-26 absent when Apr+May selected", async () => {
    const selected = ["Apr-26", "May-26"];
    const rows = await db.execute<{ month_label: string; net: string }>(sql`
      SELECT month_label, SUM(net_amount::numeric)::text AS net
      FROM secondary_sku_line
      WHERE fy = ${CUR_FY} AND distributor = ${TEST_DIST}
        ${monthCond(selected)}
      GROUP BY month_label ORDER BY month_label
    `);
    const months = rows.rows.map((r) => r.month_label);
    // Primary regression check: if monthCond is dropped, Jun-26 appears.
    expect(months).not.toContain("Jun-26");
    expect(months).toContain("Apr-26");
    expect(months).toContain("May-26");
  });

  it("filtered total equals sum of selected months only, not the full FY", async () => {
    const rows = await db.execute<{ net: string }>(sql`
      SELECT SUM(net_amount::numeric)::text AS net
      FROM secondary_sku_line
      WHERE fy = ${CUR_FY} AND distributor = ${TEST_DIST}
        ${monthCond(["Apr-26", "May-26"])}
    `);
    const filtered = parseFloat(rows.rows[0]?.net ?? "0");
    expect(filtered).toBe(2300);     // Apr(1500) + May(800)
    expect(filtered).not.toBe(3500); // never the FY total
  });

  it("monthCond(null) returns all months — no restriction applied", async () => {
    const rows = await db.execute<{ month_label: string }>(sql`
      SELECT DISTINCT month_label FROM secondary_sku_line
      WHERE fy = ${CUR_FY} AND distributor = ${TEST_DIST}
        ${monthCond(null)}
      ORDER BY month_label
    `);
    const months = rows.rows.map((r) => r.month_label);
    expect(months).toContain("Apr-26");
    expect(months).toContain("May-26");
    expect(months).toContain("Jun-26");
  });

  it("monthCond([]) returns all months — empty array treated as no filter", async () => {
    const rows = await db.execute<{ month_label: string }>(sql`
      SELECT DISTINCT month_label FROM secondary_sku_line
      WHERE fy = ${CUR_FY} AND distributor = ${TEST_DIST}
        ${monthCond([])}
    `);
    expect(rows.rows.map((r) => r.month_label)).toContain("Jun-26");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. FULL TAB-BUILDER INTEGRATION TESTS
//    These call buildSecondaryTab / buildSkuEvolution directly with the mocked
//    directory and the seeded DB data. They exercise ALL ${monthCond(months)}
//    call sites inside the tab builders — not just the helper in isolation.
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildSecondaryTab — period filter through the full query chain", () => {
  it("filtered netAmount contains only selected months' data — never the FY total", async () => {
    const result = await buildSecondaryTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    // If monthCond is dropped from ANY query inside buildSecondaryTab, netAmount
    // widens to 3500 (all three months) and this assertion fails.
    expect(result.netAmount).toBe(2300);
    expect(result.netAmount).not.toBe(3500);
  });

  it("filtered monthly breakdown contains only selected months — Jun-26 absent", async () => {
    const result = await buildSecondaryTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    const months = result.monthly.map((m) => m.month);
    expect(months).not.toContain("Jun-26");
    expect(months).toContain("Apr-26");
    expect(months).toContain("May-26");
  });

  it("filtered netAmount = sum of monthly net values (internal consistency)", async () => {
    const result = await buildSecondaryTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    const monthlySum = result.monthly.reduce((s, m) => s + m.net, 0);
    expect(Math.abs(result.netAmount - monthlySum)).toBeLessThan(1);
  });

  it("unfiltered result includes all three months and netAmount = FY total", async () => {
    const result = await buildSecondaryTab(CUR_FY, TEST_DIST, null);
    const months = result.monthly.map((m) => m.month);
    expect(months).toContain("Apr-26");
    expect(months).toContain("May-26");
    expect(months).toContain("Jun-26");
    expect(result.netAmount).toBe(3500);
  });

  it("filtered netAmount is strictly less than unfiltered netAmount", async () => {
    const [filtered, unfiltered] = await Promise.all([
      buildSecondaryTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]),
      buildSecondaryTab(CUR_FY, TEST_DIST, null),
    ]);
    expect(filtered.netAmount).toBeLessThan(unfiltered.netAmount);
  });

  it("single-month filter returns exactly that month's net", async () => {
    const result = await buildSecondaryTab(CUR_FY, TEST_DIST, ["Apr-26"]);
    expect(result.netAmount).toBe(1500);           // CODE1(1000) + CODE2(500)
    expect(result.monthly).toHaveLength(1);
    expect(result.monthly[0].month).toBe("Apr-26");
  });

  it("monthsLoaded reflects the filtered window, not the full FY", async () => {
    const result = await buildSecondaryTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    // monthsLoaded must be the intersection of the selection with present months.
    expect(result.monthsLoaded).not.toContain("Jun-26");
    expect(result.monthsLoaded).toContain("Apr-26");
    expect(result.monthsLoaded).toContain("May-26");
  });
});

describe("buildSkuEvolution — baseline months through the full query chain", () => {
  it("currentMonths equals the passed months selection", async () => {
    const result = await buildSkuEvolution(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    // secondary register has data for this period; secondary side must be non-null.
    expect(result.secondary).not.toBeNull();
    const side = result.secondary!;
    // currentMonths must be the selection, not all loaded months.
    expect(side.currentMonths.sort()).toEqual(["Apr-26", "May-26"].sort());
  });

  it("baselineMonths equals toPriorYearMonths(selection) — not a wider window", async () => {
    const result = await buildSkuEvolution(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    expect(result.secondary).not.toBeNull();
    const side = result.secondary!;
    // If months is ignored inside buildSkuEvolution, baselineMonths would be
    // toPriorYearMonths(recon.monthsLoaded) = ["Apr-25","May-25","Jun-25"],
    // which does NOT equal ["Apr-25","May-25"]. The assertion below catches it.
    expect(side.baselineMonths.sort()).toEqual(["Apr-25", "May-25"].sort());
    expect(side.baselineMonths).not.toContain("Jun-25");
  });

  it("a different selection produces a different baseline (not always the full prior FY)", async () => {
    const [rApr, rMay] = await Promise.all([
      buildSkuEvolution(CUR_FY, TEST_DIST, ["Apr-26"]),
      buildSkuEvolution(CUR_FY, TEST_DIST, ["May-26"]),
    ]);
    const baseApr = (rApr.secondary ?? rApr.primary)?.baselineMonths ?? [];
    const baseMay = (rMay.secondary ?? rMay.primary)?.baselineMonths ?? [];
    expect(baseApr.sort()).not.toEqual(baseMay.sort());
  });

  it("baseline has data from the shifted prior months (seeded base FY)", async () => {
    const result = await buildSkuEvolution(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    expect(result.secondary).not.toBeNull();
    const side = result.secondary!;
    // The base FY has CODE1 in Apr-25+May-25 (1000) and the current FY has
    // CODE1 (1800) + fresh CODE2 (500). totalBaseline must be > 0.
    expect(side.totalBaseline).toBeGreaterThan(0);
    // And existing SKU (CODE1 present in both sides) must be found.
    expect(side.existing.codes).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. buildPushTab — DORMANT RETAILER PRIOR-YEAR MONTH SCOPING
//
//    Regression guard for the priorMonths path in buildPushTab (~line 1001):
//      const priorMonths = months && months.length > 0 ? toPriorYearMonths(months) : null;
//
//    The dormant-retailer query gates the prior-FY side on monthCond(priorMonths).
//    If the months argument is silently dropped, the prior query widens to the
//    full prior FY and RETAILER-C (Jun-25 only) would appear as dormant even
//    when months=["Apr-26","May-26"].  The "not.toContain" assertion catches it.
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildPushTab — dormant-retailer prior-year month scoping", () => {
  it("RETAILER-A (Apr-25 active) appears in dormant when Apr-26/May-26 selected", async () => {
    // RETAILER-A has BASE_FY Apr-25 activity but no CUR_FY Apr-26/May-26
    // activity → must appear in dormantRetailers.
    const result = await buildPushTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    const names = result.coverage.dormantRetailers.map((r) => r.name);
    expect(names).toContain("RETAILER-A");
  });

  it("RETAILER-C (Jun-25 only) is absent from dormant when Apr-26/May-26 selected", async () => {
    // toPriorYearMonths(["Apr-26","May-26"]) = ["Apr-25","May-25"].
    // Jun-25 is NOT in that window, so RETAILER-C must be excluded from the
    // prior-FY CTE.  If monthCond(priorMonths) is dropped, RETAILER-C appears
    // and this assertion fails — catching the regression.
    const result = await buildPushTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    const names = result.coverage.dormantRetailers.map((r) => r.name);
    expect(names).not.toContain("RETAILER-C");
  });

  it("RETAILER-C does appear in dormant when no months selected (full prior FY)", async () => {
    // Confirm the test data is structurally sound: with months=null, priorMonths
    // is null (no restriction) and Jun-25 is in scope — RETAILER-C must appear.
    const result = await buildPushTab(CUR_FY, TEST_DIST, null);
    const names = result.coverage.dormantRetailers.map((r) => r.name);
    expect(names).toContain("RETAILER-C");
  });

  it("prior-year value of RETAILER-A comes from Apr-25 only (700), not wider window", async () => {
    // Guards against a silent month-widening that would accumulate more than the
    // Apr-25 row's net_amount (700) into priorYearValue.
    const result = await buildPushTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    const entry = result.coverage.dormantRetailers.find((r) => r.name === "RETAILER-A");
    expect(entry).toBeDefined();
    expect(entry!.priorYearValue).toBe(700);
  });

  it("a different month selection shifts the prior window accordingly", async () => {
    // When only Jun-26 is selected, priorMonths = ["Jun-25"] → RETAILER-C (Jun-25)
    // becomes eligible and RETAILER-A (Apr-25 only) is excluded.
    const result = await buildPushTab(CUR_FY, TEST_DIST, ["Jun-26"]);
    const names = result.coverage.dormantRetailers.map((r) => r.name);
    expect(names).toContain("RETAILER-C");
    expect(names).not.toContain("RETAILER-A");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. buildPushTab — unassignedByMember FULL-FY INVARIANT
//
//    unassignedByMember is sourced from the deep-dive snapshot (loadDistDdSnapshotOnly),
//    which carries no month dimension.  Selecting a period must NOT change these
//    counts — they always reflect the full FY state of the member working sheets.
//
//    Two specific contracts are guarded:
//      a) The unassignedByMember array is identical (same members, same counts)
//         whether months is null or a specific selection — because the snapshot
//         read is unconditional (no monthCond applied to snapshot lookup).
//      b) coverage.note explicitly states the full-FY caveat when a period is
//         selected, so the UI always has the opportunity to surface it.
//
//    The mock snapshot carries exactly ONE member ("MOCK MEMBER") with
//    noneCount=7 for the TEST_DIST distributor.  That value must appear
//    unchanged in both the filtered and unfiltered calls.
// ═══════════════════════════════════════════════════════════════════════════════

// Minimal DistributorDeepDiveResult shape (only the fields consumed by buildPushTab).
const MOCK_MEMBER_NAME = "MOCK MEMBER";
const MOCK_MEMBER_NONE_COUNT = 7;
const MOCK_SNAPSHOT = {
  fy: CUR_FY,
  stateHeads: ["MOCK HEAD"],
  distributors: [
    {
      normKey: TEST_DIST,
      name: TEST_DIST,
      retailerCount: 10,
      activeCount: 8,
      dormantCount: 2,
      orderBooking: 0,
      sale: 0,
      visits: null,
      obSharePct: null,
      isConcentrationRisk: false,
      confirmedCount: 10,
      guessedCount: 0,
      flows: null,
      retailers: [
        {
          name: "RETAILER-X",
          memberName: MOCK_MEMBER_NAME,
          district: "MOCK DISTRICT",
          orderBooking: 0,
          sale: 0,
          visits: null,
          isActive: true,
          confirmedHead: true,
        },
      ],
    },
  ],
  perMember: [
    {
      name: MOCK_MEMBER_NAME,
      normKey: "MOCK MEMBER",
      state: "MOCK STATE",
      isLeft: false,
      totalRetailers: 20,
      removedCount: 0,
      namedCount: 13,
      noneCount: MOCK_MEMBER_NONE_COUNT,
      blankCount: 0,
      sharedCount: 0,
      blankOb: 0,
      noneSharePct: 35,
      namedActivePct: 80,
      noneActivePct: 40,
      noneVisits: null,
      noneVisitSharePct: null,
      achievementTotal: null,
    },
  ],
  sharedRetailers: [],
  directDealer: null,
  noneAssigned: null,
  mappingQuality: null,
  partyObTotal: 0,
  membersLoaded: 1,
  membersNotMapped: 0,
  membersFailed: 0,
  whitespace: null,
  concentration: null,
  capacityCheck: null,
  byState: [],
  unassignedCorrelation: null,
  namingCandidates: [],
  error: null,
} as any;

describe("buildPushTab — unassignedByMember is always full-FY (snapshot-sourced)", () => {
  // Before each test in this block: give the mock distributor a head so that
  // buildPushTab actually calls loadDistDdSnapshotOnly, and configure the
  // snapshot mock to return the controlled data above.
  beforeAll(() => {
    vi.mocked(loadDistributorDirectory).mockResolvedValue({
      fy: CUR_FY,
      basis: "distributor-own-state",
      basisLabel: "mock",
      states: [],
      heads: [],
      distributors: [
        {
          name: TEST_DIST,
          distKey: TEST_DIST,
          states: [],
          heads: ["MOCK HEAD"],
          members: [],
          retailerCount: 0,
          activeCount: 0,
          orderBooking: 0,
          sale: 0,
        },
      ],
      builtAt: 0,
    });
    vi.mocked(loadDistDdSnapshotOnly).mockResolvedValue(MOCK_SNAPSHOT);
  });

  // Restore the defaults after this block so later tests (if any) are unaffected.
  afterAll(() => {
    vi.mocked(loadDistributorDirectory).mockResolvedValue({
      fy: CUR_FY,
      basis: "distributor-own-state",
      basisLabel: "mock",
      states: [],
      heads: [],
      distributors: [
        {
          name: TEST_DIST,
          distKey: TEST_DIST,
          states: [],
          heads: [],
          members: [],
          retailerCount: 0,
          activeCount: 0,
          orderBooking: 0,
          sale: 0,
        },
        {
          name: RETID_DIST,
          distKey: RETID_DIST,
          states: [],
          heads: [],
          members: [],
          retailerCount: 0,
          activeCount: 0,
          orderBooking: 0,
          sale: 0,
        },
      ],
      builtAt: 0,
    });
    vi.mocked(loadDistDdSnapshotOnly).mockResolvedValue(null);
  });

  it("unassignedByMember carries the mock member's noneCount from the snapshot", async () => {
    // Verify the snapshot mock is wired correctly: the member must appear with
    // the expected unassigned count regardless of period.
    const result = await buildPushTab(CUR_FY, TEST_DIST, null);
    const entry = result.coverage.unassignedByMember.find(
      (u) => u.member === MOCK_MEMBER_NAME,
    );
    expect(entry).toBeDefined();
    expect(entry!.unassigned).toBe(MOCK_MEMBER_NONE_COUNT);
  });

  it("unassignedByMember count is identical when a period is selected vs full FY", async () => {
    // Core invariant: the snapshot read has no month dimension.  Adding a period
    // filter must not change the unassigned counts.
    const [filtered, unfiltered] = await Promise.all([
      buildPushTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]),
      buildPushTab(CUR_FY, TEST_DIST, null),
    ]);
    expect(filtered.coverage.unassignedByMember).toEqual(
      unfiltered.coverage.unassignedByMember,
    );
  });

  it("unassigned count does not change across different period selections", async () => {
    // A different period selection (single month vs two months vs three months)
    // must all yield the same snapshot-derived count.
    const [rApr, rQ1, rNull] = await Promise.all([
      buildPushTab(CUR_FY, TEST_DIST, ["Apr-26"]),
      buildPushTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26", "Jun-26"]),
      buildPushTab(CUR_FY, TEST_DIST, null),
    ]);
    const countFor = (r: typeof rNull) =>
      r.coverage.unassignedByMember.find((u) => u.member === MOCK_MEMBER_NAME)
        ?.unassigned ?? null;

    expect(countFor(rApr)).toBe(MOCK_MEMBER_NONE_COUNT);
    expect(countFor(rQ1)).toBe(MOCK_MEMBER_NONE_COUNT);
    expect(countFor(rNull)).toBe(MOCK_MEMBER_NONE_COUNT);
  });

  it("coverage.note mentions full-FY caveat when a period is selected", async () => {
    // The note must surface the caveat so the UI has the text to display.
    // If someone removes the conditional note or changes its wording to omit
    // this key phrase, this test fails and alerts the author.
    const result = await buildPushTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    expect(result.coverage.note).toContain("full FY regardless of the selected period");
  });

  it("coverage.note does not contain the full-FY caveat when no period is selected", async () => {
    // When months=null the caveat is unnecessary (the figures ARE full-FY),
    // so the note should not prepend the clarifying sentence.
    const result = await buildPushTab(CUR_FY, TEST_DIST, null);
    expect(result.coverage.note).not.toContain("full FY regardless of the selected period");
  });

  it("loadDistDdSnapshotOnly is called with (fy, head) and not with any months arg", async () => {
    // Structural guard: the snapshot loader must never receive a months parameter.
    // If someone adds monthCond to the snapshot lookup, the call signature changes
    // and loadDistDdSnapshotOnly would need to accept months — which would break
    // the full-FY guarantee.  Checking the call args here catches that drift.
    vi.mocked(loadDistDdSnapshotOnly).mockClear();
    await buildPushTab(CUR_FY, TEST_DIST, ["Apr-26", "May-26"]);
    expect(vi.mocked(loadDistDdSnapshotOnly)).toHaveBeenCalledWith(CUR_FY, "MOCK HEAD");
    // Called with exactly 2 arguments — no months sneaked in as a third arg.
    const calls = vi.mocked(loadDistDdSnapshotOnly).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args).toHaveLength(2);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. RET# RETAILER IDENTITY — no silent merge on identical display names
// ═══════════════════════════════════════════════════════════════════════════════
//
// Fixtures (distributor = MOCK RETID DISTRIBUTOR, isolated from the totals
// assertions above):
//   TWIN STORES  RET#111  CUR_FY Apr-26 net 400
//   TWIN STORES  RET#222  CUR_FY Apr-26 net 250   ← same name, DIFFERENT retailer
//   GHOST MART   RET#444  CUR_FY Apr-26 net 100
//   GHOST MART   RET#333  BASE_FY Apr-25 net 900  ← same name, no CUR_FY sales
//
// Invariants: name-keyed aggregation would collapse TWIN STORES into one 650
// entry and let RET#444's activity mask RET#333's dormancy. RET#-keyed logic
// must keep counts, values, and dormant status distinct.

describe("buildSecondaryTab — RET# identity keeps same-name retailers distinct", () => {
  it("two TWIN STORES RET#s count as two retailers with separate values", async () => {
    const result = await buildSecondaryTab(CUR_FY, RETID_DIST, null);
    // TWIN STORES ×2 + GHOST MART (RET#444) + LEGACY SHOP (name-keyed, no ID)
    // + NEWID SHOP (RET#666) = 5 distinct retailers.
    expect(result.retailerCount).toBe(5);
    expect(result.activeRetailerCount).toBe(5);
    const twins = result.topRetailers.filter((r) => r.name === "TWIN STORES");
    expect(twins).toHaveLength(2);
    expect(twins.map((t) => t.net).sort((a, b) => a - b)).toEqual([250, 400]);
    // No merged 650 entry.
    expect(result.topRetailers.some((r) => r.net === 650)).toBe(false);
  });

  it("monthly retailer counts use identity keys, not names", async () => {
    const result = await buildSecondaryTab(CUR_FY, RETID_DIST, ["Apr-26"]);
    const apr = result.monthly.find((m) => m.month === "Apr-26");
    expect(apr?.retailers).toBe(5);
  });
});

describe("buildPushTab — RET#-keyed dormancy is not masked by a same-name active retailer", () => {
  it("GHOST MART (RET#333) is dormant even though RET#444 (same name) is active", async () => {
    const result = await buildPushTab(CUR_FY, RETID_DIST, null);
    const ghost = result.coverage.dormantRetailers.find((r) => r.name === "GHOST MART");
    expect(ghost).toBeDefined();
    expect(ghost?.priorYearValue).toBe(900);
    // TWIN STORES has no prior-FY activity — must not be reported dormant.
    expect(result.coverage.dormantRetailers.some((r) => r.name === "TWIN STORES")).toBe(false);
  });

  it("asymmetric ID coverage does not create false dormancy (ID in prior, none in current)", async () => {
    // LEGACY SHOP: prior FY carries RET#555, current FY row has no ID but is
    // active — the conditional join must fall back to name equality.
    const result = await buildPushTab(CUR_FY, RETID_DIST, null);
    expect(result.coverage.dormantRetailers.some((r) => r.name === "LEGACY SHOP")).toBe(false);
  });

  it("asymmetric ID coverage does not create false dormancy (no ID in prior, ID in current)", async () => {
    const result = await buildPushTab(CUR_FY, RETID_DIST, null);
    expect(result.coverage.dormantRetailers.some((r) => r.name === "NEWID SHOP")).toBe(false);
  });
});
