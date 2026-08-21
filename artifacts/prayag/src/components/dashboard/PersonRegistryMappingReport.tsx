import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Search, ShieldCheck, UserCheck, UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type MappingStatus =
  | "automatic_candidate"
  | "employee_code_conflict"
  | "manager_conflict"
  | "ambiguous_name"
  | "insufficient_manager_evidence"
  | "no_name_candidate";

interface Candidate {
  personId: number;
  name: string;
  employeeCode: string | null;
  isActive: boolean;
  reportsToName: string | null;
  stateHeadName: string | null;
}

interface Resolution {
  decision: "linked" | "unresolved";
  effectiveDate: string;
  reason: string;
  changedBy: string;
  createdAt: string;
}

interface ReportRow {
  registryId: number;
  canonicalName: string;
  registryEmployeeCode: string | null;
  reportingManager: string | null;
  registryStateHead: string | null;
  hrStatus: string | null;
  status: MappingStatus;
  reviewRoute: string;
  candidatePeople: Candidate[];
  employeeCodeEvidence: string;
  resolution: Resolution | null;
  managerComparison: {
    registryManager: string | null;
    operationalManager: string | null;
    agrees: boolean | null;
  };
}

interface MappingReport {
  generatedAt: string;
  summary: {
    registryPersonRows: number;
    linkedRows: number;
    unmappedRows: number;
    automaticCandidates: number;
    reviewQueue: number;
    managerConflicts: number;
    unmappedManagerConflicts: number;
    resolvedDecisions: number;
    byStatus: Record<MappingStatus, number>;
  };
  rows: ReportRow[];
  managerConflicts: Array<ReportRow & { mappingScope: "linked" | "unmapped" }>;
  resolvedRows: ReportRow[];
  routeCounts: Array<{ stateHead: string; count: number }>;
}

interface PeopleResponse {
  people: Array<{
    person_id: number;
    name: string;
    employee_code: string | null;
    reports_to_name: string | null;
    is_active: boolean;
    is_holding: boolean;
  }>;
}

interface Preview {
  registry: {
    id: number;
    canonicalName: string;
    reportingManager: string | null;
    employeeCode: string | null;
    currentPersonId: number | null;
    currentPersonName: string | null;
  };
  decision: "linked" | "unresolved";
  person: {
    personId: number;
    name: string;
    employeeCode: string | null;
    reportsToName: string | null;
  } | null;
  effectiveDate: string;
  impact: {
    selectedPersonDirectReports: number;
    selectedPersonCustomers: number;
    historicalFactsChanged: { saleLine: 0; secondarySkuLine: 0; marginFact: 0 };
    hierarchy: { valid: boolean; selfLinkPersonIds: number[]; cyclePersonIds: number[] };
    proposalHash: string;
  };
}

const statusLabel: Record<MappingStatus, string> = {
  automatic_candidate: "Automatic candidate",
  employee_code_conflict: "Code conflict",
  manager_conflict: "Manager conflict",
  ambiguous_name: "Ambiguous name",
  insufficient_manager_evidence: "Needs manager evidence",
  no_name_candidate: "No People match",
};

function statusClass(status: MappingStatus): string {
  if (status === "automatic_candidate") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "manager_conflict" || status === "employee_code_conflict") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

function isActiveManagerConflict(row: ReportRow): boolean {
  return row.managerComparison.agrees === false
    && row.hrStatus?.trim().toLowerCase() === "active";
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function fetchReport(headers?: HeadersInit): Promise<MappingReport> {
  return requestJson<MappingReport>("/api/person-registry/report", headers ? { headers } : undefined);
}

interface Props {
  adminSecret: string;
}

/**
 * Relationship evidence is always read-only until an authenticated admin opens
 * the dedicated review dialog. A candidate is merely pre-filled evidence: no
 * record is linked until the operator previews and confirms one decision.
 */
export function PersonRegistryMappingReport({ adminSecret }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<"all" | "review" | "automatic">("review");
  const [managerConflictScope, setManagerConflictScope] = useState<"all" | "active" | "historical">("all");
  const [selectedRow, setSelectedRow] = useState<ReportRow | null>(null);
  const [target, setTarget] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const headers = useMemo(
    () => ({ "Content-Type": "application/json", "X-Admin-Secret": adminSecret }),
    [adminSecret],
  );
  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["person-registry-mapping-report", Boolean(adminSecret)],
    queryFn: () => fetchReport(adminSecret ? headers : undefined),
    staleTime: 30_000,
  });
  const { data: peopleData } = useQuery<PeopleResponse>({
    queryKey: ["master-people", "relationship-review"],
    queryFn: () => requestJson<PeopleResponse>("/api/master/people?active=true&limit=200", { headers }),
    enabled: Boolean(adminSecret),
    staleTime: 30_000,
  });

  const reviewRows = useMemo(() => {
    const unique = new Map<number, ReportRow>();
    for (const row of data?.rows ?? []) unique.set(row.registryId, row);
    for (const row of data?.managerConflicts ?? []) unique.set(row.registryId, row);
    for (const row of data?.resolvedRows ?? []) unique.set(row.registryId, row);
    const query = search.trim().toLowerCase();
    return [...unique.values()].filter((row) => {
      if (managerConflictScope !== "all") {
        if (row.managerComparison.agrees !== false) return false;
        if (managerConflictScope === "active" && !isActiveManagerConflict(row)) return false;
        if (managerConflictScope === "historical" && isActiveManagerConflict(row)) return false;
      }
      if (show === "review" && row.status === "automatic_candidate") return false;
      if (show === "automatic" && row.status !== "automatic_candidate") return false;
      if (!query) return true;
      return [
        row.canonicalName,
        row.reportingManager,
        row.registryStateHead,
        row.reviewRoute,
        ...row.candidatePeople.map((candidate) => candidate.name),
      ].some((value) => value?.toLowerCase().includes(query));
    });
  }, [data?.managerConflicts, data?.resolvedRows, data?.rows, managerConflictScope, search, show]);

  const managerConflictCounts = useMemo(() => {
    const conflicts = data?.managerConflicts ?? [];
    const active = conflicts.filter(isActiveManagerConflict).length;
    return { active, historical: conflicts.length - active };
  }, [data?.managerConflicts]);

  const people = useMemo(() => {
    const unique = new Map<number, Candidate>();
    for (const person of peopleData?.people ?? []) {
      if (!person.is_active || person.is_holding) continue;
      unique.set(person.person_id, {
        personId: person.person_id,
        name: person.name,
        employeeCode: person.employee_code,
        isActive: person.is_active,
        reportsToName: person.reports_to_name,
        stateHeadName: null,
      });
    }
    for (const candidate of selectedRow?.candidatePeople ?? []) unique.set(candidate.personId, candidate);
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [peopleData?.people, selectedRow?.candidatePeople]);

  const previewMutation = useMutation({
    mutationFn: () => {
      if (!selectedRow || !target) throw new Error("Choose a People record or leave this record unresolved");
      const personId = target === "unresolved" ? "unresolved" : target;
      const params = new URLSearchParams({ personId, effectiveDate });
      return requestJson<Preview>(`/api/person-registry/${selectedRow.registryId}/relationship-preview?${params}`, { headers });
    },
    onSuccess: (result) => {
      setPreview(result);
      setAcknowledged(false);
    },
    onError: (e: Error) => toast({ title: "Preview unavailable", description: e.message, variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: () => {
      if (!selectedRow || !preview) throw new Error("Preview this decision first");
      return requestJson<{ success: boolean }>(`/api/person-registry/${selectedRow.registryId}/relationship-resolution`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          personId: target === "unresolved" ? null : Number(target),
          effectiveDate,
          reason,
          acknowledgedProposalHash: preview.impact.proposalHash,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person-registry-mapping-report"] });
      qc.invalidateQueries({ queryKey: ["master-people"] });
      qc.invalidateQueries({ queryKey: ["master-person"] });
      setSelectedRow(null);
      setPreview(null);
      setReason("");
      setTarget("");
      toast({ title: "Relationship decision saved", description: "The registry link and its audit record were updated. Historical facts were not changed." });
    },
    onError: (e: Error) => {
      if (e.message.toLowerCase().includes("preview changed")) {
        setPreview(null);
        setAcknowledged(false);
      }
      toast({ title: "Relationship was not saved", description: e.message, variant: "destructive" });
    },
  });

  const openReview = (row: ReportRow) => {
    setSelectedRow(row);
    setTarget(row.candidatePeople.length === 1 ? String(row.candidatePeople[0].personId) : "");
    setEffectiveDate(today());
    setReason("");
    setPreview(null);
    setAcknowledged(false);
  };

  if (isLoading) return <div className="py-10 text-sm text-muted-foreground">Loading relationship evidence…</div>;
  if (error || !data) {
    return <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      Could not load relationship evidence: {error instanceof Error ? error.message : "Unknown error"}
    </div>;
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-5 text-sky-700" />
            <div>
              <h2 className="font-semibold text-sky-950">Relationship evidence review</h2>
              <p className="mt-1 max-w-3xl text-sm text-sky-900">
                HR names, employee codes, and reporting-manager text are evidence only. A People link is never applied automatically.
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`mr-1.5 size-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
        {!adminSecret && (
          <p className="mt-3 rounded-md border border-sky-200 bg-white/70 px-3 py-2 text-xs text-sky-900">
            Unlock administrator access on the People tab to preview and record a relationship decision.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        {[
          ["Registry people", data.summary.registryPersonRows, "Source records"],
          ["Already linked", data.summary.linkedRows, "Current canonical links"],
          ["Review queue", data.summary.reviewQueue, "Requires a decision"],
          ["Active manager conflicts", managerConflictCounts.active, "Prioritise operational follow-up"],
          ["Historical manager conflicts", managerConflictCounts.historical, "Deactive HR records; tidy separately"],
          ["Automatic candidates", data.summary.automaticCandidates, "Still require confirmation"],
        ].map(([label, value, note]) => (
          <div key={label} className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{Number(value).toLocaleString("en-IN")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{note}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search HR name, manager, State Head, or People candidate…" className="h-8 pl-8 text-sm" />
        </div>
        {(["review", "automatic", "all"] as const).map((value) => (
          <Button key={value} size="sm" variant={show === value && managerConflictScope === "all" ? "default" : "outline"} onClick={() => {
            setShow(value);
            setManagerConflictScope("all");
          }}>
            {value === "review" ? "Needs review" : value === "automatic" ? "Automatic candidates" : "All"}
          </Button>
        ))}
        <span className="ml-1 text-xs font-medium text-muted-foreground">Manager conflicts:</span>
        <Button
          size="sm"
          variant={managerConflictScope === "active" ? "default" : "outline"}
          onClick={() => setManagerConflictScope("active")}
        >
          Active ({managerConflictCounts.active})
        </Button>
        <Button
          size="sm"
          variant={managerConflictScope === "historical" ? "default" : "outline"}
          onClick={() => setManagerConflictScope("historical")}
        >
          Historical / deactive ({managerConflictCounts.historical})
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">HR record</th>
                <th className="px-4 py-3 font-medium">Evidence</th>
                <th className="px-4 py-3 font-medium">People candidates</th>
                <th className="px-4 py-3 font-medium">Operational manager</th>
                <th className="px-4 py-3 font-medium">Decision</th>
                <th className="px-4 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {reviewRows.map((row) => (
                <tr key={row.registryId} className="align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium">{row.canonicalName}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">HR manager: {row.reportingManager || "—"}</p>
                     {row.managerComparison.agrees === false && (
                       <p className="mt-0.5 text-xs text-muted-foreground">
                         HR status: {row.hrStatus || "Not supplied"}
                       </p>
                     )}
                    <p className="mt-0.5 text-xs text-muted-foreground">Route: {row.reviewRoute}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className={statusClass(row.status)}>{statusLabel[row.status]}</Badge>
                    <p className="mt-1 text-xs text-muted-foreground">Code: {row.employeeCodeEvidence.replaceAll("_", " ")}</p>
                  </td>
                  <td className="px-4 py-3">
                    {row.candidatePeople.length ? row.candidatePeople.map((candidate) => (
                      <p key={candidate.personId} className="text-xs">
                        <span className="font-medium">{candidate.name}</span>{candidate.reportsToName ? ` → ${candidate.reportsToName}` : ""}
                      </p>
                    )) : <span className="text-xs text-muted-foreground">No normalized-name candidate</span>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <p>HR: {row.managerComparison.registryManager || "—"}</p>
                    <p>People: {row.managerComparison.operationalManager || "—"}</p>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {row.resolution ? (
                      <>
                        <Badge variant="secondary">{row.resolution.decision === "unresolved" ? "Left unresolved" : "Resolved"}</Badge>
                        <p className="mt-1 text-muted-foreground">Effective {row.resolution.effectiveDate}</p>
                      </>
                    ) : <span className="text-muted-foreground">No decision recorded</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="outline" disabled={!adminSecret} onClick={() => openReview(row)}>
                      <UserCheck className="mr-1.5 size-3.5" /> Review
                    </Button>
                  </td>
                </tr>
              ))}
              {!reviewRows.length && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No rows match this view.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2"><UsersRound className="size-4 text-muted-foreground" /><h3 className="font-semibold">Review queue by State Head</h3></div>
          <p className="mt-1 text-xs text-muted-foreground">Routing follows the HR registry’s stated State Head; it is not inferred or corrected.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {data.routeCounts.map((route) => <div key={route.stateHead} className="flex items-center justify-between gap-3 text-sm"><span className="truncate">{route.stateHead}</span><Badge variant="secondary" className="tabular-nums">{route.count}</Badge></div>)}
          </div>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-center gap-2 text-emerald-950"><CheckCircle2 className="size-4 text-emerald-700" /><h3 className="font-semibold">Safeguards on every decision</h3></div>
          <ul className="mt-2 space-y-1 text-sm text-emerald-900">
            <li>• A reason, effective date, admin access, and signed-in operator are required.</li>
            <li>• The live impact preview is hash-bound and rechecked when saved.</li>
            <li>• Self-links and manager cycles block the save; HR source text is never edited.</li>
            <li>• sale_line, secondary_sku_line, and margin_fact remain unchanged.</li>
          </ul>
        </div>
      </div>

      <Dialog open={!!selectedRow} onOpenChange={(open) => { if (!open && !resolveMutation.isPending) setSelectedRow(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Resolve People relationship</DialogTitle>
            <DialogDescription>
              {selectedRow?.canonicalName}: choose the canonical People record, or explicitly retain this HR record as unresolved. This does not rewrite HR source text or historical facts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p><span className="font-medium">HR reporting manager:</span> {selectedRow?.reportingManager || "—"}</p>
              <p className="mt-1"><span className="font-medium">Employee-code evidence:</span> {selectedRow?.employeeCodeEvidence.replaceAll("_", " ")}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Canonical People record</Label>
                <Select value={target} onValueChange={(value) => { setTarget(value); setPreview(null); setAcknowledged(false); }}>
                  <SelectTrigger><SelectValue placeholder="Select a People record…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unresolved">Leave explicitly unresolved</SelectItem>
                    {people.map((person) => <SelectItem key={person.personId} value={String(person.personId)}>{person.name}{person.reportsToName ? ` · reports to ${person.reportsToName}` : ""}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="relationship-effective-date">Effective date</Label>
                <Input id="relationship-effective-date" type="date" max={today()} value={effectiveDate} onChange={(event) => { setEffectiveDate(event.target.value); setPreview(null); setAcknowledged(false); }} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="relationship-reason">Reason</Label>
              <Input id="relationship-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this the correct operational relationship?" />
            </div>
            <Button type="button" variant="outline" onClick={() => previewMutation.mutate()} disabled={!target || !effectiveDate || previewMutation.isPending}>
              {previewMutation.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />} Preview impact
            </Button>
            {preview && (
              <div className={`rounded-md border p-3 text-sm ${preview.impact.hierarchy.valid ? "border-emerald-200 bg-emerald-50" : "border-destructive/40 bg-destructive/5"}`}>
                <p className="font-medium">{preview.decision === "unresolved" ? "This record will remain unlinked." : `This will link to ${preview.person?.name}.`}</p>
                <p className="mt-1 text-muted-foreground">Selected People scope: {preview.impact.selectedPersonDirectReports} direct report(s), {preview.impact.selectedPersonCustomers} active customer assignment(s).</p>
                <p className="mt-1 text-muted-foreground">Historical facts changed: sale_line 0 · secondary_sku_line 0 · margin_fact 0.</p>
                {!preview.impact.hierarchy.valid && <p className="mt-2 font-medium text-destructive">The operational hierarchy has a self-link or cycle and must be corrected before this decision can be saved.</p>}
                {preview.impact.hierarchy.valid && (
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs">
                    <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5" />
                    <span>I reviewed this live impact preview. I understand this creates an audit record and does not alter HR source fields or historical facts.</span>
                  </label>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSelectedRow(null)} disabled={resolveMutation.isPending}>Cancel</Button>
            <Button disabled={!preview || !preview.impact.hierarchy.valid || !acknowledged || !reason.trim() || resolveMutation.isPending} onClick={() => resolveMutation.mutate()}>
              {resolveMutation.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />} Save decision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}