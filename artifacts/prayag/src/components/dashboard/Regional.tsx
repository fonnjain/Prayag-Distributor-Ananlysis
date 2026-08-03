// Regional — FY26-27 order-book retail sales by state, head, and retailer
// (its original basis), now with State Head / State filters and an Excel
// export. The data is aggregate-level (dashboard snapshot), so there is no
// month or distributor dimension — the filter bar shows head/state only and
// the global period selector stays FY-only.
import { useState, useEffect, useMemo } from "react";
import { formatCompact, CHART_COLORS } from "@/data/dataset";
import { DEFAULT_FY } from "@/data/global-filter-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Download } from "lucide-react";
import { useTheme } from "next-themes";
import { CustomTooltip } from "./shared";
import {
  CompanyReportFilterBar,
  EMPTY_ENTITY_FILTER,
  hasEntityFilter,
  type EntityFilterValue,
} from "./CompanyReportFilters";

type ByState = { state: string; head: string; retailers: number; sales: number };
type HeadRetail = { head: string; retailers: number; sales: number; share: number };
type TopRetailer = { company: string; state: string; city: string; sales: number };

type Payload = {
  filtered: boolean;
  /** State filter active → per-head figures cover the head's full territory. */
  headsFullTerritory: boolean;
  syncedAt: string;
  byState: ByState[];
  headsRetail: HeadRetail[];
  topRetailers: TopRetailer[];
};

export default function Regional() {
  // The order-book snapshot only exists for the current FY, so this page is
  // declared NONE in period-capability (no FY selector) and the filter tree
  // is pinned to DEFAULT_FY — options and data always share the same basis.
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "#98999C" : "#71717a";

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState<EntityFilterValue>(EMPTY_ENTITY_FILTER);

  // Head/state only — the order-book aggregates have no distributor or month
  // dimension.
  const filterQuery = useMemo(() => {
    const parts: string[] = [];
    if (entityFilter.heads.length > 0) parts.push(`heads=${encodeURIComponent(JSON.stringify(entityFilter.heads))}`);
    if (entityFilter.states.length > 0) parts.push(`states=${encodeURIComponent(JSON.stringify(entityFilter.states))}`);
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }, [entityFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/regional-reports${filterQuery}`)
      .then((r) => {
        if (!r.ok) return r.json().then((e: { error?: string }) => { throw new Error(e.error ?? r.statusText); });
        return r.json() as Promise<Payload>;
      })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err: Error) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filterQuery]);

  const topStates = useMemo(
    () => (data ? [...data.byState].sort((a, b) => b.sales - a.sales).slice(0, 15) : []),
    [data],
  );

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Filters + export */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CompanyReportFilterBar
          fy={DEFAULT_FY}
          value={entityFilter}
          onChange={setEntityFilter}
          showCustomers={false}
        />
        <a
          href={`/api/regional-reports/export${filterQuery}`}
          download
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
          data-testid="button-export-excel-regional"
        >
          <Download className="h-3.5 w-3.5" />
          Export Excel
        </a>
      </div>
      {hasEntityFilter(entityFilter) && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Filters active — figures below are a subset and will not match the unfiltered totals.
        </p>
      )}

      {loading && !data && <div className="py-12 text-center text-sm text-muted-foreground">Loading regional data...</div>}
      {error && <div className="py-6 text-center text-sm text-destructive">{error}</div>}

      {data && (
        <>
          <Card>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base font-semibold">Top 15 States by Retail Sales</CardTitle>
            </CardHeader>
            <CardContent className="px-2 sm:px-5 pb-5 pt-2">
              {topStates.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">No data for this selection.</p>
              ) : (
                <ResponsiveContainer width="100%" height={400} debounce={0}>
                  <BarChart data={topStates} layout="vertical" margin={{ top: 5, right: 30, left: 60, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke={gridColor} />
                    <XAxis
                      type="number"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 12, fill: tickColor }}
                      tickFormatter={(val) => `₹${(val / 10000000).toFixed(0)}Cr`}
                    />
                    <YAxis
                      dataKey="state"
                      type="category"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 11, fill: tickColor }}
                      width={80}
                    />
                    <Tooltip
                      content={<CustomTooltip />}
                      isAnimationActive={false}
                      cursor={{ fill: gridColor }}
                      formatter={(value: number) => formatCompact(value)}
                    />
                    <Bar dataKey="sales" name="Sales" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={16}>
                      {topStates.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={CHART_COLORS.blue} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader className="px-5 pt-5 pb-2">
                <CardTitle className="text-base font-semibold">Regional Heads Performance</CardTitle>
                {data.headsFullTerritory && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400 font-normal">
                    Heads covering the selected states — figures cover each head's full territory (no per-state split exists).
                  </p>
                )}
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th className="px-5 py-3 text-left font-medium">Head</th>
                        <th className="px-5 py-3 text-right font-medium">Retailers</th>
                        <th className="px-5 py-3 text-right font-medium">Sales</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {data.headsRetail.map((head, i) => (
                        <tr key={i} className="hover:bg-muted/20 transition-colors">
                          <td className="px-5 py-3 font-medium">{head.head}</td>
                          <td className="px-5 py-3 text-right">{head.retailers}</td>
                          <td className="px-5 py-3 text-right">{formatCompact(head.sales)}</td>
                        </tr>
                      ))}
                      {data.headsRetail.length === 0 && (
                        <tr><td colSpan={3} className="px-5 py-6 text-center text-xs text-muted-foreground">No heads match this selection.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-5 pt-5 pb-2">
                <CardTitle className="text-base font-semibold">Top Retail Customers</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto h-[400px]">
                  <table className="w-full text-sm relative">
                    <thead className="bg-muted/50 text-muted-foreground sticky top-0 backdrop-blur-md">
                      <tr>
                        <th className="px-5 py-3 text-left font-medium">Company</th>
                        <th className="px-5 py-3 text-left font-medium">City, State</th>
                        <th className="px-5 py-3 text-right font-medium">Sales</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {data.topRetailers.map((retailer, i) => (
                        <tr key={i} className="hover:bg-muted/20 transition-colors">
                          <td className="px-5 py-3 font-medium truncate max-w-[150px]">{retailer.company}</td>
                          <td className="px-5 py-3 text-muted-foreground truncate max-w-[120px]">{retailer.city}, {retailer.state}</td>
                          <td className="px-5 py-3 text-right">{formatCompact(retailer.sales)}</td>
                        </tr>
                      ))}
                      {data.topRetailers.length === 0 && (
                        <tr><td colSpan={3} className="px-5 py-6 text-center text-xs text-muted-foreground">No retailers match this selection.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
