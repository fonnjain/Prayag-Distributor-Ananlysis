// Scheme Nudge Engine — live nudge list + supporting dashboards.
//
// Tabs:
//   1. Nudge List    — ranked by "what the distributor earns if they top up"
//   2. Cockpit       — management view: total opportunity, scheme cost, deadline
//   3. Annual Tracker — anti-decline projection by distributor
//   4. Sales Head    — roll up nudge opportunity by territory head
//   5. Trip Board    — distributors in reach of a trip incentive (Q_OTHER)
//   6. Scheme Master — reference slabs + basket map
//
// All data comes from /api/schemes/nudge, /cockpit, /annual, /master.
import { useState, useEffect, useMemo } from "react";
import { AlertTriangle, Lock, TrendingUp, TrendingDown, RefreshCw, ChevronUp, ChevronDown, Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// ── Helpers ───────────────────────────────────────────────────────────────────

function inr(val: number | null | undefined): string {
  if (val == null) return "—";
  if (Math.abs(val) >= 1e7) return `₹${(val / 1e7).toFixed(2)} Cr`;
  if (Math.abs(val) >= 1e5) return `₹${(val / 1e5).toFixed(2)} L`;
  return `₹${val.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function pct(val: number | null | undefined, decimals = 1): string {
  if (val == null) return "—";
  return `${(val * 100).toFixed(decimals)}%`;
}

function roiColor(roi: number | null): string {
  if (roi == null) return "text-muted-foreground";
  if (roi >= 0.12) return "text-green-600 dark:text-green-400 font-semibold";
  if (roi >= 0.08) return "text-blue-600 dark:text-blue-400";
  return "text-foreground";
}

function qLabel(q: string): string {
  return { Q1: "Apr-Jun", Q2: "Jul-Sep", Q3: "Oct-Dec", Q4: "Jan-Mar" }[q] ?? q;
}

const SCHEME_SHORT: Record<string, string> = {
  Q_PLUMB: "Plumbing",
  Q_PTMT: "PTMT",
  Q_CP: "CP/Sink",
  Q_OTHER: "Other",
  Q_CP89: "CP 89xx",
  Q_PTMT_KLKA: "PTMT KL/KA",
  A_DIST: "Annual Dist",
  A_GEN: "Annual Gen",
  A_DD_JK: "Annual J&K",
  SB_CIST: "SB Cistern",
  SB_THT: "SB T-Handle",
  SB_TEF: "SB Teflon",
  SB_DIV: "SB Divertor",
};

// ── Types ─────────────────────────────────────────────────────────────────────

type NudgeRow = {
  customer: string;
  stateHead: string | null;
  schemeId: string;
  basketName: string;
  billedSoFar: number;
  currentRate: number;
  currentEarnings: number;
  nextSlab: number;
  nextRate: number | null;
  gap: number;
  theyEarn: number | null;
  roi: number | null;
  rewardType: "pct" | "trip" | "pct_or_trip";
  tripLabel: string | null;
  status: "NUDGE" | "BLOCKED" | "AT_MAX" | "TRIP_ZONE";
  blockedReason: string | null;
};

type NudgeResult = {
  fy: string;
  quarter: string;
  months: string[];
  deadline: string;
  daysToDeadline: number;
  totalOpportunity: number;
  totalSchemeCost: number;
  nudgeCount: number;
  nudges: NudgeRow[];
  blocked: string[];
  duesDataAvailable: boolean;
  duesError: string | null;
};

type CockpitRow = {
  schemeId: string;
  schemeName: string;
  participantCount: number;
  totalBilled: number;
  totalEarned: number;
  nudgeCount: number;
  opportunityAmount: number;
};

type CockpitResult = {
  fy: string;
  quarter: string;
  deadline: string;
  daysToDeadline: number;
  totalLiveOpportunity: number;
  totalSchemeCost: number;
  totalNudges: number;
  byScheme: CockpitRow[];
};

type AnnualRow = {
  customer: string;
  stateHead: string | null;
  fyTotal: number;
  lyTotal: number;
  seasonalityPctElapsed: number;
  projectedTotal: number;
  projectedVsLyPct: number | null;
  atRisk: boolean;
  currentSlabIdx: number;
  currentRate: number | null;
  schemeId: string;
};

type SchemeMaster = {
  schemes: Array<{
    id: string;
    name: string;
    basis: string;
    slabs: Array<{ threshold: number; rate: number | null; reward?: string | null; rewardType: string }>;
    stateRestriction?: string[];
  }>;
  basketMap: Record<string, string>;
  conditions: Record<string, unknown>;
  trips: Array<{ label: string; requirement: string; threshold: number }>;
};

// ── Tab bar ───────────────────────────────────────────────────────────────────

const TABS = [
  { id: "nudge",   label: "Nudge List"     },
  { id: "cockpit", label: "Cockpit"        },
  { id: "annual",  label: "Annual Tracker" },
  { id: "heads",   label: "Sales Head"     },
  { id: "trips",   label: "Trip Board"     },
  { id: "master",  label: "Scheme Master"  },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ── Main component ────────────────────────────────────────────────────────────

export default function SchemeNudgeEngine() {
  const [tab, setTab] = useState<TabId>("nudge");
  const [fy, setFy] = useState("2026-27");
  const [quarter, setQuarter] = useState<"Q1" | "Q2" | "Q3" | "Q4">("Q2");

  const [nudgeData, setNudgeData] = useState<NudgeResult | null>(null);
  const [nudgeLoading, setNudgeLoading] = useState(false);
  const [nudgeError, setNudgeError] = useState<string | null>(null);

  const [cockpitData, setCockpitData] = useState<CockpitResult | null>(null);
  const [annualData, setAnnualData] = useState<{ rows: AnnualRow[]; completeMonths: string[] } | null>(null);
  const [masterData, setMasterData] = useState<SchemeMaster | null>(null);

  const [schemeFilter, setSchemeFilter] = useState<string>("all");
  const [headFilter, setHeadFilter] = useState<string>("all");
  const [showBlocked, setShowBlocked] = useState(false);
  const [sortKey, setSortKey] = useState<"theyEarn" | "roi" | "gap" | "billedSoFar">("theyEarn");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");

  function fetchNudge() {
    setNudgeLoading(true);
    setNudgeError(null);
    Promise.all([
      fetch(`/api/schemes/nudge?fy=${fy}&q=${quarter}`).then((r) => r.json() as Promise<NudgeResult>),
      fetch(`/api/schemes/cockpit?fy=${fy}&q=${quarter}`).then((r) => r.json() as Promise<CockpitResult>),
    ])
      .then(([nudge, cockpit]) => {
        setNudgeData(nudge);
        setCockpitData(cockpit);
      })
      .catch((e) => setNudgeError(String(e)))
      .finally(() => setNudgeLoading(false));
  }

  function fetchAnnual() {
    fetch(`/api/schemes/annual?fy=${fy}`)
      .then((r) => r.json())
      .then(setAnnualData)
      .catch(() => {});
  }

  function fetchMaster() {
    fetch("/api/schemes/master")
      .then((r) => r.json())
      .then(setMasterData)
      .catch(() => {});
  }

  useEffect(() => { fetchNudge(); }, [fy, quarter]);
  useEffect(() => { if (tab === "annual" && !annualData) fetchAnnual(); }, [tab]);
  useEffect(() => { if (tab === "master" && !masterData) fetchMaster(); }, [tab]);

  // Filtered + sorted nudge rows
  const displayNudges = useMemo(() => {
    if (!nudgeData) return [];
    let rows = nudgeData.nudges.filter((n) => {
      if (!showBlocked && n.status === "BLOCKED") return false;
      if (schemeFilter !== "all" && n.schemeId !== schemeFilter) return false;
      if (headFilter !== "all" && (n.stateHead ?? "—") !== headFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!n.customer.toLowerCase().includes(q) &&
            !(n.stateHead ?? "").toLowerCase().includes(q)) return false;
      }
      return true;
    });
    rows = [...rows].sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      return sortDir === "desc" ? Number(bv) - Number(av) : Number(av) - Number(bv);
    });
    return rows;
  }, [nudgeData, showBlocked, schemeFilter, headFilter, search, sortKey, sortDir]);

  const uniqueSchemes = useMemo(() => {
    if (!nudgeData) return [];
    return [...new Set(nudgeData.nudges.map((n) => n.schemeId))];
  }, [nudgeData]);

  const uniqueHeads = useMemo(() => {
    if (!nudgeData) return [];
    return [...new Set(nudgeData.nudges.map((n) => n.stateHead ?? "—"))].sort();
  }, [nudgeData]);

  // Trip zone rows (Q_OTHER with trip reward type)
  const tripRows = useMemo(() => {
    if (!nudgeData) return [];
    return nudgeData.nudges.filter(
      (n) => n.schemeId === "Q_OTHER" && n.rewardType === "trip",
    );
  }, [nudgeData]);

  // Sales head rollup
  const headRollup = useMemo(() => {
    if (!nudgeData) return [];
    const map = new Map<string, { head: string; nudges: number; opportunity: number; theyEarn: number }>();
    for (const n of nudgeData.nudges) {
      if (n.status !== "NUDGE") continue;
      const head = n.stateHead ?? "Unassigned";
      const cur = map.get(head) ?? { head, nudges: 0, opportunity: 0, theyEarn: 0 };
      cur.nudges++;
      cur.opportunity += n.gap;
      cur.theyEarn += n.theyEarn ?? 0;
      map.set(head, cur);
    }
    return [...map.values()].sort((a, b) => b.theyEarn - a.theyEarn);
  }, [nudgeData]);

  function SortBtn({ k }: { k: typeof sortKey }) {
    const active = sortKey === k;
    return (
      <button
        className="inline-flex items-center gap-0.5 hover:text-foreground"
        onClick={() => {
          if (active) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
          else { setSortKey(k); setSortDir("desc"); }
        }}
      >
        {active
          ? sortDir === "desc"
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronUp className="h-3.5 w-3.5" />
          : <span className="text-muted-foreground opacity-50">↕</span>}
      </button>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Scheme Nudge Engine</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            What each distributor needs to do to earn more from the current scheme.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded border bg-background px-2 text-xs"
            value={fy}
            onChange={(e) => setFy(e.target.value)}
          >
            <option value="2026-27">FY 2026-27</option>
            <option value="2025-26">FY 2025-26</option>
          </select>
          <select
            className="h-8 rounded border bg-background px-2 text-xs"
            value={quarter}
            onChange={(e) => setQuarter(e.target.value as typeof quarter)}
          >
            <option value="Q1">Q1 Apr-Jun</option>
            <option value="Q2">Q2 Jul-Sep</option>
            <option value="Q3">Q3 Oct-Dec</option>
            <option value="Q4">Q4 Jan-Mar</option>
          </select>
          <Button size="sm" variant="outline" onClick={fetchNudge} disabled={nudgeLoading}>
            <RefreshCw className={`h-3.5 w-3.5 ${nudgeLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto pb-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`shrink-0 px-3 py-1.5 text-xs rounded-t font-medium transition-colors ${
              tab === t.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {nudgeError && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {nudgeError}
        </div>
      )}

      {/* ── NUDGE LIST ─────────────────────────────────────────────────────── */}
      {tab === "nudge" && (
        <div className="space-y-3">
          {/* Banner: deadline + opportunity */}
          {nudgeData && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <KpiTile label="Deadline" value={nudgeData.deadline} sub={
                nudgeData.daysToDeadline >= 0
                  ? `${nudgeData.daysToDeadline} days left`
                  : `${Math.abs(nudgeData.daysToDeadline)} days past`
              } urgent={nudgeData.daysToDeadline <= 14} />
              <KpiTile label="Live nudges" value={String(nudgeData.nudgeCount)} sub={`${qLabel(nudgeData.quarter)} ${nudgeData.fy}`} />
              <KpiTile label="Gap to close" value={inr(nudgeData.totalOpportunity)} sub="across all distributors" />
              <KpiTile label="Dues check" value={nudgeData.duesDataAvailable ? "Active" : "Inactive"}
                sub={nudgeData.duesDataAvailable ? `${nudgeData.blocked.length} blocked` : "No dues data"} />
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              placeholder="Search distributor..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 rounded border bg-background px-2 text-xs w-44"
            />
            <select
              className="h-7 rounded border bg-background px-2 text-xs"
              value={schemeFilter}
              onChange={(e) => setSchemeFilter(e.target.value)}
            >
              <option value="all">All schemes</option>
              {uniqueSchemes.map((s) => (
                <option key={s} value={s}>{SCHEME_SHORT[s] ?? s}</option>
              ))}
            </select>
            <select
              className="h-7 rounded border bg-background px-2 text-xs"
              value={headFilter}
              onChange={(e) => setHeadFilter(e.target.value)}
            >
              <option value="all">All heads</option>
              {uniqueHeads.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showBlocked}
                onChange={(e) => setShowBlocked(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Show blocked
            </label>
          </div>

          {nudgeLoading ? (
            <div className="text-xs text-muted-foreground py-6 text-center">Computing nudges...</div>
          ) : (
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Distributor</th>
                    <th className="px-3 py-2 text-left font-medium">Scheme</th>
                    <th className="px-3 py-2 text-right font-medium">
                      Billed <SortBtn k="billedSoFar" />
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Next slab</th>
                    <th className="px-3 py-2 text-right font-medium">
                      Gap <SortBtn k="gap" />
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      They earn <SortBtn k="theyEarn" />
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      ROI <SortBtn k="roi" />
                    </th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {displayNudges.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-muted-foreground">
                        No nudges for selected filters.
                      </td>
                    </tr>
                  ) : (
                    displayNudges.map((n, i) => (
                      <tr key={`${n.customer}|${n.schemeId}`} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                        <td className="px-3 py-1.5">
                          <div className="font-medium leading-tight">{n.customer}</div>
                          {n.stateHead && (
                            <div className="text-[10px] text-muted-foreground">{n.stateHead}</div>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                          {SCHEME_SHORT[n.schemeId] ?? n.schemeId}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{inr(n.billedSoFar)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                          {n.rewardType === "trip"
                            ? inr(n.nextSlab)
                            : n.nextRate != null
                            ? `${inr(n.nextSlab)} @ ${pct(n.nextRate)}`
                            : inr(n.nextSlab)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{inr(n.gap)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                          {n.rewardType === "trip"
                            ? <span className="text-purple-600 dark:text-purple-400">{n.tripLabel ?? "Trip"}</span>
                            : inr(n.theyEarn)}
                        </td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${roiColor(n.roi)}`}>
                          {n.roi != null ? pct(n.roi) : "—"}
                        </td>
                        <td className="px-3 py-1.5">
                          <StatusBadge status={n.status} blockedReason={n.blockedReason} />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {nudgeData?.duesError && (
            <div className="text-[10px] text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3 w-3 text-amber-500" />
              Dues check unavailable: {nudgeData.duesError}
            </div>
          )}
        </div>
      )}

      {/* ── COCKPIT ────────────────────────────────────────────────────────── */}
      {tab === "cockpit" && (
        <div className="space-y-4">
          {cockpitData ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <KpiTile label="Total opportunity" value={inr(cockpitData.totalLiveOpportunity)} sub="gap to close across nudges" />
                <KpiTile label="Scheme cost (so far)" value={inr(cockpitData.totalSchemeCost)} sub="cumulative earned" />
                <KpiTile label="Active nudges" value={String(cockpitData.totalNudges)} sub={qLabel(cockpitData.quarter)} />
                <KpiTile label="Days to deadline" value={`${cockpitData.daysToDeadline}d`}
                  sub={cockpitData.deadline}
                  urgent={cockpitData.daysToDeadline <= 14} />
              </div>

              <div className="overflow-x-auto rounded border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/50 text-muted-foreground">
                      <th className="px-3 py-2 text-left font-medium">Scheme</th>
                      <th className="px-3 py-2 text-right font-medium">Participants</th>
                      <th className="px-3 py-2 text-right font-medium">Total billed</th>
                      <th className="px-3 py-2 text-right font-medium">Earned so far</th>
                      <th className="px-3 py-2 text-right font-medium">Live nudges</th>
                      <th className="px-3 py-2 text-right font-medium">Opportunity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cockpitData.byScheme.map((row) => (
                      <tr key={row.schemeId} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-1.5 font-medium">{SCHEME_SHORT[row.schemeId] ?? row.schemeId}</td>
                        <td className="px-3 py-1.5 text-right">{row.participantCount}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{inr(row.totalBilled)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{inr(row.totalEarned)}</td>
                        <td className="px-3 py-1.5 text-right">{row.nudgeCount}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{inr(row.opportunityAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground py-6 text-center">
              {nudgeLoading ? "Loading cockpit..." : "No data"}
            </div>
          )}
        </div>
      )}

      {/* ── ANNUAL TRACKER ─────────────────────────────────────────────────── */}
      {tab === "annual" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Annual slab projection based on complete months only. "At risk" = projected FY total below prior year.
          </p>
          {!annualData ? (
            <div className="text-xs text-muted-foreground py-6 text-center">Loading annual tracker...</div>
          ) : (
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Distributor</th>
                    <th className="px-3 py-2 text-right font-medium">FY to date</th>
                    <th className="px-3 py-2 text-right font-medium">Projected FY</th>
                    <th className="px-3 py-2 text-right font-medium">vs prior year</th>
                    <th className="px-3 py-2 text-right font-medium">Current slab</th>
                    <th className="px-3 py-2 text-left font-medium">Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {annualData.rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-muted-foreground">
                        No complete months yet for {fy}.
                      </td>
                    </tr>
                  ) : (
                    annualData.rows.map((r) => (
                      <tr key={r.customer} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-1.5">
                          <div className="font-medium">{r.customer}</div>
                          {r.stateHead && <div className="text-[10px] text-muted-foreground">{r.stateHead}</div>}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{inr(r.fyTotal)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-medium">{inr(r.projectedTotal)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${
                          r.projectedVsLyPct == null ? "text-muted-foreground"
                          : r.projectedVsLyPct >= 0 ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                        }`}>
                          {r.projectedVsLyPct != null
                            ? `${r.projectedVsLyPct >= 0 ? "+" : ""}${(r.projectedVsLyPct * 100).toFixed(1)}%`
                            : "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right text-muted-foreground">
                          {r.currentRate != null ? `Slab ${r.currentSlabIdx + 1} (${pct(r.currentRate)})` : "Below min"}
                        </td>
                        <td className="px-3 py-1.5">
                          {r.atRisk
                            ? <span className="flex items-center gap-1 text-red-600 dark:text-red-400 text-[10px]">
                                <TrendingDown className="h-3 w-3" /> At risk
                              </span>
                            : <span className="flex items-center gap-1 text-green-600 dark:text-green-400 text-[10px]">
                                <TrendingUp className="h-3 w-3" /> On track
                              </span>}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── SALES HEAD COCKPIT ─────────────────────────────────────────────── */}
      {tab === "heads" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Nudge opportunity rolled up by territory head. Use this to brief the head on what their team can unlock.
          </p>
          {!nudgeData ? (
            <div className="text-xs text-muted-foreground py-6 text-center">Loading...</div>
          ) : headRollup.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">No nudge data for this period.</div>
          ) : (
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Sales head</th>
                    <th className="px-3 py-2 text-right font-medium">Nudge count</th>
                    <th className="px-3 py-2 text-right font-medium">Opportunity (gap)</th>
                    <th className="px-3 py-2 text-right font-medium">They earn (total)</th>
                  </tr>
                </thead>
                <tbody>
                  {headRollup.map((row) => (
                    <tr key={row.head} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-1.5 font-medium">{row.head}</td>
                      <td className="px-3 py-1.5 text-right">{row.nudges}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{inr(row.opportunity)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium text-green-700 dark:text-green-400">{inr(row.theyEarn)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── TRIP BOARD ─────────────────────────────────────────────────────── */}
      {tab === "trips" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Distributors in reach of a trip incentive (Q_OTHER scheme). Top up the gap and earn a Goa, Thailand or Vietnam trip.
          </p>
          {!nudgeData ? (
            <div className="text-xs text-muted-foreground py-6 text-center">Loading...</div>
          ) : tripRows.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">No distributors in trip zone for this period.</div>
          ) : (
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">Distributor</th>
                    <th className="px-3 py-2 text-right font-medium">Billed so far</th>
                    <th className="px-3 py-2 text-right font-medium">Trip threshold</th>
                    <th className="px-3 py-2 text-right font-medium">Gap</th>
                    <th className="px-3 py-2 text-left font-medium">Trip</th>
                  </tr>
                </thead>
                <tbody>
                  {tripRows.map((n) => (
                    <tr key={n.customer} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-1.5">
                        <div className="font-medium">{n.customer}</div>
                        {n.stateHead && <div className="text-[10px] text-muted-foreground">{n.stateHead}</div>}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{inr(n.billedSoFar)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{inr(n.nextSlab)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-medium">{inr(n.gap)}</td>
                      <td className="px-3 py-1.5">
                        <span className="flex items-center gap-1 text-purple-700 dark:text-purple-400 font-medium">
                          <Gift className="h-3.5 w-3.5" />
                          {n.tripLabel ?? "Trip"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── SCHEME MASTER ──────────────────────────────────────────────────── */}
      {tab === "master" && (
        <div className="space-y-4">
          {!masterData ? (
            <div className="text-xs text-muted-foreground py-6 text-center">Loading scheme master...</div>
          ) : (
            <>
              {masterData.schemes.map((scheme) => (
                <div key={scheme.id} className="rounded border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded">{scheme.id}</span>
                    <span className="text-xs font-medium">{scheme.name}</span>
                    <span className="text-[10px] text-muted-foreground ml-auto">{scheme.basis.replace(/_/g, " ")}</span>
                  </div>
                  {scheme.stateRestriction && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400">
                      Restricted to: {scheme.stateRestriction.join(", ")}
                    </p>
                  )}
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="text-left font-normal py-0.5">Threshold</th>
                        <th className="text-right font-normal py-0.5">Rate / Reward</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scheme.slabs.map((s, i) => (
                        <tr key={i} className="border-t">
                          <td className="py-0.5 tabular-nums">
                            {scheme.basis === "single_invoice_qty"
                              ? `${s.threshold} units`
                              : `≥ ${inr(s.threshold)}`}
                          </td>
                          <td className="py-0.5 text-right font-medium">
                            {s.rewardType === "trip"
                              ? <span className="text-purple-600 dark:text-purple-400">{s.reward}</span>
                              : s.rewardType === "pct_or_trip"
                              ? <span>{s.reward ?? pct(s.rate ?? 0)}</span>
                              : pct(s.rate ?? 0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  sub,
  urgent,
}: {
  label: string;
  value: string;
  sub?: string;
  urgent?: boolean;
}) {
  return (
    <div className={`rounded border p-3 ${urgent ? "border-red-400 bg-red-50 dark:bg-red-950/30" : ""}`}>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={`text-base font-semibold mt-0.5 ${urgent ? "text-red-600 dark:text-red-400" : ""}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function StatusBadge({ status, blockedReason }: { status: string; blockedReason: string | null }) {
  if (status === "BLOCKED") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-red-600 dark:text-red-400 font-medium">
        <Lock className="h-3 w-3" /> Blocked
      </span>
    );
  }
  if (status === "AT_MAX") {
    return <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">Max slab</span>;
  }
  if (status === "TRIP_ZONE") {
    return (
      <span className="flex items-center gap-1 text-[10px] text-purple-600 dark:text-purple-400 font-medium">
        <Gift className="h-3 w-3" /> Trip zone
      </span>
    );
  }
  return <span className="text-[10px] text-blue-600 dark:text-blue-400 font-medium">Nudge</span>;
}
