import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetVerifyReport,
  useRunVerifyBackfill,
  getGetVerifyReportQueryKey,
  type VerifySourceAggregates,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ShieldAlert, RefreshCw, Loader2, DownloadCloud } from "lucide-react";
import { formatINR } from "@/data/dataset";

const FY_OPTIONS = ["2026-27", "2025-26", "2024-25"];

function SourceColumn({ label, agg }: { label: string; agg: VerifySourceAggregates }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/50 p-3 space-y-1.5">
      <p className="text-xs font-bold tracking-wider text-muted-foreground uppercase">{label}</p>
      <div className="text-sm space-y-1">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Rows</span>
          <span className="font-medium tabular-nums">{agg.rows.toLocaleString("en-IN")}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Amount</span>
          <span className="font-medium tabular-nums">{formatINR(agg.amount)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Invoices</span>
          <span className="font-medium tabular-nums">{agg.invoices.toLocaleString("en-IN")}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Customers</span>
          <span className="font-medium tabular-nums">{agg.customers.toLocaleString("en-IN")}</span>
        </div>
      </div>
    </div>
  );
}

export default function DataHealth() {
  const [fy, setFy] = useState(FY_OPTIONS[0]);
  const queryClient = useQueryClient();

  const query = useGetVerifyReport(
    { fy },
    {
      query: {
        queryKey: getGetVerifyReportQueryKey({ fy }),
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  );

  const backfill = useRunVerifyBackfill({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetVerifyReportQueryKey({ fy }) });
      },
    },
  });

  const report = query.data;
  const flaggedDeltas =
    report?.comparisons.flatMap((c) =>
      c.deltas.filter((d) => d.flagged).map((d) => ({ label: c.label, ...d })),
    ) ?? [];

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 pt-6 pb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-xl flex items-center gap-2">
              {report ? (
                report.healthy ? (
                  <ShieldCheck className="w-5 h-5 text-green-500" />
                ) : (
                  <ShieldAlert className="w-5 h-5 text-amber-500" />
                )
              ) : (
                <ShieldCheck className="w-5 h-5 text-muted-foreground" />
              )}
              Data Health
            </CardTitle>
            <CardDescription>
              Reconciliation of the invoice-line register: imported files vs live Google Sheets vs database.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={fy}
              onChange={(e) => setFy(e.target.value)}
              className="h-9 rounded-md border border-border/60 bg-background px-2 text-sm"
              aria-label="Fiscal year"
            >
              {FY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  FY {option}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              <span className="ml-1.5">Re-check</span>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-6 pb-6 space-y-4">
        {query.isLoading && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Reading the live register and comparing sources. This can take a few seconds.
          </p>
        )}
        {query.isError && !query.isLoading && (
          <p className="text-sm text-destructive">
            Could not build the verification report. Try again in a minute.
          </p>
        )}
        {report && (
          <>
            <p className="text-sm">
              {report.healthy ? (
                <span className="text-green-600 dark:text-green-400 font-medium">
                  All sources agree for FY {report.fy}. No rows missing, all deltas within 0.5%.
                </span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400 font-medium">
                  Differences found for FY {report.fy}. Review below.
                </span>
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <SourceColumn label="Imported files" agg={report.sources.xlsx} />
              <SourceColumn label="Live Sheets (now)" agg={report.sources.sheets} />
              <SourceColumn label="Database" agg={report.sources.db} />
            </div>
            {flaggedDeltas.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="text-sm font-medium mb-2">Deltas over 0.5%</p>
                <ul className="space-y-1">
                  {flaggedDeltas.map((d, i) => (
                    <li key={i} className="text-sm text-muted-foreground">
                      {d.label} — {d.metric}: {d.a.toLocaleString("en-IN")} vs {d.b.toLocaleString("en-IN")} ({d.deltaPct}%)
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.missingFromDb.count > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-3">
                <p className="text-sm">
                  <span className="font-medium">{report.missingFromDb.count.toLocaleString("en-IN")}</span>{" "}
                  live rows are not in the database yet.
                </p>
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground text-left">
                        <th className="pr-3 pb-1 font-medium">Invoice</th>
                        <th className="pr-3 pb-1 font-medium">Code</th>
                        <th className="pr-3 pb-1 font-medium">Month</th>
                        <th className="pb-1 font-medium text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.missingFromDb.sample.map((row, i) => (
                        <tr key={i}>
                          <td className="pr-3 py-0.5">{row.invoiceNo ?? "-"}</td>
                          <td className="pr-3 py-0.5">{row.code}</td>
                          <td className="pr-3 py-0.5">{row.monthLabel ?? "-"}</td>
                          <td className="py-0.5 text-right tabular-nums">{formatINR(row.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Button
                  size="sm"
                  onClick={() => backfill.mutate({ data: { fy } })}
                  disabled={backfill.isPending}
                >
                  {backfill.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <DownloadCloud className="w-4 h-4" />
                  )}
                  <span className="ml-1.5">Backfill missing rows</span>
                </Button>
              </div>
            )}
            {backfill.isSuccess && (
              <p className="text-sm text-green-600 dark:text-green-400">
                Backfill complete: {backfill.data.inserted.toLocaleString("en-IN")} rows inserted.
              </p>
            )}
            {backfill.isError && (
              <p className="text-sm text-destructive">Backfill failed. Try again in a minute.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
