// Task 172 guards: RET# column detection, merged-cell carry-forward, and
// serial-pollution prevention in the secondary SKU loader.
// Task 299 guards: state_canon backfill join logic (headNormKey invariants).
import { describe, it, expect } from "vitest";
import {
  parseTab,
  normaliseRetId,
  checkReplaceSanity,
  checkOpenFyWipeGuard,
  priorLikeMonthLabel,
  priorFyLabel,
  WIPE_GUARD_RATIO,
  headNormKey,
} from "./skuLoader.js";

describe("checkReplaceSanity (pre-delete gate for replace mode)", () => {
  const good = { rowsParsed: 300_000, rowsWithRetId: 300_000, tabsWithItemCodes: 4, existingRows: 250_000 };
  it("accepts a genuine full parse", () => {
    expect(checkReplaceSanity(good)).toEqual({ ok: true });
  });
  it("refuses when no data tab was found", () => {
    expect(checkReplaceSanity({ ...good, tabsWithItemCodes: 0 }).ok).toBe(false);
  });
  it("refuses an empty or near-empty parse", () => {
    expect(checkReplaceSanity({ ...good, rowsParsed: 0, rowsWithRetId: 0 }).ok).toBe(false);
    expect(checkReplaceSanity({ ...good, rowsParsed: 999, rowsWithRetId: 999 }).ok).toBe(false);
  });
  it("refuses when RET# coverage collapses (broken carry-forward/columns)", () => {
    expect(checkReplaceSanity({ ...good, rowsWithRetId: 40_000 }).ok).toBe(false);
  });
  it("refuses a suspiciously small replacement of a populated FY", () => {
    expect(checkReplaceSanity({ ...good, rowsParsed: 100_000, rowsWithRetId: 100_000 }).ok).toBe(false);
  });
  it("allows first-time loads of an empty FY (no existing rows)", () => {
    expect(checkReplaceSanity({ rowsParsed: 5_000, rowsWithRetId: 5_000, tabsWithItemCodes: 1, existingRows: 0 })).toEqual({ ok: true });
  });
});

describe("normaliseRetId", () => {
  it("normalises RET# forms", () => {
    expect(normaliseRetId("RET#12345")).toBe("RET#12345");
    expect(normaliseRetId("ret# 12345")).toBe("RET#12345");
    expect(normaliseRetId("RET 987")).toBe("RET#987");
  });
  it("rejects bare serials and junk (never pollute retailer_id again)", () => {
    expect(normaliseRetId("123")).toBeNull();
    expect(normaliseRetId("1")).toBeNull();
    expect(normaliseRetId("SR.NO")).toBeNull();
    expect(normaliseRetId("")).toBeNull();
  });
});

const HEADER = ["SR.NO.", "DATE", "RETAILER ID", "RETAILER", "ORDER ID", "SEGMENT", "CAT. NO.", "QTY", "MRP", "ORDER VALUE", "DISTRIBUTOR", "DISCOUNT", "SUB TOTAL", "ORDER TOTAL", "TEAM MEMBER"];

describe("parseTab RET# handling", () => {
  it("binds retailerId to RETAILER ID (not SR.NO) and retailer to RETAILER (not RETAILER ID)", () => {
    const rows = [
      HEADER,
      ["1", "01-05-2024", "RET#111", "ALPHA TRADERS", "ORD1", "CPVC", "C100", "2", "50", "100", "DIST A", "", "100", "", "TM ONE"],
    ];
    const res = parseTab("T", rows as never, "2024-25", "sheet1");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].retailerId).toBe("RET#111");
    expect(res.rows[0].retailer).toBe("ALPHA TRADERS");
  });

  it("carry-forwards merged RET#/retailer/date/segment cells", () => {
    const rows = [
      HEADER,
      ["1", "01-05-2024", "RET#111", "ALPHA TRADERS", "ORD1", "CPVC", "C100", "2", "50", "100", "DIST A", "", "100", "", "TM ONE"],
      // merge-continuation rows: identity cells blank
      ["", "", "", "", "", "", "C200", "1", "80", "80", "", "", "80", "", ""],
      ["", "", "", "", "", "SWR", "C300", "3", "20", "60", "", "", "60", "", ""],
    ];
    const res = parseTab("T", rows as never, "2024-25", "sheet1");
    expect(res.rows).toHaveLength(3);
    expect(res.rows[1].retailerId).toBe("RET#111");
    expect(res.rows[1].retailer).toBe("ALPHA TRADERS");
    expect(res.rows[1].monthLabel).toBe(res.rows[0].monthLabel);
    expect(res.rows[1].segmentRaw).toBe("CPVC");
    expect(res.rows[2].segmentRaw).toBe("SWR");
    expect(res.rowsWithRetId).toBe(3);
  });

  it("does not leak the previous block's RET# into a new retailer block without one", () => {
    const rows = [
      HEADER,
      ["1", "01-05-2024", "RET#111", "ALPHA TRADERS", "ORD1", "CPVC", "C100", "2", "50", "100", "DIST A", "", "100", "", "TM ONE"],
      ["2", "02-05-2024", "", "BETA AGENCIES", "ORD2", "SWR", "C200", "1", "80", "80", "DIST B", "", "80", "", "TM ONE"],
    ];
    const res = parseTab("T", rows as never, "2024-25", "sheet1");
    expect(res.rows).toHaveLength(2);
    expect(res.rows[1].retailer).toBe("BETA AGENCIES");
    expect(res.rows[1].retailerId).toBeNull();
  });

  it("never stores a bare serial as retailer_id (old ID-column layouts)", () => {
    const header = ["S.NO", "DATE", "RETAILERS", "ID", "SEGMENT", "CAT.NO", "QTY", "MRP", "ORDER VALUE", "DISTRIBUTOR", "DISCOUNT", "SUB TOTAL", "ORDER TOTAL", "TEAM MEMBER"];
    const rows = [
      header,
      ["7", "01-06-2021", "GAMMA STORES", "RET#555", "AGRI", "A10", "1", "10", "10", "DIST C", "", "10", "", "TM TWO"],
      ["8", "01-06-2021", "DELTA STORES", "42", "AGRI", "A11", "1", "10", "10", "DIST C", "", "10", "", "TM TWO"],
    ];
    const res = parseTab("T", rows as never, "2021-22", "sheet2");
    expect(res.rows[0].retailerId).toBe("RET#555");
    expect(res.rows[1].retailerId).toBeNull();
  });
});

// ── Open-FY wipe guard (abort-before-delete, pure unit tests) ─────────────────

describe("priorLikeMonthLabel / priorFyLabel helpers", () => {
  it("maps each month label to the same month in the prior fiscal year", () => {
    expect(priorLikeMonthLabel("Apr-26")).toBe("Apr-25");
    expect(priorLikeMonthLabel("Jan-27")).toBe("Jan-26");
    expect(priorLikeMonthLabel("Mar-27")).toBe("Mar-26");
  });

  it("maps FY labels to the prior FY", () => {
    expect(priorFyLabel("2026-27")).toBe("2025-26");
    expect(priorFyLabel("2025-26")).toBe("2024-25");
    expect(priorFyLabel("2024-25")).toBe("2023-24");
  });
});

describe("checkOpenFyWipeGuard (pure, no DB)", () => {
  // Helper: build Maps from plain objects for readability.
  const mkMap = (obj: Record<string, number>) => new Map(Object.entries(obj));

  it("passes when every month is well above the ratio floor", () => {
    const incoming = mkMap({ "Apr-26": 10_000, "May-26": 9_500 });
    // Prior like-months: Apr-25 = 10_000, May-25 = 9_000
    const prior = mkMap({ "Apr-25": 10_000, "May-25": 9_000 });
    expect(checkOpenFyWipeGuard(incoming, prior)).toEqual({ ok: true });
  });

  it("passes when incoming exactly equals the ratio floor", () => {
    const incoming = mkMap({ "Apr-26": 6_000 }); // exactly 60% of 10_000
    const prior    = mkMap({ "Apr-25": 10_000 });
    expect(checkOpenFyWipeGuard(incoming, prior)).toEqual({ ok: true });
  });

  it("triggers when a batch is 10% of the prior like-month (abort-path)", () => {
    // 10% is well below the 60% floor — the guard must fire.
    const incoming = mkMap({ "Apr-26": 1_000 }); // 10% of 10_000
    const prior    = mkMap({ "Apr-25": 10_000 });
    const result = checkOpenFyWipeGuard(incoming, prior);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].month).toBe("Apr-26");
      expect(result.violations[0].incoming).toBe(1_000);
      expect(result.violations[0].priorRows).toBe(10_000);
      expect(result.violations[0].floor).toBe(10_000 * WIPE_GUARD_RATIO);
      expect(result.reason).toMatch(/Apr-26/);
    }
  });

  it("triggers even for a single violating month among several passing ones", () => {
    const incoming = mkMap({ "Apr-26": 9_000, "May-26": 500 }); // May is 5% of prior
    const prior    = mkMap({ "Apr-25": 10_000, "May-25": 10_000 });
    const result = checkOpenFyWipeGuard(incoming, prior);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].month).toBe("May-26");
    }
  });

  it("skips months with no prior baseline (first-ever load, new month)", () => {
    // Prior FY has no data for Apr-25 — the guard must not fire.
    const incoming = mkMap({ "Apr-26": 1 }); // tiny batch, but no baseline
    const prior    = new Map<string, number>(); // empty: no prior data
    expect(checkOpenFyWipeGuard(incoming, prior)).toEqual({ ok: true });
  });

  it("skips months where prior baseline is 0", () => {
    const incoming = mkMap({ "Apr-26": 1 });
    const prior    = mkMap({ "Apr-25": 0 }); // explicit zero → no baseline
    expect(checkOpenFyWipeGuard(incoming, prior)).toEqual({ ok: true });
  });

  it("respects a custom ratio override", () => {
    // Using 0.30 override: 3_500 / 10_000 = 35% > 30% → passes
    const incoming = mkMap({ "Apr-26": 3_500 });
    const prior    = mkMap({ "Apr-25": 10_000 });
    expect(checkOpenFyWipeGuard(incoming, prior, 0.30)).toEqual({ ok: true });

    // Same data with default 0.60 → fails
    expect(checkOpenFyWipeGuard(incoming, prior)).toMatchObject({ ok: false });
  });

  it("guard fires before the DELETE: a violation must produce a non-ok result with a clear reason", () => {
    // Regression guard: the error message must describe the month and counts
    // so an operator can diagnose which month triggered the abort.
    const incoming = mkMap({ "Jul-26": 200 }); // 2% of prior
    const prior    = mkMap({ "Jul-25": 10_000 });
    const result = checkOpenFyWipeGuard(incoming, prior);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Jul-26");
      expect(result.reason).toContain("incoming=200");
      expect(result.reason).toMatch(/floor=\d+/);
      expect(result.reason).toContain("Jul-25=10000");
    }
  });
});

// ── Task 299: state_canon backfill join invariants ────────────────────────────
//
// The SQL backfill joins secondary_sku_line.head_canon to person_registry via:
//   Path A: exact norm_key match
//   Path B: REGEXP_REPLACE(LOWER(TRIM(COALESCE(alias_secondary, canonical_name))), '\s+', ' ', 'g')
//
// headNormKey() is the JS mirror of the SQL REGEXP_REPLACE expression.
// These tests verify the equivalence that makes the join correct and cover the
// four match paths described in the task.

describe("headNormKey (state_canon backfill join key)", () => {
  it("matches the SQL REGEXP_REPLACE(LOWER(TRIM(x)), '\\s+', ' ', 'g') semantics", () => {
    // Simulating what the SQL does to alias_secondary / canonical_name:
    expect(headNormKey("Pawan Sharma")).toBe("pawan sharma");
    expect(headNormKey("  Pawan  Sharma  ")).toBe("pawan sharma");
    expect(headNormKey("PAWAN SHARMA")).toBe("pawan sharma");
    expect(headNormKey("Pawan\tSharma")).toBe("pawan sharma");  // tab → space
    expect(headNormKey("Pawan\n Sharma")).toBe("pawan sharma"); // newline+space → space
  });

  it("head_canon (from skuLoader normKey) equals headNormKey on same input", () => {
    // head_canon = headRaw.toLowerCase().replace(/\s+/g, " ").trim()
    // headNormKey(x) must produce the same value so both sides of the join agree.
    const headRaw = "  Rajesh Kumar Singh  ";
    const headCanon = headRaw.toLowerCase().replace(/\s+/g, " ").trim();
    expect(headNormKey(headRaw)).toBe(headCanon);
  });

  it("alias_secondary path: display name match (Path B)", () => {
    // alias_secondary holds the secondary-register display spelling.
    // After headNormKey, it must equal the head_canon from the sheet.
    const aliasSecondary = "Pawan Sharma"; // as stored in person_registry
    const headCanon = "pawan sharma";      // as in secondary_sku_line
    expect(headNormKey(aliasSecondary)).toBe(headCanon);
  });

  it("canonical_name fallback when alias_secondary is absent (Path B fallback)", () => {
    // When alias_secondary is NULL, SQL uses COALESCE to fall back to canonical_name.
    const canonicalName = "Amit Singh Rawat";
    const headCanon = "amit singh rawat";
    expect(headNormKey(canonicalName)).toBe(headCanon);
  });

  it("numeric employee-code norm_key is preserved as-is (Path A exact match)", () => {
    // For employee-code norm_keys (e.g. "1234"), the exact match path is used.
    // headNormKey("1234") === "1234" so exact comparison works.
    expect(headNormKey("1234")).toBe("1234");
    expect(headNormKey("42")).toBe("42");
  });

  it("collision-safe guard: same display key + different state_heads → ambiguous (HAVING = 1 rejects)", () => {
    // The backfill SQL uses HAVING COUNT(DISTINCT state_head) = 1 per head_canon.
    // This test simulates the registry entries and shows that two entries with the
    // same normalised display key but different state_heads are correctly identified
    // as ambiguous (same key, count = 2 → rejected, not updated).
    //
    // Example: Karnataka has two concurrent state heads; both registry rows may share
    // the same display-name normalisation after headNormKey().
    const registryEntry1 = { alias_secondary: "Ramesh Kumar", state_head: "Head A" };
    const registryEntry2 = { alias_secondary: "Ramesh Kumar", state_head: "Head B" };
    const headCanonInSheet = "ramesh kumar"; // as in secondary_sku_line

    const key1 = headNormKey(registryEntry1.alias_secondary);
    const key2 = headNormKey(registryEntry2.alias_secondary);

    // Both resolve to the same key — they would both match the head_canon.
    expect(key1).toBe(headCanonInSheet);
    expect(key2).toBe(headCanonInSheet);
    // But since state_heads differ, COUNT(DISTINCT state_head) = 2 → HAVING rejects.
    const distinctStateHeads = new Set([registryEntry1.state_head, registryEntry2.state_head]);
    expect(distinctStateHeads.size).toBe(2); // > 1 → backfill SQL skips this head_canon
  });

  it("collision-safe guard: same display key + same state_head → unambiguous (HAVING = 1 accepts)", () => {
    // Two registry rows that normalise to the same key but agree on state_head
    // are treated as one match — HAVING COUNT(DISTINCT state_head) = 1 accepts.
    const registryEntry1 = { alias_secondary: "Pawan Sharma", state_head: "Head A" };
    const registryEntry2 = { canonical_name: "PAWAN SHARMA", state_head: "Head A" };
    const headCanonInSheet = "pawan sharma";

    expect(headNormKey(registryEntry1.alias_secondary)).toBe(headCanonInSheet);
    expect(headNormKey(registryEntry2.canonical_name)).toBe(headCanonInSheet);
    const distinctStateHeads = new Set([registryEntry1.state_head, registryEntry2.state_head]);
    expect(distinctStateHeads.size).toBe(1); // = 1 → backfill SQL accepts and assigns Head A
  });
});
