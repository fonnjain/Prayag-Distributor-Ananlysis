// Phase 3 — Customer management page.
//
// Two-panel layout (mirrors OrgPeoplePage):
//   Left  — search + type filter + paginated customer list
//   Right — customer detail: current assignment, full history (collapsible),
//           reassign form (admin-gated), distributor↔retailer link list
//
// Bottom strip — unresolved seed links (13 remaining, 2 auto-resolved).
//
// Verification contract (the check the user will run):
//   GET /api/master/customers/by-head before reassignment
//   PATCH /api/master/customers/:id/assign
//   GET /api/master/customers/by-head after reassignment
//   The two responses must be byte-for-byte identical.
//   sale_line.head_canon is baked at ingestion; this route never touches it.

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
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ─────────────────────────────────────────────────────────────────────

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

interface Link {
  id: number;
  link_order: number;
  retailer_id: string;
  retailer_name: string;
  distributor_id: string;
  distributor_name: string;
  effective_from: string;
  effective_to: string | null;
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
  links: Link[];
}

interface PersonOption {
  person_id: number;
  name: string;
  designation_name: string | null;
}

interface UnresolvedLink {
  id: number;
  raw_name: string;
  link_count: number;
  notes: string | null;
  resolution: string | null;
  mapped_to_id: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function typeBadge(type: string) {
  const map: Record<string, string> = {
    distributor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    retailer: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    direct_dealer: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    sub_dealer: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    project: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  };
  return (
    <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide", map[type] ?? "bg-muted text-muted-foreground")}>
      {type.replace("_", " ")}
    </span>
  );
}

function confidenceDot(conf: string | null) {
  const map: Record<string, string> = {
    confirmed: "bg-green-500",
    assign_user_chain: "bg-blue-400",
    state_lookup: "bg-yellow-400",
    guessed: "bg-gray-400",
  };
  return (
    <span
      title={conf ?? "unassigned"}
      className={cn("inline-block w-2 h-2 rounded-full flex-shrink-0", map[conf ?? ""] ?? "bg-gray-300")}
    />
  );
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useAdminSecret() {
  const [secret, setSecretState] = useState(() =>
    sessionStorage.getItem("master_admin_secret") ?? "",
  );
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

// ── Sub-components ────────────────────────────────────────────────────────────

function AssignForm({
  customerId,
  current,
  adminSecret,
  onDone,
}: {
  customerId: string;
  current: Assignment | null;
  adminSecret: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: peopleData } = usePersonList();
  const people = peopleData?.people ?? [];

  const [personId, setPersonId] = useState<string>(
    current?.person_id?.toString() ?? "",
  );
  const [shId, setShId] = useState<string>(
    current?.state_head_person_id?.toString() ?? "",
  );
  const [reason, setReason] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      fetch(`${BASE}/api/master/customers/${customerId}/assign`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": adminSecret },
        body: JSON.stringify({
          person_id: personId ? Number(personId) : null,
          state_head_person_id: shId ? Number(shId) : null,
          confidence: "confirmed",
          changed_by: reason || "operator",
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
        return r.json();
      }),
    onSuccess: () => {
      toast({ title: "Assignment updated", description: `${customerId} reassigned successfully.` });
      qc.invalidateQueries({ queryKey: ["master-customer-detail", customerId] });
      qc.invalidateQueries({ queryKey: ["master-customers"] });
      onDone();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const noChange =
    (personId || "") === (current?.person_id?.toString() ?? "") &&
    (shId || "") === (current?.state_head_person_id?.toString() ?? "");

  return (
    <div className="space-y-3 pt-3 border-t">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Reassign
      </div>
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">Territory Manager</label>
        <Select value={personId} onValueChange={setPersonId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="— none —" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {people.map((p) => (
              <SelectItem key={p.person_id} value={String(p.person_id)}>
                {p.name}
                {p.designation_name ? ` · ${p.designation_name}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">State Head</label>
        <Select value={shId} onValueChange={setShId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="— none —" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {people.filter((p) => p.designation_name?.toLowerCase().includes("manager") ||
              p.designation_name?.toLowerCase().includes("vp") ||
              p.designation_name?.toLowerCase().includes("president")).map((p) => (
              <SelectItem key={p.person_id} value={String(p.person_id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">Reason / changed_by</label>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="operator name or reason"
          className="h-8 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => mut.mutate()}
          disabled={mut.isPending || noChange}
          className="flex-1"
        >
          {mut.isPending ? "Saving…" : "Confirm reassignment"}
        </Button>
        <Button size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Creates a new effective row from today. Historical sale_line figures are
        unaffected — verify with <code className="font-mono">/api/master/customers/by-head</code>.
      </p>
    </div>
  );
}

function HistoryRow({ a }: { a: Assignment }) {
  const isCurrent = !a.effective_to;
  return (
    <div className={cn("rounded p-2 text-xs space-y-0.5 border", isCurrent ? "border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800" : "border-border bg-muted/30")}>
      <div className="flex items-center gap-1.5">
        {confidenceDot(a.confidence)}
        <span className="font-medium">{a.person_name ?? "— unassigned —"}</span>
        {isCurrent && <Badge variant="outline" className="text-[10px] h-4 px-1 border-blue-400 text-blue-600">current</Badge>}
      </div>
      {a.state_head_name && (
        <div className="text-muted-foreground pl-3.5">SH: {a.state_head_name}</div>
      )}
      <div className="text-muted-foreground pl-3.5">
        {a.effective_from} → {a.effective_to ?? "open"}
        {a.set_by ? ` · set by ${a.set_by}` : ""}
      </div>
    </div>
  );
}

function DetailPanel({
  customerId,
  adminSecret,
}: {
  customerId: string;
  adminSecret: string;
}) {
  const { data, isLoading, error } = useQuery<CustomerDetail>({
    queryKey: ["master-customer-detail", customerId],
    queryFn: () =>
      fetch(`${BASE}/api/master/customers/${customerId}`).then((r) => r.json()),
    enabled: !!customerId,
  });

  const [editing, setEditing] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (error || !data)
    return (
      <div className="p-6 text-sm text-destructive">
        {String(error ?? "Customer not found")}
      </div>
    );

  const { customer, currentAssignment, assignmentHistory, links } = data;
  const isAdmin = !!adminSecret;

  return (
    <div className="p-5 space-y-5 overflow-y-auto h-full">
      {/* Header */}
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold leading-tight">{customer.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              {typeBadge(customer.type)}
              <span className="text-xs text-muted-foreground font-mono">{customer.customer_id}</span>
              {customer.status && customer.status !== "active" && (
                <span className="text-[10px] text-orange-600 font-medium uppercase">{customer.status}</span>
              )}
            </div>
          </div>
          {links.length > 0 && (
            <span title="Has distributor↔retailer links" className="text-blue-500 mt-1">
              <Link2 size={16} />
            </span>
          )}
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
              <Badge variant="outline" className="text-[10px] h-4 px-1 ml-auto">
                {currentAssignment.confidence}
              </Badge>
            </div>
            {currentAssignment.state_head_name && (
              <p className="text-xs text-muted-foreground">State Head: {currentAssignment.state_head_name}</p>
            )}
            <p className="text-xs text-muted-foreground">
              From {currentAssignment.effective_from}
              {currentAssignment.set_by ? ` · ${currentAssignment.set_by}` : ""}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">No current assignment</p>
        )}
      </div>

      {/* Reassign form */}
      {isAdmin && !editing && (
        <Button size="sm" variant="outline" onClick={() => setEditing(true)} className="w-full">
          Reassign customer
        </Button>
      )}
      {editing && (
        <AssignForm
          customerId={customerId}
          current={currentAssignment}
          adminSecret={adminSecret}
          onDone={() => setEditing(false)}
        />
      )}

      {/* Assignment history */}
      {assignmentHistory.length > 1 && (
        <Collapsible open={histOpen} onOpenChange={setHistOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
            {histOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Assignment history ({assignmentHistory.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 space-y-1.5">
            {assignmentHistory.map((a) => (
              <HistoryRow key={a.id} a={a} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Links */}
      {links.length > 0 && (
        <Collapsible open={linksOpen} onOpenChange={setLinksOpen}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
            {linksOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Link2 size={12} />
            {customer.type === "retailer"
              ? `Distributors (${links.length})`
              : `Linked retailers (${links.length})`}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 space-y-1">
            {links.map((l) => (
              <div key={l.id} className="text-xs bg-muted/40 rounded px-2 py-1 flex items-center gap-2">
                <span className="text-muted-foreground w-4 text-center">{l.link_order}</span>
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

// ── Unresolved Links Panel ────────────────────────────────────────────────────

function UnresolvedLinksPanel() {
  const { data } = useQuery<{
    items: UnresolvedLink[];
    totalLostLinks: number;
    unresolvedCount: number;
  }>({
    queryKey: ["master-unresolved-links"],
    queryFn: () => fetch(`${BASE}/api/master/unresolved-links`).then((r) => r.json()),
  });

  const [open, setOpen] = useState(false);

  if (!data) return null;
  const { items, totalLostLinks, unresolvedCount } = data;

  return (
    <div className="border-t bg-muted/20">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-medium hover:bg-muted/40 transition-colors">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <AlertTriangle size={13} className={unresolvedCount > 0 ? "text-amber-500" : "text-green-500"} />
          <span>
            Unresolved seed links — {unresolvedCount} of {items.length} names pending
            &nbsp;·&nbsp;{totalLostLinks} links total
          </span>
          <span className="ml-auto text-muted-foreground">
            {items.filter((i) => i.resolution).length} resolved
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 pb-3 space-y-1">
            {items.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "rounded px-2.5 py-1.5 text-xs flex items-start gap-2",
                  item.resolution ? "bg-green-50 dark:bg-green-950/20" : "bg-amber-50 dark:bg-amber-950/20",
                )}
              >
                <span className="mt-0.5 flex-shrink-0">
                  {item.resolution ? (
                    <CheckCircle2 size={13} className="text-green-600" />
                  ) : (
                    <AlertTriangle size={13} className="text-amber-500" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{item.raw_name}</div>
                  <div className="text-muted-foreground">
                    {item.link_count} links
                    {item.notes ? ` · ${item.notes}` : ""}
                    {item.mapped_to_id ? ` → ${item.mapped_to_id}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OrgCustomersPage() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const { secret, setSecret } = useAdminSecret();
  const [secretInput, setSecretInput] = useState("");
  const { toast } = useToast();

  // Debounce search
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
      fetch(
        `${BASE}/api/master/customers?q=${encodeURIComponent(debouncedQ)}&type=${typeParam}&page=${page}&limit=50`,
      ).then((r) => r.json()),
  });

  const customers = data?.customers ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / 50);

  const unlock = () => {
    if (!secretInput.trim()) return;
    setSecret(secretInput.trim());
    setSecretInput("");
    toast({ title: "Admin mode enabled" });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0 bg-background">
        <div>
          <h1 className="text-base font-semibold">Organisation / Customers</h1>
          <p className="text-xs text-muted-foreground">
            {total.toLocaleString()} customers · Phase 3 of the editable master
          </p>
        </div>
        <div className="flex items-center gap-2">
          {secret ? (
            <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
              <Unlock size={13} />
              Admin
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <Lock size={13} className="text-muted-foreground" />
              <Input
                type="password"
                value={secretInput}
                onChange={(e) => setSecretInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && unlock()}
                placeholder="Admin secret to enable edits"
                className="h-7 w-52 text-xs"
              />
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={unlock}>
                Unlock
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Main body */}
      <div className="flex flex-1 min-h-0">
        {/* Left — list */}
        <div className="w-72 flex-shrink-0 border-r flex flex-col">
          {/* Filters */}
          <div className="p-3 border-b space-y-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name or ID…"
                className="pl-8 h-8 text-sm"
              />
            </div>
            <Select value={type} onValueChange={(v) => { setType(v); setPage(1); }}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="distributor">Distributor</SelectItem>
                <SelectItem value="retailer">Retailer</SelectItem>
                <SelectItem value="direct_dealer">Direct Dealer</SelectItem>
                <SelectItem value="sub_dealer">Sub Dealer</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {isLoading && (
              <div className="p-4 text-sm text-muted-foreground text-center">Loading…</div>
            )}
            {!isLoading && customers.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground text-center">No results</div>
            )}
            {customers.map((c) => (
              <button
                key={c.customer_id}
                onClick={() => setSelected(c.customer_id)}
                className={cn(
                  "w-full text-left px-3 py-2.5 border-b hover:bg-muted/50 transition-colors",
                  selected === c.customer_id && "bg-muted",
                )}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="font-medium text-sm leading-tight truncate">{c.name}</span>
                  <div className="flex-shrink-0 flex items-center gap-1 mt-0.5">
                    {c.has_link && <Link2 size={11} className="text-blue-400" />}
                    {confidenceDot(c.confidence)}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  {typeBadge(c.type)}
                  {c.person_name && (
                    <span className="text-[11px] text-muted-foreground truncate">{c.person_name}</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-3 py-2 border-t text-xs text-muted-foreground">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="disabled:opacity-40 hover:text-foreground"
              >
                ← Prev
              </button>
              <span>{page} / {totalPages}</span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="disabled:opacity-40 hover:text-foreground"
              >
                Next →
              </button>
            </div>
          )}
        </div>

        {/* Right — detail */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {selected ? (
            <DetailPanel customerId={selected} adminSecret={secret} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <Store size={40} className="opacity-30" />
              <p className="text-sm">Select a customer to view details</p>
            </div>
          )}
        </div>
      </div>

      {/* Unresolved links strip */}
      <UnresolvedLinksPanel />
    </div>
  );
}
