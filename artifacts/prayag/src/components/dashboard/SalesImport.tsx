import { useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSapStatus,
  useGetSapVerify,
  getSapUploadUrl,
  registerSapUpload,
  deleteSapUpload,
} from "@workspace/api-client-react";
import type { SapStatusMonth } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  UploadCloud,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  FileSpreadsheet,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCrore } from "@/data/dataset";

const SAP_FY = "2026-27";

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function StatBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        ok
          ? "bg-green-500/10 text-green-600 dark:text-green-400"
          : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      )}
    >
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" />
      )}
      {label}
    </span>
  );
}

export default function SalesImport() {
  const queryClient = useQueryClient();
  const statusQuery = useGetSapStatus({ fy: SAP_FY });
  const verifyQuery = useGetSapVerify({ fy: SAP_FY });

  const [activeMonth, setActiveMonth] = useState<string | null>(null);
  const [busyMonth, setBusyMonth] = useState<string | null>(null);
  const [dragMonth, setDragMonth] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const status = statusQuery.data;
  const report = verifyQuery.data;

  const uploadedByMonth = new Map<string, SapStatusMonth>(
    (status?.months ?? []).map((m) => [m.monthLabel, m]),
  );

  const refetchAll = useCallback(async () => {
    await Promise.all([statusQuery.refetch(), verifyQuery.refetch()]);
    await queryClient.invalidateQueries({ queryKey: ["/api/analytics"] });
  }, [statusQuery, verifyQuery, queryClient]);

  const handleFile = useCallback(
    async (month: string, file: File) => {
      setError(null);
      setBusyMonth(month);
      try {
        const { uploadUrl } = await getSapUploadUrl();
        const put = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) {
          throw new Error("Upload failed. Please try again.");
        }
        await registerSapUpload({
          fy: SAP_FY,
          month,
          uploadUrl,
          originalName: file.name,
        });
        await refetchAll();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Could not process the file. Check the format and try again.",
        );
      } finally {
        setBusyMonth(null);
        setActiveMonth(null);
      }
    },
    [refetchAll],
  );

  const handleDelete = useCallback(
    async (month: string) => {
      setError(null);
      setBusyMonth(month);
      try {
        await deleteSapUpload({ fy: SAP_FY, month });
        await refetchAll();
      } catch {
        setError("Could not remove that month.");
      } finally {
        setBusyMonth(null);
      }
    },
    [refetchAll],
  );

  const onPick = (month: string) => {
    setActiveMonth(month);
    fileInputRef.current?.click();
  };

  const months = status?.allMonths ?? [];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && activeMonth) {
            void handleFile(activeMonth, file);
          }
          e.target.value = "";
        }}
      />

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-xl flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-primary" />
            SAP Primary Sales — FY {SAP_FY}
          </CardTitle>
          <CardDescription>
            Upload the monthly SAP primary-sales export (columns A–M). Each file
            is enriched by the rate list, reconciled below, and only replaces the
            live FY {SAP_FY} analytics once verified. Re-uploading a month
            overwrites its previous import.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {months.map((month) => {
              const uploaded = uploadedByMonth.get(month);
              const isBusy = busyMonth === month;
              const isDragging = dragMonth === month;
              return (
                <div
                  key={month}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragMonth(month);
                  }}
                  onDragLeave={() => setDragMonth((m) => (m === month ? null : m))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragMonth(null);
                    const file = e.dataTransfer.files?.[0];
                    if (file) void handleFile(month, file);
                  }}
                  className={cn(
                    "rounded-lg border p-3 transition-colors",
                    isDragging
                      ? "border-primary bg-primary/5"
                      : uploaded
                        ? "border-green-500/30 bg-green-500/5"
                        : "border-dashed border-border/60 bg-background/40",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">{month}</span>
                    {uploaded && !isBusy && (
                      <button
                        type="button"
                        onClick={() => void handleDelete(month)}
                        className="text-muted-foreground transition-colors hover:text-red-500"
                        title="Remove this month"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {isBusy ? (
                    <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Processing…
                    </div>
                  ) : uploaded ? (
                    <div className="mt-2 space-y-1">
                      <p className="text-sm font-medium">
                        {formatCrore(uploaded.amount)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {uploaded.rowsRead.toLocaleString()} rows
                      </p>
                      <button
                        type="button"
                        onClick={() => onPick(month)}
                        className="text-xs text-primary hover:underline"
                      >
                        Replace file
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onPick(month)}
                      className="mt-3 flex w-full flex-col items-center gap-1.5 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <UploadCloud className="h-5 w-5" />
                      Drop file or click
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {report && report.uploadedMonths.length > 0 && (
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="px-6 pt-6 pb-4">
            <CardTitle className="text-xl flex items-center gap-2">
              {report.verified ? (
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-amber-500" />
              )}
              Verification
            </CardTitle>
            <CardDescription>
              {report.verified
                ? `Verified — live FY ${SAP_FY} analytics are served from SAP.`
                : `Not yet verified — analytics still use the previous register data for FY ${SAP_FY}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6 space-y-6">
            <div className="flex flex-wrap gap-2">
              <StatBadge
                ok={report.match.rowsPct >= report.match.targetPct}
                label={`Customer match ${pct(report.match.rowsPct)} rows / ${pct(report.match.revenuePct)} revenue`}
              />
              <StatBadge
                ok={report.benchmark.ok}
                label={`Apr–Jul ${formatCrore(report.benchmark.actual)} vs ${formatCrore(report.benchmark.expected)}`}
              />
              <StatBadge
                ok={report.crossFoot.ok}
                label={`Cross-foot Δ ₹${report.crossFoot.maxDeltaRupees.toFixed(2)}`}
              />
              <StatBadge
                ok={report.unmappedGroups.length === 0}
                label={`${report.unmappedGroups.length} unmapped groups`}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Rows read
                </p>
                <p className="text-lg font-semibold">
                  {report.rowsRead.toLocaleString()}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Grand total
                </p>
                <p className="text-lg font-semibold">
                  {formatCrore(report.grandTotal)}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Matched revenue
                </p>
                <p className="text-lg font-semibold">
                  {pct(report.match.revenuePct)}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">
                  Months uploaded
                </p>
                <p className="text-lg font-semibold">
                  {report.uploadedMonths.length}
                </p>
              </div>
            </div>

            {report.unmatchedCustomers.length > 0 && (
              <div>
                <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-muted-foreground">
                  Top unmatched customers
                </h3>
                <div className="space-y-1.5">
                  {report.unmatchedCustomers.slice(0, 10).map((c) => (
                    <div
                      key={c.name}
                      className="flex items-center justify-between rounded-md border border-border/50 bg-background/40 px-3 py-2 text-sm"
                    >
                      <span className="truncate pr-3">{c.name}</span>
                      <span className="shrink-0 font-medium text-muted-foreground">
                        {formatCrore(c.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {report.unmappedGroups.length > 0 && (
              <div>
                <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-muted-foreground">
                  Unmapped item groups
                </h3>
                <div className="space-y-1.5">
                  {report.unmappedGroups.map((g) => (
                    <div
                      key={g.key}
                      className="flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm"
                    >
                      <span className="truncate pr-3">{g.key}</span>
                      <span className="shrink-0 font-medium text-muted-foreground">
                        {formatCrore(g.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
