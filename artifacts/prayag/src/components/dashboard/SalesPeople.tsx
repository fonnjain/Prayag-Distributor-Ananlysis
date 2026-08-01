// SalesPeople — flat monthly secondary-sales table.
//
// Data source: GET /api/mgmt/data (STATE HEAD DASHBOARD).
// Achievement = Sales Received ÷ Plan.  Never OB ÷ Plan.
//   Column header is "Sales/Plan%" to name the denominator explicitly.
// Current open month shows "In Progress" — never a bare 0%.
// Closed month with sales=0 but ob>0: stateDashboard.ts sets notYetRecorded=true
//   (sales-lag guard) so the Ach% cell shows "Not recorded" here without any
//   additional display logic.  achPct() does not need to know about ob.
// Primary-role members (19) have no SOBR row → monthly cells show "—" (FY data only).
// FY + month selection driven by the global filter context (GlobalFilterBar).
import { useState, useEffect, useMemo } from "react";
import { achBandText } from "@/lib/achievementBands";
import { useGlobalFilter, type FiscalMonthIdx, FISCAL_MONTH_NAMES } from "@/data/global-filter-context";

const FISCAL_MONTHS = FISCAL_MONTH_NAMES;

// ── Types ─────────────────────────────────────────────────────────────────────

type Member = {
  normKey: string;
  name: string;
  stateHead: string;
  state: string;
  isPrimaryRole: boolean;
  isLeft: boolean;
  secondaryPlan: number | null;
  secondaryOrderBooked: number | null;
  secondarySalesReceived: number | null;
  secondaryAchievement: number | null;
  monthlyPlan: number[] | null;
  monthlyOrderBooked: number[] | null;
  monthlySalesReceived: number[] | null;
  monthlyAchievement: number[] | null;
  monthlyNotYetRecorded: boolean[] | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

function achPct(sales: number | null, plan: number | null): number | null {
  if (plan == null || plan <= 0) return null;
  if (sales == null) return null;
  return (sales / plan) * 100;
}

/** Calendar month of today (0=Jan … 11=Dec) and year. */
function nowCalMonthYear(): { calMonth: number; calYear: number } {
  const d = new Date();
  return { calMonth: d.getMonth(), calYear: d.getFullYear() };
}

/** True if the given fiscal index is the current in-progress calendar month. */
function isCurrentCalMonth(fiscalIdx: number, fy: string): boolean {
  const fyStart = parseInt(fy.split("-")[0], 10);
  if (isNaN(fyStart)) return false;
  const calMonth = (fiscalIdx + 3) % 12;
  const calYear = fiscalIdx <= 8 ? fyStart : fyStart + 1;
  const { calMonth: nowM, calYear: nowY } = nowCalMonthYear();
  return calYear === nowY && calMonth === nowM;
}

/** True if the fiscal month is in the future (not yet reached). */
function isFutureMonth(fiscalIdx: number, fy: string): boolean {
  const fyStart = parseInt(fy.split("-")[0], 10);
  if (isNaN(fyStart)) return false;
  const calMonth = (fiscalIdx + 3) % 12;
  const calYear = fiscalIdx <= 8 ? fyStart : fyStart + 1;
  const { calMonth: nowM, calYear: nowY } = nowCalMonthYear();
  if (calYear > nowY) return true;
  if (calYear === nowY && calMonth > nowM) return true;
  return false;
}

// Shared band scale — single source of truth in lib/achievementBands.ts.
function achClass(pct: number | null): string {
  return achBandText(pct);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SalesPeople() {
  // FY + month driven by global filter (GlobalFilterBar handles the UI).
  const {
    fy,
    effectiveMonthIdx: monthIdx,
    setMonthIdx,
    setPeriodMode,
  } = useGlobalFilter();

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPrimary, setShowPrimary] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedHead, setSelectedHead] = useState<string>("All");
  const [selectedMember, setSelectedMember] = useState<string>("All");
  const [sortKey, setSortKey] = useState<"name"|"stateHead"|"plan"|"ob"|"sales"|"ach">("ach");
  const [sortDir, setSortDir] = useState<"asc"|"desc">("asc");

  // When a month tab is clicked, update the global filter.
  function selectMonthTab(fi: FiscalMonthIdx) {
    setMonthIdx(fi);
    setPeriodMode("month");
  }

  // Fetch member data for the full FY.
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/mgmt/data?fy=${encodeURIComponent(fy)}&monthFrom=1&monthTo=12`)
      .then((r) => {
        if (!r.ok) return r.json().then((e: { error?: string }) => { throw new Error(e.error ?? r.statusText); });
        return r.json();
      })
      .then((d: { rows: Member[] }) => {
        setMembers(d.rows ?? []);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [fy]);

  const currentMonth = isCurrentCalMonth(monthIdx, fy);
  const futureMonth = isFutureMonth(monthIdx, fy);

  // Sorted list of all distinct state heads for the dropdown.
  const stateHeads = useMemo(
    () => ["All", ...Array.from(new Set(members.map((m) => m.stateHead).filter(Boolean))).sort()],
    [members],
  );

  // Members available in the member dropdown — filtered to the selected state head.
  const memberOptions = useMemo(() => {
    const base = selectedHead === "All" ? members : members.filter((m) => m.stateHead === selectedHead);
    const sorted = [...base].sort((a, b) => a.name.localeCompare(b.name));
    return ["All", ...sorted.map((m) => m.name)];
  }, [members, selectedHead]);

  // Reset member selection whenever state head changes.
  useEffect(() => {
    setSelectedMember("All");
  }, [selectedHead]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (!showPrimary && m.isPrimaryRole) return false;
      if (selectedHead !== "All" && m.stateHead !== selectedHead) return false;
      if (selectedMember !== "All" && m.name !== selectedMember) return false;
      if (q && !m.name.toLowerCase().includes(q) && !m.stateHead.toLowerCase().includes(q) && !m.state.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [members, showPrimary, search, selectedHead, selectedMember]);

  const sortedRows = useMemo(() => {
    return [...filteredRows].sort((a, b) => {
      let av: number | string | null = null;
      let bv: number | string | null = null;
      if (sortKey === "name") { av = a.name; bv = b.name; }
      else if (sortKey === "stateHead") { av = a.stateHead; bv = b.stateHead; }
      else if (sortKey === "plan") {
        av = a.monthlyPlan?.[monthIdx] ?? null;
        bv = b.monthlyPlan?.[monthIdx] ?? null;
      } else if (sortKey === "ob") {
        av = a.monthlyOrderBooked?.[monthIdx] ?? null;
        bv = b.monthlyOrderBooked?.[monthIdx] ?? null;
      } else if (sortKey === "sales") {
        av = a.monthlySalesReceived?.[monthIdx] ?? null;
        bv = b.monthlySalesReceived?.[monthIdx] ?? null;
      } else if (sortKey === "ach") {
        av = achPct(a.monthlySalesReceived?.[monthIdx] ?? null, a.monthlyPlan?.[monthIdx] ?? null);
        bv = achPct(b.monthlySalesReceived?.[monthIdx] ?? null, b.monthlyPlan?.[monthIdx] ?? null);
      }
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        const c = av.localeCompare(bv);
        return sortDir === "asc" ? c : -c;
      }
      const diff = (av as number) - (bv as number);
      return sortDir === "asc" ? diff : -diff;
    });
  }, [filteredRows, sortKey, sortDir, monthIdx]);

  function toggleSort(key: typeof sortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  function SortArrow({ k }: { k: typeof sortKey }) {
    if (sortKey !== k) return <span className="text-muted-foreground/40 ml-0.5">⇅</span>;
    return <span className="ml-0.5">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }

  // Month tab label
  function monthLabel(fi: FiscalMonthIdx): string {
    const m = FISCAL_MONTHS[fi];
    if (isCurrentCalMonth(fi, fy)) return `${m} (Open)`;
    if (isFutureMonth(fi, fy)) return m;
    return m;
  }

  // Summary totals
  const summary = useMemo(() => {
    let plan = 0, ob = 0, sales = 0, count = 0;
    for (const r of sortedRows) {
      const p = r.monthlyPlan?.[monthIdx] ?? 0;
      const o = r.monthlyOrderBooked?.[monthIdx] ?? 0;
      const s = r.monthlySalesReceived?.[monthIdx] ?? 0;
      plan += p; ob += o; sales += s;
      if (p > 0) count++;
    }
    return { plan, ob, sales, count };
  }, [sortedRows, monthIdx]);

  const summaryAch = achPct(summary.sales, summary.plan);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
        Loading sales data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-red-300 bg-red-50 dark:bg-red-950/20 p-4 text-sm text-red-700 dark:text-red-300">
        Could not load data: {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        {/* State Head dropdown */}
        <select
          value={selectedHead}
          onChange={(e) => setSelectedHead(e.target.value)}
          className="rounded border bg-background px-2 py-1 text-sm min-w-[140px] max-w-[200px] cursor-pointer"
        >
          {stateHeads.map((h) => (
            <option key={h} value={h}>{h === "All" ? "All State Heads" : h}</option>
          ))}
        </select>

        {/* Sales Person dropdown — cascades from State Head */}
        <select
          value={selectedMember}
          onChange={(e) => setSelectedMember(e.target.value)}
          className="rounded border bg-background px-2 py-1 text-sm min-w-[140px] max-w-[200px] cursor-pointer"
        >
          {memberOptions.map((n) => (
            <option key={n} value={n}>{n === "All" ? "All Members" : n}</option>
          ))}
        </select>

        {/* Free-text search */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name / state..."
          className="rounded border bg-background px-2 py-1 text-sm flex-1 min-w-[140px] max-w-[220px]"
        />

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={showPrimary}
            onChange={(e) => setShowPrimary(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Show primary-role members
        </label>
        <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">
          {sortedRows.length} members
        </span>
      </div>

      {/* In-progress banner */}
      {currentMonth && (
        <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {FISCAL_MONTHS[monthIdx]} is the current open month. Data is in progress — achievement percentages are not yet meaningful. Values entered so far are shown.
        </div>
      )}
      {futureMonth && (
        <div className="rounded border border-border/40 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {FISCAL_MONTHS[monthIdx]} has not started yet. No data available.
        </div>
      )}

      {/* Summary row */}
      {!futureMonth && (
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: "Members with plan", value: summary.count.toString() },
            { label: "Plan", value: fmt(summary.plan) },
            { label: "OB", value: fmt(summary.ob) },
            { label: "Sales", value: fmt(summary.sales) },
          ].map((t) => (
            <div key={t.label} className="rounded border bg-card p-3">
              <p className="text-xs text-muted-foreground">{t.label}</p>
              <p className="text-base font-semibold tabular-nums mt-0.5">{t.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Table */}
      {!futureMonth && (
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b bg-muted/30">
                <th className="text-left px-3 py-2 font-medium cursor-pointer whitespace-nowrap" onClick={() => toggleSort("name")}>
                  Name <SortArrow k="name" />
                </th>
                <th className="text-left px-3 py-2 font-medium cursor-pointer whitespace-nowrap hidden md:table-cell" onClick={() => toggleSort("stateHead")}>
                  State Head <SortArrow k="stateHead" />
                </th>
                <th className="text-right px-3 py-2 font-medium cursor-pointer whitespace-nowrap" onClick={() => toggleSort("plan")}>
                  Plan <SortArrow k="plan" />
                </th>
                <th className="text-right px-3 py-2 font-medium cursor-pointer whitespace-nowrap" onClick={() => toggleSort("ob")}>
                  OB <SortArrow k="ob" />
                </th>
                <th className="text-right px-3 py-2 font-medium cursor-pointer whitespace-nowrap" onClick={() => toggleSort("sales")}>
                  Sales <SortArrow k="sales" />
                </th>
                <th className="text-right px-3 py-2 font-medium cursor-pointer whitespace-nowrap" onClick={() => toggleSort("ach")}>
                  Sales/Plan% <SortArrow k="ach" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground text-sm">
                    No members match the current filters.
                  </td>
                </tr>
              )}
              {sortedRows.map((r) => {
                const plan = r.monthlyPlan?.[monthIdx] ?? null;
                const ob = r.monthlyOrderBooked?.[monthIdx] ?? null;
                const sales = r.monthlySalesReceived?.[monthIdx] ?? null;
                const notRecorded = r.monthlyNotYetRecorded?.[monthIdx] ?? false;
                const ach = achPct(sales, plan);

                return (
                  <tr key={r.normKey} className={[
                    "border-b border-border/30 last:border-0 hover:bg-muted/30 transition-colors",
                    r.isLeft ? "opacity-50" : "",
                  ].join(" ")}>
                    <td className="px-3 py-2">
                      <span className="font-medium">{r.name}</span>
                      {r.isLeft && (
                        <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 border border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800">Left</span>
                      )}
                      {r.isPrimaryRole && <span className="ml-1.5 text-[10px] text-muted-foreground">(primary)</span>}
                      <span className="block text-xs text-muted-foreground md:hidden">{r.stateHead}</span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs hidden md:table-cell">{r.stateHead}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm">{plan != null && plan > 0 ? fmt(plan) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm">{ob != null && ob > 0 ? fmt(ob) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm">{sales != null && sales > 0 ? fmt(sales) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-sm">
                      {currentMonth || notRecorded ? (
                        <span className="text-xs text-amber-600 dark:text-amber-400">
                          {notRecorded ? "Not recorded" : "In progress"}
                        </span>
                      ) : plan == null || plan <= 0 ? (
                        <span className="text-muted-foreground">No plan</span>
                      ) : (
                        <span className={achClass(ach)}>
                          {ach != null ? `${ach.toFixed(1)}%` : "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {sortedRows.length > 0 && summary.plan > 0 && (
              <tfoot>
                <tr className="border-t border-border/50 bg-muted/20 text-xs font-medium">
                  <td className="px-3 py-2" colSpan={2}>Total ({sortedRows.length})</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(summary.plan)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(summary.ob)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(summary.sales)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${currentMonth ? "text-amber-600 dark:text-amber-400" : achClass(summaryAch)}`}>
                    {currentMonth ? "In progress" : summaryAch != null ? `${summaryAch.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {members.length === 0 && !loading && (
        <div className="rounded border border-border/40 bg-muted/20 px-4 py-6 text-sm text-muted-foreground text-center">
          No data loaded. STATE HEAD DASHBOARD data populates automatically — try refreshing in a moment.
        </div>
      )}
    </div>
  );
}
