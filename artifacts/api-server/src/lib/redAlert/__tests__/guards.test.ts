// Focused unit tests for Red Alert guard functions.
// Proves three invariants the code reviewer required:
//   T1. An out-of-window channel/head change does NOT suppress a valid alert.
//   T2. An in-window channel change DOES suppress a B3 alert.
//   T3. An in-window distributor reassignment DOES suppress a B3 alert.

import { describe, it, expect } from "vitest";
import { runGuards } from "../guards.js";
import type { RawAlert, DetectionContext, CustomerMetaRow } from "../types.js";

// ── Minimal DetectionContext factory ──────────────────────────────────────────

const ALL_WINDOW_MONTHS_FROZEN = new Map<string, Set<string>>([
  // Make all months in our test windows pass Guard 3 (complete months).
  ["2026-27", new Set(["Apr-26", "May-26", "Jun-26", "Jul-26"])],
  ["2025-26", new Set(["Apr-25", "May-25", "Jun-25", "Mar-26", "Apr-25", "May-25", "Jun-25"])],
  ["2024-25", new Set(["Apr-24", "May-24", "Jun-24"])],
]);

function makeCtx(overrides: {
  customerMeta?: CustomerMetaRow[];
  retailerDistributors?: Map<string, Map<string, Set<string>>>;
  frozenMonths?: Map<string, Set<string>>;
  persons?: DetectionContext["persons"];
  personsByNameKey?: DetectionContext["personsByNameKey"];
  secHeadMonths?: DetectionContext["secHeadMonths"];
} = {}): DetectionContext {
  return {
    pool: null as unknown as DetectionContext["pool"],
    customerSale: [],
    customerMeta: overrides.customerMeta ?? [],
    customerCode: [],
    retailerSale: [],
    retailerSku: [],
    secHeadMonths: overrides.secHeadMonths ?? [],
    mrpHistory: [],
    ambiguousCodes: new Set(),
    marginFact: [],
    persons: overrides.persons ?? [],
    customerMaster: new Map(),
    retailerDistributors: overrides.retailerDistributors ?? new Map(),
    frozenMonths: overrides.frozenMonths ?? ALL_WINDOW_MONTHS_FROZEN,
    secCompleteMonths: new Map(),
    lastSheetRead: new Map(),
    personsByNameKey: overrides.personsByNameKey ?? new Set(),
    retailerPrimaryDist: new Map(),
    distSecMonthly: new Map(),
    headToStateHead: new Map(),
    retailerHeadCanon: new Map(),
  };
}

function makeB3Alert(overrides: Partial<RawAlert> = {}): RawAlert {
  return {
    code: "B3",
    category: "B",
    entity: "Test Retailer",
    entityKey: "TEST_RETAILER",
    entityType: "retailer",
    currentMonths: ["Apr-26", "May-26", "Jun-26"],
    priorMonths:   ["Apr-25", "May-25", "Jun-25"],
    numbers: { currentValue: 0, priorValue: 500_000, valueGrowthPct: -100 },
    rupeesAtStake: 500_000,
    ...overrides,
  };
}

// Helper: assert a guard result failed at a specific guard number.
// Uses TypeScript's discriminated union so .guard and .reason are accessible.
function expectGuard(result: ReturnType<typeof runGuards>, guardNum: number) {
  if (result.pass) throw new Error(`Expected guard ${guardNum} to suppress but result passed`);
  expect(result.pass).toBe(false);
  expect(result.guard).toBe(guardNum);
  return result;
}

// Helper: assert that guard N specifically did NOT fire (other guards may have).
function expectNotGuard(result: ReturnType<typeof runGuards>, guardNum: number) {
  if (!result.pass) {
    expect(result.guard).not.toBe(guardNum);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// T1: Out-of-window channel change does NOT suppress
// ─────────────────────────────────────────────────────────────────────────────
describe("Guard 1 — channel reclassification", () => {
  it("T1: a reclassification OUTSIDE the alert window (Jul-26) does not suppress a B3 on Apr–Jun", () => {
    // Prior window Apr-25..Jun-25 = Territory; current window Apr-26..Jun-26 = Territory.
    // Jul-26 (out of window) is Project. Guard 1 must ignore Jul-26.
    const ctx = makeCtx({
      customerMeta: [
        { fy: "2025-26", monthLabel: "Apr-25", customer: "TEST_RETAILER", channel: "Territory", headCanon: "Head1" },
        { fy: "2025-26", monthLabel: "May-25", customer: "TEST_RETAILER", channel: "Territory", headCanon: "Head1" },
        { fy: "2025-26", monthLabel: "Jun-25", customer: "TEST_RETAILER", channel: "Territory", headCanon: "Head1" },
        { fy: "2026-27", monthLabel: "Apr-26", customer: "TEST_RETAILER", channel: "Territory", headCanon: "Head1" },
        { fy: "2026-27", monthLabel: "May-26", customer: "TEST_RETAILER", channel: "Territory", headCanon: "Head1" },
        { fy: "2026-27", monthLabel: "Jun-26", customer: "TEST_RETAILER", channel: "Territory", headCanon: "Head1" },
        // OUT-OF-WINDOW — must be invisible to Guard 1
        { fy: "2026-27", monthLabel: "Jul-26", customer: "TEST_RETAILER", channel: "Project",   headCanon: "Head1" },
      ],
    });

    const alert = makeB3Alert({
      currentMonths: ["Apr-26", "May-26", "Jun-26"],
      priorMonths:   ["Apr-25", "May-25", "Jun-25"],
    });

    const result = runGuards(alert, ctx, "2026-27", "2025-26", new Date(), 55,
        new Set(alert.currentMonths), new Set(alert.priorMonths));
    expectNotGuard(result, 1);
  });

  it("T2: an in-window channel change (Territory → Project) DOES suppress a B3 alert", () => {
    const ctx = makeCtx({
      customerMeta: [
        { fy: "2025-26", monthLabel: "Apr-25", customer: "TEST_RETAILER", channel: "Territory", headCanon: "Head1" },
        // current window: channel changed to Project
        { fy: "2026-27", monthLabel: "Apr-26", customer: "TEST_RETAILER", channel: "Project",   headCanon: "Head1" },
      ],
    });

    const alert = makeB3Alert({ currentMonths: ["Apr-26"], priorMonths: ["Apr-25"] });
    const result = runGuards(alert, ctx, "2026-27", "2025-26", new Date(), 55,
        new Set(alert.currentMonths), new Set(alert.priorMonths));
    const failed = expectGuard(result, 1);
    expect(failed.reason).toMatch(/channel/i);
  });

  it("T2b: empty current-window rows (moved entirely off territory) suppresses B3 via Guard 1", () => {
    // Prior has Territory rows. Current window has NO rows at all in customerMeta.
    // This represents a customer that was reclassified and no longer appears in sale_line.
    const ctx = makeCtx({
      customerMeta: [
        { fy: "2025-26", monthLabel: "Apr-25", customer: "TEST_RETAILER", channel: "Territory", headCanon: "Head1" },
        // Apr-26: absent from customerMeta — customer vanished from sale_line_current
      ],
    });

    const alert = makeB3Alert({ currentMonths: ["Apr-26"], priorMonths: ["Apr-25"] });
    const result = runGuards(alert, ctx, "2026-27", "2025-26", new Date(), 55,
        new Set(alert.currentMonths), new Set(alert.priorMonths));
    const failed = expectGuard(result, 1);
    expect(failed.reason).toMatch(/channel/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard 4: Identity resolution — name-key fallback
// ─────────────────────────────────────────────────────────────────────────────
describe("Guard 4 — identity resolution", () => {
  function makeA1Alert(entityKey: string): RawAlert {
    return {
      code: "A1",
      category: "A",
      entity: entityKey,
      entityKey,
      entityType: "member",
      currentMonths: ["Apr-26", "May-26"],
      priorMonths:   ["Apr-25", "May-25"],
      numbers: { achievementPct: 40, cumulativeTarget: 1_000_000, cumulativeOb: 400_000 },
      rupeesAtStake: 600_000,
    };
  }

  it("G4-1: exact normKey match passes Guard 4", () => {
    const ctx = makeCtx({
      persons: [{ normKey: "abhijitdas", canonicalName: "Abhijit Das", stateHead: null, isStateHead: false, hrStatus: null, isPerson: true }],
      personsByNameKey: new Set(["abhijitdas"]),
      secHeadMonths: [{ fy: "2026-27", headCanon: "abhijitdas", stateHead: null, monthLabel: "Apr-26", monthIdx: 1, planAmount: 500_000, orderedAmount: 200_000, receivedAmount: null, notYetRecorded: false, isAnomaly: false, ingestedAt: new Date() }],
    });
    const result = runGuards(makeA1Alert("abhijitdas"), ctx, "2026-27", "2025-26", new Date(), 0,
        new Set(["Apr-26","May-26"]), new Set(["Apr-25","May-25"]));
    // Guard 4 should pass; alert may fail later guards (G7, G8, G9) — that's fine
    if (!result.pass) expect(result.guard).not.toBe(4);
  });

  it("G4-2: name-key fallback resolves when normKey is an employee code", () => {
    // Registry stores norm_key="639" (employee code) for "Ashutosh Kumar".
    // head_canon in secondary data is "ashutoshkumar".
    // personsByNameKey should contain "ashutoshkumar" derived from canonical_name.
    const ctx = makeCtx({
      persons: [{ normKey: "639", canonicalName: "Ashutosh Kumar", stateHead: null, isStateHead: false, hrStatus: null, isPerson: true }],
      personsByNameKey: new Set(["ashutoshkumar"]),
      secHeadMonths: [{ fy: "2026-27", headCanon: "ashutoshkumar", stateHead: null, monthLabel: "Apr-26", monthIdx: 1, planAmount: 500_000, orderedAmount: 200_000, receivedAmount: null, notYetRecorded: false, isAnomaly: false, ingestedAt: new Date() }],
    });
    const result = runGuards(makeA1Alert("ashutoshkumar"), ctx, "2026-27", "2025-26", new Date(), 0,
        new Set(["Apr-26","May-26"]), new Set(["Apr-25","May-25"]));
    if (!result.pass) expect(result.guard).not.toBe(4);
  });

  it("G4-3: name-key fallback resolves when normKey is a collision-disambiguation key", () => {
    // Registry stores norm_key="ashutoshkumarrudrapur:anantsingh".
    // head_canon is "ashutoshkumarrudrapur" (base part before ":").
    // personsByNameKey should contain "ashutoshkumarrudrapur".
    const ctx = makeCtx({
      persons: [{ normKey: "ashutoshkumarrudrapur:anantsingh", canonicalName: "Ashutosh Kumar (Rudrapur)", stateHead: null, isStateHead: false, hrStatus: null, isPerson: true }],
      personsByNameKey: new Set(["ashutoshkumarrudrapur"]),
      secHeadMonths: [{ fy: "2026-27", headCanon: "ashutoshkumarrudrapur", stateHead: null, monthLabel: "Apr-26", monthIdx: 1, planAmount: 500_000, orderedAmount: 200_000, receivedAmount: null, notYetRecorded: false, isAnomaly: false, ingestedAt: new Date() }],
    });
    const result = runGuards(makeA1Alert("ashutoshkumarrudrapur"), ctx, "2026-27", "2025-26", new Date(), 0,
        new Set(["Apr-26","May-26"]), new Set(["Apr-25","May-25"]));
    if (!result.pass) expect(result.guard).not.toBe(4);
  });

  it("G4-4: Guard 4 suppresses when entityKey is absent from both persons and personsByNameKey", () => {
    const ctx = makeCtx({
      persons: [],
      personsByNameKey: new Set(),
    });
    const result = runGuards(makeA1Alert("unknownmember"), ctx, "2026-27", "2025-26", new Date(), 0,
        new Set(["Apr-26","May-26"]), new Set(["Apr-25","May-25"]));
    expectGuard(result, 4);
  });

  it("G4-5: is_person=false exact match suppresses even when normKey matches", () => {
    const ctx = makeCtx({
      persons: [{ normKey: "stateheadkey", canonicalName: "State Head Name", stateHead: null, isStateHead: true, hrStatus: null, isPerson: false }],
      personsByNameKey: new Set(),
    });
    const result = runGuards(makeA1Alert("stateheadkey"), ctx, "2026-27", "2025-26", new Date(), 0,
        new Set(["Apr-26","May-26"]), new Set(["Apr-25","May-25"]));
    expectGuard(result, 4);
  });

  it("G4-6: A3 alerts bypass Guard 4 entirely (team-level alert, not a person key)", () => {
    const ctx = makeCtx({ persons: [], personsByNameKey: new Set() });
    const a3: RawAlert = {
      code: "A3", category: "A", entity: "State Head", entityKey: "stateheadkey",
      entityType: "team", currentMonths: ["Apr-26", "May-26"], priorMonths: ["Apr-25", "May-25"],
      numbers: { achievementPct: 50, teamMemberCount: 5 }, rupeesAtStake: 2_000_000,
    };
    const result = runGuards(a3, ctx, "2026-27", "2025-26", new Date(), 0,
        new Set(["Apr-26","May-26"]), new Set(["Apr-25","May-25"]));
    if (!result.pass) expect(result.guard).not.toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3: In-window distributor reassignment suppresses B3
// ─────────────────────────────────────────────────────────────────────────────
describe("Guard 5 — distributor reassignment", () => {
  // For G5 tests, disable G1 by providing matching channels in both windows.
  function makeCtxG5(retailerDistributors: Map<string, Map<string, Set<string>>>): DetectionContext {
    return makeCtx({
      customerMeta: [
        { fy: "2025-26", monthLabel: "Apr-25", customer: "TEST_RETAILER", channel: "Territory", headCanon: "H" },
        { fy: "2026-27", monthLabel: "Apr-26", customer: "TEST_RETAILER", channel: "Territory", headCanon: "H" },
      ],
      retailerDistributors,
    });
  }

  function distMap(entries: Array<[string, string[]]>): Map<string, Map<string, Set<string>>> {
    const outer = new Map<string, Map<string, Set<string>>>();
    const inner = new Map<string, Set<string>>();
    for (const [key, dists] of entries) inner.set(key, new Set(dists));
    outer.set("TEST_RETAILER", inner);
    return outer;
  }

  it("T3: an in-window distributor change DOES suppress a B3 alert", () => {
    const ctx = makeCtxG5(distMap([
      ["2025-26|Apr-25", ["DistA"]],
      ["2026-27|Apr-26", ["DistB"]],  // ← different distributor in window
    ]));

    const alert = makeB3Alert({ currentMonths: ["Apr-26"], priorMonths: ["Apr-25"] });
    const result = runGuards(alert, ctx, "2026-27", "2025-26", new Date(), 55,
        new Set(alert.currentMonths), new Set(alert.priorMonths));
    const failed = expectGuard(result, 5);
    expect(failed.reason).toMatch(/different distributor/i);
  });

  it("T3b: same distributor in both windows does NOT suppress via Guard 5", () => {
    const ctx = makeCtxG5(distMap([
      ["2025-26|Apr-25", ["DistA"]],
      ["2026-27|Apr-26", ["DistA"]],  // ← same
    ]));

    const alert = makeB3Alert({ currentMonths: ["Apr-26"], priorMonths: ["Apr-25"] });
    const result = runGuards(alert, ctx, "2026-27", "2025-26", new Date(), 55,
        new Set(alert.currentMonths), new Set(alert.priorMonths));
    expectNotGuard(result, 5);
  });

  it("T3d: absent current-window attribution does NOT suppress B3 (genuine dropout, not redistribution)", () => {
    // Prior window: retailer served by DistA.
    // Current window: NO distributor rows at all → genuine dropout signal.
    // Guard 5 (case b removed) must NOT suppress this.
    const ctx = makeCtxG5(distMap([
      ["2025-26|Apr-25", ["DistA"]],
      // current window Apr-26 has NO distributor attribution
    ]));

    const alert = makeB3Alert({ currentMonths: ["Apr-26"], priorMonths: ["Apr-25"] });
    const result = runGuards(alert, ctx, "2026-27", "2025-26", new Date(), 55,
        new Set(alert.currentMonths), new Set(alert.priorMonths));
    expectNotGuard(result, 5);
  });

  it("T3c: an out-of-window distributor change (Jul-26) does NOT suppress a B3 on Apr-26", () => {
    const ctx = makeCtxG5(distMap([
      ["2025-26|Apr-25", ["DistA"]],
      ["2026-27|Apr-26", ["DistA"]],   // in-window: same
      ["2026-27|Jul-26", ["DistB"]],   // out-of-window: different — must be invisible
    ]));

    const alert = makeB3Alert({
      currentMonths: ["Apr-26"],  // Jul-26 NOT in the window
      priorMonths:   ["Apr-25"],
    });
    const result = runGuards(alert, ctx, "2026-27", "2025-26", new Date(), 55,
        new Set(alert.currentMonths), new Set(alert.priorMonths));
    expectNotGuard(result, 5);
  });
});
