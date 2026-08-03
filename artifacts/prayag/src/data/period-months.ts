// Shared hook: turns the global period selector into explicit month labels
// for server queries ("Apr-26,May-26") plus month names for client-side
// slicing ("Apr", "May"). YTD / Full Year yield an inactive result — pages
// then fall back to their default (full FY / all complete months) behaviour.
//
// Uses the PRIMARY period upper bound (effectivePrimaryPeriodTo): these pages
// read sale_line / order-book data, which accumulates through the current
// month (see PA1 rule).
import { useMemo } from "react";
import { useGlobalFilter } from "./global-filter-context";

const NAMES = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

export type PeriodMonths = {
  /** True when a sub-year period (month / quarter / custom) is selected. */
  active: boolean;
  /** Month labels of the selected period, e.g. ["Apr-26", "May-26"]. */
  labels: string[];
  /** Month names of the selected period, e.g. ["Apr", "May"]. */
  names: string[];
  /** Query-string fragment: "&months=Apr-26%2CMay-26" or "". */
  param: string;
};

const INACTIVE: PeriodMonths = { active: false, labels: [], names: [], param: "" };

export function usePeriodMonths(): PeriodMonths {
  const { fy, periodMode, effectivePeriodFrom, effectivePrimaryPeriodTo } = useGlobalFilter();
  return useMemo(() => {
    if (periodMode === "ytd" || periodMode === "full") return INACTIVE;
    const fyStart = parseInt(fy.split("-")[0], 10);
    if (isNaN(fyStart)) return INACTIVE;
    const labels: string[] = [];
    const names: string[] = [];
    for (let m = effectivePeriodFrom; m <= effectivePrimaryPeriodTo; m++) {
      const yy = m <= 9 ? fyStart : fyStart + 1;
      names.push(NAMES[m - 1]);
      labels.push(`${NAMES[m - 1]}-${String(yy).slice(-2)}`);
    }
    if (labels.length === 0) return INACTIVE;
    return { active: true, labels, names, param: `&months=${encodeURIComponent(labels.join(","))}` };
  }, [periodMode, fy, effectivePeriodFrom, effectivePrimaryPeriodTo]);
}
