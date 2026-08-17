// Guard: distributors[].distKey from the real loadDistributorDirectory payload
// must be normDistKey-idempotent and must NOT be normSecKey-idempotent.
//
// WHAT THIS PROTECTS
// ──────────────────
// In distributorDirectory.ts, distKey is assigned as:
//
//   acc = { name: d.name, distKey: d.normKey, ... }
//
// where d.normKey is the normDistKey(name) value produced by distributorDeepDive.ts.
// A future refactor that accidentally changed this to normSecKey(d.name) or even
// d.name.toLowerCase() would:
//   1. Make distKey lowercase — resolveTabScope in the guard script uses it as
//      a lookup key against the UPPERCASE normDistKey family, so it would throw
//      and silently downgrade live distributor-tab checks to SKIP.
//   2. Break the identity-key-norm-guard-check.mjs idempotency check once real
//      data is present, but only AFTER a network fetch.
//
// This test catches that regression at build time, with no Sheets/network
// dependency, by exercising the real buildDirectory code path with mocked
// upstream data.
//
// HOW THE MOCK WORKS
// ──────────────────
// loadDistributorDirectory (NOT mocked) → buildDirectory (real) →
//   loadDistDdSnapshotOnly (mocked → null) →
//   loadDistributorDeepDiveResilient (mocked → controlled fixture)
// loadRoster (mocked → one-member roster so headNames drives one iteration)
//
// Each describe block uses a unique FY key to prevent the module-level cache
// inside loadDistributorDirectory from leaking between tests.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks before any real imports.
vi.mock("./distributorDeepDive.js", async (importActual) => {
  const actual = await importActual<typeof import("./distributorDeepDive.js")>();
  return {
    ...actual,
    loadDistDdSnapshotOnly: vi.fn(),
    loadDistributorDeepDiveResilient: vi.fn(),
  };
});

vi.mock("./roster.js", () => ({
  loadRoster: vi.fn(),
}));

// Real implementations (not mocked):
import { loadDistributorDirectory } from "./distributorDirectory.js";
import { normDistKey } from "./distributorDeepDive.js";
import { normSecKey } from "./names.js";

// Mocked dependencies (resolved after hoisting):
import {
  loadDistDdSnapshotOnly,
  loadDistributorDeepDiveResilient,
} from "./distributorDeepDive.js";
import { loadRoster } from "./roster.js";

// ─── Fixture distributor pairs (raw display name → expected canonical normKey) ─
// name:    raw display name as the deep-dive payload would carry it (mixed case,
//          may contain variant tokens not yet normalised)
// normKey: normDistKey(name) — the canonical key the directory must emit as distKey
//
// Using distinct name/normKey values proves that buildDirectory copies d.normKey
// (canonical) into distKey, NOT d.name (raw).  If someone accidentally changed
// `distKey: d.normKey` to `distKey: d.name`, the normDistKey-idempotency
// assertion in the test below would catch it immediately.
const FIXTURE_PAIRS: Array<{ name: string; normKey: string }> = [
  { name: "Anand Sanitaryware",        normKey: "ANAND SANITARYWARE" },       // lowercase → upper
  { name: "Singh Traders & Sons",       normKey: "SINGH TRADE SONS" },         // TRADERS→TRADE, & stripped
  { name: "Mehta Enterprises Pvt Ltd",  normKey: "MEHTA ENTERPRISE PVTLTD" }, // ENTERPRISES→ENTERPRISE, PVT LTD→PVTLTD
  { name: "ABC Industries Pvt. Ltd.",   normKey: "ABC INDUSTRY PVTLTD" },      // INDUSTRIES→INDUSTRY
];

// Minimal DistributorDeepDiveResult — only fields read by buildDirectory.
function makeFixtureResult(pairs: typeof FIXTURE_PAIRS) {
  return {
    fy: "1800-01",
    stateHeads: ["TEST STATE HEAD"],
    distributors: pairs.map(({ name, normKey }, i) => ({
      name,
      normKey,                // ← the field that becomes distKey in the directory
      retailerCount: 1,
      activeCount: 1,
      dormantCount: 0,
      orderBooking: 1000 * (i + 1),
      sale: 900 * (i + 1),
      visits: null,
      obSharePct: null,
      isConcentrationRisk: false,
      confirmedCount: 1,
      guessedCount: 0,
      retailers: [],           // empty → skip member-state resolution
      flows: null,
    })),
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
    perMember: [],
    unassignedCorrelation: null,
    namingCandidates: [],
    error: null,
    stale: false,
  };
}

// Minimal roster — one member under "TEST STATE HEAD".
function makeFixtureRoster() {
  return {
    members: [
      {
        name: "Test Member",
        normKey: normSecKey("Test Member"),
        stateHead: "TEST STATE HEAD",
        state: "DELHI",
        workingState: "",
        headquarter: "",
        dojSerial: null,
        contactNumber: "",
        weekOff: "",
        marketHours: "",
        monthlyCtc: null,
        leftDateSerial: null,
        activeLeft: "",
        channel: "",
        empCode: null,
        designation: null,
      },
    ],
    source: "hr_roster" as const,
    loadedAt: Date.now(),
    unmatchedFromCsv: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("loadDistributorDirectory — distKey is normDistKey-idempotent in the real payload", () => {
  beforeEach(() => {
    // null → buildDirectory falls back to the live resilient loader
    vi.mocked(loadDistDdSnapshotOnly).mockResolvedValue(null);
    vi.mocked(loadDistributorDeepDiveResilient).mockResolvedValue(
      makeFixtureResult(FIXTURE_PAIRS) as any,
    );
    vi.mocked(loadRoster).mockResolvedValue(makeFixtureRoster() as any);
  });

  it("every distributors[].distKey equals the canonical normKey, not the raw display name", async () => {
    // The fixture has name ≠ normKey (e.g. "Singh Traders & Sons" vs "SINGH TRADE SONS").
    // buildDirectory must copy d.normKey into distKey, not d.name.
    // If someone changes `distKey: d.normKey` to `distKey: d.name`, this test
    // fails because the raw names contain lowercase letters / variant tokens.
    const dir = await loadDistributorDirectory("1800-dir-A");
    expect(dir.distributors.length).toBeGreaterThan(0);
    const byNormKey = new Map(FIXTURE_PAIRS.map((p) => [p.normKey, p]));
    for (const d of dir.distributors) {
      const pair = byNormKey.get(d.distKey);
      expect(pair).toBeDefined(); // distKey must be a known canonical key
      // The raw name must differ from distKey so this check is non-trivial:
      expect(d.distKey).not.toBe(pair!.name);
    }
  });

  it("every distributors[].distKey in the real buildDirectory output is normDistKey-idempotent", async () => {
    // Each distKey must survive a round-trip through normDistKey unchanged.
    // This fails if someone accidentally lowercases or applies normSecKey to
    // d.normKey before assigning it to distKey.
    const dir = await loadDistributorDirectory("1800-dir-B");
    expect(dir.distributors.length).toBeGreaterThan(0);
    for (const d of dir.distributors) {
      expect(normDistKey(d.distKey)).toBe(d.distKey);
    }
  });

  it("no distributors[].distKey in the real buildDirectory output is normSecKey-idempotent", async () => {
    // A normDistKey value (UPPERCASE + spaces) can never survive normSecKey
    // unchanged: normSecKey lowercases and strips all non-alphanumerics.
    // If distKey were accidentally produced via normSecKey it would collapse to
    // lowercase-no-spaces, which IS normSecKey-idempotent — this test catches
    // that crossover.
    const dir = await loadDistributorDirectory("1800-dir-C");
    expect(dir.distributors.length).toBeGreaterThan(0);
    for (const d of dir.distributors) {
      expect(normSecKey(d.distKey)).not.toBe(d.distKey);
    }
  });
});

describe("loadDistributorDirectory — regression: wrong-family distKey values would fail idempotency", () => {
  it("normSecKey(normKey) fails normDistKey idempotency for every fixture canonical key", () => {
    // Simulate the accidental regression: distKey is assigned normSecKey(name)
    // instead of d.normKey.  The accidental value (lowercase, no spaces) fails
    // normDistKey idempotency because normDistKey uppercases it.
    for (const { normKey } of FIXTURE_PAIRS) {
      const accidental = normSecKey(normKey); // e.g. "ANAND SANITARYWARE" → "anandsanitaryware"
      // Fails normDistKey idempotency — normDistKey uppercases it back:
      expect(normDistKey(accidental)).not.toBe(accidental);
      // And is normSecKey-idempotent (confirming it crossed into the wrong family):
      expect(normSecKey(accidental)).toBe(accidental);
    }
  });

  it("using the raw display name as distKey also fails normDistKey idempotency", () => {
    // Simulate the bug: `distKey: d.name` instead of `distKey: d.normKey`.
    // The raw name (mixed case, may have punctuation) is not normDistKey-idempotent.
    for (const { name, normKey } of FIXTURE_PAIRS) {
      // The fixture deliberately uses mixed-case raw names:
      expect(name).not.toBe(normKey);
      // normDistKey on the raw name produces the canonical key (not the raw name):
      expect(normDistKey(name)).toBe(normKey);
      expect(normDistKey(name)).not.toBe(name);
    }
  });
});
