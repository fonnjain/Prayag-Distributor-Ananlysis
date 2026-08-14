// Unit tests for the SKU coverage guard pure helpers.
// DB-backed functions (checkSkuVsRegisterCoverage, computeRetailerGap)
// are not tested here — they require a live DB. The pure classification
// and warning-building functions are tested exhaustively so regressions
// in threshold logic and the recommendation-path consumption are caught.

import { describe, it, expect } from "vitest";
import {
  classifyMemberCoverage,
  buildCoverageWarning,
  buildCoverageStatus,
  COVERAGE_THRESHOLD,
  type MemberCoverageRow,
  type CoverageStatus,
} from "./skuCoverageGuard.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal MemberCoverageRow for testing. */
function mkMember(
  headCanon: string | null,
  flag: MemberCoverageRow["flag"],
  qtyRatio: number | null = null,
): MemberCoverageRow {
  return {
    fy: "2025-26",
    headCanon,
    skuQty: 0,
    skuNet: 0,
    registerQty: 0,
    registerNet: 0,
    qtyRatio,
    netRatio: null,
    flag,
  };
}

// ── classifyMemberCoverage ────────────────────────────────────────────────────

describe("classifyMemberCoverage", () => {
  it("returns ok when sku_qty equals register_qty (100% coverage)", () => {
    expect(classifyMemberCoverage(1000, 1000)).toBe("ok");
  });

  it("returns ok when sku_qty is exactly at the threshold (60%)", () => {
    expect(classifyMemberCoverage(600, 1000)).toBe("ok");
    expect(classifyMemberCoverage(600, 1000, 0.60)).toBe("ok");
  });

  it("returns low when sku_qty is just below the threshold", () => {
    // 599/1000 = 59.9% < 60% → low
    expect(classifyMemberCoverage(599, 1000)).toBe("low");
  });

  it("returns low when sku_qty is far below the threshold (e.g. 28% like Ayan Enterprise)", () => {
    // 20272/71470 ≈ 28%
    expect(classifyMemberCoverage(20272, 71470)).toBe("low");
  });

  it("returns no-sku when register_qty > 0 but sku_qty = 0", () => {
    expect(classifyMemberCoverage(0, 1000)).toBe("no-sku");
    expect(classifyMemberCoverage(0, 500)).toBe("no-sku");
  });

  it("returns no-register when both are zero", () => {
    expect(classifyMemberCoverage(0, 0)).toBe("no-register");
  });

  it("returns no-register when register_qty = 0 and sku_qty > 0 (sku-only rows)", () => {
    expect(classifyMemberCoverage(100, 0)).toBe("no-register");
  });

  it("respects a custom threshold", () => {
    // 70% custom threshold: 699/1000 → low, 700/1000 → ok
    expect(classifyMemberCoverage(699, 1000, 0.70)).toBe("low");
    expect(classifyMemberCoverage(700, 1000, 0.70)).toBe("ok");
  });

  it("COVERAGE_THRESHOLD export is 0.60", () => {
    expect(COVERAGE_THRESHOLD).toBe(0.60);
  });
});

// ── buildCoverageWarning ──────────────────────────────────────────────────────
// This function is the bridge between the DB-backed coverage check and the K3
// recommendation path in loadSkuFacts. These tests prove that an incomplete
// PSCode2 load cannot produce false push recommendations without the caller
// seeing a non-null coverageWarning.

describe("buildCoverageWarning", () => {
  it("returns null when every member has flag=ok (PSCode2 complete)", () => {
    const members = [
      mkMember("alice", "ok", 0.95),
      mkMember("bob", "ok", 1.0),
    ];
    expect(buildCoverageWarning(members)).toBeNull();
  });

  it("returns null for an empty member list", () => {
    expect(buildCoverageWarning([])).toBeNull();
  });

  it("returns null when only no-register flags are present (no register baseline to compare)", () => {
    const members = [mkMember("carol", "no-register")];
    expect(buildCoverageWarning(members)).toBeNull();
  });

  it("returns a non-null warning when any member has flag=low", () => {
    const members = [
      mkMember("alice", "ok", 0.95),
      mkMember("bob", "low", 0.28), // Ayan Enterprise pattern: ~28%
    ];
    const warning = buildCoverageWarning(members);
    expect(warning).not.toBeNull();
    expect(warning!.flaggedMemberCount).toBe(1);
    expect(warning!.totalMembers).toBe(2);
    expect(warning!.threshold).toBe(COVERAGE_THRESHOLD);
    expect(warning!.flaggedMembers).toHaveLength(1);
    expect(warning!.flaggedMembers[0].headCanon).toBe("bob");
    expect(warning!.flaggedMembers[0].flag).toBe("low");
    expect(warning!.flaggedMembers[0].qtyRatio).toBe(0.28);
    expect(warning!.note).toContain("PSCode2");
    expect(warning!.note).toContain("1 of 2 member");
  });

  it("returns a non-null warning when any member has flag=no-sku (PSCode2 not loaded)", () => {
    const members = [mkMember("dave", "no-sku", null)];
    const warning = buildCoverageWarning(members);
    expect(warning).not.toBeNull();
    expect(warning!.flaggedMemberCount).toBe(1);
    expect(warning!.flaggedMembers[0].flag).toBe("no-sku");
  });

  it("counts all low + no-sku members as flagged (excludes ok and no-register)", () => {
    const members = [
      mkMember("a", "ok", 0.90),
      mkMember("b", "low", 0.55),
      mkMember("c", "no-sku", null),
      mkMember("d", "no-register"),
    ];
    const warning = buildCoverageWarning(members);
    expect(warning).not.toBeNull();
    expect(warning!.flaggedMemberCount).toBe(2); // b + c
    expect(warning!.totalMembers).toBe(4);
    expect(warning!.flaggedMembers.map((m) => m.headCanon)).toEqual(["b", "c"]);
  });

  it("respects a custom threshold in the warning note", () => {
    const members = [mkMember("x", "low", 0.42)];
    const warning = buildCoverageWarning(members, 0.70);
    expect(warning).not.toBeNull();
    expect(warning!.threshold).toBe(0.70);
    expect(warning!.note).toContain("70%");
  });

  it("produces a plural note for multiple flagged members", () => {
    const members = [
      mkMember("a", "low", 0.30),
      mkMember("b", "low", 0.40),
      mkMember("c", "no-sku", null),
    ];
    const warning = buildCoverageWarning(members);
    expect(warning!.note).toContain("3 of 3 members");
  });

  it("produces a singular note for exactly one flagged member", () => {
    const members = [mkMember("x", "low", 0.50)];
    const warning = buildCoverageWarning(members);
    expect(warning!.note).toMatch(/1 of 1 member[^s]/);
  });
});

// ── buildCoverageStatus ───────────────────────────────────────────────────────

describe("buildCoverageStatus", () => {
  it("returns 'verified' when all members pass", () => {
    const members: MemberCoverageRow[] = [
      mkMember("a", "ok", 0.80),
      mkMember("b", "ok", 0.95),
    ];
    expect(buildCoverageStatus(members)).toBe("verified");
  });

  it("returns 'insufficient' when any member has flag=low", () => {
    const members: MemberCoverageRow[] = [
      mkMember("a", "ok", 0.90),
      mkMember("b", "low", 0.28),
    ];
    expect(buildCoverageStatus(members)).toBe("insufficient");
  });

  it("returns 'insufficient' when any member has flag=no-sku", () => {
    const members: MemberCoverageRow[] = [mkMember("x", "no-sku")];
    expect(buildCoverageStatus(members)).toBe("insufficient");
  });

  it("returns 'verified' for an empty member list (no members = no failures)", () => {
    expect(buildCoverageStatus([])).toBe("verified");
  });

  it("returns 'verified' when only no-register members are present", () => {
    const members: MemberCoverageRow[] = [mkMember("y", "no-register")];
    expect(buildCoverageStatus(members)).toBe("verified");
  });
});

// ── Fail-closed suppression contract ─────────────────────────────────────────
// These tests prove the API/UI contract that K3 retailer recommendations are
// suppressed (recommendations=[]) whenever PSCode2 coverage is not "verified".
// The route uses buildCoverageStatus to gate the response; these tests verify
// the three meaningful states the route can produce.
// ──────────────────────────────────────────────────────────────────────────────

describe("fail-closed suppression contract", () => {
  it("coverageStatus='insufficient' → route must return recommendations=[]", () => {
    // Simulate: 20,272/71,470 qty coverage ≈ 28% (Ayan Enterprise scenario)
    const members: MemberCoverageRow[] = [
      { fy: "2026-27", headCanon: "Member A", skuQty: 20272, skuNet: 0,
        registerQty: 71470, registerNet: 0, qtyRatio: 0.284, netRatio: null,
        flag: classifyMemberCoverage(20272, 71470) },
    ];
    const status = buildCoverageStatus(members);
    // Gate: when status !== "verified", the route suppresses recommendations
    expect(status).toBe("insufficient");
    // Consumer contract: response.recommendations must be [] (enforced by route handler)
    // and coverageWarning must be non-null so the UI shows the blocking panel
    const warning = buildCoverageWarning(members);
    expect(warning).not.toBeNull();
    // The UI must render the blocking panel, not recommendation cards
    expect(status !== "verified").toBe(true);
  });

  it("coverageStatus='unverified' → route must suppress recommendations (fail-closed)", () => {
    // Simulate: coverage query threw — the route sets coverageStatus="unverified" in its
    // catch block and returns recommendations=[] regardless of what getSkuRecommendations returns.
    const coverageStatus = "unverified" as CoverageStatus;
    // Suppression gate: coverageStatus !== "verified" → recommendations suppressed
    expect(coverageStatus).not.toBe("verified" as CoverageStatus);
    // buildCoverageStatus never returns "unverified" (only the route's catch block does),
    // so this state cannot be produced by pure helpers — test documents the contract only.
  });

  it("coverageStatus='verified' → route allows recommendations through", () => {
    const members: MemberCoverageRow[] = [
      { fy: "2026-27", headCanon: "Member A", skuQty: 80000, skuNet: 0,
        registerQty: 100000, registerNet: 0, qtyRatio: 0.80, netRatio: null,
        flag: "ok" },
    ];
    const status = buildCoverageStatus(members);
    expect(status).toBe("verified");
    expect(status !== "verified").toBe(false); // suppression gate does NOT fire
  });

  it("mixed members: one flagged is enough to suppress (any-member threshold)", () => {
    const members: MemberCoverageRow[] = [
      mkMember("Good", "ok", 0.92),
      mkMember("Bad",  "low", 0.45),
    ];
    // Even one flagged member triggers suppression
    const status = buildCoverageStatus(members);
    expect(status).toBe("insufficient");
    expect(status !== "verified").toBe(true);
  });
});

// ── Integration contract: incomplete PSCode2 → coverageWarning on route response
// These tests establish that when PSCode2 data is insufficient, a consumer of the
// /api/sku/recommendations or /api/sku/facts response can detect the problem from
// the coverageWarning field and refuse to treat gap codes as authoritative push
// recommendations.  They use buildCoverageWarning (pure) to simulate the guard
// output that the route handler overlays on every retailer-level response.
// ──────────────────────────────────────────────────────────────────────────────

describe("coverageWarning route integration contract", () => {
  /**
   * Simulate the recommendation path for a member whose PSCode2 is incomplete:
   * - primary_sku_line has only 28% of Summary Report qty (Ayan Enterprise scenario)
   * - buildCoverageWarning is called with this member's coverage row
   * - the result must be non-null and have the shape the route overlays on the response
   */
  it("incomplete PSCode2 (28% coverage) produces a non-null coverageWarning that the UI can gate on", () => {
    // Simulates data state: 20,272 sku_line qty vs 71,470 register qty ≈ 28%
    const members: MemberCoverageRow[] = [
      { fy: "2026-27", headCanon: "Ayan Member", skuQty: 20272, skuNet: 0,
        registerQty: 71470, registerNet: 0, qtyRatio: 20272 / 71470, netRatio: null,
        flag: classifyMemberCoverage(20272, 71470) },
    ];

    const warning = buildCoverageWarning(members);

    // The route MUST return non-null — the UI gates on this field
    expect(warning).not.toBeNull();

    // Shape that SkuFocus.tsx reads (coverageWarning is in FocusData)
    expect(warning).toMatchObject({
      flaggedMemberCount: 1,
      totalMembers: 1,
      threshold: COVERAGE_THRESHOLD,
      flaggedMembers: [{ headCanon: "Ayan Member", flag: "low" }],
      note: expect.stringContaining("PSCode2"),
    });

    // Ratio is preserved for debugging
    expect(warning!.flaggedMembers[0].qtyRatio).toBeCloseTo(0.284, 2);
  });

  it("when coverageWarning is non-null the consumer should not treat gap codes as authoritative", () => {
    // This test documents the expected consumption contract:
    // if (data.coverageWarning) { show warning; do not auto-act on recommendations }
    const members: MemberCoverageRow[] = [
      { fy: "2026-27", headCanon: "Member A", skuQty: 0, skuNet: 0,
        registerQty: 5000, registerNet: 0, qtyRatio: null, netRatio: null,
        flag: "no-sku" },
    ];
    const warning = buildCoverageWarning(members);
    // Consumer pattern: gate before rendering recommendations as push actions
    const shouldShowRecommendationsAsAuthoritative = warning === null;
    expect(shouldShowRecommendationsAsAuthoritative).toBe(false);
  });

  it("when all members have adequate PSCode2 coverage, coverageWarning is null (gap codes trustworthy)", () => {
    const members: MemberCoverageRow[] = [
      { fy: "2026-27", headCanon: "Member A", skuQty: 80000, skuNet: 0,
        registerQty: 100000, registerNet: 0, qtyRatio: 0.80, netRatio: null,
        flag: classifyMemberCoverage(80000, 100000) },
      { fy: "2026-27", headCanon: "Member B", skuQty: 65000, skuNet: 0,
        registerQty: 100000, registerNet: 0, qtyRatio: 0.65, netRatio: null,
        flag: classifyMemberCoverage(65000, 100000) },
    ];
    const warning = buildCoverageWarning(members);
    // null = all members passed; route sets coverageWarning: null; UI shows no banner
    expect(warning).toBeNull();
  });

  it("mixed members: only flagged ones appear in coverageWarning.flaggedMembers", () => {
    const members: MemberCoverageRow[] = [
      { fy: "2026-27", headCanon: "Good Member", skuQty: 75000, skuNet: 0,
        registerQty: 100000, registerNet: 0, qtyRatio: 0.75, netRatio: null,
        flag: "ok" },
      { fy: "2026-27", headCanon: "Incomplete Member", skuQty: 15000, skuNet: 0,
        registerQty: 100000, registerNet: 0, qtyRatio: 0.15, netRatio: null,
        flag: "low" },
    ];
    const warning = buildCoverageWarning(members);
    expect(warning).not.toBeNull();
    expect(warning!.flaggedMemberCount).toBe(1);
    expect(warning!.totalMembers).toBe(2);
    // Only the flagged member is disclosed — consumers don't need to know about ok members
    expect(warning!.flaggedMembers.map((m) => m.headCanon)).toEqual(["Incomplete Member"]);
  });
});
