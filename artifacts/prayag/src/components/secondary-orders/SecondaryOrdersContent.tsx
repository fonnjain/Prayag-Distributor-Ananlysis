import React, { useState, useCallback, useMemo } from "react";
import { useSecondaryOrders } from "@/hooks/use-secondary-orders";
import { trunc2IN } from "@/lib/trunc";
import { Download, FilterX, Loader2, AlertCircle, ShoppingCart } from "lucide-react";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SecondaryOrdersContent() {
  const [filters, setFilters] = useState({
    stateHead: "",
    state: "",
    cpCode: "",
    dealerId: "",
    status: "",
    from: "",
    to: "",
  });
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const { data, isLoading, isError, error, isFetching } = useSecondaryOrders({
    ...filters,
    page,
    pageSize,
  });

  const handleFilterChange = (key: keyof typeof filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const handleClearFilters = () => {
    setFilters({
      stateHead: "",
      state: "",
      cpCode: "",
      dealerId: "",
      status: "",
      from: "",
      to: "",
    });
    setPage(1);
  };

  const handleExport = () => {
    const search = new URLSearchParams();
    if (filters.stateHead) search.set("stateHead", filters.stateHead);
    if (filters.state) search.set("state", filters.state);
    if (filters.cpCode) search.set("cpCode", filters.cpCode);
    if (filters.dealerId) search.set("dealerId", filters.dealerId);
    if (filters.status) search.set("status", filters.status);
    if (filters.from) search.set("from", filters.from);
    if (filters.to) search.set("to", filters.to);

    window.location.href = `${BASE}/api/secondary-orders/export?${search.toString()}`;
  };

  const formatDate = (isoStr: string) => {
    try {
      return format(new Date(isoStr), "dd MMM yyyy, HH:mm");
    } catch {
      return isoStr;
    }
  };

  const formatShortDate = (isoStr: string) => {
    try {
      return format(new Date(isoStr), "dd MMM yyyy");
    } catch {
      return isoStr;
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header */}
      <header className="flex-shrink-0 border-b bg-card px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold tracking-tight text-foreground flex items-center gap-2">
                <ShoppingCart className="h-5 w-5 text-primary" />
                Secondary Orders
              </h1>
              <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 border border-amber-200">
                Order booking, not dispatch. Not comparable with secondary sales figures.
              </span>
            </div>
          </div>
          <button
            onClick={handleExport}
            disabled={!data || data.rows.length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50 transition-colors"
          >
            <Download className="h-4 w-4" />
            Export XLSX
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col md:flex-row overflow-hidden">
        {/* Sidebar Filters */}
        <aside className="w-full md:w-72 flex-shrink-0 border-b md:border-b-0 md:border-r bg-muted/20 overflow-y-auto p-4 space-y-6 max-h-64 md:max-h-none">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">Filters</h2>
            <button
              onClick={handleClearFilters}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <FilterX className="h-3 w-3" /> Clear
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4 md:flex md:flex-col md:gap-4 md:space-y-0">
            {/* Dates */}
            <div className="space-y-2">
              <label className="text-xs font-medium">From Date</label>
              <input
                type="date"
                value={filters.from}
                onChange={(e) => handleFilterChange("from", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium">To Date</label>
              <input
                type="date"
                value={filters.to}
                onChange={(e) => handleFilterChange("to", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {/* API Driven Filters (Disabled if no data yet to get filter options, but we can use them if data exists) */}
            <div className="space-y-2">
              <label className="text-xs font-medium">Status</label>
              <select
                value={filters.status}
                onChange={(e) => handleFilterChange("status", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">All Statuses</option>
                {data?.filters.statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium">State Head</label>
              <select
                value={filters.stateHead}
                onChange={(e) => handleFilterChange("stateHead", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">All State Heads</option>
                {data?.filters.stateHeads.map((sh) => (
                  <option key={sh.id} value={sh.id}>
                    {sh.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium">State</label>
              <select
                value={filters.state}
                onChange={(e) => handleFilterChange("state", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">All States</option>
                {data?.filters.states.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium">Distributor</label>
              <select
                value={filters.cpCode}
                onChange={(e) => handleFilterChange("cpCode", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">All Distributors</option>
                {data?.filters.distributors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium">Retailer</label>
              <select
                value={filters.dealerId}
                onChange={(e) => handleFilterChange("dealerId", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">All Retailers</option>
                {data?.filters.retailers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </aside>

        {/* Data Area */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative bg-muted/10">
          {/* Summary Cards */}
          {data && (
            <div className="flex-shrink-0 p-4 border-b bg-card space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
                <div className="rounded-lg border bg-card p-3 shadow-sm">
                  <div className="text-xs font-medium text-muted-foreground">Orders</div>
                  <div className="mt-1 text-xl font-bold">{data.summary.orders.toLocaleString('en-IN')}</div>
                </div>
                <div className="rounded-lg border bg-card p-3 shadow-sm">
                  <div className="text-xs font-medium text-muted-foreground">Lines</div>
                  <div className="mt-1 text-xl font-bold">{data.summary.lines.toLocaleString('en-IN')}</div>
                </div>
                <div className="rounded-lg border bg-card p-3 shadow-sm">
                  <div className="text-xs font-medium text-muted-foreground">Retailers</div>
                  <div className="mt-1 text-xl font-bold">{data.summary.retailers.toLocaleString('en-IN')}</div>
                </div>
                <div className="rounded-lg border bg-card p-3 shadow-sm">
                  <div className="text-xs font-medium text-muted-foreground">Distributors</div>
                  <div className="mt-1 text-xl font-bold">{data.summary.distributors.toLocaleString('en-IN')}</div>
                </div>
                <div className="rounded-lg border bg-card p-3 shadow-sm">
                  <div className="text-xs font-medium text-muted-foreground">Total Qty</div>
                  <div className="mt-1 text-xl font-bold">{data.summary.totalQty.toLocaleString('en-IN')}</div>
                </div>
                <div className="rounded-lg border bg-blue-50/50 p-3 shadow-sm md:col-span-2 lg:col-span-2">
                  <div className="text-xs font-medium text-blue-800">Basic order value (ex-GST)</div>
                  <div className="mt-1 text-xl font-bold text-blue-900">₹{trunc2IN(data.summary.totalBasicValue)}</div>
                  {(data.coverage.from || data.coverage.to) && (
                    <div className="mt-1 text-[10px] text-blue-700">
                      {data.coverage.from ? formatShortDate(data.coverage.from) : "Start"} – {data.coverage.to ? formatShortDate(data.coverage.to) : "End"}
                    </div>
                  )}
                </div>
              </div>

              {data.summary.status.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {data.summary.status.map(st => (
                    <div key={st.status} className="flex-shrink-0 inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs">
                      <span className="font-semibold text-foreground">{st.status}</span>
                      <span className="text-muted-foreground">{st.orders} orders (₹{trunc2IN(st.basicValue)})</span>
                    </div>
                  ))}
                </div>
              )}

              {data.quality.exactDuplicateExportRows > 0 && (
                <p className="text-xs text-muted-foreground">
                  {data.quality.exactDuplicateExportRows} exact duplicate export rows retained
                  {" "}({data.quality.exactDuplicateQty.toLocaleString("en-IN")} qty; ₹{trunc2IN(data.quality.exactDuplicateBasicValue)} basic value);
                  totals match the source file.
                  {data.quality.exactDuplicateRateAlert && " Duplicate-row rate exceeds the 0.5% review threshold."}
                </p>
              )}
            </div>
          )}

          {/* Table Area */}
          <div className="flex-1 overflow-auto p-4 relative">
            {isLoading && !data ? (
              <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm z-10">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
            ) : isError ? (
              <div className="flex h-full flex-col items-center justify-center text-destructive">
                <AlertCircle className="h-10 w-10 mb-4" />
                <h3 className="text-lg font-semibold">Failed to load data</h3>
                <p className="text-sm opacity-80">{error instanceof Error ? error.message : "Unknown error"}</p>
              </div>
            ) : data?.rows.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
                <ShoppingCart className="h-12 w-12 mb-4 opacity-20" />
                <h3 className="text-lg font-semibold">No orders found</h3>
                <p className="text-sm">Try adjusting your filters to see more results.</p>
              </div>
            ) : (
              <div className="rounded-lg border bg-card shadow-sm overflow-hidden flex flex-col h-full">
                <div className="overflow-auto flex-1 relative">
                  <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead className="bg-muted/50 text-muted-foreground sticky top-0 z-10 shadow-sm">
                      <tr>
                        <th className="px-4 py-3 font-medium">Order ID</th>
                        <th className="px-4 py-3 font-medium">Date & Time</th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Sales User</th>
                        <th className="px-4 py-3 font-medium">Retailer</th>
                        <th className="px-4 py-3 font-medium">Distributor</th>
                        <th className="px-4 py-3 font-medium">State / District</th>
                        <th className="px-4 py-3 font-medium">Segment</th>
                        <th className="px-4 py-3 font-medium">Item Code</th>
                        <th className="px-4 py-3 font-medium text-right">Qty</th>
                        <th className="px-4 py-3 font-medium text-right">Discount</th>
                        <th className="px-4 py-3 font-medium text-right">GST %</th>
                        <th className="px-4 py-3 font-medium text-right bg-blue-50/30 text-blue-800">Basic order value (ex-GST)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data?.rows.map((row, i) => (
                        <tr key={`${row.orderId}-${i}`} className="hover:bg-muted/30 transition-colors">
                          <td className="px-4 py-2 font-mono text-xs text-foreground">{row.orderId}</td>
                          <td className="px-4 py-2 text-muted-foreground">{formatDate(row.orderDatetime)}</td>
                          <td className="px-4 py-2">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide
                              ${row.orderStatus.toLowerCase() === 'confirmed' ? 'bg-green-100 text-green-800' :
                                row.orderStatus.toLowerCase() === 'cancelled' ? 'bg-red-100 text-red-800' :
                                'bg-gray-100 text-gray-800'}`}>
                              {row.orderStatus}
                            </span>
                          </td>
                          <td className="px-4 py-2">{row.salesUserName}</td>
                          <td className="px-4 py-2">
                            <div className="font-medium text-foreground">{row.customerName}</div>
                            {row.dealerMobile && <div className="text-xs text-muted-foreground">{row.dealerMobile}</div>}
                          </td>
                          <td className="px-4 py-2">
                            <div className="text-foreground">{row.cpName}</div>
                            <div className="text-[10px] font-mono text-muted-foreground">{row.cpCode}</div>
                          </td>
                          <td className="px-4 py-2">
                            <div>{row.district}</div>
                            <div className="text-xs text-muted-foreground">{row.state}</div>
                          </td>
                          <td className="px-4 py-2">
                            <div>{row.categoryName}</div>
                            <div className="text-xs text-muted-foreground">{row.segmentCanon}</div>
                          </td>
                          <td className="px-4 py-2 font-mono text-xs">{row.productCode}</td>
                          <td className="px-4 py-2 text-right font-medium">{row.qty.toLocaleString("en-IN")}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground">
                            {row.discountPct > 0 ? `${row.discountPct}%` : '-'}
                          </td>
                          <td className="px-4 py-2 text-right text-muted-foreground">{row.gstPct}%</td>
                          <td className="px-4 py-2 text-right font-medium bg-blue-50/10 text-blue-900">₹{trunc2IN(row.basicOrderValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {data && data.pagination.totalPages > 1 && (
                  <div className="border-t bg-muted/20 px-4 py-3 flex items-center justify-between text-sm">
                    <div className="text-muted-foreground">
                      Showing page <span className="font-medium text-foreground">{data.pagination.page}</span> of <span className="font-medium text-foreground">{data.pagination.totalPages}</span>
                      {' '} ({data.pagination.totalRows} total rows)
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1}
                        className="px-3 py-1 rounded border bg-background hover:bg-muted disabled:opacity-50 transition-colors"
                      >
                        Previous
                      </button>
                      <button
                        onClick={() => setPage(p => Math.min(data.pagination.totalPages, p + 1))}
                        disabled={page === data.pagination.totalPages}
                        className="px-3 py-1 rounded border bg-background hover:bg-muted disabled:opacity-50 transition-colors"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            
            {/* Updating overlay */}
            {isFetching && data && (
              <div className="absolute top-4 right-4 bg-primary/90 text-primary-foreground text-xs px-3 py-1.5 rounded-full shadow-lg flex items-center gap-2 animate-in fade-in z-20">
                <Loader2 className="h-3 w-3 animate-spin" />
                Updating...
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
