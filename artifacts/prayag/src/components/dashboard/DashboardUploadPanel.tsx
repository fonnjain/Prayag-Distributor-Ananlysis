// Upload panel for STATE HEAD DASHBOARD xlsx files.
// Two FYs: 2025-26 (annual targets) and 2026-27 (Q1 Apr-Jun targets).
// Pattern mirrors SalesImport: presigned PUT URL -> direct upload -> register.
import { useState, useCallback, useRef } from "react";
import {
  getMgmtDashboardXlsxUploadUrl,
  registerMgmtDashboardXlsx,
  useGetMgmtDashboardXlsxStatus,
} from "@workspace/api-client-react";
import type { DashboardXlsxStatus } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { UploadCloud, CheckCircle2, AlertTriangle, FileSpreadsheet, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

const UPLOAD_FYS = ["2025-26", "2026-27"] as const;
type UploadFy = (typeof UPLOAD_FYS)[number];

const FY_LABELS: Record<UploadFy, string> = {
  "2025-26": "FY 2025-26 (annual targets)",
  "2026-27": "FY 2026-27 (Q1 Apr-Jun targets)",
};

type TargetDiagnostic = {
  xlsxRowCount: number;
  matchedCount: number;
  unmatchedRows: Array<{ name: string; target: number | null }>;
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtCr(n: number | null): string {
  if (n == null) return "";
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        ok
          ? "bg-green-500/10 text-green-700 dark:text-green-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

function FyPanel({
  fy,
  targetDiagnostic,
}: {
  fy: UploadFy;
  targetDiagnostic: TargetDiagnostic | null;
}) {
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const statusQuery = useGetMgmtDashboardXlsxStatus(fy);
  const status: DashboardXlsxStatus | undefined = statusQuery.data?.status;

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.match(/\.xlsx?$/i)) {
        setError("Only .xlsx files are accepted.");
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const { uploadUrl } = await getMgmtDashboardXlsxUploadUrl();
        const put = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) throw new Error(`Storage upload failed (${put.status}).`);
        await registerMgmtDashboardXlsx({ fy, uploadUrl, fileName: file.name });
        await statusQuery.refetch();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Could not process the file. Check the format and try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [fy, statusQuery],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      e.target.value = "";
    },
    [handleFile],
  );

  const unmatchedCount = targetDiagnostic?.unmatchedRows.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">{FY_LABELS[fy]}</CardTitle>
        {status ? (
          <CardDescription className="text-xs">
            Last uploaded: {fmtDate(status.parsedAt)} &mdash; {status.fileName}
          </CardDescription>
        ) : (
          <CardDescription className="text-xs">No file uploaded yet.</CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Parsed summary */}
        {status && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Total members</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{status.totalRecords}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Active</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-green-700 dark:text-green-400">
                {status.activeRecords}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Left</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-muted-foreground">
                {status.leftRecords}
              </p>
            </div>
          </div>
        )}
        {status && (
          <div className="flex flex-wrap gap-2">
            <StatusBadge
              ok={status.totalRecords > 0}
              label={`${status.totalRecords} rows parsed`}
            />
            <StatusBadge ok={true} label={status.targetPeriod} />
            <StatusBadge
              ok={status.unmatchedSample.length === 0}
              label={
                status.unmatchedSample.length === 0
                  ? "All names matched"
                  : `${status.unmatchedSample.length} unmatched names`
              }
            />
          </div>
        )}

        {/* Target match diagnostic — shown when this panel's FY is the currently loaded one */}
        {targetDiagnostic && (
          <div className="rounded-lg border p-3 space-y-2">
            <p className="text-xs font-semibold">Target match diagnostic</p>
            <div className="flex flex-wrap gap-4 text-xs">
              <span className="text-muted-foreground">{targetDiagnostic.xlsxRowCount} rows read</span>
              <span className="text-green-700 dark:text-green-400">
                {targetDiagnostic.matchedCount} matched to a member
              </span>
              {unmatchedCount > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {unmatchedCount} unmatched (target lost)
                </span>
              )}
            </div>
            {unmatchedCount > 0 && (
              <div>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowUnmatched((v) => !v)}
                >
                  {showUnmatched ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {showUnmatched ? "Hide" : "Show"} unmatched names
                </button>
                {showUnmatched && (
                  <ul className="mt-2 space-y-1 max-h-48 overflow-y-auto rounded border p-2">
                    {targetDiagnostic.unmatchedRows.map((r, i) => (
                      <li key={i} className="flex items-center justify-between gap-3 text-xs py-0.5">
                        <span className="text-muted-foreground">{r.name}</span>
                        {r.target != null && (
                          <span className="tabular-nums font-medium shrink-0">{fmtCr(r.target)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* Drop zone */}
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-muted-foreground/50",
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => !busy && fileInputRef.current?.click()}
          style={{ cursor: busy ? "wait" : "pointer" }}
        >
          {busy ? (
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          ) : status ? (
            <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
          ) : (
            <UploadCloud className="h-8 w-8 text-muted-foreground" />
          )}
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {busy
                ? "Uploading and parsing..."
                : status
                  ? "Drop a new file to replace"
                  : "Drop the STATE HEAD DASHBOARD xlsx here"}
            </p>
            <p className="text-xs text-muted-foreground">
              {busy ? "Please wait." : "or click to browse"}
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={onFileChange}
            disabled={busy}
          />
        </div>

        {error && (
          <p className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardUploadPanel({
  targetDiagnostic,
  selectedFy,
}: {
  targetDiagnostic?: TargetDiagnostic | null;
  selectedFy?: string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">STATE HEAD DASHBOARD Import</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Upload the STATE HEAD DASHBOARD xlsx file for each fiscal year. This populates targets,
          CTC, designation, and stateHead assignments used in the management report. The Prayag
          Target Master sheet overrides xlsx values when both are present.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {UPLOAD_FYS.map((fy) => (
          <FyPanel
            key={fy}
            fy={fy}
            targetDiagnostic={fy === selectedFy ? (targetDiagnostic ?? null) : null}
          />
        ))}
      </div>
    </div>
  );
}
