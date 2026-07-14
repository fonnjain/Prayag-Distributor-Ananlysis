// Canonical shared enforcement point for complete-months filtering.
//
// A month is complete when its last calendar day has passed (or its max
// invoice date reaches the last day of the month for historical FYs that have
// no invoice_date column). Partial / in-progress months must never appear in
// any year-on-year comparison, churn list, or coverage ratio.
//
// Every component that performs a YoY comparison should use this hook to
// obtain the list of complete months, then restrict both the current and
// prior-year sides to those months.
import { useState, useEffect } from "react";

const BASE =
  (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(
    /\/$/,
    "",
  ) ?? "";

export type CompleteMonthsResult = {
  /** Month labels whose last calendar day has already passed, in fiscal order. */
  completeMonths: string[];
  /** Month labels that are in the DB but whose last day has not yet passed. */
  partialMonths: string[];
  /** ISO-8601 timestamp of the last successful register sync (null before first sync). */
  lastSyncedAt: string | null;
  loading: boolean;
};

export function useCompleteMonths(fy: string): CompleteMonthsResult {
  const [completeMonths, setCompleteMonths] = useState<string[]>([]);
  const [partialMonths, setPartialMonths] = useState<string[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${BASE}/api/customers/months?fy=${encodeURIComponent(fy)}`)
      .then((r) => r.json())
      .then(
        (d: {
          months?: string[];
          completeMonths?: string[];
          lastSyncedAt?: string | null;
        }) => {
          if (cancelled) return;
          const all = d.months ?? [];
          const complete = d.completeMonths ?? [];
          const completeSet = new Set(complete);
          setCompleteMonths(complete);
          setPartialMonths(all.filter((m) => !completeSet.has(m)));
          setLastSyncedAt(d.lastSyncedAt ?? null);
        },
      )
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fy]);

  return { completeMonths, partialMonths, lastSyncedAt, loading };
}
