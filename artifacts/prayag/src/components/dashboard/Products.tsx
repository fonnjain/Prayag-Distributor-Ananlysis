import { trunc2 } from "@/lib/trunc";
// Products — per-product primary sales from sale_line for the selected FY,
// with the shared State Head / State / Distributor filter bar and an Excel
// export. The page is FY_ONLY: it honours the global FY selector but has no
// sub-year period dimension.
import { useState, useEffect, useMemo } from "react";
import { formatCompact, CHART_COLOR_LIST } from "@/data/dataset";
import { useGlobalFilter } from "@/data/global-filter-context";
import { usePeriodMonths } from "@/data/period-months";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Download } from "lucide-react";
import { CustomTooltip } from "./shared";
import {
  CompanyReportFilterBar,
  EMPTY_ENTITY_FILTER,
  entityFilterQuery,
  hasEntityFilter,
  type EntityFilterValue,
} from "./CompanyReportFilters";

type ProductRow = {
  code: string;
  product: string;
  group: string;
  qty: number;
  unit: string;
  amount: number;
};

type Payload = {
  fy: string;
  filtered: boolean;
  total: number;
  products: ProductRow[];
};

export default function Products() {
  const { fy } = useGlobalFilter();
  const period = usePeriodMonths();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState<EntityFilterValue>(EMPTY_ENTITY_FILTER);

  const query = useMemo(
    () => `?fy=${encodeURIComponent(fy)}${period.param}${entityFilterQuery(entityFilter)}`,
    [fy, period.param, entityFilter],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/product-reports${query}`)
      .then((r) => {
        if (!r.ok) return r.json().then((e: { error?: string }) => { throw new Error(e.error ?? r.statusText); });
        return r.json() as Promise<Payload>;
      })
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((err: Error) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [query]);

  const topProducts = useMemo(
    () => (data ? data.products.slice(0, 15).map((p) => ({ ...p, annual: p.amount })) : []),
    [data],
  );

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Filters + export */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CompanyReportFilterBar fy={fy} value={entityFilter} onChange={setEntityFilter} />
        <a
          href={`/api/product-reports/export${query}`}
          download
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
          data-testid="button-export-excel-products"
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

      {loading && !data && <div className="py-12 text-center text-sm text-muted-foreground">Loading product data...</div>}
      {error && <div className="py-6 text-center text-sm text-destructive">{error}</div>}

      {data && (
        <>
          <Card>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base font-semibold">Top 15 Products by FY {data.fy} Sales</CardTitle>
            </CardHeader>
            <CardContent className="px-2 sm:px-5 pb-5 pt-2">
              {topProducts.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">No data for this selection.</p>
              ) : (
                <ResponsiveContainer width="100%" height={400} debounce={0}>
                  <BarChart data={topProducts} layout="vertical" margin={{ top: 5, right: 30, left: 100, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="rgba(150,150,150,0.1)" />
                    <XAxis
                      type="number"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 12, fill: "#888" }}
                      tickFormatter={(val) => `₹${trunc2((val / 10000000))}Cr`}
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
                      {topProducts.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={CHART_COLOR_LIST[index % CHART_COLOR_LIST.length]} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base font-semibold">All Products</CardTitle>
              <p className="text-[11px] text-muted-foreground font-normal">
                Quantity is per product only — never sum it across products (litres vs pieces).
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-5 py-3 text-left font-medium">Product Group</th>
                      <th className="px-5 py-3 text-left font-medium">Product</th>
                      <th className="px-5 py-3 text-right font-medium">Qty</th>
                      <th className="px-5 py-3 text-right font-medium">Sales</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.products.map((prod, i) => (
                      <tr key={i} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3 text-muted-foreground">{prod.group}</td>
                        <td className="px-5 py-3 font-medium">{prod.product}</td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          {prod.qty.toLocaleString("en-IN")}{prod.unit ? ` ${prod.unit}` : ""}
                        </td>
                        <td className="px-5 py-3 text-right font-semibold">{formatCompact(prod.amount)}</td>
                      </tr>
                    ))}
                    {data.products.length === 0 && (
                      <tr><td colSpan={4} className="px-5 py-6 text-center text-xs text-muted-foreground">No products match this selection.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
