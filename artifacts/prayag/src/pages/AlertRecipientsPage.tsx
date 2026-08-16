/**
 * Alert Routing Settings
 *
 * Three panels:
 *  1. Escalation ladder — shows who is at each level; flags empty levels.
 *  2. Recipients table  — add / edit / deactivate rows. Every field editable.
 *  3. Config tables     — severity thresholds + escalation windows (collapsible).
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Bell, Plus, Pencil, Trash2, Loader2,
  ChevronDown, ChevronUp, Settings, ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ─────────────────────────────────────────────────────────────────

type Recipient = {
  id: number;
  alert_code_pattern: string;
  scope_type: "state_head" | "all_india";
  scope_value: string | null;
  escalation_level: 1 | 2 | 3;
  name: string;
  channel: "whatsapp" | "email" | "in_app";
  contact: string | null;
  cadence: "on_raise" | "weekly";
  is_active: boolean;
  created_at: string;
};

type SeverityConfig = {
  id: number;
  code_pattern: string;
  is_severe: boolean;
  escalation_window_days: number;
  updated_at: string;
};

type EscalationConfig = {
  level: 1 | 2;
  window_days_severe: number;
  window_days_digest: number;
  updated_at: string;
};

type RecipientsResponse = {
  recipients: Recipient[];
  byLevel: Record<number, number>;
  emptyLevels: number[];
};

// ── Helpers ───────────────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<string, string> = {
  in_app: "In-app", email: "Email", whatsapp: "WhatsApp",
};

const CHANNEL_BADGE: Record<string, string> = {
  in_app: "bg-blue-50 text-blue-700",
  email: "bg-green-50 text-green-700",
  whatsapp: "bg-purple-50 text-purple-700",
};

const SCOPE_LABELS: Record<string, string> = {
  state_head: "State territory",
  all_india: "All India",
};

const LEVEL_LABELS: Record<number, string> = {
  1: "Level 1 — Initial",
  2: "Level 2 — Escalation",
  3: "Level 3 — CEO",
};

const LEVEL_COLORS: Record<number, string> = {
  1: "bg-blue-50 border-blue-200 text-blue-800",
  2: "bg-amber-50 border-amber-200 text-amber-800",
  3: "bg-red-50 border-red-200 text-red-800",
};

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

function adminFetch(url: string, opts: RequestInit = {}) {
  const secret = sessionStorage.getItem("adminSecret") ?? "";
  return fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Secret": secret,
      ...(opts.headers ?? {}),
    },
  });
}

// ── Escalation Ladder Panel ───────────────────────────────────────────────

function EscalationLadder({
  recipients,
  byLevel,
  emptyLevels,
}: {
  recipients: Recipient[];
  byLevel: Record<number, number>;
  emptyLevels: number[];
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5 mb-6">
      <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
        Escalation Ladder
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[1, 2, 3].map((level) => {
          const empty = emptyLevels.includes(level);
          const levelRecs = recipients.filter(
            (r) => r.escalation_level === level && r.is_active,
          );
          return (
            <div
              key={level}
              className={cn(
                "rounded-md border p-3",
                empty
                  ? "border-dashed border-destructive/40 bg-destructive/5"
                  : LEVEL_COLORS[level],
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold">{LEVEL_LABELS[level]}</span>
                {empty && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-destructive">
                    <AlertTriangle className="h-3 w-3" />
                    EMPTY
                  </span>
                )}
              </div>
              {levelRecs.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">
                  {level === 2 ? "No recipient — alerts skip to Level 3" : "No active recipients"}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {levelRecs.map((r) => (
                    <li key={r.id} className="text-xs truncate" title={r.name}>
                      <span className="font-medium">{r.name}</span>
                      {r.scope_type === "all_india" && (
                        <span className="ml-1 text-muted-foreground">(all India)</span>
                      )}
                      {r.scope_type === "state_head" && r.scope_value && (
                        <span className="ml-1 text-muted-foreground">(territory)</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {emptyLevels.includes(2) && (
        <p className="mt-3 text-xs text-muted-foreground border-l-2 border-amber-400 pl-2">
          Level 2 is intentionally blank. Unacknowledged alerts will skip directly to Level 3
          with a logged skip reason.
        </p>
      )}
    </div>
  );
}

// ── Readiness Panel ───────────────────────────────────────────────────────

function ReadinessPanel({
  recipients,
  emptyLevels,
}: {
  recipients: Recipient[];
  emptyLevels: number[];
}) {
  const issues: Array<{ key: string; title: string; description: string }> = [];

  // 1 — Level 2 empty: unacknowledged alerts skip directly to CEO
  if (emptyLevels.includes(2)) {
    issues.push({
      key: "l2_empty",
      title: "Level 2 is empty — alerts skip straight to the CEO",
      description:
        "Any alert unacknowledged for 7 days (severe) or 14 days (digest) escalates from Level 1 directly to Level 3 (Nitin Agarwal). A skip row is logged at Level 2 explaining the bypass, but no one at Level 2 sees it. Add a Level 2 recipient to create a middle escalation step.",
    });
  }

  // 2 — Recipients with no contact on file
  const blankContacts = recipients.filter((r) => r.is_active && !r.contact);
  if (blankContacts.length > 0) {
    const names = blankContacts.map((r) => r.name).join(", ");
    issues.push({
      key: "blank_contacts",
      title: `No contact on file: ${names}`,
      description:
        "Every alert matched to " +
        (blankContacts.length === 1 ? "this recipient" : "these recipients") +
        " will be logged as skipped with reason \"blank contact\". No message is sent. Add a phone number or email address to start receiving alerts.",
    });
  }

  // 3 — WhatsApp recipients exist but there is no provider configured
  const whatsappActive = recipients.filter(
    (r) => r.is_active && r.channel === "whatsapp",
  );
  if (whatsappActive.length > 0) {
    issues.push({
      key: "no_whatsapp_provider",
      title: "WhatsApp has no provider — deliveries will not transmit",
      description:
        `${whatsappActive.length} active recipient${whatsappActive.length !== 1 ? "s" : ""} use the WhatsApp channel (${whatsappActive.map((r) => r.name).join(", ")}). Deliveries are recorded as "pending" with reason "no provider configured" but no message reaches anyone. Configure a WhatsApp Business API provider to activate this channel.`,
    });
  }

  if (issues.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-5 mb-1">
      <h2 className="text-sm font-semibold text-amber-900 mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        Routing Readiness — {issues.length} issue{issues.length !== 1 ? "s" : ""} before this system is fully operational
      </h2>
      <ul className="space-y-3">
        {issues.map((issue) => (
          <li key={issue.key} className="flex gap-2.5">
            <span className="mt-0.5 text-amber-500 shrink-0 text-sm leading-none">▲</span>
            <div>
              <p className="text-sm font-medium text-amber-900">{issue.title}</p>
              <p className="text-xs text-amber-700 mt-0.5 leading-relaxed">{issue.description}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Recipient form ─────────────────────────────────────────────────────────

const BLANK_FORM = {
  name: "",
  alert_code_pattern: "*",
  scope_type: "all_india" as Recipient["scope_type"],
  scope_value: "",
  escalation_level: 1 as 1 | 2 | 3,
  channel: "whatsapp" as Recipient["channel"],
  contact: "",
  cadence: "on_raise" as Recipient["cadence"],
};

function RecipientForm({
  initial,
  onSubmit,
  onCancel,
  isLoading,
}: {
  initial?: typeof BLANK_FORM & { id?: number };
  onSubmit: (data: typeof BLANK_FORM) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const [form, setForm] = useState(initial ?? BLANK_FORM);
  const f = (k: keyof typeof BLANK_FORM) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}
      className="grid grid-cols-2 gap-3 text-sm"
    >
      <label className="col-span-2 space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Name</span>
        <input
          required
          value={form.name}
          onChange={f("name")}
          className="w-full rounded-md border px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </label>

      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Alert pattern</span>
        <select
          value={form.alert_code_pattern}
          onChange={f("alert_code_pattern")}
          className="w-full rounded-md border px-2 py-1.5 text-sm"
        >
          {["*", "A*", "B*", "C*", "S*", "B3"].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>

      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Level</span>
        <select
          value={form.escalation_level}
          onChange={(e) => setForm((p) => ({ ...p, escalation_level: Number(e.target.value) as 1 | 2 | 3 }))}
          className="w-full rounded-md border px-2 py-1.5 text-sm"
        >
          <option value={1}>Level 1 — Initial</option>
          <option value={2}>Level 2 — Escalation</option>
          <option value={3}>Level 3 — CEO</option>
        </select>
      </label>

      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Scope</span>
        <select
          value={form.scope_type}
          onChange={(e) => setForm((p) => ({ ...p, scope_type: e.target.value as Recipient["scope_type"] }))}
          className="w-full rounded-md border px-2 py-1.5 text-sm"
        >
          <option value="all_india">All India</option>
          <option value="state_head">State territory</option>
        </select>
      </label>

      {form.scope_type === "state_head" && (
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">State Head name</span>
          <input
            value={form.scope_value}
            onChange={f("scope_value")}
            placeholder="Anant Singh"
            className="w-full rounded-md border px-2.5 py-1.5 text-sm"
          />
        </label>
      )}

      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Channel</span>
        <select
          value={form.channel}
          onChange={(e) => setForm((p) => ({ ...p, channel: e.target.value as Recipient["channel"] }))}
          className="w-full rounded-md border px-2 py-1.5 text-sm"
        >
          <option value="whatsapp">WhatsApp</option>
          <option value="email">Email</option>
          <option value="in_app">In-app</option>
        </select>
      </label>

      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Contact {form.channel === "whatsapp" ? "(mobile)" : "(email)"}
        </span>
        <input
          value={form.contact}
          onChange={f("contact")}
          placeholder={form.channel === "whatsapp" ? "9xxxxxxxxx" : "user@domain.com"}
          className="w-full rounded-md border px-2.5 py-1.5 text-sm"
        />
      </label>

      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Cadence</span>
        <select
          value={form.cadence}
          onChange={(e) => setForm((p) => ({ ...p, cadence: e.target.value as Recipient["cadence"] }))}
          className="w-full rounded-md border px-2 py-1.5 text-sm"
        >
          <option value="on_raise">Immediate (severe)</option>
          <option value="weekly">Weekly digest</option>
        </select>
      </label>

      <div className="col-span-2 flex justify-end gap-2 mt-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="rounded-md bg-foreground text-background px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </button>
      </div>
    </form>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function AlertRecipientsPage() {
  const qc = useQueryClient();

  const [adminSecret, setAdminSecret] = useState(
    () => sessionStorage.getItem("adminSecret") ?? "",
  );
  const [secretInput, setSecretInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Recipient | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  const { data, isLoading, error } = useQuery<RecipientsResponse>({
    queryKey: ["alert-recipients"],
    queryFn: () => fetch(`${BASE}/api/alert-recipients`).then((r) => r.json()),
    staleTime: 30_000,
  });

  const { data: severityData } = useQuery<{ configs: SeverityConfig[] }>({
    queryKey: ["alert-severity-config"],
    queryFn: () => fetch(`${BASE}/api/alert-severity-config`).then((r) => r.json()),
    staleTime: 60_000,
  });

  const { data: escalationData } = useQuery<{ configs: EscalationConfig[] }>({
    queryKey: ["alert-escalation-config"],
    queryFn: () => fetch(`${BASE}/api/alert-escalation-config`).then((r) => r.json()),
    staleTime: 60_000,
  });

  const saveSecret = () => {
    sessionStorage.setItem("adminSecret", secretInput);
    setAdminSecret(secretInput);
  };

  const createMutation = useMutation({
    mutationFn: (body: object) =>
      adminFetch(`${BASE}/api/alert-recipients`, {
        method: "POST",
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["alert-recipients"] }); setAdding(false); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & object) =>
      adminFetch(`${BASE}/api/alert-recipients/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["alert-recipients"] }); setEditing(null); },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: number) =>
      adminFetch(`${BASE}/api/alert-recipients/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-recipients"] }),
  });

  const recipients = data?.recipients ?? [];
  const byLevel = data?.byLevel ?? {};
  const emptyLevels = data?.emptyLevels ?? [];

  // Group active recipients by level for the ladder
  const activeRecipients = recipients.filter((r) => r.is_active);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Alert Routing Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Who receives Red Alerts, when, and by which channel.
          </p>
        </div>
        {!adminSecret && (
          <div className="flex items-center gap-2">
            <input
              type="password"
              placeholder="Admin secret"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              className="rounded-md border px-2.5 py-1.5 text-sm w-40"
            />
            <button
              onClick={saveSecret}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Unlock
            </button>
          </div>
        )}
      </div>

      {/* Readiness Panel — surfaces known blockers before operators are surprised */}
      {!isLoading && data && (
        <ReadinessPanel recipients={activeRecipients} emptyLevels={emptyLevels} />
      )}

      {/* Escalation Ladder */}
      {!isLoading && data && (
        <EscalationLadder
          recipients={activeRecipients}
          byLevel={byLevel}
          emptyLevels={emptyLevels}
        />
      )}

      {/* Recipients Table */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <h2 className="text-sm font-semibold">Recipients</h2>
          {adminSecret && (
            <button
              onClick={() => { setAdding(true); setEditing(null); }}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors"
            >
              <Plus className="h-3 w-3" /> Add recipient
            </button>
          )}
        </div>

        {adding && (
          <div className="px-5 py-4 border-b border-border/50 bg-muted/30">
            <p className="text-xs font-semibold text-muted-foreground mb-3">New recipient</p>
            <RecipientForm
              onSubmit={(d) => createMutation.mutate(d)}
              onCancel={() => setAdding(false)}
              isLoading={createMutation.isPending}
            />
          </div>
        )}

        {isLoading && (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {error && (
          <p className="px-5 py-6 text-sm text-destructive">{String(error)}</p>
        )}

        {!isLoading && recipients.length === 0 && (
          <p className="px-5 py-8 text-sm text-muted-foreground text-center">
            No recipients configured.
          </p>
        )}

        {[1, 2, 3].map((level) => {
          const levelRecs = recipients.filter((r) => r.escalation_level === level);
          if (levelRecs.length === 0) return null;

          return (
            <div key={level}>
              <div className={cn("px-5 py-2 border-b border-border/30 text-xs font-semibold", level === 1 ? "bg-blue-50/50 text-blue-700" : level === 2 ? "bg-amber-50/50 text-amber-700" : "bg-red-50/50 text-red-700")}>
                {LEVEL_LABELS[level]} — {byLevel[level] ?? 0} active
                {emptyLevels.includes(level) && (
                  <span className="ml-2 inline-flex items-center gap-0.5 text-destructive">
                    <AlertTriangle className="h-3 w-3" /> empty
                  </span>
                )}
              </div>
              {levelRecs.map((r) => (
                <div key={r.id}>
                  {editing?.id === r.id ? (
                    <div className="px-5 py-4 border-b border-border/50 bg-muted/30">
                      <RecipientForm
                        initial={{
                          name: r.name,
                          alert_code_pattern: r.alert_code_pattern,
                          scope_type: r.scope_type,
                          scope_value: r.scope_value ?? "",
                          escalation_level: r.escalation_level,
                          channel: r.channel,
                          contact: r.contact ?? "",
                          cadence: r.cadence,
                          id: r.id,
                        }}
                        onSubmit={(d) => updateMutation.mutate({ id: r.id, ...d })}
                        onCancel={() => setEditing(null)}
                        isLoading={updateMutation.isPending}
                      />
                    </div>
                  ) : (
                    <div
                      className={cn(
                        "flex items-center gap-3 px-5 py-3 border-b border-border/30 text-sm",
                        !r.is_active && "opacity-40",
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={cn("font-medium", !r.is_active && "line-through")}>{r.name}</span>
                          <Badge className={CHANNEL_BADGE[r.channel] ?? "bg-muted text-muted-foreground"}>
                            {CHANNEL_LABELS[r.channel]}
                          </Badge>
                          <Badge className="bg-muted text-muted-foreground">
                            {r.alert_code_pattern}
                          </Badge>
                          <Badge className="bg-muted text-muted-foreground">
                            {SCOPE_LABELS[r.scope_type] ?? r.scope_type}
                            {r.scope_type === "state_head" && r.scope_value && `: ${r.scope_value}`}
                          </Badge>
                          <Badge className={r.cadence === "on_raise" ? "bg-amber-50 text-amber-700" : "bg-muted text-muted-foreground"}>
                            {r.cadence === "on_raise" ? "Immediate" : "Weekly"}
                          </Badge>
                          {!r.contact && (
                            <Badge className="bg-destructive/10 text-destructive">
                              blank contact
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {r.contact ?? <em>no contact on file — deliveries will be skipped</em>}
                        </p>
                      </div>
                      {adminSecret && r.is_active && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => { setEditing(r); setAdding(false); }}
                            className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground"
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => { if (confirm(`Deactivate ${r.name}?`)) deactivateMutation.mutate(r.id); }}
                            className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-destructive"
                            title="Deactivate"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Config tables (collapsible) */}
      <div className="rounded-lg border border-border bg-card">
        <button
          onClick={() => setConfigOpen((o) => !o)}
          className="w-full flex items-center justify-between px-5 py-4 text-sm font-semibold"
        >
          <span className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-muted-foreground" />
            Severity &amp; Escalation Windows
          </span>
          {configOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {configOpen && (
          <div className="border-t border-border/50 px-5 py-4 space-y-5">
            {/* Severity thresholds */}
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Severity thresholds — which codes fire immediately
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border/50">
                    <th className="pb-1 pr-4 font-medium">Pattern</th>
                    <th className="pb-1 pr-4 font-medium">Severe</th>
                    <th className="pb-1 font-medium">Window (days)</th>
                  </tr>
                </thead>
                <tbody>
                  {(severityData?.configs ?? []).map((c) => (
                    <tr key={c.id} className="border-b border-border/20">
                      <td className="py-1.5 pr-4 font-mono font-semibold">{c.code_pattern}</td>
                      <td className="py-1.5 pr-4">
                        <Badge className={c.is_severe ? "bg-red-50 text-red-700" : "bg-muted text-muted-foreground"}>
                          {c.is_severe ? "Severe" : "Digest"}
                        </Badge>
                      </td>
                      <td className="py-1.5 text-muted-foreground">{c.escalation_window_days}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Escalation windows */}
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Escalation windows — when does the next level receive it
              </h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border/50">
                    <th className="pb-1 pr-4 font-medium">Transition</th>
                    <th className="pb-1 pr-4 font-medium">Severe alert</th>
                    <th className="pb-1 font-medium">Digest alert</th>
                  </tr>
                </thead>
                <tbody>
                  {(escalationData?.configs ?? []).map((c) => (
                    <tr key={c.level} className="border-b border-border/20">
                      <td className="py-1.5 pr-4 font-semibold">
                        L{c.level} → L{c.level + 1}
                      </td>
                      <td className="py-1.5 pr-4 text-muted-foreground">{c.window_days_severe} days</td>
                      <td className="py-1.5 text-muted-foreground">{c.window_days_digest} days</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
