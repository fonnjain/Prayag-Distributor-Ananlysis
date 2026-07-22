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
  rowsRead?: number | null;
}

interface DeepDiveData {
  fy: string;
  stateHeads: string[];
  members: MemberRef[];
  kpis: MemberKpis | null;
  retailerDetail: RetailerDetail | null;
  rowsRead: number;
  error: string | null;
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

  const kpis = data?.kpis ?? null;
  const rd   = data?.retailerDetail ?? null;
  const stateHeads = data?.stateHeads ?? [];
  const members    = data?.members ?? [];

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
            <div className="space-y-4 pt-2 border-t border-border">
              <RetailerSpreadPanel spread={rd.spread} />
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

          <p className="text-xs text-muted-foreground pt-1">
            Source A: STATE HEAD DASHBOARD Data tab · FY {fy} ·{" "}
            {data?.rowsRead ?? 0} rows read · Dashboard is the authority for
            headline secondary OB and sales.
          </p>
        </div>
      )}
    </div>
  );
}
