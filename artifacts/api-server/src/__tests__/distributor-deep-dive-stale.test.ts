// Stale-snapshot fallback for GET /api/mgmt/distributor-deep-dive.
//
// Member-sheet Sheets failures never throw (loadMemberSheet catches, and
// Promise.allSettled absorbs the rest) — they surface as a 200 payload with
// membersFailed > 0. These tests cover both transient paths:
//   1. degraded 200 payload (all or some member sheets failed)
//   2. hard throw from the build (Data-tab read failed)
// and the persistence rule: only a complete load may replace the snapshot.
import { describe, it, expect, vi } from "vitest";
import {
  isCompleteLoad,
  isDegradedLoad,
  loadDistributorDeepDiveResilientWith,
  type ResilientDeps,
  type DistributorDeepDiveResult,
} from "../lib/mgmt/distributorDeepDive.js";

function makeResult(over: Partial<DistributorDeepDiveResult> = {}): DistributorDeepDiveResult {
  return {
    fy: "2026-27",
    stateHeads: ["Anant Singh"],
    distributors: [],
    sharedRetailers: [],
    directDealer: null,
    noneAssigned: null,
    mappingQuality: null,
    partyObTotal: 0,
    membersLoaded: 8,
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
    ...over,
  };
}

function makeDeps(over: Partial<ResilientDeps> = {}): ResilientDeps {
  return {
    build: vi.fn(async () => makeResult()),
    loadSnap: vi.fn(async () => null),
    saveSnap: vi.fn(async () => undefined),
    now: () => 1_000_000,
    sleep: vi.fn(async () => undefined),
    staleMap: new Map(),
    ...over,
  };
}

describe("load classification", () => {
  it("complete: no failures, members loaded, no error", () => {
    const r = makeResult();
    expect(isCompleteLoad(r)).toBe(true);
    expect(isDegradedLoad(r)).toBe(false);
  });

  it("degraded: partial member-sheet failures", () => {
    const r = makeResult({ membersLoaded: 5, membersFailed: 3 });
    expect(isCompleteLoad(r)).toBe(false);
    expect(isDegradedLoad(r)).toBe(true);
  });

  it("degraded: all member sheets failed (error payload, still a 200)", () => {
    const r = makeResult({
      membersLoaded: 0,
      membersFailed: 8,
      error: "No working sheets could be loaded for this state head.",
    });
    expect(isCompleteLoad(r)).toBe(false);
    expect(isDegradedLoad(r)).toBe(true);
  });

  it("not degraded: nothing mapped yet (no failures, no error)", () => {
    const r = makeResult({ membersLoaded: 0, membersNotMapped: 8 });
    expect(isCompleteLoad(r)).toBe(false);
    expect(isDegradedLoad(r)).toBe(false);
  });
});

describe("loadDistributorDeepDiveResilientWith", () => {
  it("complete load: returned as-is and persisted to the snapshot", async () => {
    const deps = makeDeps();
    const out = await loadDistributorDeepDiveResilientWith("2026-27", "Anant Singh", deps);
    expect(out.stale).toBeUndefined();
    expect(deps.saveSnap).toHaveBeenCalledTimes(1);
  });

  it("all member sheets failed: serves the saved snapshot with stale=true", async () => {
    const snap = makeResult({ partyObTotal: 123 });
    const deps = makeDeps({
      build: vi.fn(async () =>
        makeResult({ membersLoaded: 0, membersFailed: 8, error: "No working sheets could be loaded for this state head." }),
      ),
      loadSnap: vi.fn(async () => snap),
    });
    const out = await loadDistributorDeepDiveResilientWith("2026-27", "Anant Singh", deps);
    expect(out.stale).toBe(true);
    expect(out.partyObTotal).toBe(123);
    expect(out.error).toBeNull();
    expect(deps.saveSnap).not.toHaveBeenCalled();
  });

  it("partial member-sheet failure: serves snapshot, never persists the partial payload", async () => {
    const snap = makeResult({ partyObTotal: 456 });
    const deps = makeDeps({
      build: vi.fn(async () => makeResult({ membersLoaded: 5, membersFailed: 3, partyObTotal: 99 })),
      loadSnap: vi.fn(async () => snap),
    });
    const out = await loadDistributorDeepDiveResilientWith("2026-27", "Anant Singh", deps);
    expect(out.stale).toBe(true);
    expect(out.partyObTotal).toBe(456); // last known-good, not the partial 99
    expect(deps.saveSnap).not.toHaveBeenCalled();
  });

  it("degraded with no snapshot: serves the partial live payload rather than nothing", async () => {
    const partial = makeResult({ membersLoaded: 5, membersFailed: 3, partyObTotal: 99 });
    const deps = makeDeps({ build: vi.fn(async () => partial) });
    const out = await loadDistributorDeepDiveResilientWith("2026-27", "Anant Singh", deps);
    expect(out).toBe(partial);
    expect(deps.saveSnap).not.toHaveBeenCalled();
  });

  it("build throws: serves the saved snapshot with stale=true", async () => {
    const snap = makeResult({ partyObTotal: 777 });
    const deps = makeDeps({
      build: vi.fn(async () => { throw new Error("Sheets 429"); }),
      loadSnap: vi.fn(async () => snap),
    });
    const out = await loadDistributorDeepDiveResilientWith("2026-27", "Anant Singh", deps);
    expect(out.stale).toBe(true);
    expect(out.partyObTotal).toBe(777);
  });

  it("build throws with no snapshot: retries the live build once", async () => {
    const good = makeResult();
    const build: ResilientDeps["build"] & ReturnType<typeof vi.fn> = vi
      .fn()
      .mockRejectedValueOnce(new Error("Sheets 429"))
      .mockResolvedValueOnce(good);
    const deps = makeDeps({ build });
    const out = await loadDistributorDeepDiveResilientWith("2026-27", "Anant Singh", deps);
    expect(out).toBe(good);
    expect(build).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });

  it("stale window: serves the in-memory fallback without re-reading the DB", async () => {
    const snap = makeResult({ partyObTotal: 321 });
    const staleMap: ResilientDeps["staleMap"] = new Map([
      ["dist-deep-dive|2026-27|ANANT SINGH", { payload: snap, until: 2_000_000 }],
    ]);
    const deps = makeDeps({
      build: vi.fn(async () => { throw new Error("Sheets 429"); }),
      staleMap,
    });
    const out = await loadDistributorDeepDiveResilientWith("2026-27", "Anant Singh", deps);
    expect(out.stale).toBe(true);
    expect(out.partyObTotal).toBe(321);
    expect(deps.loadSnap).not.toHaveBeenCalled();
  });
});
