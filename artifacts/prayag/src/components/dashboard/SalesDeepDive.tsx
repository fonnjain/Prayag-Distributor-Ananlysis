// Sales Deep Dive — Phase 1 + Phase 2
// Phase 1: STATE HEAD DASHBOARD 'Data' tab KPIs (source A).
// Phase 2: member's own working sheet retailer-level detail (source B).
// Direct Dealer order kept separate from retailer/party OB throughout.
// Achievement always recomputed (sale / plan); never read from a sheet % cell.
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

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
  primaryTarget: number | null;
  secondaryTarget: number | null;
  monthlyTarget: number | null;
  orderBooking: number | null;
  directDealersOrder: number | null;
  sale: number | null;
  achievementPct: number | null;
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

interface DeepDiveData {
  fy: string;
  stateHeads: string[];
  members: MemberRef[];
  kpis: MemberKpis | null;
  retailerDetail: RetailerDetail | null;
  roiCost: RoiCost | null;
  skuSpread: SkuSpread | null;
  winBack: WinBackItem[] | null;
  rowsRead: number;
  error: string | null;
  fromDbSnapshot?: boolean | null;
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

// ── Band colour for achievement / active% ─────────────────────────────────────

function achieveBand(pct: number | null): string {
  if (pct == null) return "bg-muted text-muted-foreground";
  if (pct >= 100) return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  if (pct >= 70)  return "bg-blue-100  text-blue-800  dark:bg-blue-900/40  dark:text-blue-300";
  if (pct >= 50)  return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return              "bg-red-100   text-red-800   dark:bg-red-900/40   dark:text-red-300";
}

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

// ── Retailer spread panel (Phase 2) ───────────────────────────────────────────

function RetailerSpreadPanel({ spread }: { spread: RetailerSpread }) {
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
            label="Total Visits (YTD)"
            value={fmtNum(spread.totalVisits)}
          />
        )}

        {/* Concentration */}
        <SectionLabel>Order Booking Concentration</SectionLabel>

        <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide leading-tight">
            Concentration Index
          </span>
          <span className="text-lg font-semibold">
            {spread.concentrationIndex != null
              ? Math.round(spread.concentrationIndex).toLocaleString("en-IN")
              : "—"}
          </span>
          <span className="text-[11px] text-muted-foreground">HHI · 10000 = monopoly</span>
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
        <Tile label="Visits Done (YTD)" value={fmtNum(pattern.totalVisitsDone)} accent />
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
  return (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1">
        ROI on Cost
      </h3>

      {/* Cost build-up */}
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          YTD Cost ({roi.elapsedCompleteMonths} complete fiscal months elapsed)
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
            Cost Ratio
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
          <span className="text-[11px] text-muted-foreground">Cost ÷ Order Booking</span>
        </div>
        <Tile
          label="Total YTD Cost"
          value={fmtRs(roi.totalCost)}
          sub={`CTC ${fmtRs(roi.ctcCostYtd)} + T.A. ${fmtRs(roi.taBillYtd)}`}
        />
      </div>

      {/* Per-unit metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Tile
          label="Cost per Retailer"
          value={fmtRs(roi.costPerRetailer)}
          sub="Total cost ÷ all retailers"
        />
        <Tile
          label="Cost per Visit"
          value={fmtRs(roi.costPerVisit)}
          sub="Total cost ÷ visits done (YTD)"
        />
        <Tile
          label="Cost per Active Retailer"
          value={fmtRs(roi.costPerActiveRetailer)}
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

// ── Main component ────────────────────────────────────────────────────────────

const AVAILABLE_FYS = ["2026-27", "2025-26", "2024-25", "2023-24"];

export default function SalesDeepDive() {
  const [fy, setFy] = useState("2026-27");
  const [selectedHead, setSelectedHead] = useState("");
  const [selectedMemberKey, setSelectedMemberKey] = useState("");

  const [data, setData] = useState<DeepDiveData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSelectors = useCallback(
    async (newFy: string, newHead: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ fy: newFy });
        if (newHead) params.set("stateHead", newHead);
        const r = await fetch(`${API}/mgmt/deep-dive?${params}`);
        if (!r.ok) throw new Error(await r.text());
        const d: DeepDiveData = await r.json();
        setData(d);
        setSelectedMemberKey("");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const fetchKpis = useCallback(
    async (newFy: string, newHead: string, memberKey: string) => {
      if (!memberKey) return;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ fy: newFy });
        if (newHead) params.set("stateHead", newHead);
        params.set("member", memberKey);
        const r = await fetch(`${API}/mgmt/deep-dive?${params}`);
        if (!r.ok) throw new Error(await r.text());
        const d: DeepDiveData = await r.json();
        setData(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchSelectors(fy, "");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleFyChange(newFy: string) {
    setFy(newFy);
    setSelectedHead("");
    setSelectedMemberKey("");
    fetchSelectors(newFy, "");
  }

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
  const rd             = data?.retailerDetail ?? null;
  const roiCost        = data?.roiCost ?? null;
  const skuSpread      = data?.skuSpread ?? null;
  const winBack        = data?.winBack ?? null;
  const fromDbSnapshot = data?.fromDbSnapshot ?? false;
  const stateHeads     = data?.stateHeads ?? [];
  const members        = data?.members ?? [];

  return (
    <div className="space-y-6">

      {/* Selectors */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Fiscal Year
          </label>
          <select
            className="h-9 rounded-md border border-border bg-card px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            value={fy}
            onChange={(e) => handleFyChange(e.target.value)}
          >
            {AVAILABLE_FYS.map((f) => (
              <option key={f} value={f}>FY {f}</option>
            ))}
          </select>
        </div>

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
          <span className="text-xs text-muted-foreground self-center pb-1">
            Loading...
          </span>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Prompt when nothing selected */}
      {!kpis && !loading && !error && (
        <div className="rounded-md border border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          {!stateHeads.length
            ? "Could not load the Data tab. Check that the sheet is connected."
            : !selectedHead
            ? "Select a State Head and a Team Member to see their performance profile."
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
              </div>
              {kpis.achievementPct != null && (
                <div className={cn("rounded-full px-4 py-1.5 text-sm font-semibold", achieveBand(kpis.achievementPct))}>
                  {fmtPct(kpis.achievementPct)} achievement
                </div>
              )}
            </div>
          </div>

          {/* KPI tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">

            <SectionLabel>Targets</SectionLabel>
            <Tile label="Secondary Target (Annual)" value={fmtRs(kpis.secondaryTarget)} accent />
            <Tile label="Monthly Target" value={fmtRs(kpis.monthlyTarget)} />
            {kpis.primaryTarget != null && (
              <Tile label="Primary Target (Annual)" value={fmtRs(kpis.primaryTarget)} />
            )}

            <SectionLabel>Performance (YTD)</SectionLabel>
            <Tile label="Order Booking (Retailer / Party)" value={fmtRs(kpis.orderBooking)} sub="NET = Sub Total" accent />
            <Tile label="Direct Dealers Order" value={fmtRs(kpis.directDealersOrder)} sub="Kept separate from party OB" />
            <Tile label="Sales Received" value={fmtRs(kpis.sale)} accent />
            <Tile label="Achievement" value={fmtPct(kpis.achievementPct)} sub="Recomputed: sale / plan" />

            <SectionLabel>Cost</SectionLabel>
            <Tile label="Monthly CTC" value={fmtRs(kpis.ctcMonthly)} />
            {kpis.ctcAnnual != null && <Tile label="Annual CTC" value={fmtRs(kpis.ctcAnnual)} />}
            <Tile label="T.A. Bill / Station Cost" value={fmtRs(kpis.taBillStCost)} />
            <Tile label="Cost Ratio" value={fmtPct(kpis.costRatio)} sub="(CTC + T.A.) / Sale" />

            <SectionLabel>Retailer Coverage (Dashboard)</SectionLabel>
            <Tile label="Total Old Retailers" value={fmtNum(kpis.totalOldRetailers)} />
            <Tile label="Visited" value={fmtNum(kpis.visitedRetailers)} />
            <Tile label="Non-Visited" value={fmtNum(kpis.nonVisitedRetailers)} />
            <Tile label="New Party Order Booking" value={fmtRs(kpis.newPartyOrderBooking)} />
            {kpis.businessPerRetailer != null && (
              <Tile label="Business per Retailer" value={fmtRs(kpis.businessPerRetailer)} />
            )}
            {kpis.totalRetailers != null && (
              <Tile label="Total Retailers" value={fmtNum(kpis.totalRetailers)} />
            )}
            {kpis.directDealersCount != null && (
              <Tile label="Direct Dealers" value={fmtNum(kpis.directDealersCount)} />
            )}

            {Object.keys(kpis.extra).length > 0 && (
              <>
                <SectionLabel>Additional Fields</SectionLabel>
                {Object.entries(kpis.extra).map(([k, v]) => (
                  <Tile
                    key={k}
                    label={k.replace(/([A-Z])/g, " $1").trim()}
                    value={
                      typeof v === "number"
                        ? v > 1000 ? fmtRs(v) : fmtNum(v)
                        : String(v ?? "—")
                    }
                  />
                ))}
              </>
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
