// Upload panel for Secondary Order Booking xlsx files.
//
// Two-step import flow: upload → parse (validate, preview) → confirm.
// The file is sent directly to object storage via a presigned PUT URL;
// the API parses without committing, shows the validation result, then
// the user explicitly confirms before the import is committed.
//
// Drive precedence: if a Drive file for the FY already exists, the upload
// is still kept (as a backup) but Orders.ts will prefer the Drive file.
import { useState, useCallback, useRef, useEffect } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  UploadCloud,
  FileSpreadsheet,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Trash2,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  preview: {
    rowsRead: number;
    dateRange: string | null;
    teamMemberCount: number;
    retailerCount: number;
    distributorCount: number;
    totalAmount: number;
    orderIdCount: number;
  } | null;
  validation: {
    columnsFound: string[];
    columnsMissing: string[];
    outOfRangeDateRows: number;
    nonNumericSubTotalRows: number;
    duplicateOrderIds: number;
    matchedMemberCount: number;
    unmatchedMembers: Array<{ name: string; amount: number }>;
    matchPctByRows: number;
    matchPctByValue: number;
  } | null;
};

type UploadStatus = {
  fy: string;
  fileName: string;
  uploadedAt: string;
  rowsRead: number;
  dateRange: string | null;
  teamMemberCount: number;
  totalAmount: number;
  source: "upload";
};

type Step = "idle" | "uploading" | "validating" | "review" | "confirming" | "done";

const UPLOAD_FYS = ["2026-27", "2025-26", "2024-25", "2023-24"] as const;

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number): string {
  return `\u20b9${(n / 1e7).toFixed(2)} Cr`;
}

function fmtDate(iso: string): string {
  if (!iso || iso === "unknown") return "unknown";
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

function fmtNum(n: number): string {
  return n.toLocaleString("en-IN");
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

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
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" />
      )}
      {label}
    </span>
  );
}

function CommittedStatus({
  status,
  onDelete,
}: {
  status: UploadStatus;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileSpreadsheet className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate">{status.fileName}</span>
        </div>
        <StatusBadge ok label="Uploaded" />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-muted-foreground">
        {status.uploadedAt !== "unknown" && (
          <span>Uploaded: {fmtDate(status.uploadedAt)}</span>
        )}
        {status.rowsRead > 0 && <span>Rows: {fmtNum(status.rowsRead)}</span>}
        {status.dateRange && <span>Date range: {status.dateRange}</span>}
        {status.teamMemberCount > 0 && (
          <span>Team members: {status.teamMemberCount}</span>
        )}
        {status.totalAmount > 0 && (
          <span className="font-medium text-foreground">
            Total: {fmtCr(status.totalAmount)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <p className="text-xs text-muted-foreground flex-1">
          Drive file takes precedence if one is found for this FY.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-destructive hover:text-destructive gap-1.5"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </Button>
      </div>
    </div>
  );
}

function ValidationSummary({
  result,
  onConfirm,
  onCancel,
  confirming,
}: {
  result: ValidationResult;
  onConfirm: () => void;
  onCancel: () => void;
  confirming: boolean;
}) {
  const [showUnmatched, setShowUnmatched] = useState(false);
  const v = result.validation;
  const p = result.preview;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        {result.valid ? (
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-destructive" />
        )}
        <span className="text-sm font-medium">
          {result.valid ? "Validation passed — review before importing" : "Validation failed"}
        </span>
      </div>

      {/* Blocking errors */}
      {result.errors.length > 0 && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 space-y-1">
          {result.errors.map((e, i) => (
            <p key={i} className="text-xs text-destructive">
              {e}
            </p>
          ))}
        </div>
      )}

      {/* Preview stats */}
      {p && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            File Preview
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
            <span className="text-muted-foreground">Rows read:</span>
            <span className="font-medium">{fmtNum(p.rowsRead)}</span>
            {p.dateRange && (
              <>
                <span className="text-muted-foreground">Date range:</span>
                <span className="font-medium">{p.dateRange}</span>
              </>
            )}
            <span className="text-muted-foreground">Team members:</span>
            <span className="font-medium">{fmtNum(p.teamMemberCount)}</span>
            <span className="text-muted-foreground">Retailers:</span>
            <span className="font-medium">{fmtNum(p.retailerCount)}</span>
            <span className="text-muted-foreground">Distributors:</span>
            <span className="font-medium">{fmtNum(p.distributorCount)}</span>
            <span className="text-muted-foreground">Unique orders:</span>
            <span className="font-medium">{fmtNum(p.orderIdCount)}</span>
            <span className="text-muted-foreground">Total (Sub Total):</span>
            <span className="font-semibold text-foreground">{fmtCr(p.totalAmount)}</span>
          </div>
        </div>
      )}

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className="space-y-1.5">
          {result.warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Roster match + unmatched names */}
      {v && v.unmatchedMembers.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" />
              <span>
                {v.unmatchedMembers.length} name(s) not in roster —{" "}
                {v.matchPctByValue.toFixed(1)}% of value matched.
                These will still be imported.
              </span>
            </div>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowUnmatched((v) => !v)}
            >
              {showUnmatched ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {showUnmatched ? "Hide" : "Show"}
            </button>
          </div>
          {showUnmatched && (
            <div className="rounded border border-border bg-muted/30 divide-y divide-border max-h-48 overflow-y-auto">
              {v.unmatchedMembers.slice(0, 50).map((m, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between px-3 py-1.5 text-xs"
                >
                  <span className="text-foreground">{m.name}</span>
                  <span className="text-muted-foreground font-mono">
                    {fmtCr(m.amount)}
                  </span>
                </div>
              ))}
              {v.unmatchedMembers.length > 50 && (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  … and {v.unmatchedMembers.length - 50} more
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={confirming}
        >
          Cancel
        </Button>
        {result.valid && (
          <Button size="sm" onClick={onConfirm} disabled={confirming}>
            {confirming && <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />}
            Confirm import
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Main panel per FY ─────────────────────────────────────────────────────────

function FyUploadCard({ fy }: { fy: string }) {
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadUrl, setUploadUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [committedStatus, setCommittedStatus] = useState<UploadStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load committed status on mount
  useEffect(() => {
    let cancelled = false;
    setLoadingStatus(true);
    fetch(`/api/mgmt/secondary-upload/status/${fy}`)
      .then((r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(r.statusText);
        return r.json() as Promise<{ status: UploadStatus }>;
      })
      .then((d) => {
        if (!cancelled) {
          setCommittedStatus(d?.status ?? null);
          setLoadingStatus(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadingStatus(false);
      });
    return () => { cancelled = true; };
  }, [fy]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file) return;
      setError(null);
      setStep("uploading");
      setFileName(file.name);

      try {
        // Step 1: get presigned URL
        const urlRes = await fetch("/api/mgmt/secondary-upload/upload-url");
        if (!urlRes.ok) throw new Error("Could not get upload URL");
        const { uploadUrl: signedUrl } = (await urlRes.json()) as {
          uploadUrl: string;
        };
        setUploadUrl(signedUrl);

        // Step 2: PUT file directly to GCS
        const putRes = await fetch(signedUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        });
        if (!putRes.ok) throw new Error("File upload failed");

        // Step 3: Validate (no commit)
        setStep("validating");
        const parseRes = await fetch("/api/mgmt/secondary-upload/parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadUrl: signedUrl, fy }),
        });
        if (!parseRes.ok) {
          const e = (await parseRes.json()) as { error?: string };
          throw new Error(e.error ?? "Validation failed");
        }
        const result = (await parseRes.json()) as ValidationResult;
        setValidationResult(result);
        setStep("review");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStep("idle");
      }
    },
    [fy],
  );

  const handleConfirm = useCallback(async () => {
    if (!uploadUrl) return;
    setStep("confirming");
    try {
      const res = await fetch("/api/mgmt/secondary-upload/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadUrl, fy, fileName }),
      });
      if (!res.ok) {
        const e = (await res.json()) as { error?: string };
        throw new Error(e.error ?? "Confirm failed");
      }
      const { status } = (await res.json()) as { status: UploadStatus };
      setCommittedStatus(status);
      setStep("done");
      setValidationResult(null);
      setUploadUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("review");
    }
  }, [uploadUrl, fy, fileName]);

  const handleDelete = useCallback(async () => {
    if (!confirm(`Remove the uploaded secondary order booking for FY ${fy}?`)) return;
    setDeleting(true);
    try {
      await fetch(`/api/mgmt/secondary-upload/${fy}`, { method: "DELETE" });
      setCommittedStatus(null);
      setStep("idle");
    } catch {
      /* ignore */
    } finally {
      setDeleting(false);
    }
  }, [fy]);

  const handleCancel = () => {
    setStep("idle");
    setValidationResult(null);
    setUploadUrl(null);
    setError(null);
  };

  const busy = step === "uploading" || step === "validating" || step === "confirming";

  if (loadingStatus) {
    return (
      <div className="h-20 flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Committed status */}
      {committedStatus && step !== "review" && step !== "confirming" && (
        <CommittedStatus
          status={committedStatus}
          onDelete={deleting ? () => {} : handleDelete}
        />
      )}

      {/* Done message */}
      {step === "done" && (
        <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4" />
          Import committed. The orders pipeline will use this file for FY {fy}.
        </div>
      )}

      {/* Validation review */}
      {(step === "review" || step === "confirming") && validationResult && (
        <ValidationSummary
          result={validationResult}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          confirming={step === "confirming"}
        />
      )}

      {/* Upload zone — hidden during review or done (unless replacing) */}
      {step !== "review" && step !== "confirming" && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          <div
            role="button"
            tabIndex={0}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) handleFile(f);
            }}
            onClick={() => !busy && fileInputRef.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && !busy && fileInputRef.current?.click()}
            className={cn(
              "rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors select-none",
              dragOver
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-muted/30",
              busy && "opacity-50 pointer-events-none",
            )}
          >
            {busy ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-7 w-7 text-muted-foreground animate-spin" />
                <p className="text-sm text-muted-foreground">
                  {step === "uploading" && "Uploading file…"}
                  {step === "validating" && "Validating…"}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                {committedStatus ? (
                  <FileSpreadsheet className="h-7 w-7 text-muted-foreground" />
                ) : (
                  <UploadCloud className="h-7 w-7 text-muted-foreground" />
                )}
                <p className="text-sm text-foreground">
                  {committedStatus ? "Drop a replacement file to re-upload" : "Drop file here, or click to browse"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Accepts .xlsx and .csv. Re-uploading replaces the previous file.
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}

// ── Top-level panel ───────────────────────────────────────────────────────────

export default function SecondaryUploadPanel() {
  const [fy, setFy] = useState<string>("2026-27");

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Secondary Order Booking</CardTitle>
            <CardDescription className="mt-1 text-xs leading-relaxed">
              Upload the Secondary Order Booking xlsx export (distributor to retailer).
              The system checks Google Drive first; this upload fills the gap when no Drive file exists.
              Uses <strong>Sub Total</strong> (net value), not Order Value.
              Member names not in the roster are still imported and flagged.
            </CardDescription>
          </div>
          <div className="shrink-0">
            <Select value={fy} onValueChange={setFy}>
              <SelectTrigger className="h-8 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UPLOAD_FYS.map((f) => (
                  <SelectItem key={f} value={f} className="text-xs">
                    FY {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <FyUploadCard key={fy} fy={fy} />
      </CardContent>
    </Card>
  );
}
