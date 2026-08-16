/**
 * Alert Recipients Settings — manage who receives alert notifications.
 *
 * Features:
 *  • List all recipients (active + deactivated)
 *  • Create / edit / deactivate via admin-secret-gated form
 *  • Severity config display (read-only table)
 */
import { useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Bell,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronUp,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ─────────────────────────────────────────────────────────────────

type Recipient = {
  id: number;
  alert_code_pattern: string;
  scope_type: "state_head" | "all";
  scope_value: string | null;
  escalation_level: 1 | 2;
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

// ── Helpers ───────────────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<string, string> = {
  in_app: "In-app",
  email: "Email",
  whatsapp: "WhatsApp",
};

const CADENCE_LABELS: Record<string, string> = {
  on_raise: "Immediate",
  weekly: "Weekly digest",
};

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

// ── Recipient form ─────────────────────────────────────────────────────────

const BLANK_FORM = {
  alert_code_pattern: "*",
  scope_type: "all" as "all" | "state_head",
  scope_value: "",
  escalation_level: 1 as 1 | 2,
  name: "",
  channel: "in_app" as "in_app" | "email" | "whatsapp",
  contact: "",
  cadence: "weekly" as "on_raise" | "weekly",
};

function RecipientForm({
  initial,
  adminSecret,
  onDone,
  onCancel,
}: {
  initial?: Partial<typeof BLANK_FORM> & { id?: number };
  adminSecret: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({ ...BLANK_FORM, ...initial });
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const isEdit = !!initial?.id;

  const mutation = useMutation({
    mutationFn: async () => {
      const url = isEdit
        ? `${BASE}/api/alert-recipients/${initial!.id}`
        : `${BASE}/api/alert-recipients`;
      const method = isEdit ? "PATCH" : "POST";
      const body: Record<string, unknown> = {
        alert_code_pattern: form.alert_code_pattern,
        scope_type: form.scope_type,
        scope_value: form.scope_type === "state_head" ? form.scope_value || null : null,
        escalation_level: form.escalation_level,
        name: form.name,
        channel: form.channel,
        contact: form.contact || null,
        cadence: form.cadence,
      };
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Secret": adminSecret,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["alert-recipients"] });
      onDone();
    },
    onError: (err) => setError(String((err as Error).message)),
  });

  const field = (label: string, key: keyof typeof BLANK_FORM, input: React.ReactNode) => (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      {input}
    </div>
  );

  const textInput = (key: keyof typeof BLANK_FORM, placeholder?: string) => (
    <input
      type="text"
      value={form[key] as string}
      onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      placeholder={placeholder}
      className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
    />
  );

  return (
    <div className="border rounded-xl p-4 bg-muted/30 space-y-3">
      <h3 className="text-sm font-semibold">{isEdit ? "Edit recipient" : "Add recipient"}</h3>

      <div className="grid grid-cols-2 gap-3">
        {field("Name *", "name", textInput("name", "e.g. Anant Singh"))}
        {field(
          "Code pattern *",
          "alert_code_pattern",
          <select
            value={form.alert_code_pattern}
            onChange={(e) => setForm((f) => ({ ...f, alert_code_pattern: e.target.value }))}
            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {["*", "A*", "B*", "C*", "S*", "B3"].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>,
        )}
        {field(
          "Channel *",
          "channel",
          <select
            value={form.channel}
            onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value as any }))}
            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="in_app">In-app</option>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </select>,
        )}
        {field("Contact (email / phone)", "contact", textInput("contact", "phone or email"))}
        {field(
          "Cadence *",
          "cadence",
          <select
            value={form.cadence}
            onChange={(e) => setForm((f) => ({ ...f, cadence: e.target.value as any }))}
            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="weekly">Weekly digest</option>
            <option value="on_raise">Immediate (on raise)</option>
          </select>,
        )}
        {field(
          "Escalation level *",
          "escalation_level",
          <select
            value={form.escalation_level}
            onChange={(e) => setForm((f) => ({ ...f, escalation_level: Number(e.target.value) as 1 | 2 }))}
            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value={1}>Level 1 (primary)</option>
            <option value={2}>Level 2 (escalation)</option>
          </select>,
        )}
        {field(
          "Scope type *",
          "scope_type",
          <select
            value={form.scope_type}
            onChange={(e) => setForm((f) => ({ ...f, scope_type: e.target.value as any }))}
            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="all">All territories</option>
            <option value="state_head">Specific state head</option>
          </select>,
        )}
        {form.scope_type === "state_head" &&
          field(
            "State head name",
            "scope_value",
            textInput("scope_value", "e.g. Anant Singh"),
          )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!form.name.trim() || !form.alert_code_pattern || mutation.isPending}
          onClick={() => mutation.mutate()}
          className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
        >
          {mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isEdit ? "Save changes" : "Add recipient"}
        </button>
      </div>
    </div>
  );
}

// ── Recipient row ─────────────────────────────────────────────────────────

function RecipientRow({
  recipient,
  adminSecret,
}: {
  recipient: Recipient;
  adminSecret: string;
}) {
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();

  const deactivate = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/alert-recipients/${recipient.id}`, {
        method: "DELETE",
        headers: { "X-Admin-Secret": adminSecret },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["alert-recipients"] }),
  });

  if (editing) {
    return (
      <RecipientForm
        initial={{
          id: recipient.id,
          alert_code_pattern: recipient.alert_code_pattern,
          scope_type: recipient.scope_type,
          scope_value: recipient.scope_value ?? "",
          escalation_level: recipient.escalation_level,
          name: recipient.name,
          channel: recipient.channel,
          contact: recipient.contact ?? "",
          cadence: recipient.cadence,
        }}
        adminSecret={adminSecret}
        onDone={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={cn("flex items-start gap-3 p-3 rounded-lg border", !recipient.is_active && "opacity-50")}>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{recipient.name}</span>
          <Badge className="bg-muted text-muted-foreground">{recipient.alert_code_pattern}</Badge>
          <Badge className={cn(
            recipient.channel === "in_app" ? "bg-blue-50 text-blue-700" :
            recipient.channel === "email" ? "bg-green-50 text-green-700" :
            "bg-purple-50 text-purple-700"
          )}>
            {CHANNEL_LABELS[recipient.channel]}
          </Badge>
          <Badge className={cn(
            recipient.cadence === "on_raise" ? "bg-orange-50 text-orange-700" : "bg-slate-50 text-slate-700"
          )}>
            {CADENCE_LABELS[recipient.cadence]}
          </Badge>
          <Badge className={cn(
            recipient.escalation_level === 2 ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"
          )}>
            L{recipient.escalation_level}
          </Badge>
          {!recipient.is_active && (
            <Badge className="bg-muted text-muted-foreground">Inactive</Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground flex gap-3 flex-wrap">
          {recipient.scope_type === "state_head" && recipient.scope_value
            ? <span>Scope: {recipient.scope_value}</span>
            : <span>Scope: all territories</span>}
          {recipient.contact && <span>Contact: {recipient.contact}</span>}
        </div>
      </div>
      {adminSecret && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {recipient.is_active && (
            <button
              type="button"
              onClick={() => deactivate.mutate()}
              disabled={deactivate.isPending}
              className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
              title="Deactivate"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Severity config table ─────────────────────────────────────────────────

function SeverityTable() {
  const { data, isLoading } = useQuery<{ configs: SeverityConfig[] }>({
    queryKey: ["alert-severity-config"],
    queryFn: () => fetch(`${BASE}/api/alert-severity-config`).then((r) => r.json()),
  });

  if (isLoading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (!data?.configs?.length) return null;

  return (
    <div className="rounded-xl border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Pattern</th>
            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Severity</th>
            <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Escalation window</th>
          </tr>
        </thead>
        <tbody>
          {data.configs.map((c) => (
            <tr key={c.id} className="border-t hover:bg-muted/30">
              <td className="px-3 py-2 font-mono text-xs">{c.code_pattern}</td>
              <td className="px-3 py-2">
                <Badge className={c.is_severe ? "bg-red-50 text-red-700" : "bg-muted text-muted-foreground"}>
                  {c.is_severe ? "Severe (immediate)" : "Normal"}
                </Badge>
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{c.escalation_window_days} days</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function AlertRecipientsPage() {
  const [adding, setAdding] = useState(false);
  const [severityOpen, setSeverityOpen] = useState(false);
  const [adminSecret, setAdminSecret] = useState(
    () => sessionStorage.getItem("adminSecret") ?? "",
  );
  const [secretInput, setSecretInput] = useState("");

  const { data, isLoading } = useQuery<{ recipients: Recipient[] }>({
    queryKey: ["alert-recipients"],
    queryFn: () => fetch(`${BASE}/api/alert-recipients`).then((r) => r.json()),
  });

  const active = data?.recipients?.filter((r) => r.is_active) ?? [];
  const inactive = data?.recipients?.filter((r) => !r.is_active) ?? [];

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Alert Recipients</h1>
          {active.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {active.length} active
            </span>
          )}
        </div>
        {adminSecret && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add recipient
          </button>
        )}
      </div>

      {/* Admin auth */}
      {!adminSecret && (
        <div className="rounded-xl border p-4 bg-muted/30 space-y-3">
          <p className="text-sm text-muted-foreground">
            Enter the admin secret to manage recipients.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const s = secretInput.trim();
              if (s) {
                setAdminSecret(s);
                sessionStorage.setItem("adminSecret", s);
              }
            }}
            className="flex gap-2"
          >
            <input
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="Admin secret…"
              className="flex-1 rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <button
              type="submit"
              disabled={!secretInput.trim()}
              className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              Unlock
            </button>
          </form>
        </div>
      )}

      {/* Add form */}
      {adding && adminSecret && (
        <RecipientForm
          adminSecret={adminSecret}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}

      {/* Active recipients */}
      {isLoading ? (
        <div className="flex items-center justify-center h-24">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No active recipients. Add one to start routing alerts.
        </p>
      ) : (
        <div className="space-y-2">
          {active.map((r) => (
            <RecipientRow key={r.id} recipient={r} adminSecret={adminSecret} />
          ))}
        </div>
      )}

      {/* Inactive recipients (collapsed) */}
      {inactive.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors select-none">
            <ChevronDown className="h-3 w-3 group-open:hidden" />
            <ChevronUp className="h-3 w-3 hidden group-open:block" />
            {inactive.length} inactive recipient{inactive.length !== 1 ? "s" : ""}
          </summary>
          <div className="mt-2 space-y-2">
            {inactive.map((r) => (
              <RecipientRow key={r.id} recipient={r} adminSecret={adminSecret} />
            ))}
          </div>
        </details>
      )}

      {/* Severity config */}
      <div>
        <button
          type="button"
          onClick={() => setSeverityOpen((o) => !o)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2"
        >
          {severityOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Severity configuration
        </button>
        {severityOpen && <SeverityTable />}
      </div>
    </div>
  );
}
