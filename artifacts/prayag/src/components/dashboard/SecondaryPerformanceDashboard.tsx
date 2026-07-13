// Secondary Performance dashboard — Distributor to Retailer sell-out analytics.
//
// Source: Secondary Order Booking workbooks (per FY, Sub Total column).
// Team Member Name column is present in the file so no bridge is needed.
// FY2026-27 has no file yet — that case shows an "awaiting upload" banner.
// Default FY is 2025-26, which is complete.
//
// RULE: This page shows SECONDARY only. Never merge with primary totals.
// RULE: A missing file renders "unavailable" with a reason — never ₹0.00.
import { useState, useEffect, useMemo } from "react";
import {
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  Upload,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type MemberRow = {
  name: string;
  stateHead: string;
  orderBooking: number | null;
  priorOrderBooking: number | null;
  totalRetailers: number | null;
  newRetailers: number | null;
  oldRetailers: number | null;
  orderCount: number | null;
  achievementPct: number | null;
  targetSecondary: number | null;
  band: string;
};

type ApiData = {
  rows: MemberRow[];
  meta: {
    fy: string;
    monthFrom: number;
    monthTo: number;
    ordersAvailable: boolean;
    orderBookingNote?: string | null;
    rosterSource?: string;
  };
};

type HeadGroup = {
  head: string;
  booking: number;
  prior: number;
  retailers: number;
  newRetailers: number;
  orders: number;
  members: MemberRow[];
};

// ── Constants ─────────────────────────────────────────────────────────────────

const FYS = ["2026-27", "2025-26", "2024-25", "2023-24"] as const;

const PERIODS = [
  { label: "Full year", from: 1, to: 12 },
  { label: "Q1 (Apr-Jun)", from: 1, to: 3 },
  { label: "Q2 (Jul-Sep)", from: 4, to: 6 },
  { label: "Q3 (Oct-Dec)", from: 7, to: 9 },
  { label: "Q4 (Jan-Mar)", from: 10, to: 12 },
] as const;

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number | null): string {
  if (n == null || n === 0) return "—";
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function fmtNum(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function yoyPct(cy: number, ly: number): number | null {
  if (!ly || !cy) return null;
  return ((cy - ly) / ly) * 100;
}

function yoyColor(pct: number | null): string {
  if (pct == null) return "text-muted-foreground";
  if (pct >= 10) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= 0) return "text-emerald-700 dark:text-emerald-500";
  if (pct >= -10) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AchBadge({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const p = pct * 100;
  const cls =
    p >= 100
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : p >= 70
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : "bg-red-500/15 text-red-700 dark:text-red-400";
  return (
    <span className={cn("ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium", cls)}>
      {p.toFixed(0)}%
    </span>
  );
}

function HeadRow({
  group,
  expanded,
  onToggle,
}: {
  group: HeadGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const yoy = yoyPct(group.booking, group.prior);
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
          <span className="text-xs text-muted-foreground">
            ({group.members.length})
          </span>
        </div>
      </td>
      <td className="py-2 px-3 text-right font-mono text-sm font-semibold">
        {fmtCr(group.booking)}
      </td>
      <td className={cn("py-2 px-3 text-right text-xs font-mono font-medium", yoyColor(yoy))}>
        {fmtPct(yoy)}
      </td>
      <td className="py-2 px-3 text-right text-xs text-muted-foreground font-mono">
        {fmtNum(group.retailers)}
      </td>
      <td className="py-2 px-3 text-right text-xs text-muted-foreground font-mono">
        {fmtNum(group.orders)}
      </td>
    </tr>
  );
}

function MemberRow({ member }: { member: MemberRow }) {
  const booking = member.orderBooking ?? 0;
  if (booking === 0 && (member.totalRetailers ?? 0) === 0) return null;
  const yoy = yoyPct(booking, member.priorOrderBooking ?? 0);
  return (
    <tr className="border-b border-border/50 hover:bg-muted/20 transition-colors">
      <td className="py-1.5 px-3 pl-10">
        <span className="text-sm">{member.name}</span>
        <AchBadge pct={member.achievementPct} />
      </td>
      <td className="py-1.5 px-3 text-right font-mono text-xs">
        {booking > 0 ? fmtCr(booking) : "—"}
      </td>
      <td className={cn("py-1.5 px-3 text-right text-xs font-mono", yoyColor(yoy))}>
        {yoy != null ? fmtPct(yoy) : ""}
      </td>
      <td className="py-1.5 px-3 text-right text-xs text-muted-foreground font-mono">
        {fmtNum(member.totalRetailers)}
      </td>
      <td className="py-1.5 px-3 text-right text-xs text-muted-foreground font-mono">
        {fmtNum(member.orderCount)}
      </td>
    </tr>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SecondaryPerformanceDashboard() {
  const [fy, setFy] = useState<string>("2025-26");
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>(PERIODS[0]);
  const [data, setData] = useState<ApiData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedHeads, setExpandedHeads] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
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
        return r.json() as Promise<ApiData>;
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

  // Build state-head groups from rows
  const groups = useMemo((): HeadGroup[] => {
    if (!data) return [];
    const map = new Map<string, HeadGroup>();
    for (const m of data.rows) {
      const booking = m.orderBooking ?? 0;
      const prior = m.priorOrderBooking ?? 0;
      const retailers = m.totalRetailers ?? 0;
      const newR = m.newRetailers ?? 0;
      const orders = m.orderCount ?? 0;
      const head = m.stateHead || "Unassigned";
      const existing = map.get(head);
      if (existing) {
        existing.booking += booking;
        existing.prior += prior;
        existing.retailers += retailers;
        existing.newRetailers += newR;
        existing.orders += orders;
        existing.members.push(m);
      } else {
        map.set(head, {
          head,
          booking,
          prior,
          retailers,
          newRetailers: newR,
          orders,
          members: [m],
        });
      }
    }
    return Array.from(map.values())
      .filter((g) => g.booking > 0 || g.retailers > 0)
      .sort((a, b) => b.booking - a.booking);
  }, [data]);

  const totals = useMemo(() => {
    const booking = groups.reduce((s, g) => s + g.booking, 0);
    const prior = groups.reduce((s, g) => s + g.prior, 0);
    const retailers = groups.reduce((s, g) => s + g.retailers, 0);
    const orders = groups.reduce((s, g) => s + g.orders, 0);
    return { booking, prior, retailers, orders };
  }, [groups]);

  const toggleHead = (head: string) => {
    setExpandedHeads((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head);
      else next.add(head);
      return next;
    });
  };

  const yoy = yoyPct(totals.booking, totals.prior);

  const is2627 = fy === "2026-27";

  return (
    <div className="space-y-5 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Secondary Performance</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Distributor to Retailer — sell-out order booking by team member
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

      {/* FY2026-27 awaiting upload notice */}
      {is2627 && !loading && data && !data.meta.ordersAvailable && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <Upload className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              FY 2026-27 secondary order booking awaiting upload
            </p>
            <p className="text-xs text-muted-foreground">
              {data.meta.orderBookingNote ??
                "The FY2026-27 Secondary Order Booking file has not been uploaded yet. Use the Sales Import tab to upload it when available."}
            </p>
          </div>
        </div>
      )}

      {/* Load states */}
      {loading && (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading secondary performance data…
        </div>
      )}
      {error && (
        <div className="py-6 text-center text-sm text-destructive">{error}</div>
      )}

      {/* Company tiles */}
      {!loading && data && data.meta.ordersAvailable && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Order Booking (net)", value: fmtCr(totals.booking) },
            {
              label: "vs Prior Year",
              value: yoy != null ? fmtPct(yoy) : "—",
              valueClass: yoyColor(yoy),
            },
            { label: "Active Retailers", value: fmtNum(totals.retailers) },
            { label: "Orders", value: fmtNum(totals.orders) },
          ].map((tile) => (
            <div
              key={tile.label}
              className="rounded-lg border border-border bg-card p-3"
            >
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p
                className={cn(
                  "text-xl font-semibold font-mono mt-1",
                  tile.valueClass,
                )}
              >
                {tile.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Source note */}
      {!loading && data && data.meta.ordersAvailable && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md p-3">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Secondary order booking — Distributor sells to Retailer. Salesperson
            (Team Member Name) is in the file — no bridge required. Value column
            is Sub Total (net after discount).
            {totals.prior > 0 &&
              ` Prior year shown for same period (FY${
                String(Number(fy.slice(0, 4)) - 1) + "-" + fy.slice(2, 4)
              }).`}
          </span>
        </div>
      )}

      {/* Leading indicators row */}
      {!loading && data && data.meta.ordersAvailable && groups.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {(() => {
            const newR = groups.reduce((s, g) => s + g.newRetailers, 0);
            const retR = totals.retailers - newR;
            const memberCount = data.rows.filter(
              (r) => (r.orderBooking ?? 0) > 0,
            ).length;
            return [
              { label: "Active members", value: fmtNum(memberCount) },
              { label: "New retailers", value: fmtNum(newR > 0 ? newR : null) },
              {
                label: "Returning retailers",
                value: fmtNum(retR > 0 ? retR : null),
              },
            ];
          })().map((kpi) => (
            <div
              key={kpi.label}
              className="rounded-lg border border-border bg-card p-3"
            >
              <p className="text-xs text-muted-foreground">{kpi.label}</p>
              <p className="text-lg font-semibold font-mono mt-0.5">
                {kpi.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* State head breakdown table */}
      {!loading && data && data.meta.ordersAvailable && groups.length > 0 && (
        <div className="rounded-lg border border-border overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">
                  State Head / Team Member
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Order Booking
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  vs LY
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Retailers
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Orders
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
                  />
                  {expandedHeads.has(group.head) &&
                    group.members
                      .filter((m) => (m.orderBooking ?? 0) > 0)
                      .sort((a, b) => (b.orderBooking ?? 0) - (a.orderBooking ?? 0))
                      .map((m) => <MemberRow key={m.name} member={m} />)}
                </>
              ))}
              {/* Company total row */}
              <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                <td className="py-2 px-3 text-sm">Total</td>
                <td className="py-2 px-3 text-right font-mono text-sm">
                  {fmtCr(totals.booking)}
                </td>
                <td className={cn("py-2 px-3 text-right text-xs font-mono", yoyColor(yoy))}>
                  {fmtPct(yoy)}
                </td>
                <td className="py-2 px-3 text-right text-xs font-mono text-muted-foreground">
                  {fmtNum(totals.retailers)}
                </td>
                <td className="py-2 px-3 text-right text-xs font-mono text-muted-foreground">
                  {fmtNum(totals.orders)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Low-performer watchlist */}
      {!loading && data && data.meta.ordersAvailable && (() => {
        const watchlist = data.rows
          .filter(
            (m) =>
              (m.orderBooking ?? 0) > 0 &&
              m.achievementPct != null &&
              m.achievementPct < 0.5,
          )
          .sort((a, b) => (a.achievementPct ?? 1) - (b.achievementPct ?? 1))
          .slice(0, 10);
        if (watchlist.length === 0) return null;
        return (
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <span className="text-sm font-medium">
                Low achievement watchlist — below 50% of target
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {watchlist.map((m) => (
                <div
                  key={m.name}
                  className="flex items-center justify-between text-xs py-1 px-2 rounded bg-background border border-border/50"
                >
                  <span>
                    {m.name}
                    <span className="text-muted-foreground ml-1">
                      ({m.stateHead})
                    </span>
                  </span>
                  <span className="font-mono text-amber-700 dark:text-amber-400 ml-2">
                    {m.achievementPct != null
                      ? `${(m.achievementPct * 100).toFixed(0)}%`
                      : "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Empty state when data is available but no rows */}
      {!loading && data && data.meta.ordersAvailable && groups.length === 0 && (
        <div className="py-12 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            No secondary order booking data for the selected period.
          </p>
        </div>
      )}
    </div>
  );
}
