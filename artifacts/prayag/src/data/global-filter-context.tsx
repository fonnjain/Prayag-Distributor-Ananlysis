// Global date filter context — shared FY + period selection across all pages.
// Components subscribe with useGlobalFilter(); the filter bar is in GlobalFilterBar.tsx.
import { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from "react";
import { useLocation } from "wouter";
import { getCapabilityForPath, type PeriodCapability } from "./period-capability";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PeriodMode =
  | "ytd"
  | "month"
  | "q1" | "q2" | "q3" | "q4"
  | "full"
  | "last7"
  | "today"
  | "custom";

/** 0 = Apr, 1 = May, … 11 = Mar */
export type FiscalMonthIdx = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export const FISCAL_MONTH_NAMES = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
] as const;

/** Quarter ranges in 0-based fiscal indices [fromIdx, toIdx] */
export const QUARTER_RANGES: Record<"q1"|"q2"|"q3"|"q4", [FiscalMonthIdx, FiscalMonthIdx]> = {
  q1: [0, 2],
  q2: [3, 5],
  q3: [6, 8],
  q4: [9, 11],
};

const DEFAULT_FY = "2026-27";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Calendar month → fiscal index (0=Apr … 11=Mar). */
function calMonthToFiscalIdx(calMonth: number /* 0=Jan */): FiscalMonthIdx {
  return ((calMonth - 3 + 12) % 12) as FiscalMonthIdx;
}

/** Fiscal index of the currently in-progress calendar month. */
export function currentFiscalMonthIdx(_fy: string): FiscalMonthIdx {
  return calMonthToFiscalIdx(new Date().getMonth());
}

/** Fiscal index of the last *completed* calendar month for the given FY. */
export function lastCompleteFiscalMonthIdx(fy: string): FiscalMonthIdx {
  const now = new Date();
  const fyStart = parseInt(fy.split("-")[0], 10);
  if (isNaN(fyStart)) return 2;

  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevCalYear = prevDate.getFullYear();
  const prevCalMonth = prevDate.getMonth();

  const inFy =
    (prevCalYear === fyStart && prevCalMonth >= 3) ||
    (prevCalYear === fyStart + 1 && prevCalMonth <= 2);

  if (!inFy) return 0;
  return calMonthToFiscalIdx(prevCalMonth);
}

/** True if the fiscal index is still in the future for the given FY. */
export function isFutureFiscalMonth(idx: FiscalMonthIdx, fy: string): boolean {
  const fyStart = parseInt(fy.split("-")[0], 10);
  if (isNaN(fyStart)) return false;
  const calMonth = (idx + 3) % 12;
  const calYear = idx <= 8 ? fyStart : fyStart + 1;
  return Date.now() < Date.UTC(calYear, calMonth, 1);
}

/** True if the fiscal index is the current in-progress month. */
export function isOpenFiscalMonth(idx: FiscalMonthIdx, fy: string): boolean {
  const fyStart = parseInt(fy.split("-")[0], 10);
  if (isNaN(fyStart)) return false;
  const calMonth = (idx + 3) % 12;
  const calYear = idx <= 8 ? fyStart : fyStart + 1;
  const now = new Date();
  return now.getFullYear() === calYear && now.getMonth() === calMonth;
}

/**
 * True when the entire FY has ended (today is on or after 1 Apr of the next year).
 * Used to guard YTD / Last-7d / Today from resolving to partial ranges on historical FYs.
 */
export function isFyClosed(fy: string): boolean {
  const fyStart = parseInt(fy.split("-")[0], 10);
  if (isNaN(fyStart)) return false;
  // FY Apr-xxxx to Mar-yyyy ends on Mar 31 of fyStart+1.
  // It is fully closed when today >= Apr 1 of fyStart+1.
  return Date.now() >= Date.UTC(fyStart + 1, 3, 1); // month 3 = April (0-based)
}

/** Last complete month clamped to a [fromIdx, toIdx] range (0-based). */
function clampToRange(fromIdx: number, toIdx: number, lastComplete: FiscalMonthIdx): FiscalMonthIdx {
  if (lastComplete < fromIdx) return fromIdx as FiscalMonthIdx;
  if (lastComplete > toIdx) return toIdx as FiscalMonthIdx;
  return lastComplete;
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface EffectivePeriod {
  /** 1-based fiscal month (from). */
  from: number;
  /** 1-based fiscal month (to). */
  to: number;
  label: string;
}

export interface GlobalFilterContextValue {
  fy: string;
  setFy: (fy: string) => void;
  periodMode: PeriodMode;
  setPeriodMode: (mode: PeriodMode) => void;
  /** Active single fiscal month index (0=Apr…11=Mar). Used by "month" mode. */
  monthIdx: FiscalMonthIdx;
  setMonthIdx: (idx: FiscalMonthIdx) => void;
  /** Custom range — start index. Used by "custom" mode. */
  rangeFrom: FiscalMonthIdx;
  setRangeFrom: (idx: FiscalMonthIdx) => void;
  /** Custom range — end index. Used by "custom" mode. */
  rangeTo: FiscalMonthIdx;
  setRangeTo: (idx: FiscalMonthIdx) => void;
  /** All known FYs — populated when any component fetches /api/mgmt/options. */
  availableFys: string[];
  setAvailableFys: (fys: string[]) => void;
  /** Derived: last complete fiscal month index for current FY. */
  lastCompleteIdx: FiscalMonthIdx;
  /** Derived: current in-progress fiscal month index. */
  currentIdx: FiscalMonthIdx;
  /** Derived: single month to highlight / show in single-month views (e.g. SalesPeople). */
  effectiveMonthIdx: FiscalMonthIdx;
  /** Derived: API period {from, to} as 1-based fiscal month numbers. Primitive values — safe as useEffect deps. */
  effectivePeriodFrom: number;
  effectivePeriodTo: number;
  effectivePeriodLabel: string;
  /**
   * Primary-source period upper bound (1-based fiscal month).
   * Same as effectivePeriodTo EXCEPT on YTD for an open FY, where it extends
   * to the current in-progress month so that live sale_line / Order Sheet data
   * is not silently truncated to the secondary cadence cutoff.
   * On closed FYs in YTD mode both values equal 12 (Full Year).
   */
  effectivePrimaryPeriodTo: number;
  /**
   * True when the selected FY has fully ended (today ≥ 1 Apr of the following year).
   * Components use this to guard against YTD / Last-7d / Today returning partial
   * ranges on historical FYs.
   */
  isFyClosedValue: boolean;
  /**
   * Period capability of the currently active page, derived from the route.
   * FULL    — honours month / quarter / YTD / custom
   * FY_ONLY — honours the FY selector only; sub-year period has no effect
   * NONE    — not period-scoped at all
   * Used by GlobalFilterBar to disable/hide controls and by export code to
   * label generated documents with the period they actually cover.
   */
  periodCapability: PeriodCapability;
}

const GlobalFilterContext = createContext<GlobalFilterContextValue | null>(null);

export function GlobalFilterProvider({ children }: { children: ReactNode }) {
  const [fy, setFy] = useState(DEFAULT_FY);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("ytd");
  const [monthIdx, setMonthIdx] = useState<FiscalMonthIdx>(() => lastCompleteFiscalMonthIdx(DEFAULT_FY));
  const [rangeFrom, setRangeFrom] = useState<FiscalMonthIdx>(0);
  const [rangeTo, setRangeTo] = useState<FiscalMonthIdx>(2);
  const [availableFys, setAvailableFys] = useState<string[]>([DEFAULT_FY, "2025-26", "2024-25", "2023-24"]);

  // Derive the current page's period capability from the wouter location.
  // This requires GlobalFilterProvider to be inside WouterRouter (see App.tsx).
  const [location] = useLocation();
  const periodCapability = useMemo(() => getCapabilityForPath(location), [location]);

  // Reset monthIdx to last complete month when FY changes.
  useEffect(() => {
    setMonthIdx(lastCompleteFiscalMonthIdx(fy));
  }, [fy]);

  // YTD / Last-7d / Today are meaningless on a closed (historical) FY — the
  // year is over, so "to date" IS the full year. Switch to Full Year so the
  // UI never shows a YTD pill active on a prior year.
  useEffect(() => {
    if (isFyClosed(fy) && (periodMode === "ytd" || periodMode === "last7" || periodMode === "today")) {
      setPeriodMode("full");
    }
  }, [fy, periodMode]);

  const lastCompleteIdx = useMemo(() => lastCompleteFiscalMonthIdx(fy), [fy]);
  const currentIdx = useMemo(() => currentFiscalMonthIdx(fy), [fy]);
  const isFyClosedValue = useMemo(() => isFyClosed(fy), [fy]);

  // All period derivations as primitive values — no object allocation in deps.
  const { effectiveMonthIdx, effectivePeriodFrom, effectivePeriodTo, effectivePeriodLabel, effectivePrimaryPeriodTo } =
    useMemo(() => {
      let from: number;
      let to: number;
      let primaryTo: number;
      let label: string;
      let singleIdx: FiscalMonthIdx;

      switch (periodMode) {
        case "month":
          from = monthIdx + 1;
          to = from;
          primaryTo = to;
          label = FISCAL_MONTH_NAMES[monthIdx];
          singleIdx = monthIdx;
          break;
        case "q1":
        case "q2":
        case "q3":
        case "q4": {
          const [f0, t0] = QUARTER_RANGES[periodMode];
          from = f0 + 1;
          to = t0 + 1;
          primaryTo = to;
          label = `${periodMode.toUpperCase()} (${FISCAL_MONTH_NAMES[f0]}–${FISCAL_MONTH_NAMES[t0]})`;
          singleIdx = clampToRange(f0, t0, lastCompleteIdx);
          break;
        }
        case "full":
          from = 1;
          to = 12;
          primaryTo = 12;
          label = "Full Year";
          singleIdx = lastCompleteIdx;
          break;
        case "custom":
          from = rangeFrom + 1;
          to = Math.max(from, rangeTo + 1);
          primaryTo = to;
          label = from === to
            ? FISCAL_MONTH_NAMES[rangeFrom]
            : `${FISCAL_MONTH_NAMES[rangeFrom]}–${FISCAL_MONTH_NAMES[Math.max(rangeFrom, rangeTo)]}`;
          singleIdx = clampToRange(rangeFrom, Math.max(rangeFrom, rangeTo), lastCompleteIdx);
          break;
        case "last7":
        case "today":
          // On a closed FY these calendar-day modes are meaningless; resolve to Full Year.
          if (isFyClosedValue) {
            from = 1;
            to = 12;
            primaryTo = 12;
            label = "Full Year";
            singleIdx = 11 as FiscalMonthIdx;
          } else {
            from = currentIdx + 1;
            to = from;
            primaryTo = to;
            label = periodMode === "today" ? "Today" : "Last 7 Days";
            singleIdx = currentIdx;
          }
          break;
        case "ytd":
        default:
          if (isFyClosedValue) {
            // Closed FY — YTD IS the full year; avoid partial ranges on historical FYs.
            from = 1;
            to = 12;
            primaryTo = 12;
            label = "Full Year";
            singleIdx = 11 as FiscalMonthIdx;
          } else {
            // Open FY — secondary: up to last complete month; primary: up to current month.
            from = 1;
            to = lastCompleteIdx + 1;
            primaryTo = currentIdx + 1;
            label = `YTD (Apr–${FISCAL_MONTH_NAMES[lastCompleteIdx]})`;
            singleIdx = lastCompleteIdx;
          }
          break;
      }

      return {
        effectiveMonthIdx: singleIdx,
        effectivePeriodFrom: from,
        effectivePeriodTo: to,
        effectivePeriodLabel: label,
        effectivePrimaryPeriodTo: primaryTo,
      };
    }, [periodMode, monthIdx, rangeFrom, rangeTo, lastCompleteIdx, currentIdx, isFyClosedValue]);

  const value: GlobalFilterContextValue = {
    fy, setFy,
    periodMode, setPeriodMode,
    monthIdx, setMonthIdx,
    rangeFrom, setRangeFrom,
    rangeTo, setRangeTo,
    availableFys, setAvailableFys,
    lastCompleteIdx,
    currentIdx,
    effectiveMonthIdx,
    effectivePeriodFrom,
    effectivePeriodTo,
    effectivePeriodLabel,
    effectivePrimaryPeriodTo,
    isFyClosedValue,
    periodCapability,
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
