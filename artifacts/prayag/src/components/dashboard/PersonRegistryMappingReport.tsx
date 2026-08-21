import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, Search, ShieldCheck, UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

interface ReportRow {
  registryId: number;
  canonicalName: string;
  registryEmployeeCode: string | null;
  reportingManager: string | null;
  registryStateHead: string | null;
  status: MappingStatus;
  reviewRoute: string;
  candidatePeople: Candidate[];
  employeeCodeEvidence: string;
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
    byStatus: Record<MappingStatus, number>;
  };
  rows: ReportRow[];
  managerConflicts: Array<ReportRow & { mappingScope: "linked" | "unmapped" }>;
  routeCounts: Array<{ stateHead: string; count: number }>;
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

async function fetchReport(): Promise<MappingReport> {
  const response = await fetch("/api/person-registry/report");
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<MappingReport>;
}

/**
 * Evidence-only review surface. It never sends an admin secret or a mutation:
 * later editor work must make any proposed relationship change separately.
 */
export function PersonRegistryMappingReport() {
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<"all" | "review" | "automatic">("review");
  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["person-registry-mapping-report"],
    queryFn: fetchReport,
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const rows = data?.rows ?? [];
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
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
  }, [data?.rows, search, show]);

  if (isLoading) {
    return <div className="py-10 text-sm text-muted-foreground">Loading relationship evidence…</div>;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
        Could not load the mapping report: {error.message}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-sky-200 bg-sky-50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-5 text-sky-700" />
            <div>
              <h2 className="font-semibold text-sky-950">Relationship evidence review</h2>
              <p className="mt-1 max-w-3xl text-sm text-sky-900">
                This is a read-only go/no-go report. “Automatic candidate” means a single
                People match agrees with the HR manager; nothing has been linked or changed.
                Employee codes only support that evidence and never decide identity alone.
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={`mr-1.5 size-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Registry people", data.summary.registryPersonRows, "All person registry records"],
          ["Already linked", data.summary.linkedRows, "Existing links; not changed here"],
          ["Unmapped", data.summary.unmappedRows, "Rows classified below"],
          ["Automatic candidates", data.summary.automaticCandidates, "Name + manager evidence"],
          ["Review queue", data.summary.reviewQueue, "Requires an operator decision"],
        ].map(([label, value, hint]) => (
          <div key={String(label)} className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString("en-IN")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="rounded-xl border bg-card">
          <div className="border-b p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold">Unmapped registry review</h3>
                <p className="text-sm text-muted-foreground">
                  {data.summary.unmappedManagerConflicts.toLocaleString("en-IN")} unmapped
                  HR-to-operational manager conflict{data.summary.unmappedManagerConflicts === 1 ? "" : "s"} are
                  separated below.
                </p>
              </div>
              <div className="flex rounded-md border p-0.5 text-xs">
                {(["review", "automatic", "all"] as const).map((option) => (
                  <button
                    key={option}
                    onClick={() => setShow(option)}
                    className={`rounded px-2.5 py-1.5 capitalize ${
                      show === option ? "bg-muted font-medium" : "text-muted-foreground"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
            <div className="relative mt-3 max-w-md">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search person, manager, or State Head"
                className="pl-9"
              />
            </div>
          </div>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="sticky top-0 bg-muted/80 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Registry person</th>
                  <th className="px-4 py-3 font-medium">Classification</th>
                  <th className="px-4 py-3 font-medium">People evidence</th>
                  <th className="px-4 py-3 font-medium">Manager evidence</th>
                  <th className="px-4 py-3 font-medium">Route</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((row) => (
                  <tr key={row.registryId} className="align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium">{row.canonicalName}</p>
                      <p className="text-xs text-muted-foreground">
                        HR code: {row.registryEmployeeCode || "—"} · {row.registryStateHead || "Unassigned"}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={statusClass(row.status)}>
                        {statusLabel[row.status]}
                      </Badge>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Code: {row.employeeCodeEvidence.replaceAll("_", " ")}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      {row.candidatePeople.length ? (
                        row.candidatePeople.map((candidate) => (
                          <p key={candidate.personId} className="text-xs">
                            <span className="font-medium">{candidate.name}</span>
                            {candidate.reportsToName ? ` → ${candidate.reportsToName}` : ""}
                          </p>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">No normalized-name candidate</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <p>HR: {row.managerComparison.registryManager || "—"}</p>
                      <p>Operational: {row.managerComparison.operationalManager || "—"}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="secondary">{row.reviewRoute}</Badge>
                    </td>
                  </tr>
                ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                      No rows match this view.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <UsersRound className="size-4 text-muted-foreground" />
              <h3 className="font-semibold">Review queue by State Head</h3>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Routing follows the registry’s stated State Head; it is not inferred or corrected.
            </p>
            <div className="mt-3 space-y-2">
              {data.routeCounts.map((route) => (
                <div key={route.stateHead} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{route.stateHead}</span>
                  <Badge variant="secondary" className="tabular-nums">{route.count}</Badge>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-rose-700" />
              <h3 className="font-semibold text-rose-950">Manager conflicts</h3>
            </div>
            <p className="mt-1 text-sm text-rose-900">
              {data.summary.managerConflicts.toLocaleString("en-IN")} records have a unique
              People name match but a different HR manager. They are not automatic candidates.
            </p>
            <p className="mt-2 text-xs text-rose-800">
              This includes {data.managerConflicts.filter((row) => row.mappingScope === "linked").length}
              {" "}already-linked records for relationship review; no operational hierarchy has been changed.
            </p>
          </div>

          <div className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <CheckCircle2 className="size-4 text-emerald-600" />
              Safe by design
            </div>
            <p className="mt-1">
              This report runs only read queries. It cannot create links, alter managers, or
              introduce hierarchy cycles.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}