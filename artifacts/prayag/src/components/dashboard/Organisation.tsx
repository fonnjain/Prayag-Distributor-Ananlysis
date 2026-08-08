import { trunc2 } from "@/lib/trunc";
// DS1 — Organisation: State Heads level.
// Three-level model: State Heads → States (DS2) → Employees (DS3).
// This file implements Level 1 only; DS2 and DS3 tabs are shown as locked.
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Users,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  Plus,
  Lock,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API = "/api";

// ── Types (mirror backend) ────────────────────────────────────────────────────

type HeadStatus = "active" | "left" | "inactive";

interface Alias {
  id: number;
  headId: string;
  alias: string;
  fySeen: string | null;
  createdAt: string;
}

interface Flag {
  id: number;
  headId: string | null;
  flagType: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail: Record<string, unknown>;
  status: "open" | "acknowledged" | "resolved";
  createdAt: string;
}

interface StateHead {
  id: string;
  displayName: string;
  status: HeadStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  hq: string | null;
  notes: string | null;
  isDualRole: boolean;
  dualRoleDetail: string | null;
  sheetRowRef: string | null;
  aliases: Alias[];
  flags: Flag[];
  memberCount: number;
}

interface AliasCheckMatch {
  id: string;
  displayName: string;
  matchType: "name" | "alias";
  alias?: string;
}

interface AuditEntry {
  id: number;
  headId: string;
  changedAt: string;
  changedBy: string | null;
  action: string;
  detail: Record<string, unknown> | null;
}

interface OrgData {
  heads: StateHead[];
  globalFlags: Flag[];
  seeded: boolean;
  totalMembers: number;
}

interface RosterHealth {
  rowsParsed: number;
  activeCount: number;
  deactiveCount: number;
  coverage: {
    designation: number;
    reportingManager: number;
    ctc: number;
    headquarter: number;
    workingState: number;
    assignedSegment: number;
  };
  orderType: Record<string, number>;
  badEmpCodeNames: string[];
  sharedEmpCode: {
    empCode: string;
    people: Array<{ name: string; city: string; reportingManager: string }>;
  } | null;
  possibleDuplicate: {
    empCode: string;
    rows: Array<{ name: string; city: string; status: string }>;
  } | null;
  unresolvedManagers: string[];
  ambiguousNameCount: number;
  ambiguousNames: Array<{ name: string; count: number }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(status: HeadStatus) {
  if (status === "active")
    return (
      <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-0 text-xs py-0 px-2">
        Active
      </Badge>
    );
  if (status === "left")
    return (
      <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0 text-xs py-0 px-2">
        Left
      </Badge>
    );
  return (
    <Badge className="bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border-0 text-xs py-0 px-2">
      Inactive
    </Badge>
  );
}

function flagIcon(severity: Flag["severity"]) {
  if (severity === "error") return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
  if (severity === "warning") return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
  return <Info className="h-4 w-4 text-blue-500 shrink-0" />;
}

function flagBg(severity: Flag["severity"]) {
  if (severity === "error") return "border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20";
  if (severity === "warning") return "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20";
  return "border-blue-200 bg-blue-50 dark:border-blue-900/40 dark:bg-blue-950/20";
}

// ── Add Head modal ─────────────────────────────────────────────────────────────

function AddHeadModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [status, setStatus] = useState<HeadStatus>("active");
  const [hq, setHq] = useState("");
  const [checking, setChecking] = useState(false);
  const [matches, setMatches] = useState<AliasCheckMatch[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkingTo, setLinkingTo] = useState<AliasCheckMatch | null>(null);
  const [linkFySeen, setLinkFySeen] = useState("");
  const [linking, setLinking] = useState(false);

  // Debounced alias check as user types.
  useEffect(() => {
    if (name.trim().length < 2) { setMatches([]); return; }
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const r = await fetch(`${API}/org/state-heads/alias-check?name=${encodeURIComponent(name.trim())}`);
        const d: { matches: AliasCheckMatch[] } = await r.json();
        setMatches(d.matches);
      } finally {
        setChecking(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [name]);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const r = await fetch(`${API}/org/state-heads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name.trim(), status, hq: hq.trim() || undefined }),
      });
      if (!r.ok) {
        const e: { error?: string } = await r.json();
        setError(e.error ?? "Create failed");
        return;
      }
      onCreated();
      onClose();
    } finally {
      setCreating(false);
    }
  }

  async function handleLinkAlias() {
    if (!linkingTo) return;
    setError(null);
    setLinking(true);
    try {
      const r = await fetch(`${API}/org/state-heads/${linkingTo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addAlias: name.trim(),
          aliasedFySeen: linkFySeen.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const e: { error?: string } = await r.json();
        setError(e.error ?? "Link failed");
        return;
      }
      onCreated();
      onClose();
    } finally {
      setLinking(false);
    }
  }

  const hasExactAlias = matches.some(
    (m) => m.matchType === "alias" && m.alias?.toLowerCase() === name.trim().toLowerCase(),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-2xl p-6 space-y-5 mx-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-base">Add State Head</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Name + alias check */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Full name</label>
          <div className="relative">
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setLinkingTo(null); }}
              placeholder="e.g. Sandeep Ji"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {checking && (
              <Loader2 className="absolute right-2.5 top-2.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* Matches */}
          {name.trim().length >= 2 && !checking && matches.length > 0 && !linkingTo && (
            <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20 p-3 space-y-2">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                This name matches existing records:
              </p>
              {matches.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2">
                  <div className="text-xs text-amber-900 dark:text-amber-200">
                    <span className="font-medium">{m.displayName}</span>
                    {m.matchType === "alias" && (
                      <span className="text-amber-600 dark:text-amber-400"> (via alias "{m.alias}")</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-6 px-2 border-amber-400 text-amber-800 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-300"
                    onClick={() => setLinkingTo(m)}
                  >
                    Link as alias
                  </Button>
                </div>
              ))}
              <p className="text-xs text-amber-700 dark:text-amber-400 pt-1 border-t border-amber-200 dark:border-amber-800">
                If this is genuinely a new person, scroll down and click "Create new head" anyway.
              </p>
            </div>
          )}

          {/* No match — show clear message */}
          {name.trim().length >= 2 && !checking && matches.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No existing head or alias matches this name.
            </p>
          )}
        </div>

        {/* Link-as-alias flow */}
        {linkingTo && (
          <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900/40 dark:bg-blue-950/20 p-4 space-y-3">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
              Add <span className="font-semibold">"{name.trim()}"</span> as an alias for{" "}
              <span className="font-semibold">{linkingTo.displayName}</span>
            </p>
            <div className="space-y-1">
              <label className="text-xs font-medium text-blue-700 dark:text-blue-400">
                FY first seen (optional, e.g. 2025-26)
              </label>
              <input
                type="text"
                value={linkFySeen}
                onChange={(e) => setLinkFySeen(e.target.value)}
                placeholder="leave blank if unknown"
                className="w-full rounded border border-blue-300 dark:border-blue-700 bg-white dark:bg-blue-950/40 px-2 py-1 text-sm focus:outline-none"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleLinkAlias} disabled={linking} className="flex-1">
                {linking ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                Confirm link
              </Button>
              <Button size="sm" variant="outline" onClick={() => setLinkingTo(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Status + HQ (only for create flow) */}
        {!linkingTo && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium">Status</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as HeadStatus)}
                  className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-sm focus:outline-none"
                >
                  <option value="active">Active</option>
                  <option value="left">Left</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">HQ (optional)</label>
                <input
                  type="text"
                  value={hq}
                  onChange={(e) => setHq(e.target.value)}
                  placeholder="e.g. Jaipur"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none"
                />
              </div>
            </div>

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                onClick={handleCreate}
                disabled={!name.trim() || creating || hasExactAlias}
                className="flex-1"
              >
                {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                Create new head
              </Button>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Mark-left modal ────────────────────────────────────────────────────────────

function MarkLeftModal({
  head,
  onClose,
  onDone,
}: {
  head: StateHead;
  onClose: () => void;
  onDone: () => void;
}) {
  const [effectiveTo, setEffectiveTo] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${API}/org/state-heads/${head.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "left", effectiveTo }),
      });
      if (!r.ok) { const e: { error?: string } = await r.json(); setError(e.error ?? "Failed"); return; }
      onDone();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card shadow-2xl p-6 space-y-5 mx-4">
        <h3 className="font-semibold text-base">Mark as Left — {head.displayName}</h3>
        <p className="text-sm text-muted-foreground">
          This sets the status to <strong>Left</strong> and records an effective date. All historical
          data is preserved permanently. This does not write to Google Drive.
        </p>
        <div className="space-y-1">
          <label className="text-sm font-medium">Effective date</label>
          <input
            type="date"
            value={effectiveTo}
            onChange={(e) => setEffectiveTo(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button onClick={confirm} disabled={saving} variant="destructive" className="flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            Confirm
          </Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// ── Single head row ────────────────────────────────────────────────────────────

function HeadRow({
  head,
  onRefresh,
}: {
  head: StateHead;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [markingLeft, setMarkingLeft] = useState(false);
  const openFlags = head.flags.filter((f) => f.status === "open" || f.status === "acknowledged");

  return (
    <>
      {markingLeft && (
        <MarkLeftModal head={head} onClose={() => setMarkingLeft(false)} onDone={onRefresh} />
      )}
      <tr
        className={cn(
          "border-b border-border/50 hover:bg-muted/30 transition-colors cursor-pointer",
          head.status === "left" && "opacity-70",
        )}
        onClick={() => setExpanded((x) => !x)}
      >
        <td className="px-4 py-3 w-5">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{head.displayName}</span>
            {head.isDualRole && (
              <Badge className="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border-0 text-xs py-0 px-1.5">
                dual-role
              </Badge>
            )}
          </div>
          {head.aliases.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {head.aliases.map((a) => (
                <span
                  key={a.id}
                  className="text-xs text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5"
                >
                  {a.alias}
                  {a.fySeen && (
                    <span className="text-muted-foreground/70"> ({a.fySeen})</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="px-4 py-3">{statusBadge(head.status)}</td>
        <td className="px-4 py-3 text-sm tabular-nums text-right font-medium">
          {head.memberCount > 0 ? head.memberCount : (head.status === "left" ? "—" : "0")}
        </td>
        <td className="px-4 py-3">
          {openFlags.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              {openFlags.length}
            </span>
          )}
        </td>
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
          {head.status === "active" && (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-7 text-muted-foreground hover:text-destructive"
              onClick={() => setMarkingLeft(true)}
            >
              Mark left
            </Button>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="bg-muted/10 border-b border-border/40">
          <td />
          <td colSpan={5} className="px-6 py-4 space-y-3">
            {/* Details */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <p className="font-medium text-muted-foreground uppercase tracking-wide mb-0.5">ID</p>
                <p className="font-mono text-foreground">{head.id}</p>
              </div>
              {head.hq && (
                <div>
                  <p className="font-medium text-muted-foreground uppercase tracking-wide mb-0.5">HQ</p>
                  <p>{head.hq}</p>
                </div>
              )}
              {head.effectiveFrom && (
                <div>
                  <p className="font-medium text-muted-foreground uppercase tracking-wide mb-0.5">From</p>
                  <p>{new Date(head.effectiveFrom).toLocaleDateString()}</p>
                </div>
              )}
              {head.effectiveTo && (
                <div>
                  <p className="font-medium text-muted-foreground uppercase tracking-wide mb-0.5">Left on</p>
                  <p>{new Date(head.effectiveTo).toLocaleDateString()}</p>
                </div>
              )}
            </div>

            {/* Dual-role detail */}
            {head.isDualRole && head.dualRoleDetail && (
              <div className="rounded-md border border-purple-200 bg-purple-50 dark:border-purple-900/40 dark:bg-purple-950/20 px-3 py-2 text-xs text-purple-800 dark:text-purple-300 flex items-start gap-2">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-purple-500" />
                <span>{head.dualRoleDetail}</span>
              </div>
            )}

            {/* Notes */}
            {head.notes && (
              <p className="text-xs text-muted-foreground italic">{head.notes}</p>
            )}

            {/* Flags */}
            {openFlags.map((f) => (
              <div
                key={f.id}
                className={cn(
                  "rounded-md border px-3 py-2 text-xs flex items-start gap-2",
                  flagBg(f.severity),
                )}
              >
                {flagIcon(f.severity)}
                <div className="space-y-1">
                  <p className="font-medium">{f.title}</p>
                  {typeof f.detail?.description === "string" && (
                    <p className="text-muted-foreground leading-relaxed">
                      {f.detail.description}
                    </p>
                  )}
                  {f.detail?.customerCount != null && (
                    <p>
                      Customers: <strong>{String(f.detail.customerCount)}</strong>
                      {f.detail.revenueInr != null && (
                        <span>
                          {" · "}₹{trunc2(((f.detail.revenueInr as number) / 1e7))} Cr
                        </span>
                      )}
                    </p>
                  )}
                </div>
              </div>
            ))}

            {/* Aliases detail */}
            {head.aliases.length > 0 && (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">Confirmed aliases: </span>
                {head.aliases.map((a) => (
                  <span key={a.id} className="mr-2">
                    "{a.alias}"
                    {a.fySeen ? ` (FY ${a.fySeen})` : " (all FYs)"}
                  </span>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Audit trail ────────────────────────────────────────────────────────────────

function AuditTrail() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`${API}/org/state-heads/audit`)
      .then((r) => r.json())
      .then((d: { entries: AuditEntry[] }) => setEntries(d.entries ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [open]);

  const actionLabel: Record<string, string> = {
    created: "Created",
    seeded: "Seeded",
    status_changed: "Status changed",
    alias_added: "Alias added",
    alias_removed: "Alias removed",
    notes_updated: "Notes updated",
  };

  return (
    <div className="border-t border-border/50 pt-4">
      <button
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setOpen((x) => !x)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Clock className="h-3.5 w-3.5" />
        Audit trail
      </button>

      {open && (
        <div className="mt-3 space-y-1.5">
          {loading ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading...
            </div>
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">No audit entries yet.</p>
          ) : (
            entries.map((e) => (
              <div key={e.id} className="flex items-start gap-3 text-xs">
                <span className="text-muted-foreground tabular-nums shrink-0 w-24">
                  {new Date(e.changedAt).toLocaleDateString()}
                </span>
                <span className="font-medium shrink-0 w-28">
                  {actionLabel[e.action] ?? e.action}
                </span>
                <span className="text-muted-foreground">
                  {e.headId}
                  {e.detail?.displayName ? ` · ${String(e.detail.displayName)}` : ""}
                  {e.detail?.alias ? ` · alias "${String(e.detail.alias)}"` : ""}
                  {e.detail?.from && e.detail?.to
                    ? ` · ${String(e.detail.from)} → ${String(e.detail.to)}`
                    : ""}
                </span>
                {e.changedBy && (
                  <span className="text-muted-foreground/60 ml-auto shrink-0">by {e.changedBy}</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Roster health panel ──────────────────────────────────────────────────────
// Read-only overlay computed from hr_roster.csv (Sales_User_List). Every item
// is advisory — HR corrects at source; the app never auto-fixes or merges.

function CoverageBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium">{value.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full",
            value >= 99 ? "bg-emerald-500" : value >= 90 ? "bg-amber-500" : "bg-red-500",
          )}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}

function RosterHealthPanel() {
  const [health, setHealth] = useState<RosterHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllBad, setShowAllBad] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${API}/org/roster-health`)
      .then((r) => {
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        return r.json();
      })
      .then((d: RosterHealth) => { if (!cancelled) setHealth(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Load failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading roster health…
      </div>
    );
  }
  if (error || !health) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        Roster health unavailable ({error ?? "no data"}).
      </div>
    );
  }

  const orderEntries = Object.entries(health.orderType).sort((a, b) => b[1] - a[1]);
  const badNames = showAllBad ? health.badEmpCodeNames : health.badEmpCodeNames.slice(0, 10);

  return (
    <div className="rounded-lg border border-border/50 bg-background p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-primary" />
        <h4 className="text-sm font-semibold">Roster health</h4>
        <span className="text-xs text-muted-foreground">
          hr_roster.csv (Sales_User_List) · {health.rowsParsed} rows
        </span>
      </div>

      {/* Active / Deactive */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-md border border-border/50 px-3 py-2">
          <p className="text-xs text-muted-foreground">Active</p>
          <p className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {health.activeCount}
          </p>
        </div>
        <div className="rounded-md border border-border/50 px-3 py-2">
          <p className="text-xs text-muted-foreground">Deactive</p>
          <p className="text-lg font-semibold tabular-nums text-muted-foreground">
            {health.deactiveCount}
          </p>
        </div>
        <div className="rounded-md border border-border/50 px-3 py-2 col-span-2">
          <p className="text-xs text-muted-foreground mb-1">Order Type (active)</p>
          <div className="flex flex-wrap gap-1.5">
            {orderEntries.map(([k, v]) => (
              <Badge
                key={k}
                className="bg-muted text-foreground border-0 text-xs py-0 px-2 tabular-nums"
              >
                {k}: {v}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      {/* Coverage */}
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          Coverage (active members)
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
          <CoverageBar label="Designation" value={health.coverage.designation} />
          <CoverageBar label="Reporting Manager" value={health.coverage.reportingManager} />
          <CoverageBar label="CTC" value={health.coverage.ctc} />
          <CoverageBar label="Headquarter" value={health.coverage.headquarter} />
          <CoverageBar label="Working State" value={health.coverage.workingState} />
          <CoverageBar label="Assigned Segment" value={health.coverage.assignedSegment} />
        </div>
      </div>

      {/* Bad employee codes */}
      <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20 px-3 py-2.5 space-y-2">
        <p className="text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {health.badEmpCodeNames.length} active members with an implausible employee code
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Codes that are non-numeric or longer than 4 digits (mobile numbers, keyboard
          input in the wrong field). Flagged for HR to correct at source — not auto-fixed.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {badNames.map((n) => (
            <span
              key={n}
              className="text-xs bg-white/60 dark:bg-amber-900/30 rounded px-1.5 py-0.5 text-amber-900 dark:text-amber-200"
            >
              {n}
            </span>
          ))}
        </div>
        {health.badEmpCodeNames.length > 10 && (
          <button
            className="text-xs text-amber-700 dark:text-amber-400 underline"
            onClick={() => setShowAllBad((x) => !x)}
          >
            {showAllBad ? "Show first 10" : `Show all ${health.badEmpCodeNames.length}`}
          </button>
        )}
      </div>

      {/* Shared placeholder code */}
      {health.sharedEmpCode && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20 px-3 py-2.5 space-y-1">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Employee code {health.sharedEmpCode.empCode} shared by two different active people
          </p>
          {health.sharedEmpCode.people.map((p) => (
            <p key={p.name} className="text-xs text-amber-900 dark:text-amber-200">
              {p.name} ({p.city}, reporting to {p.reportingManager})
            </p>
          ))}
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Two real people sharing a placeholder code — both kept.
          </p>
        </div>
      )}

      {/* Possible name-reversed duplicate */}
      {health.possibleDuplicate && (
        <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900/40 dark:bg-blue-950/20 px-3 py-2.5 space-y-1">
          <p className="text-xs font-medium text-blue-800 dark:text-blue-300 flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 shrink-0" />
            Possible duplicate under employee code {health.possibleDuplicate.empCode} — flagged for review
          </p>
          {health.possibleDuplicate.rows.map((r) => (
            <p key={r.name} className="text-xs text-blue-900 dark:text-blue-200">
              {r.name} ({r.city}, {r.status})
            </p>
          ))}
          <p className="text-xs text-blue-700 dark:text-blue-400">
            Looks like one person entered twice with the name reversed. Review manually —
            not merged automatically.
          </p>
        </div>
      )}

      {/* Ambiguous duplicate names */}
      {health.ambiguousNameCount > 0 && (
        <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900/40 dark:bg-blue-950/20 px-3 py-2.5 space-y-1.5">
          <p className="text-xs font-medium text-blue-800 dark:text-blue-300 flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 shrink-0" />
            {health.ambiguousNameCount} duplicate name{health.ambiguousNameCount !== 1 ? "s" : ""} — resolved only by reporting manager
          </p>
          <p className="text-xs text-blue-700 dark:text-blue-400">
            The same name appears on multiple rows under different managers. Enrichment is
            matched on name + reporting manager; a name with no manager match attaches nothing
            rather than another person's employee code / designation / CTC.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {health.ambiguousNames.map((a) => (
              <span
                key={a.name}
                className="text-xs bg-white/60 dark:bg-blue-900/30 rounded px-1.5 py-0.5 text-blue-900 dark:text-blue-200"
              >
                {a.name} ×{a.count}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Unresolved managers */}
      <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2.5">
        <p className="text-xs font-medium text-muted-foreground">
          Reporting Managers not resolving to a roster row: {health.unresolvedManagers.length}
        </p>
        {health.unresolvedManagers.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {health.unresolvedManagers.map((m) => (
              <span key={m} className="text-xs bg-muted rounded px-1.5 py-0.5">
                {m}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Organisation() {
  const [tab, setTab] = useState<"heads" | "states" | "employees">("heads");
  const [data, setData] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/org/state-heads`);
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      const d: OrgData = await r.json();
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleSeed() {
    setSeeding(true);
    try {
      const r = await fetch(`${API}/org/seed`, { method: "POST" });
      if (!r.ok) {
        const e: { error?: string } = await r.json();
        setError(e.error ?? "Seed failed");
        return;
      }
      await load();
    } finally {
      setSeeding(false);
    }
  }

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data.heads;
    return data.heads.filter(
      (h) =>
        h.displayName.toLowerCase().includes(q) ||
        h.aliases.some((a) => a.alias.toLowerCase().includes(q)),
    );
  }, [data, search]);

  const totalMembers = data?.totalMembers ?? 0;
  const activeCount = data?.heads.filter((h) => h.status === "active").length ?? 0;
  const leftCount = data?.heads.filter((h) => h.status === "left").length ?? 0;
  const openGlobalFlags = (data?.globalFlags ?? []).filter((f) => f.status !== "resolved");

  const TABS = [
    { id: "heads", label: "State Heads", icon: Users, locked: false },
    { id: "states", label: "States", icon: null, locked: true, ds: "DS2" },
    { id: "employees", label: "Employees", icon: null, locked: true, ds: "DS3" },
  ] as const;

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="px-6 pt-6 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-xl flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" />
              Organisation
            </CardTitle>
            <CardDescription className="mt-1">
              Canonical roster of State Heads, their states, and sales employees. App overlay — Google
              Drive is read-only; divergences are flagged.
            </CardDescription>
          </div>
          {!loading && !data?.seeded && (
            <Button onClick={handleSeed} disabled={seeding} size="sm">
              {seeding ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Seed from dashboard
            </Button>
          )}
          {data?.seeded && (
            <Button onClick={() => void load()} disabled={loading} size="sm" variant="ghost">
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
              Refresh
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="px-6 pb-6 space-y-5">
        {/* Tabs */}
        <div className="flex gap-1 border-b border-border/50">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => !t.locked && setTab(t.id as typeof tab)}
              disabled={t.locked}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                !t.locked && tab === t.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground",
                t.locked && "opacity-50 cursor-not-allowed",
              )}
            >
              {t.locked && <Lock className="h-3 w-3" />}
              {t.label}
              {"ds" in t && (
                <span className="text-xs bg-muted px-1 rounded">{t.ds}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── State Heads tab ──────────────────────────────────────────────── */}
        {tab === "heads" && (
          <div className="space-y-4">
            {/* KPI strip */}
            {data && (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                <div className="rounded-lg border border-border/50 bg-background px-4 py-3">
                  <p className="text-xs text-muted-foreground">State Heads</p>
                  <p className="text-xl font-semibold tabular-nums">
                    {activeCount}
                    {leftCount > 0 && (
                      <span className="text-sm text-red-500 ml-1.5">+{leftCount} left</span>
                    )}
                  </p>
                </div>
                <div className="rounded-lg border border-border/50 bg-background px-4 py-3">
                  <p className="text-xs text-muted-foreground">Members (live)</p>
                  <p className="text-xl font-semibold tabular-nums">{totalMembers}</p>
                </div>
                <div className="rounded-lg border border-border/50 bg-background px-4 py-3">
                  <p className="text-xs text-muted-foreground">Open flags</p>
                  <p className="text-xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                    {(data.heads.reduce(
                      (s, h) => s + h.flags.filter((f) => f.status !== "resolved").length,
                      0,
                    ) + openGlobalFlags.length) || "—"}
                  </p>
                </div>
                <div className="hidden sm:block rounded-lg border border-border/50 bg-background px-4 py-3">
                  <p className="text-xs text-muted-foreground">Source</p>
                  <p className="text-xs font-medium text-muted-foreground mt-0.5 leading-snug">
                    STATE HEAD DASHBOARD 2026-27<br />
                    tab Data, header row 3
                  </p>
                </div>
              </div>
            )}

            {/* Roster health panel (from hr_roster.csv / Sales_User_List) */}
            <RosterHealthPanel />

            {/* Global flags (non-territory etc.) */}
            {openGlobalFlags.map((f) => (
              <div
                key={f.id}
                className={cn("rounded-lg border px-4 py-3 flex items-start gap-3", flagBg(f.severity))}
              >
                {flagIcon(f.severity)}
                <div>
                  <p className="text-sm font-medium">{f.title}</p>
                  {typeof f.detail?.description === "string" && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {f.detail.description}
                    </p>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading roster...
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {/* Not seeded yet */}
            {!loading && data && !data.seeded && (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 px-8 py-12 text-center space-y-3">
                <Users className="h-10 w-10 text-muted-foreground mx-auto" />
                <p className="text-sm font-medium">No state heads yet</p>
                <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                  Click "Seed from dashboard" to populate the 12 confirmed State Heads and their
                  aliases from the STATE HEAD DASHBOARD 2026-27.
                </p>
              </div>
            )}

            {/* Table */}
            {!loading && data && data.seeded && (
              <>
                {/* Search + Add bar */}
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by name or alias…"
                      className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <Button size="sm" onClick={() => setShowAdd(true)}>
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    Add
                  </Button>
                </div>

                {/* Roster table */}
                <div className="rounded-lg border border-border/50 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/50 bg-muted/30">
                        <th className="px-4 py-2.5 w-5" />
                        <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">
                          Name / Aliases
                        </th>
                        <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">
                          Status
                        </th>
                        <th className="px-4 py-2.5 text-right font-medium text-muted-foreground text-xs uppercase tracking-wide">
                          Members
                        </th>
                        <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">
                          Flags
                        </th>
                        <th className="px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((h) => (
                        <HeadRow key={h.id} head={h} onRefresh={() => void load()} />
                      ))}
                      {filtered.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                            No state heads match "{search}".
                          </td>
                        </tr>
                      )}
                    </tbody>
                    {filtered.length > 0 && (
                      <tfoot>
                        <tr className="border-t border-border/50 bg-muted/10">
                          <td colSpan={3} className="px-4 py-2 text-xs text-muted-foreground">
                            {filtered.length} head{filtered.length !== 1 ? "s" : ""}
                            {search && ` matching "${search}"`}
                          </td>
                          <td className="px-4 py-2 text-xs tabular-nums text-right font-medium">
                            {filtered.reduce((s, h) => s + h.memberCount, 0)}
                          </td>
                          <td colSpan={2} />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>

                {/* Audit trail */}
                <AuditTrail />

                {/* Sheet-divergence notice */}
                <div className="rounded-md border border-border/50 bg-muted/20 px-4 py-3 flex items-start gap-2.5 text-xs text-muted-foreground">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    <strong>App roster is an overlay.</strong> Changes here do not write to Google
                    Drive. If the sheet and app diverge (e.g. a leaver not yet marked here), both
                    counts are shown as a data-quality flag.
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Locked tabs ─────────────────────────────────────────────────── */}
        {(tab === "states" || tab === "employees") && (
          <div className="py-16 flex flex-col items-center gap-3 text-center text-muted-foreground">
            <Lock className="h-8 w-8 opacity-40" />
            <p className="text-sm font-medium">
              {tab === "states" ? "States (DS2)" : "Employees (DS3)"}
            </p>
            <p className="text-xs max-w-xs">
              This level is built in a later phase. Complete DS1 verification first.
            </p>
          </div>
        )}
      </CardContent>

      {showAdd && (
        <AddHeadModal
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); void load(); }}
        />
      )}
    </Card>
  );
}
