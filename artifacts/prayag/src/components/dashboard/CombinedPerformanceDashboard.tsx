// Combined Performance — Primary vs Secondary.
//
// CORRECT business model:
//   Prayag sells ONCE to Distributors (PRIMARY = ₹361 Cr FY25-26).
//   Salesperson takes orders from retailers/dealers (SECONDARY), which feeds
//   distributor reorders — secondary ⊂ primary, never additive.
//   Adding ₹361 Cr + ₹240 Cr is double-counting — the same goods, two ledgers.
//
// What this page shows:
//   1. PRIMARY STAGE — Order Booking (committed), Sale (dispatched), Pending.
//   2. SECONDARY STAGE — Plan (target), Order Booked, Sales Received.
//   3. COVERAGE — secondary sales / primary sale.
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
import { useState, useEffect, useMemo } from "react";
import {
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  const coveragePct = data?.meta.secondaryCoveragePct ?? null;
  const coverageGap =
    headSalesTotal > 0 && secTotal
      ? headSalesTotal - secTotal.salesReceived
      : null;

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
          <strong>Why these are never added:</strong> Salesperson takes an order from a retailer (secondary), which feeds the distributor's reorder from Prayag (primary). The same goods appear in both ledgers. Secondary ⊂ Primary — coverage shows how much primary was salesperson-supported.
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
                sub="invoiced by Prayag"
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
                label="Salesperson Coverage"
                sub="secondary / primary sale"
                value={fmtPct(coveragePct)}
                note={
                  coverageGap != null
                    ? `Gap: ${fmtCr(coverageGap)} without TM touch`
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
                    <>
                      <tr
                        key={group.head}
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
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* FY2026-27 verification anchors */}
          {fy === "2026-27" && secTotal != null && (
            <div className="rounded-md bg-muted/30 border border-border p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Verification anchors — FY 2026-27 (closed months only)</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-muted-foreground">
                <span>Q1 Achievement: ~69.4%</span>
                <span>Apr: ~55.5%</span>
                <span>May: ~71.4%</span>
                <span>Jun: ~79.6%</span>
              </div>
            </div>
          )}
          {fy === "2025-26" && (
            <div className="rounded-md bg-muted/30 border border-border p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Verification anchors — FY 2025-26</p>
              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <span>Primary Sale: ~₹361.14 Cr</span>
                <span>Secondary Plan: ~₹364.98 Cr</span>
                <span>Secondary Sales: ~₹240.14 Cr</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
