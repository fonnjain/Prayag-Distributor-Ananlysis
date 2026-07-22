// Sales Deep Dive — Phase 1
// Selectors: State Head → Team Member → FY.
// KPI grid: reads the STATE HEAD DASHBOARD 'Data' tab (source A).
// Direct Dealer order is kept separate from retailer/party OB.
// Achievement recomputed (sale / plan); never read from a sheet % cell.
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL ?? "/";
const API = `${BASE}api`.replace(/\/\//g, "/");

// ── Types (mirror MgmtDeepDiveKpis from openapi) ─────────────────────────────

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

interface DeepDiveData {
  fy: string;
  stateHeads: string[];
  members: MemberRef[];
  kpis: MemberKpis | null;
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

// ── Band colour for achievement ───────────────────────────────────────────────

function achieveBand(pct: number | null): string {
  if (pct == null) return "bg-muted text-muted-foreground";
  if (pct >= 100) return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  if (pct >= 70)  return "bg-blue-100  text-blue-800  dark:bg-blue-900/40  dark:text-blue-300";
  if (pct >= 50)  return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return              "bg-red-100   text-red-800   dark:bg-red-900/40   dark:text-red-300";
}

// ── KPI tile ──────────────────────────────────────────────────────────────────

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

// ── Section header ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return (
    <h3 className="col-span-full text-xs font-semibold uppercase tracking-widest text-muted-foreground pt-2 pb-1 border-b border-border">
      {children}
    </h3>
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

  // Fetch state heads + members list for the selected FY (and head filter).
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
        // Reset member selection when head or FY changes.
        setSelectedMemberKey("");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Fetch KPIs for the selected member.
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

  // On mount: load state heads.
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
  const stateHeads = data?.stateHeads ?? [];
  const members = data?.members ?? [];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Selectors row */}
      <div className="flex flex-wrap gap-3 items-end">
        {/* FY selector */}
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
              <option key={f} value={f}>
                FY {f}
              </option>
            ))}
          </select>
        </div>

        {/* State Head dropdown */}
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
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </div>

        {/* Team Member dropdown */}
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
              <option key={m.normKey} value={m.normKey}>
                {m.name}
              </option>
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

      {/* Data-not-yet note when no member is selected */}
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

      {/* KPI grid */}
      {kpis && (
        <div className="space-y-4">

          {/* Header identity card */}
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
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {kpis.contact}
                  </p>
                )}
              </div>
              {kpis.achievementPct != null && (
                <div
                  className={cn(
                    "rounded-full px-4 py-1.5 text-sm font-semibold",
                    achieveBand(kpis.achievementPct),
                  )}
                >
                  {fmtPct(kpis.achievementPct)} achievement
                </div>
              )}
            </div>
          </div>

          {/* KPI tiles grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">

            {/* Targets */}
            <SectionLabel>Targets</SectionLabel>
            <Tile
              label="Secondary Target (Annual)"
              value={fmtRs(kpis.secondaryTarget)}
              accent
            />
            <Tile
              label="Monthly Target"
              value={fmtRs(kpis.monthlyTarget)}
            />
            {kpis.primaryTarget != null && (
              <Tile
                label="Primary Target (Annual)"
                value={fmtRs(kpis.primaryTarget)}
              />
            )}

            {/* Performance */}
            <SectionLabel>Performance (YTD)</SectionLabel>
            <Tile
              label="Order Booking (Retailer / Party)"
              value={fmtRs(kpis.orderBooking)}
              sub="NET = Sub Total"
              accent
            />
            <Tile
              label="Direct Dealers Order"
              value={fmtRs(kpis.directDealersOrder)}
              sub="Kept separate from party OB"
            />
            <Tile
              label="Sales Received"
              value={fmtRs(kpis.sale)}
              accent
            />
            <Tile
              label="Achievement"
              value={fmtPct(kpis.achievementPct)}
              sub="Recomputed: sale / plan"
            />

            {/* Cost */}
            <SectionLabel>Cost</SectionLabel>
            <Tile label="Monthly CTC" value={fmtRs(kpis.ctcMonthly)} />
            {kpis.ctcAnnual != null && (
              <Tile label="Annual CTC" value={fmtRs(kpis.ctcAnnual)} />
            )}
            <Tile label="T.A. Bill / Station Cost" value={fmtRs(kpis.taBillStCost)} />
            <Tile
              label="Cost Ratio"
              value={fmtPct(kpis.costRatio)}
              sub="(CTC + T.A.) / Sale"
            />

            {/* Retailers */}
            <SectionLabel>Retailer Coverage</SectionLabel>
            <Tile
              label="Total Old Retailers"
              value={fmtNum(kpis.totalOldRetailers)}
            />
            <Tile label="Visited" value={fmtNum(kpis.visitedRetailers)} />
            <Tile label="Non-Visited" value={fmtNum(kpis.nonVisitedRetailers)} />
            <Tile
              label="New Party Order Booking"
              value={fmtRs(kpis.newPartyOrderBooking)}
            />
            {kpis.businessPerRetailer != null && (
              <Tile
                label="Business per Retailer"
                value={fmtRs(kpis.businessPerRetailer)}
              />
            )}
            {kpis.totalRetailers != null && (
              <Tile label="Total Retailers" value={fmtNum(kpis.totalRetailers)} />
            )}
            {kpis.directDealersCount != null && (
              <Tile label="Direct Dealers" value={fmtNum(kpis.directDealersCount)} />
            )}

            {/* Extra fields (any additional columns read from Data tab) */}
            {Object.keys(kpis.extra).length > 0 && (
              <>
                <SectionLabel>Additional Fields</SectionLabel>
                {Object.entries(kpis.extra).map(([k, v]) => (
                  <Tile
                    key={k}
                    label={k.replace(/([A-Z])/g, " $1").trim()}
                    value={
                      typeof v === "number"
                        ? v > 1000
                          ? fmtRs(v)
                          : fmtNum(v)
                        : String(v ?? "—")
                    }
                  />
                ))}
              </>
            )}
          </div>

          {/* Footer note */}
          <p className="text-xs text-muted-foreground pt-1">
            Source: STATE HEAD DASHBOARD Data tab · FY {fy} ·{" "}
            {data?.rowsRead ?? 0} rows read · Dashboard is the authority for
            headline secondary OB and sales.
          </p>
        </div>
      )}
    </div>
  );
}
