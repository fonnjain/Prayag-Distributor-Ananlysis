import { describe, it, expect } from "vitest";
import { hydrateGlobalFilterFromUrl, serializeGlobalFilterToUrl, HydrationLock, CodecState, statesEqual } from "../global-filter-codec";

describe("Global Filter Codec", () => {
  it("hydrates from empty URL with defaults", () => {
    const params = new URLSearchParams("");
    const state = hydrateGlobalFilterFromUrl(params);
    expect(state.fy).toBe("2026-27");
    expect(state.periodMode).toBe("ytd");
  });

  it("serializes custom range correctly", () => {
    const params = new URLSearchParams("");
    const changed = serializeGlobalFilterToUrl(params, {
      fy: "2023-24",
      periodMode: "custom",
      monthIdx: 5,
      rangeFrom: 2,
      rangeTo: 8
    });
    expect(changed).toBe(true);
    expect(params.get("fy")).toBe("2023-24");
    expect(params.get("period")).toBe("custom");
    expect(params.get("rangeFrom")).toBe("2");
    expect(params.get("rangeTo")).toBe("8");
    expect(params.has("month")).toBe(false);
  });
});

describe("HydrationLock", () => {
  it("allows sync when not locked", () => {
    const lock = new HydrationLock();
    const state: CodecState = { fy: "2023-24", periodMode: "ytd", monthIdx: 0, rangeFrom: 0, rangeTo: 2 };
    expect(lock.shouldBlockSync(state)).toBe(false);
  });

  it("blocks sync and clears lock when state matches pending", () => {
    const lock = new HydrationLock();
    const state: CodecState = { fy: "2023-24", periodMode: "ytd", monthIdx: 0, rangeFrom: 0, rangeTo: 2 };

    lock.setPending(state);

    // First check matches and clears lock
    expect(lock.shouldBlockSync(state)).toBe(true);

    // Subsequent checks allow sync
    expect(lock.shouldBlockSync(state)).toBe(false);
  });

  it("blocks sync but retains lock on intermediate mismatched state", () => {
    const lock = new HydrationLock();
    const targetState: CodecState = { fy: "2024-25", periodMode: "month", monthIdx: 5, rangeFrom: 0, rangeTo: 2 };
    const intermediateState: CodecState = { fy: "2023-24", periodMode: "month", monthIdx: 5, rangeFrom: 0, rangeTo: 2 };

    lock.setPending(targetState);

    // Check intermediate state, should block sync but keep lock
    expect(lock.shouldBlockSync(intermediateState)).toBe(true);

    // Check target state, should block sync and clear lock
    expect(lock.shouldBlockSync(targetState)).toBe(true);

    // Now unlocked
    expect(lock.shouldBlockSync(targetState)).toBe(false);
  });

  it("drill/Back popstate with unchanged filters, then a real month change must serialize successfully and not remain blocked", () => {
    const lock = new HydrationLock();
    const currentState: CodecState = { fy: "2023-24", periodMode: "ytd", monthIdx: 3, rangeFrom: 0, rangeTo: 2 };

    // popstate with unchanged filters
    const popstateURLState: CodecState = { ...currentState };
    lock.setPending(popstateURLState, currentState);

    // lock should NOT be set because they were identical
    expect(lock.shouldBlockSync(currentState)).toBe(false);

    // Now a real month change happens (e.g. from user interacting with FilterBar)
    const newMonthState: CodecState = { ...currentState, monthIdx: 4 };

    // the sync should NOT be blocked
    expect(lock.shouldBlockSync(newMonthState)).toBe(false);
  });
});

describe("statesEqual", () => {
  it("correctly compares states", () => {
    const a: CodecState = { fy: "2023-24", periodMode: "ytd", monthIdx: 3, rangeFrom: 0, rangeTo: 2 };
    const b: CodecState = { fy: "2023-24", periodMode: "ytd", monthIdx: 3, rangeFrom: 0, rangeTo: 2 };
    const c: CodecState = { fy: "2023-24", periodMode: "month", monthIdx: 3, rangeFrom: 0, rangeTo: 2 };

    expect(statesEqual(a, b)).toBe(true);
    expect(statesEqual(a, c)).toBe(false);
  });
});
