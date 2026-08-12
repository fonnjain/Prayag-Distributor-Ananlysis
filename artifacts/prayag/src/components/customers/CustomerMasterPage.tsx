// Customer Data — editable attribution master for Distributors, Direct Dealers,
// and Retailers. This is the single source of truth for "which customer belongs
// to which State Head" — it does NOT store rupee/quantity values (those stay in
// the live sale sheets).
//
// Views:
//   Distributor | Direct Dealer | Retailer  — filtered table with inline editing
//   Review Queue                            — pending head-attribution mismatches
//
// Inline editing: click any cell to edit; Enter/blur saves; Esc cancels.
// Import: upload xlsx (ID column required) → diff preview → confirm.
// Export: download current filtered view as xlsx.
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCustomerMaster,
  getListCustomerMasterQueryKey,
  useUpdateCustomerMasterRecord,
  useListCustomerMismatches,
  getListCustomerMismatchesQueryKey,
  useResolveCustomerMismatch,
  getGetCustomerMismatchCountQueryKey,
} from "@workspace/api-client-react";
import type {
  CustomerMasterRow,
  CustomerMasterImportPreview,
  CustomerMismatchRow,
  ListCustomerMasterType,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

// State heads are fetched live from /api/org/state-heads so the filter and
// edit dropdowns always reflect the current person registry (no hardcoded list).
// Populated in CustomerMasterPage via useEffect; passed down as a prop.

const TABS = [
  { id: "Distributor",    label: "Distributors" },
  { id: "Direct Dealer",  label: "Direct Dealers" },
  { id: "Retailer",       label: "Retailers" },
  { id: "insights",       label: "Upload Insights" },
  { id: "queue",          label: "Review Queue" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const STATUS_COLORS: Record<string, string> = {
  Active:    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  Inactive:  "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  Closed:    "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  Converted: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  Confirmed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  Guessed:   "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
};

// ── Editable cell ─────────────────────────────────────────────────────────────

interface EditableCellProps {
  value: string | null | undefined;
  isEditing: boolean;
  onStart: () => void;
  onSave: (v: string) => void;
  onCancel: () => void;
  options?: string[];
  placeholder?: string;
  className?: string;
}

function EditableCell({
  value, isEditing, onStart, onSave, onCancel, options, placeholder, className,
}: EditableCellProps) {
  const [draft, setDraft] = useState(value ?? "");

  if (isEditing) {
    if (options) {
      return (
        <select
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onSave(draft)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter") { onSave(draft); }
            if (e.key === "Escape") { onCancel(); }
          }}
          className="w-full rounded border bg-background px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
        onBlur={() => onSave(draft)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter") { onSave(draft); }
          if (e.key === "Escape") { onCancel(); }
        }}
        placeholder={placeholder}
        className="w-full rounded border bg-background px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
      />
    );
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onStart}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onStart(); }}
      className={cn(
        "block min-h-[1.25rem] cursor-pointer rounded px-1 hover:bg-muted/60 transition-colors",
        className,
      )}
      title="Click to edit"
    >
      {value || <span className="text-muted-foreground/50 italic">{placeholder ?? "—"}</span>}
    </span>
  );
}

// ── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ value, colorMap }: { value: string | null | undefined; colorMap: Record<string, string> }) {
  if (!value) return <span className="text-muted-foreground/40">—</span>;
  const cls = colorMap[value] ?? "bg-muted text-muted-foreground";
  return <span className={cn("px-1.5 py-0.5 rounded text-[11px] font-medium leading-none", cls)}>{value}</span>;
}

// ── Import preview dialog ─────────────────────────────────────────────────────

interface ImportPreviewProps {
  preview: CustomerMasterImportPreview;
  onCommit: () => void;
  onCancel: () => void;
  committing: boolean;
}

function ImportPreviewDialog({ preview, onCommit, onCancel, committing }: ImportPreviewProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-background rounded-lg border shadow-lg max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h3 className="font-semibold">Import Preview</h3>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground text-xl leading-none">&times;</button>
        </div>
        <div className="px-5 py-4 flex-1 overflow-y-auto space-y-4">
          <div className="flex gap-6 text-sm">
            <span><strong>{preview.inserts}</strong> new records</span>
            <span><strong>{preview.updates}</strong> updates</span>
            <span><strong>{preview.unchanged}</strong> unchanged</span>
            <span className="text-muted-foreground">Total: {preview.totalRows}</span>
          </div>

          {preview.updateDetails.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Fields to update (showing {Math.min(preview.updateDetails.length, 20)} of {preview.updates})
              </p>
              <div className="rounded border divide-y max-h-60 overflow-y-auto text-xs">
                {preview.updateDetails.slice(0, 20).map((d) => (
                  <div key={d.id} className="px-3 py-2">
                    <p className="font-medium">{d.company} <span className="text-muted-foreground font-normal">({d.id})</span></p>
                    {Object.entries(d.changes).map(([field, { old: o, new: n }]) => (
                      <p key={field} className="ml-2 mt-0.5 text-muted-foreground">
                        <span className="font-mono">{field}</span>:{" "}
                        <span className="line-through text-red-600 dark:text-red-400">{o || "(empty)"}</span>
                        {" "}&rarr;{" "}
                        <span className="text-emerald-600 dark:text-emerald-400">{n || "(empty)"}</span>
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {preview.inserts > 0 && preview.insertSample.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                New records (sample of {preview.insertSample.length})
              </p>
              <div className="rounded border divide-y max-h-40 overflow-y-auto text-xs">
                {preview.insertSample.map((r) => (
                  <div key={r.id} className="px-3 py-1.5 flex gap-3">
                    <span className="font-mono text-muted-foreground">{r.id}</span>
                    <span className="font-medium">{r.company}</span>
                    <span className="text-muted-foreground">{r.type}</span>
                    <span className="text-muted-foreground">{r.stateHead ?? "—"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {preview.updates === 0 && preview.inserts === 0 && (
            <p className="text-sm text-muted-foreground">No changes to apply — all rows are already up to date.</p>
          )}
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded border text-sm hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          {(preview.updates > 0 || preview.inserts > 0) && (
            <button
              onClick={onCommit}
              disabled={committing}
              className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {committing ? "Committing..." : `Apply ${preview.updates + preview.inserts} changes`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Review queue tab ──────────────────────────────────────────────────────────

function ReviewQueue() {
  const { data, isLoading } = useListCustomerMismatches({ pending: true });
  const resolve = useResolveCustomerMismatch();
  const qc = useQueryClient();

  const handle = (id: number, resolution: "approved" | "dismissed") => {
    resolve.mutate(
      { mid: id, data: { resolution } },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: getListCustomerMismatchesQueryKey() });
          void qc.invalidateQueries({ queryKey: getGetCustomerMismatchCountQueryKey() });
        },
      },
    );
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">Loading...</div>;
  }

  const rows = data?.rows ?? [];
  const pending = rows.filter((r) => !r.resolvedAt);

  if (pending.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-2">
        <div className="text-4xl">&#10003;</div>
        <p className="text-sm font-medium">Review queue is empty</p>
        <p className="text-xs">No pending head-attribution mismatches.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground mb-3">
        These customers have a different State Head in the live sale sheet vs the master.
        Approve to update the master, dismiss to keep the master as-is.
      </p>
      <div className="rounded border overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/40 border-b">
              <th className="px-3 py-2 text-left font-medium">Customer</th>
              <th className="px-3 py-2 text-left font-medium">Master Head</th>
              <th className="px-3 py-2 text-left font-medium">Sheet Head</th>
              <th className="px-3 py-2 text-left font-medium">FY</th>
              <th className="px-3 py-2 text-left font-medium">Detected</th>
              <th className="px-3 py-2 text-left font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {pending.map((row: CustomerMismatchRow) => (
              <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-3 py-2">
                  <div className="font-medium">{row.customerName}</div>
                  {row.customerId && <div className="text-muted-foreground">{row.customerId}</div>}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{row.masterHead ?? "—"}</td>
                <td className="px-3 py-2 font-medium">{row.sheetHead}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.fy}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {new Date(row.detectedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    <button
                      onClick={() => handle(row.id, "approved")}
                      disabled={resolve.isPending}
                      className="px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-100 text-emerald-800 hover:bg-emerald-200 disabled:opacity-50 dark:bg-emerald-900/40 dark:text-emerald-200 transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handle(row.id, "dismissed")}
                      disabled={resolve.isPending}
                      className="px-2 py-0.5 rounded text-[11px] font-medium bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50 transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Upload Insights panel ──────────────────────────────────────────────────────
// Surfaces the Distributer/Retailer upload load: headline Active retailers
// (Leads kept separate, NEVER folded into coverage), the 40 unassigned Active
// retailers by district, the referenced-distributor-name vs Channel-Partner
// reconciliation, the post-split referential-integrity panel, and the 59
// review groups (same state+district, different phone) for human adjudication.

interface UploadInsights {
  retailer: {
    active: number; lead: number; inactive: number;
    statusBreakdown: Record<string, number>;
  };
  distributor: { statusBreakdown: Record<string, number> };
  unassignedActiveRetailers: {
    total: number;
    byDistrict: Array<{ district: string | null; count: number }>;
  };
  distributorNameReconciliation: {
    referencedByActiveRetailers: number; referencedSource: string;
    channelPartners: number; channelPartnersSource: string;
  };
  referentialIntegrity: {
    distributorSlots: { total: number; resolved: number; pct: number };
    userSlots: { total: number; resolved: number; pct: number };
    orphanCount: number; orphanNames: string[];
  };
  reviewGroups: Array<{
    groupNo: number;
    members: Array<{
      id: string; company: string; address: string | null;
      district: string | null; state: string | null;
      phone: string | null; gst: string | null;
    }>;
  }>;
}

function fmt(n: number): string {
  return n.toLocaleString("en-IN");
}

function UploadInsightsPanel() {
  const [data, setData] = useState<UploadInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError(null);
    fetch(`${BASE}/api/customer-master/upload-insights`)
      .then((r) => { if (!r.ok) throw new Error("Failed to load insights"); return r.json(); })
      .then((d: UploadInsights) => { if (!ignore) { setData(d); setLoading(false); } })
      .catch((e: Error) => { if (!ignore) { setError(e.message); setLoading(false); } });
    return () => { ignore = true; };
  }, []);

  if (loading) return <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">Loading insights…</div>;
  if (error || !data) return <div className="flex items-center justify-center h-32 text-destructive text-sm">{error ?? "No data."}</div>;

  const ri = data.referentialIntegrity;
  const rec = data.distributorNameReconciliation;

  return (
    <div className="space-y-6">
      {/* Headline retailer status: Active headline, Leads separate */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Retailer status</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border p-3 bg-emerald-50 dark:bg-emerald-900/20">
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{fmt(data.retailer.active)}</p>
            <p className="text-xs text-muted-foreground">Active retailers (headline)</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-2xl font-bold">{fmt(data.retailer.lead)}</p>
            <p className="text-xs text-muted-foreground">Leads (shown separately — never coverage)</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-2xl font-bold">{fmt(data.retailer.inactive)}</p>
            <p className="text-xs text-muted-foreground">Inactive</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-sm font-medium mb-1">Distributor status</p>
            {Object.entries(data.distributor.statusBreakdown).map(([k, v]) => (
              <p key={k} className="text-xs text-muted-foreground">{k}: <strong>{fmt(v)}</strong></p>
            ))}
          </div>
        </div>
      </section>

      {/* 40 unassigned Active retailers by district */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Actionable: {fmt(data.unassignedActiveRetailers.total)} Active retailers with NO distributor assigned
        </h2>
        <div className="rounded border overflow-hidden max-w-md">
          <table className="w-full text-xs">
            <thead><tr className="bg-muted/40 border-b"><th className="px-3 py-1.5 text-left font-medium">District</th><th className="px-3 py-1.5 text-right font-medium">Count</th></tr></thead>
            <tbody className="divide-y">
              {data.unassignedActiveRetailers.byDistrict.map((r) => (
                <tr key={r.district ?? "(none)"}><td className="px-3 py-1.5">{r.district ?? "(none)"}</td><td className="px-3 py-1.5 text-right">{r.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Referenced distributor names vs Channel Partners — sources named */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Distributor-name reconciliation (not reconciled silently)</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg border p-3">
            <p className="text-2xl font-bold">{fmt(rec.referencedByActiveRetailers)}</p>
            <p className="text-xs font-medium">Distinct distributor names referenced by Active retailers</p>
            <p className="text-[11px] text-muted-foreground mt-1">Source: {rec.referencedSource}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-2xl font-bold">{fmt(rec.channelPartners)}</p>
            <p className="text-xs font-medium">Channel Partners</p>
            <p className="text-[11px] text-muted-foreground mt-1">Source: {rec.channelPartnersSource}</p>
          </div>
        </div>
      </section>

      {/* Referential integrity — post-split resolution % */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Referential integrity (post comma-split)</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-lg border p-3">
            <p className="text-2xl font-bold">{ri.distributorSlots.pct}%</p>
            <p className="text-xs text-muted-foreground">Distributor slots resolving to distributor master ({fmt(ri.distributorSlots.resolved)} / {fmt(ri.distributorSlots.total)})</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-2xl font-bold">{ri.userSlots.pct}%</p>
            <p className="text-xs text-muted-foreground">User slots resolving to HR roster ({fmt(ri.userSlots.resolved)} / {fmt(ri.userSlots.total)})</p>
          </div>
        </div>
        <div className="mt-3">
          <p className="text-xs font-medium mb-1">{ri.orphanCount} orphan distributor name{ri.orphanCount === 1 ? "" : "s"} (referenced by Active retailers, unresolved)</p>
          <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-0.5">
            {ri.orphanNames.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      </section>

      {/* 59 review groups side-by-side */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {data.reviewGroups.length} duplicate-name review groups (same state + district, different phone — never auto-merged)
        </h2>
        <div className="space-y-3">
          {data.reviewGroups.map((g) => (
            <div key={g.groupNo} className="rounded border overflow-x-auto">
              <table className="w-full text-xs min-w-[720px]">
                <thead>
                  <tr className="bg-muted/40 border-b">
                    <th className="px-3 py-1.5 text-left font-medium">Group #{g.groupNo} — Company</th>
                    <th className="px-3 py-1.5 text-left font-medium">Address</th>
                    <th className="px-3 py-1.5 text-left font-medium">District</th>
                    <th className="px-3 py-1.5 text-left font-medium">Phone</th>
                    <th className="px-3 py-1.5 text-left font-medium">GST</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {g.members.map((m) => (
                    <tr key={m.id}>
                      <td className="px-3 py-1.5"><span className="font-medium">{m.company}</span> <span className="text-muted-foreground font-mono">{m.id}</span></td>
                      <td className="px-3 py-1.5 text-muted-foreground">{m.address ?? "—"}</td>
                      <td className="px-3 py-1.5">{m.district ?? "—"}</td>
                      <td className="px-3 py-1.5 font-mono">{m.phone ?? "—"}</td>
                      <td className="px-3 py-1.5 font-mono">{m.gst ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CustomerMasterPage() {
  const [activeTab, setActiveTab] = useState<TabId>("Distributor");

  // State heads — fetched live from the person registry so the dropdowns
  // always reflect the current territory structure (no hardcoded list).
  const [stateHeads, setStateHeads] = useState<string[]>([]);
  useEffect(() => {
    fetch(`${BASE}/api/org/state-heads`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { heads: Array<{ displayName: string; status: string }> }) => {
        const active = d.heads
          .filter((h) => h.status === "active")
          .map((h) => h.displayName)
          .sort((a, b) => a.localeCompare(b));
        setStateHeads(active);
      })
      .catch(() => {/* leave empty — dropdowns degrade gracefully */});
  }, []);

  // Filters
  const [search, setSearch] = useState("");
  const [filterHead, setFilterHead] = useState("");
  const [filterState, setFilterState] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterConfidence, setFilterConfidence] = useState("");

  // Editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);

  // History panel
  const [historyId, setHistoryId] = useState<string | null>(null);

  // Import state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<CustomerMasterImportPreview | null>(null);
  const [committing, setCommitting] = useState(false);

  const qc = useQueryClient();
  const update = useUpdateCustomerMasterRecord();

  const isCustomerTab = activeTab !== "queue" && activeTab !== "insights";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listParams: any = isCustomerTab ? {
    type: activeTab,
    ...(filterHead ? { stateHead: filterHead } : {}),
    ...(filterState ? { state: filterState } : {}),
    ...(filterStatus ? { status: filterStatus } : {}),
    ...(filterConfidence ? { confidence: filterConfidence } : {}),
    ...(search ? { q: search } : {}),
    limit: 300,
  } : undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, isLoading } = useListCustomerMaster(listParams, { query: { enabled: isCustomerTab } as any });

  const rows = data?.rows ?? [];

  // ── Editing ──────────────────────────────────────────────────────────────────

  const startEdit = (id: string, field: string) => {
    setEditingId(id);
    setEditingField(field);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingField(null);
  };

  const saveEdit = useCallback((id: string, field: string, value: string) => {
    setEditingId(null);
    setEditingField(null);
    update.mutate(
      { id, data: { [field]: value || null, editedBy: "app" } as Parameters<typeof update.mutate>[0]["data"] },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: getListCustomerMasterQueryKey(listParams) });
        },
      },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, qc, JSON.stringify(listParams)]);

  // ── Export ───────────────────────────────────────────────────────────────────

  const handleExport = () => {
    const params = new URLSearchParams();
    if (isCustomerTab) params.set("type", activeTab);
    if (filterHead) params.set("stateHead", filterHead);
    if (filterState) params.set("state", filterState);
    if (filterStatus) params.set("status", filterStatus);
    if (filterConfidence) params.set("confidence", filterConfidence);
    const url = `${BASE}/api/customer-master/export?${params.toString()}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    a.click();
  };

  // ── Import ───────────────────────────────────────────────────────────────────

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImporting(true);
    setImportError(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(`${BASE}/api/customer-master/import/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" })) as { error?: string };
        throw new Error(err.error ?? "Upload failed");
      }
      const preview = await res.json() as CustomerMasterImportPreview;
      setImportPreview(preview);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleCommit = async () => {
    if (!importPreview?.rows) return;
    setCommitting(true);
    try {
      const res = await fetch(`${BASE}/api/customer-master/import/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: importPreview.batchId, rows: importPreview.rows, editedBy: "import" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Commit failed" })) as { error?: string };
        throw new Error(err.error ?? "Commit failed");
      }
      setImportPreview(null);
      void qc.invalidateQueries({ queryKey: getListCustomerMasterQueryKey() });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Commit failed");
      setImportPreview(null);
    } finally {
      setCommitting(false);
    }
  };

  // ── History panel data ────────────────────────────────────────────────────────

  const historyRow = historyId ? rows.find((r) => r.id === historyId) : null;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={handleFileChange} />

      {/* Import preview dialog */}
      {importPreview && (
        <ImportPreviewDialog
          preview={importPreview}
          onCommit={() => void handleCommit()}
          onCancel={() => setImportPreview(null)}
          committing={committing}
        />
      )}

      {/* Top bar */}
      <header className="flex items-center gap-2 border-b px-4 py-2.5 flex-shrink-0 flex-wrap">
        <h1 className="font-semibold text-sm whitespace-nowrap">Customer Data</h1>

        {/* Tabs */}
        <div className="flex items-center gap-1 ml-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={cn(
                "px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap",
                activeTab === t.id
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Filters (only for customer tabs) */}
        {isCustomerTab && (
          <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
            <input
              type="search"
              placeholder="Search company, city..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-xs w-40"
            />
            <select
              value={filterHead}
              onChange={(e) => setFilterHead(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-xs"
            >
              <option value="">All Heads</option>
              {stateHeads.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-xs"
            >
              <option value="">All Status</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Closed">Closed</option>
              <option value="Converted">Converted</option>
            </select>
            <select
              value={filterConfidence}
              onChange={(e) => setFilterConfidence(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-xs"
            >
              <option value="">Any confidence</option>
              <option value="Confirmed">Confirmed</option>
              <option value="Guessed">Guessed</option>
            </select>
          </div>
        )}

        {/* Action buttons */}
        <div className={cn("flex items-center gap-2", isCustomerTab ? "" : "ml-auto")}>
          {isCustomerTab && (
            <>
              {importError && (
                <span className="text-xs text-destructive">{importError}</span>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-medium hover:bg-muted transition-colors disabled:opacity-60"
              >
                {importing ? "Parsing..." : "Import xlsx"}
              </button>
              <button
                onClick={handleExport}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-medium hover:bg-muted transition-colors"
              >
                Export xlsx
              </button>
            </>
          )}
        </div>
      </header>

      {/* Content area */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4">

          {/* Review queue */}
          {activeTab === "queue" && <ReviewQueue />}

          {/* Upload insights */}
          {activeTab === "insights" && <UploadInsightsPanel />}

          {/* Customer table */}
          {isCustomerTab && (
            <>
              {isLoading && (
                <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">Loading...</div>
              )}
              {!isLoading && rows.length === 0 && (
                <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-2">
                  <p className="text-sm font-medium">No records found</p>
                  <p className="text-xs">No customers of this type are loaded. Master data is loaded from the admin Master Data page (CSV upload); xlsx import only updates existing rows.</p>
                </div>
              )}
              {!isLoading && rows.length > 0 && (
                <>
                  <p className="text-xs text-muted-foreground mb-2">
                    {data?.total ?? rows.length} records
                    {data?.total !== undefined && data.total > rows.length && ` (showing ${rows.length})`}
                    {" "}&mdash; click any cell to edit
                  </p>
                  <div className="rounded border overflow-x-auto">
                    <table className="w-full text-xs min-w-[900px]">
                      <thead>
                        <tr className="bg-muted/40 border-b">
                          <th className="px-3 py-2 text-left font-medium w-28">ID</th>
                          <th className="px-3 py-2 text-left font-medium">Company</th>
                          <th className="px-3 py-2 text-left font-medium w-24">Status</th>
                          <th className="px-3 py-2 text-left font-medium">State Head</th>
                          <th className="px-3 py-2 text-left font-medium w-24">Confidence</th>
                          <th className="px-3 py-2 text-left font-medium">State</th>
                          <th className="px-3 py-2 text-left font-medium">City</th>
                          <th className="px-3 py-2 text-left font-medium">Contact</th>
                          {activeTab === "Retailer" && (
                            <th className="px-3 py-2 text-left font-medium">Distributor</th>
                          )}
                          <th className="px-3 py-2 text-left font-medium">Notes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {rows.map((row: CustomerMasterRow) => {
                          const editing = (field: string) =>
                            editingId === row.id && editingField === field;

                          const cell = (
                            field: string,
                            value: string | null | undefined,
                            opts?: { options?: string[]; placeholder?: string; className?: string }
                          ) => (
                            <EditableCell
                              key={field}
                              value={value}
                              isEditing={editing(field)}
                              onStart={() => startEdit(row.id, field)}
                              onSave={(v) => saveEdit(row.id, field, v)}
                              onCancel={cancelEdit}
                              options={opts?.options}
                              placeholder={opts?.placeholder}
                              className={opts?.className}
                            />
                          );

                          return (
                            <tr
                              key={row.id}
                              className={cn(
                                "hover:bg-muted/20 transition-colors",
                                historyId === row.id && "bg-primary/5",
                              )}
                            >
                              <td
                                className="px-3 py-1.5 font-mono text-muted-foreground cursor-pointer hover:text-primary"
                                onClick={() => setHistoryId((prev) => (prev === row.id ? null : row.id))}
                                title="Click to view change history"
                              >
                                {row.id}
                              </td>
                              <td className="px-3 py-1.5 min-w-[180px]">
                                {cell("company", row.company, { placeholder: "Company name" })}
                              </td>
                              <td className="px-3 py-1.5">
                                {editing("status") ? (
                                  <EditableCell
                                    value={row.status}
                                    isEditing
                                    onStart={() => {}}
                                    onSave={(v) => saveEdit(row.id, "status", v)}
                                    onCancel={cancelEdit}
                                    options={["Active", "Inactive", "Closed", "Converted"]}
                                  />
                                ) : (
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => startEdit(row.id, "status")}
                                    onKeyDown={(e) => { if (e.key === "Enter") startEdit(row.id, "status"); }}
                                  >
                                    <StatusChip value={row.status} colorMap={STATUS_COLORS} />
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 min-w-[160px]">
                                {editing("stateHead") ? (
                                  <EditableCell
                                    value={row.stateHead}
                                    isEditing
                                    onStart={() => {}}
                                    onSave={(v) => saveEdit(row.id, "stateHead", v)}
                                    onCancel={cancelEdit}
                                    options={["", ...stateHeads]}
                                  />
                                ) : (
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => startEdit(row.id, "stateHead")}
                                    onKeyDown={(e) => { if (e.key === "Enter") startEdit(row.id, "stateHead"); }}
                                    className="block min-h-[1.25rem] cursor-pointer rounded px-1 hover:bg-muted/60 transition-colors"
                                    title="Click to edit"
                                  >
                                    {row.stateHead || <span className="text-muted-foreground/50 italic">—</span>}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-1.5">
                                {editing("headConfidence") ? (
                                  <EditableCell
                                    value={row.headConfidence}
                                    isEditing
                                    onStart={() => {}}
                                    onSave={(v) => saveEdit(row.id, "headConfidence", v)}
                                    onCancel={cancelEdit}
                                    options={["Confirmed", "Guessed"]}
                                  />
                                ) : (
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => startEdit(row.id, "headConfidence")}
                                    onKeyDown={(e) => { if (e.key === "Enter") startEdit(row.id, "headConfidence"); }}
                                  >
                                    <StatusChip value={row.headConfidence} colorMap={CONFIDENCE_COLORS} />
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 min-w-[100px]">
                                {cell("state", row.state, { placeholder: "State" })}
                              </td>
                              <td className="px-3 py-1.5 min-w-[100px]">
                                {cell("city", row.city, { placeholder: "City" })}
                              </td>
                              <td className="px-3 py-1.5 min-w-[130px]">
                                {cell("contact", row.contact, { placeholder: "Contact name" })}
                              </td>
                              {activeTab === "Retailer" && (
                                <td className="px-3 py-1.5 min-w-[150px]">
                                  {cell("supplyingDistributor", row.supplyingDistributor, { placeholder: "Distributor" })}
                                </td>
                              )}
                              <td className="px-3 py-1.5 min-w-[140px]">
                                {cell("notes", row.notes, { placeholder: "Notes" })}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* History panel */}
        {historyId && historyRow && (
          <HistoryPanel
            id={historyId}
            company={historyRow.company}
            onClose={() => setHistoryId(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Change history panel ──────────────────────────────────────────────────────

function HistoryPanel({ id, company, onClose }: { id: string; company: string; onClose: () => void }) {
  const [log, setLog] = useState<Array<{
    id: number; changedAt: string; changedBy: string | null;
    field: string; oldValue: string | null; newValue: string | null; reason: string | null;
  }>>([]);
  const [loading, setLoading] = useState(true);

  const BASE_LOCAL = (import.meta as { env: Record<string, string> }).env.BASE_URL?.replace(/\/$/, "") ?? "";

  useState(() => {
    fetch(`${BASE_LOCAL}/api/customer-master/${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d: { log?: typeof log }) => { setLog(d.log ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  });

  return (
    <div className="w-80 border-l flex flex-col flex-shrink-0 overflow-hidden bg-background">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <p className="text-xs font-semibold truncate">{company}</p>
          <p className="text-[11px] text-muted-foreground font-mono">{id}</p>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg leading-none"
        >
          &times;
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Change History
        </p>
        {loading && <p className="text-xs text-muted-foreground">Loading...</p>}
        {!loading && log.length === 0 && (
          <p className="text-xs text-muted-foreground">No changes recorded.</p>
        )}
        {!loading && log.length > 0 && (
          <div className="space-y-3">
            {log.map((entry) => (
              <div key={entry.id} className="text-xs border-l-2 border-muted pl-2.5">
                <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                  <span>
                    {new Date(entry.changedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })}
                  </span>
                  {entry.changedBy && <span>&middot; {entry.changedBy}</span>}
                </div>
                {entry.field === "_created" ? (
                  <p className="font-medium text-muted-foreground">Record created</p>
                ) : (
                  <>
                    <p className="font-medium font-mono">{entry.field}</p>
                    <p className="text-muted-foreground">
                      <span className="line-through">{entry.oldValue || "(empty)"}</span>
                      {" "}&rarr;{" "}
                      <span className="text-foreground">{entry.newValue || "(empty)"}</span>
                    </p>
                    {entry.reason && <p className="text-muted-foreground/70 italic">{entry.reason}</p>}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
