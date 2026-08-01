// GlobalFilterBar — sticky filter strip shown at the top of every page.
// Behaviour depends on the current page's PeriodCapability (from context):
//   FULL    — full controls: FY · YTD · Q1–Q4 · Full Year · months · Custom
//   FY_ONLY — FY selector only; period pills hidden + reason shown
//   NONE    — period controls hidden; reason shown
import { Clock, RefreshCw, ChevronDown, Settings2, AlertCircle } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  useGlobalFilter,
  FISCAL_MONTH_NAMES,
  QUARTER_RANGES,
  isOpenFiscalMonth,
  isFutureFiscalMonth,
  isFyClosed,
  type FiscalMonthIdx,
  type PeriodMode,
} from "@/data/global-filter-context";
import { FY_ONLY_REASON, NONE_REASON } from "@/data/period-capability";
import { useDashboard } from "@/data/dashboard-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSyncedAt(iso: string | null): string {
  const d = new Date(iso ?? Date.now());
  const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return `${time} · ${date}`;
}

// ── Pill button ───────────────────────────────────────────────────────────────

function Pill({
  active,
  onClick,
  children,
  dimmed,
  variant = "default",
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  dimmed?: boolean;
  variant?: "default" | "open" | "special" | "custom";
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={dimmed}
      className={cn(
        "px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors shrink-0 select-none",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : variant === "open"
            ? "text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/40"
            : variant === "special"
              ? "text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-950/40"
              : variant === "custom"
                ? "text-violet-700 dark:text-violet-400 border border-violet-200 dark:border-violet-700 hover:bg-violet-50 dark:hover:bg-violet-950/40 flex items-center gap-1"
                : dimmed
                  ? "text-muted-foreground/40 cursor-not-allowed"
                  : "text-foreground/70 border border-border hover:bg-muted",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── Custom range picker (popover) ─────────────────────────────────────────────

function CustomRangePicker() {
  const {
    rangeFrom, setRangeFrom,
    rangeTo, setRangeTo,
    setPeriodMode,
    effectivePeriodFrom,
    effectivePeriodTo,
    periodMode,
    fy,
  } = useGlobalFilter();

  const [open, setOpen] = useState(false);

  function apply(from: FiscalMonthIdx, to: FiscalMonthIdx) {
    const safeFrom = from;
    const safeTo = Math.max(from, to) as FiscalMonthIdx;
    setRangeFrom(safeFrom);
    setRangeTo(safeTo);
    setPeriodMode("custom");
    setOpen(false);
  }

  const isActive = periodMode === "custom";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors shrink-0 select-none flex items-center gap-1",
            isActive
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-violet-700 dark:text-violet-400 border border-violet-200 dark:border-violet-700 hover:bg-violet-50 dark:hover:bg-violet-950/40",
          )}
        >
          <Settings2 className="w-3 h-3" />
          {isActive
            ? `${FISCAL_MONTH_NAMES[rangeFrom]}–${FISCAL_MONTH_NAMES[Math.max(rangeFrom, rangeTo) as FiscalMonthIdx]}`
            : "Custom"}
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <p className="text-xs font-semibold text-muted-foreground mb-2">Custom date range</p>
        <div className="flex gap-2 items-center mb-3">
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-[10px] text-muted-foreground">From</label>
            <Select
              value={String(rangeFrom)}
              onValueChange={(v) => setRangeFrom(Number(v) as FiscalMonthIdx)}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FISCAL_MONTH_NAMES.map((name, i) => (
                  <SelectItem
                    key={name}
                    value={String(i)}
                    disabled={isFutureFiscalMonth(i as FiscalMonthIdx, fy)}
                    className="text-xs"
                  >
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="text-muted-foreground text-sm mt-4">–</span>
          <div className="flex flex-col gap-1 flex-1">
            <label className="text-[10px] text-muted-foreground">To</label>
            <Select
              value={String(Math.max(rangeFrom, rangeTo))}
              onValueChange={(v) => setRangeTo(Number(v) as FiscalMonthIdx)}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FISCAL_MONTH_NAMES.map((name, i) => (
                  <SelectItem
                    key={name}
                    value={String(i)}
                    disabled={i < rangeFrom || isFutureFiscalMonth(i as FiscalMonthIdx, fy)}
                    className="text-xs"
                  >
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <button
          onClick={() => apply(rangeFrom, Math.max(rangeFrom, rangeTo) as FiscalMonthIdx)}
          className="w-full py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          Apply range
        </button>
        {isActive && (
          <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
            Showing period {effectivePeriodFrom}–{effectivePeriodTo} (1-indexed)
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Sync row (shared across all capability modes) ─────────────────────────────

function SyncRow() {
  const { syncedAt, sourceStatus, isRefreshing, refresh, refreshError } = useDashboard();
  const isLive = sourceStatus === "live";

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span
        className={cn(
          "text-xs font-medium px-2 py-0.5 rounded inline-flex items-center gap-1",
          isLive
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground",
        )}
      >
        <span className={cn("w-1.5 h-1.5 rounded-full", isLive ? "bg-primary" : "bg-muted-foreground")} />
        {isLive ? "Live" : "Baseline"}
      </span>

      <span className="text-xs text-muted-foreground flex items-center gap-1">
        <Clock className="w-3 h-3" />
        Last synced: {fmtSyncedAt(syncedAt)}
      </span>

      {refreshError && (
        <span className="text-xs text-destructive">{String(refreshError)}</span>
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
  );
}

// ── Capability note ────────────────────────────────────────────────────────────

function CapabilityNote({ reason }: { reason: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px opacity-60" />
      {reason}
    </p>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface GlobalFilterBarProps {
  hideSyncRow?: boolean;
  className?: string;
}

export default function GlobalFilterBar({ hideSyncRow, className }: GlobalFilterBarProps) {
  const {
    fy, setFy,
    periodMode, setPeriodMode,
    monthIdx, setMonthIdx,
    availableFys,
    currentIdx,
    periodCapability,
  } = useGlobalFilter();

  const isMonthActive = (idx: FiscalMonthIdx) => periodMode === "month" && monthIdx === idx;

  function selectMonth(idx: FiscalMonthIdx) {
    setMonthIdx(idx);
    setPeriodMode("month");
  }

  const quarters: { id: "q1"|"q2"|"q3"|"q4"; label: string }[] = [
    { id: "q1", label: "Q1" },
    { id: "q2", label: "Q2" },
    { id: "q3", label: "Q3" },
    { id: "q4", label: "Q4" },
  ];

  // FY selector — shared between FULL and FY_ONLY modes.
  const FySelector = (
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
  );

  // ── NONE ──────────────────────────────────────────────────────────────────
  // Not period-scoped at all. Show only the sync row and a brief note.
  if (periodCapability === "NONE") {
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <CapabilityNote reason={NONE_REASON} />
        {!hideSyncRow && <SyncRow />}
      </div>
    );
  }

  // ── FY_ONLY ───────────────────────────────────────────────────────────────
  // Honours the FY selector only. Period pills are hidden; reason is shown.
  if (periodCapability === "FY_ONLY") {
    return (
      <div className={cn("flex flex-col gap-1.5", className)}>
        <div className="flex flex-wrap items-center gap-1.5">
          {FySelector}
          <CapabilityNote reason={FY_ONLY_REASON} />
        </div>
        {!hideSyncRow && <SyncRow />}
      </div>
    );
  }

  // ── FULL ──────────────────────────────────────────────────────────────────
  // Full controls: FY · YTD · Q1–Q4 · Full Year · months · Last 7d · Today · Custom
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {/* Row 1: FY + presets + month pills + special modes */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* FY selector */}
        {FySelector}

        <span className="text-border/60 select-none text-sm">|</span>

        {/* YTD — only meaningful on the open FY; hidden on closed (prior) FYs */}
        {!isFyClosed(fy) && (
          <Pill active={periodMode === "ytd"} onClick={() => setPeriodMode("ytd")} variant="special">
            YTD
          </Pill>
        )}

        {/* Quarters */}
        {quarters.map(({ id, label }) => (
          <Pill
            key={id}
            active={periodMode === id}
            onClick={() => setPeriodMode(id as PeriodMode)}
          >
            {label}
          </Pill>
        ))}

        {/* Full Year */}
        <Pill active={periodMode === "full"} onClick={() => setPeriodMode("full")}>
          Full Year
        </Pill>

        <span className="text-border/60 select-none text-sm">|</span>

        {/* Month pills — scrollable */}
        <div className="flex items-center gap-1 overflow-x-auto pb-0.5 max-w-full">
          {FISCAL_MONTH_NAMES.map((name, i) => {
            const fi = i as FiscalMonthIdx;
            const isOpen = isOpenFiscalMonth(fi, fy);
            const isFuture = isFutureFiscalMonth(fi, fy);
            const active = isMonthActive(fi);
            return (
              <Pill
                key={name}
                active={active}
                onClick={() => selectMonth(fi)}
                dimmed={isFuture}
                variant={isOpen && !active ? "open" : "default"}
              >
                {name}
                {isOpen && <span className="ml-0.5 text-[9px] opacity-70">open</span>}
              </Pill>
            );
          })}
        </div>

        <span className="text-border/60 select-none text-sm hidden sm:inline">|</span>

        {/* Last 7 days / Today — hidden on closed FYs (meaningless for historical data) */}
        <div className="flex items-center gap-1">
          {!isFyClosed(fy) && (
            <>
              <Pill
                active={periodMode === "last7"}
                onClick={() => setPeriodMode("last7")}
                variant={periodMode === "last7" ? "default" : "special"}
              >
                Last 7 days
              </Pill>
              <Pill
                active={periodMode === "today"}
                onClick={() => setPeriodMode("today")}
                variant={periodMode === "today" ? "default" : "special"}
              >
                Today
              </Pill>
            </>
          )}
          {/* Custom range */}
          <CustomRangePicker />
        </div>
      </div>

      {/* Row 2: Sync status + refresh */}
      {!hideSyncRow && <SyncRow />}
    </div>
  );
}
