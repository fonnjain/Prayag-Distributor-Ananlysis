// GlobalFilterBar — sticky filter strip shown at the top of every page.
// Provides: FY selector · Period/Month pills · Last 7 Days · Today
// Shows: sync timestamp · Refresh button
import { RefreshCw, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useGlobalFilter,
  FISCAL_MONTH_NAMES,
  isOpenFiscalMonth,
  isFutureFiscalMonth,
  type FiscalMonthIdx,
  type PeriodMode,
} from "@/data/global-filter-context";
import { useDashboard } from "@/data/dashboard-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSyncedAt(iso: string | null): { date: string; time: string } {
  const d = new Date(iso ?? Date.now());
  const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return { date, time };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PeriodPill({
  active,
  onClick,
  children,
  dimmed,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  dimmed?: boolean;
  accent?: "open" | "special";
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors shrink-0",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : accent === "open"
            ? "text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/40"
            : accent === "special"
              ? "text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-950/40"
              : dimmed
                ? "text-muted-foreground/50 cursor-not-allowed"
                : "text-foreground/70 border border-border hover:bg-muted",
      )}
      disabled={dimmed}
    >
      {children}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface GlobalFilterBarProps {
  /** When true, hides the sync/refresh row (e.g. if the parent already shows it). */
  hideSyncRow?: boolean;
  /** Override class on the root div. */
  className?: string;
}

export default function GlobalFilterBar({ hideSyncRow, className }: GlobalFilterBarProps) {
  const {
    fy,
    setFy,
    periodMode,
    setPeriodMode,
    monthIdx,
    setMonthIdx,
    availableFys,
    currentIdx,
  } = useGlobalFilter();

  const { syncedAt, sourceStatus, isRefreshing, refresh, refreshError } = useDashboard();
  const isLive = sourceStatus === "live";
  const { date: syncDate, time: syncTime } = fmtSyncedAt(syncedAt);

  function selectMonth(idx: FiscalMonthIdx) {
    setMonthIdx(idx);
    setPeriodMode("month");
  }

  function selectMode(mode: PeriodMode) {
    setPeriodMode(mode);
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Row 1: FY + period pills + special modes */}
      <div className="flex flex-wrap items-center gap-2">
        {/* FY selector */}
        <Select value={fy} onValueChange={setFy}>
          <SelectTrigger className="h-7 w-[108px] text-xs font-semibold border-border">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableFys.map((f) => (
              <SelectItem key={f} value={f} className="text-xs">
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Divider */}
        <span className="text-border/70 text-sm select-none">|</span>

        {/* YTD pill */}
        <PeriodPill
          active={periodMode === "ytd"}
          onClick={() => selectMode("ytd")}
          accent="special"
        >
          YTD
        </PeriodPill>

        {/* Month pills — scrollable row on small screens */}
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5 max-w-full">
          {FISCAL_MONTH_NAMES.map((name, i) => {
            const fi = i as FiscalMonthIdx;
            const isOpen = isOpenFiscalMonth(fi, fy);
            const isFuture = isFutureFiscalMonth(fi, fy);
            const isActive = periodMode === "month" && monthIdx === fi;
            return (
              <PeriodPill
                key={name}
                active={isActive}
                onClick={() => selectMonth(fi)}
                dimmed={isFuture}
                accent={isOpen && !isActive ? "open" : undefined}
              >
                {name}
                {isOpen && (
                  <span className="ml-0.5 text-[9px] align-super opacity-70">open</span>
                )}
              </PeriodPill>
            );
          })}
        </div>

        {/* Divider */}
        <span className="text-border/70 text-sm select-none hidden sm:inline">|</span>

        {/* Special date modes */}
        <div className="flex items-center gap-1">
          <PeriodPill
            active={periodMode === "last7"}
            onClick={() => selectMode("last7")}
            accent={periodMode === "last7" ? undefined : "special"}
          >
            Last 7 days
          </PeriodPill>
          <PeriodPill
            active={periodMode === "today"}
            onClick={() => selectMode("today")}
            accent={periodMode === "today" ? undefined : "special"}
          >
            Today
          </PeriodPill>
        </div>
      </div>

      {/* Row 2: Sync status + refresh */}
      {!hideSyncRow && (
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={cn(
              "text-xs font-medium px-2 py-0.5 rounded inline-flex items-center gap-1",
              isLive
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                isLive ? "bg-primary" : "bg-muted-foreground",
              )}
            />
            {isLive ? "Live" : "Baseline"}
          </span>

          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Last synced: {syncTime} · {syncDate}
          </span>

          {refreshError && (
            <span className="text-xs text-destructive">{refreshError}</span>
          )}

          <button
            onClick={refresh}
            disabled={isRefreshing}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border/60 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={cn("w-3 h-3", isRefreshing && "animate-spin")} />
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}
    </div>
  );
}
