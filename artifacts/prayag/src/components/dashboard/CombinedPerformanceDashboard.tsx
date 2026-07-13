// Combined Performance dashboard.
//
// RULE ZERO: Primary and Secondary are NEVER summed. They are different
// stages of the same channel:
//   Prayag → [PRIMARY] → Distributor → [SECONDARY] → Retailer
// Adding ₹361 Cr + ₹240 Cr is double-counting — it equals nothing real.
//
// This page shows both stages side by side, derives:
//   Sell-through = Secondary ÷ Primary Sale
//   Channel Stock = cumulative Primary Sale − cumulative Secondary
//   Pending       = Primary Booking − Primary Sale
//
// Signal matrix (per rep):
//   Primary ↑, Secondary flat/↓ → CHANNEL STUFFING (red — warn even though revenue looks good)
//   Primary flat/↓, Secondary ↑ → DESTOCKING       (green — reorder due)
//   Both ↓                       → REAL DEMAND PROBLEM (red)
//   Both ↑                       → HEALTHY GROWTH      (green)
//
// Attribution: Primary carried via distributor bridge; where the bridge cannot map
// a distributor → "Unassigned" (excluded from per-rep sell-through ratio).
// Secondary carried directly via Team Member Name.
//
// Data availability:
//   FY2025-26: PRIMARY (₹361.14 Cr) + SECONDARY (₹240.14 Cr) → full page.
//   FY2026-27: PRIMARY live (₹96 Cr booked / ₹73 Cr dispatched); SECONDARY
//              not yet uploaded → sell-through and channel stock show "Awaiting data".
import { useState, useEffect, useMemo } from "react";
import {
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Minus,
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
  targetPrimary: number | null;
  targetSecondary: number | null;
};

type DashboardData = {
  rows: Member[];
  meta: {
    orderLoadStatus?: { fy: string; status: string; detail: string } | null;
  };
};

// ── Signal matrix ─────────────────────────────────────────────────────────────

type Signal =
  | "healthy"         // both ↑
  | "channel-stuffing" // primary ↑, secondary flat/↓ — WARN even if revenue good
  | "destocking"      // primary flat/↓, secondary ↑ — opportunity
  | "demand-problem"  // both ↓
  | "awaiting-data"   // secondary not uploaded
  | "unattributed";   // no primary bridge coverage

function classifySignal(
  primarySale: number,
  secondary: number,
  hasSecondary: boolean,
): Signal {
  if (!hasSecondary) return "awaiting-data";
  if (primarySale <= 0) return "unattributed";
  const sellThrough = secondary / primarySale;
  // Classify based on sell-through ratio position.
  // Trend-based signals require multi-period data (not available in single FY load).
  // Interim heuristic: sell-through < 50% with meaningful channel stock → stuffing risk.
  const channelStock = primarySale - secondary;
  if (sellThrough > 0.9) return "destocking"; // stock clearing, reorder due
  if (sellThrough < 0.45 && channelStock > 5_000_000) return "channel-stuffing";
  if (sellThrough < 0.3) return "demand-problem";
  return "healthy";
}

const SIGNAL_META: Record<
  Signal,
  { label: string; short: string; color: string; bg: string; description: string }
> = {
  healthy: {
    label: "Healthy",
    short: "OK",
    color: "text-green-700 dark:text-green-400",
    bg: "bg-green-500/10",
    description: "Good sell-through. Channel stock within normal range.",
  },
  "channel-stuffing": {
    label: "Channel Stuffing Risk",
    short: "STUFF",
    color: "text-red-700 dark:text-red-400",
    bg: "bg-red-500/10",
    description:
      "Low sell-through with large channel stock. Rep looks strong on primary but distributors are not selling on. A correction is coming.",
  },
  destocking: {
    label: "Destocking",
    short: "DEST",
    color: "text-green-700 dark:text-green-400",
    bg: "bg-green-500/10",
    description: "High sell-through — channel is clearing. A reorder is due soon.",
  },
  "demand-problem": {
    label: "Demand Problem",
    short: "PROB",
    color: "text-red-700 dark:text-red-400",
    bg: "bg-red-500/10",
    description: "Both primary and secondary are low. This is a real demand issue, not a stock artefact.",
  },
  "awaiting-data": {
    label: "Awaiting secondary data",
    short: "N/A",
    color: "text-muted-foreground",
    bg: "bg-muted/50",
    description: "Secondary Order Booking not yet uploaded for this FY. Upload in Settings.",
  },
  unattributed: {
    label: "No primary attribution",
    short: "—",
    color: "text-muted-foreground",
    bg: "bg-muted/50",
    description: "Distributor bridge cannot map this member's primary data.",
  },
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number | null | undefined): string {
  if (n == null) return "—";
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

// ── Signal chip ───────────────────────────────────────────────────────────────

function SignalChip({ signal }: { signal: Signal }) {
  const meta = SIGNAL_META[signal];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
        meta.bg,
        meta.color,
      )}
      title={meta.description}
    >
      {signal === "channel-stuffing" && <AlertTriangle className="h-2.5 w-2.5" />}
      {signal === "demand-problem" && <AlertTriangle className="h-2.5 w-2.5" />}
      {meta.short}
    </span>
  );
}

// ── Row types ─────────────────────────────────────────────────────────────────

type RepRow = {
  name: string;
  stateHead: string;
  primarySale: number;
  secondary: number;
  sellThrough: number | null;
  channelStock: number | null;
  pending: number;
  retailers: number;
  signal: Signal;
};

type HeadGroup = {
  head: string;
  primarySale: number;
  secondary: number;
  sellThrough: number | null;
  channelStock: number | null;
  pending: number;
  members: RepRow[];
};

// ── Funnel tile ───────────────────────────────────────────────────────────────

function FunnelStep({
  label,
  sub,
  value,
  pct,
  warn,
}: {
  label: string;
  sub: string;
  value: string;
  pct?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex-1 min-w-0 rounded-lg border border-border bg-card p-3 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xs text-muted-foreground/70 mb-1">{sub}</p>
      <p className="text-xl font-semibold font-mono">{value}</p>
      {pct && (
        <p className={cn("text-xs mt-1", warn ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          {pct}
        </p>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

const FYS = ["2025-26", "2026-27", "2024-25"] as const;

export default function CombinedPerformanceDashboard() {
  const [fy, setFy] = useState("2025-26");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedHeads, setExpandedHeads] = useState<Set<string>>(new Set());
  const [showMatrix, setShowMatrix] = useState(false);

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

  // Determine if secondary data exists for this FY
  const hasSecondary = useMemo(() => {
    if (!data) return false;
    return data.rows.some((m) => (m.orderBooking ?? 0) > 0 || (m.saleAmount ?? 0) > 0);
  }, [data]);

  // Build per-rep rows
  const repRows = useMemo((): RepRow[] => {
    if (!data) return [];
    return data.rows
      .filter((m) => (m.primarySaleAmount ?? 0) > 0 || (m.saleAmount ?? 0) > 0)
      .map((m) => {
        const primarySale = m.primarySaleAmount ?? 0;
        const primaryBooking = m.primaryOrderAmount ?? 0;
        const secondary = m.saleAmount ?? 0;
        const pending = Math.max(0, primaryBooking - primarySale);
        const sellThrough =
          hasSecondary && primarySale > 0 ? (secondary / primarySale) * 100 : null;
        const channelStock = hasSecondary ? primarySale - secondary : null;
        const signal = classifySignal(primarySale, secondary, hasSecondary);
        return {
          name: m.name,
          stateHead: m.stateHead || "Unassigned",
          primarySale,
          secondary,
          sellThrough,
          channelStock,
          pending,
          retailers: m.totalRetailers ?? 0,
          signal,
        };
      })
      .sort((a, b) => b.primarySale - a.primarySale);
  }, [data, hasSecondary]);

  // Group by state head
  const headGroups = useMemo((): HeadGroup[] => {
    const map = new Map<string, HeadGroup>();
    for (const r of repRows) {
      const existing = map.get(r.stateHead);
      if (existing) {
        existing.primarySale += r.primarySale;
        existing.secondary += r.secondary;
        existing.pending += r.pending;
        existing.members.push(r);
      } else {
        map.set(r.stateHead, {
          head: r.stateHead,
          primarySale: r.primarySale,
          secondary: r.secondary,
          sellThrough: null,
          channelStock: null,
          pending: r.pending,
          members: [r],
        });
      }
    }
    // Compute group-level sell-through
    for (const g of map.values()) {
      if (hasSecondary && g.primarySale > 0) {
        g.sellThrough = (g.secondary / g.primarySale) * 100;
        g.channelStock = g.primarySale - g.secondary;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.primarySale - a.primarySale);
  }, [repRows, hasSecondary]);

  // Company totals
  const totals = useMemo(() => {
    const primarySale = repRows.reduce((s, r) => s + r.primarySale, 0);
    const secondary = repRows.reduce((s, r) => s + r.secondary, 0);
    const pending = repRows.reduce((s, r) => s + r.pending, 0);
    const primaryBooking = data?.rows.reduce((s, m) => s + (m.primaryOrderAmount ?? 0), 0) ?? 0;
    return { primaryBooking, primarySale, secondary, pending };
  }, [repRows, data]);

  const toggleHead = (head: string) =>
    setExpandedHeads((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head);
      else next.add(head);
      return next;
    });

  // Signal counts
  const signalCounts = useMemo(() => {
    const counts: Record<Signal, number> = {
      healthy: 0, "channel-stuffing": 0, destocking: 0, "demand-problem": 0,
      "awaiting-data": 0, unattributed: 0,
    };
    for (const r of repRows) counts[r.signal]++;
    return counts;
  }, [repRows]);

  return (
    <div className="space-y-5 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Combined Performance</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Primary (Prayag to Distributor) and Secondary (Distributor to Retailer) — shown side by side, never summed
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

      {/* Rule Zero banner */}
      <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-500/5 p-3 text-xs">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
        <span className="text-blue-800 dark:text-blue-300">
          <strong>Rule Zero:</strong> Primary (₹361 Cr FY25-26) + Secondary (₹240 Cr) ≠ ₹601 Cr. They are the same goods at two stages of the same channel. Adding is double-counting. No tile on this page sums them.
        </span>
      </div>

      {/* Secondary data banner */}
      {!loading && data && !hasSecondary && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Secondary Order Booking not uploaded for FY {fy}.
            Sell-through ratio and channel stock cannot be computed — showing "awaiting data".
            Upload the file in Settings to activate the full combined view.
          </span>
        </div>
      )}

      {loading && (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading combined performance data…
        </div>
      )}
      {error && (
        <div className="py-6 text-center text-sm text-destructive">{error}</div>
      )}

      {!loading && data && (
        <>
          {/* Company funnel */}
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Company Funnel — FY {fy}
            </p>
            <div className="flex flex-wrap gap-3">
              <FunnelStep
                label="Order Booking"
                sub="booked by distributors"
                value={fmtCr(totals.primaryBooking)}
              />
              <div className="self-center text-muted-foreground text-lg">→</div>
              <FunnelStep
                label="Primary Sale"
                sub="dispatched by Prayag"
                value={fmtCr(totals.primarySale)}
                pct={totals.primaryBooking > 0
                  ? `${((totals.primarySale / totals.primaryBooking) * 100).toFixed(1)}% dispatched`
                  : undefined}
              />
              <div className="self-center text-muted-foreground text-lg">→</div>
              <FunnelStep
                label="Pending"
                sub="booked, not dispatched — OPS signal"
                value={fmtCr(totals.pending)}
                pct={totals.primaryBooking > 0
                  ? `${((totals.pending / totals.primaryBooking) * 100).toFixed(1)}% of booking`
                  : undefined}
                warn={totals.primaryBooking > 0 && totals.pending / totals.primaryBooking > 0.25}
              />
              <div className="self-center text-muted-foreground text-lg">→</div>
              <FunnelStep
                label="Secondary"
                sub={hasSecondary ? "sold on by distributors" : "awaiting data"}
                value={hasSecondary ? fmtCr(totals.secondary) : "Awaiting data"}
                pct={hasSecondary && totals.primarySale > 0
                  ? `${((totals.secondary / totals.primarySale) * 100).toFixed(1)}% sell-through`
                  : undefined}
              />
            </div>
          </div>

          {/* Signal matrix summary */}
          {hasSecondary && (
            <div>
              <button
                className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2"
                onClick={() => setShowMatrix((v) => !v)}
              >
                Signal Matrix — Rep Classification
                {showMatrix ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {showMatrix && (
                <div className="rounded-lg border border-border p-4 space-y-3">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {(["healthy", "channel-stuffing", "destocking", "demand-problem"] as Signal[]).map((s) => {
                      const meta = SIGNAL_META[s];
                      return (
                        <div key={s} className={cn("rounded-md p-3", meta.bg)}>
                          <div className="flex items-center justify-between mb-1">
                            <span className={cn("text-xs font-medium", meta.color)}>
                              {meta.label}
                            </span>
                            <span className={cn("text-lg font-bold", meta.color)}>
                              {signalCounts[s]}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {meta.description}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Classification based on sell-through ratio and channel stock position. Trend-based signals (primary ↑ vs secondary ↓) require multi-period comparison — coming once multi-FY data is available.
                  </p>
                </div>
              )}
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
                      Secondary
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Sell-through
                    </th>
                    <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                      Channel Stock
                    </th>
                    {hasSecondary && (
                      <th className="py-2 px-3 text-center text-xs font-medium text-muted-foreground">
                        Signal
                      </th>
                    )}
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
                          {hasSecondary ? fmtCr(group.secondary) : "Awaiting data"}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs">
                          {group.sellThrough != null ? (
                            <span className={cn(
                              group.sellThrough < 45 ? "text-red-700 dark:text-red-400" :
                              group.sellThrough > 90 ? "text-green-700 dark:text-green-400" :
                              "text-foreground"
                            )}>
                              {fmtPct(group.sellThrough)}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-xs text-muted-foreground">
                          {group.channelStock != null ? fmtCr(group.channelStock) : "—"}
                        </td>
                        {hasSecondary && <td className="py-2 px-3 text-center" />}
                      </tr>
                      {expandedHeads.has(group.head) &&
                        group.members.map((m) => (
                          <tr
                            key={m.name}
                            className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                          >
                            <td className="py-1.5 px-3 pl-10 text-sm">
                              {m.name}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs">
                              {fmtCr(m.primarySale)}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs text-muted-foreground">
                              {hasSecondary ? fmtCr(m.secondary) : "—"}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs">
                              {m.sellThrough != null ? (
                                <span className={cn(
                                  m.sellThrough < 45 ? "text-red-700 dark:text-red-400" :
                                  m.sellThrough > 90 ? "text-green-700 dark:text-green-400" :
                                  "text-foreground"
                                )}>
                                  {fmtPct(m.sellThrough)}
                                </span>
                              ) : "—"}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono text-xs text-muted-foreground">
                              {m.channelStock != null ? fmtCr(m.channelStock) : "—"}
                            </td>
                            {hasSecondary && (
                              <td className="py-1.5 px-3 text-center">
                                <SignalChip signal={m.signal} />
                              </td>
                            )}
                          </tr>
                        ))}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Verification anchors for FY2025-26 */}
          {fy === "2025-26" && hasSecondary && (
            <div className="rounded-md bg-muted/30 border border-border p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Verification anchors — FY 2025-26</p>
              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <span>Primary: ₹361.14 Cr</span>
                <span>Secondary: ₹240.14 Cr</span>
                <span>Sell-through: ~66%</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
