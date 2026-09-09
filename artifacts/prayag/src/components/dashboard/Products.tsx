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
import { Download, Loader2 } from "lucide-react";
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
  master: string;
  subcategory: string | null;
  qty: number;
  unit: string;
  amount: number;
};

type MrpConflict = {
  code: string;
  feature: string;
  product: string;
  options: { segment: string; mrp: number | null }[];
};

type UnmappedSegment = { segment: string; codes: number };

type RegisterGap = {
  totalUnresolved: number;
  totalCodes: number;
  prefixes: { prefix: string; codes: number }[];
};

type ProductDataQuality = {
  mrpConflicts: MrpConflict[];
  unmappedSegments: UnmappedSegment[];
  unmappedCodeTotal: number;
  registerGap: RegisterGap;
};

type MasterTab = {
  master: string;
  rows: number;
  distinctCodes: number;
  value: number;
};

type SubcategoryTab = {
  master: string;
  subcategory: string;
  rows: number;
  distinctCodes: number;
  value: number;
};

type AllocationProof = {
  allValue: number;
  masterValueSum: number;
  delta: number;
  allRows: number;
  masterRowsSum: number;
  uncoveredRows: number;
  overlappingRows: number;
  exact: boolean;
};

type Payload = {
  fy: string;
  filtered: boolean;
  total: number;
  selectedMaster: string;
  selectedSubcategory: string | null;
  masterTabs: MasterTab[];
  subcategoryTabs: SubcategoryTab[];
  allocationProof: AllocationProof;
  mappingSplit?: unknown;
  products: ProductRow[];
  dataQuality?: ProductDataQuality;
};

const MASTER_TABS = ["All", "PLUMBING", "PTMT", "C P", "SANITARYWARE", "SINK", "HARDWARE"];

export default function Products() {
  const { fy } = useGlobalFilter();
  const period = usePeriodMonths();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entityFilter, setEntityFilter] = useState<EntityFilterValue>(EMPTY_ENTITY_FILTER);
  const [master, setMaster] = useState<string>("All");
  const [subcategory, setSubcategory] = useState<string | null>(null);

  const query = useMemo(
    () => `?fy=${encodeURIComponent(fy)}${period.param}${entityFilterQuery(entityFilter)}${
      master === "All" ? "" : `&master=${encodeURIComponent(master)}`
    }${subcategory ? `&subcategory=${encodeURIComponent(subcategory)}` : ""}`,
    [fy, period.param, entityFilter, master, subcategory],
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

  useEffect(() => {
    if (!data) return;
    if (master !== "All" && !data.masterTabs.some((tab) => tab.master === master)) {
      setMaster("All");
      setSubcategory(null);
    } else if (
      subcategory &&
      !data.subcategoryTabs.some((tab) => tab.master === master && tab.subcategory === subcategory)
    ) {
      setSubcategory(null);
    }
  }, [data, master, subcategory]);

  const currentMaster = data?.selectedMaster || master;
  const currentSubcategory = data?.selectedSubcategory || subcategory;
  const masterLabel = currentMaster === "All" ? "" : `${currentMaster} `;
  const selectedMasterSubcategories = data?.subcategoryTabs.filter((tab) => tab.master === master) ?? [];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Filters + export */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CompanyReportFilterBar fy={fy} value={entityFilter} onChange={setEntityFilter} />
        {loading || error ? (
          <span
            aria-disabled="true"
            className="flex cursor-not-allowed items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium opacity-50"
            data-testid="button-export-excel-products"
          >
            <Download className="h-3.5 w-3.5" />
            Export Excel
          </span>
        ) : (
          <a
            href={`/api/product-reports/export${query}`}
            download
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
            data-testid="button-export-excel-products"
          >
            <Download className="h-3.5 w-3.5" />
            Export Excel
          </a>
        )}
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
          {data.masterTabs && data.masterTabs.length > 0 && (
            <div className="space-y-2">
              <div
                className="flex w-full items-center gap-2 overflow-x-auto pb-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
                role="tablist"
                aria-label="Product masters"
              >
                {MASTER_TABS.map((tabName) => {
                  const isSelected = currentMaster === tabName;
                  return (
                    <button
                      key={tabName}
                      role="tab"
                      aria-selected={isSelected}
                      disabled={loading}
                      onClick={() => {
                        setMaster(tabName);
                        setSubcategory(null);
                      }}
                      className={`relative flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        isSelected
                          ? "bg-primary text-primary-foreground shadow"
                          : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                      } ${loading ? "opacity-60 cursor-not-allowed" : ""}`}
                    >
                      {loading && master === tabName && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      <span>{tabName}</span>
                    </button>
                  );
                })}
              </div>
              {master !== "All" && selectedMasterSubcategories.length > 0 && (
                <div
                  className="flex w-full items-center gap-2 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
                  role="tablist"
                  aria-label={`${master} subcategories`}
                >
                  <button
                    role="tab"
                    aria-selected={!subcategory}
                    disabled={loading}
                    onClick={() => setSubcategory(null)}
                    className={`whitespace-nowrap rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                      !subcategory ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted/60"
                    }`}
                  >
                    All
                  </button>
                  {selectedMasterSubcategories.map((tab) => (
                    <button
                      key={tab.subcategory}
                      role="tab"
                      aria-selected={currentSubcategory === tab.subcategory}
                      disabled={loading}
                      onClick={() => setSubcategory(tab.subcategory)}
                      className={`whitespace-nowrap rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                        currentSubcategory === tab.subcategory
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-muted/60"
                      }`}
                    >
                      {tab.subcategory}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <Card className={loading ? "opacity-60 pointer-events-none transition-opacity duration-300" : "transition-opacity duration-300"}>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base font-semibold">Top 15 {masterLabel}Products by FY {data.fy} Sales</CardTitle>
            </CardHeader>
            <CardContent className="px-2 sm:px-5 pb-5 pt-2">
              {topProducts.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">No data for this selection.</p>
              ) : (
                <ResponsiveContainer width="100%" height={460} debounce={0}>
                  <BarChart data={topProducts} layout="vertical" margin={{ top: 5, right: 30, left: 8, bottom: 5 }}>
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
                      width={190}
                      interval={0}
                      tick={({ x, y, payload }: { x: number; y: number; payload: { value: string } }) => {
                        const name = String(payload.value);
                        const label = name.length > 26 ? `${name.slice(0, 25).trimEnd()}…` : name;
                        return (
                          <text x={x} y={y} dy={4} textAnchor="end" fontSize={11} fill="#888">
                            {label}
                          </text>
                        );
                      }}
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

          {data.dataQuality && (
            <div className={`grid gap-4 md:grid-cols-3 ${loading ? "opacity-60 pointer-events-none transition-opacity duration-300" : "transition-opacity duration-300"}`}>
              {/* (a) Unresolved MRP conflicts */}
              <Card className="border-amber-300/60 dark:border-amber-500/40">
                <CardHeader className="px-5 pt-5 pb-2">
                  <CardTitle className="text-sm font-semibold text-amber-700 dark:text-amber-400">
                    Unresolved MRP conflicts
                  </CardTitle>
                  <p className="text-[11px] text-muted-foreground font-normal">
                    Same code + colour listed under two segments at different prices — loaded
                    under both, awaiting a business decision. Not picked silently.
                  </p>
                </CardHeader>
                <CardContent className="px-5 pb-5 pt-1 space-y-3">
                  {data.dataQuality.mrpConflicts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None.</p>
                  ) : (
                    data.dataQuality.mrpConflicts.map((c) => (
                      <div key={`${c.code}-${c.feature}`} className="text-xs">
                        <div className="font-medium">
                          {c.code}
                          {c.feature ? ` (${c.feature})` : ""}
                        </div>
                        <div className="text-muted-foreground">{c.product}</div>
                        <ul className="mt-0.5">
                          {c.options.map((o, i) => (
                            <li key={i} className="tabular-nums">
                              {o.segment} → ₹{o.mrp ?? "—"}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              {/* (b) Segment not yet mapped */}
              <Card className="border-border">
                <CardHeader className="px-5 pt-5 pb-2">
                  <CardTitle className="text-sm font-semibold">Segment not yet mapped</CardTitle>
                  <p className="text-[11px] text-muted-foreground font-normal">
                    {data.dataQuality.unmappedCodeTotal.toLocaleString("en-IN")} codes across
                    these marketing segments have no canonical mapping yet — a segment is not
                    guessed for them.
                  </p>
                </CardHeader>
                <CardContent className="px-5 pb-5 pt-1">
                  {data.dataQuality.unmappedSegments.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None.</p>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {data.dataQuality.unmappedSegments.map((s) => (
                        <li key={s.segment} className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground">{s.segment}</span>
                          <span className="tabular-nums font-medium">
                            {s.codes.toLocaleString("en-IN")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              {/* (c) Register-code gap */}
              <Card className="border-border">
                <CardHeader className="px-5 pt-5 pb-2">
                  <CardTitle className="text-sm font-semibold">Register codes not in master</CardTitle>
                  <p className="text-[11px] text-muted-foreground font-normal">
                    {data.dataQuality.registerGap.totalUnresolved.toLocaleString("en-IN")} of{" "}
                    {data.dataQuality.registerGap.totalCodes.toLocaleString("en-IN")} FY {data.fy}{" "}
                    register codes fail to resolve to any product code (exact-first resolver).
                    Top prefixes below size the catalogue gap.
                  </p>
                </CardHeader>
                <CardContent className="px-5 pb-5 pt-1">
                  {data.dataQuality.registerGap.prefixes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      All register codes resolve.
                    </p>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {data.dataQuality.registerGap.prefixes.map((p) => (
                        <li key={p.prefix} className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground font-mono">{p.prefix}</span>
                          <span className="tabular-nums font-medium">
                            {p.codes.toLocaleString("en-IN")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          <Card className={loading ? "opacity-60 pointer-events-none transition-opacity duration-300" : "transition-opacity duration-300"}>
            <CardHeader className="px-5 pt-5 pb-2">
              <CardTitle className="text-base font-semibold">All {masterLabel}Products</CardTitle>
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
                      <th className="px-5 py-3 text-left font-medium">Master</th>
                      <th className="px-5 py-3 text-left font-medium">Subcategory</th>
                      <th className="px-5 py-3 text-left font-medium">Product</th>
                      <th className="px-5 py-3 text-right font-medium">Qty</th>
                      <th className="px-5 py-3 text-right font-medium">Sales</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.products.map((prod, i) => (
                      <tr key={i} className="hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3 text-muted-foreground">{prod.group}</td>
                        <td className="px-5 py-3 text-muted-foreground">{prod.master}</td>
                        <td className="px-5 py-3 text-muted-foreground">{prod.subcategory || "—"}</td>
                        <td className="px-5 py-3 font-medium">{prod.product}</td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          {prod.qty.toLocaleString("en-IN")}{prod.unit ? ` ${prod.unit}` : ""}
                        </td>
                        <td className="px-5 py-3 text-right font-semibold">{formatCompact(prod.amount)}</td>
                      </tr>
                    ))}
                    {data.products.length === 0 && (
                      <tr><td colSpan={6} className="px-5 py-6 text-center text-xs text-muted-foreground">No products match this selection.</td></tr>
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
