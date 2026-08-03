import { formatCompact, CHART_COLORS, CHART_COLOR_LIST } from "@/data/dataset";
import { useDashboard } from "@/data/dashboard-context";
import { KPICard, CustomTooltip, CustomLegend } from "./shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LineChart, Line, Legend } from "recharts";
import { CSVLink } from "react-csv";
import { Download, TrendingUp } from "lucide-react";
import { useTheme } from "next-themes";

export default function OrderMomentum() {
  const { data } = useDashboard();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "#98999C" : "#71717a";

  const totalYTD = data.totals.orders_fy2627_ytd_cr;
  const groups = [...data.orders_fy2627.groups]
    .sort((a, b) => b.value_cr - a.value_cr)
    .slice(0, 10);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Export — the order-book aggregates carry only month and group
          dimensions, so the shared State Head / State / Distributor filter
          bar does not apply to this page. */}
      <div className="flex items-center justify-end">
        <a
          href="/api/momentum-reports/export"
          download
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
          data-testid="button-export-excel-momentum"
        >
          <Download className="w-3.5 h-3.5" />
          Export Excel
        </a>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KPICard 
          title="Orders YTD (FY26-27)" 
          value={`₹${totalYTD} Cr`} 
          icon={<TrendingUp className="w-5 h-5" />}
          subtitle="Forward pipeline momentum"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="px-5 pt-5 pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base font-semibold">Monthly Order Value (Cr)</CardTitle>
            <CSVLink 
              data={data.orders_fy2627.monthly} 
              filename="monthly-orders.csv" 
              className="print:hidden flex items-center justify-center w-[28px] h-[28px] rounded-md transition-colors hover:bg-muted text-muted-foreground"
            >
              <Download className="w-4 h-4" />
            </CSVLink>
          </CardHeader>
          <CardContent className="px-2 sm:px-5 pb-5 pt-2">
            <ResponsiveContainer width="100%" height={320} debounce={0}>
              <BarChart data={data.orders_fy2627.monthly} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
                <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: tickColor }} dy={10} />
                <YAxis 
                  tickLine={false} 
                  axisLine={false} 
                  tick={{ fontSize: 12, fill: tickColor }} 
                  tickFormatter={(val) => `₹${val}Cr`}
                />
                <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ fill: gridColor }} />
                <Bar dataKey="value_cr" name="Order Value (Cr)" radius={[4, 4, 0, 0]} isAnimationActive={false} barSize={32}>
                  {data.orders_fy2627.monthly.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLORS.purple} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-5 pt-5 pb-2 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base font-semibold">Top 10 Order Groups (Cr)</CardTitle>
            <CSVLink 
              data={groups} 
              filename="order-groups.csv" 
              className="print:hidden flex items-center justify-center w-[28px] h-[28px] rounded-md transition-colors hover:bg-muted text-muted-foreground"
            >
              <Download className="w-4 h-4" />
            </CSVLink>
          </CardHeader>
          <CardContent className="px-2 sm:px-5 pb-5 pt-2">
            <ResponsiveContainer width="100%" height={320} debounce={0}>
              <BarChart data={groups} layout="vertical" margin={{ top: 5, right: 20, left: 80, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke={gridColor} />
                <XAxis 
                  type="number" 
                  tickLine={false} 
                  axisLine={false} 
                  tick={{ fontSize: 12, fill: tickColor }} 
                  tickFormatter={(val) => `₹${val}Cr`}
                />
                <YAxis 
                  dataKey="group" 
                  type="category" 
                  tickLine={false} 
                  axisLine={false} 
                  tick={{ fontSize: 11, fill: tickColor }} 
                  width={100}
                />
                <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ fill: gridColor }} />
                <Bar dataKey="value_cr" name="Value (Cr)" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={12}>
                  {groups.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLORS.blue} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
