import { DEFAULT_FY, PeriodMode, FiscalMonthIdx, lastCompleteFiscalMonthIdx } from "./global-filter-context";

export type CodecState = { fy: string; periodMode: PeriodMode; monthIdx: FiscalMonthIdx; rangeFrom: FiscalMonthIdx; rangeTo: FiscalMonthIdx };

export function statesEqual(a: CodecState, b: CodecState): boolean {
  return a.fy === b.fy &&
    a.periodMode === b.periodMode &&
    a.monthIdx === b.monthIdx &&
    a.rangeFrom === b.rangeFrom &&
    a.rangeTo === b.rangeTo;
}

/**
 * Pure codec for hydration: reads values from URLSearchParams with fallbacks.
 */
export function hydrateGlobalFilterFromUrl(searchParams: URLSearchParams): CodecState {
  const fy = searchParams.get("fy") || DEFAULT_FY;
  const periodMode = (searchParams.get("period") as PeriodMode) || "ytd";
  const monthIdx = searchParams.has("month")
    ? parseInt(searchParams.get("month")!, 10) as FiscalMonthIdx
    : lastCompleteFiscalMonthIdx(fy);
  const rangeFrom = searchParams.has("rangeFrom")
    ? parseInt(searchParams.get("rangeFrom")!, 10) as FiscalMonthIdx
    : 0 as FiscalMonthIdx;
  const rangeTo = searchParams.has("rangeTo")
    ? parseInt(searchParams.get("rangeTo")!, 10) as FiscalMonthIdx
    : 2 as FiscalMonthIdx;

  return { fy, periodMode, monthIdx, rangeFrom, rangeTo };
}

/**
 * Pure codec for serialization: mutates URLSearchParams with the active state,
 * returning true if modifications were made.
 */
export function serializeGlobalFilterToUrl(searchParams: URLSearchParams, state: CodecState): boolean {
  let changed = false;

  const setParam = (key: string, val: string) => {
    if (searchParams.get(key) !== val) {
      searchParams.set(key, val);
      changed = true;
    }
  };
  const delParam = (key: string) => {
    if (searchParams.has(key)) {
      searchParams.delete(key);
      changed = true;
    }
  };

  setParam("fy", state.fy);
  setParam("period", state.periodMode);

  if (state.periodMode === "month") setParam("month", state.monthIdx.toString());
  else delParam("month");

  if (state.periodMode === "custom") {
    setParam("rangeFrom", state.rangeFrom.toString());
    setParam("rangeTo", state.rangeTo.toString());
  } else {
    delParam("rangeFrom");
    delParam("rangeTo");
  }

  return changed;
}

/**
 * Provenance state machine helper to break React effect loops during bidirectional URL sync.
 */
export class HydrationLock {
  private pending: CodecState | null = null;

  setPending(state: CodecState, currentState?: CodecState) {
    if (currentState && statesEqual(state, currentState)) {
      return;
    }
    this.pending = { ...state };
  }

  /**
   * Returns true if a context->URL sync should be skipped because we are currently
   * hydrating from the URL. Automatically clears the lock when the target state is reached.
   */
  shouldBlockSync(currentState: CodecState): boolean {
    if (!this.pending) return false;

    if (statesEqual(this.pending, currentState)) {
      this.pending = null; // Reached target, unlock
      return true; // Block this specific sync (it's what we just read from the URL)
    }

    return true; // Still trying to reach target (intermediate renders), block sync
  }
}
