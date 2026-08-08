import { trunc2 } from "@/lib/trunc";
// SKU Deep Dive — Trends section (K4).
//
// Three views driven by GET /api/sku/trend:
//   1. Line chart  — breadth % per segment per FY-month
//   2. Bar chart   — codesBought per segment per FY (breadth %)
//   3. Net share   — compact table: which segments are growing / shrinking
//
// Segment selector defaults to top-6 by cumulative net.

import { useState, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import { useTheme } from "next-themes";

// ── Types (mirror API response) ───────────────────────────────────────────────

export type TrendMonthRow = {
  fy: string;
  fyMonth: string;
  monthIdx: number;
  segment: string;
  codesBought: number;
  net: number;
};

export type TrendFyRow = {
  fy: string;
  segment: string;
  codesBought: number;
  net: number;
};

export type TrendData = {
  level: string;
  fys: string[];
  fyMonths: string[];
  everSold: Record<string, number>;
  monthly: TrendMonthRow[];
  fyTotals: TrendFyRow[];
  fyNetTotals: Record<string, number>;
};

interface Props {
  data: TrendData;
}

// ── Colour palette ────────────────────────────────────────────────────────────

const PALETTE = [
  "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed",
  "#db2777", "#0891b2", "#84cc16", "#ea580c", "#9333ea",
];

function segColor(idx: number): string {
  return PALETTE[idx % PALETTE.length];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function breadthPct(codesBought: number, everSold: number): number {
  return everSold > 0 ? +trunc2(((codesBought / everSold) * 100)) : 0;
}

function fmtCr(n: number): string {
  return `₹${trunc2((n / 1e7))} Cr`;
}

function abbr(seg: string, max = 14): string {
  return seg.length > max ? seg.slice(0, max) + "…" : seg;
}

// Returns the best tick interval for the line chart x-axis.
function xTickInterval(count: number): number {
  if (count <= 12) return 0;
  if (count <= 24) return 2;
  if (count <= 48) return 5;
  return 11;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SkuTrends({ data }: Props) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const gridColor = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "#98999C" : "#71717a";

  const { fys, fyMonths, everSold, monthly, fyTotals, fyNetTotals } = data;

  // Rank segments by cumulative net (descending)
  const segmentsByNet = useMemo(() => {
    const netMap = new Map<string, number>();
    for (const r of fyTotals) {
      netMap.set(r.segment, (netMap.get(r.segment) ?? 0) + r.net);
    }
    return [...netMap.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([seg]) => seg);
  }, [fyTotals]);

  // Default: top 6
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(segmentsByNet.slice(0, 6)),
  );

  function toggleSeg(seg: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seg)) {
        if (next.size > 1) next.delete(seg);
      } else {
        next.add(seg);
      }
      return next;
    });
  }

  const activeSegments = segmentsByNet.filter((s) => selected.has(s));
  const segColorMap = Object.fromEntries(
    segmentsByNet.map((s, i) => [s, segColor(i)]),
  );

  // ── Chart 1: Line chart data ──────────────────────────────────────────────
  // Pivot monthly into { fyMonth, SWR: 62.5, CPVC: 45.0, ... }

  const monthlyByKey = useMemo(() => {
    const m = new Map<string, TrendMonthRow>();
    for (const r of monthly) m.set(`${r.fyMonth}|${r.segment}`, r);
    return m;
  }, [monthly]);

  const lineData = useMemo(() =>
    fyMonths.map((fm) => {
      const point: Record<string, string | number> = { fyMonth: fm };
      for (const seg of activeSegments) {
        const row = monthlyByKey.get(`${fm}|${seg}`);
        if (row) {
          const denom = everSold[seg] ?? row.codesBought;
          point[seg] = breadthPct(row.codesBought, denom);
        }
      }
      return point;
    }),
    [fyMonths, activeSegments, monthlyByKey, everSold],
  );

  // ── Chart 2: Bar chart data ───────────────────────────────────────────────
  // One bar per segment, grouped by FY → shows breadth% trajectory

  const fyTotalsByKey = useMemo(() => {
    const m = new Map<string, TrendFyRow>();
    for (const r of fyTotals) m.set(`${r.fy}|${r.segment}`, r);
    return m;
  }, [fyTotals]);

  const barData = useMemo(() =>
    activeSegments.map((seg) => {
      const point: Record<string, string | number> = { segment: abbr(seg) };
      for (const fy of fys) {
        const row = fyTotalsByKey.get(`${fy}|${seg}`);
        if (row) {
          const denom = everSold[seg] ?? row.codesBought;
          point[fy] = breadthPct(row.codesBought, denom);
        }
      }
      return point;
    }),
    [activeSegments, fys, fyTotalsByKey, everSold],
  );

  // Bar colours: one per FY, cycling through a simpler set
  const FY_BAR_COLORS = [
    "#94a3b8", "#60a5fa", "#34d399", "#f59e0b", "#f87171",
  ];

  // ── Net share table ───────────────────────────────────────────────────────
  // segment × FY: net share as %, with ▲ / ▼ vs prior FY

  const netShareTable = useMemo(() => {
    return segmentsByNet.slice(0, 12).map((seg) => {
      const cells: Array<{ fy: string; share: number | null }> = fys.map((fy) => {
        const row = fyTotalsByKey.get(`${fy}|${seg}`);
        const total = fyNetTotals[fy] ?? 0;
        return {
          fy,
          share: row && total > 0 ? +trunc2(((row.net / total) * 100)) : null,
        };
      });
      return { segment: seg, cells };
    });
  }, [segmentsByNet, fys, fyTotalsByKey, fyNetTotals]);

  if (!fyMonths.length) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        No trend data available for this channel.
      </p>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Segment selector */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Segments shown in charts
        </p>
        <div className="flex flex-wrap gap-1.5">
          {segmentsByNet.map((seg) => {
            const active = selected.has(seg);
            const color = segColorMap[seg];
            return (
              <button
                key={seg}
                type="button"
                onClick={() => toggleSeg(seg)}
                className={cn(
                  "px-2 py-0.5 rounded text-xs border transition-colors",
                  active
                    ? "text-white border-transparent"
                    : "bg-muted text-muted-foreground border-muted-foreground/20 hover:bg-muted/70",
                )}
                style={active ? { backgroundColor: color, borderColor: color } : {}}
              >
                {seg}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Chart 1: Breadth % over time ────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold mb-1">
          Breadth % by month
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            {data.level === "project"
            ? "codesBought ÷ codesEverSold (project codes)"
            : "codesBought ÷ codesEverSold (territory codes)"}
          </span>
        </h3>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={lineData} margin={{ top: 8, right: 16, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
            <XAxis
              dataKey="fyMonth"
              tick={{ fontSize: 11, fill: tickColor }}
              tickLine={false}
              axisLine={false}
              interval={xTickInterval(fyMonths.length)}
            />
            <YAxis
              tick={{ fontSize: 11, fill: tickColor }}
              tickLine={false}
              axisLine={false}
              domain={[0, 100]}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              formatter={(val: number, name: string) => [`${val}%`, name]}
              contentStyle={{
                fontSize: 12,
                background: isDark ? "#1e1e2e" : "#fff",
                border: `1px solid ${isDark ? "#333" : "#e5e7eb"}`,
                borderRadius: 6,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {activeSegments.map((seg) => (
              <Line
                key={seg}
                type="monotone"
                dataKey={seg}
                stroke={segColorMap[seg]}
                dot={false}
                strokeWidth={1.8}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── Chart 2: FY-over-FY breadth % per segment ────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold mb-1">
          Breadth % by FY
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            {data.level === "project"
              ? "full-year distinct codes ÷ codesEverSold (project codes)"
              : "full-year distinct codes ÷ codesEverSold (territory codes)"}
          </span>
        </h3>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart
            data={barData}
            margin={{ top: 8, right: 16, left: -20, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
            <XAxis
              dataKey="segment"
              tick={{ fontSize: 10, fill: tickColor }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: tickColor }}
              tickLine={false}
              axisLine={false}
              domain={[0, 100]}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              formatter={(val: number, name: string) => [`${val}%`, `FY ${name}`]}
              contentStyle={{
                fontSize: 12,
                background: isDark ? "#1e1e2e" : "#fff",
                border: `1px solid ${isDark ? "#333" : "#e5e7eb"}`,
                borderRadius: 6,
              }}
            />
            <Legend
              formatter={(v: string) => `FY ${v}`}
              wrapperStyle={{ fontSize: 11 }}
            />
            {fys.map((fy, i) => (
              <Bar
                key={fy}
                dataKey={fy}
                fill={FY_BAR_COLORS[i % FY_BAR_COLORS.length]}
                radius={[3, 3, 0, 0]}
                maxBarSize={28}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* ── Net share shift table ────────────────────────────────────────── */}
      <div>
        {/* Channel-basis disclosure — FY2024-25 vs FY2025-26 are not like-for-like
            (one large customer was unattributed in 2024-25 and project in 2025-26).
            Plain text by request; do not restyle or move below the table. */}
        <p className="text-xs mb-2">
          FY2024-25 and FY2025-26 are not on the same channel basis. One
          customer (net Rs 35.73 Cr in FY2025-26) is classified as project
          this year and was unattributed last year, so it sits in the
          FY2024-25 territory total and not in FY2025-26. Year-on-year
          shifts in this table are not like-for-like. Under review.
        </p>
        <h3 className="text-sm font-semibold mb-1">
          Net mix shift
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            each segment's share of total net — which are growing / shrinking
          </span>
        </h3>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="py-1.5 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">
                  Segment
                </th>
                {fys.map((fy) => (
                  <th
                    key={fy}
                    className="py-1.5 px-2 text-right font-medium text-muted-foreground whitespace-nowrap"
                  >
                    FY {fy}
                  </th>
                ))}
                <th className="py-1.5 px-3 text-right font-medium text-muted-foreground whitespace-nowrap">
                  Shift
                </th>
              </tr>
            </thead>
            <tbody>
              {netShareTable.map(({ segment, cells }) => {
                const first = cells.find((c) => c.share !== null)?.share ?? null;
                const last = [...cells].reverse().find((c) => c.share !== null)?.share ?? null;
                const shift = first !== null && last !== null ? +trunc2((last - first)) : null;
                return (
                  <tr key={segment} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-1.5 px-3 font-medium whitespace-nowrap">
                      <span
                        className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle flex-shrink-0"
                        style={{ backgroundColor: segColorMap[segment] ?? "#888" }}
                      />
                      {segment}
                    </td>
                    {cells.map(({ fy, share }) => (
                      <td
                        key={fy}
                        className="py-1.5 px-2 text-right tabular-nums"
                      >
                        {share !== null ? (
                          <NetShareCell share={share} />
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                    ))}
                    <td className="py-1.5 px-3 text-right tabular-nums font-medium">
                      {shift !== null ? (
                        <span
                          className={cn(
                            shift > 0.5
                              ? "text-emerald-600 dark:text-emerald-400"
                              : shift < -0.5
                                ? "text-red-600 dark:text-red-400"
                                : "text-muted-foreground",
                          )}
                        >
                          {shift > 0 ? "+" : ""}
                          {shift}pp
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          "Shift" = latest FY share minus earliest FY share (pp = percentage points).
          {fys.length > 0 &&
            ` Total net per FY: ${fys.map((fy) => `${fy} ${fmtCr(fyNetTotals[fy] ?? 0)}`).join(", ")}.`}
        </p>
      </div>
    </div>
  );
}

// ── Net share cell ─────────────────────────────────────────────────────────────

function NetShareCell({ share }: { share: number }) {
  const color =
    share >= 20 ? "bg-blue-500/20 text-blue-700 dark:text-blue-300"
    : share >= 12 ? "bg-blue-400/10 text-blue-600 dark:text-blue-400"
    : share >= 6  ? "bg-slate-100 dark:bg-slate-800/60"
    : "text-muted-foreground/70";
  return (
    <span className={cn("px-1 rounded text-right", color)}>
      {share}%
    </span>
  );
}
