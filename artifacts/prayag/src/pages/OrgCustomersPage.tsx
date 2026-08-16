// Phase 3 — Customer management page (tabs: Customers · Unassigned · Review Queue)
//
// Tab 0 — Customers
//   Two-panel: search + type filter + list | detail (assignment, history, links,
//   type-change admin form).
//
// Tab 1 — Unassigned
//   Territory sidebar → customer list → bulk-assign form.
//   The main job: 3,381 NULL-person_id rows need to reach a TM.
//
// Tab 2 — Review Queue
//   Propose-new-customer form + list of pending/approved/rejected entries.
//   Admin can approve (creates customer row) or reject.
//
// Invariant guarantee:
//   GET /api/master/customers/by-head produces IDENTICAL results before and
//   after ANY bulk-assign or single-assign operation. sale_line.head_canon is
//   baked at ingestion and is never written by these routes.

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Search, Lock, Unlock, ChevronDown, ChevronRight,
  Link2, AlertTriangle, CheckCircle2, Store, Users,
  RefreshCw, ClipboardList, UserCheck, Lightbulb, TrendingUp, X,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Shared types ──────────────────────────────────────────────────────────────

interface PersonOption {
  person_id: number;
  name: string;
  designation_name: string | null;
}

interface CustomerRow {
  customer_id: string;
  name: string;
  type: string;
  status: string | null;
  person_id: number | null;
  person_name: string | null;
  state_head_person_id: number | null;
  state_head_name: string | null;
  confidence: string | null;
  effective_from: string | null;
  has_link: boolean;
}

interface Assignment {
  id: number;
  person_id: number | null;
  person_name: string | null;
  state_head_person_id: number | null;
  state_head_name: string | null;
  confidence: string;
  set_by: string | null;
  effective_from: string;
  effective_to: string | null;
  set_at: string;
}

interface CustomerDetail {
  customer: {
    customer_id: string;
    name: string;
    type: string;
    status: string | null;
    territory_id: number | null;
    territory_name: string | null;
  };
  currentAssignment: Assignment | null;
  assignmentHistory: Assignment[];
  links: { id: number; link_order: number; retailer_id: string; retailer_name: string; distributor_id: string; distributor_name: string }[];
}

interface UnassignedCustomer {
  customer_id: string;
  name: string;
  type: string;
  status: string | null;
  territory_id: number | null;
  territory_name: string | null;
  // Suggestion fields
  state_head_person_id: number | null;
  state_head_name: string | null;
  former_person_name_raw: string | null;
  suggested_person_id: number | null;
  suggested_person_name: string | null;
  suggestion_rule: "former_book" | "territory_majority" | "state_head" | null;
  suggestion_cover_count: number | null;
  // Confidence band (territory_majority only)
  confidence_band: "strong" | "moderate" | "weak" | null;
  tm_cover_count: number | null;
  territory_total_assigned: number | null;
}

interface TerritoryGroup {
  territory_id: number | null;
  territory_name: string | null;
  customer_count: number;
  retailers: number;
  dist_dealer: number;
  // Suggestion fields
  suggested_person_id: number | null;
  suggested_person_name: string | null;
  suggestion_cover_count: number | null;
  territory_total_assigned: number | null;
  confidence_band: "strong" | "moderate" | "weak" | null;
  with_suggestion: number;
}

interface BulkSuggestResult {
  moved: number;
  skipped: number;
  breakdown: { person_name: string; count: number; rule: string }[];
}

interface QueueItem {
  id: number;
  name: string;
  type: string;
  notes: string | null;
  submitted_by: string;
  submitted_at: string;
  review_status: "pending" | "approved" | "rejected";
  reviewed_by: string | null;
  reviewed_at: string | null;
  approved_customer_id: string | null;
  territory_name: string | null;
  proposed_person_name: string | null;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

const VALID_TYPES = ["retailer","distributor","direct_dealer","sub_dealer","project","govt","other"];

function typeBadge(type: string) {
  const map: Record<string, string> = {
    distributor:  "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    retailer:     "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    direct_dealer:"bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    sub_dealer:   "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    project:      "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    govt:         "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  };
  return (
    <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide",
      map[type] ?? "bg-muted text-muted-foreground")}>
      {type.replace(/_/g, " ")}
    </span>
  );
}

function confidenceDot(conf: string | null) {
  const map: Record<string, string> = {
    confirmed:          "bg-green-500",
    assign_user_chain:  "bg-blue-400",
    state_lookup:       "bg-yellow-400",
    guessed:            "bg-gray-400",
  };
  return (
    <span title={conf ?? "unassigned"}
      className={cn("inline-block w-2 h-2 rounded-full flex-shrink-0",
        map[conf ?? ""] ?? "bg-gray-300")} />
  );
}

function useAdminSecret() {
  const [secret, setSecretState] = useState(() =>
    sessionStorage.getItem("master_admin_secret") ?? "");
  const setSecret = (s: string) => {
    sessionStorage.setItem("master_admin_secret", s);
    setSecretState(s);
  };
  return { secret, setSecret };
}

function usePersonList() {
  return useQuery<{ total: number; people: PersonOption[] }>({
    queryKey: ["master-people-all"],
    queryFn: () =>
      fetch(`${BASE}/api/master/people?active=true&limit=200`).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  });
}

// ── Admin unlock widget ───────────────────────────────────────────────────────

function AdminBar({ secret, setSecret }: { secret: string; setSecret: (s: string) => void }) {
  const [input, setInput] = useState("");
  const { toast } = useToast();
  const unlock = () => {
    if (!input.trim()) return;
    setSecret(input.trim());
    setInput("");
    toast({ title: "Admin mode enabled" });
  };
  return (
    <div className="flex items-center gap-2">
      {secret ? (
        <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
          <Unlock size={13} /> Admin
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Lock size={13} className="text-muted-foreground" />
          <Input type="password" value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
            placeholder="Admin secret" className="h-7 w-44 text-xs" />
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={unlock}>Unlock</Button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 0 — CUSTOMERS (existing two-panel + type-change)
// ═══════════════════════════════════════════════════════════════════════════

function AssignForm({ customerId, current, adminSecret, onDone }:
  { customerId: string; current: Assignment | null; adminSecret: string; onDone: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: pd } = usePersonList();
  const people = pd?.people ?? [];
  const [personId, setPersonId] = useState(current?.person_id?.toString() ?? "");
  const [shId, setShId] = useState(current?.state_head_person_id?.toString() ?? "");
  const [reason, setReason] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      fetch(`${BASE}/api/master/customers/${customerId}/assign`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": adminSecret },
        body: JSON.stringify({ person_id: personId ? Number(personId) : null,
          state_head_person_id: shId ? Number(shId) : null,
          confidence: "confirmed", changed_by: reason || "operator" }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? r.statusText); return r.json(); }),
    onSuccess: () => {
      toast({ title: "Assignment updated" });
      qc.invalidateQueries({ queryKey: ["master-customer-detail", customerId] });
      qc.invalidateQueries({ queryKey: ["master-customers"] });
      onDone();
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const noChange = (personId || "") === (current?.person_id?.toString() ?? "") &&
    (shId || "") === (current?.state_head_person_id?.toString() ?? "");

  return (
    <div className="space-y-3 pt-3 border-t">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Reassign</div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Territory Manager</label>
        <Select value={personId} onValueChange={setPersonId}>
          <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {people.map((p) => (
              <SelectItem key={p.person_id} value={String(p.person_id)}>
                {p.name}{p.designation_name ? ` · ${p.designation_name}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Reason / changed_by</label>
        <Input value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="operator name or reason" className="h-8 text-sm" />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => mut.mutate()} disabled={mut.isPending || noChange} className="flex-1">
          {mut.isPending ? "Saving…" : "Confirm"}
        </Button>
        <Button size="sm" variant="outline" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function TypeChangeForm({ customerId, currentType, adminSecret, onDone }:
  { customerId: string; currentType: string; adminSecret: string; onDone: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [newType, setNewType] = useState(currentType);
  const [reason, setReason] = useState("");
  const [changedBy, setChangedBy] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      fetch(`${BASE}/api/master/customers/${customerId}/type`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": adminSecret },
        body: JSON.stringify({ new_type: newType, reason, changed_by: changedBy || "operator" }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? r.statusText); return r.json(); }),
    onSuccess: (d) => {
      if (d.changed) {
        toast({ title: "Type changed", description: `${currentType} → ${newType}. Recorded in change_log.` });
        qc.invalidateQueries({ queryKey: ["master-customer-detail", customerId] });
        qc.invalidateQueries({ queryKey: ["master-customers"] });
      } else {
        toast({ title: "No change", description: "Type is already " + newType });
      }
      onDone();
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const noReason = !reason.trim();
  const noChange = newType === currentType;

  return (
    <div className="space-y-3 pt-3 border-t border-amber-200 dark:border-amber-800">
      <div className="text-xs font-medium text-amber-700 dark:text-amber-400 uppercase tracking-wide">
        ⚠ Change type — reason required
      </div>
      <Alert className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 py-2">
        <AlertDescription className="text-xs text-amber-800 dark:text-amber-300">
          Type changes broke year-on-year comparison before. The reason is permanently
          recorded in <code className="font-mono">change_log.changed_by</code>.
        </AlertDescription>
      </Alert>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">New type</label>
        <Select value={newType} onValueChange={setNewType}>
          <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {VALID_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">
          Reason <span className="text-destructive">*</span>
          <span className="ml-1 font-normal text-muted-foreground">(→ change_log.reason)</span>
        </label>
        <Input value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Required — why is this type changing?" className="h-8 text-sm" />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">
          Your name / changed_by
          <span className="ml-1 font-normal text-muted-foreground">(→ change_log.changed_by)</span>
        </label>
        <Input value={changedBy} onChange={(e) => setChangedBy(e.target.value)}
          placeholder="operator" className="h-8 text-sm" />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => mut.mutate()}
          disabled={mut.isPending || noChange || noReason} className="flex-1">
          {mut.isPending ? "Saving…" : "Confirm type change"}
        </Button>
        <Button size="sm" variant="outline" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function DetailPanel({ customerId, adminSecret }:
  { customerId: string; adminSecret: string }) {
  const { data, isLoading, error } = useQuery<CustomerDetail>({
    queryKey: ["master-customer-detail", customerId],
    queryFn: () => fetch(`${BASE}/api/master/customers/${customerId}`).then((r) => r.json()),
    enabled: !!customerId,
  });

  const [editing, setEditing] = useState(false);
  const [typeEditing, setTypeEditing] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (error || !data) return <div className="p-6 text-sm text-destructive">{String(error ?? "Not found")}</div>;

  const { customer, currentAssignment, assignmentHistory, links } = data;

  return (
    <div className="p-5 space-y-5 overflow-y-auto h-full">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold leading-tight">{customer.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              {typeBadge(customer.type)}
              <span className="text-xs text-muted-foreground font-mono">{customer.customer_id}</span>
            </div>
          </div>
          {links.length > 0 && <Link2 size={16} className="text-blue-500 mt-1 flex-shrink-0" />}
        </div>
        {customer.territory_name && (
          <p className="text-xs text-muted-foreground mt-1">Territory: {customer.territory_name}</p>
        )}
      </div>

      {/* Current assignment */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Current Assignment</div>
        {currentAssignment ? (
          <div className="rounded-lg border p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              {confidenceDot(currentAssignment.confidence)}
              <span className="font-medium text-sm">{currentAssignment.person_name ?? "— unassigned —"}</span>
              <Badge variant="outline" className="text-[10px] h-4 px-1 ml-auto">{currentAssignment.confidence}</Badge>
            </div>
            {currentAssignment.state_head_name && (
              <p className="text-xs text-muted-foreground">SH: {currentAssignment.state_head_name}</p>
            )}
            <p className="text-xs text-muted-foreground">From {currentAssignment.effective_from}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">No current assignment</p>
        )}
      </div>

      {/* Reassign + type-change buttons */}
      {adminSecret && !editing && !typeEditing && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} className="flex-1">
            Reassign
          </Button>
          <Button size="sm" variant="outline" onClick={() => setTypeEditing(true)}
            className="flex-1 border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400">
            Change type
          </Button>
        </div>
      )}
      {editing && (
        <AssignForm customerId={customer.customer_id} current={currentAssignment}
          adminSecret={adminSecret} onDone={() => setEditing(false)} />
      )}
      {typeEditing && (
        <TypeChangeForm customerId={customer.customer_id} currentType={customer.type}
          adminSecret={adminSecret} onDone={() => setTypeEditing(false)} />
      )}

      {/* Assignment history */}
      {assignmentHistory.length > 1 && (
        <Collapsible open={histOpen} onOpenChange={setHistOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            {histOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            History ({assignmentHistory.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 space-y-1.5">
            {assignmentHistory.map((a) => (
              <div key={a.id} className={cn("rounded p-2 text-xs space-y-0.5 border",
                !a.effective_to ? "border-blue-200 bg-blue-50 dark:bg-blue-950/20" : "border-border bg-muted/30")}>
                <div className="flex items-center gap-1.5">
                  {confidenceDot(a.confidence)}
                  <span className="font-medium">{a.person_name ?? "— unassigned —"}</span>
                  {!a.effective_to && <Badge variant="outline" className="text-[10px] h-4 px-1 border-blue-400 text-blue-600">current</Badge>}
                </div>
                <div className="text-muted-foreground pl-3.5">
                  {a.effective_from} → {a.effective_to ?? "open"}
                  {a.set_by ? ` · ${a.set_by}` : ""}
                </div>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Links */}
      {links.length > 0 && (
        <Collapsible open={linksOpen} onOpenChange={setLinksOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            {linksOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Link2 size={12} />
            {customer.type === "retailer" ? `Distributors (${links.length})` : `Linked retailers (${links.length})`}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 space-y-1">
            {links.map((l) => (
              <div key={l.id} className="text-xs bg-muted/40 rounded px-2 py-1 flex items-center gap-2">
                <span className="font-mono text-muted-foreground">
                  {customer.type === "retailer" ? l.distributor_id : l.retailer_id}
                </span>
                <span className="truncate">
                  {customer.type === "retailer" ? l.distributor_name : l.retailer_name}
                </span>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function CustomersTab({ adminSecret }: { adminSecret: string }) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setDebouncedQ(q); setPage(1); }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  const typeParam = type === "all" ? "" : type;
  const { data, isLoading } = useQuery<{ total: number; customers: CustomerRow[] }>({
    queryKey: ["master-customers", debouncedQ, typeParam, page],
    queryFn: () =>
      fetch(`${BASE}/api/master/customers?q=${encodeURIComponent(debouncedQ)}&type=${typeParam}&page=${page}&limit=50`)
        .then((r) => r.json()),
  });

  const customers = data?.customers ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / 50);

  return (
    <div className="flex flex-1 min-h-0">
      {/* Left list */}
      <div className="w-72 flex-shrink-0 border-r flex flex-col">
        <div className="p-3 border-b space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or ID…" className="pl-8 h-8 text-sm" />
          </div>
          <Select value={type} onValueChange={(v) => { setType(v); setPage(1); }}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {VALID_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="p-4 text-sm text-muted-foreground text-center">Loading…</div>}
          {!isLoading && customers.length === 0 && <div className="p-4 text-sm text-muted-foreground text-center">No results</div>}
          {customers.map((c) => (
            <button key={c.customer_id} onClick={() => setSelected(c.customer_id)}
              className={cn("w-full text-left px-3 py-2.5 border-b hover:bg-muted/50 transition-colors",
                selected === c.customer_id && "bg-muted")}>
              <div className="flex items-start justify-between gap-1">
                <span className="font-medium text-sm leading-tight truncate">{c.name}</span>
                <div className="flex-shrink-0 flex items-center gap-1 mt-0.5">
                  {c.has_link && <Link2 size={11} className="text-blue-400" />}
                  {confidenceDot(c.confidence)}
                </div>
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                {typeBadge(c.type)}
                {c.person_name && <span className="text-[11px] text-muted-foreground truncate">{c.person_name}</span>}
              </div>
            </button>
          ))}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-3 py-2 border-t text-xs text-muted-foreground">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-40">← Prev</button>
            <span>{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-40">Next →</button>
          </div>
        )}
      </div>

      {/* Right detail */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selected ? (
          <DetailPanel customerId={selected} adminSecret={adminSecret} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <Store size={40} className="opacity-30" />
            <p className="text-sm">Select a customer to view details</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 1 — UNASSIGNED / BULK REASSIGN
// ═══════════════════════════════════════════════════════════════════════════

type Band = "strong" | "moderate" | "weak" | null;

function bandBadge(band: Band): React.ReactNode {
  if (!band) return null;
  const styles: Record<NonNullable<Band>, string> = {
    strong:   "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    moderate: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    weak:     "bg-red-100   text-red-800   dark:bg-red-900/30   dark:text-red-300",
  };
  return (
    <span className={cn(
      "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide",
      styles[band],
    )}>
      {band}
    </span>
  );
}

function coverageText(
  rule: string | null,
  coverCount: number | null,
  totalAssigned: number | null,
): string {
  if (rule === "former_book")
    return `former book successor · inherited ${coverCount ?? "?"}`;
  if (rule === "territory_majority") {
    const n = coverCount ?? "?";
    const m = totalAssigned ?? "?";
    return `territory majority · covers ${n} of ${m} in territory`;
  }
  if (rule === "state_head") return "state head";
  return "";
}

function UnassignedTab({ adminSecret }: { adminSecret: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: pd } = usePersonList();
  const people = pd?.people ?? [];

  // Territory sidebar selection
  const [selTerritory, setSelTerritory] = useState<number | null | "all">("all");
  const [selType, setSelType] = useState("all");
  const [page, setPage] = useState(1);

  // Manual bulk form (override / fallback)
  const [toPersonId, setToPersonId] = useState("");
  const [changedBy, setChangedBy] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [showManual, setShowManual] = useState(false);

  // Suggested-accept confirmation
  const [confirmTerritory, setConfirmTerritory] = useState<TerritoryGroup | null>(null);

  // How-to panel — dismissed per session
  const [howToDismissed, setHowToDismissed] = useState(
    () => sessionStorage.getItem("unassigned-howto-dismissed") === "1"
  );
  function dismissHowTo() {
    sessionStorage.setItem("unassigned-howto-dismissed", "1");
    setHowToDismissed(true);
  }

  const territoryParam = selTerritory === "all" ? undefined :
    selTerritory === null ? "null" : String(selTerritory);
  const typeParam = selType === "all" ? "" : selType;

  const { data, isLoading, refetch } = useQuery<{
    total: number;
    customers: UnassignedCustomer[];
    territoryGroups: TerritoryGroup[];
  }>({
    queryKey: ["master-unassigned", territoryParam, typeParam, page],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "100", page: String(page) });
      if (typeParam) params.set("type", typeParam);
      if (selTerritory !== "all" && selTerritory !== null) params.set("territory_id", String(selTerritory));
      return fetch(`${BASE}/api/master/customers/unassigned?${params}`).then((r) => r.json());
    },
  });

  const groups = data?.territoryGroups ?? [];
  const customers = data?.customers ?? [];
  const total = data?.total ?? 0;

  // Progress totals
  const totalUnassigned = groups.reduce((s, g) => s + Number(g.customer_count), 0);
  const totalWithSuggestion = groups.reduce((s, g) => s + Number(g.with_suggestion), 0);

  // Keep selectAll in sync
  const visibleIds = customers.map((c) => c.customer_id);
  useEffect(() => {
    if (selectAll) setSelectedIds(new Set(visibleIds));
    else setSelectedIds(new Set());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectAll, data]);

  // Manual bulk assign
  const bulkMut = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        to_person_id: Number(toPersonId),
        changed_by: changedBy || "bulk_assign",
      };
      if (selectedIds.size > 0) {
        body.customer_ids = [...selectedIds];
      } else {
        if (typeParam) body.type = typeParam;
        if (selTerritory !== "all" && selTerritory !== null)
          body.territory_id = selTerritory;
      }
      return fetch(`${BASE}/api/master/customers/bulk-assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": adminSecret },
        body: JSON.stringify(body),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
        return r.json();
      });
    },
    onSuccess: (d) => {
      toast({
        title: `Moved ${d.moved} customers`,
        description: `→ ${d.toPersonName} · ${d.moved} change_log entries written`,
      });
      setSelectedIds(new Set());
      setSelectAll(false);
      invalidateAll();
    },
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // Accept-all-suggested for a territory
  const suggestMut = useMutation({
    mutationFn: (tg: TerritoryGroup) =>
      fetch(`${BASE}/api/master/customers/bulk-assign-suggested`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": adminSecret },
        body: JSON.stringify({
          territory_id: tg.territory_id,
          changed_by: changedBy || "bulk_assign_suggested",
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
        return r.json() as Promise<BulkSuggestResult>;
      }),
    onSuccess: (d, tg) => {
      const names = d.breakdown.map((b) => `${b.person_name} ×${b.count}`).join(", ");
      toast({
        title: `Accepted ${d.moved} suggestion${d.moved !== 1 ? "s" : ""} in ${tg.territory_name ?? "territory"}`,
        description: `→ ${names}${d.skipped ? ` · ${d.skipped} had no suggestion` : ""} · ${d.moved} change_log entries`,
      });
      setConfirmTerritory(null);
      invalidateAll();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
      setConfirmTerritory(null);
    },
  });

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ["master-unassigned"] });
    qc.invalidateQueries({ queryKey: ["master-unassigned-total"] });
    qc.invalidateQueries({ queryKey: ["master-customers"] });
    refetch();
  }

  const isBulkReady = adminSecret && toPersonId && (selectedIds.size > 0 || total > 0);
  const moveCount = selectedIds.size > 0 ? selectedIds.size : total;

  // Currently-selected territory group (for Accept-all button in main area)
  const selGroup = groups.find((g) => g.territory_id === selTerritory) ?? null;

  return (
    <div className="flex flex-1 min-h-0">

      {/* ── Territory sidebar ──────────────────────────────────────────────── */}
      <div className="w-64 flex-shrink-0 border-r flex flex-col overflow-y-auto">

        {/* Progress header */}
        <div className="p-3 border-b space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Progress</span>
            <span className="text-xs font-semibold">{totalUnassigned.toLocaleString()} remaining</span>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Lightbulb size={11} className="text-amber-500 flex-shrink-0" />
            {totalWithSuggestion.toLocaleString()} of {totalUnassigned.toLocaleString()} have a suggestion
          </div>
          {totalUnassigned > 0 && (
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-amber-400 transition-all"
                style={{ width: `${Math.round((totalWithSuggestion / totalUnassigned) * 100)}%` }}
              />
            </div>
          )}
        </div>

        {/* All territories row */}
        <button
          onClick={() => { setSelTerritory("all"); setPage(1); setSelectAll(false); }}
          className={cn("w-full text-left px-3 py-2 text-sm border-b hover:bg-muted/50",
            selTerritory === "all" && "bg-muted font-medium")}>
          <div className="flex justify-between items-baseline">
            <span>All territories</span>
            <span className="text-xs text-muted-foreground">{totalUnassigned.toLocaleString()}</span>
          </div>
        </button>

        {/* Per-territory rows */}
        {groups.map((g) => {
          const hasSuggestion = g.suggested_person_id !== null;
          const isWeak = g.confidence_band === "weak";
          return (
            <button key={g.territory_id ?? "null"}
              onClick={() => { setSelTerritory(g.territory_id); setPage(1); setSelectAll(false); }}
              className={cn("w-full text-left px-3 py-2 text-sm border-b hover:bg-muted/50 group",
                selTerritory === g.territory_id && "bg-muted")}>
              <div className="flex justify-between items-baseline">
                <span className={cn("truncate pr-2 font-medium", selTerritory === g.territory_id && "font-semibold")}>
                  {g.territory_name ?? "No territory"}
                </span>
                <span className="text-xs text-muted-foreground flex-shrink-0">{g.customer_count}</span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-[11px] text-muted-foreground">{g.dist_dealer}D · {g.retailers}R</span>
                {hasSuggestion && bandBadge(g.confidence_band)}
              </div>
              {hasSuggestion && (
                <div className={cn(
                  "text-[10px] truncate mt-0.5",
                  isWeak
                    ? "text-muted-foreground line-through opacity-60"
                    : "text-amber-700 dark:text-amber-300 opacity-80",
                )}>
                  {isWeak ? "⚠ weak — pick one-by-one" : `→ ${g.suggested_person_name}`}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col">

        {/* ── How-to panel ── */}
        {!howToDismissed && (
          <div className="border-b bg-blue-50 dark:bg-blue-950/25 px-4 py-3 flex items-start gap-3">
            <Lightbulb size={15} className="text-blue-500 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0 text-xs text-blue-900 dark:text-blue-200 space-y-1 leading-relaxed">
              <p className="font-semibold text-[12px]">How to work through this list</p>
              <p>Pick a territory on the left. <span className="font-medium">Strong</span> (green) and <span className="font-medium">moderate</span> (amber) territories have an <em>Accept all suggestions</em> button — use it. Check the <em>covers X of Y</em> figure first: 82 of 134 is a much stronger signal than 24 of 97.</p>
              <p><span className="font-medium">Weak</span> (red) territories and the <span className="font-medium">55 customers with no former name</span> have no accept-all — assign them one by one. East&nbsp;U.P holds 13 of those 55.</p>
              <p>As you accept suggestions, the engine builds evidence. Once 5 of a departed person's customers go to one TM, the remaining customers from that person route to them automatically.</p>
            </div>
            <button
              onClick={dismissHowTo}
              className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 flex-shrink-0 mt-0.5"
              aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        )}

        {/* ── Suggested-accept confirmation overlay ── */}
        {confirmTerritory && (
          <div className="p-4 border-b bg-amber-50 dark:bg-amber-950/20 flex items-start gap-3">
            <Lightbulb size={18} className="text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                Accept all {confirmTerritory.with_suggestion} suggestions in {confirmTerritory.territory_name ?? "this territory"}?
                {bandBadge(confirmTerritory.confidence_band)}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                → {confirmTerritory.suggested_person_name}
                {" · covers "}
                {confirmTerritory.suggestion_cover_count ?? "?"}
                {" of "}
                {confirmTerritory.territory_total_assigned ?? "?"}
                {" currently assigned"}
                {" · "}{confirmTerritory.with_suggestion} change_log entries will be written
                {Number(confirmTerritory.customer_count) - Number(confirmTerritory.with_suggestion) > 0 && (
                  <> · {Number(confirmTerritory.customer_count) - Number(confirmTerritory.with_suggestion)} skipped (no suggestion)</>
                )}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <Button size="sm" className="h-7 text-xs bg-amber-500 hover:bg-amber-600 text-white"
                  disabled={suggestMut.isPending}
                  onClick={() => suggestMut.mutate(confirmTerritory)}>
                  {suggestMut.isPending
                    ? <><RefreshCw size={11} className="animate-spin mr-1" />Applying…</>
                    : <><UserCheck size={11} className="mr-1" />Confirm — accept {confirmTerritory.with_suggestion}</>}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs"
                  onClick={() => setConfirmTerritory(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Territory suggestion banner (when a territory is selected with suggestion) ── */}
        {!confirmTerritory && selGroup && selGroup.suggested_person_id !== null && (
          <div className={cn(
            "px-4 py-2.5 border-b flex items-center gap-3",
            selGroup.confidence_band === "weak"
              ? "bg-red-50/60 dark:bg-red-950/10"
              : "bg-amber-50/60 dark:bg-amber-950/10",
          )}>
            <TrendingUp size={15} className={cn(
              "flex-shrink-0",
              selGroup.confidence_band === "weak" ? "text-red-400" : "text-amber-500",
            )} />
            <div className="flex-1 min-w-0">
              <span className={cn(
                "text-sm font-medium",
                selGroup.confidence_band === "weak"
                  ? "text-red-700 dark:text-red-300"
                  : "text-amber-800 dark:text-amber-300",
              )}>
                {selGroup.confidence_band === "weak"
                  ? "Weak suggestion — pick individually"
                  : `Suggested → ${selGroup.suggested_person_name}`}
              </span>
              <span className="text-xs text-muted-foreground ml-2">
                covers {selGroup.suggestion_cover_count ?? "?"} of {selGroup.territory_total_assigned ?? "?"} in territory
              </span>
              {bandBadge(selGroup.confidence_band)}
            </div>
            {adminSecret && selGroup.confidence_band !== "weak" && (
              <Button size="sm"
                className="h-7 text-xs bg-amber-500 hover:bg-amber-600 text-white flex-shrink-0"
                onClick={() => setConfirmTerritory(selGroup)}>
                <Lightbulb size={11} className="mr-1" />
                Accept {selGroup.with_suggestion} suggestions
              </Button>
            )}
          </div>
        )}

        {/* ── Filter + manual bulk form ── */}
        <div className="p-3 border-b bg-muted/20 flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Type</label>
            <Select value={selType} onValueChange={(v) => { setSelType(v); setPage(1); setSelectAll(false); }}>
              <SelectTrigger className="h-8 w-36 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {VALID_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button size="sm" variant="outline" className="h-8 text-xs"
            onClick={() => setShowManual((v) => !v)}>
            {showManual ? "Hide manual assign" : "Manual assign…"}
          </Button>

          {showManual && (
            <>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <label className="text-xs text-muted-foreground flex-shrink-0">Assign to</label>
                <Select value={toPersonId} onValueChange={setToPersonId}>
                  <SelectTrigger className="h-8 flex-1 text-sm min-w-0"><SelectValue placeholder="Choose TM…" /></SelectTrigger>
                  <SelectContent>
                    {people.map((p) => (
                      <SelectItem key={p.person_id} value={String(p.person_id)}>
                        {p.name}{p.designation_name ? ` · ${p.designation_name}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Input value={changedBy} onChange={(e) => setChangedBy(e.target.value)}
                placeholder="changed_by" className="h-8 w-36 text-sm" />
              <Button size="sm"
                onClick={() => bulkMut.mutate()}
                disabled={!isBulkReady || bulkMut.isPending}
                className="bg-primary">
                {bulkMut.isPending ? <RefreshCw size={13} className="animate-spin mr-1" /> : <UserCheck size={13} className="mr-1" />}
                Assign {selectedIds.size > 0 ? selectedIds.size : moveCount}
              </Button>
            </>
          )}
        </div>

        {!adminSecret && (
          <Alert className="m-3 py-2">
            <AlertDescription className="text-xs">Unlock admin secret to enable assignment actions.</AlertDescription>
          </Alert>
        )}

        {/* ── Select-all / count bar ── */}
        <div className="px-3 py-1.5 border-b bg-muted/10 flex items-center gap-3 text-xs text-muted-foreground">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={selectAll}
              onChange={(e) => setSelectAll(e.target.checked)} className="rounded" />
            Select all {total} visible
          </label>
          {selectedIds.size > 0 && (
            <span className="text-blue-600 font-medium">{selectedIds.size} selected</span>
          )}
          <span className="ml-auto">{isLoading ? "Loading…" : `${total} unassigned`}</span>
        </div>

        {/* ── Customer list ── */}
        <div className="flex-1 overflow-y-auto">
          {customers.map((c) => (
            <label key={c.customer_id}
              className="flex items-start gap-3 px-3 py-2.5 border-b hover:bg-muted/30 cursor-pointer">
              <input type="checkbox"
                checked={selectedIds.has(c.customer_id)}
                onChange={(e) => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    e.target.checked ? next.add(c.customer_id) : next.delete(c.customer_id);
                    return next;
                  });
                  if (!e.target.checked) setSelectAll(false);
                }}
                className="rounded flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm truncate">{c.name}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {typeBadge(c.type)}
                  {c.territory_name && (
                    <span className="text-[11px] text-muted-foreground">{c.territory_name}</span>
                  )}
                </div>
                {/* Formerly assigned to */}
                {c.former_person_name_raw && (
                  <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                    <span className="opacity-60">Previously:</span>
                    <span className="italic">{c.former_person_name_raw}</span>
                    <span className="opacity-50">(departed)</span>
                  </div>
                )}
                {/* Suggestion hint */}
                {c.suggested_person_id !== null && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <Lightbulb size={10} className="text-amber-400 flex-shrink-0" />
                    <span className="text-[11px] text-amber-700 dark:text-amber-300">
                      → {c.suggested_person_name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      ({coverageText(c.suggestion_rule, c.suggestion_cover_count, c.territory_total_assigned)})
                    </span>
                  </div>
                )}
              </div>
              <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0 mt-0.5">
                {c.customer_id}
              </span>
            </label>
          ))}
          {!isLoading && customers.length === 0 && (
            <div className="p-8 text-center text-muted-foreground">
              <UserCheck size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">No unassigned customers in this filter</p>
            </div>
          )}
        </div>

        {/* ── Pagination ── */}
        {Math.ceil(total / 100) > 1 && (
          <div className="flex items-center justify-between px-3 py-2 border-t text-xs text-muted-foreground">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-40">← Prev</button>
            <span>{page} / {Math.ceil(total / 100)}</span>
            <button disabled={page >= Math.ceil(total / 100)} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-40">Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TAB 2 — REVIEW QUEUE
// ═══════════════════════════════════════════════════════════════════════════

function ReviewQueueTab({ adminSecret }: { adminSecret: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: pd } = usePersonList();
  const people = pd?.people ?? [];

  // Propose form
  const [name, setName] = useState("");
  const [type, setType] = useState("retailer");
  const [notes, setNotes] = useState("");
  const [submittedBy, setSubmittedBy] = useState("");

  const { data, isLoading } = useQuery<{ total: number; pending: number; items: QueueItem[] }>({
    queryKey: ["master-review-queue"],
    queryFn: () => fetch(`${BASE}/api/master/customers/review-queue`).then((r) => r.json()),
  });

  const proposeMut = useMutation({
    mutationFn: () =>
      fetch(`${BASE}/api/master/customers/review-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), type, notes: notes.trim() || null,
          submitted_by: submittedBy.trim() || "unknown" }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? r.statusText); return r.json(); }),
    onSuccess: (d) => {
      toast({ title: "Proposed", description: `"${d.item.name}" added to review queue (id ${d.item.id})` });
      setName(""); setNotes(""); setSubmittedBy("");
      qc.invalidateQueries({ queryKey: ["master-review-queue"] });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const approveMut = useMutation({
    mutationFn: ({ id, reviewed_by }: { id: number; reviewed_by: string }) =>
      fetch(`${BASE}/api/master/customers/review-queue/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": adminSecret },
        body: JSON.stringify({ reviewed_by }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? r.statusText); return r.json(); }),
    onSuccess: (d) => {
      toast({ title: "Approved", description: `Customer created: ${d.customerId}` });
      qc.invalidateQueries({ queryKey: ["master-review-queue"] });
      qc.invalidateQueries({ queryKey: ["master-customers"] });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      fetch(`${BASE}/api/master/customers/review-queue/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": adminSecret },
        body: JSON.stringify({ reviewed_by: "admin", reason }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error ?? r.statusText); return r.json(); }),
    onSuccess: () => {
      toast({ title: "Rejected" });
      qc.invalidateQueries({ queryKey: ["master-review-queue"] });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const items = data?.items ?? [];

  return (
    <div className="flex flex-1 min-h-0">
      {/* Left — propose form */}
      <div className="w-72 flex-shrink-0 border-r p-4 space-y-4 overflow-y-auto">
        <div>
          <div className="text-sm font-medium mb-3">Propose new customer</div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name <span className="text-destructive">*</span></label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" className="h-8 text-sm" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Type</label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VALID_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Notes</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional context" className="h-8 text-sm" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Submitted by</label>
              <Input value={submittedBy} onChange={(e) => setSubmittedBy(e.target.value)} placeholder="Your name" className="h-8 text-sm" />
            </div>
            <Button size="sm" onClick={() => proposeMut.mutate()}
              disabled={!name.trim() || proposeMut.isPending} className="w-full">
              {proposeMut.isPending ? "Submitting…" : "Submit proposal"}
            </Button>
          </div>
        </div>

        <Alert className="py-2">
          <AlertDescription className="text-xs">
            Proposed customers land in the review queue — NOT in the customer table.
            Admin must approve before any customer_id is assigned.
          </AlertDescription>
        </Alert>
      </div>

      {/* Right — queue list */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {isLoading && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
        {!isLoading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <ClipboardList size={40} className="opacity-30" />
            <p className="text-sm">No proposals yet</p>
          </div>
        )}
        {items.map((item) => (
          <QueueRow key={item.id} item={item} adminSecret={adminSecret}
            onApprove={(reviewed_by) => approveMut.mutate({ id: item.id, reviewed_by })}
            onReject={(reason) => rejectMut.mutate({ id: item.id, reason })} />
        ))}
      </div>
    </div>
  );
}

function QueueRow({ item, adminSecret, onApprove, onReject }:
  { item: QueueItem; adminSecret: string; onApprove: (by: string) => void; onReject: (r: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [reviewer, setReviewer] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  const statusIcon = item.review_status === "approved" ? (
    <CheckCircle2 size={14} className="text-green-600" />
  ) : item.review_status === "rejected" ? (
    <AlertTriangle size={14} className="text-red-500" />
  ) : (
    <ClipboardList size={14} className="text-amber-500" />
  );

  return (
    <div className={cn("border-b px-4 py-3", item.review_status === "approved" && "bg-green-50/50 dark:bg-green-950/10",
      item.review_status === "rejected" && "bg-red-50/50 dark:bg-red-950/10")}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {statusIcon}
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{item.name}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              {typeBadge(item.type)}
              <span className="text-[11px] text-muted-foreground">
                #{item.id} · {item.submitted_by} · {new Date(item.submitted_at).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
        {item.review_status === "pending" && adminSecret && (
          <button onClick={() => setExpanded((e) => !e)}
            className="text-xs text-blue-600 flex-shrink-0 hover:underline">
            {expanded ? "collapse" : "review"}
          </button>
        )}
        {item.approved_customer_id && (
          <span className="text-[11px] font-mono text-green-700 flex-shrink-0">{item.approved_customer_id}</span>
        )}
      </div>
      {item.notes && <p className="text-xs text-muted-foreground mt-1 pl-6">{item.notes}</p>}
      {expanded && item.review_status === "pending" && (
        <div className="mt-3 pl-6 space-y-2">
          <Input value={reviewer} onChange={(e) => setReviewer(e.target.value)}
            placeholder="Reviewer name" className="h-7 text-xs" />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
              onClick={() => onApprove(reviewer || "admin")}>
              ✓ Approve → creates customer
            </Button>
            <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reject reason" className="h-7 text-xs flex-1" />
            <Button size="sm" variant="destructive" className="h-7 text-xs"
              onClick={() => onReject(rejectReason)}>
              ✗ Reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════

export default function OrgCustomersPage() {
  const { secret, setSecret } = useAdminSecret();
  const [tab, setTab] = useState(0);

  // Unassigned count for badge
  const { data: unassignedData } = useQuery<{ total: number; customers: unknown[]; territoryGroups: unknown[] }>({
    queryKey: ["master-unassigned-total"],
    queryFn: () => fetch(`${BASE}/api/master/customers/unassigned?limit=1`).then((r) => r.json()),
    staleTime: 60_000,
  });
  const unassignedCount = unassignedData?.total ?? 0;

  // Review queue pending count
  const { data: queueData } = useQuery<{ total: number; pending: number; items: unknown[] }>({
    queryKey: ["master-review-queue-count"],
    queryFn: () => fetch(`${BASE}/api/master/customers/review-queue`).then((r) => r.json()),
    staleTime: 60_000,
  });
  const pendingCount = queueData?.pending ?? 0;

  const tabs = [
    { label: "Customers", icon: <Store size={14} /> },
    { label: `Unassigned ${unassignedCount ? `(${unassignedCount.toLocaleString()})` : ""}`, icon: <Users size={14} /> },
    { label: `Review Queue ${pendingCount ? `(${pendingCount})` : ""}`, icon: <ClipboardList size={14} /> },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0 bg-background">
        <div>
          <h1 className="text-base font-semibold">Organisation / Customers</h1>
          <p className="text-xs text-muted-foreground">Phase 3 of the editable master</p>
        </div>
        <AdminBar secret={secret} setSecret={setSecret} />
      </div>

      {/* Tab bar */}
      <div className="flex border-b flex-shrink-0 bg-background">
        {tabs.map((t, i) => (
          <button key={i} onClick={() => setTab(i)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2.5 text-sm border-b-2 transition-colors",
              tab === i
                ? "border-primary text-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}>
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 0 && <CustomersTab adminSecret={secret} />}
      {tab === 1 && <UnassignedTab adminSecret={secret} />}
      {tab === 2 && <ReviewQueueTab adminSecret={secret} />}
    </div>
  );
}
