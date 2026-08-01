import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  getGetDashboardQueryKey,
  useGetDashboard,
  useRefreshDashboard,
} from "@workspace/api-client-react";
import rawData from "./prayag_data.json";

// Types are derived from the bundled dataset, which is the canonical shape of
// the live payload. The live API returns the same structure.
export type DashboardData = typeof rawData.data;
export type DashboardManifest = typeof rawData.manifest;

interface DashboardContextValue {
  data: DashboardData;
  manifest: DashboardManifest;
  syncedAt: string | null;
  sourceStatus: string;
  refreshError: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  /** True while Google Sheets is briefly rate-limiting reads (503 quota). */
  quotaWait: boolean;
  refresh: () => void;
}

/**
 * Detects the API server's "Google Sheets quota exhausted" response:
 * a 503 with `{ quota: true, retryAfter }` in the body. The error thrown by
 * the generated client is an ApiError with `status` and `data` fields; use a
 * duck-typed check so we do not depend on the class being exported.
 */
export function isQuotaWaitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; data?: { quota?: boolean } | null };
  return e.status === 503 && e.data?.quota === true;
}

/** Retry delay for quota errors: honour the server's retryAfter, capped 5-60s. */
export function quotaRetryDelayMs(err: unknown): number {
  const retryAfter =
    (err as { data?: { retryAfter?: number } | null })?.data?.retryAfter ?? 30;
  return Math.min(60, Math.max(5, retryAfter)) * 1000;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const query = useGetDashboard({
    query: {
      queryKey: getGetDashboardQueryKey(),
      // Auto-recover from the ~60s Sheets quota window: keep retrying quota
      // 503s (the banner explains the wait); other errors retry twice.
      retry: (failureCount, error) =>
        isQuotaWaitError(error) ? failureCount < 10 : failureCount < 2,
      retryDelay: (failureCount, error) =>
        isQuotaWaitError(error)
          ? quotaRetryDelayMs(error)
          : Math.min(30_000, 1000 * 2 ** failureCount),
    },
  });
  const refreshMutation = useRefreshDashboard({
    mutation: {
      onSuccess: () => {
        void query.refetch();
      },
    },
  });

  // The fetched snapshot is the source of truth for rendered data; the refresh
  // mutation triggers a refetch on success, so query.data always reflects the
  // latest good snapshot (live or seed fallback). Fall back to the bundled seed
  // only while the first fetch is in flight. The refresh error, however, only
  // travels on the mutation response, so surface it from there; it clears on
  // the next successful refresh.
  const snapshot = query.data ?? null;
  const data = (snapshot?.data ?? rawData.data) as DashboardData;
  const manifest = (snapshot?.manifest ?? rawData.manifest) as DashboardManifest;

  // Quota state travels two ways:
  //  - rejected 503 { quota, retryAfter } (no snapshot available) → query /
  //    mutation error; react-query's retry config auto-recovers the query.
  //  - 200 fallback snapshot with { quota: true, retryAfter } (last-good data
  //    served while Google's quota window is open) → flagged on the payload;
  //    we schedule our own retry below.
  const refreshPayload = refreshMutation.data as
    | ({ quota?: boolean; retryAfter?: number } & typeof refreshMutation.data)
    | undefined;
  const snapshotPayload = snapshot as
    | ({ quota?: boolean; retryAfter?: number } & typeof snapshot)
    | null;
  const payloadQuota =
    refreshPayload?.quota === true || snapshotPayload?.quota === true;
  const payloadRetryAfter =
    refreshPayload?.quota === true
      ? (refreshPayload.retryAfter ?? 30)
      : (snapshotPayload?.retryAfter ?? 30);

  const quotaWait =
    payloadQuota ||
    isQuotaWaitError(query.error) ||
    isQuotaWaitError(query.failureReason) ||
    isQuotaWaitError(refreshMutation.error);

  // Auto-recover from a quota-flagged fallback payload: once the retryAfter
  // window has passed, re-run the refresh so the snapshot is rebuilt from
  // fresh Sheets data (a plain GET would just return the same fallback).
  // Capped so a persistently blocked quota cannot loop forever.
  const quotaRetryCount = useRef(0);
  const refreshRef = useRef(refreshMutation.mutate);
  refreshRef.current = refreshMutation.mutate;
  useEffect(() => {
    if (!payloadQuota) {
      quotaRetryCount.current = 0;
      return;
    }
    if (quotaRetryCount.current >= 5) return;
    const delayMs = Math.min(60, Math.max(5, payloadRetryAfter)) * 1000;
    const timer = setTimeout(() => {
      quotaRetryCount.current += 1;
      refreshRef.current();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [payloadQuota, payloadRetryAfter, refreshPayload, snapshotPayload]);

  const value: DashboardContextValue = {
    data,
    manifest,
    syncedAt: snapshot?.syncedAt ?? null,
    sourceStatus: snapshot?.sourceStatus ?? "seed",
    refreshError: refreshMutation.data?.refreshError ?? null,
    isLoading: query.isLoading,
    isRefreshing: refreshMutation.isPending,
    quotaWait,
    refresh: () => refreshMutation.mutate(),
  };

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (!ctx) {
    throw new Error("useDashboard must be used within a DashboardProvider");
  }
  return ctx;
}
