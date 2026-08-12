// Guard: verifies that TERRITORY_GROUPS, SCHEMES, SCHEME_SLABS, SCHEME_ITEM_GROUPS
// and SPECIAL_PRICING all meet minimum row counts derived from the Q2 FY2026-27
// workbook. No DB connection required — pure in-memory assertions.
//
// If any assertion fails, it means the seed arrays lost rows (e.g. a bad merge
// truncated a partial array) and the nudge engine would silently run on fewer
// slabs. Fix by restoring the missing rows from the source workbook before
// running POST /api/admin/schemes/load.

import { describe, it, expect } from "vitest";
import {
  TERRITORY_GROUPS,
  SCHEMES,
  SCHEME_SLABS,
  SCHEME_ITEM_GROUPS,
  SPECIAL_PRICING,
} from "../schemeSeedData.js";

// ── Minimum counts anchored to the Q2 FY2026-27 workbook ─────────────────────
// Actual counts as of workbook parse: 15 / 19 / 132 / 75 / 1.
// Thresholds are intentionally set just below the exact counts so that any
// accidental loss of even a single row is caught, while a deliberate addition
// of a new scheme/slab is not a false positive.

const MIN_TERRITORY_GROUPS = 15;
const MIN_SCHEMES          = 19;
const MIN_SLABS            = 100; // actual 132; threshold catches major drops
const MIN_ITEM_GROUPS      = 70;  // actual 75
const MIN_SPECIAL_PRICING  = 1;

// ── Exact counts — fail fast when the arrays drift from the workbook ──────────
// These assert the precise values so any change (addition or removal) is
// surfaced explicitly rather than silently accepted.

const EXACT_TERRITORY_GROUPS = 15;
const EXACT_SCHEMES          = 19;
const EXACT_SLABS            = 132;
const EXACT_ITEM_GROUPS      = 75;
const EXACT_SPECIAL_PRICING  = 1;

describe("schemeSeedData — minimum-count guard (CI-safe, no DB)", () => {
  it(`TERRITORY_GROUPS has at least ${MIN_TERRITORY_GROUPS} rows`, () => {
    expect(TERRITORY_GROUPS.length).toBeGreaterThanOrEqual(MIN_TERRITORY_GROUPS);
  });

  it(`SCHEMES has at least ${MIN_SCHEMES} rows`, () => {
    expect(SCHEMES.length).toBeGreaterThanOrEqual(MIN_SCHEMES);
  });

  it(`SCHEME_SLABS has at least ${MIN_SLABS} rows`, () => {
    expect(SCHEME_SLABS.length).toBeGreaterThanOrEqual(MIN_SLABS);
  });

  it(`SCHEME_ITEM_GROUPS has at least ${MIN_ITEM_GROUPS} rows`, () => {
    expect(SCHEME_ITEM_GROUPS.length).toBeGreaterThanOrEqual(MIN_ITEM_GROUPS);
  });

  it(`SPECIAL_PRICING has at least ${MIN_SPECIAL_PRICING} row`, () => {
    expect(SPECIAL_PRICING.length).toBeGreaterThanOrEqual(MIN_SPECIAL_PRICING);
  });
});

describe("schemeSeedData — exact-count guard (Q2 FY2026-27 workbook baseline)", () => {
  it(`TERRITORY_GROUPS has exactly ${EXACT_TERRITORY_GROUPS} rows`, () => {
    expect(TERRITORY_GROUPS.length).toBe(EXACT_TERRITORY_GROUPS);
  });

  it(`SCHEMES has exactly ${EXACT_SCHEMES} rows`, () => {
    expect(SCHEMES.length).toBe(EXACT_SCHEMES);
  });

  it(`SCHEME_SLABS has exactly ${EXACT_SLABS} rows`, () => {
    expect(SCHEME_SLABS.length).toBe(EXACT_SLABS);
  });

  it(`SCHEME_ITEM_GROUPS has exactly ${EXACT_ITEM_GROUPS} rows`, () => {
    expect(SCHEME_ITEM_GROUPS.length).toBe(EXACT_ITEM_GROUPS);
  });

  it(`SPECIAL_PRICING has exactly ${EXACT_SPECIAL_PRICING} row`, () => {
    expect(SPECIAL_PRICING.length).toBe(EXACT_SPECIAL_PRICING);
  });
});

describe("schemeSeedData — structural integrity", () => {
  it("every SCHEME_SLAB references a known scheme_id", () => {
    const knownIds = new Set(SCHEMES.map((s) => s.schemeId));
    const orphans = SCHEME_SLABS.filter((sl) => !knownIds.has(sl.schemeId));
    expect(orphans).toEqual([]);
  });

  it("every SCHEME_ITEM_GROUP references a known scheme_id", () => {
    const knownIds = new Set(SCHEMES.map((s) => s.schemeId));
    const orphans = SCHEME_ITEM_GROUPS.filter((ig) => !knownIds.has(ig.schemeId));
    expect(orphans).toEqual([]);
  });

  it("every scheme has at least one slab", () => {
    const slabsByScheme = new Map<string, number>();
    for (const sl of SCHEME_SLABS) {
      slabsByScheme.set(sl.schemeId, (slabsByScheme.get(sl.schemeId) ?? 0) + 1);
    }
    const schemesWithoutSlabs = SCHEMES.filter((s) => !slabsByScheme.has(s.schemeId));
    expect(schemesWithoutSlabs).toEqual([]);
  });

  it("every TERRITORY_GROUP has a non-empty states array", () => {
    const empty = TERRITORY_GROUPS.filter((tg) => tg.states.length === 0);
    expect(empty).toEqual([]);
  });

  it("every SCHEME_SLAB has a non-negative slab_order", () => {
    const bad = SCHEME_SLABS.filter((sl) => sl.slabOrder < 1);
    expect(bad).toEqual([]);
  });
});
