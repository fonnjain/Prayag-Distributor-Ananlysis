// Organisation / People — Phase 2 people management.
//
// Layout: fixed-width left list | flexible right detail panel.
// Mutations: edit (name, emp code, designation, manager) + deactivate + reactivate.
// CRITICAL RULE: any operation that touches hierarchy (changing reports_to) or
// deactivates a person MUST go through the impact-preview gate before saving.
// The gate shows subTreeCount + totalCustomersAffected. Nothing saves without
// the user clicking the explicit confirmation button.
import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  Lock,
  Pencil,
  RefreshCw,
  Search,
  UserCheck,
  UserMinus,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { PersonRegistryPanel } from "@/components/dashboard/Organisation";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Designation {
  designation_id: number;
  name: string;
  rank: number;
}

interface PersonSummary {
  person_id: number;
  name: string;
  employee_code: string | null;
  designation_id: number | null;
  designation_name: string | null;
  designation_rank: number | null;
  reports_to_person_id: number | null;
  reports_to_name: string | null;
  is_state_head: boolean;
  is_active: boolean;
  direct_reports: number;
  customers_as_sh: number;
  customers_as_tm: number;
}

interface DirectReport {
  person_id: number;
  name: string;
  designation_name: string | null;
  is_active: boolean;
}

interface ChainEntry {
  person_id: number;
  name: string;
  designation_name: string | null;
  level: number;
}

interface Territory {
  territory_id: number;
  name: string;
  parent_name: string | null;
  effective_from: string;
  effective_to: string | null;
}

interface ChangeEntry {
  id: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_at: string;
}

interface PersonDetail extends PersonSummary {
  state_head_person_id: number | null;
  state_head_name: string | null;
  created_at: string;
  directReports: DirectReport[];
  reportingChain: ChainEntry[];
  territories: Territory[];
  changeLog: ChangeEntry[];
}

interface ImpactData {
  person: { person_id: number; name: string; is_active: boolean };
  directReports: Array<{ person_id: number; name: string; designation_name: string | null }>;
  subTreeCount: number;
  customersAsStateHead: number;
  customersAsTm: number;
  totalCustomersAffected: number;
}

interface PeopleResponse {
  people: PersonSummary[];
  total: number;
  page: number;
  pages: number;
}

// ── API helpers ───────────────────────────────────────────────────────────────

const BASE = "/api/master";

async function apiJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OrgPeoplePage() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── Tab ───────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"people" | "registry">("people");

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [secret, setSecret] = useState(
    () => sessionStorage.getItem("adminSecret") ?? "",
  );
  const [secretInput, setSecretInput] = useState("");
  const hdrs = useCallback(
    () => ({ "Content-Type": "application/json", "X-Admin-Secret": secret }),
    [secret],
  );

  // ── List filters ──────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("active");
  const [designationFilter, setDesignationFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // ── Edit / action state ───────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<{
    name: string;
    employee_code: string;
    designation_id: string;
    reports_to_person_id: string;
    reports_to_search: string;
    reports_to_open: boolean;
  }>({
    name: "",
    employee_code: "",
    designation_id: "",
    reports_to_person_id: "",
    reports_to_search: "",
    reports_to_open: false,
  });

  // ── State-head re-sync ───────────────────────────────────────────────────
  const [resyncState, setResyncState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle");
  const [resyncResult, setResyncResult] = useState<{
    personSync: { step1Updated: number; step2Updated: number } | null;
    updated: number;
    residual: { nullCount: number; total: number };
    fy: string;
  } | null>(null);

  async function handleResyncStateHead() {
    if (!secret) return;
    setResyncState("running");
    setResyncResult(null);
    try {
      const r = await fetch("/api/sku/backfill-state-canon?syncFromPerson=true", {
        method: "POST",
        headers: { "X-Admin-Secret": secret },
      });
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setResyncResult(data);
      setResyncState("done");
      toast({
        title: "State-head re-sync complete",
        description: `Registry rows synced: ${data.personSync?.step1Updated ?? 0} (members) + ${data.personSync?.step2Updated ?? 0} (state heads). SKU lines updated: ${data.updated}.`,
      });
    } catch (err) {
      setResyncState("error");
      toast({
        title: "Re-sync failed",
        description: String(err),
        variant: "destructive",
      });
    }
  }

  // Impact modal
  const [impactData, setImpactData] = useState<ImpactData | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [showImpactModal, setShowImpactModal] = useState(false);
  const [pendingAction, setPendingAction] = useState<"deactivate" | "move" | null>(null);

  // ── Queries ───────────────────────────────────────────────────────────────

  const { data: designations = [] } = useQuery<Designation[]>({
    queryKey: ["master-designations"],
    queryFn: () => apiJson(`${BASE}/designations`),
    staleTime: Infinity,
  });

  const peopleParams = new URLSearchParams({
    q: query,
    active: activeFilter === "all" ? "all" : activeFilter === "active" ? "true" : "false",
    limit: "200",
  });
  if (designationFilter !== "all") peopleParams.set("designation_id", designationFilter);

  const { data: peopleData, isLoading: listLoading, isError: listError } =
    useQuery<PeopleResponse>({
      queryKey: ["master-people", query, activeFilter, designationFilter],
      queryFn: () => apiJson(`${BASE}/people?${peopleParams}`),
      staleTime: 30_000,
    });

  const { data: detailData, isLoading: detailLoading } =
    useQuery<{ person: PersonDetail; directReports: DirectReport[]; reportingChain: ChainEntry[]; territories: Territory[]; changeLog: ChangeEntry[] }>({
      queryKey: ["master-person", selectedId],
      queryFn: () => apiJson(`${BASE}/people/${selectedId}`),
      enabled: selectedId !== null,
      staleTime: 30_000,
    });

  const person = detailData?.person ?? null;

  // Initialise edit form when person changes
  useEffect(() => {
    if (person && editMode) {
      setEditForm({
        name: person.name,
        employee_code: person.employee_code ?? "",
        designation_id: person.designation_id ? String(person.designation_id) : "",
        reports_to_person_id: person.reports_to_person_id ? String(person.reports_to_person_id) : "",
        reports_to_search: person.reports_to_name ?? "",
        reports_to_open: false,
      });
    }
  }, [person?.person_id, editMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mutations ─────────────────────────────────────────────────────────────

  const patchMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      return apiJson(`${BASE}/people/${selectedId}`, {
        method: "PATCH",
        headers: hdrs(),
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["master-person", selectedId] });
      qc.invalidateQueries({ queryKey: ["master-people"] });
      setEditMode(false);
      toast({ title: "Saved", description: "Person updated." });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const deactivateMutation = useMutation({
    mutationFn: async (body: { acknowledgedSubTree: number; acknowledgedCustomers: number }) => {
      return apiJson(`${BASE}/people/${selectedId}/deactivate`, {
        method: "POST",
        headers: hdrs(),
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["master-person", selectedId] });
      qc.invalidateQueries({ queryKey: ["master-people"] });
      toast({ title: "Deactivated", description: "Person has been deactivated." });
    },
    onError: (e: Error) => toast({ title: "Deactivation failed", description: e.message, variant: "destructive" }),
  });

  const reactivateMutation = useMutation({
    mutationFn: async () => {
      return apiJson(`${BASE}/people/${selectedId}/reactivate`, {
        method: "POST",
        headers: hdrs(),
        body: JSON.stringify({}),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["master-person", selectedId] });
      qc.invalidateQueries({ queryKey: ["master-people"] });
      toast({ title: "Reactivated", description: "Person has been reactivated." });
    },
    onError: (e: Error) => toast({ title: "Reactivation failed", description: e.message, variant: "destructive" }),
  });

  // ── Impact gate ───────────────────────────────────────────────────────────

  const fetchAndShowImpact = useCallback(
    async (action: "deactivate" | "move") => {
      if (!selectedId) return;
      setImpactLoading(true);
      try {
        const data = await apiJson<ImpactData>(`${BASE}/people/${selectedId}/impact`);
        setImpactData(data);
        setPendingAction(action);
        setShowImpactModal(true);
      } catch (e) {
        toast({
          title: "Could not load impact",
          description: (e as Error).message,
          variant: "destructive",
        });
      } finally {
        setImpactLoading(false);
      }
    },
    [selectedId, toast],
  );

  const handleDeactivateClick = () => fetchAndShowImpact("deactivate");

  const handleSave = async () => {
    if (!person) return;
    const newReportsTo =
      editForm.reports_to_person_id
        ? Number(editForm.reports_to_person_id)
        : null;
    const reportsToChanged = newReportsTo !== person.reports_to_person_id;

    if (reportsToChanged) {
      // Must go through impact gate before saving
      await fetchAndShowImpact("move");
      return;
    }

    // Non-hierarchy edit — save directly
    const body: Record<string, unknown> = {
      name: editForm.name.trim() || person.name,
      employee_code: editForm.employee_code.trim() || null,
      designation_id: editForm.designation_id ? Number(editForm.designation_id) : null,
    };
    patchMutation.mutate(body);
  };

  const handleConfirmAction = async () => {
    if (!impactData) return;
    const ack = {
      acknowledgedSubTree: impactData.subTreeCount,
      acknowledgedCustomers: impactData.totalCustomersAffected,
    };
    if (pendingAction === "deactivate") {
      await deactivateMutation.mutateAsync(ack);
    } else if (pendingAction === "move") {
      const body: Record<string, unknown> = {
        name: editForm.name.trim() || person?.name,
        employee_code: editForm.employee_code.trim() || null,
        designation_id: editForm.designation_id ? Number(editForm.designation_id) : null,
        reports_to_person_id: editForm.reports_to_person_id
          ? Number(editForm.reports_to_person_id)
          : null,
        ...ack,
      };
      await patchMutation.mutateAsync(body);
    }
    setShowImpactModal(false);
    setPendingAction(null);
    setImpactData(null);
  };

  const people = peopleData?.people ?? [];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Page header */}
      <div className="px-6 py-4 border-b flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-semibold">Organisation / People</h1>
          <p className="text-sm text-muted-foreground">
            {peopleData ? `${peopleData.total} people` : "Organisation"} · Phase 2 of the editable master
          </p>
        </div>
        {/* Admin secret lock */}
        {!secret ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              sessionStorage.setItem("adminSecret", secretInput);
              setSecret(secretInput);
              setSecretInput("");
            }}
          >
            <Lock className="size-4 text-muted-foreground" />
            <Input
              type="password"
              placeholder="Admin secret to enable edits"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              className="h-8 w-56 text-sm"
            />
            <Button type="submit" size="sm" variant="outline">
              Unlock
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={resyncState === "running"}
              onClick={handleResyncStateHead}
              title="Propagate state_head_person_id corrections from the person table into person_registry, then re-run the secondary_sku_line state_canon backfill."
            >
              {resyncState === "running" ? (
                <Loader2 className="size-3.5 animate-spin mr-1.5" />
              ) : (
                <RefreshCw className="size-3.5 mr-1.5" />
              )}
              Re-sync state head
            </Button>
            {resyncState === "done" && resyncResult && (
              <span className="text-xs text-muted-foreground">
                Registry: {(resyncResult.personSync?.step1Updated ?? 0) + (resyncResult.personSync?.step2Updated ?? 0)} rows ·{" "}
                SKU lines: {resyncResult.updated} updated
              </span>
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <UserCheck className="size-4 text-emerald-600" />
              <span>Edit access unlocked</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  sessionStorage.removeItem("adminSecret");
                  setSecret("");
                  setResyncState("idle");
                  setResyncResult(null);
                }}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Tab bar ────────────────────────────────────────────────────── */}
      <div className="flex border-b shrink-0">
        {(["people", "registry"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={cn(
              "px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "people" ? "People" : "Person Registry"}
          </button>
        ))}
      </div>

      {activeTab === "registry" && (
        <div className="flex-1 overflow-y-auto p-6">
          <PersonRegistryPanel />
        </div>
      )}

      {activeTab === "people" && <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* ── Left panel: list ─────────────────────────────────────────── */}
        <div className="w-72 shrink-0 border-r flex flex-col min-h-0">
          {/* Filters */}
          <div className="p-3 space-y-2 border-b shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search name…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
            <div className="flex gap-1.5">
              {(["active", "all", "inactive"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setActiveFilter(f)}
                  className={cn(
                    "flex-1 py-1 text-xs rounded border capitalize transition-colors",
                    activeFilter === f
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/40",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
            <Select value={designationFilter} onValueChange={setDesignationFilter}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="All designations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All designations</SelectItem>
                {designations.map((d) => (
                  <SelectItem key={d.designation_id} value={String(d.designation_id)}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* People list */}
          <ScrollArea className="flex-1">
            {listLoading && (
              <div className="p-4 flex justify-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {listError && (
              <p className="p-4 text-sm text-destructive">Failed to load people.</p>
            )}
            {!listLoading && people.map((p) => (
              <button
                key={p.person_id}
                onClick={() => { setSelectedId(p.person_id); setEditMode(false); }}
                className={cn(
                  "w-full text-left px-3 py-2.5 border-b hover:bg-muted/50 transition-colors",
                  selectedId === p.person_id && "bg-muted",
                )}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className={cn("text-sm font-medium leading-tight", !p.is_active && "text-muted-foreground line-through")}>
                    {p.name}
                  </span>
                  {p.is_state_head && (
                    <span className="shrink-0 text-[10px] font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 rounded px-1">
                      SH
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{p.designation_name ?? "—"}</p>
                <div className="flex items-center gap-2 mt-1">
                  {p.direct_reports > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      <Users className="inline size-2.5 mr-0.5" />{p.direct_reports}
                    </span>
                  )}
                  {p.customers_as_sh > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {p.customers_as_sh.toLocaleString("en-IN")} cust
                    </span>
                  )}
                  {!p.is_active && (
                    <span className="text-[10px] text-amber-600 font-medium">Inactive</span>
                  )}
                </div>
              </button>
            ))}
            {!listLoading && !people.length && (
              <p className="p-4 text-sm text-muted-foreground">No people match the filters.</p>
            )}
          </ScrollArea>

          {peopleData && (
            <div className="px-3 py-2 border-t text-xs text-muted-foreground shrink-0">
              {people.length} of {peopleData.total} shown
            </div>
          )}
        </div>

        {/* ── Right panel: detail / edit ───────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {!selectedId ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <div className="text-center space-y-1">
                <Users className="size-8 mx-auto opacity-30" />
                <p className="text-sm">Select a person to view details</p>
              </div>
            </div>
          ) : detailLoading ? (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : person ? (
            <PersonPanel
              person={person}
              detail={detailData!}
              designations={designations}
              allPeople={people}
              editMode={editMode}
              editForm={editForm}
              setEditForm={setEditForm}
              onEdit={() => {
                setEditForm({
                  name: person.name,
                  employee_code: person.employee_code ?? "",
                  designation_id: person.designation_id ? String(person.designation_id) : "",
                  reports_to_person_id: person.reports_to_person_id ? String(person.reports_to_person_id) : "",
                  reports_to_search: person.reports_to_name ?? "",
                  reports_to_open: false,
                });
                setEditMode(true);
              }}
              onCancelEdit={() => setEditMode(false)}
              onSave={handleSave}
              onDeactivate={handleDeactivateClick}
              onReactivate={() => reactivateMutation.mutate()}
              isSaving={patchMutation.isPending}
              isDeactivating={deactivateMutation.isPending || impactLoading}
              isReactivating={reactivateMutation.isPending}
              hasAdminAccess={!!secret}
            />
          ) : (
            <div className="p-6 text-sm text-destructive">Person not found.</div>
          )}
        </div>
      </div>}

      {/* ── Impact confirmation modal ──────────────────────────────────── */}
      <ImpactModal
        open={showImpactModal}
        action={pendingAction}
        impact={impactData}
        newManagerName={
          pendingAction === "move" && editForm.reports_to_person_id
            ? people.find((p) => String(p.person_id) === editForm.reports_to_person_id)?.name ??
              editForm.reports_to_search
            : null
        }
        isConfirming={patchMutation.isPending || deactivateMutation.isPending}
        onCancel={() => { setShowImpactModal(false); setPendingAction(null); setImpactData(null); }}
        onConfirm={handleConfirmAction}
      />
    </div>
  );
}

// ── PersonPanel ───────────────────────────────────────────────────────────────

interface PersonPanelProps {
  person: PersonDetail;
  detail: { directReports: DirectReport[]; reportingChain: ChainEntry[]; territories: Territory[]; changeLog: ChangeEntry[] };
  designations: Designation[];
  allPeople: PersonSummary[];
  editMode: boolean;
  editForm: {
    name: string;
    employee_code: string;
    designation_id: string;
    reports_to_person_id: string;
    reports_to_search: string;
    reports_to_open: boolean;
  };
  setEditForm: React.Dispatch<React.SetStateAction<PersonPanelProps["editForm"]>>;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  isSaving: boolean;
  isDeactivating: boolean;
  isReactivating: boolean;
  hasAdminAccess: boolean;
}

function PersonPanel({
  person,
  detail,
  designations,
  allPeople,
  editMode,
  editForm,
  setEditForm,
  onEdit,
  onCancelEdit,
  onSave,
  onDeactivate,
  onReactivate,
  isSaving,
  isDeactivating,
  isReactivating,
  hasAdminAccess,
}: PersonPanelProps) {
  const dropRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!editForm.reports_to_open) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setEditForm((f) => ({ ...f, reports_to_open: false }));
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editForm.reports_to_open, setEditForm]);

  const filteredPeople = allPeople.filter(
    (p) =>
      p.person_id !== person.person_id &&
      p.name.toLowerCase().includes(editForm.reports_to_search.toLowerCase()),
  );

  return (
    <div className="p-6 max-w-2xl space-y-6">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          {editMode ? (
            <Input
              className="text-xl font-semibold h-auto py-0.5 px-1 -ml-1 border-0 border-b rounded-none focus-visible:ring-0"
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
            />
          ) : (
            <h2 className="text-xl font-semibold">{person.name}</h2>
          )}
          <div className="flex items-center flex-wrap gap-1.5">
            {person.is_state_head && (
              <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-0">
                State Head
              </Badge>
            )}
            <Badge
              variant="outline"
              className={cn(
                "text-xs",
                person.is_active
                  ? "border-emerald-500 text-emerald-700 dark:text-emerald-400"
                  : "border-amber-500 text-amber-700 dark:text-amber-400",
              )}
            >
              {person.is_active ? "Active" : "Inactive"}
            </Badge>
            {person.designation_name && (
              <Badge variant="outline" className="text-xs">
                {person.designation_name}
              </Badge>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {!editMode ? (
            <>
              {hasAdminAccess && (
                <Button size="sm" variant="outline" onClick={onEdit}>
                  <Pencil className="size-3.5 mr-1.5" />
                  Edit
                </Button>
              )}
              {hasAdminAccess && person.is_active && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-amber-700 border-amber-300 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-800"
                  onClick={onDeactivate}
                  disabled={isDeactivating}
                >
                  {isDeactivating ? (
                    <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <UserMinus className="size-3.5 mr-1.5" />
                  )}
                  Deactivate
                </Button>
              )}
              {hasAdminAccess && !person.is_active && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400"
                  onClick={onReactivate}
                  disabled={isReactivating}
                >
                  {isReactivating ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <UserCheck className="size-3.5 mr-1.5" />}
                  Reactivate
                </Button>
              )}
              {!hasAdminAccess && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Lock className="size-3" /> Unlock to edit
                </span>
              )}
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={onCancelEdit} disabled={isSaving}>
                Cancel
              </Button>
              <Button size="sm" onClick={onSave} disabled={isSaving}>
                {isSaving ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : null}
                Save
              </Button>
            </>
          )}
        </div>
      </div>

      {!person.is_active && (
        <Alert className="border-amber-200 bg-amber-50 dark:bg-amber-950/20">
          <AlertTriangle className="size-4 text-amber-600" />
          <AlertDescription className="text-amber-800 dark:text-amber-300 text-sm">
            This person is inactive. Their customer assignments and reporting
            relationships are still recorded but they no longer appear in active
            rosters.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Identity fields ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Identity
        </h3>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3">
          <InfoRow label="Employee code">
            {editMode ? (
              <Input
                value={editForm.employee_code}
                onChange={(e) => setEditForm((f) => ({ ...f, employee_code: e.target.value }))}
                className="h-7 text-sm"
                placeholder="Optional"
              />
            ) : (
              <span className="font-mono text-sm">{person.employee_code ?? <em className="text-muted-foreground not-italic">—</em>}</span>
            )}
          </InfoRow>
          <InfoRow label="Designation">
            {editMode ? (
              <Select
                value={editForm.designation_id}
                onValueChange={(v) => setEditForm((f) => ({ ...f, designation_id: v }))}
              >
                <SelectTrigger className="h-7 text-sm">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">— None —</SelectItem>
                  {designations.map((d) => (
                    <SelectItem key={d.designation_id} value={String(d.designation_id)}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-sm">{person.designation_name ?? "—"}</span>
            )}
          </InfoRow>
        </div>
      </section>

      <Separator />

      {/* ── Reporting line ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Reporting line
        </h3>

        {/* Manager (editable) */}
        <InfoRow label="Reports to">
          {editMode ? (
            <div className="relative" ref={dropRef}>
              <Input
                value={editForm.reports_to_search}
                onChange={(e) => {
                  setEditForm((f) => ({
                    ...f,
                    reports_to_search: e.target.value,
                    reports_to_open: true,
                    // Clear the ID if user is typing a new search
                    reports_to_person_id: "",
                  }));
                }}
                onFocus={() => setEditForm((f) => ({ ...f, reports_to_open: true }))}
                placeholder="Search manager name…"
                className="h-7 text-sm"
              />
              {editForm.reports_to_open && filteredPeople.length > 0 && (
                <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-background border rounded shadow-md max-h-48 overflow-y-auto">
                  <button
                    className="w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
                    onClick={() =>
                      setEditForm((f) => ({
                        ...f,
                        reports_to_person_id: "",
                        reports_to_search: "",
                        reports_to_open: false,
                      }))
                    }
                  >
                    — No manager (top level) —
                  </button>
                  {filteredPeople.slice(0, 20).map((p) => (
                    <button
                      key={p.person_id}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex items-center justify-between"
                      onClick={() =>
                        setEditForm((f) => ({
                          ...f,
                          reports_to_person_id: String(p.person_id),
                          reports_to_search: p.name,
                          reports_to_open: false,
                        }))
                      }
                    >
                      <span>{p.name}</span>
                      <span className="text-xs text-muted-foreground">{p.designation_name}</span>
                    </button>
                  ))}
                </div>
              )}
              {editForm.reports_to_person_id &&
                editForm.reports_to_person_id !== String(person.reports_to_person_id) && (
                  <p className="text-xs text-amber-700 mt-1 flex items-center gap-1">
                    <AlertTriangle className="size-3" />
                    Changing manager requires impact confirmation before saving.
                  </p>
                )}
            </div>
          ) : (
            <span className="text-sm">{person.reports_to_name ?? <em className="text-muted-foreground not-italic">Top level — no manager</em>}</span>
          )}
        </InfoRow>

        {/* Reporting chain upward */}
        {!editMode && detail.reportingChain.length > 0 && (
          <div className="ml-4 space-y-1">
            {detail.reportingChain.map((c, i) => (
              <div key={c.person_id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <div style={{ marginLeft: i * 8 }} className="flex items-center gap-1">
                  <ChevronRight className="size-3 shrink-0" />
                  <span>{c.name}</span>
                  {c.designation_name && (
                    <span className="text-[10px] opacity-70">({c.designation_name})</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* State head */}
        {person.state_head_name && (
          <InfoRow label="State head">{person.state_head_name}</InfoRow>
        )}

        {/* Direct reports */}
        <div>
          <Label className="text-xs text-muted-foreground">
            Direct reports ({detail.directReports.length})
          </Label>
          {detail.directReports.length === 0 ? (
            <p className="text-sm text-muted-foreground mt-1">None</p>
          ) : (
            <div className="mt-1 space-y-0.5">
              {detail.directReports.map((r) => (
                <div key={r.person_id} className="flex items-center gap-2 text-sm">
                  <Users className="size-3 text-muted-foreground shrink-0" />
                  <span className={cn(!r.is_active && "text-muted-foreground line-through")}>
                    {r.name}
                  </span>
                  {r.designation_name && (
                    <span className="text-xs text-muted-foreground">{r.designation_name}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <Separator />

      {/* ── Customer scope ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Customer scope
        </h3>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2">
          <StatRow
            label="As state head"
            value={person.customers_as_sh.toLocaleString("en-IN")}
            sub="active assignments"
          />
          <StatRow
            label="As territory manager"
            value={person.customers_as_tm.toLocaleString("en-IN")}
            sub="active assignments"
          />
          <StatRow
            label="Total affected"
            value={(person.customers_as_sh + person.customers_as_tm).toLocaleString("en-IN")}
            sub="if deactivated"
            highlight
          />
        </div>
      </section>

      {/* ── Territories ─────────────────────────────────────────────── */}
      {detail.territories.length > 0 && (
        <>
          <Separator />
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Territories
            </h3>
            {detail.territories.map((t) => (
              <div key={t.territory_id} className="flex items-center gap-2 text-sm">
                <span>{t.name}</span>
                {t.parent_name && (
                  <span className="text-xs text-muted-foreground">({t.parent_name})</span>
                )}
                {t.effective_to && (
                  <span className="text-xs text-amber-600">ended {t.effective_to}</span>
                )}
              </div>
            ))}
          </section>
        </>
      )}

      {/* ── Change log ──────────────────────────────────────────────── */}
      {detail.changeLog.length > 0 && (
        <>
          <Separator />
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Recent changes
            </h3>
            <div className="space-y-1">
              {detail.changeLog.map((c) => (
                <div key={c.id} className="text-xs text-muted-foreground flex items-start gap-2">
                  <span className="shrink-0 text-[10px] mt-0.5">
                    {new Date(c.changed_at).toLocaleString("en-IN", {
                      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                    })}
                  </span>
                  <span>
                    <span className="font-mono">{c.field}</span>
                    {c.old_value !== null && (
                      <>: <span className="line-through">{c.old_value}</span> → {c.new_value}</>
                    )}
                    {c.changed_by && <span className="ml-1 opacity-60">by {c.changed_by}</span>}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ── Impact confirmation modal ─────────────────────────────────────────────────

interface ImpactModalProps {
  open: boolean;
  action: "deactivate" | "move" | null;
  impact: ImpactData | null;
  newManagerName: string | null;
  isConfirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ImpactModal({ open, action, impact, newManagerName, isConfirming, onCancel, onConfirm }: ImpactModalProps) {
  if (!impact) return null;
  const name = impact.person.name;
  const isDeactivate = action === "deactivate";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !isConfirming) onCancel(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-5" />
            {isDeactivate ? `Confirm deactivation of ${name}` : `Moving ${name} to a new manager`}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground pt-1">
              {isDeactivate
                ? "Review the impact below. None of these are reassigned automatically."
                : `${name} and their entire reporting tree will now report through ${newManagerName ?? "the new manager"}.`}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Reporting tree */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Reporting tree</span>
              <span className={cn(
                "text-lg font-bold tabular-nums",
                impact.subTreeCount > 0 ? "text-amber-600" : "text-muted-foreground",
              )}>
                {impact.subTreeCount}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {impact.subTreeCount === 0
                ? "No direct reports — this person is a leaf node."
                : `${impact.subTreeCount} ${impact.subTreeCount === 1 ? "person" : "people"} in this person's reporting subtree${isDeactivate ? " will have no active manager" : " will move with them"}.`}
            </p>
            {impact.directReports.length > 0 && (
              <div className="pl-2 border-l-2 border-amber-300 space-y-0.5">
                <p className="text-xs font-medium text-muted-foreground">
                  Direct reports ({impact.directReports.length}):
                </p>
                {impact.directReports.map((r) => (
                  <p key={r.person_id} className="text-xs text-muted-foreground">
                    • {r.name}{r.designation_name ? ` (${r.designation_name})` : ""}
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* Customer scope */}
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Customers affected</span>
              <span className={cn(
                "text-lg font-bold tabular-nums",
                impact.totalCustomersAffected > 0 ? "text-amber-600" : "text-muted-foreground",
              )}>
                {impact.totalCustomersAffected.toLocaleString("en-IN")}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 text-xs text-muted-foreground">
              <div>
                <span className="tabular-nums font-medium text-foreground">
                  {impact.customersAsStateHead.toLocaleString("en-IN")}
                </span>{" "}
                as state head
              </div>
              <div>
                <span className="tabular-nums font-medium text-foreground">
                  {impact.customersAsTm.toLocaleString("en-IN")}
                </span>{" "}
                as territory manager
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {impact.totalCustomersAffected === 0
                ? "No customer assignments will be affected."
                : `${isDeactivate ? "These customers will retain their assignment records but their assigned person will be inactive." : "Customer assignments are not changed by a manager move."}`}
            </p>
          </div>

          {isDeactivate && impact.totalCustomersAffected > 0 && (
            <Alert className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 py-2">
              <AlertDescription className="text-amber-800 dark:text-amber-300 text-xs">
                After deactivating, use the Customer page (Phase 3) to
                reassign the {impact.totalCustomersAffected.toLocaleString("en-IN")} affected customers.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel} disabled={isConfirming}>
            Cancel
          </Button>
          <Button
            variant={isDeactivate ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={isConfirming}
          >
            {isConfirming ? (
              <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            ) : null}
            {isDeactivate
              ? `Confirm deactivation`
              : `Confirm move`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div>{children}</div>
    </div>
  );
}

function StatRow({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-bold tabular-nums", highlight && "text-amber-600 dark:text-amber-400")}>
        {value}
      </p>
      <p className="text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}
