// Primary Performance dashboard — Prayag to Distributor / Direct Dealer.
//
// Three tiers, each degrading independently:
//   1. Company totals  — always from sheets; never blocked.
//   2. By State Head   — always from sheets (STATE HEAD column); never blocked.
//   3. By Team Member  — ONLY this tier needs the distributor bridge.
//      If bridge not ready: show gated message + "Build bridge" action.
// Plus:
//   4. By Distributor  — Customer column in the order sheet; never blocked.
//
// Source: GET /api/mgmt/primary
// RULE: Never show ₹0.00 for data that exists. Unavailable shows a reason.
import { useState, useEffect, useMemo } from "react";
import { useGlobalFilter } from "@/data/global-filter-context";
import {
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  Info,
  RefreshCw,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type HeadRow = {
  head: string;
  booking: number;
  sale: number;
  pending: number;
};

type DistributorRow = {
  name: string;
  stateHead: string;
  booking: number;
};

type MemberRow = {
  normKey: string;
  name: string;
  stateHead: string;
  booking: number;
  sale: number;
  distributors: number;
};

type OrderTabInventoryRow = {
  tabName: string;
  role: "monthly" | "lookup" | "combined" | "per-head" | "unknown";
  includedInSum: boolean;
  excludedReason: string | null;
  rowCount: number;
  dateMin: string | null;
  dateMax: string | null;
  taxableValue: number;
  ltrRows: number;
  ltrQty: number;
  pieceRows: number;
  pieceQty: number;
  retailValue: number;
  govtValue: number;
};

type ApiResponse = {
  fy: string;
  monthFrom: number;
  monthTo: number;
  companyBooking: number;
  companySale: number;
  companyPending: number;
  byHead: HeadRow[];
  byDistributor: DistributorRow[];
  byMember: MemberRow[] | null;
  bridgeStatus: "ready" | "building" | "unavailable";
  sources: { booking: string | null; sale: string | null };
  bookingAvailable: boolean;
  saleAvailable: boolean;
  /** true = figure corresponds to the selected period; false = FY total. */
  bookingPeriodFiltered: boolean;
  salePeriodFiltered: boolean;
  tabInventory: OrderTabInventoryRow[] | null;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const FYS = ["2026-27", "2025-26"] as const;

const FISCAL_MONTH_NAMES = [
  "Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar",
] as const;

function openFiscalMonthsInPeriod(fy: string, fromFm: number, toFm: number): string[] {
  const fyStart = parseInt(fy.slice(0, 4), 10);
  if (isNaN(fyStart)) return [];
  const now = Date.now();
  const open: string[] = [];
  for (let fm = fromFm; fm <= toFm; fm++) {
    const calM = (2 + fm) % 12;
    const yr = fm <= 9 ? fyStart : fyStart + 1;
    const startMs = Date.UTC(yr, calM, 1);
    const endMs = Date.UTC(yr, calM + 1, 0, 23, 59, 59, 999);
    if (now >= startMs && now <= endMs) open.push(FISCAL_MONTH_NAMES[fm - 1]);
  }
  return open;
}

const PERIODS = [
  { label: "Full year", from: 1, to: 12 },
  { label: "Q1 (Apr-Jun)", from: 1, to: 3 },
  { label: "Q2 (Jul-Sep)", from: 4, to: 6 },
  { label: "Q3 (Oct-Dec)", from: 7, to: 9 },
  { label: "Q4 (Jan-Mar)", from: 10, to: 12 },
  { label: "Apr", from: 1, to: 1 },
  { label: "May", from: 2, to: 2 },
  { label: "Jun", from: 3, to: 3 },
  { label: "Jul", from: 4, to: 4 },
  { label: "Aug", from: 5, to: 5 },
  { label: "Sep", from: 6, to: 6 },
  { label: "Oct", from: 7, to: 7 },
  { label: "Nov", from: 8, to: 8 },
  { label: "Dec", from: 9, to: 9 },
  { label: "Jan", from: 10, to: 10 },
  { label: "Feb", from: 11, to: 11 },
  { label: "Mar", from: 12, to: 12 },
] as const;

type View = "head" | "distributor" | "member" | "stateTargets" | "velocity";

// ── State-achievement types (GET /api/primary-targets/state-achievement) ──────

type StateMonthCell = {
  month: string;
  targetLakh: number;
  actualLakh: number;
  source: string;
};

type StateAchievementStateRow = {
  state: string;
  isNewTerritory: boolean;
  registerStates: string[];
  monthly: StateMonthCell[];
  totalTargetLakh: number;
  totalActualLakh: number;
  achievementPct: number | null;
};

type StateAchievementHead = {
  stateHead: string;
  states: StateAchievementStateRow[];
  totalTargetLakh: number;
  totalActualLakh: number;
  achievementPct: number | null;
};

type StateAchievementResponse = {
  fy: string;
  months: string[];
  rows: StateAchievementHead[];
  companyTotals: { month: string; targetLakh: number; actualLakh: number; achievementPct: number | null }[];
  actualsAvailable: boolean;
  actualsError: string | null;
};

// ── Velocity types (GET /api/primary-performance/velocity) ────────────────────

type VelocityStatus = "too_early" | "on_pace" | "ahead" | "behind";
type VelocityMomentum = "building" | "stalling" | "steady" | "early";

type VelocityHeadRow = {
  stateHead: string;
  headKey: string;
  targetLakh: number;
  targetDerived: boolean;
  actualLakh: number;
  actualPct: number;
  expectedPct: number;
  bandLow: number;
  bandHigh: number;
  typicalPctToday: number;
  typicalPctRef: { d15: number; d20: number; d25: number; d28: number } | null;
  status: VelocityStatus;
  momentum: VelocityMomentum;
  projectedClosePct: number | null;
  sparkline: number[];
  isNewTerritory: boolean;
  hasDateData: boolean;
};

type VelocityResponse = {
  fy: string;
  month: string | null;
  monthFull: string;
  dayOfMonth: number;
  daysInMonth: number;
  effectiveDay: number;
  expectedPct: number;
  bandLow: number;
  bandHigh: number;
  isEarlyMonth: boolean;
  targetDerived: boolean;
  company: {
    targetLakh: number;
    actualLakh: number;
    actualPct: number;
    expectedPct: number;
    status: VelocityStatus;
  } | null;
  heads: VelocityHeadRow[];
  dataError: string | null;
  asOf: string;
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number | null | undefined): string {
  if (n == null || n === 0) return "—";
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-IN");
}

// ── Pending chip ──────────────────────────────────────────────────────────────

function PendingChip({ pending, booking }: { pending: number; booking: number }) {
  if (booking <= 0) return null;
  const pct = (pending / booking) * 100;
  if (pct < 10) return null;
  return (
    <span
      className={cn(
        "ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        pct >= 40
          ? "bg-red-500/10 text-red-700 dark:text-red-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      <AlertTriangle className="h-2.5 w-2.5" />
      {pct.toFixed(0)}% pending
    </span>
  );
}

// ── Velocity helper components ────────────────────────────────────────────────

const STATUS_LABEL: Record<VelocityStatus, string> = {
  too_early: "Too early",
  on_pace:   "On pace",
  ahead:     "Ahead",
  behind:    "Behind",
};

const STATUS_CLASS: Record<VelocityStatus, string> = {
  too_early: "bg-muted text-muted-foreground",
  on_pace:   "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  ahead:     "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  behind:    "bg-red-500/10 text-red-700 dark:text-red-400",
};

function VelocityStatusChip({ status }: { status: VelocityStatus }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold",
        STATUS_CLASS[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

const MOMENTUM_LABEL: Record<VelocityMomentum, string> = {
  building: "Building",
  stalling: "Stalling",
  steady:   "Steady",
  early:    "",
};

function VelocityMomentumChip({ momentum }: { momentum: VelocityMomentum }) {
  if (momentum === "early" || momentum === "steady") return null;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium",
        momentum === "building"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      {MOMENTUM_LABEL[momentum]}
    </span>
  );
}

function VelocitySparkline({
  data,
  daysInMonth,
  dayOfMonth,
}: {
  data: number[];
  daysInMonth: number;
  dayOfMonth: number;
}) {
  const W = 120;
  const H = 28;
  const max = Math.max(...data.slice(0, dayOfMonth), 0.001);
  const barSlot = W / daysInMonth;
  const barW = Math.max(barSlot - 1, 1);
  return (
    <svg width={W} height={H} className="shrink-0 overflow-visible">
      {data.slice(0, dayOfMonth).map((v, i) => {
        if (v <= 0) return null;
        const bh = Math.max((v / max) * H, 1);
        const x = i * barSlot;
        return (
          <rect
            key={i}
            x={x}
            y={H - bh}
            width={barW}
            height={bh}
            rx="0.5"
            className="fill-primary/50"
          />
        );
      })}
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PrimaryPerformanceDashboard() {
  const { fy, effectivePeriodFrom, effectivePeriodTo } = useGlobalFilter();
  const [view, setView] = useState<View>("head");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedHeads, setExpandedHeads] = useState<Set<string>>(new Set());
  const [bridgeBuilding, setBridgeBuilding] = useState(false);
  const [bridgeBuildMsg, setBridgeBuildMsg] = useState<string | null>(null);
  const [showInventory, setShowInventory] = useState(false);
  const [stateData, setStateData] = useState<StateAchievementResponse | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);
  const [velocityData, setVelocityData] = useState<VelocityResponse | null>(null);
  const [velocityLoading, setVelocityLoading] = useState(false);
  const [velocityError, setVelocityError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      fy,
      monthFrom: String(effectivePeriodFrom),
      monthTo: String(effectivePeriodTo),
    });
    fetch(`/api/mgmt/primary?${params}`)
      .then((r) => {
        if (!r.ok)
          return r.json().then((e: { error?: string }) => {
            throw new Error(e.error ?? r.statusText);
          });
        return r.json() as Promise<ApiResponse>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [fy, effectivePeriodFrom, effectivePeriodTo]);

  // Lazy-fetch state targets only when that view is active
  useEffect(() => {
    if (view !== "stateTargets") return;
    setStateLoading(true);
    setStateError(null);
    fetch(`/api/primary-targets/state-achievement?fy=${encodeURIComponent(fy)}`)
      .then((r) => {
        if (!r.ok)
          return r.json().then((e: { error?: string }) => {
            throw new Error(e.error ?? r.statusText);
          });
        return r.json() as Promise<StateAchievementResponse>;
      })
      .then((d) => { setStateData(d); setStateLoading(false); })
      .catch((err: Error) => { setStateError(err.message); setStateLoading(false); });
  }, [fy, view]);

  // Lazy-fetch velocity only when that view is active; always uses current FY
  useEffect(() => {
    if (view !== "velocity") return;
    setVelocityLoading(true);
    setVelocityError(null);
    fetch(`/api/primary-performance/velocity?fy=${encodeURIComponent(fy)}`)
      .then((r) => {
        if (!r.ok)
          return r.json().then((e: { error?: string }) => {
            throw new Error(e.error ?? r.statusText);
          });
        return r.json() as Promise<VelocityResponse>;
      })
      .then((d) => { setVelocityData(d); setVelocityLoading(false); })
      .catch((err: Error) => { setVelocityError(err.message); setVelocityLoading(false); });
  }, [fy, view]);

  const toggleHead = (head: string) => {
    setExpandedHeads((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head);
      else next.add(head);
      return next;
    });
  };

  // Group distributor rows by state head for the distributor view
  const distributorsByHead = useMemo(() => {
    if (!data) return new Map<string, DistributorRow[]>();
    const map = new Map<string, DistributorRow[]>();
    for (const d of data.byDistributor) {
      const list = map.get(d.stateHead) ?? [];
      list.push(d);
      map.set(d.stateHead, list);
    }
    return map;
  }, [data]);

  // Group member rows by state head
  const membersByHead = useMemo(() => {
    if (!data?.byMember) return new Map<string, MemberRow[]>();
    const map = new Map<string, MemberRow[]>();
    for (const m of data.byMember) {
      const list = map.get(m.stateHead) ?? [];
      list.push(m);
      map.set(m.stateHead, list);
    }
    return map;
  }, [data]);

  async function handleBuildBridge() {
    setBridgeBuilding(true);
    setBridgeBuildMsg(null);
    try {
      const r = await fetch("/api/mgmt/bridge/build", { method: "POST" });
      const body = (await r.json()) as { message?: string; error?: string };
      setBridgeBuildMsg(
        body.message ?? body.error ?? "Bridge build started. Reload in 2-3 minutes.",
      );
    } catch {
      setBridgeBuildMsg("Failed to start bridge build. Check the server logs.");
    } finally {
      setBridgeBuilding(false);
    }
  }

  const nothingAvailable =
    !loading && data && !data.bookingAvailable && !data.saleAvailable;

  const openInPeriod = openFiscalMonthsInPeriod(fy, effectivePeriodFrom, effectivePeriodTo);

  return (
    <div className="space-y-5 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Primary Performance</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Prayag to Distributor / Direct Dealer — order booking, dispatch, and pending
          </p>
        </div>
        <span className="text-xs text-muted-foreground">FY {fy}</span>
      </div>

      {openInPeriod.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
          <span>
            {openInPeriod.join(", ")} {openInPeriod.length === 1 ? "is" : "are"} still in
            progress — figures include partial current-month data. Prior-year figures for the same
            month{openInPeriod.length > 1 ? "s" : ""} are complete. Any year-on-year comparison
            covering this period is provisional until the month closes.
          </span>
        </div>
      )}

      {/* Load states */}
      {loading && (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading primary performance data…
        </div>
      )}
      {error && (
        <div className="py-6 text-center text-sm text-destructive">{error}</div>
      )}

      {/* Tier 1 — Company totals (always rendered when data exists) */}
      {!loading && data && (() => {
        const isSubYear = data.monthFrom !== 1 || data.monthTo !== 12;
        const bookingUnfiltered = isSubYear && !data.bookingPeriodFiltered;
        const saleUnfiltered = isSubYear && !data.salePeriodFiltered;
        return (
          <div className="grid grid-cols-3 gap-3">
            {[
              {
                label: "Order Booking (booked)",
                value: data.companyBooking,
                source: data.sources.booking,
                available: data.bookingAvailable,
                unfiltered: bookingUnfiltered,
              },
              {
                label: "Sale / Dispatch",
                value: data.companySale,
                source: data.sources.sale,
                available: data.saleAvailable,
                unfiltered: saleUnfiltered,
              },
              {
                label: "Pending (booked \u2212 dispatched)",
                value: data.companyPending,
                source: null,
                available: data.bookingAvailable && data.saleAvailable,
                warn: data.companyBooking > 0 && data.companyPending / data.companyBooking > 0.25,
                unfiltered: bookingUnfiltered || saleUnfiltered,
              },
            ].map((tile) => (
              <div
                key={tile.label}
                className="rounded-lg border border-border bg-card p-3"
              >
                <p className="text-xs text-muted-foreground">{tile.label}</p>
                {tile.available ? (
                  <p className="text-xl font-semibold font-mono mt-1">
                    {fmtCr(tile.value)}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground mt-1 italic">
                    unavailable
                  </p>
                )}
                {tile.source && (
                  <p className="text-[10px] text-muted-foreground mt-1 truncate">
                    {tile.source}
                  </p>
                )}
                {tile.unfiltered && (
                  <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    FY total — period filter not applied
                  </p>
                )}
                {"warn" in tile && tile.warn && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Ops / fulfilment signal
                  </p>
                )}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Nothing available at all */}
      {nothingAvailable && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md p-3">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            No primary sheets are configured for FY {fy}. Order booking and
            dispatch sale data are unavailable for this fiscal year.
          </span>
        </div>
      )}

      {/* View toggle (only when some data exists) */}
      {!loading && data && (data.bookingAvailable || data.saleAvailable) && (
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5 w-fit flex-wrap">
          {(
            [
              { key: "head" as View, label: "By State Head" },
              ...(data.byDistributor.length > 0
                ? [{ key: "distributor" as View, label: "By Distributor" }]
                : []),
              { key: "member" as View, label: "By Team Member" },
              { key: "stateTargets" as View, label: "State Targets" },
              { key: "velocity" as View, label: "Velocity" },
            ] as { key: View; label: string }[]
          ).map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={cn(
                "px-3 py-1 text-xs rounded-md font-medium transition-colors",
                view === v.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      {/* Tier 2 — By State Head (always rendered, no bridge needed) */}
      {!loading && data && view === "head" && data.byHead.length > 0 && (() => {
        const isSubYear = data.monthFrom !== 1 || data.monthTo !== 12;
        const bookingUnfiltered = isSubYear && !data.bookingPeriodFiltered;
        const saleUnfiltered = isSubYear && !data.salePeriodFiltered;
        return (
        <div className="rounded-lg border border-border overflow-auto">
          {(bookingUnfiltered || saleUnfiltered) && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-500/20 bg-amber-500/5 text-[11px] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>
                {[bookingUnfiltered && "Order Booking", saleUnfiltered && "Sale"]
                  .filter(Boolean)
                  .join(" and ")}{" "}
                shows FY total — period filter not applied for{" "}
                {[bookingUnfiltered && "booking", saleUnfiltered && "sale"]
                  .filter(Boolean)
                  .join(" and ")}
                . By State Head rows reflect the same unfiltered figures.
              </span>
            </div>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">
                  State Head
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Order Booking
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Dispatched
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Pending
                </th>
              </tr>
            </thead>
            <tbody>
              {data.byHead.map((row) => (
                <tr
                  key={row.head}
                  className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                >
                  <td className="py-2 px-3 font-medium text-sm">{row.head}</td>
                  <td className="py-2 px-3 text-right font-mono text-sm">
                    {row.booking > 0 ? fmtCr(row.booking) : "—"}
                    {row.booking > 0 && (
                      <PendingChip pending={row.pending} booking={row.booking} />
                    )}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-xs text-muted-foreground">
                    {row.sale > 0 ? fmtCr(row.sale) : "—"}
                  </td>
                  <td className="py-2 px-3 text-right font-mono text-xs text-muted-foreground">
                    {row.pending > 0 ? fmtCr(row.pending) : "—"}
                  </td>
                </tr>
              ))}
              {/* Totals */}
              <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                <td className="py-2 px-3 text-sm">Total</td>
                <td className="py-2 px-3 text-right font-mono text-sm">
                  {fmtCr(data.companyBooking)}
                </td>
                <td className="py-2 px-3 text-right font-mono text-xs text-muted-foreground">
                  {fmtCr(data.companySale)}
                </td>
                <td className="py-2 px-3 text-right font-mono text-xs text-muted-foreground">
                  {data.companyPending > 0 ? fmtCr(data.companyPending) : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        );
      })()}

      {/* Tier 4 — By Distributor (always available from Customer column in order sheet) */}
      {!loading && data && view === "distributor" && data.byDistributor.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {data.byDistributor.length} distributors from the order sheet.
            Grouped by State Head. No bridge required.
          </p>
          {/* Group by state head */}
          {Array.from(
            data.byDistributor.reduce((map, d) => {
              const list = map.get(d.stateHead) ?? [];
              list.push(d);
              map.set(d.stateHead, list);
              return map;
            }, new Map<string, DistributorRow[]>()),
          )
            .sort(([, a], [, b]) =>
              b.reduce((s, x) => s + x.booking, 0) -
              a.reduce((s, x) => s + x.booking, 0),
            )
            .map(([head, dists]) => (
              <div key={head} className="rounded-lg border border-border overflow-auto">
                <div
                  className="flex items-center justify-between px-3 py-2 bg-muted/20 cursor-pointer"
                  onClick={() => toggleHead(head)}
                >
                  <span className="font-medium text-sm">{head}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground font-mono">
                      {fmtCr(dists.reduce((s, d) => s + d.booking, 0))} ·{" "}
                      {dists.length} distributors
                    </span>
                    {expandedHeads.has(head) ? (
                      <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </div>
                </div>
                {expandedHeads.has(head) && (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/10">
                        <th className="py-1.5 px-3 text-left text-xs font-medium text-muted-foreground">
                          Distributor / Dealer
                        </th>
                        <th className="py-1.5 px-3 text-right text-xs font-medium text-muted-foreground">
                          Order Booking
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {dists
                        .sort((a, b) => b.booking - a.booking)
                        .map((d) => (
                          <tr
                            key={d.name}
                            className="border-b border-border/40 hover:bg-muted/10"
                          >
                            <td className="py-1.5 px-3 text-sm">{d.name}</td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs">
                              {fmtCr(d.booking)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
        </div>
      )}

      {view === "distributor" && !loading && data && data.byDistributor.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No distributor data available. The order sheet for FY {fy} may not
          have a Customer column or could not be read.
        </div>
      )}

      {/* Tier 3 — By Team Member (gated on bridge) */}
      {!loading && data && view === "member" && (
        <>
          {data.bridgeStatus === "ready" && data.byMember && data.byMember.length > 0 ? (
            <div className="rounded-lg border border-border overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">
                      Team Member
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      State Head
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Order Booking
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Dispatched
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Distributors
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.byMember
                    .filter((m) => m.booking > 0 || m.sale > 0)
                    .map((m) => (
                      <tr
                        key={m.normKey}
                        className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                      >
                        <td className="py-1.5 px-3 text-sm">{m.name}</td>
                        <td className="py-1.5 px-3 text-right text-xs text-muted-foreground">
                          {m.stateHead}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-xs">
                          {m.booking > 0 ? fmtCr(m.booking) : "—"}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-xs text-muted-foreground">
                          {m.sale > 0 ? fmtCr(m.sale) : "—"}
                        </td>
                        <td className="py-1.5 px-3 text-right text-xs text-muted-foreground">
                          {m.distributors > 0 ? fmtNum(m.distributors) : "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-muted/10 p-6 space-y-4">
              <div className="flex items-start gap-3">
                <Lock className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    Per-salesperson split requires the distributor bridge
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {data.bridgeStatus === "building"
                      ? "The distributor bridge is currently being built. Company totals and state-head breakdown (above) are fully available now. Come back in a minute for per-member attribution."
                      : "The distributor-to-team-member bridge maps each Customer in the order sheet to their salesperson. State Head and Distributor views above work without it."}
                  </p>
                </div>
              </div>
              {data.bridgeStatus !== "building" && (
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleBuildBridge}
                    disabled={bridgeBuilding}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                      bridgeBuilding
                        ? "border-border text-muted-foreground cursor-not-allowed"
                        : "border-primary text-primary hover:bg-primary/5",
                    )}
                  >
                    <RefreshCw
                      className={cn(
                        "h-3 w-3",
                        bridgeBuilding && "animate-spin",
                      )}
                    />
                    {bridgeBuilding ? "Building…" : "Build bridge"}
                  </button>
                  {bridgeBuildMsg && (
                    <p className="text-xs text-muted-foreground">
                      {bridgeBuildMsg}
                    </p>
                  )}
                </div>
              )}
              {/* Company and head tier still visible below the gated section */}
              <div className="pt-2 border-t border-border/50">
                <p className="text-xs text-muted-foreground">
                  Company total and State Head breakdown are fully available
                  above — switch to "By State Head" to see them.
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {/* State Targets view — target vs order-booking actual, per state per head */}
      {!loading && view === "stateTargets" && (
        <div className="space-y-3">
          {stateLoading && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Loading state targets…
            </div>
          )}
          {stateError && (
            <div className="py-6 text-center text-sm text-destructive">{stateError}</div>
          )}
          {!stateLoading && stateData && (
            <>
              {/* Month totals strip */}
              {stateData.companyTotals.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {stateData.companyTotals.map((ct) => (
                    <div
                      key={ct.month}
                      className="flex-shrink-0 rounded-lg border border-border bg-card p-2.5 min-w-[110px]"
                    >
                      <p className="text-[10px] text-muted-foreground font-medium">{ct.month}</p>
                      <p className="text-xs font-mono mt-0.5">
                        {ct.targetLakh.toFixed(0)} L
                        {stateData.actualsAvailable && (
                          <span className="text-muted-foreground"> / {ct.actualLakh.toFixed(0)}</span>
                        )}
                      </p>
                      {stateData.actualsAvailable && ct.achievementPct != null && (
                        <p
                          className={cn(
                            "text-[11px] font-semibold mt-0.5",
                            ct.achievementPct >= 100
                              ? "text-emerald-600 dark:text-emerald-400"
                              : ct.achievementPct >= 75
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-destructive",
                          )}
                        >
                          {ct.achievementPct.toFixed(1)}%
                        </p>
                      )}
                      <p className="text-[9px] text-muted-foreground/60 mt-0.5">Tgt / Act (Lakh)</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Actuals unavailable notice */}
              {!stateData.actualsAvailable && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-500" />
                  <span>
                    Order-booking actuals could not be loaded from the live sheet — targets are
                    shown but achievement cannot be computed.
                    {stateData.actualsError ? ` (${stateData.actualsError})` : ""}
                  </span>
                </div>
              )}

              {stateData.rows.length === 0 && (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No state targets found for FY {fy}. State targets are loaded for FY2026-27 only.
                </div>
              )}

              {/* Per-head collapsible blocks */}
              {stateData.rows.map((head) => (
                <div key={head.stateHead} className="rounded-lg border border-border overflow-hidden">
                  {/* Head header */}
                  <div
                    className="flex items-center justify-between px-3 py-2.5 bg-muted/20 cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => toggleHead(head.stateHead)}
                  >
                    <span className="font-medium text-sm">{head.stateHead}</span>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <span className="text-xs font-mono text-muted-foreground">
                          {head.totalTargetLakh.toFixed(0)} Lakh target
                        </span>
                        {stateData.actualsAvailable && head.achievementPct != null && (
                          <span
                            className={cn(
                              "ml-2 text-xs font-semibold",
                              head.achievementPct >= 100
                                ? "text-emerald-600 dark:text-emerald-400"
                                : head.achievementPct >= 75
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-destructive",
                            )}
                          >
                            {head.achievementPct.toFixed(1)}%
                          </span>
                        )}
                      </div>
                      {expandedHeads.has(head.stateHead) ? (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                  </div>

                  {/* Expanded: state table */}
                  {expandedHeads.has(head.stateHead) && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border bg-muted/10">
                            <th className="py-1.5 px-3 text-left font-medium text-muted-foreground">
                              State
                            </th>
                            {stateData.months.map((m) => (
                              <th
                                key={m}
                                colSpan={stateData.actualsAvailable ? 2 : 1}
                                className="py-1.5 px-2 text-center font-medium text-muted-foreground border-l border-border/50"
                              >
                                {m}
                              </th>
                            ))}
                            <th
                              colSpan={stateData.actualsAvailable ? 3 : 1}
                              className="py-1.5 px-2 text-center font-medium text-muted-foreground border-l border-border/50"
                            >
                              Total
                            </th>
                          </tr>
                          <tr className="border-b border-border bg-muted/5">
                            <th className="py-1 px-3 text-left text-[10px] text-muted-foreground/70" />
                            {stateData.months.map((m) => (
                              <th key={m} colSpan={stateData.actualsAvailable ? 2 : 1} className="border-l border-border/50">
                                {stateData.actualsAvailable ? (
                                  <div className="grid grid-cols-2 text-[10px] text-muted-foreground/70">
                                    <span className="px-2 py-0.5 text-right">Tgt</span>
                                    <span className="px-2 py-0.5 text-right">Act</span>
                                  </div>
                                ) : (
                                  <span className="text-[10px] text-muted-foreground/70 px-2">Tgt</span>
                                )}
                              </th>
                            ))}
                            <th className="border-l border-border/50">
                              {stateData.actualsAvailable ? (
                                <div className="grid grid-cols-3 text-[10px] text-muted-foreground/70">
                                  <span className="px-2 py-0.5 text-right">Tgt</span>
                                  <span className="px-2 py-0.5 text-right">Act</span>
                                  <span className="px-2 py-0.5 text-right">Ach%</span>
                                </div>
                              ) : (
                                <span className="text-[10px] text-muted-foreground/70 px-2">Tgt</span>
                              )}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {head.states.map((st) => (
                            <tr
                              key={st.state}
                              className="border-b border-border/40 hover:bg-muted/10 last:border-0"
                            >
                              <td className="py-1.5 px-3 font-medium">
                                {st.state}
                                {st.isNewTerritory && (
                                  <span className="ml-1.5 rounded px-1 py-0.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[9px] font-semibold">
                                    new
                                  </span>
                                )}
                              </td>
                              {stateData.months.map((m) => {
                                const cell = st.monthly.find((mm) => mm.month === m);
                                return (
                                  <td
                                    key={m}
                                    colSpan={stateData.actualsAvailable ? 2 : 1}
                                    className="border-l border-border/50 p-0"
                                  >
                                    {cell ? (
                                      stateData.actualsAvailable ? (
                                        <div className="grid grid-cols-2">
                                          <span className="px-2 py-1.5 text-right tabular-nums">
                                            {cell.targetLakh.toFixed(0)}
                                          </span>
                                          <span className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                                            {cell.actualLakh.toFixed(0)}
                                          </span>
                                        </div>
                                      ) : (
                                        <span className="px-2 py-1.5 text-right tabular-nums block">
                                          {cell.targetLakh.toFixed(0)}
                                        </span>
                                      )
                                    ) : (
                                      <span className="px-2 py-1.5 text-muted-foreground/40 block text-right">—</span>
                                    )}
                                  </td>
                                );
                              })}
                              {/* Total + achievement */}
                              <td className="border-l border-border/50 p-0">
                                {stateData.actualsAvailable ? (
                                  <div className="grid grid-cols-3">
                                    <span className="px-2 py-1.5 text-right tabular-nums font-medium">
                                      {st.totalTargetLakh.toFixed(0)}
                                    </span>
                                    <span className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                                      {st.totalActualLakh.toFixed(0)}
                                    </span>
                                    <span
                                      className={cn(
                                        "px-2 py-1.5 text-right font-semibold",
                                        st.isNewTerritory
                                          ? "text-blue-500"
                                          : st.achievementPct == null
                                            ? "text-muted-foreground"
                                            : st.achievementPct >= 100
                                              ? "text-emerald-600 dark:text-emerald-400"
                                              : st.achievementPct >= 75
                                                ? "text-amber-600 dark:text-amber-400"
                                                : "text-destructive",
                                      )}
                                    >
                                      {st.isNewTerritory
                                        ? "new"
                                        : st.achievementPct != null
                                          ? `${st.achievementPct.toFixed(1)}%`
                                          : "—"}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="px-2 py-1.5 text-right tabular-nums font-medium block">
                                    {st.totalTargetLakh.toFixed(0)}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        {/* Head subtotal */}
                        <tfoot>
                          <tr className="border-t-2 border-border bg-muted/20 font-semibold">
                            <td className="py-1.5 px-3">Subtotal</td>
                            {stateData.months.map((m) => {
                              const tgt = head.states.reduce((s, st) => {
                                const c = st.monthly.find((mm) => mm.month === m);
                                return s + (c?.targetLakh ?? 0);
                              }, 0);
                              const act = head.states.reduce((s, st) => {
                                const c = st.monthly.find((mm) => mm.month === m);
                                return s + (c?.actualLakh ?? 0);
                              }, 0);
                              return (
                                <td
                                  key={m}
                                  colSpan={stateData.actualsAvailable ? 2 : 1}
                                  className="border-l border-border/50 p-0"
                                >
                                  {stateData.actualsAvailable ? (
                                    <div className="grid grid-cols-2">
                                      <span className="px-2 py-1.5 text-right tabular-nums">{tgt.toFixed(0)}</span>
                                      <span className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{act.toFixed(0)}</span>
                                    </div>
                                  ) : (
                                    <span className="px-2 py-1.5 text-right tabular-nums block">{tgt.toFixed(0)}</span>
                                  )}
                                </td>
                              );
                            })}
                            <td className="border-l border-border/50 p-0">
                              {stateData.actualsAvailable ? (
                                <div className="grid grid-cols-3">
                                  <span className="px-2 py-1.5 text-right tabular-nums">{head.totalTargetLakh.toFixed(0)}</span>
                                  <span className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{head.totalActualLakh.toFixed(0)}</span>
                                  <span
                                    className={cn(
                                      "px-2 py-1.5 text-right font-semibold",
                                      head.achievementPct == null
                                        ? "text-muted-foreground"
                                        : head.achievementPct >= 100
                                          ? "text-emerald-600 dark:text-emerald-400"
                                          : head.achievementPct >= 75
                                            ? "text-amber-600 dark:text-amber-400"
                                            : "text-destructive",
                                    )}
                                  >
                                    {head.achievementPct != null ? `${head.achievementPct.toFixed(1)}%` : "—"}
                                  </span>
                                </div>
                              ) : (
                                <span className="px-2 py-1.5 text-right tabular-nums block">{head.totalTargetLakh.toFixed(0)}</span>
                              )}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              ))}

              {/* Source legend */}
              <p className="text-[10px] text-muted-foreground/60 px-1">
                Targets in Lakh rupees. Apr–May = seasonal estimate (derived); Jun–Jul = management plan (given).
                {stateData.actualsAvailable
                  ? " Actuals from Order Book FY2627 live sheet."
                  : ""}
              </p>
            </>
          )}
        </div>
      )}

      {/* ── Velocity view ────────────────────────────────────────────────── */}
      {view === "velocity" && velocityLoading && (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading velocity data…
        </div>
      )}
      {view === "velocity" && velocityError && (
        <div className="py-6 text-center text-sm text-destructive">{velocityError}</div>
      )}
      {view === "velocity" && !velocityLoading && velocityData && (
        <div className="space-y-4">
          {/* Header strip */}
          <div className="rounded-lg border border-border bg-card px-4 py-3 space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-semibold">
                {velocityData.monthFull} — day {velocityData.dayOfMonth} of {velocityData.daysInMonth}
              </span>
              {velocityData.isEarlyMonth ? (
                <span className="text-xs text-muted-foreground italic">
                  Too early in the month to score pace (before day 15)
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Expected pace today:{" "}
                  <span className="font-medium text-foreground">
                    {velocityData.expectedPct}%
                  </span>
                  <span className="text-muted-foreground/70">
                    {" "}(band {velocityData.bandLow}%–{velocityData.bandHigh}%)
                  </span>
                </span>
              )}
            </div>
            {velocityData.targetDerived && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                Targets for this month are seasonal estimates (derived), not the management plan.
              </p>
            )}
            {velocityData.dataError && (
              <p className="text-[11px] text-destructive">
                Data warning: {velocityData.dataError}
              </p>
            )}
          </div>

          {/* Company summary */}
          {velocityData.company && (
            <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Company
                </span>
                <span className="text-sm font-mono font-medium">
                  {velocityData.company.actualLakh.toFixed(0)} L actual
                </span>
                <span className="text-xs text-muted-foreground">
                  / {velocityData.company.targetLakh.toFixed(0)} L target
                </span>
                <span className="text-sm font-semibold">
                  {velocityData.company.actualPct}%
                </span>
                {!velocityData.isEarlyMonth && (
                  <span className="text-xs text-muted-foreground">
                    vs expected {velocityData.company.expectedPct}%
                  </span>
                )}
                {!velocityData.isEarlyMonth && (
                  <VelocityStatusChip status={velocityData.company.status} />
                )}
              </div>
            </div>
          )}

          {/* Per-head cards */}
          {velocityData.heads.length === 0 ? (
            <p className="text-sm text-muted-foreground px-1">
              No head-level targets found for {velocityData.month ?? "this month"}.
              Load targets via the State Targets view first.
            </p>
          ) : (
            <div className="space-y-2">
              {velocityData.heads.map((head) => (
                <div
                  key={head.headKey}
                  className="rounded-lg border border-border bg-card px-3 py-2.5 space-y-2"
                >
                  {/* Row 1: name + status */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{head.stateHead}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {head.isNewTerritory && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400">
                          new territory
                        </span>
                      )}
                      {!velocityData.isEarlyMonth && (
                        <VelocityStatusChip status={head.status} />
                      )}
                      {head.momentum !== "early" && head.momentum !== "steady" && (
                        <VelocityMomentumChip momentum={head.momentum} />
                      )}
                    </div>
                  </div>

                  {/* Row 2: actual vs expected */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs text-muted-foreground">
                      Actual
                    </span>
                    <span className="text-sm font-mono font-semibold">
                      {head.actualPct}%
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ({head.actualLakh.toFixed(1)} L / {head.targetLakh.toFixed(0)} L)
                    </span>
                    {!velocityData.isEarlyMonth && (
                      <>
                        <span className="text-muted-foreground/40 text-xs">vs</span>
                        <span className="text-xs text-muted-foreground">
                          expected {head.expectedPct}%
                          <span className="text-muted-foreground/60">
                            {" "}({head.bandLow}%–{head.bandHigh}%)
                          </span>
                        </span>
                        {head.typicalPctToday >= 0 && (
                          <span className="text-xs text-muted-foreground/70">
                            · own pace {head.typicalPctToday}%
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {/* Row 3: projected + sparkline */}
                  <div className="flex items-end justify-between gap-3">
                    <div className="space-y-0.5">
                      {head.projectedClosePct != null && !velocityData.isEarlyMonth && (
                        <p className="text-xs text-muted-foreground">
                          Projected close:{" "}
                          <span
                            className={cn(
                              "font-medium",
                              head.projectedClosePct >= 100
                                ? "text-emerald-600 dark:text-emerald-400"
                                : head.projectedClosePct >= 80
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-destructive",
                            )}
                          >
                            {head.projectedClosePct}%
                          </span>
                        </p>
                      )}
                      {head.typicalPctRef && (
                        <p className="text-[10px] text-muted-foreground/60">
                          Historical pace: d15={head.typicalPctRef.d15}%
                          · d20={head.typicalPctRef.d20}%
                          · d25={head.typicalPctRef.d25}%
                          · d28={head.typicalPctRef.d28}%
                        </p>
                      )}
                    </div>
                    {head.hasDateData && head.sparkline.some((v) => v > 0) && (
                      <VelocitySparkline
                        data={head.sparkline}
                        daysInMonth={velocityData.daysInMonth}
                        dayOfMonth={velocityData.dayOfMonth}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Legend */}
          <p className="text-[10px] text-muted-foreground/60 px-1">
            Pace curve derived from FY2025-26 actuals. Status scored after day 15 only.
            {velocityData.heads[0]?.hasDateData
              ? " Sparklines show daily bookings for the month."
              : " No date column detected in order sheet — sparklines unavailable."}
            {" "}Projected close = actual% &divide; expected% &times; 100.
            Own-pace reference is each head&rsquo;s typical pattern from FY2025-26.
          </p>
        </div>
      )}

      {/* Order Sheet tab inventory */}
      {!loading && data?.tabInventory && data.tabInventory.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <button
            onClick={() => setShowInventory((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/40 transition-colors rounded-lg"
          >
            <span>Order Sheet — Tab Breakdown</span>
            <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              {data.tabInventory.filter((r) => r.includedInSum).length} of{" "}
              {data.tabInventory.length} tabs included in total
              {showInventory ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </span>
          </button>

          {showInventory && (
            <div className="px-4 pb-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Every tab in the Order Sheet is listed below. Only monthly tabs (Apr, May, Jun,
                Jul, ...) are summed. Lookup tables (WT, INDEX) and combined summaries are
                excluded. The Litre Rule applies: litres (water tanks, Unit.Name = Ltr.) and
                pieces are tracked separately and must never be added together. The channel
                column (last column) identifies Retail vs Govt rows — schemes apply to Retail
                only.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Tab</th>
                      <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Role</th>
                      <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Rows</th>
                      <th className="text-left py-1.5 pr-3 font-medium text-muted-foreground">Dates</th>
                      <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Value</th>
                      <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Pieces</th>
                      <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Litres</th>
                      <th className="text-right py-1.5 pr-3 font-medium text-muted-foreground">Retail</th>
                      <th className="text-right py-1.5 font-medium text-muted-foreground">Govt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tabInventory.map((row) => (
                      <tr
                        key={row.tabName}
                        className={cn(
                          "border-b border-border/50 last:border-0",
                          row.includedInSum
                            ? "bg-transparent"
                            : "text-muted-foreground/70",
                        )}
                      >
                        <td className="py-1.5 pr-3 font-mono">
                          {row.tabName}
                          {row.includedInSum && (
                            <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 align-middle" />
                          )}
                        </td>
                        <td className="py-1.5 pr-3">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[10px] font-medium",
                              row.role === "monthly"
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                : row.role === "lookup"
                                  ? "bg-slate-500/10 text-slate-600 dark:text-slate-400"
                                  : row.role === "combined"
                                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                    : "bg-muted text-muted-foreground",
                            )}
                          >
                            {row.role}
                          </span>
                          {row.excludedReason && (
                            <span
                              className="ml-1.5 text-[10px] text-muted-foreground/60"
                              title={row.excludedReason}
                            >
                              (excluded)
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {row.rowCount > 0 ? row.rowCount.toLocaleString("en-IN") : "—"}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-[10px]">
                          {row.dateMin && row.dateMax
                            ? row.dateMin === row.dateMax
                              ? row.dateMin
                              : `${row.dateMin} – ${row.dateMax}`
                            : "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {row.taxableValue > 0 ? fmtCr(row.taxableValue) : "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {row.pieceRows > 0
                            ? `${row.pieceQty.toLocaleString("en-IN")} pcs`
                            : "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {row.ltrRows > 0
                            ? `${row.ltrQty.toLocaleString("en-IN")} L`
                            : "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {row.retailValue > 0 ? fmtCr(row.retailValue) : "—"}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">
                          {row.govtValue > 0 ? fmtCr(row.govtValue) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border font-medium">
                      <td className="py-1.5 pr-3" colSpan={4}>
                        Included total ({data.tabInventory.filter((r) => r.includedInSum).length} monthly tabs)
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {fmtCr(
                          data.tabInventory
                            .filter((r) => r.includedInSum)
                            .reduce((s, r) => s + r.taxableValue, 0),
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground text-[10px]">
                        {data.tabInventory
                          .filter((r) => r.includedInSum)
                          .reduce((s, r) => s + r.pieceQty, 0)
                          .toLocaleString("en-IN")}{" "}
                        pcs
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground text-[10px]">
                        {data.tabInventory
                          .filter((r) => r.includedInSum)
                          .reduce((s, r) => s + r.ltrQty, 0)
                          .toLocaleString("en-IN")}{" "}
                        L
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {fmtCr(
                          data.tabInventory
                            .filter((r) => r.includedInSum)
                            .reduce((s, r) => s + r.retailValue, 0),
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {fmtCr(
                          data.tabInventory
                            .filter((r) => r.includedInSum)
                            .reduce((s, r) => s + r.govtValue, 0),
                        )}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Green dot = included in company total. Litres (L) and pieces (pcs) are never
                added together. Govt value is excluded from scheme calculations. Retail +
                Govt = included total.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Pending orders operational note */}
      {!loading && data && data.companyPending > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <span className="text-sm font-medium">
              Pending Orders — Fulfilment Signal, Not a Sales Signal
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {fmtCr(data.companyPending)} of booked orders have not been
            dispatched. This is a stock / credit-hold / logistics issue — do not
            penalise the salesperson for it.
          </p>
          <p className="text-xs text-muted-foreground">
            Reconciliation: Booking {fmtCr(data.companyBooking)} &minus; Dispatched{" "}
            {fmtCr(data.companySale)} = Pending {fmtCr(data.companyPending)}
          </p>
        </div>
      )}
    </div>
  );
}
