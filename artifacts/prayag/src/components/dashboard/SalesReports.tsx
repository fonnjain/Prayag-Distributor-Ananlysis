// Per-salesperson report view and Excel download.
//
// Calls GET /api/salespeople/:key/reports independently (no dive prop needed).
// Secondary tab: breakdowns by state/group/segment + parties + movers.
// Primary tab:   bridged/unbridged party tables from SAP dispatch register.
// Monthly:       12-row booking + sale table from the team rollup.
import { useState } from "react";
import { Download, Loader2, FileSpreadsheet, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  useGetSalesPersonReports,
  getGetSalesPersonReportsQueryKey,
  type DeepRow,
  type PrimaryParty,
  type SalesRepReport,
} from "@workspace/api-client-react";

function formatCr(rupees: number): string {
  return `${(rupees / 1e7).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} Cr`;
}

function formatInt(n: number): string {
  return n.toLocaleString("en-IN");
}

function GrowthCell({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-muted-foreground">-</span>;
  return (
    <span className={cn("tabular-nums", pct >= 0 ? "text-green-600 dark:text-green-400" : "text-destructive")}>
      {pct >= 0 ? "+" : ""}
      {pct}%
    </span>
  );
}

function ReportTable({
  title,
  rows,
  showFlag,
  limit = 20,
}: {
  title: string;
  rows: DeepRow[];
  showFlag?: boolean;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayRows = expanded ? rows : rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground px-6 pb-4">No data for this selection.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border/40 bg-muted/30">
                    <th className="text-left font-medium py-2 px-4">Name</th>
                    <th className="text-right font-medium py-2 px-3">This FY</th>
                    <th className="text-right font-medium py-2 px-3">Last FY</th>
                    <th className="text-right font-medium py-2 px-3">Difference</th>
                    <th className="text-right font-medium py-2 px-3">Growth</th>
                    <th className="text-right font-medium py-2 px-3">Share</th>
                    {showFlag && <th className="text-right font-medium py-2 px-4">Status</th>}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((r, i) => (
                    <tr
                      key={`${r.label}-${i}`}
                      className="border-b border-border/20 last:border-0 hover:bg-muted/20"
                    >
                      <td className="py-1.5 px-4 max-w-[160px] truncate">{r.label}</td>
                      <td className="text-right tabular-nums py-1.5 px-3">{formatCr(r.thisFy)}</td>
                      <td className="text-right tabular-nums py-1.5 px-3 text-muted-foreground">
                        {formatCr(r.lastFy)}
                      </td>
                      <td
                        className={cn(
                          "text-right tabular-nums py-1.5 px-3",
                          r.diff > 0 && "text-green-600 dark:text-green-400",
                          r.diff < 0 && "text-destructive",
                          r.diff === 0 && "text-muted-foreground",
                        )}
                      >
                        {r.diff > 0 ? "+" : ""}
                        {formatCr(r.diff)}
                      </td>
                      <td className="text-right py-1.5 px-3">
                        <GrowthCell pct={r.growthPct} />
                      </td>
                      <td className="text-right tabular-nums py-1.5 px-3 text-muted-foreground">
                        {r.sharePct == null ? "-" : `${r.sharePct}%`}
                      </td>
                      {showFlag && (
                        <td className="text-right py-1.5 px-4">
                          {r.flag && (
                            <span
                              className={cn(
                                "px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide",
                                r.flag === "new" && "bg-green-500/15 text-green-600 dark:text-green-400",
                                r.flag === "churned" && "bg-destructive/15 text-destructive",
                                r.flag === "old" && "bg-muted text-muted-foreground",
                              )}
                            >
                              {r.flag}
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                {displayRows.length > 0 && (
                  <tfoot>
                    <tr className="border-t border-border/40 bg-muted/30 font-medium">
                      <td className="py-1.5 px-4">Total</td>
                      <td className="text-right tabular-nums py-1.5 px-3">
                        {formatCr(rows.reduce((a, r) => a + r.thisFy, 0))}
                      </td>
                      <td className="text-right tabular-nums py-1.5 px-3 text-muted-foreground">
                        {formatCr(rows.reduce((a, r) => a + r.lastFy, 0))}
                      </td>
                      <td className="py-1.5 px-3" />
                      <td className="py-1.5 px-3" />
                      <td className="py-1.5 px-3" />
                      {showFlag && <td className="py-1.5 px-4" />}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {hasMore && !expanded && (
              <button
                className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border/30"
                onClick={() => setExpanded(true)}
              >
                Show all {rows.length} rows
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MoverPairCard({
  upTitle,
  downTitle,
  upRows,
  downRows,
}: {
  upTitle: string;
  downTitle: string;
  upRows: DeepRow[];
  downRows: DeepRow[];
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">{upTitle}</p>
            {upRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">None</p>
            ) : (
              <ul className="space-y-1">
                {upRows.map((r, i) => (
                  <li key={`up-${i}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">{r.label}</span>
                    <span className="tabular-nums shrink-0 text-green-600 dark:text-green-400">
                      +{formatCr(r.diff)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">{downTitle}</p>
            {downRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">None</p>
            ) : (
              <ul className="space-y-1">
                {downRows.map((r, i) => (
                  <li key={`down-${i}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">{r.label}</span>
                    <span className="tabular-nums shrink-0 text-destructive">
                      {formatCr(r.diff)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PrimaryPartyTable({
  title,
  parties,
  limit = 25,
}: {
  title: string;
  parties: PrimaryParty[];
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayRows = expanded ? parties : parties.slice(0, limit);
  const hasMore = parties.length > limit;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {parties.length === 0 ? (
          <p className="text-sm text-muted-foreground px-6 pb-4">None</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b border-border/40 bg-muted/30">
                    <th className="text-left font-medium py-2 px-4">Party</th>
                    <th className="text-right font-medium py-2 px-4">Dispatched Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((p, i) => (
                    <tr
                      key={`${p.party}-${i}`}
                      className="border-b border-border/20 last:border-0 hover:bg-muted/20"
                    >
                      <td className="py-1.5 px-4 max-w-[220px] truncate">{p.party}</td>
                      <td className="text-right tabular-nums py-1.5 px-4">{formatCr(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border/40 bg-muted/30 font-medium">
                    <td className="py-1.5 px-4">Total</td>
                    <td className="text-right tabular-nums py-1.5 px-4">
                      {formatCr(parties.reduce((a, p) => a + p.amount, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {hasMore && !expanded && (
              <button
                className="w-full py-2 text-xs text-muted-foreground hover:text-foreground border-t border-border/30"
                onClick={() => setExpanded(true)}
              >
                Show all {parties.length} parties
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MonthlyTable({ report }: { report: SalesRepReport }) {
  const { monthly } = report;
  const totalOrder = monthly.reduce((a, m) => a + m.orderAmount, 0);
  const totalOrders = monthly.reduce((a, m) => a + m.orders, 0);
  const totalSale = monthly.reduce((a, m) => a + m.saleAmount, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Monthly Booking</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border/40 bg-muted/30">
                <th className="text-left font-medium py-2 px-4">Month</th>
                <th className="text-right font-medium py-2 px-3">Order Amount</th>
                <th className="text-right font-medium py-2 px-3">Orders</th>
                <th className="text-right font-medium py-2 px-3">Sale Amount</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr
                  key={m.month}
                  className="border-b border-border/20 last:border-0 hover:bg-muted/20"
                >
                  <td className="py-1.5 px-4">{m.month}</td>
                  <td className="text-right tabular-nums py-1.5 px-3">
                    {m.orderAmount > 0 ? formatCr(m.orderAmount) : <span className="text-muted-foreground">-</span>}
                  </td>
                  <td className="text-right tabular-nums py-1.5 px-3">
                    {m.orders > 0 ? formatInt(m.orders) : <span className="text-muted-foreground">-</span>}
                  </td>
                  <td className="text-right tabular-nums py-1.5 px-3">
                    {m.saleAmount > 0 ? formatCr(m.saleAmount) : <span className="text-muted-foreground">-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border/40 bg-muted/30 font-medium">
                <td className="py-1.5 px-4">Total</td>
                <td className="text-right tabular-nums py-1.5 px-3">{formatCr(totalOrder)}</td>
                <td className="text-right tabular-nums py-1.5 px-3">{formatInt(totalOrders)}</td>
                <td className="text-right tabular-nums py-1.5 px-3">{formatCr(totalSale)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function PrimarySection({ report }: { report: SalesRepReport }) {
  const p = report.primary;

  if (!p.available) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          {p.reason ?? "Primary data not available."}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="p-3 rounded-lg border border-border/50 bg-background/50">
          <p className="text-xs text-muted-foreground">Head register total</p>
          <p className="text-base font-semibold tabular-nums mt-0.5">
            {p.headTotal > 0 ? formatCr(p.headTotal) : "-"}
          </p>
        </div>
        <div className="p-3 rounded-lg border border-border/50 bg-background/50">
          <p className="text-xs text-muted-foreground">Bridged to this rep</p>
          <p className="text-base font-semibold tabular-nums mt-0.5">
            {p.totalBridged > 0 ? formatCr(p.totalBridged) : "-"}
          </p>
        </div>
        <div className="p-3 rounded-lg border border-border/50 bg-background/50">
          <p className="text-xs text-muted-foreground">Bridge coverage (head)</p>
          <p className="text-base font-semibold tabular-nums mt-0.5">
            {p.headTotal > 0 ? `${p.bridgeCoverage.toFixed(1)}%` : "-"}
          </p>
          <p className="text-xs text-muted-foreground">
            of head register mapped to any TM
          </p>
        </div>
      </div>

      {p.headTotal === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            No dispatch register data found for this head and FY. Load the relevant
            register via Data Sources to enable primary view.
          </CardContent>
        </Card>
      ) : (
        <>
          <PrimaryPartyTable
            title={`Bridged Parties — mapped to this rep (${formatInt(p.bridgedParties.length)})`}
            parties={p.bridgedParties}
          />
          <PrimaryPartyTable
            title={`Unbridged Parties — not mapped to any TM (${formatInt(p.unbridgedParties.length)})`}
            parties={p.unbridgedParties}
          />
        </>
      )}
    </div>
  );
}

export function SalesReports({
  fy,
  selectedKey,
  effectiveScope,
}: {
  fy: string;
  selectedKey: string;
  effectiveScope: "own" | "team";
}) {
  const [basis, setBasis] = useState<"secondary" | "primary">("secondary");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const reportQuery = useGetSalesPersonReports(
    selectedKey,
    { fy, scope: effectiveScope },
    {
      query: {
        enabled: !!selectedKey,
        queryKey: getGetSalesPersonReportsQueryKey(selectedKey, { fy, scope: effectiveScope }),
      },
    },
  );
  const report = reportQuery.data;

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const params = new URLSearchParams({ fy, basis, scope: effectiveScope });
      const url = `/api/salespeople/${encodeURIComponent(selectedKey)}/reports/download?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      const cd = res.headers.get("Content-Disposition");
      const match = cd?.match(/filename="([^"]+)"/);
      a.download = match?.[1] ?? `SalesReports_${fy}_${basis}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed. Try again.");
    } finally {
      setDownloading(false);
    }
  };

  if (reportQuery.isLoading) {
    return (
      <Card>
        <CardContent className="py-12 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading report...
        </CardContent>
      </Card>
    );
  }

  if (!report?.available) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          {report?.reason ?? "No data available for this selection."}
        </CardContent>
      </Card>
    );
  }

  const sec = report.secondary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {report.fy} vs {report.priorFy} &middot; {report.scope === "team" ? "Own + team" : "Own book"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
            {(["secondary", "primary"] as const).map((b) => (
              <button
                key={b}
                className={cn(
                  "px-3 py-1.5",
                  basis === b ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
                )}
                onClick={() => setBasis(b)}
              >
                {b === "secondary" ? "Secondary" : "Primary"}
              </button>
            ))}
          </div>
          <button
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border bg-background hover:bg-muted disabled:opacity-50"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            Download Excel
          </button>
        </div>
      </div>

      {downloadError && (
        <p className="text-sm text-destructive">{downloadError}</p>
      )}

      <MonthlyTable report={report} />

      {basis === "secondary" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="p-3 rounded-lg border border-border/50 bg-background/50">
              <p className="text-xs text-muted-foreground">Net order booked</p>
              <p className="text-base font-semibold tabular-nums mt-0.5">{formatCr(sec.tiles.netOrderBooked)}</p>
              <p className="text-xs text-muted-foreground">vs {formatCr(sec.tiles.netOrderBookedLast)} last year</p>
            </div>
            <div className="p-3 rounded-lg border border-border/50 bg-background/50">
              <p className="text-xs text-muted-foreground">Orders</p>
              <p className="text-base font-semibold tabular-nums mt-0.5">{formatInt(sec.tiles.orders)}</p>
            </div>
            <div className="p-3 rounded-lg border border-border/50 bg-background/50">
              <p className="text-xs text-muted-foreground">Active retailers</p>
              <p className="text-base font-semibold tabular-nums mt-0.5">{formatInt(sec.tiles.activeRetailers)}</p>
              <p className="text-xs text-muted-foreground">{formatInt(sec.tiles.newRetailers)} new</p>
            </div>
          </div>

          <ReportTable title="By State" rows={sec.byState} />
          <ReportTable title="By Group" rows={sec.byGroup} />
          <ReportTable title="By Segment" rows={sec.bySegment} />

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ReportTable title="Top Parties" rows={sec.parties.top} showFlag />
            <ReportTable
              title={`New Parties this year (${formatInt(sec.parties.newCount)})`}
              rows={sec.parties.newTop}
              showFlag
            />
            <ReportTable
              title={`Churned Parties (${formatInt(sec.parties.churnedCount)} ordered last year, none this)`}
              rows={sec.parties.churned}
              showFlag
            />
          </div>

          <MoverPairCard
            upTitle="Parties gaining"
            downTitle="Parties declining"
            upRows={sec.movers.partiesUp}
            downRows={sec.movers.partiesDown}
          />
          <MoverPairCard
            upTitle="Segments gaining"
            downTitle="Segments declining"
            upRows={sec.movers.segmentsUp}
            downRows={sec.movers.segmentsDown}
          />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2 p-3 rounded-lg border border-border/50 bg-muted/40 text-sm">
            <Info className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground">
              Primary basis uses SAP dispatched-sale data from the state-head dispatch
              register, matched to this rep via the Party TM Map bridge.
              {report.primary.available && report.primary.headTotal > 0 && (
                <> Bridge coverage for this head: {report.primary.bridgeCoverage.toFixed(1)}%.</>
              )}
            </p>
          </div>
          <PrimarySection report={report} />
        </div>
      )}
    </div>
  );
}
