// Sales Deep Dive — Phase 1 + Phase 2
// Phase 1: STATE HEAD DASHBOARD 'Data' tab KPIs (source A).
// Phase 2: member's own working sheet retailer-level detail (source B).
// Direct Dealer order kept separate from retailer/party OB throughout.
// Achievement always recomputed (sale / plan); never read from a sheet % cell.
import { Loader2 } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { QuotaWaitBanner, quotaDelayMs, quotaOrThrow } from "./quotaWait";
import { cn } from "@/lib/utils";
import { achBandBg, achBandText } from "@/lib/achievementBands";
import { SalesPersonReport } from "./SalesPersonReport";
import { useGlobalFilter, isFyClosed } from "@/data/global-filter-context";

const BASE = import.meta.env.BASE_URL ?? "/";
const API = `${BASE}api`.replace(/\/\//g, "/");

// ── Types ─────────────────────────────────────────────────────────────────────

interface MemberRef {
  stateHead: string;
  name: string;
  normKey: string;
}

interface MemberKpis {
  stateHead: string;
  name: string;
  normKey: string;
  hq: string | null;
  designation: string | null;
  contact: string | null;
  // Targets (all "to date" / monthly — NOT annual)
  primaryTarget: number | null;           // G: primary YTD target to date
  secondaryTarget: number | null;         // H: secondary YTD target to date
  monthlyTarget: number | null;           // BE: total monthly target
  primaryTargetMonthly: number | null;    // BK: primary monthly target
  secondaryTargetMonthly: number | null;  // Derived: BE − BK
  totalTargetToDate: number | null;       // BM: total target to date
  elapsedMonths: number | null;           // Derived: round(BM / BE)
  orderBooking: number | null;
  directDealersOrder: number | null;
  sale: number | null;
  // 4 achievement ratios (achievementPct = achievementSale for compat)
  achievementPct: number | null;
  achievementSecondary: number | null;
  achievementDirectDealer: number | null;
  achievementTotal: number | null;
  achievementSale: number | null;
  // Prior year quarterly actuals
  lastYearQ1: number | null;
  lastYearQ2: number | null;
  lastYearQ3: number | null;
  lastYearQ4: number | null;
  ctcMonthly: number | null;
  ctcAnnual: number | null;
  taBillStCost: number | null;
  costRatio: number | null;
  totalOldRetailers: number | null;
  visitedRetailers: number | null;
  nonVisitedRetailers: number | null;
  newPartyOrderBooking: number | null;
  businessPerRetailer: number | null;
  totalRetailers: number | null;
  directDealersCount: number | null;
  extra: Record<string, number | string | null>;
}

// Per-month actuals from the member's own FY tab.
interface MonthActual {
  month: string;              // "Apr" | "May" | ... | "Mar"
  plan: number | null;
  orderBooking: number | null;
  sale: number | null;
}

interface RetailerRow {
  name: string;
  district: string | null;
  city: string | null;
  distributor: string | null;
  distanceKm: number | null;
  businessPlan: number | null;
  visitsRequired: number | null;
  orderBooking: number;
  sale: number;
  totalVisit: number | null;
  achievementPct: number | null;
  isActive: boolean;
}

interface RetailerSpread {
  totalRetailers: number;
  activeRetailers: number;
  dormantRetailers: number;
  activePct: number;
  totalOrderBooking: number;
  totalSale: number;
  totalVisits: number | null;
  top5ObShare: number | null;
  top10ObShare: number | null;
  concentrationIndex: number | null;
  businessPerActiveRetailer: number | null;
  businessPerVisit: number | null;
  annualBusinessPlan: number | null;
}

type RetailerDetailStatus = "ok" | "not-mapped" | "error" | "loading";

interface RetailerDetail {
  status: RetailerDetailStatus;
  error?: string | null;
  fileId?: string | null;
  tabName?: string | null;
  rows?: RetailerRow[];
  spread?: RetailerSpread;
  visitPlan?: VisitPlan | null;
  months?: MonthActual[] | null;   // Phase 7: per-month actuals from FY tab
  rowsRead?: number | null;
}

// ── Phase 3 types ──────────────────────────────────────────────────────────────

interface DistanceBucket {
  label: string;
  minKm: number;
  maxKm: number | null;
  count: number;
  visitsDone: number;
  avgVisits: number;
  avgOb: number;
  activeCount: number;
}

interface VisitPattern {
  totalVisitsDone: number;
  totalVisitsRequired: number;
  proRatedRequired: number;
  visitDeficit: number;
  visitedZeroOrderCount: number;
  visitedZeroOrderRetailers: string[];
  distanceBuckets: DistanceBucket[];
}

interface HistoricalFyCapacity {
  fy: string;
  totalRetailers: number;
  totalVisitsRequired: number;
  totalVisitsDone: number;
  coveragePct: number;
}

interface VisitCapacity {
  fyStartDate: string;
  dataWindowEndDate: string;
  dataCutoffWorkingDays: number;
  demonstratedVisitsPerDay: number;
  annualCapacityAnchor: number;
  anchorFy: string;
  feasibleRemainingVisits: number;
  remainingRequired: number;
  gap: number;
  workingDaysRemaining: number;
  monthlyCapacity: number;
}

interface VisitTarget {
  name: string;
  district: string | null;
  distanceKm: number | null;
  ob: number;
  businessPlan: number | null;
  visitsDone: number;
  priority: "maintain" | "develop" | "reduce";
  reason: string;
}

interface MonthVisitPlan {
  month: string;
  workingDays: number;
  capacity: number;
  maintenanceVisits: number;
  developmentVisits: number;
  targets: VisitTarget[];
}

interface VisitPlan {
  pattern: VisitPattern;
  capacity: VisitCapacity;
  historicalFyCapacity: HistoricalFyCapacity[];
  monthPlans: MonthVisitPlan[];
  totalFeasible: number;
  totalRequired: number;
  gap: number;
}

interface RoiCost {
  ctcMonthly: number;
  taBillYtd: number;
  elapsedCompleteMonths: number;
  ctcCostYtd: number;
  totalCost: number;
  obToCostMultiple: number | null;
  saleToCostMultiple: number | null;
  costPerRetailer: number | null;
  costPerVisit: number | null;
  costPerActiveRetailer: number | null;
  costRatioPct: number | null;
  marginRoiAvailable: false;
}

// ── Phase 5 types ──────────────────────────────────────────────────────────────

interface SegmentNet {
  segment: string;
  net: number;
  pct: number;
}

interface SkuSpread {
  isLiveYear: boolean;
  liveYearNote?: string | null;
  totalRows?: number | null;
  totalNet?: number | null;
  distinctSegments?: number | null;
  totalKnownSegments?: number | null;
  coveragePct?: number | null;
  netBySegment?: SegmentNet[] | null;
  crossSellDepth?: number | null;
  concentrationHhi?: number | null;
}

// ── Phase 6 types ──────────────────────────────────────────────────────────────

interface WinBackItem {
  customer: string;
  lastActiveFy: string;
  lastActiveMonth: string;
  lastNet: number;
}

// ── Team-summary types (mirrors API TeamSummary / StateBreakdownRow) ──────────

interface StateBreakdownRow {
  state: string;
  memberCount: number;
  membersWithTarget: number;
  targetTotal: number;
  obTotal: number;
  saleTotal: number;
  visitTotal: number;
  headlinePct: number | null;
  likeForLikePct: number | null;
  zeroTargetCount: number;
  zeroTargetOb: number;
}

interface TeamSummary {
  totalMembers: number;
  activeMembers: number;
  leftMembers: number;
  zeroTargetActiveCount: number;
  zeroTargetActiveOb: number;
  zeroTargetActiveNames: string[];
  totalTarget: number;
  totalOB: number;
  totalSale: number;
  totalVisits: number;
  totalRetailers: number;
  directDealerOB: number;
  headlineAchievementPct: number | null;
  likeForLikeAchievementPct: number | null;
  byState: StateBreakdownRow[];
}

interface DeepDiveData {
  fy: string;
  stateHeads: string[];
  members: MemberRef[];
  kpis: MemberKpis | null;
  teamSummary: TeamSummary | null;
  retailerDetail: RetailerDetail | null;
  roiCost: RoiCost | null;
  skuSpread: SkuSpread | null;
  winBack: WinBackItem[] | null;
  rowsRead: number;
  /** Unix ms timestamp when the Data tab was last read from Google Sheets (or DB snapshot). */
  dataReadAt?: number | null;
  error: string | null;
  fromDbSnapshot?: boolean | null;
  /** True when the server served the last saved snapshot because Google Sheets
   *  was briefly busy — figures may be slightly out of date. */
  stale?: boolean | null;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtRs(v: number | null | undefined): string {
  if (v == null) return "—";
  if (Math.abs(v) >= 1_00_00_000)
    return `Rs ${(v / 1_00_00_000).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1_00_000)
    return `Rs ${(v / 1_00_000).toFixed(2)} L`;
  return `Rs ${v.toLocaleString("en-IN")}`;
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("en-IN");
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toFixed(1)}%`;
}

// Whole-rupee formatter for per-unit cost metrics (no decimal places).
function fmtRsWhole(v: number | null | undefined): string {
  if (v == null) return "—";
  const r = Math.round(v);
  if (Math.abs(r) >= 1_00_00_000) return `Rs ${(r / 1_00_00_000).toFixed(0)} Cr`;
  if (Math.abs(r) >= 1_00_000) return `Rs ${(r / 1_00_000).toFixed(0)} L`;
  return `Rs ${r.toLocaleString("en-IN")}`;
}

// ── Band colour for achievement / active% ─────────────────────────────────────

// Shared band scale — single source of truth in lib/achievementBands.ts.
const achieveBand = achBandBg;

function activeBand(pct: number): string {
  if (pct >= 60) return "text-green-700 dark:text-green-400";
  if (pct >= 40) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Tile({
  label, value, sub, accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 flex flex-col gap-1",
        accent
          ? "border-primary/40 bg-primary/5"
          : "border-border bg-card",
      )}
    >
      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
        {label}
      </span>
      <span className="text-lg font-semibold leading-tight">{value}</span>
      {sub && (
        <span className="text-[11px] text-muted-foreground">{sub}</span>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <h3 className="col-span-full text-xs font-semibold uppercase tracking-widest text-muted-foreground pt-2 pb-1 border-b border-border">
      {children}
    </h3>
  );
}

// HHI bar visualisation: 0–10000 → 0–100% width.
function ConcentrationBar({ hhi }: { hhi: number }) {
  const pct = Math.min(100, (hhi / 10000) * 100);
  const colour =
    hhi > 2500 ? "bg-red-500" : hhi > 1500 ? "bg-amber-400" : "bg-green-500";
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
        <div
          className={cn("h-full rounded-full", colour)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums">
        HHI {Math.round(hhi)}
      </span>
    </div>
  );
}

// ── Achievement text colour (for table cells, not pill badges) ────────────────

// Shared band scale — single source of truth in lib/achievementBands.ts.
const achieveBandText = achBandText;

// ── Team summary panel (SD1: shown when a state head is chosen, no member) ────

function fmtReadAt(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

// ── Retailer-count drift (typed vs sheet) — maintenance signal per head ──────

type MemberDrift = {
  name: string;
  normKey: string;
  isLeft: boolean;
  status: "ok" | "loading" | "not-mapped" | "no-typed-count" | "error";
  typed: number | null;
  sheet: number | null;
  drift: number | null;
  direction: "IN_SYNC" | "SHEET_EXCEEDS_TYPED" | "TYPED_EXCEEDS_SHEET" | null;
};

type RetailerDriftReport = {
  fy: string;
  stateHead: string;
  tolerance: number;
  members: MemberDrift[];
  summary: {
    comparable: number;
    pending: number;
    notMapped: number;
    inSync: number;
    sheetExceedsTyped: number;
    typedExceedsSheet: number;
    netDrift: number;
    typedTotal: number;
    sheetTotal: number;
  };
};

function RetailerDriftPanel({ fy, stateHead }: { fy: string; stateHead: string }) {
  const [report, setReport] = useState<RetailerDriftReport | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      setDriftLoading(true);
      setDriftError(null);
      try {
        const params = new URLSearchParams({ fy, stateHead });
        const r = await fetch(`${API}/mgmt/retailer-drift?${params}`);
        if (cancelled) return;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d: RetailerDriftReport = await r.json();
        if (cancelled) return;
        setReport(d);
        // Cold-cache member sheets come back as "loading" — poll until settled.
        if (d.summary.pending > 0) retryTimer = setTimeout(load, 20000);
      } catch {
        if (!cancelled) setDriftError("Could not load the retailer count check.");
      } finally {
        if (!cancelled) setDriftLoading(false);
      }
    };
    load();
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [fy, stateHead]);

  if (driftError) return null; // non-essential panel — fail quiet
  if (!report && driftLoading) {
    return (
      <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        Checking retailer counts against member sheets…
      </div>
    );
  }
  if (!report || report.summary.comparable === 0) return null;

  const s = report.summary;
  const outOfSync = report.members.filter(
    (m) => m.status === "ok" && m.direction !== "IN_SYNC",
  ).sort((a, b) => Math.abs(b.drift ?? 0) - Math.abs(a.drift ?? 0));

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-baseline justify-between gap-3 flex-wrap">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Retailer Count Maintenance — typed vs member sheets
        </p>
        <p className="text-[11px] text-muted-foreground">
          {s.comparable} member{s.comparable !== 1 ? "s" : ""} checked
          {s.pending > 0 ? ` · ${s.pending} still loading` : ""}
          {s.notMapped > 0 ? ` · ${s.notMapped} without a sheet` : ""}
        </p>
      </div>
      <div className="px-4 py-3 space-y-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>Sheets: <strong>{s.sheetTotal.toLocaleString()}</strong> retailers</span>
          <span>Typed (Data tab): <strong>{s.typedTotal.toLocaleString()}</strong></span>
          <span className={s.netDrift === 0 ? "" : s.netDrift < 0 ? "text-amber-700 dark:text-amber-400" : "text-orange-700 dark:text-orange-400"}>
            Net drift: <strong>{s.netDrift > 0 ? "+" : ""}{s.netDrift}</strong>
          </span>
          <span className="text-muted-foreground">{s.inSync} in sync (±{report.tolerance})</span>
        </div>

        {s.sheetExceedsTyped > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {s.sheetExceedsTyped} member{s.sheetExceedsTyped !== 1 ? "s" : ""} — typed count is behind the sheet:
            the Data tab column is not being kept up to date as retailers are added.
          </p>
        )}
        {s.typedExceedsSheet > 0 && (
          <p className="text-xs text-orange-700 dark:text-orange-400 font-medium">
            {s.typedExceedsSheet} member{s.typedExceedsSheet !== 1 ? "s" : ""} — typed count EXCEEDS the sheet:
            the State Head believes there are retailers the member has not recorded. That is a coverage
            gap, not a bookkeeping error.
          </p>
        )}

        {outOfSync.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th className="px-3 py-1.5 text-left">Member</th>
                  <th className="px-3 py-1.5 text-right">Sheet rows</th>
                  <th className="px-3 py-1.5 text-right">Typed</th>
                  <th className="px-3 py-1.5 text-right">Drift</th>
                  <th className="px-3 py-1.5 text-left">Reading</th>
                </tr>
              </thead>
              <tbody>
                {outOfSync.map((m) => (
                  <tr key={m.normKey} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-1.5">{m.name}{m.isLeft ? " (left)" : ""}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{m.sheet}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{m.typed}</td>
                    <td className={`px-3 py-1.5 text-right ${m.direction === "TYPED_EXCEEDS_SHEET" ? "text-orange-700 dark:text-orange-400" : "text-amber-700 dark:text-amber-400"}`}>
                      {(m.drift ?? 0) > 0 ? "+" : ""}{m.drift}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {m.direction === "TYPED_EXCEEDS_SHEET"
                        ? "Possible unrecorded retailers"
                        : "Typed column under-maintained"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Sheet rows = serial-numbered retailers in the member&rsquo;s working sheet (the fresher source).
          Typed = the count entered on the Dashboard Data tab. Both are kept; this drift is a
          maintenance signal for the State Head, not an app calculation.
        </p>
      </div>
    </div>
  );
}

function TeamSummaryPanel({ summary, dataReadAt }: { summary: TeamSummary; dataReadAt: number | null }) {
  return (
    <div className="space-y-4">

      {/* Identity + achievement header */}
      <div className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold">Team Summary</p>
            <p className="text-sm text-muted-foreground">
              {summary.activeMembers} active member{summary.activeMembers !== 1 ? "s" : ""}
              {summary.leftMembers > 0 && ` · ${summary.leftMembers} LEFT`}
              {summary.zeroTargetActiveCount > 0 && ` · ${summary.zeroTargetActiveCount} with no target`}
            </p>
            {dataReadAt ? (
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                Data read: {fmtReadAt(dataReadAt)}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            {summary.headlineAchievementPct != null && (
              <div className={cn("rounded-full px-3 py-1 text-xs font-semibold", achieveBand(summary.headlineAchievementPct))}>
                {fmtPct(summary.headlineAchievementPct)} headline OB
              </div>
            )}
            {summary.likeForLikeAchievementPct != null && (
              <div className={cn("rounded-full px-3 py-1 text-xs font-semibold", achieveBand(summary.likeForLikeAchievementPct))}>
                {fmtPct(summary.likeForLikeAchievementPct)} like-for-like
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Zero-target notice */}
      {summary.zeroTargetActiveCount > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-50/60 px-4 py-3 text-sm dark:bg-amber-900/10">
          <p className="font-medium text-amber-800 dark:text-amber-300">
            {summary.zeroTargetActiveCount} active member
            {summary.zeroTargetActiveCount !== 1 ? "s have" : " has"} no target recorded
            — carrying {fmtRs(summary.zeroTargetActiveOb)} of order booking.
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
            Headline includes their OB but contributes no target denominator.
            Like-for-like excludes them entirely.
          </p>
          {summary.zeroTargetActiveNames.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              {summary.zeroTargetActiveNames.join(" · ")}
            </p>
          )}
        </div>
      )}

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <SectionLabel>Team Totals</SectionLabel>
        <Tile label="Total Target (to date)" value={fmtRs(summary.totalTarget)} accent />
        <Tile label="Order Booking" value={fmtRs(summary.totalOB)} />
        <Tile label="Sales Received" value={fmtRs(summary.totalSale)} />
        <Tile label="Total Visits" value={fmtNum(summary.totalVisits)} />
        <Tile label="Total Retailers" value={fmtNum(summary.totalRetailers)} sub="Source: Dashboard Data tab (typed by State Head)" />
        {summary.directDealerOB > 0 && (
          <Tile label="Direct Dealer OB" value={fmtRs(summary.directDealerOB)} />
        )}
      </div>

      {/* State breakdown */}
      {summary.byState.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              By State
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-left">State</th>
                  <th className="px-3 py-2 text-right">Members</th>
                  <th className="px-3 py-2 text-right">Target</th>
                  <th className="px-3 py-2 text-right">OB</th>
                  <th className="px-3 py-2 text-right">Sales</th>
                  <th className="px-3 py-2 text-right">Headline</th>
                  <th className="px-3 py-2 text-right">Like-for-like</th>
                </tr>
              </thead>
              <tbody>
                {summary.byState.map((row) => (
                  <tr key={row.state} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">{row.state}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{row.memberCount}</td>
                    <td className="px-3 py-2 text-right">{row.targetTotal > 0 ? fmtRs(row.targetTotal) : <span className="text-muted-foreground text-xs">no target</span>}</td>
                    <td className="px-3 py-2 text-right">{fmtRs(row.obTotal)}</td>
                    <td className="px-3 py-2 text-right">{fmtRs(row.saleTotal)}</td>
                    <td className="px-3 py-2 text-right">
                      {row.headlinePct != null ? (
                        <span className={achieveBandText(row.headlinePct)}>
                          {fmtPct(row.headlinePct)}
                          {row.zeroTargetCount > 0 && (
                            <span className="ml-1 text-amber-600 dark:text-amber-400" title={`${row.zeroTargetCount} member(s) with no target inflate this figure`}>⚠</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">no target</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.likeForLikePct != null ? (
                        <span className={achieveBandText(row.likeForLikePct)}>
                          {fmtPct(row.likeForLikePct)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                      {row.zeroTargetCount > 0 && (
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {row.zeroTargetCount} w/o target
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}

// ── Retailer spread panel (Phase 2) ───────────────────────────────────────────

function RetailerSpreadPanel({ spread }: { spread: RetailerSpread }) {
  const { isFyClosedValue } = useGlobalFilter();
  const toDateLabel = isFyClosedValue ? "FY" : "YTD";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">

        <SectionLabel>Retailer Activity (re-derived from working sheet)</SectionLabel>

        {/* Counts */}
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Total Retailers
          </span>
          <span className="text-lg font-semibold">{spread.totalRetailers}</span>
          <span className="text-[10px] text-muted-foreground leading-tight">
            Source: member working sheet rows (excl. Removed Parties)
          </span>
          <div className="flex gap-3 text-[11px] mt-0.5">
            <span className={cn("font-medium", activeBand(spread.activePct))}>
              {spread.activeRetailers} active ({fmtPct(spread.activePct)})
            </span>
            <span className="text-muted-foreground">
              {spread.dormantRetailers} dormant
            </span>
          </div>
        </div>

        {/* Totals (cross-check with Phase 1) */}
        <Tile
          label="Total Order Booking (re-derived)"
          value={fmtRs(spread.totalOrderBooking)}
          sub="Sum of retailer OB from working sheet"
          accent
        />
        <Tile
          label="Total Sale Received (re-derived)"
          value={fmtRs(spread.totalSale)}
          sub="Should match Dashboard KPI"
          accent
        />
        {spread.totalVisits != null && (
          <Tile
            label={`Total Visits (${toDateLabel})`}
            value={fmtNum(spread.totalVisits)}
          />
        )}

        {/* Concentration */}
        <SectionLabel>Order Booking Concentration</SectionLabel>

        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Effective Retailers
          </span>
          <span className="text-lg font-semibold">
            {spread.concentrationIndex != null && spread.concentrationIndex > 0
              ? (10000 / spread.concentrationIndex).toFixed(1)
              : "—"}
          </span>
          <span className="text-[11px] text-muted-foreground">
            10,000 ÷ HHI — equivalent equal-size retailers
          </span>
          {spread.concentrationIndex != null && (
            <span className="text-[10px] text-muted-foreground">
              Raw HHI: {Math.round(spread.concentrationIndex).toLocaleString("en-IN")}
            </span>
          )}
          {spread.concentrationIndex != null && (
            <ConcentrationBar hhi={spread.concentrationIndex} />
          )}
        </div>

        {spread.top5ObShare != null && (
          <Tile
            label="Top-5 Retailers OB Share"
            value={fmtPct(spread.top5ObShare)}
            sub="Share of total order booking"
          />
        )}
        {spread.top10ObShare != null && (
          <Tile
            label="Top-10 Retailers OB Share"
            value={fmtPct(spread.top10ObShare)}
            sub="Share of total order booking"
          />
        )}

        {/* Per-unit metrics */}
        <SectionLabel>Per-Unit Metrics</SectionLabel>

        {spread.businessPerActiveRetailer != null && (
          <Tile
            label="Business per Active Retailer"
            value={fmtRs(spread.businessPerActiveRetailer)}
            sub="Total OB / active retailers"
            accent
          />
        )}
        {spread.businessPerVisit != null && (
          <Tile
            label="Business per Visit"
            value={fmtRs(spread.businessPerVisit)}
            sub="Total OB / total visits"
          />
        )}
        {spread.annualBusinessPlan != null && (
          <Tile
            label="Annual Business Plan (sheet)"
            value={fmtRs(spread.annualBusinessPlan)}
            sub="From member's own FY tab"
          />
        )}
      </div>
    </div>
  );
}

// ── Retailer table (Phase 2) ──────────────────────────────────────────────────

function RetailerTable({ rows }: { rows: RetailerRow[] }) {
  const [showDormant, setShowDormant] = useState(false);

  const visible = showDormant ? rows : rows.filter((r) => r.isActive);
  // Sort by OB desc.
  const sorted = [...visible].sort((a, b) => b.orderBooking - a.orderBooking);

  const dormantCount = rows.filter((r) => !r.isActive).length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Retailer Table ({rows.length} total · sorted by Order Booking)
        </h3>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            className="rounded"
            checked={showDormant}
            onChange={(e) => setShowDormant(e.target.checked)}
          />
          Show {dormantCount} dormant
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50 text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Retailer</th>
              <th className="px-3 py-2 text-left font-medium">District</th>
              <th className="px-3 py-2 text-left font-medium">City</th>
              <th className="px-3 py-2 text-right font-medium">OB</th>
              <th className="px-3 py-2 text-right font-medium">Sale</th>
              <th className="px-3 py-2 text-right font-medium">Plan</th>
              <th className="px-3 py-2 text-right font-medium">Visits</th>
              <th className="px-3 py-2 text-right font-medium">Ach%</th>
              <th className="px-3 py-2 text-left font-medium">Distributor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((r, i) => (
              <tr
                key={`${r.name}-${i}`}
                className={cn(
                  "hover:bg-muted/30 transition-colors",
                  !r.isActive && "opacity-50",
                )}
              >
                <td className="px-3 py-1.5 text-muted-foreground tabular-nums">
                  {i + 1}
                </td>
                <td className="px-3 py-1.5 font-medium max-w-[160px] truncate">
                  {r.name}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground">{r.district ?? "—"}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{r.city ?? "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                  {r.orderBooking > 0 ? fmtRs(r.orderBooking) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.sale > 0 ? fmtRs(r.sale) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.businessPlan != null ? fmtRs(r.businessPlan) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.totalVisit != null ? fmtNum(r.totalVisit) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.achievementPct != null ? (
                    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", achieveBand(r.achievementPct))}>
                      {fmtPct(r.achievementPct)}
                    </span>
                  ) : "—"}
                </td>
                <td className="px-3 py-1.5 text-muted-foreground max-w-[120px] truncate">
                  {r.distributor ?? "—"}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                  {showDormant ? "No retailers found." : "No active retailers. Enable 'Show dormant' to see all."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Phase 3 components ────────────────────────────────────────────────────────

function gapColour(gap: number): string {
  if (gap >= 0) return "text-green-700 dark:text-green-400";
  if (gap >= -100) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

function VisitBar({
  done, proRated, required,
}: { done: number; proRated: number; required: number }) {
  const donePct    = required > 0 ? Math.min(100, (done / required) * 100) : 0;
  const proRatePct = required > 0 ? Math.min(100, (proRated / required) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>Visits done: <strong className="text-foreground">{fmtNum(done)}</strong></span>
        <span>Pro-rated target: <strong className="text-foreground">{fmtNum(proRated)}</strong></span>
        <span>Annual required: <strong className="text-foreground">{fmtNum(required)}</strong></span>
      </div>
      <div className="relative h-3 rounded-full bg-muted overflow-hidden">
        {/* Pro-rated target marker */}
        <div
          className="absolute top-0 h-full w-0.5 bg-amber-400 z-10"
          style={{ left: `${proRatePct}%` }}
        />
        {/* Done bar */}
        <div
          className={cn(
            "h-full rounded-full transition-all",
            donePct >= proRatePct ? "bg-green-500" : "bg-amber-500",
          )}
          style={{ width: `${donePct}%` }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground">
        Amber marker = pro-rated target for FY portion elapsed
      </div>
    </div>
  );
}

function VisitPatternPanel({ pattern }: { pattern: VisitPattern }) {
  const { isFyClosedValue } = useGlobalFilter();
  const toDateLabel = isFyClosedValue ? "FY" : "YTD";
  const [showZeroList, setShowZeroList] = useState(false);

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
        Visit Pattern Analysis
      </h3>

      <VisitBar
        done={pattern.totalVisitsDone}
        proRated={pattern.proRatedRequired}
        required={pattern.totalVisitsRequired}
      />

      {/* Visit deficit tile */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label={`Visits Done (${toDateLabel})`} value={fmtNum(pattern.totalVisitsDone)} accent />
        <Tile label="Annual Required" value={fmtNum(pattern.totalVisitsRequired)} />
        <Tile
          label="Pro-Rated Target (elapsed)"
          value={fmtNum(pattern.proRatedRequired)}
          sub={pattern.visitDeficit > 0
            ? `${fmtNum(pattern.visitDeficit)} behind schedule`
            : `${fmtNum(-pattern.visitDeficit)} ahead`}
        />
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Visited — Zero OB
          </span>
          <span className={cn(
            "text-lg font-semibold",
            pattern.visitedZeroOrderCount > 0 ? "text-amber-600 dark:text-amber-400" : "",
          )}>
            {pattern.visitedZeroOrderCount}
          </span>
          <span className="text-[11px] text-muted-foreground">
            Visited {pattern.visitedZeroOrderCount}x · zero order booked
          </span>
          {pattern.visitedZeroOrderCount > 0 && (
            <button
              className="text-[11px] text-primary underline underline-offset-2 text-left mt-0.5"
              onClick={() => setShowZeroList((v) => !v)}
            >
              {showZeroList ? "Hide list" : "Show list"}
            </button>
          )}
        </div>
      </div>

      {showZeroList && pattern.visitedZeroOrderRetailers.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 px-4 py-3">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-2">
            Retailers visited but with zero order booked ({pattern.visitedZeroOrderRetailers.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {pattern.visitedZeroOrderRetailers.map((name, i) => (
              <span
                key={i}
                className="rounded px-2 py-0.5 text-[11px] bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300"
              >
                {name}
              </span>
            ))}
          </div>
          <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-2">
            These retailers received visits but placed no orders. Redirect effort toward high-potential dormant parties.
          </p>
        </div>
      )}

      {/* Distance buckets */}
      {pattern.distanceBuckets.some((b) => b.count > 0) && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Distance band</th>
                <th className="px-3 py-2 text-right font-medium">Retailers</th>
                <th className="px-3 py-2 text-right font-medium">Active</th>
                <th className="px-3 py-2 text-right font-medium">Visits done</th>
                <th className="px-3 py-2 text-right font-medium">Avg visits</th>
                <th className="px-3 py-2 text-right font-medium">Avg OB</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pattern.distanceBuckets.map((b) => (
                <tr key={b.label} className="hover:bg-muted/30">
                  <td className="px-3 py-1.5 font-medium">{b.label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{b.count}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-green-700 dark:text-green-400">
                    {b.activeCount}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(b.visitsDone)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{b.avgVisits.toFixed(1)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtRs(b.avgOb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CapacityPanel({
  capacity, historicalFyCapacity, gap,
}: { capacity: VisitCapacity; historicalFyCapacity: HistoricalFyCapacity[]; gap: number }) {
  const isShortfall = gap < 0;

  // Sort historical descending so most recent FY is first.
  const histSorted = [...historicalFyCapacity].sort((a, b) => b.fy.localeCompare(a.fy));

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
        Visit Capacity Model
      </h3>

      {/* Anchor explanation */}
      <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground leading-relaxed">
        <span className="font-medium text-foreground">Capacity anchor: </span>
        FY{capacity.anchorFy} demonstrated{" "}
        <span className="font-semibold text-foreground">{fmtNum(capacity.annualCapacityAnchor)}</span>{" "}
        visits over the full year. Using this as the annual budget avoids projecting a quarterly pace
        that excludes leave, festivals and slower periods.
        <span className="block mt-1">
          <span className="font-medium text-foreground">Pace check (Q1): </span>
          {fmtNum(capacity.dataCutoffWorkingDays)} Mon–Sat days (data window ends {capacity.dataWindowEndDate}) ·{" "}
          <span className="font-semibold text-foreground">{capacity.demonstratedVisitsPerDay.toFixed(2)} visits/day</span>
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <Tile
          label={`FY${capacity.anchorFy} annual capacity`}
          value={fmtNum(capacity.annualCapacityAnchor)}
          sub="Demonstrated visits — full closed year"
          accent
        />
        <Tile
          label="Done this FY"
          value={fmtNum(capacity.annualCapacityAnchor - capacity.feasibleRemainingVisits)}
          sub={`Data window ends ${capacity.dataWindowEndDate}`}
        />
        <Tile
          label="Remaining capacity"
          value={fmtNum(capacity.feasibleRemainingVisits)}
          sub={`Anchor minus done · ~${fmtNum(capacity.monthlyCapacity)} / month`}
        />
        <Tile
          label="Remaining required"
          value={fmtNum(capacity.remainingRequired)}
          sub="Annual total minus visits already done"
        />
      </div>

      {/* Gap — always shown explicitly, never hidden */}
      <div className={cn(
        "rounded-lg border px-5 py-4 flex flex-col gap-1",
        isShortfall
          ? "border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/10"
          : "border-green-200 bg-green-50 dark:border-green-900/40 dark:bg-green-900/10",
      )}>
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {isShortfall ? "Visit shortfall" : "Visit surplus"}
        </span>
        <span className={cn("text-2xl font-bold", gapColour(gap))}>
          {isShortfall ? "" : "+"}{fmtNum(gap)}
        </span>
        <p className={cn("text-xs mt-0.5", isShortfall ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400")}>
          {isShortfall
            ? `Remaining capacity (${fmtNum(capacity.feasibleRemainingVisits)}) is ${fmtNum(-gap)} short of the ${fmtNum(capacity.remainingRequired)} visits still required. The gap is structural — he has never met the visit requirement — not this year's lapse.`
            : `Remaining capacity (${fmtNum(capacity.feasibleRemainingVisits)}) exceeds what is still required by ${fmtNum(gap)} visits.`}
        </p>
      </div>

      {/* 3-year historical panel */}
      {histSorted.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
            Three-Year Coverage History
          </h4>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">FY</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Retailers</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Required</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Done</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {histSorted.map((h) => (
                  <tr key={h.fy} className="border-b border-border last:border-0 hover:bg-muted/10">
                    <td className="px-3 py-2 font-medium">FY{h.fy}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(h.totalRetailers)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(h.totalVisitsRequired)}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmtNum(h.totalVisitsDone)}</td>
                    <td className={cn(
                      "px-3 py-2 text-right font-semibold",
                      h.coveragePct >= 80 ? "text-green-700 dark:text-green-400"
                        : h.coveragePct >= 60 ? "text-amber-700 dark:text-amber-400"
                        : "text-red-700 dark:text-red-400",
                    )}>
                      {h.coveragePct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
                {/* Current FY projection row */}
                <tr className="bg-muted/20 border-t-2 border-border">
                  <td className="px-3 py-2 font-medium text-muted-foreground">
                    FY{capacity.anchorFy.replace(/\d{2}-/, (m) => {
                      const y = parseInt(m) + 1;
                      return `${y}-`;
                    })} (proj.)
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {fmtNum(capacity.remainingRequired + (capacity.annualCapacityAnchor - capacity.feasibleRemainingVisits))}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {fmtNum(capacity.annualCapacityAnchor)} if anchor repeats
                  </td>
                  <td className={cn(
                    "px-3 py-2 text-right font-semibold",
                    capacity.annualCapacityAnchor > 0 &&
                    (capacity.remainingRequired + (capacity.annualCapacityAnchor - capacity.feasibleRemainingVisits)) > 0
                      ? ((capacity.annualCapacityAnchor /
                          (capacity.remainingRequired + (capacity.annualCapacityAnchor - capacity.feasibleRemainingVisits))) * 100) >= 80
                          ? "text-green-700 dark:text-green-400"
                          : ((capacity.annualCapacityAnchor /
                              (capacity.remainingRequired + (capacity.annualCapacityAnchor - capacity.feasibleRemainingVisits))) * 100) >= 60
                              ? "text-amber-700 dark:text-amber-400"
                              : "text-red-700 dark:text-red-400"
                      : "text-muted-foreground",
                  )}>
                    {capacity.annualCapacityAnchor > 0 &&
                     (capacity.remainingRequired + (capacity.annualCapacityAnchor - capacity.feasibleRemainingVisits)) > 0
                      ? `~${((capacity.annualCapacityAnchor /
                          (capacity.remainingRequired + (capacity.annualCapacityAnchor - capacity.feasibleRemainingVisits))) * 100).toFixed(0)}%`
                      : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            He has never met the visit requirement. Coverage fell in FY{histSorted[0]?.fy} because the
            requirement per retailer was raised sharply while his actual effort rose year-on-year.
            With the requirement now reduced, repeating last year's effort would be his best coverage in three years.
          </p>
        </div>
      )}
    </div>
  );
}

function priorityBadge(p: VisitTarget["priority"]) {
  if (p === "maintain")
    return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
  if (p === "develop")
    return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
}

function ForwardPlanPanel({
  monthPlans, totalFeasible, totalRequired, gap,
}: { monthPlans: MonthVisitPlan[]; totalFeasible: number; totalRequired: number; gap: number }) {
  const [openMonth, setOpenMonth] = useState<string | null>(null);

  if (monthPlans.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        No remaining complete months in this FY.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
        Forward Visit Plan ({monthPlans.length} months)
      </h3>

      {/* Summary totals */}
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Total feasible (plan)" value={fmtNum(totalFeasible)} accent />
        <Tile label="Total required" value={fmtNum(totalRequired)} />
        <div className={cn(
          "rounded-lg border px-4 py-3 flex flex-col gap-1",
          gap < 0 ? "border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/10" : "border-green-200 bg-green-50 dark:border-green-900/40 dark:bg-green-900/10",
        )}>
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            {gap < 0 ? "Shortfall" : "Surplus"}
          </span>
          <span className={cn("text-lg font-semibold", gapColour(gap))}>
            {gap < 0 ? "" : "+"}{fmtNum(gap)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            Feasible − required
          </span>
        </div>
      </div>

      {/* Month-by-month table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50 text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Month</th>
              <th className="px-3 py-2 text-right font-medium">Working days</th>
              <th className="px-3 py-2 text-right font-medium">Capacity</th>
              <th className="px-3 py-2 text-right font-medium">Maintenance</th>
              <th className="px-3 py-2 text-right font-medium">Development</th>
              <th className="px-3 py-2 text-left font-medium">Top targets</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {monthPlans.map((m) => (
              <>
                <tr
                  key={m.month}
                  className="hover:bg-muted/30 cursor-pointer"
                  onClick={() => setOpenMonth(openMonth === m.month ? null : m.month)}
                >
                  <td className="px-3 py-1.5 font-medium">{m.month}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                    {m.workingDays}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                    {fmtNum(m.capacity)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-blue-700 dark:text-blue-400">
                    {fmtNum(m.maintenanceVisits)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-green-700 dark:text-green-400">
                    {fmtNum(m.developmentVisits)}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {m.targets.slice(0, 2).map((t) => t.name).join(", ")}
                    {m.targets.length > 2 ? ` +${m.targets.length - 2}` : ""}
                    <span className="ml-1 text-[10px] text-primary">
                      {openMonth === m.month ? "(collapse)" : "(expand)"}
                    </span>
                  </td>
                </tr>
                {openMonth === m.month && m.targets.length > 0 && (
                  <tr key={`${m.month}-targets`}>
                    <td colSpan={6} className="px-3 py-2 bg-muted/20">
                      <div className="space-y-1">
                        {m.targets.map((t, i) => (
                          <div key={i} className="flex items-start gap-2 text-[11px]">
                            <span className={cn("rounded px-1.5 py-0.5 font-medium shrink-0", priorityBadge(t.priority))}>
                              {t.priority}
                            </span>
                            <span className="font-medium">{t.name}</span>
                            {t.district && (
                              <span className="text-muted-foreground">{t.district}</span>
                            )}
                            {t.distanceKm != null && (
                              <span className="text-muted-foreground">{t.distanceKm} km</span>
                            )}
                            <span className="text-muted-foreground ml-auto">{t.reason}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/50 font-medium">
              <td className="px-3 py-1.5">Total</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                {fmtNum(monthPlans.reduce((s, m) => s + m.workingDays, 0))}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(totalFeasible)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-blue-700 dark:text-blue-400">
                {fmtNum(monthPlans.reduce((s, m) => s + m.maintenanceVisits, 0))}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-green-700 dark:text-green-400">
                {fmtNum(monthPlans.reduce((s, m) => s + m.developmentVisits, 0))}
              </td>
              <td className={cn("px-3 py-1.5 font-bold", gapColour(gap))}>
                {gap < 0 ? `${fmtNum(-gap)} visits short` : `${fmtNum(gap)} surplus`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Maintenance = active retailers at monthly cadence. Development = dormant high-potential sorted by plan / km.
        Target list batched by district + distance. Click a month to expand its retailer list.
      </p>
    </div>
  );
}

// ── Phase 5 components ────────────────────────────────────────────────────────

function hhiLabel(hhi: number): { label: string; colour: string } {
  if (hhi < 2500) return { label: "Diversified", colour: "text-green-700 dark:text-green-400" };
  if (hhi < 5000) return { label: "Moderate", colour: "text-amber-700 dark:text-amber-400" };
  return { label: "Concentrated", colour: "text-red-700 dark:text-red-400" };
}

function SkuSpreadPanel({ spread }: { spread: SkuSpread }) {
  if (spread.isLiveYear) {
    return (
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
          Segment Spread (Secondary Register)
        </h3>
        <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          {spread.liveYearNote ?? "Segment data will populate once a FY2026-27 secondary register is ingested."}
        </div>
      </div>
    );
  }

  const segments = spread.netBySegment ?? [];
  const total = spread.totalNet ?? 0;
  const distinct = spread.distinctSegments ?? 0;
  const universe = spread.totalKnownSegments ?? 0;
  const coveragePct = spread.coveragePct ?? 0;
  const hhi = spread.concentrationHhi ?? 0;
  const hhiInfo = hhiLabel(hhi);

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
        Segment Spread (Secondary Register)
      </h3>

      {spread.liveYearNote && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
          {spread.liveYearNote}
        </div>
      )}

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Register NET (Sub Total)
          </span>
          <span className="text-xl font-bold text-foreground">{fmtRs(total)}</span>
          <span className="text-[11px] text-muted-foreground">{(spread.totalRows ?? 0).toLocaleString("en-IN")} lines</span>
        </div>

        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Segment Coverage
          </span>
          <span className="text-xl font-bold text-foreground">
            {distinct} <span className="text-sm font-normal text-muted-foreground">of {universe}</span>
          </span>
          <span className="text-[11px] text-muted-foreground">{coveragePct.toFixed(1)}% of all segments</span>
        </div>

        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Cross-sell Depth
          </span>
          <span className="text-xl font-bold text-foreground">
            {(spread.crossSellDepth ?? 0).toFixed(1)}
          </span>
          <span className="text-[11px] text-muted-foreground">avg segments per customer</span>
        </div>

        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Concentration (HHI)
          </span>
          <span className={cn("text-xl font-bold", hhiInfo.colour)}>{hhi.toLocaleString("en-IN")}</span>
          <span className={cn("text-[11px]", hhiInfo.colour)}>{hhiInfo.label}</span>
        </div>
      </div>

      {/* NET by segment */}
      {segments.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="px-4 py-2 bg-muted/30 border-b border-border">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              NET (Sub Total) by Segment — sorted by value
            </p>
          </div>
          <div className="divide-y divide-border">
            {segments.map((seg) => (
              <div key={seg.segment} className="px-4 py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{seg.segment}</p>
                  <div className="mt-1 h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary/60 rounded-full transition-all"
                      style={{ width: `${Math.min(100, seg.pct)}%` }}
                    />
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-foreground">{fmtRs(seg.net)}</p>
                  <p className="text-[11px] text-muted-foreground">{seg.pct.toFixed(1)}%</p>
                </div>
              </div>
            ))}
          </div>
          <div className="px-4 py-2 bg-muted/20 border-t border-border flex justify-between text-xs text-muted-foreground">
            <span>Total (foots to register NET)</span>
            <span className="font-semibold text-foreground">{fmtRs(total)}</span>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Source: secondary_register_line · NET = net_amount (Sub Total) · segment = brand_canon.
      </p>
    </div>
  );
}

// ── Phase 6 components ────────────────────────────────────────────────────────

function AvsBPanel({
  kpis,
  rd,
}: {
  kpis: MemberKpis;
  rd: RetailerDetail | null;
}) {
  const partyOb = kpis.orderBooking ?? 0;
  const directOb = kpis.directDealersOrder ?? 0;
  const aTotal = partyOb + directOb;

  const sheetTotal =
    rd?.status === "ok" && rd.spread ? rd.spread.totalOrderBooking : null;

  const variance = sheetTotal != null ? aTotal - sheetTotal : null;
  const variancePct =
    sheetTotal != null && aTotal > 0
      ? ((aTotal - sheetTotal) / aTotal) * 100
      : null;
  const withinOne = variancePct != null && Math.abs(variancePct) <= 1;

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
        A-vs-B Reconciliation — Order Booking
      </h3>

      <div className="grid grid-cols-2 gap-3">
        {/* Source A */}
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 space-y-1.5">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Source A — Dashboard (Data tab)
          </p>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Party OB</span>
            <span className="font-semibold">{fmtRs(partyOb)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Direct Dealer OB</span>
            <span className="font-semibold">{fmtRs(directOb)}</span>
          </div>
          <div className="flex justify-between text-sm border-t border-border pt-1.5">
            <span className="text-muted-foreground font-medium">Total A</span>
            <span className="font-bold">{fmtRs(aTotal)}</span>
          </div>
        </div>

        {/* Source B */}
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 space-y-1.5">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Source B — Working Sheet (re-derived)
          </p>
          {rd?.status === "loading" && (
            <p className="text-xs text-muted-foreground italic">Working sheet loading…</p>
          )}
          {rd?.status === "not-mapped" && (
            <p className="text-xs text-muted-foreground italic">No working sheet mapped.</p>
          )}
          {rd?.status === "error" && (
            <p className="text-xs text-amber-700 dark:text-amber-400 italic">Sheet error — B unavailable.</p>
          )}
          {sheetTotal != null && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Sum of retailer rows</span>
                <span className="font-semibold">{fmtRs(sheetTotal)}</span>
              </div>
              <div className="flex justify-between text-sm border-t border-border pt-1.5">
                <span className="text-muted-foreground font-medium">Total B</span>
                <span className="font-bold">{fmtRs(sheetTotal)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {variance != null && (
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold",
              withinOne
                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
            )}
          >
            {withinOne ? "Reconciles within 1%" : "Variance outside 1%"}
          </div>
          <span className="text-xs text-muted-foreground">
            Variance: {fmtRs(Math.abs(variance))}{" "}
            {variancePct != null && `(${Math.abs(variancePct).toFixed(2)}%)`}
            {variance > 0 ? " — A exceeds B" : variance < 0 ? " — B exceeds A" : " — exact match"}
          </span>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        A = Data tab party OB + direct dealer OB · B = sum of individual retailer rows in working sheet.
      </p>
    </div>
  );
}

function WinBackPanel({ items }: { items: WinBackItem[] }) {
  const top = items.slice(0, 20);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1 flex-1">
          Win-Back — Dormant Retailers
        </h3>
        <span className="ml-3 text-[11px] font-semibold rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 px-2 py-0.5">
          {items.length} dormant
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        Customers present in FY2024-25 or FY2025-26 secondary register but not in the current working sheet.
      </p>

      <div className="rounded-lg border border-border overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-0 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/30 px-4 py-2">
          <span>Customer</span>
          <span className="text-center px-3">Last FY</span>
          <span className="text-center px-3">Last Month</span>
          <span className="text-right">Last NET</span>
        </div>
        <div className="divide-y divide-border">
          {top.map((item) => (
            <div
              key={`${item.customer}-${item.lastActiveFy}`}
              className="grid grid-cols-[1fr_auto_auto_auto] gap-0 px-4 py-2.5 text-sm items-center"
            >
              <span className="truncate text-foreground font-medium">{item.customer}</span>
              <span className="text-center px-3 text-muted-foreground text-xs">{item.lastActiveFy}</span>
              <span className="text-center px-3 text-muted-foreground text-xs">{item.lastActiveMonth}</span>
              <span className="text-right font-semibold text-foreground">{fmtRs(item.lastNet)}</span>
            </div>
          ))}
        </div>
        {items.length > 20 && (
          <div className="px-4 py-2 bg-muted/20 border-t border-border text-xs text-muted-foreground">
            Showing top 20 of {items.length} dormant customers.
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Source: secondary_register_line · FY2024-25 and FY2025-26 · compared by normalised customer name.
      </p>
    </div>
  );
}

function RunRatePanel({
  kpis,
  elapsedMonths,
}: {
  kpis: MemberKpis;
  elapsedMonths: number;
}) {
  if (elapsedMonths <= 0) return null;

  const ytdOb = (kpis.orderBooking ?? 0) + (kpis.directDealersOrder ?? 0);
  const pace = ytdOb / elapsedMonths; // per-month pace
  const projected = pace * 12;
  const plan = kpis.secondaryTarget;
  const projVsPlanPct = plan && plan > 0 ? (projected / plan) * 100 : null;
  const barWidth = projVsPlanPct != null ? Math.min(100, projVsPlanPct) : 0;
  const isOnTrack = projVsPlanPct != null && projVsPlanPct >= 100;

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
        Run-Rate Projection — FY2026-27
      </h3>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-3 text-center">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">YTD OB ({elapsedMonths}M)</p>
          <p className="text-base font-bold text-foreground mt-0.5">{fmtRs(ytdOb)}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-3 text-center">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Projected Year-End</p>
          <p className="text-base font-bold text-foreground mt-0.5">{fmtRs(projected)}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-3 text-center">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Annual Plan</p>
          <p className="text-base font-bold text-foreground mt-0.5">
            {plan ? fmtRs(plan) : "—"}
          </p>
        </div>
      </div>

      {projVsPlanPct != null && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Projection vs Plan</span>
            <span
              className={cn(
                "font-semibold",
                isOnTrack
                  ? "text-green-700 dark:text-green-400"
                  : "text-amber-700 dark:text-amber-400",
              )}
            >
              {projVsPlanPct.toFixed(1)}%
            </span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                isOnTrack ? "bg-green-500" : "bg-amber-500",
              )}
              style={{ width: `${barWidth}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Monthly pace {fmtRs(pace)} × 12 months · Plan = annual secondary Business Plan.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Phase 4 components ────────────────────────────────────────────────────────

function multipleColour(m: number): string {
  if (m >= 20) return "text-green-700 dark:text-green-400";
  if (m >= 10) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

function RoiCostPanel({ roi, memberName }: { roi: RoiCost; memberName: string }) {
  const { isFyClosedValue } = useGlobalFilter();
  const toDateLabel = isFyClosedValue ? "FY" : "YTD";
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
        ROI on Cost
      </h3>

      {/* Cost build-up */}
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {toDateLabel} Cost ({roi.elapsedCompleteMonths} complete fiscal months elapsed)
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span>
            CTC: <strong className="text-foreground">{fmtRs(roi.ctcCostYtd)}</strong>
            <span className="text-xs text-muted-foreground ml-1">
              ({fmtRs(roi.ctcMonthly)}/mo × {roi.elapsedCompleteMonths})
            </span>
          </span>
          <span className="text-muted-foreground">+</span>
          <span>
            T.A. Bill: <strong className="text-foreground">{fmtRs(roi.taBillYtd)}</strong>
          </span>
          <span className="text-muted-foreground">=</span>
          <span>
            Total: <strong className="text-foreground text-base">{fmtRs(roi.totalCost)}</strong>
          </span>
        </div>
      </div>

      {/* Revenue-to-cost multiples */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            OB / Cost
          </span>
          <span className={cn(
            "text-2xl font-bold",
            roi.obToCostMultiple != null ? multipleColour(roi.obToCostMultiple) : "",
          )}>
            {roi.obToCostMultiple != null ? `${roi.obToCostMultiple.toFixed(1)}x` : "—"}
          </span>
          <span className="text-[11px] text-muted-foreground">Revenue-to-cost (OB)</span>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Sale / Cost
          </span>
          <span className={cn(
            "text-2xl font-bold",
            roi.saleToCostMultiple != null ? multipleColour(roi.saleToCostMultiple) : "",
          )}>
            {roi.saleToCostMultiple != null ? `${roi.saleToCostMultiple.toFixed(1)}x` : "—"}
          </span>
          <span className="text-[11px] text-muted-foreground">Revenue-to-cost (Sale)</span>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Cost Ratio (cost / OB)
          </span>
          <span className={cn(
            "text-2xl font-bold",
            roi.costRatioPct != null
              ? roi.costRatioPct <= 6 ? "text-green-700 dark:text-green-400"
              : roi.costRatioPct <= 10 ? "text-amber-700 dark:text-amber-400"
              : "text-red-700 dark:text-red-400"
              : "",
          )}>
            {roi.costRatioPct != null ? `${roi.costRatioPct.toFixed(2)}%` : "—"}
          </span>
          <span className="text-[11px] text-muted-foreground">Total cost ÷ order booking ({toDateLabel})</span>
        </div>
        <Tile
          label={`Total ${toDateLabel} Cost`}
          value={fmtRs(roi.totalCost)}
          sub={`CTC ${fmtRs(roi.ctcCostYtd)} + T.A. ${fmtRs(roi.taBillYtd)}`}
        />
      </div>

      {/* Per-unit metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Tile
          label="Cost per Retailer"
          value={fmtRsWhole(roi.costPerRetailer)}
          sub="Total cost ÷ all retailers"
        />
        <Tile
          label="Cost per Visit"
          value={fmtRsWhole(roi.costPerVisit)}
          sub={`Total cost ÷ visits done (${toDateLabel})`}
        />
        <Tile
          label="Cost per Active Retailer"
          value={fmtRsWhole(roi.costPerActiveRetailer)}
          sub="Total cost ÷ retailers with orders"
        />
      </div>

      {/* Margin ROI placeholder */}
      <div className="rounded-lg border border-dashed border-border bg-muted/10 px-5 py-4 space-y-1.5">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Margin ROI — waiting for Cost Master
        </p>
        <p className="text-xs text-muted-foreground">
          Gross margin and margin-based ROI will appear here once a Cost Master with
          finished-goods cost (FG cost) is uploaded. MRP and purchase price are never
          used as cost proxies.
        </p>
        <p className="text-[11px] text-muted-foreground italic">
          Go to Data Health to upload a Cost Master for {memberName}.
        </p>
      </div>
    </div>
  );
}

// ── Phase 7: Period Selector Panel ────────────────────────────────────────────

type PeriodId = "ytd" | "full-year" | "q1" | "q2" | "q3" | "q4" | "month";

const PERIOD_LABELS: Record<PeriodId, string> = {
  "ytd":       "YTD",
  "full-year": "Full Year",
  "q1":        "Q1 Apr-Jun",
  "q2":        "Q2 Jul-Sep",
  "q3":        "Q3 Oct-Dec",
  "q4":        "Q4 Jan-Mar",
  "month":     "Month",
};

const FY_MONTHS_LIST = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"] as const;
const QUARTER_MONTHS: Record<string, string[]> = {
  "q1": ["Apr","May","Jun"],
  "q2": ["Jul","Aug","Sep"],
  "q3": ["Oct","Nov","Dec"],
  "q4": ["Jan","Feb","Mar"],
};

function computePeriodData(
  period: PeriodId,
  selectedMonth: string,
  kpis: MemberKpis,
  months: MonthActual[],
) {
  const monthlyTotal   = kpis.monthlyTarget;
  const primaryMonthly = kpis.primaryTargetMonthly;
  const secMonthly     = kpis.secondaryTargetMonthly;
  const elapsed        = kpis.elapsedMonths;

  const monthCount =
    period === "ytd"       ? (elapsed ?? 0)
    : period === "full-year" ? 12
    : period === "month"     ? 1
    : 3; // q1–q4

  // Pro-rata targets
  const secTarget     = secMonthly    !== null ? secMonthly    * monthCount : null;
  const primTarget    = primaryMonthly !== null ? primaryMonthly * monthCount : null;
  const totalTarget   = monthlyTotal   !== null ? monthlyTotal   * monthCount : null;

  // YTD: always use authoritative Data-tab values
  if (period === "ytd") {
    return { secOb: kpis.orderBooking, ddOb: kpis.directDealersOrder, sale: kpis.sale,
             plan: null, secTarget, primTarget, totalTarget, monthCount, fromMonthlyTab: false };
  }

  // Sub-period: sum from monthly tab rows
  const targetMonths =
    period === "full-year" ? [...FY_MONTHS_LIST]
    : period === "month"    ? [selectedMonth]
    : QUARTER_MONTHS[period] ?? [];

  const relevant = months.filter((m) => targetMonths.includes(m.month));
  if (relevant.length === 0) {
    return { secOb: null, ddOb: null, sale: null, plan: null,
             secTarget, primTarget, totalTarget, monthCount, fromMonthlyTab: true };
  }
  const sum = (fn: (m: MonthActual) => number | null) => {
    const vals = relevant.map(fn).filter((n): n is number => n !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return {
    secOb:  sum((m) => m.orderBooking),
    ddOb:   null, // DD monthly breakdown not in member sheet
    sale:   sum((m) => m.sale),
    plan:   sum((m) => m.plan),
    secTarget, primTarget, totalTarget, monthCount, fromMonthlyTab: true,
  };
}

interface PeriodSelectorPanelProps {
  kpis: MemberKpis;
  months: MonthActual[];
  dateFilterLabel?: string | null;
}

function PeriodSelectorPanel({ kpis, months, dateFilterLabel }: PeriodSelectorPanelProps) {
  const { fy, isFyClosedValue } = useGlobalFilter();
  // YTD is meaningless on a closed FY — the year is over. Hide the option and
  // fall back to Full Year whenever a prior year is selected.
  const [period, setPeriod]               = useState<PeriodId>(isFyClosedValue ? "full-year" : "ytd");
  const [selectedMonth, setSelectedMonth] = useState("Apr");
  useEffect(() => {
    if (isFyClosedValue && period === "ytd") setPeriod("full-year");
  }, [fy, isFyClosedValue, period]);

  const effectivePeriod: PeriodId = isFyClosedValue && period === "ytd" ? "full-year" : period;
  const d = computePeriodData(effectivePeriod, selectedMonth, kpis, months);
  const hasMonthlyData = months.length > 0;

  const PERIODS: PeriodId[] = isFyClosedValue
    ? ["full-year", "q1", "q2", "q3", "q4", "month"]
    : ["ytd", "q1", "q2", "q3", "q4", "month", "full-year"];

  // Achievement
  const saleAch = d.sale !== null && d.totalTarget !== null && d.totalTarget > 0
    ? (d.sale / d.totalTarget) * 100 : null;
  const secAch  = d.secOb !== null && d.secTarget  !== null && d.secTarget  > 0
    ? (d.secOb / d.secTarget) * 100 : null;

  // YoY comparison from prior-year quarterly fields
  const priorYearMap: Record<string, number | null | undefined> = {
    "q1": kpis.lastYearQ1, "q2": kpis.lastYearQ2,
    "q3": kpis.lastYearQ3, "q4": kpis.lastYearQ4,
  };
  const priorYear = priorYearMap[period] ?? null;

  // Shared band scale — single source of truth in lib/achievementBands.ts.
  const achColor = (pct: number) => achBandText(pct);

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Period Analysis</h3>
          {dateFilterLabel && (
            <span className="text-xs px-2 py-0.5 rounded-full border border-primary/40 bg-primary/10 text-primary">
              {dateFilterLabel}
            </span>
          )}
        </div>
        {!hasMonthlyData && period !== "ytd" && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Monthly tab not found — targets only shown
          </span>
        )}
      </div>

      {/* Period toggle */}
      <div className="flex flex-wrap gap-1.5">
        {PERIODS.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={cn(
              "px-3 py-1 rounded-md text-xs font-medium border transition-colors",
              period === p
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-muted",
            )}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      {/* Month sub-selector */}
      {period === "month" && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Month:</label>
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm focus:outline-none"
          >
            {FY_MONTHS_LIST.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      )}

      {/* Summary rows */}
      <div className="rounded-md border border-border overflow-x-auto">
        <table className="w-full text-xs">
          <tbody className="divide-y divide-border">
            <tr className="bg-muted/40">
              <td className="px-3 py-2 text-muted-foreground font-medium w-40">
                {period === "ytd"
                  ? `Target (${d.monthCount} mo elapsed)`
                  : `Target (${d.monthCount} mo × rate)`}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                Sec {fmtRs(d.secTarget)}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                Primary {fmtRs(d.primTarget)}
              </td>
              <td className="px-3 py-2 text-right font-mono font-semibold">
                Total {fmtRs(d.totalTarget)}
              </td>
            </tr>
            <tr>
              <td className="px-3 py-2 text-muted-foreground font-medium">
                {d.fromMonthlyTab ? "Actual (member FY tab)" : "Actual (Data tab)"}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {d.secOb !== null ? `Sec OB ${fmtRs(d.secOb)}` : "Sec OB —"}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {d.ddOb !== null ? `DD ${fmtRs(d.ddOb)}` : period === "ytd" ? "DD —" : "DD n/a"}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                Sale {d.sale !== null ? fmtRs(d.sale) : "—"}
              </td>
            </tr>
            {(saleAch !== null || secAch !== null) && (
              <tr className="bg-muted/20">
                <td className="px-3 py-2 text-muted-foreground font-medium">Achievement</td>
                <td className="px-3 py-2 text-right">
                  {secAch !== null && (
                    <span className={cn("font-semibold", achColor(secAch))}>
                      {fmtPct(secAch)} Sec OB
                    </span>
                  )}
                </td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right">
                  {saleAch !== null && (
                    <span className={cn("font-semibold", achColor(saleAch))}>
                      {fmtPct(saleAch)} Sale
                    </span>
                  )}
                </td>
              </tr>
            )}
            {d.plan !== null && (
              <tr>
                <td className="px-3 py-2 text-muted-foreground">Plan (member tab)</td>
                <td colSpan={3} className="px-3 py-2 text-right font-mono">{fmtRs(d.plan)}</td>
              </tr>
            )}
            {priorYear !== null && (
              <tr className="bg-muted/20">
                <td className="px-3 py-2 text-muted-foreground">Prior Year Actual</td>
                <td colSpan={2} className="px-3 py-2 text-right font-mono">{fmtRs(priorYear)}</td>
                <td className="px-3 py-2 text-right">
                  {d.sale !== null && priorYear > 0 && (
                    <span className={cn(
                      "font-semibold",
                      d.sale >= priorYear ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                    )}>
                      {d.sale >= priorYear ? "+" : ""}
                      {(((d.sale - priorYear) / priorYear) * 100).toFixed(1)}% YoY
                    </span>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Full monthly breakdown (collapsible) — only when monthly tab data exists */}
      {hasMonthlyData && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
            Monthly breakdown — member's FY tab ({months.length} months)
          </summary>
          <div className="mt-2 rounded-md border border-border overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">Month</th>
                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">Plan</th>
                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">Order Booking</th>
                  <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">Sale Received</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {months.map((m) => (
                  <tr key={m.month} className="hover:bg-muted/20">
                    <td className="px-3 py-1 font-medium">{m.month}</td>
                    <td className="px-3 py-1 text-right font-mono">
                      {m.plan !== null ? fmtRs(m.plan) : "—"}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {m.orderBooking !== null ? fmtRs(m.orderBooking) : "—"}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {m.sale !== null ? fmtRs(m.sale) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

// ── Date range filter ─────────────────────────────────────────────────────────

const FY_MONTH_ORDER = [
  "Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar",
] as const;
type FyMonth = (typeof FY_MONTH_ORDER)[number];

type DatePreset = "today" | "7d" | "15d" | "month" | "custom";

interface DateFilter {
  preset: DatePreset | null;
  month: FyMonth;
  fromDate: string;  // YYYY-MM-DD
  toDate:   string;  // YYYY-MM-DD
}

const DATE_FILTER_INIT: DateFilter = { preset: null, month: "Apr", fromDate: "", toDate: "" };

/** Calendar start/end for a given FY month label (e.g. "Jul" in FY 2026-27 → July 2026). */
function fyMonthCalendarRange(month: FyMonth, fyLabel: string): { start: Date; end: Date } {
  const fyYear   = parseInt(fyLabel.split("-")[0], 10);   // 2026
  const idx      = FY_MONTH_ORDER.indexOf(month);          // 0 = Apr … 11 = Mar
  const calYear  = idx < 9 ? fyYear : fyYear + 1;
  const calMonth = (idx + 3) % 12;                         // Apr→3, May→4 … Dec→11, Jan→0 … Mar→2
  const start = new Date(calYear, calMonth, 1);
  const end   = new Date(calYear, calMonth + 1, 0, 23, 59, 59);
  return { start, end };
}

interface ActiveDateRange { from: Date; to: Date; label: string }

function computeActiveDateRange(f: DateFilter, fyLabel: string): ActiveDateRange | null {
  if (!f.preset) return null;
  const eod = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
  const bod = (offset = 0) => {
    const d = new Date(); d.setDate(d.getDate() - offset); d.setHours(0, 0, 0, 0); return d;
  };
  if (f.preset === "today") return { from: bod(0),  to: eod(), label: "Today" };
  if (f.preset === "7d")    return { from: bod(6),  to: eod(), label: "Last 7 days" };
  if (f.preset === "15d")   return { from: bod(14), to: eod(), label: "Last 15 days" };
  if (f.preset === "month") {
    const { start, end } = fyMonthCalendarRange(f.month, fyLabel);
    return { from: start, to: end, label: f.month };
  }
  if (f.preset === "custom" && f.fromDate && f.toDate) {
    const from = new Date(f.fromDate + "T00:00:00");
    const to   = new Date(f.toDate   + "T23:59:59");
    if (from <= to) return { from, to, label: `${f.fromDate} – ${f.toDate}` };
  }
  return null;
}

function coveredFyMonths(range: ActiveDateRange, fyLabel: string): Set<FyMonth> {
  const out = new Set<FyMonth>();
  for (const m of FY_MONTH_ORDER) {
    const { start, end } = fyMonthCalendarRange(m, fyLabel);
    if (range.from <= end && range.to >= start) out.add(m);
  }
  return out;
}

function availableFyMonths(fyLabel: string): FyMonth[] {
  const today = new Date();
  return FY_MONTH_ORDER.filter((m) => fyMonthCalendarRange(m, fyLabel).start <= today);
}

function DateFilterBar({
  fyLabel,
  value,
  onChange,
}: {
  fyLabel: string;
  value: DateFilter;
  onChange: (f: DateFilter) => void;
}) {
  const months = availableFyMonths(fyLabel);

  const PRESETS: Array<{ key: DatePreset; label: string }> = [
    { key: "today", label: "Today" },
    { key: "7d",    label: "Last 7 days" },
    { key: "15d",   label: "Last 15 days" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">
        Date
      </label>

      {PRESETS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() =>
            onChange({ ...value, preset: value.preset === key ? null : key })
          }
          className={cn(
            "px-2.5 py-1 text-xs rounded-md border transition-colors",
            value.preset === key
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card hover:bg-muted/50",
          )}
        >
          {label}
        </button>
      ))}

      {/* Month dropdown */}
      <div className="flex flex-col gap-0.5">
        <select
          className="h-8 rounded-md border border-border bg-card px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
          value={value.preset === "month" ? value.month : ""}
          onChange={(e) => {
            if (e.target.value)
              onChange({ ...value, preset: "month", month: e.target.value as FyMonth });
            else
              onChange({ ...value, preset: null });
          }}
        >
          <option value="">Month...</option>
          {months.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* Custom date range — expand inline when active */}
      {value.preset === "custom" ? (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={value.fromDate}
            onChange={(e) => onChange({ ...value, fromDate: e.target.value })}
            className="h-8 rounded-md border border-border bg-card px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={value.toDate}
            onChange={(e) => onChange({ ...value, toDate: e.target.value })}
            className="h-8 rounded-md border border-border bg-card px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      ) : (
        <button
          onClick={() =>
            onChange({ ...value, preset: "custom", fromDate: "", toDate: "" })
          }
          className="px-2.5 py-1 text-xs rounded-md border border-border bg-card hover:bg-muted/50 transition-colors"
        >
          Custom
        </button>
      )}

      {/* Clear */}
      {value.preset && (
        <button
          onClick={() => onChange(DATE_FILTER_INIT)}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const AVAILABLE_FYS = ["2026-27", "2025-26", "2024-25", "2023-24"];

export default function SalesDeepDive() {
  const { fy } = useGlobalFilter();
  const [selectedHead, setSelectedHead] = useState("");
  const [selectedMemberKey, setSelectedMemberKey] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>(DATE_FILTER_INIT);

  const [data, setData] = useState<DeepDiveData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while Google Sheets is briefly rate-limiting reads (503 quota);
  // a retry is scheduled automatically after the server's retryAfter hint.
  const [quotaWait, setQuotaWait] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Request generation counter: each user-initiated load bumps it, so a stale
  // quota retry (or late response) from an earlier selection never commits.
  const reqSeq = useRef(0);

  // Called at the start of every load: supersede any pending quota retry.
  const beginRequest = useCallback((): number => {
    if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
    setQuotaWait(false);
    return ++reqSeq.current;
  }, []);

  const scheduleRetry = useCallback((retryAfter: number, fn: () => void) => {
    setQuotaWait(true);
    retryTimer.current = setTimeout(fn, quotaDelayMs(retryAfter));
  }, []);

  useEffect(() => {
    return () => {
      if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
    };
  }, []);

  const fetchSelectors = useCallback(
    async (newFy: string, newHead: string) => {
      const seq = beginRequest();
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ fy: newFy });
        if (newHead) params.set("stateHead", newHead);
        const r = await fetch(`${API}/mgmt/deep-dive?${params}`);
        if (seq !== reqSeq.current) return; // superseded by a newer load
        const q = await quotaOrThrow(r);
        if (q) {
          scheduleRetry(q.retryAfter, () => fetchSelectors(newFy, newHead));
          return;
        }
        const d: DeepDiveData = await r.json();
        if (seq !== reqSeq.current) return;
        setData(d);
        setSelectedMemberKey("");
      } catch (e) {
        if (seq !== reqSeq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [beginRequest, scheduleRetry],
  );

  const fetchKpis = useCallback(
    async (newFy: string, newHead: string, memberKey: string) => {
      if (!memberKey) return;
      const seq = beginRequest();
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ fy: newFy });
        if (newHead) params.set("stateHead", newHead);
        params.set("member", memberKey);
        const r = await fetch(`${API}/mgmt/deep-dive?${params}`);
        if (seq !== reqSeq.current) return; // superseded by a newer load
        const q = await quotaOrThrow(r);
        if (q) {
          scheduleRetry(q.retryAfter, () => fetchKpis(newFy, newHead, memberKey));
          return;
        }
        const d: DeepDiveData = await r.json();
        if (seq !== reqSeq.current) return;
        setData(d);
      } catch (e) {
        if (seq !== reqSeq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    [beginRequest, scheduleRetry],
  );

  // Reload selectors whenever the global FY changes (or on first mount).
  useEffect(() => {
    setSelectedHead("");
    setSelectedMemberKey("");
    setDateFilter(DATE_FILTER_INIT);
    fetchSelectors(fy, "");
  }, [fy, fetchSelectors]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleHeadChange(newHead: string) {
    setSelectedHead(newHead);
    setSelectedMemberKey("");
    fetchSelectors(fy, newHead);
  }

  function handleMemberChange(memberKey: string) {
    setSelectedMemberKey(memberKey);
    if (memberKey) fetchKpis(fy, selectedHead, memberKey);
  }

  const kpis           = data?.kpis ?? null;
  const teamSummary    = data?.teamSummary ?? null;
  const rd             = data?.retailerDetail ?? null;
  const roiCost        = data?.roiCost ?? null;
  const skuSpread      = data?.skuSpread ?? null;
  const winBack        = data?.winBack ?? null;
  const fromDbSnapshot = data?.fromDbSnapshot ?? false;
  const dataReadAt     = data?.dataReadAt ?? null;
  const stateHeads     = data?.stateHeads ?? [];
  const members        = data?.members ?? [];

  const activeDateRange    = computeActiveDateRange(dateFilter, fy);
  const covered            = activeDateRange ? coveredFyMonths(activeDateRange, fy) : null;
  const allMonths          = rd?.months ?? [];
  const dateFilteredMonths = covered
    ? allMonths.filter((m) => covered.has(m.month as FyMonth))
    : allMonths;
  const dateFilterLabel    = activeDateRange?.label ?? null;

  return (
    <div className="space-y-6">

      {/* Selectors */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            State Head
          </label>
          <select
            className="h-9 rounded-md border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 min-w-[180px]"
            value={selectedHead}
            onChange={(e) => handleHeadChange(e.target.value)}
            disabled={!stateHeads.length}
          >
            <option value="">All State Heads</option>
            {stateHeads.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Team Member
          </label>
          <select
            className="h-9 rounded-md border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 min-w-[200px]"
            value={selectedMemberKey}
            onChange={(e) => handleMemberChange(e.target.value)}
            disabled={!members.length}
          >
            <option value="">Select member...</option>
            {members.map((m) => (
              <option key={m.normKey} value={m.normKey}>{m.name}</option>
            ))}
          </select>
        </div>

        {loading && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground self-center pb-1">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Data loading…
          </span>
        )}
      </div>

      {/* Date range filter */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50">
        <DateFilterBar fyLabel={fy} value={dateFilter} onChange={setDateFilter} />
      </div>

      {/* Quota wait banner */}
      {quotaWait && <QuotaWaitBanner testId="banner-quota-wait-deep-dive" />}

      {/* Stale-snapshot notice: Sheets was briefly busy, showing saved figures */}
      {data?.stale && !error && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 dark:bg-amber-900/10 dark:text-amber-300"
          data-testid="banner-stale-deep-dive"
        >
          Figures are updating — showing the last saved snapshot while Google
          Sheets is briefly busy. Refresh in a minute for live figures.
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* State head selected, no member → team summary panel */}
      {!kpis && !loading && !error && selectedHead && teamSummary && (
        <>
          <TeamSummaryPanel summary={teamSummary} dataReadAt={dataReadAt} />
          <RetailerDriftPanel fy={fy} stateHead={selectedHead} />
        </>
      )}

      {/* Prompt when nothing useful to show yet */}
      {!kpis && !loading && !error && !(selectedHead && teamSummary) && (
        <div className="rounded-md border border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          {!stateHeads.length
            ? "Could not load the Data tab. Check that the sheet is connected."
            : !selectedHead
            ? "Select a State Head to see team summary, or choose a Team Member for individual analysis."
            : !selectedMemberKey
            ? "Select a Team Member to see their performance profile."
            : "Member data not found. The name may not appear in the Data tab yet."}
        </div>
      )}

      {/* Phase 1: KPI grid */}
      {kpis && (
        <div className="space-y-4">

          {/* Identity card */}
          <div className="rounded-lg border border-border bg-card px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-lg font-bold">{kpis.name}</p>
                <p className="text-sm text-muted-foreground">
                  {kpis.stateHead}
                  {kpis.designation ? ` · ${kpis.designation}` : ""}
                  {kpis.hq ? ` · ${kpis.hq}` : ""}
                </p>
                {kpis.contact && (
                  <p className="text-xs text-muted-foreground mt-0.5">{kpis.contact}</p>
                )}
                {dataReadAt ? (
                  <p className="text-xs text-muted-foreground/70 mt-0.5">
                    Data read: {fmtReadAt(dataReadAt)}
                  </p>
                ) : null}
              </div>
              {/* Phase 7: 4 achievement badges replacing the old blended figure */}
              <div className="flex flex-wrap gap-2">
                {kpis.achievementSale != null && (
                  <div className={cn("rounded-full px-3 py-1 text-xs font-semibold", achieveBand(kpis.achievementSale))}>
                    {fmtPct(kpis.achievementSale)} sale vs total target
                  </div>
                )}
                {kpis.achievementTotal != null && (
                  <div className={cn("rounded-full px-3 py-1 text-xs font-semibold", achieveBand(kpis.achievementTotal))}>
                    {fmtPct(kpis.achievementTotal)} total OB vs total target
                  </div>
                )}
                {kpis.achievementSecondary != null && (
                  <div className={cn("rounded-full px-3 py-1 text-xs font-semibold", achieveBand(kpis.achievementSecondary))}>
                    {fmtPct(kpis.achievementSecondary)} secondary OB
                  </div>
                )}
                {kpis.achievementDirectDealer != null && (
                  <div className={cn("rounded-full px-3 py-1 text-xs font-semibold", achieveBand(kpis.achievementDirectDealer))}>
                    {fmtPct(kpis.achievementDirectDealer)} DD OB
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Phase A2: AI narrative report */}
          {selectedMemberKey && (
            <div className="rounded-lg border border-border bg-card px-5 py-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                AI Report
              </p>
              <SalesPersonReport
                fy={fy}
                stateHead={selectedHead}
                memberKey={selectedMemberKey}
                memberName={kpis.name}
              />
            </div>
          )}

          {/* KPI tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">

            <SectionLabel>Targets</SectionLabel>
            <Tile label="Secondary Target (to date)" value={fmtRs(kpis.secondaryTarget)} accent />
            <Tile label="Monthly Total Target" value={fmtRs(kpis.monthlyTarget)} />
            {kpis.totalTargetToDate != null && (
              <Tile label="Total Target (to date)" value={fmtRs(kpis.totalTargetToDate)} accent />
            )}
            {kpis.elapsedMonths != null && (
              <Tile label="Elapsed Months" value={String(kpis.elapsedMonths)} sub="Derived: Total Target / Monthly Target" />
            )}
            {kpis.primaryTarget != null && (
              <Tile label="Primary Target (to date)" value={fmtRs(kpis.primaryTarget)} />
            )}
            {kpis.primaryTargetMonthly != null && (
              <Tile label="Primary Monthly Target" value={fmtRs(kpis.primaryTargetMonthly)} sub="Direct Dealer" />
            )}
            {kpis.secondaryTargetMonthly != null && (
              <Tile label="Secondary Monthly Target" value={fmtRs(kpis.secondaryTargetMonthly)} sub="Derived: Total − Primary" />
            )}

            <SectionLabel>{isFyClosed(fy) ? "Performance (Full Year)" : "Performance (YTD)"}</SectionLabel>
            <Tile label="Order Booking (Retailer / Party)" value={fmtRs(kpis.orderBooking)} sub="NET = Sub Total" accent />
            <Tile label="Direct Dealers Order" value={fmtRs(kpis.directDealersOrder)} sub="Kept separate from party OB" />
            <Tile label="Sales Received" value={fmtRs(kpis.sale)} accent />
            <Tile label="Sale Achievement" value={fmtPct(kpis.achievementSale)} sub="Sale / Total Target (to date)" />
            {kpis.achievementTotal != null && (
              <Tile label="Total OB Achievement" value={fmtPct(kpis.achievementTotal)} sub="(Sec OB + DD) / Total Target" />
            )}
            {kpis.achievementSecondary != null && (
              <Tile label="Secondary OB Achievement" value={fmtPct(kpis.achievementSecondary)} sub="Secondary OB / Secondary Target" />
            )}
            {kpis.achievementDirectDealer != null && (
              <Tile label="DD Achievement" value={fmtPct(kpis.achievementDirectDealer)} sub="DD Order / Primary Target" />
            )}

            <SectionLabel>Cost</SectionLabel>
            <Tile label="Monthly CTC" value={fmtRs(kpis.ctcMonthly)} />
            {kpis.ctcAnnual != null && <Tile label="Annual CTC" value={fmtRs(kpis.ctcAnnual)} />}
            <Tile label="T.A. Bill / Station Cost" value={fmtRs(kpis.taBillStCost)} />
            <Tile label="Cost Ratio (cost / sale)" value={fmtPct(kpis.costRatio)} sub="(CTC + T.A.) / sale received" />

            <SectionLabel>Retailer Coverage (Dashboard)</SectionLabel>
            <Tile label="Total Old Retailers" value={fmtNum(kpis.totalOldRetailers)} sub="Source: Dashboard Data tab" />
            <Tile label="Visited" value={fmtNum(kpis.visitedRetailers)} />
            <Tile label="Non-Visited" value={fmtNum(kpis.nonVisitedRetailers)} />
            <Tile label="New Party Order Booking" value={fmtRs(kpis.newPartyOrderBooking)} />
            {kpis.businessPerRetailer != null && (
              <Tile label="Business per Retailer" value={fmtRs(kpis.businessPerRetailer)} />
            )}
            {/* Sheet count is primary where a member sheet exists; the typed
                Data tab value is kept and shown beside it when they diverge
                by more than the small tolerance (±3). typed > sheet =
                possible unrecorded retailers (coverage gap). */}
            {(() => {
              const typed = kpis.totalRetailers;
              const sheet = rd?.status === "ok" ? (rd.rows ?? []).length : null;
              if (sheet != null) {
                const drift = (typed ?? 0) - sheet;
                const diverged = typed != null && Math.abs(drift) > 3;
                return (
                  <Tile
                    label="Total Retailers"
                    value={fmtNum(sheet)}
                    sub={
                      !diverged
                        ? `Source: member sheet rows${typed != null ? ` (Data tab typed: ${typed})` : ""}`
                        : drift > 0
                        ? `Data tab typed: ${typed} — typed EXCEEDS sheet by ${drift}: possible unrecorded retailers`
                        : `Data tab typed: ${typed} — typed column behind the sheet by ${-drift}`
                    }
                  />
                );
              }
              return typed != null ? (
                <Tile label="Total Retailers" value={fmtNum(typed)} sub="Source: Dashboard Data tab (typed by State Head — no member sheet to verify)" />
              ) : null;
            })()}
            {kpis.directDealersCount != null && (
              <Tile label="Direct Dealers" value={fmtNum(kpis.directDealersCount)} />
            )}

            {/* Phase 7: prior-year quarterly actuals */}
            {(kpis.lastYearQ1 != null || kpis.lastYearQ2 != null ||
              kpis.lastYearQ3 != null || kpis.lastYearQ4 != null) && (
              <>
                <SectionLabel>Prior Year Quarterly Actuals</SectionLabel>
                {kpis.lastYearQ1 != null && <Tile label="Q1 (Apr-Jun) Last Year" value={fmtRs(kpis.lastYearQ1)} />}
                {kpis.lastYearQ2 != null && <Tile label="Q2 (Jul-Sep) Last Year" value={fmtRs(kpis.lastYearQ2)} />}
                {kpis.lastYearQ3 != null && <Tile label="Q3 (Oct-Dec) Last Year" value={fmtRs(kpis.lastYearQ3)} />}
                {kpis.lastYearQ4 != null && <Tile label="Q4 (Jan-Mar) Last Year" value={fmtRs(kpis.lastYearQ4)} />}
              </>
            )}

            {Object.keys(kpis.extra).length > 0 && (
              <ExtraFieldsSections
                extra={{
                  ...kpis.extra,
                  // Inject current-year YTD values so they appear beside the prior-year
                  // actuals — only on the open FY (labels say "YTD (current FY)", which
                  // would be wrong on a closed year where these are full-year figures).
                  ...(!isFyClosed(fy) && kpis.sale != null ? { SALENOWYTD: kpis.sale } : {}),
                  ...(!isFyClosed(fy) && kpis.orderBooking != null ? { TOTALORDERNOWYTD: kpis.orderBooking } : {}),
                }}
              />
            )}
          </div>

          {/* Phase 2: retailer detail from working sheet */}
          {rd && rd.status === "ok" && rd.spread && (
            <div className="space-y-6 pt-2 border-t border-border">
              <RetailerSpreadPanel spread={rd.spread} />

              {/* Phase 3: visit pattern + capacity + forward plan */}
              {rd.visitPlan && (
                <>
                  <VisitPatternPanel pattern={rd.visitPlan.pattern} />
                  <CapacityPanel
                    capacity={rd.visitPlan.capacity}
                    historicalFyCapacity={rd.visitPlan.historicalFyCapacity}
                    gap={rd.visitPlan.gap}
                  />
                  <ForwardPlanPanel
                    monthPlans={rd.visitPlan.monthPlans}
                    totalFeasible={rd.visitPlan.totalFeasible}
                    totalRequired={rd.visitPlan.totalRequired}
                    gap={rd.visitPlan.gap}
                  />
                </>
              )}

              {/* Phase 4: ROI on cost */}
              {roiCost && (
                <RoiCostPanel roi={roiCost} memberName={kpis?.name ?? ""} />
              )}

              {rd.rows && rd.rows.length > 0 && (
                <RetailerTable rows={rd.rows} />
              )}
              <p className="text-xs text-muted-foreground">
                Source: member's working sheet{rd.tabName ? ` · ${rd.tabName}` : ""} ·{" "}
                {rd.rowsRead ?? 0} rows read · Achievement recomputed (OB / plan) · NET = Sub Total.
              </p>
            </div>
          )}

          {rd && rd.status === "loading" && (
            <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900/40 dark:bg-blue-900/10 px-4 py-3 text-xs text-blue-800 dark:text-blue-300">
              Retailer detail is loading in the background (first-time Sheets read).
              Re-select this member in 30–60 seconds to see the full retailer analysis.
            </div>
          )}

          {rd && rd.status === "not-mapped" && (
            <div className="rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              Retailer-level detail not yet available for this member. Add their
              working sheet ID to config/member_sheet_map.json to enable Phase 2.
            </div>
          )}

          {rd && rd.status === "error" && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-300">
              Could not load working sheet: {rd.error}
            </div>
          )}

          {/* Phase 5: segment and SKU spread from secondary_register_line */}
          {skuSpread && (
            <div className="pt-2 border-t border-border">
              <SkuSpreadPanel spread={skuSpread} />
            </div>
          )}

          {/* Phase 6A: A-vs-B reconciliation — always show when a member is selected */}
          {kpis && (
            <div className="pt-2 border-t border-border">
              <AvsBPanel kpis={kpis} rd={rd} />
            </div>
          )}

          {/* Phase 6B: Win-back dormant retailer list */}
          {winBack && winBack.length > 0 && (
            <div className="pt-2 border-t border-border">
              <WinBackPanel items={winBack} />
            </div>
          )}

          {/* Phase 6C: Run-rate projection — only for open FY with elapsed months */}
          {kpis && roiCost && roiCost.elapsedCompleteMonths > 0 && fy === "2026-27" && (
            <div className="pt-2 border-t border-border">
              <RunRatePanel kpis={kpis} elapsedMonths={roiCost.elapsedCompleteMonths} />
            </div>
          )}

          {/* Phase 7: Period selector — show whenever kpis is loaded */}
          {kpis && (
            <div className="pt-2 border-t border-border">
              <PeriodSelectorPanel
                kpis={kpis}
                months={dateFilteredMonths}
                dateFilterLabel={dateFilterLabel}
              />
            </div>
          )}

          <p className="text-xs text-muted-foreground pt-1">
            Source A: STATE HEAD DASHBOARD Data tab · FY {fy} ·{" "}
            {data?.rowsRead ?? 0} rows read{fromDbSnapshot ? " · served from DB snapshot" : ""} · Dashboard is the authority for
            headline secondary OB and sales.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExtraFieldsSections — renders the raw `extra` dictionary with readable
// labels, correct value formatting, and logical section grouping.
// ---------------------------------------------------------------------------

const EXTRA_LABELS: Record<string, string> = {
  // Profile / identity
  STATE:                              "State",
  WORKINGSTATE:                       "Working State",
  DOJ:                                "Date of Joining",
  EMPCODE:                            "Employee Code",
  ACTIVELEFT:                         "Active / Left",
  OLDNEW:                             "Old / New",
  SECONDARYPRIMARY:                   "Channel (Secondary / Primary)",
  TARGETRANGE:                        "Target Range",
  JUN:                                "Jun (month indicator)",

  // Achievement detail
  ACHIEVEMENT:                        "Secondary Order Booking (achieved amount)",
  TARGETACHIEVEMENT:                  "Target Achievement",
  TARGETACHIEVEMENTSALE:              "Target Achievement (Sale)",
  DIRECTDEALERPRIMARYTARGETACHIEVEMENT: "DD Primary Target Achievement",
  COSTRATIOSALE:                      "Cost Ratio (Sale)",
  BELOW60DEALER:                      "Dealers Below 60% Achievement",
  BUSINESSACHIEVED50ANDABOVE:         "Parties — 50%+ Achievement",
  TARGETCROSSCHECK:                   "Target Cross-check",

  // Business breakdown
  BUSINESSACHIEVEDBY:                 "Business Achieved By (parties)",
  BUSINESSACHIVEDBYNOOFOLDPARTIES:    "Business — Old Parties",
  BUSINESSACHIVEDBYNOOFNEWPARTIES:    "Business — New Parties",
  BUSINESSACHIEVEDBYDIRECTDEALER:     "Business — Direct Dealer",
  BUSINESSRECEIVEDPARTIESVISITS:      "Parties Giving Business",
  NEWRETAILERS:                       "New Retailers",
  NEWPARTYORDERS:                     "New Party Orders",

  // Counterwise / visit breakdown
  TOTALLEADCOUNTERS:                  "Lead Counters",
  TOTALLEADVISITS:                    "Lead Visits",
  TOTALNONLEADVISITS:                 "Non-Lead Visits",
  DISTRIBUTORCOUNTER:                 "Distributor Counter",
  DISTRIBUTORVISITS:                  "Distributor Visits",
  DIRECTDEALERCOUNTER:                "Direct Dealer Counter",
  DIRECTDEALERVISITS:                 "Direct Dealer Visits",
  DISTRIBUTORDIRECTDEALERLEADCOUNTER: "Distributor DD Lead Counter",
  DISTRIBUTORDIRECTDEALERLEADVISITS:  "Distributor DD Lead Visits",
  ACTIVEPARTIESVISITS:                "Active Parties Visited",
  TOTALVISITS:                        "Total Visits",
  VISITEDBUTNOBUSINESSRECEIVED:       "Visited — No Business",
  NOVISITNOBUSINESSRECEIVED:          "No Visit, No Business",

  // Activity & effort
  AVERAGESALESPERDAY:                 "Avg. Sales Per Day",
  AVERAGEVISITPERDAY:                 "Avg. Visits Per Day",
  NOOFORDERS:                         "No. of Orders",
  TOTALWORKINGHOURS:                  "Total Working Hours",
  TOTALGPSKM:                         "Total GPS km",
  AVGDISTANCEKM:                      "Avg. Distance (km)",
  CTC:                                "CTC",
  CTC2025:                            "CTC (FY 24-25)",

  // Prior period
  SALE2526:                           "Sales FY 25-26",
  TOTALORDER2526:                     "Order Booking FY 25-26",
  Q1:                                 "Q1 (Apr-Jun)",
  Q2:                                 "Q2 (Jul-Sep)",
  Q3:                                 "Q3 (Oct-Dec)",
  Q4:                                 "Q4 (Jan-Mar)",

  // Additional targets / totals
  MONTHYDIRECTDEALERPRIMARYTARGET:    "Monthly DD Primary Target",
  DIRECTDEALERPRIMARYTARGET:          "DD Primary Target",
  SALE:                               "Sale FY2025-26 (full year)",
  TOTALORDER:                         "Order Booking FY2025-26 (full year)",
  SALENOWYTD:                         "Sale YTD (current FY)",
  TOTALORDERNOWYTD:                   "Order Booking YTD (current FY)",
};

// Fields that are ratios (value < 2 = raw fraction, value >= 2 = already a percentage).
// ACHIEVEMENT (col I) is a rupee amount — NOT a ratio — intentionally excluded.
const RATIO_KEYS = new Set([
  "TARGETACHIEVEMENT", "TARGETACHIEVEMENTSALE",
  "DIRECTDEALERPRIMARYTARGETACHIEVEMENT", "COSTRATIOSALE",
]);

// Fields where a numeric 0 means the source cell was blank — show "not available".
const NULLABLE_ZERO_KEYS = new Set(["BELOW60DEALER"]);

// Fields that are suppressed entirely: sourced but undefined or unverifiable.
const SUPPRESS_KEYS = new Set(["VARITAION"]);

// Fields that are plain counts (never currency)
const COUNT_KEYS = new Set([
  "TOTALVISITS", "TOTALLEADVISITS", "TOTALNONLEADVISITS",
  "ACTIVEPARTIESVISITS", "VISITEDBUTNOBUSINESSRECEIVED", "NOVISITNOBUSINESSRECEIVED",
  "BUSINESSRECEIVEDPARTIESVISITS", "DISTRIBUTORVISITS", "DIRECTDEALERVISITS",
  "DISTRIBUTORDIRECTDEALERLEADVISITS", "TOTALLEADCOUNTERS", "DISTRIBUTORCOUNTER",
  "DIRECTDEALERCOUNTER", "DISTRIBUTORDIRECTDEALERLEADCOUNTER",
  "NOOFORDERS", "NEWRETAILERS", "NEWPARTYORDERS", "BELOW60DEALER",
  "BUSINESSACHIEVEDBY", "BUSINESSACHIVEDBYNOOFOLDPARTIES",
  "BUSINESSACHIVEDBYNOOFNEWPARTIES", "BUSINESSACHIEVEDBYDIRECTDEALER",
  "BUSINESSACHIEVED50ANDABOVE",
]);

// Fields with explicit units appended
const KM_KEYS  = new Set(["TOTALGPSKM", "AVGDISTANCEKM"]);
const HRS_KEYS = new Set(["TOTALWORKINGHOURS"]);

function fmtExtra(key: string, v: number | string | null): string {
  if (v === null || v === undefined) return "—";
  // Blank or whitespace-only string — source cell was effectively empty.
  if (typeof v === "string") return v.trim() ? v : "not available";
  // Numeric zero for fields where blank-in-sheet evaluates to 0 — show "not available"
  // rather than "0" which reads as "nobody is underperforming" vs "we did not measure it".
  if (v === 0 && NULLABLE_ZERO_KEYS.has(key)) return "not available";
  if (RATIO_KEYS.has(key)) {
    // Raw fraction (e.g. 0.485) → percentage; if already > 1 it's a multiplier
    const pct = Math.abs(v) <= 5 ? v * 100 : v;
    return fmtPct(pct);
  }
  if (COUNT_KEYS.has(key)) return fmtNum(v);
  if (KM_KEYS.has(key))    return fmtNum(v) + " km";
  if (HRS_KEYS.has(key))   return fmtNum(v) + " hrs";
  // Auto: currency for large values, plain number otherwise
  return v >= 1000 ? fmtRs(v) : fmtNum(v);
}

// Logical section groupings — rendered in order; unlisted keys go in "Other"
const EXTRA_SECTION_GROUPS: Array<{ section: string; keys: string[] }> = [
  {
    section: "Business Breakdown",
    keys: [
      "BUSINESSACHIVEDBYNOOFOLDPARTIES", "BUSINESSACHIVEDBYNOOFNEWPARTIES",
      "BUSINESSACHIEVEDBYDIRECTDEALER", "BUSINESSACHIEVEDBY",
      "BUSINESSRECEIVEDPARTIESVISITS",
      "BUSINESSACHIEVED50ANDABOVE", "NEWRETAILERS", "NEWPARTYORDERS",
    ],
  },
  {
    section: "Counterwise",
    keys: [
      "TOTALLEADCOUNTERS", "TOTALLEADVISITS", "TOTALNONLEADVISITS",
      "DISTRIBUTORCOUNTER", "DISTRIBUTORVISITS",
      "DIRECTDEALERCOUNTER", "DIRECTDEALERVISITS",
      "DISTRIBUTORDIRECTDEALERLEADCOUNTER", "DISTRIBUTORDIRECTDEALERLEADVISITS",
      "ACTIVEPARTIESVISITS", "TOTALVISITS",
      "VISITEDBUTNOBUSINESSRECEIVED", "NOVISITNOBUSINESSRECEIVED",
    ],
  },
  {
    section: "Activity",
    keys: [
      "AVERAGESALESPERDAY", "AVERAGEVISITPERDAY", "NOOFORDERS",
      "TOTALWORKINGHOURS", "TOTALGPSKM", "AVGDISTANCEKM", "CTC", "CTC2025",
    ],
  },
  {
    section: "Achievement Detail",
    keys: [
      "ACHIEVEMENT", "TARGETACHIEVEMENT", "TARGETACHIEVEMENTSALE",
      "DIRECTDEALERPRIMARYTARGETACHIEVEMENT", "COSTRATIOSALE",
      "BELOW60DEALER", "TARGETCROSSCHECK",
    ],
  },
  {
    // Current-year YTD first, then prior-year full-year, then quarterly.
    section: "Prior Period vs Current Year",
    keys: [
      "SALENOWYTD", "TOTALORDERNOWYTD",
      "SALE", "TOTALORDER",
      "SALE2526", "TOTALORDER2526",
      "Q1", "Q2", "Q3", "Q4",
    ],
  },
  {
    section: "Additional Targets",
    keys: ["MONTHYDIRECTDEALERPRIMARYTARGET", "DIRECTDEALERPRIMARYTARGET"],
  },
  {
    section: "Profile",
    keys: [
      "STATE", "WORKINGSTATE", "DOJ", "EMPCODE",
      "ACTIVELEFT", "OLDNEW", "SECONDARYPRIMARY", "TARGETRANGE", "JUN",
    ],
  },
];

function ExtraFieldsSections({ extra }: { extra: Record<string, number | string | null> }) {
  const listed = new Set<string>();

  const sections = EXTRA_SECTION_GROUPS.map(({ section, keys }) => {
    const entries = keys.flatMap((k) => {
      if (!(k in extra)) return [];
      if (SUPPRESS_KEYS.has(k)) return [];
      listed.add(k);
      return [[k, extra[k]] as [string, number | string | null]];
    });
    return { section, entries };
  }).filter((s) => s.entries.length > 0);

  // Catch anything not in any group (suppressed keys are silently dropped)
  const otherEntries = Object.entries(extra).filter(([k]) => !listed.has(k) && !SUPPRESS_KEYS.has(k));
  if (otherEntries.length > 0) {
    sections.push({ section: "Other", entries: otherEntries as [string, number | string | null][] });
  }

  return (
    <>
      {sections.map(({ section, entries }) => (
        <>
          <SectionLabel key={section + "_label"}>{section}</SectionLabel>
          {entries.map(([k, v]) => (
            <Tile
              key={k}
              label={EXTRA_LABELS[k] ?? k.charAt(0) + k.slice(1).toLowerCase()}
              value={fmtExtra(k, v)}
            />
          ))}
        </>
      ))}
    </>
  );
}
