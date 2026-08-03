import { trunc2IN } from "@/lib/trunc";
import { useState, useEffect, useMemo } from "react";
import { formatINR, formatCompact } from "@/data/dataset";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { TrendingUp, TrendingDown, Users, Loader2, RefreshCw, AlertTriangle, Download } from "lucide-react";
import { useTheme } from "next-themes";
import { useGlobalFilter } from "@/data/global-filter-context";
import {
  CompanyReportFilterBar,
  EMPTY_ENTITY_FILTER,
  entityFilterQuery,
  hasEntityFilter,
  type EntityFilterValue,
} from "./CompanyReportFilters";

type AnalyticsYoy = { current: number; prior: number; pct: number | null };

type MonthStat = {
  monthLabel: string;
  monthName: string;
  amount: number;
  territoryAmount: number;
  institutionalAmount: number;
  maxInvoiceDate: string | null;
  complete: boolean;
};

type AnalyticsPayload = {
  fy: string;
  compareFy: string;
  filtered?: boolean;
  months: MonthStat[];
  compareMonths: MonthStat[];
  comparableMonths: string[];
  yoy: { overall: AnalyticsYoy; territory: AnalyticsYoy; institutional: AnalyticsYoy };
  invoicesInPeriod: number;
  customersInPeriod: number;
  byHead: Array<{ head: string; amount: number; sharePct: number; isTerritory: boolean }>;
  retention: {
    periodMonths: string[];
    retained: number;
    newCustomers: number;
    lost: number;
    retainedRevenue: number;
    newRevenue: number;
    lostPriorRevenue: number;
  };
  margins: {
    byGroup: Array<{ group: string; revenue: number; margin: number }>;
    coveragePct: number;
    provisional: boolean;
    message: string | null;
  };
};

function toCr(value: number): string {
  return `₹${trunc2IN((value / 1e7))} Cr`;
}

function YoyCard({ title, split, subtitle }: { title: string; split: AnalyticsYoy; subtitle: string }) {
  const pct = split.pct;
  const up = pct != null && pct >= 0;
  return (
    <Card>
      <CardContent className="p-5 space-y-1.5">
        <p className="text-sm text-muted-foreground">{title}</p>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-semibold font-display">{toCr(split.current)}</span>
          {pct != null && (
            <span
              className={`inline-flex items-center gap-1 text-sm font-medium ${
                up ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
              }`}
            >
              {up ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              {pct > 0 ? "+" : ""}
              {pct}%
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          vs {toCr(split.prior)} — {subtitle}
        </p>
      </CardContent>
    </Card>
  );
}

export default function Growth() {
  const { fy } = useGlobalFilter();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "#98999C" : "#71717a";

  const [entityFilter, setEntityFilter] = useState<EntityFilterValue>(EMPTY_ENTITY_FILTER);
  const [report, setReport] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const queryStr = useMemo(
    () => `?fy=${encodeURIComponent(fy)}${entityFilterQuery(entityFilter)}`,
    [fy, entityFilter],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/analytics${queryStr}`)
      .then((r) => {
        if (!r.ok) return r.json().then((e: { error?: string }) => { throw new Error(e.error ?? r.statusText); });
        return r.json() as Promise<AnalyticsPayload>;
      })
      .then((d) => { if (!cancelled) { setReport(d); setLoading(false); } })
      .catch((err: Error) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [queryStr, reloadKey]);

  const filterBar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <CompanyReportFilterBar fy={fy} value={entityFilter} onChange={setEntityFilter} />
      <a
        href={`/api/analytics/export${queryStr}`}
        download
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
        data-testid="button-export-excel-growth"
      >
        <Download className="h-3.5 w-3.5" />
        Export Excel
      </a>
    </div>
  );

  if (loading && !report) {
    return (
      <div className="space-y-6">
        {filterBar}
        <div className="flex items-center gap-2 text-muted-foreground p-6">
          <Loader2 className="w-4 h-4 animate-spin" />
          Computing growth analytics...
        </div>
      </div>
    );
  }
  if (error || !report) {
    return (
      <div className="p-6 space-y-3">
        {filterBar}
        <p className="text-sm text-destructive">Could not load growth analytics.</p>
        <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
          <RefreshCw className="w-4 h-4 mr-1.5" />
          Retry
        </Button>
      </div>
    );
  }

  const periodLabel =
    report.comparableMonths.length > 0
      ? `${report.comparableMonths[0]}–${report.comparableMonths[report.comparableMonths.length - 1]}`
      : "no complete months";
  const partialMonths = report.months.filter((m) => !m.complete);

  const priorByName = new Map(report.compareMonths.map((m) => [m.monthName, m]));
  const trendData = report.months.map((m) => ({
    name: m.monthName + (m.complete ? "" : " (partial)"),
    [`FY ${report.fy}`]: Math.round((m.amount / 1e7) * 100) / 100,
    [`FY ${report.compareFy}`]: Math.round(((priorByName.get(m.monthName)?.amount ?? 0) / 1e7) * 100) / 100,
  }));

  const topHeads = report.byHead.slice(0, 8);
  const { retention, margins } = report;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {filterBar}
      {hasEntityFilter(entityFilter) && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Filters active — figures below are a subset and will not match the unfiltered totals.
          Last year is scoped to this year's distributors for the selected heads/states.
        </p>
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold font-display">Growth vs FY {report.compareFy}</h2>
          <p className="text-sm text-muted-foreground">
            Complete months only ({periodLabel}). {report.invoicesInPeriod.toLocaleString("en-IN")}{" "}
            invoices, {report.customersInPeriod.toLocaleString("en-IN")} customers in the period.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">FY {fy}</span>
      </div>

      {partialMonths.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
          <span>
            {partialMonths.map((m) => m.monthLabel).join(", ")}{" "}
            {partialMonths.length === 1 ? "is" : "are"} partial (data through{" "}
            {partialMonths[partialMonths.length - 1].maxInvoiceDate ?? "unknown"}) and excluded
            from all growth figures.
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <YoyCard title="Overall sales" split={report.yoy.overall} subtitle="same months last year" />
        <YoyCard title="Territory business" split={report.yoy.territory} subtitle="dealer and retail channel" />
        <YoyCard title="Institutional business" split={report.yoy.institutional} subtitle="projects, govt and other" />
      </div>

      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base font-semibold">Monthly Sales (Cr) — This Year vs Last</CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-4">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={trendData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
              <XAxis dataKey="name" tick={{ fill: tickColor, fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: tickColor, fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip
                formatter={(value: number) => [`₹${value} Cr`]}
                contentStyle={{
                  background: isDark ? "#1c1c1e" : "#fff",
                  border: "1px solid rgba(128,128,128,0.2)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey={`FY ${report.compareFy}`} fill="#94a3b8" radius={[4, 4, 0, 0]} />
              <Bar dataKey={`FY ${report.fy}`} fill="#2563eb" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="px-5 pt-5 pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Users className="w-4 h-4" />
              Customer Retention ({periodLabel})
            </CardTitle>
            <CardDescription>Compared with the same months last year.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="grid grid-cols-3 gap-3 text-center mb-4">
              <div className="rounded-lg bg-background/50 border border-border/50 p-3">
                <p className="text-xl font-semibold">{retention.retained}</p>
                <p className="text-xs text-muted-foreground">Retained</p>
              </div>
              <div className="rounded-lg bg-background/50 border border-border/50 p-3">
                <p className="text-xl font-semibold">{retention.newCustomers}</p>
                <p className="text-xs text-muted-foreground">New</p>
              </div>
              <div className="rounded-lg bg-background/50 border border-border/50 p-3">
                <p className="text-xl font-semibold">{retention.lost}</p>
                <p className="text-xs text-muted-foreground">Lost</p>
              </div>
            </div>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>Retained customers billed {toCr(retention.retainedRevenue)} this period.</li>
              <li>New customers added {toCr(retention.newRevenue)}.</li>
              <li>
                Lost customers were worth {toCr(retention.lostPriorRevenue)} in the same period
                last year.
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-5 pt-5 pb-3">
            <CardTitle className="text-base font-semibold">Sales by Head — FY {report.fy}</CardTitle>
            <CardDescription>Full fiscal year to date, including partial months.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="space-y-2">
              {topHeads.map((h) => (
                <div key={h.head} className="flex items-center gap-3">
                  <span className="text-sm w-32 truncate shrink-0">{h.head}</span>
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full ${h.isTerritory ? "bg-blue-500" : "bg-slate-400"}`}
                      style={{ width: `${Math.max(2, h.sharePct)}%` }}
                    />
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground w-24 text-right">
                    {formatCompact(h.amount)} ({h.sharePct}%)
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Blue bars are territory heads; grey bars are institutional buckets.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="px-5 pt-5 pb-3">
          <CardTitle className="text-base font-semibold">Margins</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          {margins.byGroup.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {margins.message ?? "Add a Cost Master to enable margins."} Cost coverage:{" "}
              {margins.coveragePct}% of revenue.
            </p>
          ) : (
            <>
              {margins.message && (
                <p className="text-sm text-amber-600 dark:text-amber-400 mb-3">{margins.message}</p>
              )}
              <div className="space-y-1.5">
                {margins.byGroup.map((g) => (
                  <div key={g.group} className="flex justify-between text-sm">
                    <span>{g.group}</span>
                    <span className="tabular-nums">
                      {formatINR(g.margin)} on {formatINR(g.revenue)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Cost coverage: {margins.coveragePct}% of revenue.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
