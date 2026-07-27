// Secondary Performance dashboard — authoritative data from STATE HEAD DASHBOARD.
//
// SOURCE (read-only):
//   FY2026-27: spreadsheet 1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM
//   FY2025-26: spreadsheet 1PTkkEa_ENkSqsGnpqoXy9kt0Fe1hCtlmU6kVFBNaonY
//
// Every secondary-facing number on this page comes from /api/mgmt/data, which
// populates secondaryPlan, secondaryOrderBooked, secondarySalesReceived, and
// secondaryAchievement per member from the live sheet.
//
// RULES:
//   - Achievement = Sales Received / Plan (recomputed; never Order Booked / Plan).
//   - Open months (not yet ended) → "not yet recorded", never 0%.
//   - Primary-role members have no secondary target — exclude from achievement.
//   - Left members count in totals but never appear in the low-performer list.
//   - Never add secondary and primary together.
import { useState, useEffect, useMemo, Fragment } from "react";
import { AlertTriangle, ChevronUp, ChevronDown, Info } from "lucide-react";
import { useGlobalFilter } from "@/data/global-filter-context";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type MemberRow = {
  name: string;
  stateHead: string;
  secondaryPlan: number | null;
  secondaryOrderBooked: number | null;
  secondarySalesReceived: number | null;
  secondaryAchievement: number | null;
  secondaryBusinessPlan: number | null;
  isPrimaryRole: boolean;
  isLeft: boolean;
  // Legacy fields (populated for FY2025-26 and earlier from uploaded files)
  orderBooking: number | null;
  priorOrderBooking: number | null;
  totalRetailers: number | null;
  orderCount: number | null;
  achievementPct: number | null;
  band: string;
};

type SecondaryTotal = {
  plan: number;
  orderBooked: number;
  salesReceived: number;
  ytdAchievement: number | null;
  totalDealers: number;
};

type ApiData = {
  rows: MemberRow[];
  meta: {
    fy: string;
    monthFrom: number;
    monthTo: number;
    ordersAvailable: boolean;
    secondarySource?: string | null;
    secondaryTotal?: SecondaryTotal | null;
    orderBookingSource?: string | null;
  };
};

type HeadGroup = {
  head: string;
  plan: number;
  orderBooked: number;
  sales: number;
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
  { label: "Apr", from: 1, to: 1 },
  { label: "May", from: 2, to: 2 },
  { label: "Jun", from: 3, to: 3 },
  { label: "Jul", from: 4, to: 4 },
  { label: "Aug", from: 5, to: 5 },
  { label: "Sep", from: 6, to: 6 },
  { label: "Oct", from: 7, to: 7 },
  { label: "Nov", from: 8, to: 8 },
  { label: "Dec", from: 9, to: 9 },
  { label: "Jan", from: 10, to: 10 },
  { label: "Feb", from: 11, to: 11 },
  { label: "Mar", from: 12, to: 12 },
] as const;

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number | null | undefined): string {
  if (n == null || n === 0) return "—";
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-IN");
}

function achColor(pct: number | null): string {
  if (pct == null) return "text-muted-foreground";
  const p = pct * 100;
  if (p >= 100) return "text-emerald-600 dark:text-emerald-400";
  if (p >= 70) return "text-amber-600 dark:text-amber-400";
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
  const ach = group.plan > 0 ? group.sales / group.plan : null;
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
      <td className="py-2 px-3 text-right font-mono text-sm">{fmtCr(group.plan)}</td>
      <td className="py-2 px-3 text-right font-mono text-sm">{fmtCr(group.orderBooked)}</td>
      <td className="py-2 px-3 text-right font-mono text-sm font-semibold">{fmtCr(group.sales)}</td>
      <td className={cn("py-2 px-3 text-right text-sm font-mono font-semibold", achColor(ach))}>
        {fmtPct(ach)}
      </td>
    </tr>
  );
}

function MemberRowEl({ member }: { member: MemberRow }) {
  const plan = member.secondaryPlan;
  const ob = member.secondaryOrderBooked;
  const sales = member.secondarySalesReceived;
  const ach = member.secondaryAchievement;
  if ((plan == null || plan === 0) && (ob == null || ob === 0) && (sales == null || sales === 0)) return null;
  return (
    <tr className="border-b border-border/50 hover:bg-muted/20 transition-colors">
      <td className="py-1.5 px-3 pl-10">
        <span className="text-sm">{member.name}</span>
        {member.isLeft && <span className="ml-1 text-[10px] text-muted-foreground">(left)</span>}
        <AchBadge pct={ach} />
      </td>
      <td className="py-1.5 px-3 text-right font-mono text-xs">{fmtCr(plan)}</td>
      <td className="py-1.5 px-3 text-right font-mono text-xs">{fmtCr(ob)}</td>
      <td className="py-1.5 px-3 text-right font-mono text-xs font-medium">{fmtCr(sales)}</td>
      <td className={cn("py-1.5 px-3 text-right text-xs font-mono", achColor(ach))}>
        {fmtPct(ach)}
      </td>
    </tr>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SecondaryPerformanceDashboard() {
  const { fy, effectivePeriodFrom, effectivePeriodTo } = useGlobalFilter();
  const [data, setData] = useState<ApiData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedHeads, setExpandedHeads] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    const params = new URLSearchParams({
      fy,
      monthFrom: String(effectivePeriodFrom),
      monthTo: String(effectivePeriodTo),
    });
    fetch(`/api/mgmt/data?${params}`, { signal: controller.signal })
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
        if (err.name === "AbortError") return;
        setError(err.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [fy, effectivePeriodFrom, effectivePeriodTo]);

  // Whether secondary data comes from the authoritative STATE HEAD DASHBOARD.
  const isStateDash = data?.meta.secondarySource === "state_head_dashboard";
  // Fall back to legacy order-booking fields when state dashboard is unavailable.
  const hasData = isStateDash || (data?.meta.ordersAvailable ?? false);

  // Secondary-only rows (exclude primary-role members who have no secondary target).
  const secondaryRows = useMemo((): MemberRow[] => {
    if (!data) return [];
    return data.rows.filter((r) => !r.isPrimaryRole);
  }, [data]);

  // Build state-head groups from secondary rows.
  const groups = useMemo((): HeadGroup[] => {
    const map = new Map<string, HeadGroup>();
    for (const m of secondaryRows) {
      const plan = isStateDash ? (m.secondaryPlan ?? 0) : (m.orderBooking ?? 0);
      const ob = isStateDash ? (m.secondaryOrderBooked ?? 0) : (m.orderBooking ?? 0);
      const sales = isStateDash ? (m.secondarySalesReceived ?? 0) : (m.orderBooking ?? 0);
      const head = m.stateHead || "Unassigned";
      const existing = map.get(head);
      if (existing) {
        existing.plan += plan;
        existing.orderBooked += ob;
        existing.sales += sales;
        existing.members.push(m);
      } else {
        map.set(head, { head, plan, orderBooked: ob, sales, members: [m] });
      }
    }
    return Array.from(map.values())
      .filter((g) => g.plan > 0 || g.orderBooked > 0 || g.sales > 0)
      .sort((a, b) => b.sales - a.sales);
  }, [secondaryRows, isStateDash]);

  // Company-level totals.
  //
  // PLAN: always sum from groups (period-filtered via secondaryPlan / targetSecondary per member).
  //   DO NOT use meta.secondaryTotal.plan — it is the ANNUAL business plan, not the period plan.
  //
  // OB / SALES: prefer meta.secondaryTotal (sheet-level, all months, anomaly months included)
  //   over group sums (closed months only, anomaly months excluded from ytdSalesReceived).
  //   Using the sheet totals matches what managers see in the source sheet directly.
  const totals = useMemo(() => {
    const plan = groups.reduce((s, g) => s + g.plan, 0);
    const st = data?.meta.secondaryTotal;
    const ob = st && st.orderBooked > 0 ? st.orderBooked : groups.reduce((s, g) => s + g.orderBooked, 0);
    const sales = st && st.salesReceived > 0 ? st.salesReceived : groups.reduce((s, g) => s + g.sales, 0);
    return {
      plan,
      orderBooked: ob,
      sales,
      ach: plan > 0 && sales > 0 ? sales / plan : null,
    };
  }, [data?.meta.secondaryTotal, groups]);

  const toggleHead = (head: string) => {
    setExpandedHeads((prev) => {
      const next = new Set(prev);
      if (next.has(head)) next.delete(head);
      else next.add(head);
      return next;
    });
  };

  return (
    <div className="space-y-5 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Secondary Performance</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {data?.meta.orderBookingSource ?? "STATE HEAD DASHBOARD — Secondary Order Booking"}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">FY {fy}</span>
      </div>

      {/* Load states */}
      {loading && (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading secondary performance data...
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* KPI tiles */}
      {!loading && data && hasData && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Plan (Target)", value: fmtCr(totals.plan) },
            { label: "Order Booked", value: fmtCr(totals.orderBooked) },
            { label: "Sales Received", value: fmtCr(totals.sales) },
            {
              label: "Achievement",
              value: totals.ach != null ? fmtPct(totals.ach) : "—",
              valueClass: achColor(totals.ach),
            },
          ].map((tile) => (
            <div key={tile.label} className="rounded-lg border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">{tile.label}</p>
              <p className={cn("text-xl font-semibold font-mono mt-1", tile.valueClass)}>
                {tile.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* No secondary data available */}
      {!loading && data && !hasData && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Secondary data not yet available for FY {fy}</p>
            <p className="text-xs text-muted-foreground">
              The STATE HEAD DASHBOARD sheet for this fiscal year has not been configured.
            </p>
          </div>
        </div>
      )}

      {/* State head breakdown table */}
      {!loading && data && hasData && groups.length > 0 && (
        <div className="rounded-lg border border-border overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="py-2 px-3 text-left text-xs font-medium text-muted-foreground">
                  State Head / Team Member
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Plan
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Order Booked
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Sales Received
                </th>
                <th className="py-2 px-3 text-right text-xs font-medium text-muted-foreground">
                  Achievement
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Fragment key={group.head}>
                  <HeadRow
                    group={group}
                    expanded={expandedHeads.has(group.head)}
                    onToggle={() => toggleHead(group.head)}
                  />
                  {expandedHeads.has(group.head) &&
                    group.members
                      .filter((m) => !m.isPrimaryRole)
                      .sort((a, b) => (b.secondarySalesReceived ?? 0) - (a.secondarySalesReceived ?? 0))
                      .map((m) => <MemberRowEl key={m.name} member={m} />)}
                </Fragment>
              ))}
              {/* Company total row */}
              <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                <td className="py-2 px-3 text-sm">Total</td>
                <td className="py-2 px-3 text-right font-mono text-sm">{fmtCr(totals.plan)}</td>
                <td className="py-2 px-3 text-right font-mono text-sm">{fmtCr(totals.orderBooked)}</td>
                <td className="py-2 px-3 text-right font-mono text-sm">{fmtCr(totals.sales)}</td>
                <td className={cn("py-2 px-3 text-right text-sm font-mono", achColor(totals.ach))}>
                  {fmtPct(totals.ach)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Low-performer watchlist — Sales / Plan < 50%, exclude primary-role and left */}
      {!loading && data && hasData && (() => {
        const watchlist = secondaryRows
          .filter(
            (m) =>
              !m.isLeft &&
              (m.secondaryAchievement ?? m.achievementPct ?? 1) < 0.5 &&
              (m.secondarySalesReceived ?? m.orderBooking ?? 0) > 0,
          )
          .sort(
            (a, b) =>
              (a.secondaryAchievement ?? a.achievementPct ?? 1) -
              (b.secondaryAchievement ?? b.achievementPct ?? 1),
          )
          .slice(0, 10);
        if (watchlist.length === 0) return null;
        return (
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-500/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <span className="text-sm font-medium">
                Low achievement — below 50% of plan
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {watchlist.map((m) => {
                const ach = m.secondaryAchievement ?? m.achievementPct;
                return (
                  <div
                    key={m.name}
                    className="flex items-center justify-between text-xs py-1 px-2 rounded bg-background border border-border/50"
                  >
                    <span>
                      {m.name}
                      <span className="text-muted-foreground ml-1">({m.stateHead})</span>
                    </span>
                    <span className="font-mono text-amber-700 dark:text-amber-400 ml-2">
                      {ach != null ? `${(ach * 100).toFixed(0)}%` : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Empty state when data is loaded but no rows */}
      {!loading && data && hasData && groups.length === 0 && (
        <div className="py-12 text-center space-y-2">
          <p className="text-sm text-muted-foreground">
            No secondary order booking data for the selected period.
          </p>
        </div>
      )}

      {/* Source note */}
      {!loading && data && hasData && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/30 rounded-md p-3">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Achievement = Sales Received / Plan (recomputed; the sheet&apos;s own Achievement
            column uses Order Booked / Plan and is not used).
            Open months are not yet recorded — secondary data is entered at month-end.
            Primary-role team members are excluded from this view.
          </span>
        </div>
      )}
    </div>
  );
}
