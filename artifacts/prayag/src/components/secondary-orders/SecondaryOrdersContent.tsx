import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useSecondaryOrders, useSecondaryOrderRetailers } from "@/hooks/use-secondary-orders";
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
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);
  const [retailerSearch, setRetailerSearch] = useState("");
  const [debouncedRetailerSearch, setDebouncedRetailerSearch] = useState("");
  const pageSize = 50;
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedRetailerSearch(retailerSearch), 300);
    return () => window.clearTimeout(timer);
  }, [retailerSearch]);
  const { data: retailerResults } = useSecondaryOrderRetailers(debouncedRetailerSearch);

  const { data, isLoading, isError, error, isFetching } = useSecondaryOrders({
    ...filters,
    cursor,
    pageSize,
  });

  const handleFilterChange = (key: keyof typeof filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setCursor(undefined);
    setCursorHistory([]);
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
    setCursor(undefined);
    setCursorHistory([]);
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
  const text = (value: string | null | undefined) => value == null || value === "" ? "—" : value;
  const number = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("en-IN");
  const amount = (value: number | null | undefined) => value == null ? "—" : `₹${trunc2IN(value)}`;
  const summaryAmount = (value: number | null | undefined) => {
    if (value == null) return "—";
    const absolute = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    const compact = (n: number) => n.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (absolute >= 1e7) return `${sign}₹${compact(absolute / 1e7)} Cr`;
    if (absolute >= 1e5) return `${sign}₹${compact(absolute / 1e5)} L`;
    return `${sign}₹${Math.round(absolute).toLocaleString("en-IN")}`;
  };
  const fiscalYearLabel = (fiscalYear: string) =>
    fiscalYear === "2025-26"
      ? "FY 2025–26"
      : fiscalYear === "2026-27"
        ? "FY 2026–27 (to date)"
        : fiscalYear;

  const renderFiscalYearSummary = (fy: NonNullable<typeof data>["fiscalYearSummaries"][number]) => (
    <section key={fy.fiscalYear} className="rounded-lg border bg-muted/10 p-3 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{fiscalYearLabel(fy.fiscalYear)}</h2>
        <span className="text-xs text-muted-foreground">
          {fy.coverage.from ? formatShortDate(fy.coverage.from) : "Start"} –{" "}
          {fy.coverage.to ? formatShortDate(fy.coverage.to) : "To date"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
        <div className="min-w-0 rounded-lg border bg-card p-3 shadow-sm" title={`Orders: ${fy.orders.toLocaleString("en-IN")}`}>
          <div className="text-xs font-medium text-muted-foreground">Orders</div>
          <div className="mt-1 whitespace-nowrap text-xl font-bold tabular-nums">{fy.orders.toLocaleString("en-IN")}</div>
        </div>
        <div className="min-w-0 rounded-lg border bg-card p-3 shadow-sm" title={`Lines: ${fy.lines.toLocaleString("en-IN")}`}>
          <div className="text-xs font-medium text-muted-foreground">Lines</div>
          <div className="mt-1 whitespace-nowrap text-xl font-bold tabular-nums">{fy.lines.toLocaleString("en-IN")}</div>
        </div>
        <div className="min-w-0 rounded-lg border bg-card p-3 shadow-sm" title={`Retailers: ${fy.retailers.toLocaleString("en-IN")}`}>
          <div className="text-xs font-medium text-muted-foreground">Retailers</div>
          <div className="mt-1 whitespace-nowrap text-xl font-bold tabular-nums">{fy.retailers.toLocaleString("en-IN")}</div>
        </div>
        <div className="min-w-0 rounded-lg border bg-card p-3 shadow-sm" title={`Distributors: ${fy.distributors.toLocaleString("en-IN")}`}>
          <div className="text-xs font-medium text-muted-foreground">Distributors (names)</div>
          <div className="mt-1 whitespace-nowrap text-xl font-bold tabular-nums">{fy.distributors.toLocaleString("en-IN")}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">{fy.distributorNote}</div>
        </div>
        <div className="min-w-0 rounded-lg border bg-card p-3 shadow-sm" title={`Total Qty: ${fy.totalQty.toLocaleString("en-IN")}`}>
          <div className="text-xs font-medium text-muted-foreground">Total Qty</div>
          <div className="mt-1 whitespace-nowrap text-xl font-bold tabular-nums">{fy.totalQty.toLocaleString("en-IN")}</div>
        </div>
        <div className="min-w-0 rounded-lg border bg-blue-50/50 p-3 shadow-sm" title={`Basic order value: ${amount(fy.totalBasicValue)}`}>
          <div className="text-xs font-medium text-blue-800">Basic order value (ex-GST)</div>
          <div className="mt-1 whitespace-nowrap text-xl font-bold tabular-nums text-blue-900">{summaryAmount(fy.totalBasicValue)}</div>
        </div>
      </div>
      {fy.status.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {fy.status.map((st) => (
            <div key={st.status} className="flex-shrink-0 inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs">
              <span className="font-semibold text-foreground">{st.status}</span>
              <span className="text-muted-foreground">
                {st.orders.toLocaleString("en-IN")} orders -{" "}
                <span title={`Exact value: ${amount(st.basicValue)}`}>{summaryAmount(st.basicValue)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );

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
                    {s === "UNAVAILABLE" ? "Status unavailable" : s}
                  </option>
                ))}
              </select>
              {filters.status && (
                <p className="text-xs text-amber-700">
                  {filters.status === "UNAVAILABLE"
                    ? "Shows legacy rows whose source status is unavailable."
                    : "APPROVED/PENDING applies only to rows with that recorded status; legacy rows remain Status unavailable."}
                </p>
              )}
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
              <input
                type="search"
                list="secondary-order-retailers"
                value={retailerSearch}
                onChange={(e) => setRetailerSearch(e.target.value)}
                onBlur={() => {
                  const match = retailerResults?.retailers.find((r) => r.dealerId === retailerSearch || `${r.customerName ?? ""} (${r.dealerId})` === retailerSearch);
                  handleFilterChange("dealerId", match?.dealerId ?? retailerSearch);
                }}
                placeholder="Search retailer / ID"
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <datalist id="secondary-order-retailers">
                {retailerResults?.retailers.map((r) => <option key={r.dealerId} value={`${r.customerName ?? "Unavailable"} (${r.dealerId})`} />)}
              </datalist>
            </div>
          </div>
        </aside>

        {/* Data Area */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative bg-muted/10">
          {/* Summary Cards */}
          {data && (
            <div className="flex-shrink-0 p-4 border-b bg-card space-y-4">
               <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{data.basis.mixedEraNote}</p>
              <div className="space-y-4">
                {data.fiscalYearSummaries.map(renderFiscalYearSummary)}
              </div>

              {data.quality.exactDuplicateExportRows > 0 && (
                <p className="text-xs text-muted-foreground">
                  {data.quality.exactDuplicateExportRows} exact duplicate export rows retained
                  {" "}({data.quality.exactDuplicateQty.toLocaleString("en-IN")} qty;{" "}
                  <span title={`Exact value: ${amount(data.quality.exactDuplicateBasicValue)}`}>
                    {summaryAmount(data.quality.exactDuplicateBasicValue)}
                  </span>{" "}basic value);
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
                        <th className="px-4 py-3 font-medium">Source / Period</th>
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
                           <td className="px-4 py-2 font-mono text-xs text-foreground">{text(row.orderId)}</td>
                           <td className="px-4 py-2 text-xs">
                             <div>{text(row.sourceEra)}{row.sourceKind ? ` · ${row.sourceKind}` : ""}</div>
                             <div className="text-muted-foreground">{text(row.fiscalYear)} · {text(row.periodCompleteness)}</div>
                           </td>
                          <td className="px-4 py-2 text-muted-foreground">{formatDate(row.orderDatetime)}</td>
                          <td className="px-4 py-2">
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide
                              ${row.orderStatus.toLowerCase() === 'confirmed' ? 'bg-green-100 text-green-800' :
                                row.orderStatus.toLowerCase() === 'cancelled' ? 'bg-red-100 text-red-800' :
                                'bg-gray-100 text-gray-800'}`}>
                              {row.orderStatus}
                            </span>
                          </td>
                           <td className="px-4 py-2">{text(row.salesUserName)}</td>
                          <td className="px-4 py-2">
                             <div className="font-medium text-foreground">{text(row.customerName)}</div>
                            {row.dealerMobile && <div className="text-xs text-muted-foreground">{row.dealerMobile}</div>}
                          </td>
                          <td className="px-4 py-2">
                             <div className="text-foreground">{text(row.cpName)}</div>
                             <div className="text-[10px] font-mono text-muted-foreground">{text(row.cpCode)}</div>
                          </td>
                          <td className="px-4 py-2">
                             <div>{text(row.district)}</div>
                             <div className="text-xs text-muted-foreground">{text(row.state)}</div>
                          </td>
                          <td className="px-4 py-2">
                             <div>{text(row.categoryName)}</div>
                             <div className="text-xs text-muted-foreground">{text(row.segmentCanon)}</div>
                          </td>
                           <td className="px-4 py-2 font-mono text-xs">{text(row.productCode)}</td>
                           <td className="px-4 py-2 text-right font-medium">{number(row.qty)}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground">
                             {row.discountPct == null ? "—" : `${row.discountPct}%`}
                          </td>
                           <td className="px-4 py-2 text-right text-muted-foreground">{row.gstPct == null ? "—" : `${row.gstPct}%`}</td>
                           <td className="px-4 py-2 text-right font-medium bg-blue-50/10 text-blue-900">{amount(row.basicOrderValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                 {data && (cursorHistory.length > 0 || data.pagination.hasMore) && (
                  <div className="border-t bg-muted/20 px-4 py-3 flex items-center justify-between text-sm">
                    <div className="text-muted-foreground">
                       Showing cursor page ({data.pagination.totalRows} matching rows)
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                         onClick={() => { const prior = cursorHistory[cursorHistory.length - 1]; setCursorHistory(h => h.slice(0, -1)); setCursor(prior); }}
                         disabled={cursorHistory.length === 0}
                        className="px-3 py-1 rounded border bg-background hover:bg-muted disabled:opacity-50 transition-colors"
                      >
                        Previous
                      </button>
                      <button
                         onClick={() => { setCursorHistory(h => [...h, cursor]); setCursor(data.pagination.nextCursor ?? undefined); }}
                         disabled={!data.pagination.hasMore}
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
