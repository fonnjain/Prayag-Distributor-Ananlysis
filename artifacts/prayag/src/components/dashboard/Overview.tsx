import { trunc2 } from "@/lib/trunc";
import { formatCompact, CHART_COLORS } from "@/data/dataset";
import { KPICard } from "./shared";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LabelList } from "recharts";
import { CSVLink } from "react-csv";
import { Download, IndianRupee, Target, Database, AlertCircle } from "lucide-react";
import { useTheme } from "next-themes";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetOverviewPerformance } from "@workspace/api-client-react";
import { prepareChartData, formatGrowthLabel, getNarrativeSummary, NarrativeSummary, getAchievementText, formatCroreExact, getAchievementDetails } from "./OverviewLogic";

function OverviewSkeleton() {
  return (
    <div className="space-y-6 animate-in fade-in" data-testid="overview-loading">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="p-5 space-y-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-8 w-24" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-48" />
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3 w-44" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-2">
          <Skeleton className="h-[320px] w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function OverviewError() {
  return (
    <div className="flex flex-col items-center justify-center p-12 text-center border rounded-lg bg-destructive/5" data-testid="overview-error">
      <AlertCircle className="w-10 h-10 text-destructive mb-4" />
      <h3 className="text-lg font-semibold">Failed to load performance data</h3>
      <p className="text-muted-foreground mt-2 max-w-md">
        There was a problem retrieving the overview performance metrics. Please try again later.
      </p>
    </div>
  );
}

function NarrativeBlock({ summary }: { summary: NarrativeSummary }) {
  if (!summary.available) {
    return (
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground">
          No closed, comparable months available for narrative summary.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-primary/5 border-primary/10">
      <CardContent className="p-5">
        <p className="text-sm leading-relaxed text-foreground">
          Based strictly on {summary.closedCount} closed comparable month{summary.closedCount > 1 ? "s" : ""} (excluding partial and future months), the overall trajectory shows a growth of{" "}
          <span className="font-semibold">{summary.trajectoryPct != null ? formatGrowthLabel(summary.trajectoryPct) : "0.0%"}</span>{" "}
          <span className="text-muted-foreground">
            ({formatCompact(summary.totalNum)} / {formatCompact(summary.totalDen)})
          </span>.
          {summary.strongest && (
            <>
              {" "}The strongest month was {summary.strongest.monthLabel} at{" "}
              <span className="font-semibold">{formatGrowthLabel(summary.strongest.pct)}</span>{" "}
              <span className="text-muted-foreground">
                ({formatCompact(summary.strongest.num)} / {formatCompact(summary.strongest.den)})
              </span>.
            </>
          )}
          {summary.weakest && summary.weakest.monthLabel !== summary.strongest?.monthLabel && (
            <>
              {" "}The weakest month was {summary.weakest.monthLabel} at{" "}
              <span className="font-semibold">{formatGrowthLabel(summary.weakest.pct)}</span>{" "}
              <span className="text-muted-foreground">
                ({formatCompact(summary.weakest.num)} / {formatCompact(summary.weakest.den)})
              </span>.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

export default function Overview() {
  const { data, isLoading, isError } = useGetOverviewPerformance();
  const { theme } = useTheme();
  const isDark = theme === "dark";

  if (isLoading) return <OverviewSkeleton />;
  if (isError || !data) return <OverviewError />;

  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "#98999C" : "#71717a";
  const priorBarColor = isDark ? "#3f3f46" : "#e4e4e7";

  const ytd = data.closedComparableYtd;
  const ach = data.companyAchievement;

  const chartData = prepareChartData(data.months);
  const narrativeSummary = getNarrativeSummary(data.months);

  const csvData = data.months.map((m) => ({
    Month: m.monthLabel,
    [`${data.fy} Sales (INR)`]: m.currentSalesInr,
    [`${data.priorFy} Sales (INR)`]: m.priorSalesInr,
    State: m.state,
    "Growth %": m.comparableGrowthPct,
    "Growth Numerator": m.growthNumeratorInr,
    "Growth Denominator": m.growthDenominatorInr,
  }));

  const ChartTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;

    const currentPayload = payload.find((p: any) => p.dataKey === "currentSalesInr");
    const entry = currentPayload?.payload || payload[0].payload;

    return (
      <div className="bg-popover border border-border rounded-lg shadow-lg p-3 text-sm min-w-[240px]" data-testid="chart-tooltip">
        <div className="font-semibold text-foreground mb-2 pb-2 border-b border-border/50 flex items-center justify-between">
          <span>{label}</span>
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider bg-muted px-1.5 py-0.5 rounded-sm">
            {entry.state}
          </span>
        </div>
        <div className="space-y-2">
          {payload.map((p: any, i: number) => (
            <div key={i} className="flex justify-between items-center gap-4">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: p.color }} />
                <span className="text-muted-foreground text-xs">{p.name}</span>
              </span>
              <span className="font-medium font-mono text-xs">
                {p.value != null ? formatCompact(p.value) : "—"}
              </span>
            </div>
          ))}
          {entry.state === "closed" && entry.comparableGrowthPct != null && (
            <div className="pt-2 mt-2 border-t border-border/50">
              <div className="flex justify-between items-center gap-4 mb-1">
                <span className="text-muted-foreground text-xs">Growth Basis</span>
                <span className="font-medium font-mono text-xs">
                  {formatGrowthLabel(entry.comparableGrowthPct)}
                </span>
              </div>
              {entry.growthNumeratorInr != null && entry.growthDenominatorInr != null && (
                <div className="flex justify-between items-center gap-4">
                  <span className="text-muted-foreground/70 text-[10px]">Num / Den</span>
                  <span className="text-muted-foreground text-[10px] font-mono">
                    {formatCompact(entry.growthNumeratorInr)} / {formatCompact(entry.growthDenominatorInr)}
                  </span>
                </div>
              )}
            </div>
          )}
          <div className="pt-2 mt-2 border-t border-border/50 text-[10px] text-muted-foreground space-y-0.5">
            <p>Source: {data.sources.sales} vs {data.sources.priorSales}</p>
            <p>Coverage: {entry.currentCoverageThrough || "N/A"} (Current) / {entry.priorCoverageThrough || "N/A"} (Prior)</p>
          </div>
        </div>
      </div>
    );
  };

  const GrowthLabel = (props: any) => {
    const { x, y, width, index } = props;
    const entry = chartData[index];
    if (entry.state !== "closed" || entry.comparableGrowthPct == null) return null;
    const text = formatGrowthLabel(entry.comparableGrowthPct);
    const fill = isDark ? "#A1A1AA" : "#71717A";

    return (
      <text x={x + width / 2} y={y - 8} fill={fill} fontSize={10} textAnchor="middle" fontWeight={500} className="font-mono">
        {text}
      </text>
    );
  };

  const achievementText = getAchievementText(ach);
  const achievementValueNode = ach.actualsError
    ? <span className="text-destructive text-xl">{achievementText}</span>
    : achievementText;

  const achievementDetails = getAchievementDetails(ach, data.sources.targets);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500" data-testid="overview-dashboard">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* KPI 1: YTD Sales vs Prior */}
        <KPICard
          title={`Closed-Comparable YTD (${data.fy})`}
          value={formatCroreExact(ytd.currentSalesInr)}
          subtitle={
            ytd.growthPct != null
              ? `${formatGrowthLabel(ytd.growthPct)} vs Prior YTD`
              : "No prior comparison"
          }
          icon={<IndianRupee className="w-5 h-5" />}
          detail={[
            `Prior YTD: ${formatCroreExact(ytd.priorSalesInr)}`,
            ytd.growthNumeratorInr != null && ytd.growthDenominatorInr != null
              ? `Basis: ${formatCompact(ytd.growthNumeratorInr)} / ${formatCompact(ytd.growthDenominatorInr)}`
              : "Basis: N/A",
            `Source: ${data.sources.sales} vs ${data.sources.priorSales}`,
            ytd.throughDate ? `Through: ${ytd.throughDate}` : "Through: Unavailable",
          ]}
        />

        {/* KPI 2: Achievement */}
        <KPICard
          title={`YTD Target Achievement (${data.fy})`}
          value={achievementValueNode}
          subtitle={
            ach.actualsAvailable
              ? `Actual: ${ach.actualInr != null ? formatCompact(ach.actualInr) : "—"}`
              : undefined
          }
          icon={<Target className="w-5 h-5" />}
          detail={achievementDetails}
        />

        {/* KPI 3: Data Coverage & Context */}
        <KPICard
          title="Data Coverage Context"
          value={data.fy}
          subtitle={`vs ${data.priorFy} Base`}
          icon={<Database className="w-5 h-5" />}
          detail={[
            `Current Closed: ${data.coverage.currentClosedMonths.join(", ") || "None"}`,
            `Current Partial: ${data.coverage.currentPartialMonths.join(", ") || "None"}`,
            `Prior Closed: ${data.coverage.priorClosedMonths.join(", ") || "None"}`,
            `Bookings Source: ${data.sources.bookings}`,
          ]}
        />
      </div>

      <NarrativeBlock summary={narrativeSummary} />

      <Card>
        <CardHeader className="px-5 pt-5 pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base font-semibold">12-Month Performance Trend</CardTitle>
          <CSVLink
            data={csvData}
            filename="overview-performance.csv"
            className="print:hidden flex items-center justify-center w-[28px] h-[28px] rounded-md transition-colors hover:bg-muted text-muted-foreground"
            aria-label="Export chart data"
          >
            <Download className="w-4 h-4" />
          </CSVLink>
        </CardHeader>
        <CardContent className="px-2 sm:px-5 pb-5 pt-2">
          <ResponsiveContainer width="100%" height={340} debounce={0}>
            <BarChart data={chartData} margin={{ top: 25, right: 10, left: 10, bottom: 0 }} barGap={2} barCategoryGap="20%">
              <defs>
                <pattern id="stripe-pattern-dark" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_COLORS.blue} strokeWidth="2.5" opacity={0.6} />
                </pattern>
                <pattern id="stripe-pattern-light" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_COLORS.blue} strokeWidth="2.5" opacity={0.4} />
                </pattern>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
              <XAxis dataKey="monthLabel" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: tickColor }} dy={10} />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12, fill: tickColor, fontFamily: "monospace" }}
                tickFormatter={(val) => (val === 0 ? "0" : `₹${trunc2(val / 10000000)}Cr`)}
                dx={-10}
              />
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ fill: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.02)" }}
                isAnimationActive={false}
              />
              <Legend
                verticalAlign="bottom"
                height={36}
                iconType="rect"
                wrapperStyle={{ paddingTop: "20px", fontSize: "12px" }}
              />

              <Bar
                dataKey="currentSalesInr"
                name={`${data.fy} Sales`}
                fill={CHART_COLORS.blue}
                radius={[2, 2, 0, 0]}
                isAnimationActive={false}
              >
                {chartData.map((entry, index) => (
                  <Cell
                    key={`cell-curr-${index}`}
                    fill={entry.state === "partial" ? `url(#stripe-pattern-${isDark ? "dark" : "light"})` : CHART_COLORS.blue}
                    stroke={entry.state === "partial" ? CHART_COLORS.blue : "none"}
                    strokeWidth={entry.state === "partial" ? 1.5 : 0}
                    strokeDasharray={entry.state === "partial" ? "4 4" : "none"}
                    className={entry.state === "future" ? "opacity-0" : ""}
                  />
                ))}
                <LabelList dataKey="currentSalesInr" content={<GrowthLabel />} />
              </Bar>

              <Bar
                dataKey="priorSalesInr"
                name={`${data.priorFy} Sales`}
                fill={priorBarColor}
                radius={[2, 2, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
        <CardFooter className="px-5 pb-5 pt-0 text-xs text-muted-foreground flex justify-between items-center">
          <span>Source: {data.sources.sales} vs {data.sources.priorSales}</span>
          <span>
            Latest: {data.coverage.salesThroughDate ? `Through ${data.coverage.salesThroughDate}` : "Unavailable"} |
            Comparable: {ytd.throughDate ? `Through ${ytd.throughDate}` : "Unavailable"}
          </span>
        </CardFooter>
      </Card>
    </div>
  );
}
