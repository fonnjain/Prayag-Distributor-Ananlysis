import { trunc2 } from "@/lib/trunc";
import { LoadingState } from "@/components/ui/loading-state";
import { QuotaWaitBanner, quotaDelayMs, quotaOrThrow } from "./quotaWait";
import { SnapshotBanner, useSnapshotRefresh } from "./snapshotRefresh";
import { BAND_LABEL, BAND_BG } from "@/lib/achievementBands";
import { useState, useEffect, useMemo } from "react";
import { useGlobalFilter } from "@/data/global-filter-context";
import {
  Download,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  AlertTriangle,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

// ── Types ─────────────────────────────────────────────────────────────────────

type Member = {
  normKey: string;
  name: string;
  stateHead: string;
  state: string;
  hq: string;
  dojLabel: string | null;
  workingState: string;
  channel: string;
  oldNew: string;
  activeLeft: string;
  targetSecondary: number | null;
  targetPrimary: number | null;
  targetBusinessPlan: number | null;
  orderBooking: number | null;
  saleAmount: number | null;
  priorOrderBooking: number | null;
  totalRetailers: number | null;
  oldRetailers: number | null;
  newRetailers: number | null;
  distributorCount: number | null;
  directDealerCount: number | null;
  orderCount: number | null;
  achievementPct: number | null;
  band: string;
  /** Plan from STATE HEAD DASHBOARD (ytdPlan for the selected period). Canonical secondary target. */
  secondaryPlan: number | null;
  /** Achievement denominator — plan for fully-recorded closed months only. Undefined on older API versions. */
  secondaryPlanRecorded?: number | null;
  /** True when this member is listed in the Primary Team Members tab (no secondary target expected). */
  isPrimaryRole: boolean;
  /** True when this member is in the LEFT TEAM MEMBERS section (count in totals, never low-perf). */
  isLeft: boolean;
  visitedParties: number | null;
  workingDays: number | null;
  ctcMonthly: number | null;
  costRatioPct: number | null;
  designation: string | null;
  /** Primary order booking (booked orders) attributed to this member via distributor map */
  primaryOrderAmount: number | null;
  /** Primary dispatch sale attributed to this member via distributor map */
  primarySaleAmount: number | null;
  /** Count of Distributor-type parties mapped to this member */
  primaryDistributors: number | null;
  /** Count of Direct Dealer-type parties mapped to this member */
  primaryDirectDealers: number | null;
  /** Annual primary target (pre-split) so the UI can label "₹X = annual ₹Y × Z% seasonal share". */
  targetPrimaryAnnual: number | null;
  /** Annual business-plan target (pre-split). */
  targetBusinessPlanAnnual: number | null;
};

type DashboardMeta = {
  fy: string;
  monthFrom: number;
  monthTo: number;
  ordersAvailable: boolean;
  targetsAvailable: boolean;
  orderBookingNote: string | null;
  rosterSource: string;
  /** Head-level dispatched sale (Taxable Value), by STATE HEAD. */
  headSales?: Record<string, number>;
  /** Source label for the Sale (Dispatched) tile. */
  saleSource?: string | null;
  /** Head-level primary order booking (booked orders), by STATE HEAD. FY2026-27 only. */
  orderBookingPrimary?: Record<string, number>;
  /** Source label for the Order Booking (Primary) tile. */
  orderBookingPrimarySource?: string | null;
  /** Company-wide pending orders = orderBookingPrimary total minus headSales total. */
  pendingOrdersTotal?: number | null;
  /** Set when pendingOrdersTotal < 0 — explains why sale exceeded booking. */
  pendingOrdersTotalNote?: string | null;
  /**
   * True when Sale (Dispatched) is queried from sale_line for exactly the
   * selected period (not always a FY total).  Undefined on older API versions.
   */
  salePeriodFiltered?: boolean;
  /**
   * True when Order Booking (Primary) is filtered to the selected period via
   * per-tab reads (not a FY total).  Undefined on older API versions.
   */
  primaryBookingPeriodFiltered?: boolean;
  /** Raw sheet grand total for the OB (Primary) card — includes Non-territory rows. */
  primaryBookingRawTotal?: number;
  /** Raw sheet grand total for Sale (Dispatched) — includes Non-territory rows. */
  saleRawTotal?: number;
  /** Source label for secondary Order Booking tile. */
  orderBookingSource?: string | null;
  /** "state_head_dashboard" when secondary data comes from the authoritative STATE HEAD DASHBOARD sheet. */
  secondarySource?: string | null;
  /** Company-level totals from the STATE HEAD DASHBOARD (all months, all members, anomaly months included). */
  secondaryTotal?: {
    plan: number;
    orderBooked: number;
    salesReceived: number;
    /** Achievement denominator — plan for fully-recorded closed months only. */
    planRecorded?: number;
    ytdAchievement: number | null;
    totalDealers: number;
    sheetTotals: { orderBooked: number | null; salesReceived: number | null } | null;
  } | null;
  /** Attribution diagnostics — null until the distributor-TM map is warm. */
  primaryAttributionDiagnostics?: {
    distMapAvailable: boolean;
    orderBookingAvailable: boolean;
    dispatchSaleAvailable: boolean;
    totalOrderRows: number;
    attributedOrderRows: number;
    totalOrderAmount: number;
    attributedOrderAmount: number;
    attributionPct: number | null;
  } | null;
  /** Diagnostic from the dashboard xlsx target-to-roster join. */
  targetMatchDiagnostic?: {
    xlsxRowCount: number;
    matchedCount: number;
    unmatchedRows: Array<{ name: string; target: number | null }>;
  } | null;
  /**
   * Seasonal calibration metadata.  Includes the monthly shares (Apr=0..Mar=11) used to
   * split annual primary/business-plan targets.  Null when the server is pre-patch.
   * SINGLE-YEAR CALIBRATION: derived from FY2025-26 actuals only.
   */
  seasonalCalibration?: {
    fy: string;
    derivedFrom: string;
    monthly: number[];
    quarterly: number[];
    monthNames: string[];
  } | null;
  /** Cold-start snapshot freshness — see snapshotRefresh.tsx. */
  snapshotSavedAt?: number;
  refreshing?: boolean;
};

type DashboardData = { rows: Member[]; meta: DashboardMeta };

type View = "data" | "lowPerf" | "summary" | "secondary" | "primary";

type SortState = { key: string; dir: "asc" | "desc" };

// ── Constants ─────────────────────────────────────────────────────────────────

type Period = { label: string; from: number; to: number };

const PERIODS: Period[] = [
  { label: "Q1 (Apr-Jun)", from: 1, to: 3 },
  { label: "Q2 (Jul-Sep)", from: 4, to: 6 },
  { label: "Q3 (Oct-Dec)", from: 7, to: 9 },
  { label: "Q4 (Jan-Mar)", from: 10, to: 12 },
  { label: "Full Year", from: 1, to: 12 },
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
];

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

// Shared band scale — single source of truth in lib/achievementBands.ts.

const VIEWS: { id: View; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "lowPerf", label: "Low Performers" },
  { id: "summary", label: "Summary by Head" },
  { id: "secondary", label: "Secondary" },
  { id: "primary", label: "Primary" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCr(n: number | null, digits = 2): string {
  if (n == null) return "—";
  return `\u20b9${trunc2(n / 1e7)} Cr`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${trunc2((n * 100))}%`;
}

function fmtN(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

function sortedRows<T extends Record<string, unknown>>(
  rows: T[],
  { key, dir }: SortState,
): T[] {
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp =
      typeof av === "string"
        ? (av as string).localeCompare(bv as string)
        : (av as number) - (bv as number);
    return dir === "asc" ? cmp : -cmp;
  });
}

function isLowPerf(band: string, threshold: number): boolean {
  if (band === "noTarget") return false;
  if (threshold <= 25) return band === "below25";
  return band === "below25" || band === "below50";
}

function isPrimary(m: Member): boolean {
  return m.channel.toLowerCase().includes("primary");
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BandChip({ band }: { band: string }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${BAND_BG[band] ?? BAND_BG.noTarget}`}
    >
      {BAND_LABEL[band] ?? band}
    </span>
  );
}

function KpiTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 flex flex-col gap-0.5 min-w-[120px]">
      <p className="text-xs text-muted-foreground font-medium">{label}</p>
      <p className="text-lg font-bold leading-tight">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  className = "",
  title,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  className?: string;
  title?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide cursor-pointer select-none whitespace-nowrap ${className}`}
      onClick={() => onSort(sortKey)}
      title={title}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {title && <Info className="h-3 w-3 opacity-60 shrink-0" />}
        {active ? (
          sort.dir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </span>
    </th>
  );
}

function Th({ label, className = "" }: { label: string; className?: string }) {
  return (
    <th className={`px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap ${className}`}>
      {label}
    </th>
  );
}

function Td({
  children,
  className = "",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-3 py-2 text-sm whitespace-nowrap ${className}`} title={title}>
      {children}
    </td>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function StateHeadDashboard() {
  // FY + period driven by the global filter context (GlobalFilterBar handles UI).
  const {
    fy,
    effectivePeriodFrom,
    effectivePeriodTo,
    effectivePeriodLabel,
    effectivePrimaryPeriodTo,
    setAvailableFys,
  } = useGlobalFilter();
  // Stable Period object for secondary data — only changes when the primitive values change.
  // Secondary uses effectivePeriodTo (last COMPLETE month) because the State Head Dashboard
  // records actuals at month-end; secPeriod() on the server enforces this gate.
  const period: Period = useMemo(
    () => ({ label: effectivePeriodLabel, from: effectivePeriodFrom, to: effectivePeriodTo }),
    [effectivePeriodFrom, effectivePeriodTo, effectivePeriodLabel],
  );

  // Primary data (sale_line, Order Sheet) accumulates continuously through the
  // current month.  effectivePrimaryPeriodTo already accounts for:
  //   • open FY YTD  → currentIdx + 1 (includes the live in-progress month)
  //   • closed FY YTD → 12 (full year — no partial range on historical FYs)
  //   • all other modes → same as effectivePeriodTo
  const primaryMonthTo = effectivePrimaryPeriodTo;

  // Short range labels used in KPI tile sub-lines.
  const primaryPeriodLabel: string = (() => {
    const f = FISCAL_MONTH_NAMES[effectivePeriodFrom - 1];
    const t = FISCAL_MONTH_NAMES[primaryMonthTo - 1];
    return f === t ? f : `${f}–${t}`;
  })();
  const secPeriodLabel: string = (() => {
    const f = FISCAL_MONTH_NAMES[effectivePeriodFrom - 1];
    const t = FISCAL_MONTH_NAMES[effectivePeriodTo - 1];
    return f === t ? f : `${f}–${t}`;
  })();

  const [stateHeadFilter, setStateHeadFilter] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [activeView, setActiveView] = useState<View>("data");
  const [lowPerfThreshold, setLowPerfThreshold] = useState(50);
  const [sort, setSort] = useState<SortState>({ key: "achievementPct", dir: "asc" });

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // True while Google Sheets is briefly rate-limiting reads (503 quota);
  // a retry is scheduled automatically after the server's retryAfter hint.
  const [quotaWait, setQuotaWait] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  // Cold-start snapshot: while meta.refreshing is true the server is rebuilding
  // from live sources in the background — poll silently and swap the fresh
  // figures in without a loading state.
  const dataUrl = `/api/mgmt/data?fy=${encodeURIComponent(fy)}&monthFrom=${effectivePeriodFrom}&monthTo=${primaryMonthTo}`;
  useSnapshotRefresh(data?.meta, dataUrl, (fresh) => setData(fresh as DashboardData));

  // Load FY options once — also populate the global filter's available FYs.
  useEffect(() => {
    fetch("/api/mgmt/options")
      .then((r) => r.json())
      .then((d: { fys?: string[] }) => {
        if (Array.isArray(d.fys) && d.fys.length > 0) {
          setAvailableFys(d.fys);
        }
      })
      .catch(() => {});
  }, [setAvailableFys]);

  // Fetch dashboard data when FY or period changes.
  // Uses an AbortController so that rapid filter changes cancel in-flight requests.
  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(null);
    setQuotaWait(false);
    // Never leave the previous selection's figures on screen while the new
    // period loads — stale numbers for the wrong year are worse than a spinner.
    setData(null);
    const params = new URLSearchParams({
      fy,
      monthFrom: String(effectivePeriodFrom),
      monthTo: String(primaryMonthTo),
    });
    fetch(`/api/mgmt/data?${params}`, { signal: controller.signal })
      .then(async (r) => {
        const q = await quotaOrThrow(r);
        if (q) {
          setQuotaWait(true);
          setLoading(false);
          retryTimer = setTimeout(
            () => setRetryTick((t) => t + 1),
            quotaDelayMs(q.retryAfter),
          );
          return null;
        }
        return r.json() as Promise<DashboardData>;
      })
      .then((d) => {
        if (d === null) return;
        setData(d);
        setLoading(false);
        setStateHeadFilter("");
        setSearch("");
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return; // stale request — ignore
        setError(e.message);
        setLoading(false);
      });
    return () => {
      controller.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  // Primitive deps — stable comparison via Object.is.
  }, [fy, effectivePeriodFrom, primaryMonthTo, retryTick]);

  function toggleSort(key: string) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  }

  async function downloadExcel() {
    setDownloading(true);
    try {
      const res = await fetch("/api/mgmt/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fy,
          monthFrom: period.from,
          monthTo: primaryMonthTo,
          lowPerfPct: lowPerfThreshold,
          states: stateHeadFilter ? [stateHeadFilter] : [],
          regions: [],
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
        throw new Error(e.error ?? "Excel generation failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `StateHeadDashboard_${fy}_${period.label.replace(/[^A-Za-z0-9]+/g, "_")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  // Clear employee selection whenever the state head changes.
  useEffect(() => {
    setEmployeeFilter("");
  }, [stateHeadFilter]);

  // Derived data
  const allHeads = useMemo(
    () =>
      data
        ? [...new Set(data.rows.map((r) => r.stateHead).filter(Boolean))].sort()
        : [],
    [data],
  );

  /** Members belonging to the currently selected state head — drives the Employee dropdown. */
  const membersForHead = useMemo(() => {
    if (!data || !stateHeadFilter) return [];
    return data.rows
      .filter((r) => r.stateHead === stateHeadFilter)
      .map((r) => ({ normKey: r.normKey, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, stateHeadFilter]);

  const filteredRows = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (stateHeadFilter && r.stateHead !== stateHeadFilter) return false;
      if (employeeFilter && r.normKey !== employeeFilter) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.stateHead.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [data, stateHeadFilter, employeeFilter, search]);

  const lowPerfRows = useMemo(
    () => filteredRows.filter((r) => isLowPerf(r.band, lowPerfThreshold)),
    [filteredRows, lowPerfThreshold],
  );

  const summaryByHead = useMemo(() => {
    const map = new Map<
      string,
      {
        head: string;
        count: number;
        target: number;
        booking: number;
        sale: number;
        retailers: number;
        lowPerf: number;
        noTarget: number;
      }
    >();
    for (const r of filteredRows) {
      const head = r.stateHead || "Unknown";
      let s = map.get(head);
      if (!s) {
        s = { head, count: 0, target: 0, booking: 0, sale: 0, retailers: 0, lowPerf: 0, noTarget: 0 };
        map.set(head, s);
      }
      s.count++;
      s.target += r.secondaryPlan ?? r.targetSecondary ?? 0;
      s.booking += r.orderBooking ?? 0;
      s.sale += r.saleAmount ?? 0;
      s.retailers += r.totalRetailers ?? 0;
      if (r.band === "noTarget") s.noTarget++;
      else if (isLowPerf(r.band, lowPerfThreshold)) s.lowPerf++;
    }
    // Override per-head Sale with authoritative head-level data from the primary
    // dispatch sheet (meta.headSales). Member saleAmount is null when the Sale
    // source is head-level only, so the member-sum above would be 0 for those heads.
    const headSales = data?.meta.headSales;
    if (headSales) {
      for (const [, s] of map) {
        const fromMeta = headSales[s.head];
        if (fromMeta != null) s.sale = fromMeta;
      }
    }
    return [...map.values()].sort((a, b) => b.booking - a.booking);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows, lowPerfThreshold, data?.meta.headSales]);

  // KPI aggregates over all filtered rows (regardless of active view)
  const kpi = useMemo(() => {
    // Target: prefer STATE HEAD DASHBOARD Plan column over Target Master (canonical source).
    const target = filteredRows.reduce((s, r) => s + (r.secondaryPlan ?? r.targetSecondary ?? 0), 0);
    const booking = filteredRows.reduce((s, r) => s + (r.orderBooking ?? 0), 0);
    // Secondary sales received (saleAmount = sec.ytdSalesReceived from STATE HEAD DASHBOARD).
    const secSalesReceived = filteredRows.reduce((s, r) => s + (r.saleAmount ?? 0), 0);
    // Sale (dispatched): use post-processed summaryByHead totals when head-level
    // data is available from meta (so stateHeadFilter is respected correctly).
    const sale = data?.meta.headSales
      ? summaryByHead.reduce((s, h) => s + h.sale, 0)
      : filteredRows.reduce((s, r) => s + (r.saleAmount ?? 0), 0);

    // Primary order booking (booked orders) — sum across filtered heads
    const filteredHeadKeys = new Set(filteredRows.map((r) => r.stateHead));
    const obMeta = data?.meta.orderBookingPrimary;
    const primaryOrderBooking = obMeta
      ? Object.entries(obMeta)
          .filter(([h]) => filteredHeadKeys.size === 0 || filteredHeadKeys.has(h))
          .reduce((s, [, v]) => s + v, 0)
      : null;
    // Pending orders = order booking (booked) minus sale (dispatched)
    const pendingOrders =
      primaryOrderBooking != null && sale > 0 ? primaryOrderBooking - sale : null;

    // Low performers: exclude primary-role and left members (no secondary target expected).
    const lowPerf = filteredRows.filter((r) => isLowPerf(r.band, lowPerfThreshold) && !r.isPrimaryRole && !r.isLeft).length;
    // No-target count: exclude primary-role (no secondary target expected) and left members.
    const noTarget = filteredRows.filter((r) => r.band === "noTarget" && !r.isPrimaryRole && !r.isLeft).length;
    // Achievement = secondary sales received / plan (STATE HEAD DASHBOARD, recomputed).
    // Falls back to order booked / target when state dashboard is unavailable.
    const hasStateDash = data?.meta.secondarySource === "state_head_dashboard";
    // Use the sheet-level sales total (all months, no anomaly exclusion) for the headline
    // achievement tile.  Per-member ytdSalesReceived excludes anomaly months, which causes
    // the row-sum to undershoot the sheet figure by several crore.  meta.secondaryTotal is
    // the authoritative number that matches what managers see in the sheet directly.
    const secSalesForAch =
      hasStateDash && (data?.meta.secondaryTotal?.salesReceived ?? 0) > 0
        ? data!.meta.secondaryTotal!.salesReceived
        : secSalesReceived;
    // Company-level achievement: prefer the server figure (secondaryTotal.ytdAchievement) —
    // its numerator (recorded sales) and denominator (recorded-month plan) use the SAME
    // closed-month set.  Dividing period sales by the full period plan understates
    // achievement whenever the period includes months with no recorded sales yet
    // (e.g. full-FY view early in the year).  Null (no fully-recorded months) renders "—".
    const st = data?.meta.secondaryTotal;
    // The server figure is company-wide — only use it when no member/head filter
    // narrows the row set (otherwise fall back to the filtered row computation).
    const isFiltered = Boolean(stateHeadFilter || employeeFilter || search.trim());
    const useServerAch = hasStateDash && st != null && !isFiltered;
    // Filtered views: use the per-member recorded-months denominator
    // (secondaryPlanRecorded) so achievement uses the same basis as the
    // company tile — recorded sales ÷ plan of recorded months only.
    // Undefined on older API versions → fall back to the full-period plan.
    const hasPlanRecorded =
      hasStateDash && filteredRows.some((r) => r.secondaryPlanRecorded !== undefined);
    const planRecordedSum = hasPlanRecorded
      ? filteredRows.reduce((s, r) => s + (r.secondaryPlanRecorded ?? 0), 0)
      : null;
    const achPct = useServerAch
      ? st.ytdAchievement
      : isFiltered && planRecordedSum != null
        // No fully-recorded months in the period → null renders "—".
        ? (planRecordedSum > 0 ? secSalesReceived / planRecordedSum : null)
        : target > 0
          ? (hasStateDash && secSalesForAch > 0 ? secSalesForAch / target : booking / target)
          : null;
    // True when the achievement denominator excludes months (not yet recorded) —
    // the UI shows a "vs. recorded months' plan" note, matching Secondary Performance.
    const achClosedMonthsOnly = useServerAch
      ? st.planRecorded != null && st.planRecorded > 0 && st.planRecorded < st.plan - 1
      : isFiltered && planRecordedSum != null && planRecordedSum > 0 && planRecordedSum < target - 1;
    return {
      target,
      booking,
      sale,
      primaryOrderBooking,
      pendingOrders,
      achPct,
      achClosedMonthsOnly,
      members: filteredRows.length,
      lowPerf,
      noTarget,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows, lowPerfThreshold, summaryByHead, data?.meta.headSales, data?.meta.orderBookingPrimary, data?.meta.secondarySource, data?.meta.secondaryTotal, stateHeadFilter, employeeFilter, search]);

  /**
   * Seasonal calibration context for the selected period.
   * Used to label primary-target cells with their derivation basis (Rule 3).
   */
  const seasonalInfo = useMemo(() => {
    const cal = data?.meta.seasonalCalibration;
    if (!cal) return null;
    const from0 = (data?.meta.monthFrom ?? 1) - 1; // 0-based fiscal index
    const to0   = (data?.meta.monthTo   ?? 12) - 1;
    const months = to0 - from0 + 1;
    const share  = cal.monthly.slice(from0, to0 + 1).reduce((s, v) => s + v, 0);
    const flatShare = (months / 12) * 100;
    const periodLabel = cal.monthNames.slice(from0, to0 + 1).join("-");
    return { cal, share, flatShare, months, periodLabel };
  }, [
    data?.meta.seasonalCalibration,
    data?.meta.monthFrom,
    data?.meta.monthTo,
  ]);

  // Rows to render for each view (after sort)
  function viewRows(): Member[] {
    let rows =
      activeView === "lowPerf"
        ? lowPerfRows
        : activeView === "secondary"
          ? filteredRows.filter((r) => !isPrimary(r))
          : activeView === "primary"
            ? filteredRows.filter(isPrimary)
            : filteredRows;
    return sortedRows(rows as unknown as Record<string, unknown>[], sort) as unknown as Member[];
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  // True when secondary data is available from the STATE HEAD DASHBOARD (authoritative)
  // or from an uploaded order file (legacy FY2025-26 and earlier).
  // Replaces the old ordersAvailable gate which only covered uploaded files.
  const hasSecondaryData =
    data?.meta.secondarySource === "state_head_dashboard" ||
    (data?.meta.ordersAvailable ?? false);

  // openInPeriod uses the primary period (which includes the current open month
  // in YTD mode) so the banner fires whenever primary figures are provisional.
  const openInPeriod = openFiscalMonthsInPeriod(fy, period.from, primaryMonthTo);

  return (
    <div className="flex flex-col gap-4 p-4 pb-8">
      <SnapshotBanner meta={data?.meta} />
      {/* Filter bar — FY & period driven by GlobalFilterBar in page header */}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">State Head</label>
          <Select value={stateHeadFilter || "__all__"} onValueChange={(v) => setStateHeadFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-44 text-sm">
              <SelectValue placeholder="All heads" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All heads</SelectItem>
              {allHeads.map((h) => (
                <SelectItem key={h} value={h}>
                  {h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Employee dropdown — only visible when a specific head is selected */}
        {stateHeadFilter && membersForHead.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Employee</label>
            <Select
              value={employeeFilter || "__all__"}
              onValueChange={(v) => setEmployeeFilter(v === "__all__" ? "" : v)}
            >
              <SelectTrigger className="h-8 w-52 text-sm">
                <SelectValue placeholder="All employees" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All employees</SelectItem>
                {membersForHead.map((m) => (
                  <SelectItem key={m.normKey} value={m.normKey}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {(activeView === "lowPerf") && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">Threshold</label>
            <Select
              value={String(lowPerfThreshold)}
              onValueChange={(v) => setLowPerfThreshold(Number(v))}
            >
              <SelectTrigger className="h-8 w-28 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">Below 25%</SelectItem>
                <SelectItem value="50">Below 50%</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">Search</label>
          <Input
            className="h-8 w-48 text-sm"
            placeholder="Name or head..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={downloadExcel}
            disabled={downloading || loading}
          >
            <Download className="h-3.5 w-3.5" />
            {downloading ? "Generating..." : "Download Excel"}
          </Button>
        </div>
      </div>

      {/* Status / notes */}
      {openInPeriod.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            {openInPeriod.join(", ")} {openInPeriod.length === 1 ? "is" : "are"} still in
            progress — this period includes partial current-month data. Prior-year figures for
            the same month{openInPeriod.length > 1 ? "s" : ""} are complete. Year-on-year
            comparisons covering {openInPeriod.length === 1 ? "this month" : "these months"} are
            provisional until the month closes. For like-for-like comparison use Q1 (Apr–Jun).
          </span>
        </div>
      )}
      {data?.meta.orderBookingNote && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{data.meta.orderBookingNote}</span>
        </div>
      )}
      {data?.meta.rosterSource === "fallback" && (
        <div className="flex items-start gap-2 rounded-md border border-orange-200 bg-orange-50 dark:border-orange-900/40 dark:bg-orange-950/20 px-3 py-2 text-sm text-orange-800 dark:text-orange-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Roster loaded from bundled fallback — Google Sheets may be unavailable. Data may be outdated.</span>
        </div>
      )}
      {quotaWait && <QuotaWaitBanner testId="banner-quota-wait-dashboard" />}
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* KPI tiles */}
      {data && (
        <div className="flex flex-wrap gap-3">
          <KpiTile label="Members" value={fmtN(kpi.members)} sub={`${kpi.noTarget} no target`} />
          <KpiTile label={`Target (${period.label})`} value={fmtCr(kpi.target > 0 ? kpi.target : null)} />
          <KpiTile
            label="Order Booking (Secondary)"
            value={hasSecondaryData ? fmtCr(kpi.booking) : "—"}
            sub={`${secPeriodLabel}${data.meta.orderBookingSource ? ` · ${data.meta.orderBookingSource}` : ""}`}
          />
          <KpiTile
            label="Sales Received"
            value={
              hasSecondaryData && (data.meta.secondaryTotal?.salesReceived ?? 0) > 0
                ? fmtCr(data.meta.secondaryTotal!.salesReceived)
                : "—"
            }
            sub={`${secPeriodLabel} · Secondary, state head dashboard`}
          />
          <KpiTile
            label="Achievement"
            value={hasSecondaryData && kpi.achPct != null ? fmtPct(kpi.achPct) : "—"}
            sub={`${secPeriodLabel} · Sales Received ÷ Plan${kpi.achClosedMonthsOnly ? " · vs. recorded months' plan" : ""}`}
          />
          <KpiTile label="Low Performers" value={fmtN(kpi.lowPerf)} sub={`<${lowPerfThreshold}% threshold`} />
          {(() => {
            // isSubYear uses primaryMonthTo — that's the actual period sent to the
            // server for primary data (may differ from effectivePeriodTo in YTD mode).
            const isSubYear = period.from !== 1 || primaryMonthTo !== 12;
            const saleFilt = data.meta.salePeriodFiltered;
            const saleSub =
              saleFilt === false && isSubYear
                ? "FY total — period filter not applied"
                : (data.meta.saleSource ?? undefined);
            const obFilt = data.meta.primaryBookingPeriodFiltered;
            const obSub =
              obFilt === false && isSubYear
                ? "FY total — period filter not applied"
                : (data.meta.orderBookingPrimarySource ?? undefined);
            return (
              <>
                <KpiTile
                  label="Sale (Dispatched)"
                  value={fmtCr(data.meta.saleRawTotal ?? (kpi.sale > 0 ? kpi.sale : null))}
                  sub={`${primaryPeriodLabel}${saleSub ? ` · ${saleSub}` : ""}`}
                />
                <KpiTile
                  label="Order Booking (Primary)"
                  value={fmtCr(data.meta.primaryBookingRawTotal ?? kpi.primaryOrderBooking)}
                  sub={`${primaryPeriodLabel}${obSub ? ` · ${obSub}` : ""}`}
                />
              </>
            );
          })()}
          <KpiTile
            label="Pending Orders"
            value={fmtCr(data.meta.pendingOrdersTotal ?? kpi.pendingOrders)}
            sub={
              data.meta.pendingOrdersTotalNote
                ? `${primaryPeriodLabel} · ${data.meta.pendingOrdersTotalNote}`
                : `${primaryPeriodLabel}${kpi.primaryOrderBooking != null ? " · Order Booking minus Dispatched" : ""}`
            }
          />
        </div>
      )}

      {/* View tabs */}
      <div className="flex gap-1 border-b pb-0">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setActiveView(v.id)}
            className={`px-3 py-1.5 text-sm font-medium rounded-t transition-colors ${
              activeView === v.id
                ? "border border-b-background bg-background text-foreground -mb-px"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {v.id === "lowPerf"
              ? `Low Performers${data ? ` (${lowPerfRows.length})` : ""}`
              : v.label}
          </button>
        ))}
      </div>

      {/* Loading skeleton */}
      {loading && <LoadingState className="py-16" />}

      {/* ── Summary by Head view ── */}
      {!loading && data && activeView === "summary" && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <Th label="State Head" />
                <Th label="Members" className="text-right" />
                <Th label="Target" className="text-right" />
                <Th label="Order Booking" className="text-right" />
                <Th label="Ach%" className="text-right" />
                <Th label="Sale" className="text-right" />
                <Th label="Retailers" className="text-right" />
                <Th label={`Low Perf (<${lowPerfThreshold}%)`} className="text-right" />
                <Th label="No Target" className="text-right" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {summaryByHead.map((s) => {
                const pct = s.target > 0 ? s.booking / s.target : null;
                return (
                  <tr key={s.head} className="hover:bg-muted/30 transition-colors">
                    <Td className="font-medium">{s.head}</Td>
                    <Td className="text-right">{fmtN(s.count)}</Td>
                    <Td className="text-right">{fmtCr(s.target || null)}</Td>
                    <Td className="text-right">
                      {hasSecondaryData ? fmtCr(s.booking || null) : "—"}
                    </Td>
                    <Td className="text-right">
                      {hasSecondaryData ? fmtPct(pct) : "—"}
                    </Td>
                    <Td className="text-right">{fmtCr(s.sale || null)}</Td>
                    <Td className="text-right">{fmtN(s.retailers || null)}</Td>
                    <Td className="text-right">{fmtN(s.lowPerf || null)}</Td>
                    <Td className="text-right">{fmtN(s.noTarget || null)}</Td>
                  </tr>
                );
              })}
              {summaryByHead.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No data.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Primary view ── */}
      {!loading && data && activeView === "primary" && (
        <div className="overflow-x-auto rounded-lg border">
          {data.meta.primaryAttributionDiagnostics && (
            <div className="px-3 py-2 text-xs text-muted-foreground border-b bg-muted/30">
              {data.meta.primaryAttributionDiagnostics.distMapAvailable
                ? `Primary attribution: ${
                    data.meta.primaryAttributionDiagnostics.attributionPct != null
                      ? `${trunc2((data.meta.primaryAttributionDiagnostics.attributionPct * 100))}% of order value attributed to named members`
                      : "distributor map loaded"
                  }`
                : "Distributor map loading in background — per-member primary columns will populate on next refresh."}
            </div>
          )}
          {!data.meta.primaryAttributionDiagnostics && (
            <div className="px-3 py-2 text-xs text-muted-foreground border-b bg-muted/30">
              Distributor map building in background — per-member primary columns will populate on next refresh.
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <SortTh label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                <SortTh label="State Head" sortKey="stateHead" sort={sort} onSort={toggleSort} />
                <Th label="State" />
                <Th label="HQ" />
                <SortTh label="Distributors" sortKey="primaryDistributors" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Direct Dealers" sortKey="primaryDirectDealers" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh
                  label="Target (Primary)"
                  sortKey="targetPrimary"
                  sort={sort}
                  onSort={toggleSort}
                  className="text-right"
                  title={
                    seasonalInfo
                      ? `Split seasonally from annual — not ÷12. ${seasonalInfo.periodLabel} (${seasonalInfo.months} months) carries ${trunc2((seasonalInfo.share * 100))}% of annual vs ${trunc2(seasonalInfo.flatShare)}% flat. Calibrated from FY${seasonalInfo.cal.fy} actuals (single year).`
                      : undefined
                  }
                />
                <SortTh label="Order Booking" sortKey="primaryOrderAmount" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Sale (Dispatched)" sortKey="primarySaleAmount" sort={sort} onSort={toggleSort} className="text-right" />
                <Th label="Old/New" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {viewRows().map((r) => (
                <tr key={r.normKey} className="hover:bg-muted/30 transition-colors">
                  <Td className="font-medium">{r.name}</Td>
                  <Td className="text-muted-foreground">{r.stateHead}</Td>
                  <Td>{r.state}</Td>
                  <Td>{r.hq}</Td>
                  <Td className="text-right">{fmtN(r.primaryDistributors)}</Td>
                  <Td className="text-right">{fmtN(r.primaryDirectDealers)}</Td>
                  <Td
                    className="text-right"
                    title={
                      r.targetPrimaryAnnual != null && r.targetPrimary != null && seasonalInfo
                        ? `${seasonalInfo.periodLabel} target ₹${trunc2((r.targetPrimary / 1e7))} Cr = annual ₹${trunc2((r.targetPrimaryAnnual / 1e7))} Cr × ${trunc2((seasonalInfo.share * 100))}% seasonal share (flat ÷12 × ${seasonalInfo.months} = ₹${trunc2((r.targetPrimaryAnnual / 12 * seasonalInfo.months / 1e7))} Cr; FY${seasonalInfo.cal.fy} calibration)`
                        : undefined
                    }
                  >
                    {fmtCr(r.targetPrimary)}
                  </Td>
                  <Td className="text-right">{fmtCr(r.primaryOrderAmount)}</Td>
                  <Td className="text-right">{fmtCr(r.primarySaleAmount)}</Td>
                  <Td>{r.oldNew}</Td>
                </tr>
              ))}
              {viewRows().length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No primary team members found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Data / Low Performers / Secondary views (same table structure) ── */}
      {!loading && data && activeView !== "summary" && activeView !== "primary" && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <SortTh label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                <SortTh label="State Head" sortKey="stateHead" sort={sort} onSort={toggleSort} />
                <Th label="State" />
                <Th label="Old/New" />
                <SortTh label="Target" sortKey="targetSecondary" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Order Booking" sortKey="orderBooking" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Prior Booking" sortKey="priorOrderBooking" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Ach%" sortKey="achievementPct" sort={sort} onSort={toggleSort} className="text-right" />
                <Th label="Band" />
                <SortTh label="Sale" sortKey="saleAmount" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Retailers" sortKey="totalRetailers" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="New Ret." sortKey="newRetailers" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Visits" sortKey="visitedParties" sort={sort} onSort={toggleSort} className="text-right" />
                <SortTh label="Working Days" sortKey="workingDays" sort={sort} onSort={toggleSort} className="text-right" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {viewRows().map((r) => (
                <tr
                  key={r.normKey}
                  className={`hover:bg-muted/30 transition-colors ${r.isLeft ? "opacity-60" : ""}`}
                >
                  <Td className="font-medium">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      {r.name}
                      {r.isLeft && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 border border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800">
                          Left
                        </span>
                      )}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{r.stateHead}</Td>
                  <Td>{r.state}</Td>
                  <Td>{r.oldNew}</Td>
                  <Td className="text-right">{fmtCr(r.targetSecondary)}</Td>
                  <Td className="text-right">
                    {hasSecondaryData ? fmtCr(r.orderBooking) : "—"}
                  </Td>
                  <Td className="text-right">{fmtCr(r.priorOrderBooking)}</Td>
                  <Td className="text-right">
                    {hasSecondaryData ? fmtPct(r.achievementPct) : "—"}
                  </Td>
                  <Td>
                    <BandChip band={r.band} />
                  </Td>
                  <Td className="text-right">{fmtCr(r.saleAmount)}</Td>
                  <Td className="text-right">{fmtN(r.totalRetailers)}</Td>
                  <Td className="text-right">{fmtN(r.newRetailers)}</Td>
                  <Td className="text-right">{fmtN(r.visitedParties)}</Td>
                  <Td className="text-right">{fmtN(r.workingDays)}</Td>
                </tr>
              ))}
              {viewRows().length === 0 && (
                <tr>
                  <td
                    colSpan={14}
                    className="px-3 py-6 text-center text-sm text-muted-foreground"
                  >
                    {activeView === "lowPerf"
                      ? `No members below the ${lowPerfThreshold}% threshold.`
                      : "No data."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Row count footer */}
      {!loading && data && activeView !== "summary" && (
        <p className="text-xs text-muted-foreground text-right">
          {viewRows().length} of {filteredRows.length} members
        </p>
      )}
    </div>
  );
}
