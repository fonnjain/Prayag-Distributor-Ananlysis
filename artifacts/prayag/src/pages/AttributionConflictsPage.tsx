import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  UserX,
  Clock,
  Database,
  Crosshair,
  GitMerge,
  FileWarning,
  ShieldCheck,
  Building2,
  Calendar,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

// ── Types ─────────────────────────────────────────────────────────────────

type Pair = { head: string; rows: number; net: number };

interface SelectionAudit {
  fyLabelRows: number;
  fyLabelNet: number;
  rawDateRows: number;
  rawDateNet: number;
  bothRows: number;
  labelOnlyRows: number;
  dateOnlyRows: number;
}

interface ValidationState {
  state: string;
  packCustomers: number;
  registerCustomers: number;
  agreementCount: number;
  disagreementCount: number;
  status: "matched" | "conflicts";
}

interface Conflict {
  state: string;
  customer: string;
  cities: string[];
  workbookHeads: Pair[];
  derivedRegisterHeads: Array<{ head: string; net: number }>;
  workbookRows: number;
  workbookNet: number;
  registerNet: number;
  departedWorkbookHeads: string[];
}

interface DepartedReview {
  head: string;
  workbookRows: number;
  workbookNet: number;
  linkedConflictCount: number;
  linkedCustomers: Array<{ customer: string; state: string; workbookNet: number }>;
  decisionPrompt: string;
}

interface AttributionConflictsPayload {
  generatedAt: string;
  readOnly: true;
  fy: string;
  basis: { selection: string; detail: string; rawDates: string };
  selectionAudit: SelectionAudit;
  validationStates: ValidationState[];
  conflicts: Conflict[];
  departedReview: DepartedReview[];
  duplicateSourceLines: any[];
  futureRows: any[];
  institutionalConflict: any[];
}

// ── Formatters ────────────────────────────────────────────────────────────

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || isNaN(Number(value))) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function formatDate(val: any) {
  if (!val) return "—";
  try {
    return new Date(val).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return String(val);
  }
}

// ── Components ────────────────────────────────────────────────────────────

function DynamicRow({ item }: { item: any }) {
  if (!item || typeof item !== "object") {
    return <div className="p-3 border-b text-xs">{String(item)}</div>;
  }

  return (
    <div className="p-4 border-b hover:bg-muted/40 transition-colors text-xs flex flex-wrap gap-x-6 gap-y-3">
      {Object.entries(item).map(([k, v]) => {
        if (v === null || v === undefined) return null;
        return (
          <div key={k} className="flex flex-col">
            <span className="text-[10px] uppercase text-muted-foreground tracking-wider mb-0.5">
              {k.replace(/([A-Z])/g, " $1").trim()}
            </span>
            <span className="font-medium text-foreground truncate max-w-[250px]" title={String(v)}>
              {String(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────

export default function AttributionConflictsPage() {
  const { data, isLoading, error } = useQuery<AttributionConflictsPayload>({
    queryKey: ["attribution-conflicts"],
    queryFn: async () => {
      const res = await fetch("/api/org/attribution-conflicts");
      if (!res.ok) throw new Error("Failed to fetch conflicts data");
      return res.json();
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-slate-50/50 dark:bg-background">
        <div className="px-6 py-5 border-b bg-card animate-pulse">
          <div className="h-7 w-64 bg-muted rounded mb-2" />
          <div className="h-4 w-96 bg-muted rounded" />
        </div>
        <div className="p-6 space-y-8 flex-1">
          <div className="h-28 bg-muted/40 rounded-xl animate-pulse max-w-4xl" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-[500px] bg-muted/40 rounded-xl animate-pulse" />
            <div className="h-[500px] bg-muted/40 rounded-xl animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full bg-slate-50/50 dark:bg-background items-center justify-center p-6">
        <div className="p-8 border border-destructive/20 bg-destructive/10 rounded-xl text-center max-w-md shadow-sm">
          <FileWarning className="h-10 w-10 text-destructive mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-destructive mb-2">Error Loading Audit Data</h2>
          <p className="text-sm text-destructive/80">{error.message}</p>
        </div>
      </div>
    );
  }

  const payload: Partial<AttributionConflictsPayload> = data ?? {};

  // ── Render Helpers ──────────────────────────────────────────────────────

  const renderSelectionAudit = (audit: SelectionAudit | undefined) => {
    if (!audit) return null;
    const measures = [
      { label: "FY-label rows", value: new Intl.NumberFormat("en-IN").format(audit.fyLabelRows) },
      { label: "FY-label value", value: formatCurrency(audit.fyLabelNet) },
      { label: "Rows matching both", value: new Intl.NumberFormat("en-IN").format(audit.bothRows) },
      { label: "Date-only audit rows", value: new Intl.NumberFormat("en-IN").format(audit.dateOnlyRows) },
    ];
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {measures.map(({ label, value }) => (
          <div
            key={label}
            className="border rounded-xl bg-card p-5 shadow-sm hover:border-indigo-500/30 hover:shadow-md transition-all duration-300"
          >
            <div className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-medium">
              {label}
            </div>
            <div className="text-2xl font-bold text-foreground tracking-tight">{value}</div>
          </div>
        ))}
      </div>
    );
  };

  const renderValidationStates = (states: ValidationState[]) => {
    if (!states?.length) return null;
    return (
      <div className="mb-6 flex flex-wrap gap-2.5">
        {states.map((s) => {
          const isError = s.status === "conflicts";
          return (
            <Badge
              key={s.state}
              variant="outline"
              className={cn(
                "px-3 py-1.5 text-xs font-medium border shadow-sm",
                isError
                  ? "bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-900"
                  : "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900"
              )}
            >
              <span className="truncate max-w-[140px]">{s.state}</span>
              <span className="ml-2 px-1.5 py-0.5 rounded-full bg-background/50 text-[10px] tabular-nums font-bold">
                {s.agreementCount}/{s.agreementCount + s.disagreementCount} agree
              </span>
            </Badge>
          );
        })}
      </div>
    );
  };

  const renderDepartedReview = (departedReview: DepartedReview[]) => {
    if (!departedReview || departedReview.length === 0) {
      return (
        <div className="p-12 text-center text-muted-foreground text-sm flex flex-col items-center gap-3">
          <UserX className="h-8 w-8 opacity-20" />
          No departed head conflicts detected.
        </div>
      );
    }
    return (
      <div className="divide-y">
        {departedReview.map((item) => (
          <section key={item.head} className="p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h4 className="font-semibold text-foreground">{item.head}</h4>
                <p className="text-xs text-muted-foreground mt-1">Workbook attribution retained for review, not proof of active booking.</p>
              </div>
              <div className="text-right shrink-0">
                <div className="font-semibold text-rose-700 dark:text-rose-400">{formatCurrency(item.workbookNet)}</div>
                <div className="text-[10px] text-muted-foreground">{item.workbookRows} rows</div>
              </div>
            </div>
            <p className="text-xs bg-rose-50 dark:bg-rose-950/30 border border-rose-100 dark:border-rose-900/60 rounded-md p-2.5 text-rose-900 dark:text-rose-200">
              {item.decisionPrompt}
            </p>
            <div className="text-xs">
              <span className="font-semibold">{item.linkedConflictCount} linked customer conflict{item.linkedConflictCount === 1 ? "" : "s"}:</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {item.linkedCustomers.map((customer) => (
                  <span key={`${customer.state}-${customer.customer}`} className="rounded bg-muted px-2 py-1 text-[11px]">
                    {customer.customer} <span className="text-muted-foreground">({customer.state}, {formatCurrency(customer.workbookNet)})</span>
                  </span>
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>
    );
  };

  const renderConflicts = (conflicts: Conflict[]) => {
    if (!conflicts || conflicts.length === 0) {
      return (
        <div className="p-12 text-center text-muted-foreground text-sm flex flex-col items-center gap-3">
          <GitMerge className="h-8 w-8 opacity-20" />
          No attribution conflicts detected.
        </div>
      );
    }
    return (
      <table className="w-full text-left text-sm whitespace-nowrap">
        <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground sticky top-0 backdrop-blur-md z-10 border-b">
          <tr>
            <th className="px-5 py-3 font-semibold">Customer</th>
            <th className="px-5 py-3 font-semibold">Derived register ownership</th>
            <th className="px-5 py-3 font-semibold">Workbook attribution</th>
            <th className="px-5 py-3 font-semibold text-right">Rows / value</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {conflicts.map((item) => {
            return (
              <tr key={`${item.state}-${item.customer}`} className="hover:bg-muted/40 transition-colors group">
                <td className="px-5 py-3">
                  <div className="font-medium text-foreground truncate max-w-[180px]" title={item.customer}>
                    {item.customer}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{item.state}{item.cities.length ? ` · ${item.cities.join(", ")}` : ""}</div>
                </td>
                <td className="px-5 py-3">
                  <span className="inline-flex items-center rounded-md bg-emerald-50 dark:bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 ring-1 ring-inset ring-emerald-600/20">
                    {item.derivedRegisterHeads.map((head) => head.head).join(", ")}
                  </span>
                </td>
                <td className="px-5 py-3">
                  <span className="inline-flex items-center rounded-md bg-amber-50 dark:bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400 ring-1 ring-inset ring-amber-600/20">
                    {item.workbookHeads.map((head) => head.head).join(", ")}
                  </span>
                </td>
                <td className="px-5 py-3 text-right text-foreground font-mono font-medium">
                  <div>{item.workbookRows} rows</div>
                  <div className="text-xs">{formatCurrency(item.workbookNet)}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  const renderDuplicates = (duplicates: any[]) => {
    if (!duplicates?.length) return null;
    return (
      <div className="mt-6 border rounded-xl bg-card shadow-sm overflow-hidden hover:shadow-md transition-shadow duration-300">
        <div className="bg-violet-50/50 dark:bg-violet-950/20 px-5 py-4 border-b flex items-center gap-2.5">
          <div className="p-1.5 bg-violet-100 dark:bg-violet-900/50 rounded-md">
            <Database className="h-4 w-4 text-violet-700 dark:text-violet-400" />
          </div>
          <h3 className="font-semibold text-violet-900 dark:text-violet-200">Duplicate Source Lines</h3>
        </div>
        <div className="p-0 overflow-auto max-h-[350px]">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground sticky top-0 backdrop-blur-md z-10 border-b">
              <tr>
                <th className="px-5 py-3 font-semibold">Source</th>
                <th className="px-5 py-3 font-semibold">Line Ref</th>
                <th className="px-5 py-3 font-semibold">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {duplicates.map((dup, i) => (
                <tr key={i} className="hover:bg-muted/40 transition-colors">
                  <td className="px-5 py-3 text-muted-foreground font-medium">
                    {dup.files?.join(", ") || dup.source || dup.file || "Unknown"}
                  </td>
                  <td className="px-5 py-3 font-mono text-xs whitespace-normal min-w-56">
                    {dup.sourceLines?.join(", ") || dup.lineRef || dup.row || dup.id || "—"}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap gap-3">
                      {Object.entries(dup)
                        .filter(([k]) => !["source", "file", "files", "sourceLines", "lineRef", "row", "id"].includes(k))
                        .map(([k, v]) => (
                          <div key={k} className="text-[11px]">
                            <span className="text-muted-foreground uppercase tracking-wider mr-1">
                              {k.replace(/([A-Z])/g, " $1").trim()}:
                            </span>
                            <span className="font-medium text-foreground">{String(v)}</span>
                          </div>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderInstitutional = (inst: any[]) => {
    if (!inst?.length) return null;
    return (
      <div className="mt-6 border rounded-xl bg-card shadow-sm overflow-hidden hover:shadow-md transition-shadow duration-300">
        <div className="bg-blue-50/50 dark:bg-blue-950/20 px-5 py-4 border-b flex items-center gap-2.5">
          <div className="p-1.5 bg-blue-100 dark:bg-blue-900/50 rounded-md">
            <Building2 className="h-4 w-4 text-blue-700 dark:text-blue-400" />
          </div>
          <h3 className="font-semibold text-blue-900 dark:text-blue-200">PROJECT / OTHER conflict</h3>
        </div>
        <div className="p-5 space-y-4">
          {inst.map((item, i) => (
            <div key={i} className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border bg-amber-50/50 dark:bg-amber-950/20 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Workbook pack</div>
                  <div className="font-semibold mt-1">{formatCurrency(item.workbookNet)}</div>
                  <div className="text-xs text-muted-foreground">{item.workbookRows} rows</div>
                </div>
                <div className="rounded-lg border bg-blue-50/50 dark:bg-blue-950/20 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Broader register unowned bucket</div>
                  <div className="font-semibold mt-1">{formatCurrency(item.registerNet)}</div>
                  <div className="text-xs text-muted-foreground">{item.registerRows} rows</div>
                </div>
              </div>
              <p className="text-xs text-blue-900 dark:text-blue-200 border border-blue-100 dark:border-blue-900/60 rounded-md bg-blue-50/60 dark:bg-blue-950/20 p-2.5">
                Broader register gap: {formatCurrency(item.netGap)}. {item.comparisonNote} {item.exception}
              </p>
              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Workbook labels: </span>
                {(item.workbookBreakdown ?? []).map((row: Pair) => `${row.head} (${row.rows} rows, ${formatCurrency(row.net)})`).join(" · ") || "None"}
              </div>
              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Register labels: </span>
                {(item.registerBreakdown ?? []).map((row: Pair) => `${row.head} (${row.rows} rows, ${formatCurrency(row.net)})`).join(" · ") || "None"}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderFutureRows = (rows: any[]) => {
    if (!rows?.length) return null;
    return (
      <div className="mt-6 border rounded-xl bg-card shadow-sm overflow-hidden hover:shadow-md transition-shadow duration-300">
        <div className="bg-slate-100/80 dark:bg-slate-900/50 px-5 py-4 border-b flex items-center gap-2.5">
          <div className="p-1.5 bg-slate-200 dark:bg-slate-800 rounded-md">
            <Calendar className="h-4 w-4 text-slate-700 dark:text-slate-400" />
          </div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-200">Future Rows</h3>
        </div>
        <div className="p-0 overflow-auto max-h-[350px]">
          <div className="divide-y">
            {rows.map((item, i) => (
              <DynamicRow key={i} item={item} />
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-50/50 dark:bg-background">
      {/* Header */}
      <div className="px-6 py-5 border-b bg-card shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-4 sticky top-0 z-20 shadow-sm">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2.5">
            <div className="p-1.5 bg-indigo-100 dark:bg-indigo-900/40 rounded-lg">
              <Crosshair className="h-5 w-5 text-indigo-700 dark:text-indigo-400" />
            </div>
            Attribution Conflicts
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-xl">
            Review State Head workbook attribution evidence against register-derived ownership. High-stakes read-only audit view.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {payload.fy && (
            <Badge variant="secondary" className="px-3 py-1 font-medium shadow-sm">
              FY {payload.fy}
            </Badge>
          )}
          {payload.readOnly && (
            <Badge
              variant="outline"
              className="px-3 py-1 font-medium text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-sm"
            >
              <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
              Read Only
            </Badge>
          )}
          {payload.generatedAt && (
            <div className="text-muted-foreground flex items-center gap-1.5 px-2 font-medium text-xs bg-muted/50 py-1.5 rounded-md border">
              <Clock className="h-3.5 w-3.5" />
              {formatDate(payload.generatedAt)}
            </div>
          )}
        </div>
      </div>

      {/* Main Scrollable Content */}
      <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6">
        <div className="max-w-[1600px] mx-auto space-y-8">
          {/* Top Indicators */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
            {payload.basis && (
              <div className="mb-5 rounded-lg border border-indigo-100 bg-indigo-50/60 p-3 text-xs text-indigo-950 dark:border-indigo-900/60 dark:bg-indigo-950/25 dark:text-indigo-100">
                <span className="font-semibold">{payload.basis.selection} basis: </span>
                {payload.basis.detail} {payload.basis.rawDates}
              </div>
            )}
            {renderValidationStates(payload.validationStates || [])}
            {renderSelectionAudit(payload.selectionAudit)}
          </div>

          {/* Primary Split View */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
            {/* Departed Review */}
            <div className="col-span-1 border rounded-xl bg-card shadow-sm overflow-hidden flex flex-col hover:shadow-md transition-shadow duration-300 animate-in fade-in slide-in-from-bottom-3 duration-500 delay-100">
              <div className="bg-rose-50/50 dark:bg-rose-950/30 px-5 py-4 border-b flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 bg-rose-100 dark:bg-rose-900/50 rounded-md">
                    <UserX className="h-4 w-4 text-rose-700 dark:text-rose-400" />
                  </div>
                  <h3 className="font-semibold text-rose-900 dark:text-rose-200">
                    Departed Head Review
                  </h3>
                </div>
                <Badge
                  variant="outline"
                  className="text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-800 bg-white/50 dark:bg-black/20 font-semibold"
                >
                  {payload.departedReview?.length || 0} Records
                </Badge>
              </div>
              <div className="p-0 overflow-auto max-h-[550px] relative">
                {renderDepartedReview(payload.departedReview || [])}
              </div>
            </div>

            {/* Attribution Conflicts */}
            <div className="col-span-1 border rounded-xl bg-card shadow-sm overflow-hidden flex flex-col hover:shadow-md transition-shadow duration-300 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
              <div className="bg-amber-50/50 dark:bg-amber-950/30 px-5 py-4 border-b flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 bg-amber-100 dark:bg-amber-900/50 rounded-md">
                    <GitMerge className="h-4 w-4 text-amber-700 dark:text-amber-400" />
                  </div>
                  <h3 className="font-semibold text-amber-900 dark:text-amber-200">
                    Active Conflicts
                  </h3>
                </div>
                <Badge
                  variant="outline"
                  className="text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800 bg-white/50 dark:bg-black/20 font-semibold"
                >
                  {payload.conflicts?.length || 0} Issues
                </Badge>
              </div>
              <div className="p-0 overflow-auto max-h-[550px] relative">
                {renderConflicts(payload.conflicts || [])}
              </div>
            </div>
          </div>

          {/* Secondary Views */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start animate-in fade-in slide-in-from-bottom-5 duration-500 delay-300">
            <div className="space-y-6">
              {payload.institutionalConflict &&
                payload.institutionalConflict.length > 0 &&
                renderInstitutional(payload.institutionalConflict)}
            </div>
            <div className="space-y-6">
              {payload.duplicateSourceLines &&
                payload.duplicateSourceLines.length > 0 &&
                renderDuplicates(payload.duplicateSourceLines)}
              {payload.futureRows &&
                payload.futureRows.length > 0 &&
                renderFutureRows(payload.futureRows)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
