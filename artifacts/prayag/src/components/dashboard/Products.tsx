import { formatCompact, CHART_COLORS, CHART_COLOR_LIST } from "@/data/dataset";
import { useDashboard } from "@/data/dashboard-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { CustomTooltip } from "./shared";

export default function Products() {
  const { data } = useDashboard();
  const topProducts = [...data.fy2425.products]
    .sort((a, b) => b.annual - a.annual)
    .slice(0, 15);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base font-semibold">Top 15 Products by FY24-25 Sales</CardTitle>
        </CardHeader>
        <CardContent className="px-2 sm:px-5 pb-5 pt-2">
          <ResponsiveContainer width="100%" height={400} debounce={0}>
            <BarChart data={topProducts} layout="vertical" margin={{ top: 5, right: 30, left: 100, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="rgba(150,150,150,0.1)" />
              <XAxis 
                type="number" 
                tickLine={false} 
                axisLine={false} 
                tick={{ fontSize: 12, fill: "#888" }} 
                tickFormatter={(val) => `₹${(val / 10000000).toFixed(0)}Cr`}
              />
              <YAxis 
                dataKey="product" 
                type="category" 
                tickLine={false} 
                axisLine={false} 
                tick={{ fontSize: 11, fill: "#888" }} 
                width={120}
              />
              <Tooltip 
                content={<CustomTooltip />} 
                isAnimationActive={false} 
                cursor={{ fill: "rgba(150,150,150,0.05)" }}
                formatter={(value: number) => formatCompact(value)}
              />
              <Bar dataKey="annual" name="Sales" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={16}>
                {topProducts.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={CHART_COLOR_LIST[index % CHART_COLOR_LIST.length]} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base font-semibold">All Products</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 text-left font-medium">Product Group</th>
                  <th className="px-5 py-3 text-left font-medium">Product</th>
                  <th className="px-5 py-3 text-right font-medium">Annual Sales</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {data.fy2425.products.map((prod, i) => (
                  <tr key={i} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3 text-muted-foreground">{prod.group}</td>
                    <td className="px-5 py-3 font-medium">{prod.product}</td>
                    <td className="px-5 py-3 text-right font-semibold">{formatCompact(prod.annual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
