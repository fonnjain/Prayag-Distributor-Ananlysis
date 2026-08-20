import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { fetchCoverageDrift } from "@/lib/coverageDriftApi";
import {
  ShieldCheck,
  AlertTriangle,
  RefreshCcw,
  Lock,
  CheckCircle2,
  ServerCrash,
  X,
  UserCheck,
  Clock
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type IssueKind =
  | "mixed"
  | "unassigned"
  | "system-routed"
  | "unresolved"
  | "coverage-mismatch"
  | "evidence-mismatch";

interface Evidence {
  customerCount?: number;
  netAmount?: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  fiscalYear?: string;
  coverageFiscalYear?: string;
  evidenceFiscalYear?: string;
  registerHeads?: string[];
  heads?: string[];
}

interface IssueDetail {
  review?: {
    canonicalLeaf: string;
    fiscalYear: string;
    customer?: string | null;
    currentRegisterEvidence?: Evidence | null;
    persistedEvidence?: Evidence | null;
    difference?: EvidenceDifference | null;
    coverageWasChanged: boolean;
  };
  structuralReasons?: StructuralReason[];
  person?: unknown;
}

type StructuralReason =
  | "source-attribution"
  | "customer-head-changed"
  | "customer-appeared-or-disappeared"
  | "customer-count-changed"
  | "effective-date-range-changed"
  | "leaf-gained-or-lost-head"
  | "evidence-fiscal-year-changed";

interface EvidenceDifference {
  customerCount?: number;
  netAmount?: number;
  effectiveFromDays?: number | null;
  effectiveToDays?: number | null;
  fiscalYearChanged?: boolean;
}

interface Issue {
  kind: IssueKind;
  stateCanon: string;
  fiscalYear: string;
  customer: string | null;
  detail: IssueDetail;
}

interface ConcentrationWarning {
  stateCanon: "TAMIL NADU";
  fiscalYear: string;
  customer: string;
  customerCount: number;
  customerNetAmount: number;
  stateNetAmount: number;
  sharePercent: number;
  coverageRows: number;
  coveragePeople: string[];
  responsibleHeads: string[];
  message: string;
}

interface CurrentDrift {
  checkedAt: string;
  fiscalYear: string | null;
  passed: boolean;
  issueCount: number;
  issues: Issue[];
  concentrationWarnings: ConcentrationWarning[];
  warning?: string;
}

interface EventRow {
  event_id: string;
  checked_at: string;
  trigger_fy: string;
  trigger_source: string;
  report_fy: string;
  status: string;
  detail?: {
    issueCount?: number;
    issues?: Issue[];
    concentrationWarnings?: ConcentrationWarning[];
  };
}

interface DriftHistory {
  events: EventRow[];
  warning?: string;
}

// ── Formatters ────────────────────────────────────────────────────────────────

const formatCurrency = (val: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(val);

const formatNumber = (val: number) =>
  new Intl.NumberFormat("en-IN").format(val);

const formatDate = (val: string) => {
  return new Date(val).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const signedValue = (value: number) =>
  `${value > 0 ? "+" : ""}${formatCurrency(value)}`;

// ── Components ────────────────────────────────────────────────────────────────

function IssueKindBadge({ kind }: { kind: IssueKind }) {
  const styles: Record<string, string> = {
    mixed:
      "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800",
    unassigned:
      "bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
    "system-routed":
      "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800",
    unresolved:
      "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800",
    "coverage-mismatch":
      "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200 dark:bg-fuchsia-900/30 dark:text-fuchsia-300 dark:border-fuchsia-800",
    "evidence-mismatch":
      "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800",
  };
  return (
    <span
      className={cn(
        "px-2 py-0.5 text-[10px] font-medium border rounded-full whitespace-nowrap",
        styles[kind] || "bg-muted text-muted-foreground"
      )}
    >
      {kind.replace("-", " ")}
    </span>
  );
}

function EvidenceData({ data }: { data: Evidence }) {
  return (
    <ul className="space-y-0.5 mt-1">
      {data.customerCount !== undefined && (
        <li>
          Customers: <b className="text-foreground">{formatNumber(data.customerCount)}</b>
        </li>
      )}
      {data.netAmount !== undefined && (
        <li>
          Net Amount: <b className="text-foreground">{formatCurrency(data.netAmount)}</b>
        </li>
      )}
      {(data.effectiveFrom || data.effectiveTo) && (
        <li>
          Effective:{" "}
          <b className="text-foreground">
            {data.effectiveFrom ?? "—"} to {data.effectiveTo ?? "—"}
          </b>
        </li>
      )}
      {(data.fiscalYear || data.coverageFiscalYear || data.evidenceFiscalYear) && (
        <li>
          FY:{" "}
          <b className="text-foreground">
            {data.fiscalYear ?? data.coverageFiscalYear ?? "—"}
            {data.evidenceFiscalYear && data.evidenceFiscalYear !== (data.fiscalYear ?? data.coverageFiscalYear)
              ? ` (evidence ${data.evidenceFiscalYear})`
              : ""}
          </b>
        </li>
      )}
      {(data.registerHeads ?? data.heads)?.length ? (
        <li>
          Heads: <b className="text-foreground">{(data.registerHeads ?? data.heads)?.join(", ")}</b>
        </li>
      ) : null}
    </ul>
  );
}

function EvidenceDiff({
  current,
  persisted,
}: {
  current?: Evidence | null;
  persisted?: Evidence | null;
}) {
  if (!current && !persisted) {
    return <span className="text-muted-foreground italic">No evidence payload available</span>;
  }
  return (
    <div className="grid grid-cols-2 gap-3 text-[10px] mt-2">
      <div className="border rounded bg-card p-2 shadow-sm">
        <div className="font-semibold text-muted-foreground uppercase tracking-wider text-[9px] border-b pb-1 mb-1">
          Register (Live)
        </div>
        {current ? <EvidenceData data={current} /> : <div className="text-muted-foreground mt-1">None</div>}
      </div>
      <div className="border rounded bg-muted/30 p-2 shadow-sm">
        <div className="font-semibold text-muted-foreground uppercase tracking-wider text-[9px] border-b pb-1 mb-1">
          Persisted
        </div>
        {persisted ? <EvidenceData data={persisted} /> : <div className="text-muted-foreground mt-1">None</div>}
      </div>
    </div>
  );
}

function IssueDetails({ issue }: { issue: Issue }) {
  const difference = issue.detail?.review?.difference;
  const structuralReasonLabels: Record<StructuralReason, string> = {
    "source-attribution": "Register attribution needs review",
    "customer-head-changed": "Customer is attributed to a different head",
    "customer-appeared-or-disappeared": "Customer appeared in or disappeared from this leaf",
    "customer-count-changed": "Customer count changed",
    "effective-date-range-changed": "Coverage effective dates changed",
    "leaf-gained-or-lost-head": "Leaf gained or lost a head",
    "evidence-fiscal-year-changed": "Evidence fiscal year changed",
  };
  return (
    <div className="space-y-2 py-1 max-w-xl">
      {issue.customer && (
        <div className="text-xs text-muted-foreground">
          Customer: <span className="font-medium text-foreground">{issue.customer}</span>
        </div>
      )}
      {issue.detail?.review && (
        <EvidenceDiff
          current={issue.detail.review.currentRegisterEvidence}
          persisted={issue.detail.review.persistedEvidence}
        />
      )}
      {issue.detail.structuralReasons && issue.detail.structuralReasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-[10px] text-amber-900 dark:text-amber-200">
          <span className="font-semibold">Why this is actionable:</span>
          {issue.detail.structuralReasons.map((reason) => (
            <span key={reason} className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 dark:border-amber-700 dark:bg-amber-900/30">
              {structuralReasonLabels[reason] ?? reason}
            </span>
          ))}
        </div>
      )}
      {difference && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] bg-muted/60 p-2 rounded border text-muted-foreground">
          {difference.customerCount !== undefined && (
            <span>Customer difference: <b className="text-foreground">{difference.customerCount > 0 ? "+" : ""}{difference.customerCount}</b></span>
          )}
          {difference.netAmount !== undefined && (
            <span>Net difference: <b className="text-foreground">{signedValue(difference.netAmount)}</b></span>
          )}
          {difference.effectiveFromDays !== undefined && (
            <span>Start-date difference: <b className="text-foreground">{difference.effectiveFromDays == null ? "—" : `${difference.effectiveFromDays > 0 ? "+" : ""}${difference.effectiveFromDays} days`}</b></span>
          )}
          {difference.effectiveToDays !== undefined && (
            <span>End-date difference: <b className="text-foreground">{difference.effectiveToDays == null ? "—" : `${difference.effectiveToDays > 0 ? "+" : ""}${difference.effectiveToDays} days`}</b></span>
          )}
          {difference.fiscalYearChanged && <span className="font-medium text-amber-700 dark:text-amber-300">Evidence FY differs</span>}
        </div>
      )}
    </div>
  );
}

export default function CoverageDriftPage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [secret, setSecret] = useState(
    () => sessionStorage.getItem("adminSecret") ?? ""
  );
  const [secretInput, setSecretInput] = useState("");

  // ── Queries ───────────────────────────────────────────────────────────────

  const {
    data: current,
    isLoading: currentLoading,
    error: currentError,
  } = useQuery<CurrentDrift>({
    queryKey: ["coverage-drift-current"],
    queryFn: async () => {
      const res = await fetch("/api/master/coverage-drift/current");
      if (res.status === 409) {
        return res.json(); // drift found
      }
      if (!res.ok) throw new Error("Failed to fetch current drift status");
      return res.json();
    },
    staleTime: 0,
  });

  const {
    data: history,
    isLoading: historyLoading,
    error: historyError,
  } = useQuery<DriftHistory>({
    queryKey: ["coverage-drift-history"],
    queryFn: () => fetchCoverageDrift<DriftHistory>("/api/master/coverage-drift"),
    staleTime: 30_000,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────

  const checkMutation = useMutation({
    mutationFn: async () => {
      if (!secret) throw new Error("Not authorized");
      const res = await fetch("/api/master/coverage-drift/check", {
        method: "POST",
        headers: { "X-Admin-Secret": secret },
      });
      if (res.status === 409) return res.json();
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data: CurrentDrift) => {
      qc.setQueryData(["coverage-drift-current"], data);
      qc.invalidateQueries({ queryKey: ["coverage-drift-history"] });
      if (data.passed) {
        toast({
          title: "Check completed",
          description: "No evidence drift found.",
        });
      } else {
        toast({
          title: "Check completed",
          description: `Found ${data.issueCount} issue${
            data.issueCount === 1 ? "" : "s"
          }.`,
          variant: "destructive",
        });
      }
    },
    onError: (err: Error) => {
      toast({
        title: "Check failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // ── Render Helpers ────────────────────────────────────────────────────────

  function handleUnlock(e: FormEvent) {
    e.preventDefault();
    if (!secretInput.trim()) return;
    sessionStorage.setItem("adminSecret", secretInput);
    setSecret(secretInput);
    setSecretInput("");
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-50/50 dark:bg-background">
      {/* Header */}
      <div className="px-6 py-4 border-b flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0 bg-card">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Coverage Review
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Inspect canonical evidence drift between register and persistence.
          </p>
        </div>

        {/* Action / Auth */}
        <div className="flex items-center gap-3">
          {!secret ? (
            <form onSubmit={handleUnlock} className="flex items-center gap-2">
              <Lock className="size-4 text-muted-foreground" />
              <Input
                type="password"
                placeholder="Admin secret to enable checks"
                value={secretInput}
                onChange={(e) => setSecretInput(e.target.value)}
                className="h-8 w-56 text-sm"
              />
              <Button type="submit" size="sm" variant="outline">
                Unlock
              </Button>
            </form>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground px-3">
                <UserCheck className="size-4 text-emerald-600" />
                <span className="hidden sm:inline">Admin Access</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  onClick={() => {
                    sessionStorage.removeItem("adminSecret");
                    setSecret("");
                  }}
                  title="Lock access"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
              <Button
                size="sm"
                onClick={() => checkMutation.mutate()}
                disabled={checkMutation.isPending}
                className="min-w-36"
              >
                {checkMutation.isPending ? (
                  <RefreshCcw className="size-3.5 mr-2 animate-spin" />
                ) : (
                  <RefreshCcw className="size-3.5 mr-2" />
                )}
                Run Drift Check
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6">
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 max-w-[1600px] mx-auto">
          {/* Main Content (Left, 2 cols) */}
          <div className="xl:col-span-2 space-y-6">
            {/* Warnings block */}
            {(current?.concentrationWarnings?.length ?? 0) > 0 && (
              <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 p-4 rounded-lg space-y-2">
                <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-semibold text-sm">
                  <AlertTriangle className="h-4 w-4" />
                  Concentration Warnings
                </div>
                <ul className="text-sm text-amber-700 dark:text-amber-400/90 list-disc list-inside pl-2 space-y-1">
                  {current!.concentrationWarnings.map((w) => (
                    <li key={`${w.fiscalYear}-${w.customer}`}>
                      <span className="font-medium">{w.customer}</span> — {formatCurrency(w.customerNetAmount)} of {formatCurrency(w.stateNetAmount)} ({w.sharePercent.toFixed(1)}%) in FY{w.fiscalYear}; {w.customerCount} customer{w.customerCount === 1 ? "" : "s"}.
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {current?.warning && (
              <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/50 p-4 rounded-lg space-y-2 text-sm text-blue-800 dark:text-blue-300">
                <div className="flex items-center gap-2 font-semibold">
                  <ShieldCheck className="h-4 w-4" /> System Notice
                </div>
                <div>{current.warning}</div>
              </div>
            )}

            <div className="flex items-center justify-between border-b pb-2">
              <h2 className="text-base font-semibold">Live Coverage State</h2>
              {current && !currentLoading && (
                <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  Last checked: {formatDate(current.checkedAt)}
                </div>
              )}
            </div>

            {currentLoading ? (
              <div className="space-y-4">
                <div className="h-32 bg-muted/40 animate-pulse rounded-lg border" />
                <div className="h-64 bg-muted/40 animate-pulse rounded-lg border" />
              </div>
            ) : currentError ? (
              <div className="p-12 text-center border rounded-lg bg-card text-destructive">
                <ServerCrash className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p className="font-semibold text-lg">Failed to load drift data</p>
                <p className="text-sm opacity-80 mt-1">{currentError.message}</p>
              </div>
            ) : current?.passed ? (
              <div className="border border-green-200 dark:border-green-900/50 bg-green-50/50 dark:bg-green-950/10 rounded-xl p-10 flex flex-col items-center justify-center text-center shadow-sm">
                <div className="h-14 w-14 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center mb-5">
                  <CheckCircle2 className="h-7 w-7 text-green-600 dark:text-green-400" />
                </div>
                <h2 className="text-xl font-semibold text-green-900 dark:text-green-100">
                  Coverage is Synchronised
                </h2>
                <p className="text-sm text-green-700/80 dark:text-green-400 max-w-md mt-2">
                  No evidence drift detected between the live register and persisted coverage tables for FY {current.fiscalYear}. The system state is canonical.
                </p>
              </div>
            ) : current ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <Badge variant="destructive" className="px-2.5 py-0.5 text-xs">
                    {current.issueCount} Drift Issues Detected
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    Review required before any geography change. This page never rewrites coverage.
                  </span>
                </div>

                <div className="border rounded-lg overflow-x-auto bg-card shadow-sm">
                  <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead className="bg-muted/50 border-b text-muted-foreground text-xs uppercase tracking-wider">
                      <tr>
                        <th className="px-4 py-3.5 font-medium">State</th>
                        <th className="px-4 py-3.5 font-medium">Kind</th>
                        <th className="px-4 py-3.5 font-medium">FY</th>
                        <th className="px-4 py-3.5 font-medium">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {current.issues.map((issue, idx) => (
                        <tr
                          key={idx}
                          className="hover:bg-muted/30 transition-colors align-top group"
                        >
                          <td className="px-4 py-4 font-medium text-foreground">
                            {issue.stateCanon}
                          </td>
                          <td className="px-4 py-4">
                            <IssueKindBadge kind={issue.kind} />
                          </td>
                          <td className="px-4 py-4 text-muted-foreground">
                            {issue.fiscalYear}
                          </td>
                          <td className="px-4 py-4 whitespace-normal w-full">
                            <IssueDetails issue={issue} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>

          {/* Sidebar (Right, 1 col) */}
          <div className="xl:col-span-1 space-y-4">
            <div className="flex items-center justify-between border-b pb-2 mb-4">
              <h2 className="text-base font-semibold">Audit History</h2>
            </div>

            {history?.warning && (
              <div className="bg-blue-50 dark:bg-blue-950/20 text-blue-800 dark:text-blue-300 text-xs p-3 rounded border border-blue-200 dark:border-blue-900/50 mb-4">
                {history.warning}
              </div>
            )}

            {historyLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-24 bg-muted/40 animate-pulse rounded-lg border"
                  />
                ))}
              </div>
            ) : historyError ? (
              <div className="text-sm text-destructive p-4 border border-destructive/20 bg-destructive/10 rounded-lg">
                Could not load audit history.
              </div>
            ) : !history?.events?.length ? (
              <div className="text-sm text-muted-foreground p-6 border border-dashed rounded-lg text-center bg-card/50">
                No recent audit events.
              </div>
            ) : (
              <div className="space-y-3">
                {history.events.map((event) => (
                  <div
                    key={event.event_id}
                    className="border rounded-lg bg-card p-4 text-sm shadow-sm transition-colors hover:border-border/80"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="font-medium text-foreground">
                        {formatDate(event.checked_at)}
                      </div>
                      <Badge
                        variant={
                          event.status === "ok"
                            ? "default"
                            : event.status === "drift" || event.status === "error"
                            ? "destructive"
                            : "secondary"
                        }
                        className={cn(
                          "text-[10px] uppercase tracking-widest px-2 py-0.5",
                          event.status === "ok" &&
                            "bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900/50 dark:text-green-300"
                        )}
                      >
                        {event.status}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground bg-muted/30 p-2 rounded-md">
                      <div>
                        Trigger:{" "}
                        <span className="text-foreground font-medium block mt-0.5">
                          {event.trigger_source}
                        </span>
                      </div>
                      <div>
                        FY:{" "}
                        <span className="text-foreground font-medium block mt-0.5">
                          {event.trigger_fy || event.report_fy}
                        </span>
                      </div>
                      {event.detail?.issueCount !== undefined && (
                        <div className="col-span-2">
                          Review items:{" "}
                          <span className="text-foreground font-medium">
                            {event.detail.issueCount}
                          </span>
                        </div>
                      )}
                    </div>
                    {event.detail?.issues?.length ? (
                      <details className="mt-3 group">
                        <summary className="cursor-pointer text-xs font-medium text-primary hover:underline">
                          Review {event.detail.issues.length} stored evidence item{event.detail.issues.length === 1 ? "" : "s"}
                        </summary>
                        <div className="mt-3 space-y-3 rounded-md border bg-muted/20 p-3">
                          {event.detail.issues.map((issue, issueIndex) => (
                            <div key={`${issue.kind}-${issue.stateCanon}-${issue.customer ?? issueIndex}`} className="border-b last:border-0 pb-3 last:pb-0">
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <IssueKindBadge kind={issue.kind} />
                                <span className="font-medium">{issue.stateCanon}</span>
                                <span className="text-muted-foreground">FY{issue.fiscalYear}</span>
                              </div>
                              <IssueDetails issue={issue} />
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                    {event.detail?.concentrationWarnings?.length ? (
                      <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                        {event.detail.concentrationWarnings.map((warning) => (
                          <div key={`${warning.fiscalYear}-${warning.customer}`}>
                            <span className="font-medium">{warning.customer}</span>: {formatCurrency(warning.customerNetAmount)} / {formatCurrency(warning.stateNetAmount)} ({warning.sharePercent.toFixed(1)}%) in FY{warning.fiscalYear}.
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
