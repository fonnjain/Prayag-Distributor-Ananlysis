// Combined Performance — Primary vs Secondary.
//
// CORRECT business model:
//   Prayag sells ONCE to Distributors (PRIMARY). The same transaction —
//   salesperson takes orders from retailers/dealers, distributor then buys from
//   Prayag — is the SECONDARY booking. Secondary ⊂ Primary: it is the
//   salesperson-attributed portion of primary, never a separate flow.
//   Adding the two figures is double-counting.
//
// Two cadences:
//   PRIMARY — invoiced daily by Prayag from the register chain.
//   SECONDARY — recorded once a month at month-end by each salesperson.
//   This is why like-months comparison (same closed months in both FYs) matters:
//   secondary only has complete data for closed months.
//
// What this page shows:
//   1. PRIMARY — Order Booking (committed), Sale (dispatched), Pending.
//   2. SECONDARY — Plan (target), Order Booked, Sales Received.
//   3. COVERAGE — secondary sales / primary sale (like-months basis).
//      Shows what share of primary was salesperson-supported.
//   4. COVERAGE GAP — primary sale minus secondary sales.
//      Business that arrived without direct salesperson touch.
//
// Achievement = Sales Received / Plan (STATE HEAD DASHBOARD — recomputed,
//   never copied from the sheet). Closed months only for YTD.
//   Mid-month data not yet recorded = shown as "—", never 0%.
//
// Anomaly rule: per-person per-month, if sales > orders × 1.5 — impossible,
//   flag but show the recorded value; exclude from rankings.
import { useState, useEffect, useMemo, Fragment } from "react";
import {
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCompleteMonths } from "@/hooks/useCompleteMonths";

// ── Types ─────────────────────────────────────────────────────────────────────

type Member = {
  name: string;
  stateHead: string;
  state: string;
  primaryOrderAmount: number | null;
  primarySaleAmount: number | null;
  primaryDistributors: number | null;
  orderBooking: number | null;
  saleAmount: number | null;
  totalRetailers: number | null;
  achievementPct: number | null;
  targetSecondary: number | null;
  // STATE HEAD DASHBOARD fields (authoritative secondary source)
  secondaryPlan: number | null;
  secondaryOrderBooked: number | null;
  secondarySalesReceived: number | null;
  secondaryAchievement: number | null;
  secondaryBusinessPlan: number | null;
  salary: number | null;
  totalDealers: number | null;
  monthlyPlan: (number | null)[] | null;
  monthlyOrderBooked: (number | null)[] | null;
  monthlySalesReceived: (number | null)[] | null;
  monthlyAchievement: (number | null)[] | null;
  monthlyNotYetRecorded: boolean[] | null;
  isPrimaryRole: boolean;
  isLeft: boolean;
  hasSecondaryAnomaly: boolean;
};

type SecondaryTotal = {
  plan: number;
  orderBooked: number;
  salesReceived: number;
  ytdAchievement: number | null;
  totalDealers: number;
};

type AnomalyRecord = {
  name: string;
  stateHead: string;
  monthIdx: number;
  monthLabel: string;
  salesAmount: number;
  orderedAmount: number;
  ratio: number;
};

type DashboardMeta = {
  headSales?: Record<string, number>;
  orderBookingPrimary?: Record<string, number>;
  pendingOrdersTotal?: number | null;
  secondarySource?: string | null;
  secondaryTotal?: SecondaryTotal | null;
  secondaryCoveragePct?: number | null;
  anomalies?: AnomalyRecord[];
  fy?: string;
};

type DashboardData = {
  rows: Member[];
  meta: DashboardMeta;
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number | null | undefined): string {
  if (n == null) return "—";
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

function achColor(pct: number | null | undefined): string {
  if (pct == null) return "text-muted-foreground";
  if (pct >= 1.0) return "text-green-700 dark:text-green-400";
  if (pct >= 0.7) return "text-amber-700 dark:text-amber-400";
  return "text-red-700 dark:text-red-400";
}

// ── KPI tile ──────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  sub,
  value,
  note,
  warn,
}: {
  label: string;
  sub?: string;
  value: string;
  note?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex-1 min-w-[140px] rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {sub && <p className="text-[10px] text-muted-foreground/70 mb-1">{sub}</p>}
      <p className="text-xl font-semibold font-mono mt-0.5">{value}</p>
      {note && (
        <p className={cn("text-[10px] mt-0.5", warn ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          {note}
        </p>
      )}
    </div>
  );
}

// ── Row types ─────────────────────────────────────────────────────────────────

type RepRow = {
  name: string;
  stateHead: string;
  primarySale: number;
  secPlan: number | null;
  secOrdered: number | null;
  secSales: number | null;
  secAchievement: number | null;
  dealers: number | null;
  coveragePct: number | null;
  coverageGap: number | null;
  isPrimaryRole: boolean;
  isLeft: boolean;
  hasAnomaly: boolean;
};

type HeadGroup = {
  head: string;
  primarySale: number;
  secPlan: number;
  secOrdered: number;
  secSales: number;
  secAchievement: number | null;
  coveragePct: number | null;
  coverageGap: number | null;
  members: RepRow[];
};

// ── Main component ─────────────────────────────────────────────────────────────

const FYS = ["2026-27", "2025-26", "2024-25"] as const;

export default function CombinedPerformanceDashboard() {
  const [fy, setFy] = useState("2026-27");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedHeads, setExpandedHeads] = useState<Set<string>>(new Set());
  // Canonical complete-months enforcement: completeMonths = closed months only,
  // lastSyncedAt = ISO timestamp of last register sync (null until first sync).
  // This is the single source of truth for month-filtering across all KPI tiles.
  const { completeMonths, lastSyncedAt } = useCompleteMonths(fy);

  // Per-month primary amounts from the company-reports endpoint (needed to
  // compute the like-months primary total). The month filter itself comes from
  // completeMonths above — explicit label intersection, not an implicit total.
  const [monthlyPrimary, setMonthlyPrimary] = useState<
    Array<{ label: string; amount: number }>
  >([]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ fy, monthFrom: "1", monthTo: "12" });
    fetch(`/api/mgmt/data?${params}`)
      .then((r) => {
        if (!r.ok) return r.json().then((e: { error?: string }) => { throw new Error(e.error ?? r.statusText); });
        return r.json() as Promise<DashboardData>;
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((err: Error) => { setError(err.message); setLoading(false); });
  }, [fy]);

  // Fetch monthly primary amounts from the company-reports endpoint.
  // Only the per-month array is used here; the month filter comes from
  // useCompleteMonths (above) so the intersection is always explicit.
  useEffect(() => {
    setMonthlyPrimary([]);
    fetch(`/api/company-reports?fy=${encodeURIComponent(fy)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { monthlyPrimary?: Array<{ label: string; amount: number }> } | null) => {
        if (d?.monthlyPrimary) setMonthlyPrimary(d.monthlyPrimary);
      })
      .catch(() => setMonthlyPrimary([]));
  }, [fy]);

  const hasStateDashboard = useMemo(() => {
    return !!data?.meta.secondarySource;
  }, [data]);

  // Build per-rep rows — secondary members only (exclude primary-role TMs)
  const repRows = useMemo((): RepRow[] => {
    if (!data) return [];
    return data.rows
      .filter((m) => !m.isPrimaryRole)
      .map((m): RepRow => {
        const primarySale = m.primarySaleAmount ?? 0;
        // Prefer STATE HEAD DASHBOARD values; fall back to old fields
        const secPlan = m.secondaryPlan ?? m.targetSecondary;
        const secOrdered = m.secondaryOrderBooked ?? m.orderBooking;
        const secSales = m.secondarySalesReceived ?? m.saleAmount;
        const secAchievement = m.secondaryAchievement ?? m.achievementPct;
        const dealers = m.totalDealers ?? m.totalRetailers;
        // Coverage: secondary sales as a fraction of primary sale
        const coveragePct =
          secSales != null && primarySale > 0 ? secSales / primarySale : null;
        const coverageGap =
          secSales != null && primarySale > 0 ? primarySale - secSales : null;
        return {
          name: m.name,
          stateHead: m.stateHead || "Unassigned",
          primarySale,
          secPlan,
          secOrdered,
          secSales,
          secAchievement,
          dealers,
          coveragePct,
          coverageGap,
          isPrimaryRole: m.isPrimaryRole,
          isLeft: m.isLeft,
          hasAnomaly: m.hasSecondaryAnomaly,
        };
      })
      .sort((a, b) => b.primarySale - a.primarySale);
  }, [data]);

  // Group by state head
  const headGroups = useMemo((): HeadGroup[] => {
    const map = new Map<string, HeadGroup>();
    for (const r of repRows) {
      const existing = map.get(r.stateHead);
      if (existing) {
        existing.primarySale += r.primarySale;
        existing.secPlan += r.secPlan ?? 0;
        existing.secOrdered += r.secOrdered ?? 0;
        existing.secSales += r.secSales ?? 0;
        existing.members.push(r);
      } else {
        map.set(r.stateHead, {
          head: r.stateHead,
          primarySale: r.primarySale,
          secPlan: r.secPlan ?? 0,
          secOrdered: r.secOrdered ?? 0,
          secSales: r.secSales ?? 0,
          secAchievement: null,
          coveragePct: null,
          coverageGap: null,
          members: [r],
        });
      }
    }
    for (const g of map.values()) {
      g.secAchievement = g.secPlan > 0 ? g.secSales / g.secPlan : null;
      g.coveragePct = g.primarySale > 0 ? g.secSales / g.primarySale : null;
      g.coverageGap = g.primarySale > 0 ? g.primarySale - g.secSales : null;
    }
    return Array.from(map.values()).sort((a, b) => b.primarySale - a.primarySale);
  }, [repRows]);

  // Company totals (from STATE HEAD DASHBOARD secondary total when available)
  const secTotal = data?.meta.secondaryTotal;
  const headSalesTotal = useMemo(() => {
    const hs = data?.meta.headSales;
    if (!hs) return 0;
    return Object.values(hs).reduce((s, v) => s + v, 0);
  }, [data]);
  const primaryBookingTotal = useMemo(() => {
    const ob = data?.meta.orderBookingPrimary;
    if (!ob) return 0;
    return Object.values(ob).reduce((s, v) => s + v, 0);
  }, [data]);
  // Like-months primary total: sum only the months in completeMonths (from the
  // canonical hook) against the per-month primary array from company-reports.
  // This explicit label intersection guarantees primary and secondary cover the
  // exact same calendar months — secondary data is entered at month-end so its
  // total naturally matches the same closed-month set.
  const likeMonthsPrimaryTotal = useMemo(() => {
    if (!completeMonths.length || !monthlyPrimary.length) return null;
    const monthSet = new Set(completeMonths);
    return monthlyPrimary
      .filter((m) => monthSet.has(m.label))
      .reduce((s, m) => s + m.amount, 0);
  }, [completeMonths, monthlyPrimary]);

  const likeMonthsLabel = useMemo(() => {
    if (!completeMonths.length) return null;
    const first = completeMonths[0].slice(0, 3);
    const last = completeMonths[completeMonths.length - 1].slice(0, 3);
    return first === last ? first : `${first}–${last}`;
  }, [completeMonths]);

  const likeMonthsCoveragePct = useMemo(() => {
    if (!secTotal || !likeMonthsPrimaryTotal || likeMonthsPrimaryTotal === 0) return null;
    return secTotal.salesReceived / likeMonthsPrimaryTotal;
  }, [secTotal, likeMonthsPrimaryTotal]);

  const likeMonthsCoverageGap = useMemo(() => {
    if (!secTotal || !likeMonthsPrimaryTotal || likeMonthsPrimaryTotal === 0) return null;
    return likeMonthsPrimaryTotal - secTotal.salesReceived;
  }, [secTotal, likeMonthsPrimaryTotal]);

  const anomalies = data?.meta.anomalies ?? [];

  const toggleHead = (head: string) =>
    setExpandedHeads((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head);
      else next.add(head);
      return next;
    });

  return (
    <div className="space-y-5 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Salesperson Coverage</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Primary (Prayag to Distributor) and Secondary (salesperson order booking) — shown side by side, never summed
          </p>
        </div>
        <select
          value={fy}
          onChange={(e) => setFy(e.target.value)}
          className="text-xs border border-border rounded-md px-2 py-1.5 bg-background"
        >
          {FYS.map((f) => (
            <option key={f} value={f}>FY {f}</option>
          ))}
        </select>
      </div>

      {/* Model explanation */}
      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-500/5 p-3 text-xs">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
        <span className="text-blue-800 dark:text-blue-300">
          <strong>Why these are never added:</strong> Secondary sales are already counted within primary. Prayag bills the distributor (primary). The salesperson books that order from retailers (secondary). Same goods, same transaction — secondary is the salesperson-attributed portion of primary, never a separate flow. Coverage = secondary / primary tells you what share the team directly drove.
        </span>
      </div>

      {/* Cadence callout */}
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          <strong>Two cadences:</strong> Primary is invoiced <em>daily</em> by Prayag and updated live from the register chain.
          Secondary is recorded <em>once a month</em> (end-of-month) by each salesperson. Like-months coverage below
          compares secondary (closed months only) against the same calendar months of primary.
        </span>
      </div>

      {/* No STATE HEAD DASHBOARD data for this FY */}
      {!loading && data && !hasStateDashboard && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Secondary data (STATE HEAD DASHBOARD) is not available for FY {fy}.
            Achievement, coverage, and salesperson metrics are blank for this year.
          </span>
        </div>
      )}

      {loading && (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading combined performance data...
        </div>
      )}
      {error && (
        <div className="py-6 text-center text-sm text-destructive">{error}</div>
      )}

      {!loading && data && (
        <>
          {/* Company KPI tiles */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Company — FY {fy}
            </p>
            <div className="flex flex-wrap gap-3">
              <KpiTile
                label="Primary — Order Booking"
                sub="booked by distributors"
                value={fmtCr(primaryBookingTotal || null)}
              />
              <KpiTile
                label="Primary — Sale Dispatched"
                sub={lastSyncedAt
                  ? `invoiced by Prayag · synced ${new Date(lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : "invoiced by Prayag"}
                value={fmtCr(headSalesTotal || null)}
                note={
                  primaryBookingTotal > 0 && data.meta.pendingOrdersTotal != null
                    ? `${fmtCr(data.meta.pendingOrdersTotal)} pending`
                    : undefined
                }
                warn={(data.meta.pendingOrdersTotal ?? 0) / (primaryBookingTotal || 1) > 0.25}
              />
              <KpiTile
                label="Secondary — Sales Received"
                sub="salesperson-supported"
                value={secTotal ? fmtCr(secTotal.salesReceived) : "—"}
                note={secTotal ? `Plan: ${fmtCr(secTotal.plan)}` : "No data for this FY"}
              />
              <KpiTile
                label={likeMonthsLabel ? `Salesperson Coverage — ${likeMonthsLabel}` : "Salesperson Coverage"}
                sub={likeMonthsLabel
                  ? `secondary closed months / primary same months (${likeMonthsLabel})`
                  : "secondary (closed months) / primary (same months)"}
                value={likeMonthsCoveragePct != null ? fmtPct(likeMonthsCoveragePct) : "—"}
                note={
                  likeMonthsCoverageGap != null
                    ? `Gap: ${fmtCr(likeMonthsCoverageGap)} — apples-to-apples`
                    : !completeMonths.length || !monthlyPrimary.length
                    ? "Loading primary data..."
                    : undefined
                }
              />
              <KpiTile
                label="Secondary YTD Achievement"
                sub="sales received / plan (closed months)"
                value={secTotal?.ytdAchievement != null ? fmtPct(secTotal.ytdAchievement) : "—"}
                note={
                  secTotal
                    ? `${fmtNum(secTotal.totalDealers)} total dealers`
                    : undefined
                }
              />
            </div>
          </div>

          {/* Anomaly warnings */}
          {anomalies.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-500/5 p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                  Data anomalies detected ({anomalies.length}) — sales exceed orders by more than 1.5x (physically impossible). Values shown as-is; excluded from rankings.
                </p>
              </div>
              <div className="space-y-0.5">
                {anomalies.map((a, i) => (
                  <p key={i} className="text-[10px] text-amber-700 dark:text-amber-400 pl-5">
                    {a.name} ({a.stateHead}) — {a.monthLabel}: sales {fmtCr(a.salesAmount)} vs orders {fmtCr(a.orderedAmount)} ({a.ratio.toFixed(1)}x)
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* Per-rep table */}
          {headGroups.length > 0 && (
            <div className="rounded-lg border border-border overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">
                      State Head / Team Member
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Primary Sale
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Sec Plan
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Sec Sales
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Achievement
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Coverage
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {headGroups.map((group) => (
                    <Fragment key={group.head}>
                      <tr
                        className="cursor-pointer border-b border-border bg-muted/20 hover:bg-muted/40 transition-colors"
                        onClick={() => toggleHead(group.head)}
                      >
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            {expandedHeads.has(group.head) ? (
                              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span className="font-medium text-sm">{group.head}</span>
                          </div>
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-sm font-semibold">
                          {fmtCr(group.primarySale)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs text-muted-foreground">
                          {group.secPlan > 0 ? fmtCr(group.secPlan) : "—"}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs">
                          {group.secSales > 0 ? fmtCr(group.secSales) : "—"}
                        </td>
                        <td className={cn("py-2 px-3 text-right font-mono text-xs", achColor(group.secAchievement))}>
                          {fmtPct(group.secAchievement)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs text-muted-foreground">
                          {group.coveragePct != null
                            ? `${(group.coveragePct * 100).toFixed(1)}%`
                            : "—"}
                        </td>
                      </tr>
                      {expandedHeads.has(group.head) &&
                        group.members.map((m) => (
                          <tr
                            key={m.name}
                            className={cn(
                              "border-b border-border/50 hover:bg-muted/20 transition-colors",
                              m.isLeft && "opacity-70",
                            )}
                          >
                            <td className="py-1.5 px-3 pl-10 text-sm">
                              <span>{m.name}</span>
                              {m.isLeft && (
                                <span className="ml-1.5 text-[10px] text-muted-foreground">(left)</span>
                              )}
                              {m.hasAnomaly && (
                                <AlertTriangle className="inline ml-1.5 h-3 w-3 text-amber-500" aria-label="Data anomaly — sales exceed orders" />
                              )}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs text-muted-foreground">
                              {m.primarySale > 0 ? fmtCr(m.primarySale) : "—"}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs text-muted-foreground">
                              {m.secPlan != null ? fmtCr(m.secPlan) : "—"}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs">
                              {m.secSales != null ? fmtCr(m.secSales) : "—"}
                            </td>
                            <td className={cn("py-1.5 px-3 text-right font-mono text-xs", achColor(m.secAchievement))}>
                              {fmtPct(m.secAchievement)}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs text-muted-foreground">
                              {m.coveragePct != null
                                ? `${(m.coveragePct * 100).toFixed(1)}%`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Live company totals */}
          {fy === "2026-27" && secTotal != null && (
            <div className="rounded-md bg-muted/30 border border-border p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                Live totals — FY 2026-27
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-muted-foreground">
                <span>Secondary: {fmtCr(secTotal.salesReceived)}</span>
                <span>Secondary OB: {fmtCr(secTotal.orderBooked)}</span>
                <span>Primary (full year): {fmtCr(headSalesTotal || null)}</span>
                {likeMonthsPrimaryTotal != null && (
                  <span>Primary ({likeMonthsLabel}): {fmtCr(likeMonthsPrimaryTotal)}</span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
