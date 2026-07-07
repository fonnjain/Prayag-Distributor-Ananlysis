import { formatCompact, CHART_COLORS } from "@/data/dataset";
import { useDashboard } from "@/data/dashboard-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { CSVLink } from "react-csv";
import { Download } from "lucide-react";
import { useTheme } from "next-themes";
import { CustomTooltip } from "./shared";

export default function Regional() {
  const { data } = useDashboard();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "#98999C" : "#71717a";

  const topStates = [...data.by_state].sort((a, b) => b.sales - a.sales).slice(0, 15);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Card>
        <CardHeader className="px-5 pt-5 pb-2 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base font-semibold">Top 15 States by Retail Sales</CardTitle>
          <CSVLink 
            data={topStates} 
            filename="top-states.csv" 
            className="print:hidden flex items-center justify-center w-[28px] h-[28px] rounded-md transition-colors hover:bg-muted text-muted-foreground"
          >
            <Download className="w-4 h-4" />
          </CSVLink>
        </CardHeader>
        <CardContent className="px-2 sm:px-5 pb-5 pt-2">
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
                {topStates.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={CHART_COLORS.blue} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base font-semibold">Regional Heads Performance</CardTitle>
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
                  {data.heads_retail.map((head, i) => (
                    <tr key={i} className="hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3 font-medium">{head.head}</td>
                      <td className="px-5 py-3 text-right">{head.retailers}</td>
                      <td className="px-5 py-3 text-right">{formatCompact(head.sales)}</td>
                    </tr>
                  ))}
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
                  {data.top_retailers.map((retailer, i) => (
                    <tr key={i} className="hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3 font-medium truncate max-w-[150px]">{retailer.company}</td>
                      <td className="px-5 py-3 text-muted-foreground truncate max-w-[120px]">{retailer.city}, {retailer.state}</td>
                      <td className="px-5 py-3 text-right">{formatCompact(retailer.sales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
