// Primary Performance vs History dashboard.
//
// Shows primary sales (Prayag → Distributor) with:
//   - Company totals: Order Booking | Sale/Dispatch | Pending
//   - Per state head breakdown
//   - Per team member via distributor bridge
//   - Pending orders panel (OPS signal, not a rep-performance signal)
//
// RULE: This dashboard shows PRIMARY only. Never merge with secondary data.
// Attribution: order sheet carries Distributor + STATE HEAD → bridge maps to TM.
// Where the bridge cannot map a distributor → "Unassigned" under the State Head.
import { useState, useEffect, useMemo } from "react";
import {
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  Info,
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
  achievementPct: number | null;
  targetPrimary: number | null;
  band: string;
};

type DashboardData = {
  rows: Member[];
  meta: {
    orderLoadStatus?: { fy: string; status: string; detail: string } | null;
    primaryAttribution?: {
      totalBookingCr: number;
      totalSaleCr: number;
      attributedBookingCr: number;
      attributedSaleCr: number;
      attributionPct: number;
    } | null;
  };
};

type SortKey = "name" | "booking" | "sale" | "pending" | "distributors";
type SortDir = "asc" | "desc";
type View = "booking" | "sale" | "pending";

const PERIODS = [
  { label: "Full year", from: 1, to: 12 },
  { label: "Q1 (Apr-Jun)", from: 1, to: 3 },
  { label: "Q2 (Jul-Sep)", from: 4, to: 6 },
  { label: "Q3 (Oct-Dec)", from: 7, to: 9 },
  { label: "Q4 (Jan-Mar)", from: 10, to: 12 },
] as const;

const FYS = ["2026-27", "2025-26", "2024-25"] as const;

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number | null): string {
  if (n == null) return "—";
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

// ── Signal chip ───────────────────────────────────────────────────────────────

function PendingChip({ pending, booking }: { pending: number; booking: number }) {
  if (booking <= 0) return null;
  const pct = (pending / booking) * 100;
  if (pct < 15) return null;
  return (
    <span
      className={cn(
        "ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        pct >= 40
          ? "bg-red-500/10 text-red-700 dark:text-red-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      <AlertTriangle className="h-2.5 w-2.5" />
      {pct.toFixed(0)}% pending
    </span>
  );
}

// ── State head group row ───────────────────────────────────────────────────────

type HeadGroup = {
  head: string;
  booking: number;
  sale: number;
  pending: number;
  distributors: number;
  members: Member[];
};

function HeadRow({
  group,
  expanded,
  onToggle,
  view,
}: {
  group: HeadGroup;
  expanded: boolean;
  onToggle: () => void;
  view: View;
}) {
  const primaryVal =
    view === "booking" ? group.booking : view === "sale" ? group.sale : group.pending;

  return (
    <tr
      className="cursor-pointer hover:bg-muted/40 transition-colors border-b border-border bg-muted/20"
      onClick={onToggle}
    >
      <td className="py-2 px-3">
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="font-medium text-sm">{group.head}</span>
        </div>
      </td>
      <td className="py-2 px-3 text-right font-mono text-sm font-semibold">
        {fmtCr(primaryVal)}
        {view === "booking" && (
          <PendingChip pending={group.pending} booking={group.booking} />
        )}
      </td>
      <td className="py-2 px-3 text-right text-xs text-muted-foreground font-mono">
        {view !== "sale" && fmtCr(group.sale)}
      </td>
      <td className="py-2 px-3 text-right text-xs text-muted-foreground font-mono">
        {group.distributors > 0 ? fmtNum(group.distributors) : "—"}
      </td>
    </tr>
  );
}

function MemberRow({ member, view }: { member: Member; view: View }) {
  const booking = member.primaryOrderAmount ?? 0;
  const sale = member.primarySaleAmount ?? 0;
  const pending = Math.max(0, booking - sale);
  const primaryVal = view === "booking" ? booking : view === "sale" ? sale : pending;

  if (booking === 0 && sale === 0) return null;

  return (
    <tr className="border-b border-border/50 hover:bg-muted/20 transition-colors">
      <td className="py-1.5 px-3 pl-10">
        <span className="text-sm">{member.name}</span>
      </td>
      <td className="py-1.5 px-3 text-right font-mono text-xs">
        {fmtCr(primaryVal || null)}
      </td>
      <td className="py-1.5 px-3 text-right text-xs text-muted-foreground font-mono">
        {view !== "sale" && sale > 0 ? fmtCr(sale) : ""}
      </td>
      <td className="py-1.5 px-3 text-right text-xs text-muted-foreground font-mono">
        {member.primaryDistributors != null && member.primaryDistributors > 0
          ? fmtNum(member.primaryDistributors)
          : "—"}
      </td>
    </tr>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PrimaryPerformanceDashboard() {
  const [fy, setFy] = useState("2026-27");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(PERIODS[0]);
  const [view, setView] = useState<View>("booking");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedHeads, setExpandedHeads] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "booking",
    dir: "desc",
  });

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      fy,
      monthFrom: String(period.from),
      monthTo: String(period.to),
    });
    fetch(`/api/mgmt/data?${params}`)
      .then((r) => {
        if (!r.ok)
          return r.json().then((e: { error?: string }) => {
            throw new Error(e.error ?? r.statusText);
          });
        return r.json() as Promise<DashboardData>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [fy, period]);

  // Aggregate into state head groups
  const groups = useMemo((): HeadGroup[] => {
    if (!data) return [];
    const map = new Map<string, HeadGroup>();
    for (const m of data.rows) {
      const booking = m.primaryOrderAmount ?? 0;
      const sale = m.primarySaleAmount ?? 0;
      if (booking === 0 && sale === 0) continue;
      const head = m.stateHead || "Unassigned";
      const existing = map.get(head);
      if (existing) {
        existing.booking += booking;
        existing.sale += sale;
        existing.pending = Math.max(0, existing.booking - existing.sale);
        existing.distributors += m.primaryDistributors ?? 0;
        existing.members.push(m);
      } else {
        map.set(head, {
          head,
          booking,
          sale,
          pending: Math.max(0, booking - sale),
          distributors: m.primaryDistributors ?? 0,
          members: [m],
        });
      }
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => b.booking - a.booking);
    return arr;
  }, [data]);

  // Company totals
  const totals = useMemo(() => {
    const booking = groups.reduce((s, g) => s + g.booking, 0);
    const sale = groups.reduce((s, g) => s + g.sale, 0);
    return { booking, sale, pending: Math.max(0, booking - sale) };
  }, [groups]);

  const toggleHead = (head: string) => {
    setExpandedHeads((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head);
      else next.add(head);
      return next;
    });
  };

  const cycleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  };

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sort.key !== k) return <ChevronsUpDown className="h-3 w-3 opacity-30" />;
    return sort.dir === "asc" ? (
      <ChevronUp className="h-3 w-3" />
    ) : (
      <ChevronDown className="h-3 w-3" />
    );
  };

  return (
    <div className="space-y-5 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Primary Performance</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Prayag to Distributor / Direct Dealer — order booking, dispatch, and pending
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={fy}
            onChange={(e) => setFy(e.target.value)}
            className="text-xs border border-border rounded-md px-2 py-1.5 bg-background"
          >
            {FYS.map((f) => (
              <option key={f} value={f}>
                FY {f}
              </option>
            ))}
          </select>
          <select
            value={`${period.from}-${period.to}`}
            onChange={(e) => {
              const p = PERIODS.find(
                (p) => `${p.from}-${p.to}` === e.target.value,
              );
              if (p) setPeriod(p);
            }}
            className="text-xs border border-border rounded-md px-2 py-1.5 bg-background"
          >
            {PERIODS.map((p) => (
              <option key={`${p.from}-${p.to}`} value={`${p.from}-${p.to}`}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-1 rounded-lg border border-border p-0.5 w-fit">
        {(["booking", "sale", "pending"] as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn(
              "px-3 py-1 text-xs rounded-md font-medium transition-colors",
              view === v
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v === "booking"
              ? "Order Booking"
              : v === "sale"
              ? "Sale / Dispatch"
              : "Pending Orders"}
          </button>
        ))}
      </div>

      {/* Company totals */}
      {!loading && data && (
        <div className="grid grid-cols-3 gap-3">
          {[
            {
              label: "Order Booking (booked)",
              value: totals.booking,
              active: view === "booking",
            },
            {
              label: "Sale / Dispatch",
              value: totals.sale,
              active: view === "sale",
            },
            {
              label: "Pending (booked − dispatched)",
              value: totals.pending,
              active: view === "pending",
              warn: totals.booking > 0 && totals.pending / totals.booking > 0.25,
            },
          ].map((tile) => (
            <div
              key={tile.label}
              className={cn(
                "rounded-lg border p-3 cursor-pointer transition-colors",
                tile.active
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card",
              )}
              onClick={() =>
                setView(
                  tile.label.includes("Booking")
                    ? "booking"
                    : tile.label.includes("Sale")
                    ? "sale"
                    : "pending",
                )
              }
            >
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className="text-xl font-semibold font-mono mt-1">
                {fmtCr(tile.value)}
              </p>
              {tile.warn && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Ops / fulfilment signal — not a rep issue
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Attribution note */}
      {!loading && data?.meta?.primaryAttribution && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md p-3">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Primary attribution via distributor bridge:{" "}
            {data.meta.primaryAttribution.attributionPct.toFixed(1)}% of booking attributed to a
            team member. Distributors the bridge cannot map appear under "Unassigned" and are
            excluded from per-rep ratios.
          </span>
        </div>
      )}

      {/* Load states */}
      {loading && (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading primary performance data…
        </div>
      )}
      {error && (
        <div className="py-6 text-center text-sm text-destructive">{error}</div>
      )}

      {/* Table */}
      {!loading && data && groups.length > 0 && (
        <div className="rounded-lg border border-border overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">
                  State Head / Team Member
                </th>
                <th
                  className="py-2 px-3 text-right text-xs font-medium text-muted-foreground cursor-pointer select-none"
                  onClick={() => cycleSort("booking")}
                >
                  <span className="inline-flex items-center gap-1">
                    {view === "booking"
                      ? "Order Booking"
                      : view === "sale"
                      ? "Sale"
                      : "Pending"}
                    <SortIcon k="booking" />
                  </span>
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  {view === "booking" ? "Dispatched" : ""}
                </th>
                <th
                  className="py-2 px-3 text-right text-xs font-medium text-muted-foreground cursor-pointer select-none"
                  onClick={() => cycleSort("distributors")}
                >
                  <span className="inline-flex items-center gap-1">
                    Distributors
                    <SortIcon k="distributors" />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <>
                  <HeadRow
                    key={group.head}
                    group={group}
                    expanded={expandedHeads.has(group.head)}
                    onToggle={() => toggleHead(group.head)}
                    view={view}
                  />
                  {expandedHeads.has(group.head) &&
                    group.members
                      .sort((a, b) =>
                        (b.primaryOrderAmount ?? 0) - (a.primaryOrderAmount ?? 0),
                      )
                      .map((m) => (
                        <MemberRow key={m.name} member={m} view={view} />
                      ))}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pending orders alert */}
      {!loading && data && totals.pending > 0 && view === "pending" && (
        <div className="rounded-lg border border-amber-200 bg-amber-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <span className="text-sm font-medium">
              Pending Orders — Fulfilment Alert, Not a Sales Signal
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {fmtCr(totals.pending)} of booked orders have not been dispatched. This is a
            stock / credit-hold / logistics issue. Do not penalise the salesperson for this — it
            is routed here as a separate fulfilment signal.
          </p>
          <p className="text-xs text-muted-foreground">
            Reconciliation: Booking {fmtCr(totals.booking)} − Dispatched {fmtCr(totals.sale)} ={" "}
            Pending {fmtCr(totals.pending)}
          </p>
        </div>
      )}

      {/* Empty state */}
      {!loading && data && groups.length === 0 && (
        <div className="py-12 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            No primary attribution data available for FY {fy}.
          </p>
          <p className="text-xs text-muted-foreground">
            Primary attribution requires the distributor bridge to be built.
            Check the bridge status in the State Head dashboard.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Missing import ─────────────────────────────────────────────────────────────
// ChevronsUpDown is not in the main lucide import above — add it.
function ChevronsUpDown({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </svg>
  );
}
