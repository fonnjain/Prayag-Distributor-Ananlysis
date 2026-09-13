import { describe, it, expect } from "vitest";
import { reportReducer, deriveReportLayout, ReportState } from "../SalesPersonReportLogic";

// A dummy report type for testing
type DummyReport = { id: string };

describe("SalesPersonReportLogic", () => {
  const initialState: ReportState<DummyReport> = {
    fy: "2024",
    memberKey: "M1",
    isCollapsed: true,
    report: null,
    loading: false,
    error: null,
    activeRequestId: null,
  };

  it("starts with expected default layout", () => {
    const layout = deriveReportLayout(initialState);
    expect(layout.showPreGenActions).toBe(true);
    expect(layout.showPostGenHeader).toBe(false);
    expect(layout.showGuardBadge).toBe(false);
    expect(layout.showNarrative).toBe(false);
  });

  it("toggles the collapsed state", () => {
    const toggled = reportReducer(initialState, { type: "TOGGLE_COLLAPSE" });
    expect(toggled.isCollapsed).toBe(false);
  });

  it("clears state and invalidates requests on identity change", () => {
    const activeState: ReportState<DummyReport> = {
      fy: "2024",
      memberKey: "M1",
      isCollapsed: false,
      report: { id: "rep1" },
      loading: false,
      error: "Some error",
      activeRequestId: 123,
    };

    const nextState = reportReducer(activeState, {
      type: "SET_PROPS",
      fy: "2024",
      memberKey: "M2", // Identity change
    });

    expect(nextState.fy).toBe("2024");
    expect(nextState.memberKey).toBe("M2");
    expect(nextState.isCollapsed).toBe(true);
    expect(nextState.report).toBeNull();
    expect(nextState.error).toBeNull();
    expect(nextState.loading).toBe(false);
    expect(nextState.activeRequestId).toBeNull();
  });

  it("preserves state if identity does not change", () => {
    const activeState: ReportState<DummyReport> = {
      fy: "2024",
      memberKey: "M1",
      isCollapsed: false,
      report: { id: "rep1" },
      loading: false,
      error: null,
      activeRequestId: 123,
    };

    const nextState = reportReducer(activeState, {
      type: "SET_PROPS",
      fy: "2024",
      memberKey: "M1", // No change
    });

    // Exactly the same state
    expect(nextState).toBe(activeState);
    expect(nextState.isCollapsed).toBe(false);
    expect(nextState.report).not.toBeNull();
  });

  it("accepts a success payload if the request ID matches", () => {
    let state = reportReducer(initialState, { type: "GENERATE_START", requestId: 42 });
    expect(state.loading).toBe(true);
    expect(state.activeRequestId).toBe(42);

    state = reportReducer(state, { type: "GENERATE_SUCCESS", requestId: 42, report: { id: "rep2" } });
    expect(state.loading).toBe(false);
    expect(state.report).toEqual({ id: "rep2" });
    
    // Layout validates successful render
    const layout = deriveReportLayout(state);
    expect(layout.showPreGenActions).toBe(false);
    expect(layout.showPostGenHeader).toBe(true);
    expect(layout.showGuardBadge).toBe(true);
    expect(layout.showNarrative).toBe(false); // Collapsed by default
  });

  it("rejects a success payload if the request ID does not match", () => {
    let state = reportReducer(initialState, { type: "GENERATE_START", requestId: 42 });
    
    // User quickly navigates away or switches identity
    state = reportReducer(state, { type: "SET_PROPS", fy: "2024", memberKey: "M2" });
    
    // The fetch for M1 resolves
    state = reportReducer(state, { type: "GENERATE_SUCCESS", requestId: 42, report: { id: "repM1" } });
    
    expect(state.report).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("rejects an error payload if the request ID does not match", () => {
    let state = reportReducer(initialState, { type: "GENERATE_START", requestId: 100 });
    
    // User quickly clicked regenerate
    state = reportReducer(state, { type: "GENERATE_START", requestId: 101 });
    
    // The first fetch fails
    state = reportReducer(state, { type: "GENERATE_ERROR", requestId: 100, error: "Network Error" });
    
    expect(state.error).toBeNull();
    expect(state.loading).toBe(true); // Still waiting for 101
  });
});
