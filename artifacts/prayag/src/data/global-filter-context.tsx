// Global date filter context — shared FY + period selection across all pages.
// Components subscribe with useGlobalFilter(); the filter bar is in GlobalFilterBar.tsx.
import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PeriodMode = "ytd" | "month" | "last7" | "today";
/** 0 = Apr, 1 = May, … 11 = Mar */
export type FiscalMonthIdx = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export const FISCAL_MONTH_NAMES = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
] as const;

const DEFAULT_FY = "2026-27";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Calendar month → fiscal index (0=Apr … 11=Mar) for a given FY start year. */
function calMonthToFiscalIdx(calMonth: number /* 0=Jan */): FiscalMonthIdx {
  return ((calMonth - 3 + 12) % 12) as FiscalMonthIdx;
}

/** Return the fiscal index of the currently in-progress calendar month. */
export function currentFiscalMonthIdx(fy: string): FiscalMonthIdx {
  const now = new Date();
  return calMonthToFiscalIdx(now.getMonth());
}

/** Return the fiscal index of the last *completed* calendar month for the given FY.
 *  For the first month of the FY before it starts, returns 0. */
export function lastCompleteFiscalMonthIdx(fy: string): FiscalMonthIdx {
  const now = new Date();
  const fyStart = parseInt(fy.split("-")[0], 10);
  if (isNaN(fyStart)) return 2;

  // Previous calendar month
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevCalYear = prevDate.getFullYear();
  const prevCalMonth = prevDate.getMonth(); // 0=Jan

  // Is prev month within this FY?
  const fyStartCalYear = fyStart;
  const fyEndCalYear = fyStart + 1;
  const inFy =
    (prevCalYear === fyStartCalYear && prevCalMonth >= 3) ||
    (prevCalYear === fyEndCalYear && prevCalMonth <= 2);

  if (!inFy) return 0;
  return calMonthToFiscalIdx(prevCalMonth);
}

/** True if the given fiscal index is still in the future for the given FY. */
export function isFutureFiscalMonth(idx: FiscalMonthIdx, fy: string): boolean {
  const now = new Date();
  const fyStart = parseInt(fy.split("-")[0], 10);
  if (isNaN(fyStart)) return false;
  // Calendar month+year for this fiscal index
  const calMonth = (idx + 3) % 12; // 0=Jan
  const calYear = idx <= 8 ? fyStart : fyStart + 1;
  const startMs = Date.UTC(calYear, calMonth, 1);
  return Date.now() < startMs;
}

/** True if the given fiscal index is the current in-progress month. */
export function isOpenFiscalMonth(idx: FiscalMonthIdx, fy: string): boolean {
  const now = new Date();
  const fyStart = parseInt(fy.split("-")[0], 10);
  if (isNaN(fyStart)) return false;
  const calMonth = (idx + 3) % 12;
  const calYear = idx <= 8 ? fyStart : fyStart + 1;
  return now.getFullYear() === calYear && now.getMonth() === calMonth;
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface GlobalFilterContextValue {
  fy: string;
  setFy: (fy: string) => void;
  periodMode: PeriodMode;
  setPeriodMode: (mode: PeriodMode) => void;
  /** Active fiscal month index (0=Apr…11=Mar). Used when periodMode === "month". */
  monthIdx: FiscalMonthIdx;
  setMonthIdx: (idx: FiscalMonthIdx) => void;
  /** All known FYs — populated by whichever component first fetches /api/mgmt/options. */
  availableFys: string[];
  setAvailableFys: (fys: string[]) => void;
  /** Derived: last complete fiscal month index for current FY. */
  lastCompleteIdx: FiscalMonthIdx;
  /** Derived: current in-progress fiscal month index. */
  currentIdx: FiscalMonthIdx;
  /** Derived: the resolved monthIdx to display/query.
   *  - "month"  → monthIdx
   *  - "ytd"    → lastCompleteIdx (for single-month views that need one month to highlight)
   *  - "last7"  → currentIdx (in-progress month)
   *  - "today"  → currentIdx */
  effectiveMonthIdx: FiscalMonthIdx;
  /** Derived: 1-based period range {from, to} suitable for StateHeadDashboard API calls. */
  effectivePeriod: { from: number; to: number; label: string };
}

const GlobalFilterContext = createContext<GlobalFilterContextValue | null>(null);

export function GlobalFilterProvider({ children }: { children: ReactNode }) {
  const [fy, setFy] = useState(DEFAULT_FY);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("ytd");
  const [monthIdx, setMonthIdx] = useState<FiscalMonthIdx>(() => lastCompleteFiscalMonthIdx(DEFAULT_FY));
  const [availableFys, setAvailableFys] = useState<string[]>([DEFAULT_FY, "2025-26", "2024-25", "2023-24"]);

  // When FY changes, reset monthIdx to last complete month of the new FY.
  useEffect(() => {
    setMonthIdx(lastCompleteFiscalMonthIdx(fy));
  }, [fy]);

  const lastCompleteIdx = useMemo(() => lastCompleteFiscalMonthIdx(fy), [fy]);
  const currentIdx = useMemo(() => currentFiscalMonthIdx(fy), [fy]);

  const effectiveMonthIdx = useMemo<FiscalMonthIdx>(() => {
    if (periodMode === "month") return monthIdx;
    if (periodMode === "ytd") return lastCompleteIdx;
    // last7 / today → current in-progress month
    return currentIdx;
  }, [periodMode, monthIdx, lastCompleteIdx, currentIdx]);

  const effectivePeriod = useMemo(() => {
    if (periodMode === "month") {
      const from = monthIdx + 1;
      return { from, to: from, label: FISCAL_MONTH_NAMES[monthIdx] };
    }
    if (periodMode === "ytd") {
      const to = lastCompleteIdx + 1;
      return { from: 1, to, label: `YTD (Apr–${FISCAL_MONTH_NAMES[lastCompleteIdx]})` };
    }
    // last7 / today → current month
    const from = currentIdx + 1;
    return {
      from,
      to: from,
      label: periodMode === "today" ? "Today" : "Last 7 Days",
    };
  }, [periodMode, monthIdx, lastCompleteIdx, currentIdx]);

  const value: GlobalFilterContextValue = {
    fy, setFy,
    periodMode, setPeriodMode,
    monthIdx, setMonthIdx,
    availableFys, setAvailableFys,
    lastCompleteIdx,
    currentIdx,
    effectiveMonthIdx,
    effectivePeriod,
  };

  return (
    <GlobalFilterContext.Provider value={value}>
      {children}
    </GlobalFilterContext.Provider>
  );
}

export function useGlobalFilter(): GlobalFilterContextValue {
  const ctx = useContext(GlobalFilterContext);
  if (!ctx) throw new Error("useGlobalFilter must be used within a GlobalFilterProvider");
  return ctx;
}
