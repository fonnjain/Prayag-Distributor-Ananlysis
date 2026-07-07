import { createContext, useContext, type ReactNode } from "react";
import { useGetDashboard, useRefreshDashboard } from "@workspace/api-client-react";
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
  refresh: () => void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const query = useGetDashboard();
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

  const value: DashboardContextValue = {
    data,
    manifest,
    syncedAt: snapshot?.syncedAt ?? null,
    sourceStatus: snapshot?.sourceStatus ?? "seed",
    refreshError: refreshMutation.data?.refreshError ?? null,
    isLoading: query.isLoading,
    isRefreshing: refreshMutation.isPending,
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
