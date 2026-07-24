import { formatCompact, CHART_COLORS, CHART_COLOR_LIST } from "@/data/dataset";
import { useDashboard } from "@/data/dashboard-context";
import {
  useGetAnalytics,
  getGetAnalyticsQueryKey,
} from "@workspace/api-client-react";
import { KPICard, CustomTooltip, CustomLegend } from "./shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { CSVLink } from "react-csv";
import { Download, IndianRupee, Users, Store, TrendingUp } from "lucide-react";
import { useTheme } from "next-themes";

export default function Overview() {
  const { data } = useDashboard();
  // FY25-26 total sales come from the invoice-line register (all 12 months
  // are final), served by the analytics endpoint.
  const fy2526Query = useGetAnalytics(
    { fy: "2025-26" },
    {
      query: {
        queryKey: getGetAnalyticsQueryKey({ fy: "2025-26" }),
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
      },
    },
  );
  const fy2526Total = fy2526Query.data
    ? fy2526Query.data.months.reduce((sum, m) => sum + m.amount, 0)
    : null;
  const { theme } = useTheme();
  const isDark = theme === "dark";
  
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "#98999C" : "#71717a";

  const monthlySales = data.fy2425.months.map((month, i) => ({
    month,
    sales: data.fy2425.grand_monthly[i]
  }));

  const pieData = data.fy2425.groups.map(g => ({
    name: g.group,
    value: g.annual
  })).sort((a, b) => b.value - a.value);

  // Secondary retail reach: registered retailers not covered by any secondary
  // team member — minimum figure, true gap is higher because 11,338 is not deduplicated.
  const registeredRetailers = data.totals.retailers;
  const secondaryReach = data.totals.secondary_retail_reach ?? 0;
  const coverageGapPct =
    registeredRetailers > 0
      ? Math.round(((registeredRetailers - secondaryReach) / registeredRetailers) * 100)
      : 0;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <KPICard 
          title="FY24-25 Total Sales" 
          value={formatCompact(data.totals.fy2425_sales_inr)} 
          icon={<IndianRupee className="w-5 h-5" />}
          detail={[
            "Primary sale & dispatch",
            "Source: sale_line register",
            "All channels, incl. project & institutional",
          ]}
        />
        <KPICard
          title="FY25-26 Total Sales"
          value={fy2526Total != null ? formatCompact(fy2526Total) : "—"}
          icon={<IndianRupee className="w-5 h-5" />}
          detail={[
            "Primary sale & dispatch",
            "Source: analytics endpoint",
            "All channels, incl. project & institutional",
          ]}
        />
        <KPICard 
          title="Orders YTD (FY26-27)" 
          value={`₹${data.totals.orders_fy2627_ytd_cr} Cr`} 
          icon={<TrendingUp className="w-5 h-5" />}
          detail={[
            "Primary order booking",
            "Source: Order Book, monthly tabs",
            "All channels",
          ]}
        />
        <KPICard 
          title="Retailers" 
          value={data.totals.retailers.toLocaleString()} 
          icon={<Store className="w-5 h-5" />}
          subtitle={`Secondary OB: ${formatCompact(data.totals.retailer_sales_inr)}`}
          detail={[
            "Registered retailer count",
            "Source: Retailer-Distributor Data",
            "Master roster · Excl. project & institutional",
          ]}
        />
        <KPICard 
          title="Channel Partners" 
          value={data.totals.channel_partners.toLocaleString()} 
          icon={<Users className="w-5 h-5" />}
          detail={[
            "Distributors only",
            "Source: Retailer-Distributor Data",
            "Direct commercial partners",
          ]}
        />
        <KPICard
          title="Secondary Retail Reach"
          value={(data.totals.secondary_retail_reach ?? 0).toLocaleString()}
          icon={<Store className="w-5 h-5" />}
          detail={[
            "Per-member col K sum, not deduplicated",
            "Source: Secondary report",
            `At least ${coverageGapPct}% of registered retailers uncovered`,
          ]}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="px-5 pt-5 pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base font-semibold">FY24-25 Monthly Sales</CardTitle>
            <CSVLink 
              data={monthlySales} 
              filename="monthly-sales.csv" 
              className="print:hidden flex items-center justify-center w-[28px] h-[28px] rounded-md transition-colors hover:bg-muted text-muted-foreground"
              aria-label="Export chart data"
            >
              <Download className="w-4 h-4" />
            </CSVLink>
          </CardHeader>
          <CardContent className="px-2 sm:px-5 pb-5 pt-2">
            <ResponsiveContainer width="100%" height={320} debounce={0}>
              <AreaChart data={monthlySales} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS.blue} stopOpacity={0.3}/>
                    <stop offset="95%" stopColor={CHART_COLORS.blue} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: tickColor }} dy={10} />
                <YAxis 
                  tickLine={false} 
                  axisLine={false} 
                  tick={{ fontSize: 12, fill: tickColor }} 
                  tickFormatter={(val) => `₹${(val / 10000000).toFixed(0)}Cr`}
                  dx={-10}
                />
                <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ stroke: gridColor, strokeWidth: 1, fill: "transparent" }} />
                <Area type="monotone" dataKey="sales" name="Sales" stroke={CHART_COLORS.blue} strokeWidth={3} fillOpacity={1} fill="url(#colorSales)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-5 pt-5 pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base font-semibold">Product Mix</CardTitle>
            <CSVLink 
              data={pieData} 
              filename="product-mix.csv" 
              className="print:hidden flex items-center justify-center w-[28px] h-[28px] rounded-md transition-colors hover:bg-muted text-muted-foreground"
            >
              <Download className="w-4 h-4" />
            </CSVLink>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2">
            <ResponsiveContainer width="100%" height={320} debounce={0}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="45%"
                  innerRadius={70}
                  outerRadius={100}
                  paddingAngle={2}
                  dataKey="value"
                  stroke="none"
                  isAnimationActive={false}
                >
                  {pieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLOR_LIST[index % CHART_COLOR_LIST.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  content={<CustomTooltip />} 
                  isAnimationActive={false} 
                  formatter={(value: number) => formatCompact(value)}
                />
                <Legend content={<CustomLegend />} />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
