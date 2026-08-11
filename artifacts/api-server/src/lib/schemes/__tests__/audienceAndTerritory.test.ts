// Tests for scheme audience filtering and territory resolver.
//
// Verifies:
//   1. sub_dealer audience SQL excludes distributors (NOT EXISTS in distributor_identity)
//   2. distributor audience SQL includes only distributors (EXISTS in distributor_identity)
//   3. Mixed/dual audience returns no filter
//   4. direct_dealer-only audience returns a failing condition (not resolvable from sale_line)
//   5. stateCanonsForAbbrevs handles ALL, ALL_EXCEPT_KL_KA_TN_AP, normal abbrevs
//   6. ALL_EXCEPT_KL_KA_TN_AP correctly excludes Kerala/Karnataka/AP/Telangana states
import { describe, it, expect } from "vitest";
import { buildAudienceFilterSQL } from "../audienceFilter.js";
import { stateCanonsForAbbrevs } from "../territoryResolver.js";

// ── buildAudienceFilterSQL ─────────────────────────────────────────────────────

describe("buildAudienceFilterSQL", () => {
  it("sub_dealer-only: returns NOT EXISTS distributor_identity clause", () => {
    const sql = buildAudienceFilterSQL(["sub_dealer"]);
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("distributor_identity");
    expect(sql).toContain("norm_key");
    // Must not mention type_raw — that column is NULL for all sale_line rows
    expect(sql).not.toContain("type_raw");
  });

  it("sub_dealer-only: uses default table alias 'sl'", () => {
    const sql = buildAudienceFilterSQL(["sub_dealer"]);
    expect(sql).toContain("sl.customer");
  });

  it("sub_dealer-only: respects custom table alias", () => {
    const sql = buildAudienceFilterSQL(["sub_dealer"], "t");
    expect(sql).toContain("t.customer");
    expect(sql).not.toContain("sl.customer");
  });

  it("distributor-only: returns EXISTS distributor_identity clause", () => {
    const sql = buildAudienceFilterSQL(["distributor"]);
    expect(sql).toContain("EXISTS");
    expect(sql).not.toContain("NOT EXISTS");
    expect(sql).toContain("distributor_identity");
  });

  it("direct_dealer-only: returns a failing condition (fail closed)", () => {
    const sql = buildAudienceFilterSQL(["direct_dealer"]);
    // Must fail closed — no data available to identify direct dealers in sale_line
    expect(sql).toContain("false");
  });

  it("sub_dealer + direct_dealer: returns empty string (no filter)", () => {
    const sql = buildAudienceFilterSQL(["direct_dealer", "sub_dealer"]);
    expect(sql.trim()).toBe("");
  });

  it("distributor + direct_dealer: returns empty string (no filter)", () => {
    const sql = buildAudienceFilterSQL(["distributor", "direct_dealer"]);
    expect(sql.trim()).toBe("");
  });

  it("empty audience: returns empty string (no filter)", () => {
    const sql = buildAudienceFilterSQL([]);
    expect(sql.trim()).toBe("");
  });

  it("sub_dealer SQL uses REGEXP_REPLACE for name normalisation", () => {
    const sql = buildAudienceFilterSQL(["sub_dealer"]);
    expect(sql).toContain("REGEXP_REPLACE");
    expect(sql).toContain("UPPER");
    expect(sql).toContain("TRIM");
  });
});

// ── stateCanonsForAbbrevs — normal cases ──────────────────────────────────────

describe("stateCanonsForAbbrevs — normal abbrevs", () => {
  it("WB → WEST BENGAL", () => {
    const result = stateCanonsForAbbrevs(["WB"]);
    expect(result).toContain("WEST BENGAL");
  });

  it("WUP → UP (A)", () => {
    const result = stateCanonsForAbbrevs(["WUP"]);
    expect(result).toContain("UP (A)");
  });

  it("KARNATAKA → KARNATAKA and KARNATAKA (B)", () => {
    const result = stateCanonsForAbbrevs(["KARNATAKA"]);
    expect(result).toContain("KARNATAKA");
    expect(result).toContain("KARNATAKA (B)");
  });

  it("empty abbrev list → empty result", () => {
    expect(stateCanonsForAbbrevs([])).toHaveLength(0);
  });

  it("unrecognised abbrev → empty result (fail closed)", () => {
    // An unknown sentinel should not match any state
    expect(stateCanonsForAbbrevs(["UNKNOWN_SENTINEL"])).toHaveLength(0);
  });
});

// ── stateCanonsForAbbrevs — ALL sentinel ──────────────────────────────────────

describe("stateCanonsForAbbrevs — ALL sentinel", () => {
  it("ALL: includes common states", () => {
    const result = stateCanonsForAbbrevs(["ALL"]);
    expect(result).toContain("WEST BENGAL");
    expect(result).toContain("GUJARAT");
    expect(result).toContain("KERALA");
    expect(result).toContain("KARNATAKA");
  });

  it("ALL: does not include empty-abbrev states (Tamil Nadu, GEM)", () => {
    const result = stateCanonsForAbbrevs(["ALL"]);
    expect(result).not.toContain("TAMIL NADU");
    expect(result).not.toContain("GEM");
  });
});

// ── stateCanonsForAbbrevs — ALL_EXCEPT_KL_KA_TN_AP sentinel ─────────────────

describe("stateCanonsForAbbrevs — ALL_EXCEPT_KL_KA_TN_AP sentinel", () => {
  it("includes Delhi, WB, Gujarat, Bihar (not excluded)", () => {
    const result = stateCanonsForAbbrevs(["ALL_EXCEPT_KL_KA_TN_AP"]);
    expect(result).toContain("DELHI");
    expect(result).toContain("WEST BENGAL");
    expect(result).toContain("GUJARAT");
    expect(result).toContain("BIHAR");
  });

  it("excludes KERALA", () => {
    const result = stateCanonsForAbbrevs(["ALL_EXCEPT_KL_KA_TN_AP"]);
    expect(result).not.toContain("KERALA");
  });

  it("excludes KARNATAKA and KARNATAKA (B)", () => {
    const result = stateCanonsForAbbrevs(["ALL_EXCEPT_KL_KA_TN_AP"]);
    expect(result).not.toContain("KARNATAKA");
    expect(result).not.toContain("KARNATAKA (B)");
  });

  it("excludes AP/Andhra Pradesh/Telangana", () => {
    const result = stateCanonsForAbbrevs(["ALL_EXCEPT_KL_KA_TN_AP"]);
    expect(result).not.toContain("AP");
    expect(result).not.toContain("ANDHRA PRADESH");
    expect(result).not.toContain("TELANGANA");
  });

  it("excludes Tamil Nadu (empty abbrev — already excluded from ALL)", () => {
    const result = stateCanonsForAbbrevs(["ALL_EXCEPT_KL_KA_TN_AP"]);
    expect(result).not.toContain("TAMIL NADU");
  });

  it("returns a non-empty list (most of India is included)", () => {
    const result = stateCanonsForAbbrevs(["ALL_EXCEPT_KL_KA_TN_AP"]);
    expect(result.length).toBeGreaterThan(10);
  });

  it("result is strictly smaller than ALL", () => {
    const all = stateCanonsForAbbrevs(["ALL"]);
    const except = stateCanonsForAbbrevs(["ALL_EXCEPT_KL_KA_TN_AP"]);
    expect(except.length).toBeLessThan(all.length);
  });
});
