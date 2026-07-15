import { useState } from "react";
import { cn } from "@/lib/utils";
import { Copy, Check, Trash2, Plus, Key, AlertTriangle, Loader2, Eye, EyeOff } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ApiKeyRow {
  id: number;
  name: string;
  description: string | null;
  prefix: string;
  isRevoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(ts: string | null): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtDate(ts: string): string {
  return new Date(ts).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

// ── CopyButton ─────────────────────────────────────────────────────────────────

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors",
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ── NewKeyBanner — shown once after creation ────────────────────────────────────

function NewKeyBanner({ rawKey, onDismiss }: { rawKey: string; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 p-4 space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            Copy your key now — it will not be shown again
          </p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            Store it securely. We only keep a hash and cannot recover the original.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200"
        >
          Dismiss
        </button>
      </div>
      <div className="flex items-center gap-2 rounded border border-amber-200 dark:border-amber-800 bg-white dark:bg-black/20 px-3 py-2">
        <span className="flex-1 font-mono text-xs break-all select-all">
          {visible ? rawKey : rawKey.replace(/./g, "•")}
        </span>
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          title={visible ? "Hide key" : "Reveal key"}
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <CopyButton text={rawKey} />
      </div>
    </div>
  );
}

// ── CreateKeyDialog ─────────────────────────────────────────────────────────────

function CreateKeyDialog({
  onCreated,
  onCancel,
}: {
  onCreated: (key: ApiKeyRow, rawKey: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create key");
        return;
      }
      onCreated(data.key as ApiKeyRow, data.rawKey as string);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <h2 className="font-semibold text-sm">Create API key</h2>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs font-medium mb-1">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. Analytics Dashboard, Mobile App"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Description <span className="text-muted-foreground font-normal">(optional)</span></label>
          <textarea
            className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            placeholder="What will this key be used for?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={500}
          />
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Generate key
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ── KeyRow ─────────────────────────────────────────────────────────────────────

function KeyRow({
  apiKey,
  onRevoke,
}: {
  apiKey: ApiKeyRow;
  onRevoke: (id: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);

  async function handleRevoke() {
    setRevoking(true);
    try {
      const res = await fetch(`/api/keys/${apiKey.id}`, { method: "DELETE" });
      if (res.ok) onRevoke(apiKey.id);
    } finally {
      setRevoking(false);
      setConfirming(false);
    }
  }

  return (
    <div className={cn("rounded-lg border px-4 py-3 space-y-1.5", apiKey.isRevoked ? "border-border/50 bg-muted/30 opacity-60" : "border-border bg-card")}>
      <div className="flex items-start gap-3">
        <Key className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{apiKey.name}</span>
            {apiKey.isRevoked && (
              <span className="rounded-full bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-[10px] font-semibold px-2 py-0.5">
                Revoked
              </span>
            )}
          </div>
          {apiKey.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{apiKey.description}</p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              Key: <span className="font-mono">{apiKey.prefix}…</span>
            </span>
            <span>Created {fmtDate(apiKey.createdAt)}</span>
            <span>Last used: {fmt(apiKey.lastUsedAt)}</span>
            {apiKey.isRevoked && apiKey.revokedAt && (
              <span>Revoked {fmt(apiKey.revokedAt)}</span>
            )}
          </div>
        </div>

        {!apiKey.isRevoked && (
          <div className="shrink-0">
            {confirming ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Revoke?</span>
                <button
                  type="button"
                  onClick={handleRevoke}
                  disabled={revoking}
                  className="flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-700 disabled:opacity-60 transition-colors"
                >
                  {revoking ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Yes, revoke
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-red-400 hover:text-red-600 transition-colors"
              >
                <Trash2 className="h-3 w-3" />
                Revoke
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── UsageGuide ─────────────────────────────────────────────────────────────────

const BASE = typeof window !== "undefined" ? window.location.origin : "https://your-app.replit.app";

const USAGE_EXAMPLES = [
  {
    lang: "curl",
    label: "curl",
    code: `curl "${BASE}/api/dashboard" \\
  -H "Authorization: Bearer YOUR_API_KEY"`,
  },
  {
    lang: "js",
    label: "JavaScript",
    code: `const res = await fetch("${BASE}/api/dashboard", {
  headers: {
    "Authorization": "Bearer YOUR_API_KEY",
  },
});
const data = await res.json();`,
  },
  {
    lang: "python",
    label: "Python",
    code: `import requests

res = requests.get(
    "${BASE}/api/dashboard",
    headers={"Authorization": "Bearer YOUR_API_KEY"},
)
print(res.json())`,
  },
];

function UsageGuide() {
  const [lang, setLang] = useState("curl");
  const [copied, setCopied] = useState(false);

  const ex = USAGE_EXAMPLES.find((e) => e.lang === lang) ?? USAGE_EXAMPLES[0];

  function copy() {
    navigator.clipboard.writeText(ex.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-3">
      <h2 className="font-semibold text-sm">How to use a key</h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Include the key in an <span className="font-mono">Authorization</span> header on every request to the API. Replace{" "}
        <span className="font-mono">YOUR_API_KEY</span> with the full key you copied at creation time.
      </p>

      <div>
        <div className="flex items-center justify-between mb-0">
          <div className="flex gap-px rounded-t border border-b-0 border-border bg-muted/60 px-2 pt-1.5">
            {USAGE_EXAMPLES.map((e) => (
              <button
                key={e.lang}
                type="button"
                onClick={() => setLang(e.lang)}
                className={cn(
                  "px-2.5 py-1 text-[11px] font-mono rounded-t transition-colors",
                  lang === e.lang
                    ? "bg-background text-foreground font-semibold border border-b-0 border-border -mb-px"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {e.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="overflow-x-auto rounded-b rounded-tr border border-border bg-muted/50 p-3 text-xs font-mono leading-relaxed whitespace-pre">
          {ex.code}
        </pre>
      </div>

      <div className="rounded border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-1">
        <p><span className="font-medium text-foreground">Base URL:</span> <span className="font-mono">{BASE}/api</span></p>
        <p><span className="font-medium text-foreground">Auth header:</span> <span className="font-mono">Authorization: Bearer &lt;key&gt;</span></p>
        <p><span className="font-medium text-foreground">Invalid/revoked keys</span> receive a <span className="font-mono">401</span> response.</p>
        <p><span className="font-medium text-foreground">No key</span> is required for same-origin browser requests.</p>
      </div>
    </div>
  );
}

// ── DevApiKeysPage ─────────────────────────────────────────────────────────────

export default function DevApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<{ row: ApiKeyRow; raw: string } | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function loadKeys() {
    setLoadError(null);
    try {
      const res = await fetch("/api/keys");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setKeys(data.keys as ApiKeyRow[]);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoaded(true);
    }
  }

  if (!loaded) {
    loadKeys();
    setLoaded(true);
  }

  function handleCreated(row: ApiKeyRow, raw: string) {
    setKeys((prev) => (prev ? [row, ...prev] : [row]));
    setNewKey({ row, raw });
    setCreating(false);
  }

  function handleRevoke(id: number) {
    setKeys((prev) =>
      prev
        ? prev.map((k) =>
            k.id === id ? { ...k, isRevoked: true, revokedAt: new Date().toISOString() } : k,
          )
        : prev,
    );
  }

  const activeKeys = keys?.filter((k) => !k.isRevoked) ?? [];
  const revokedKeys = keys?.filter((k) => k.isRevoked) ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-bold tracking-tight">API Keys</h1>
          {keys !== null && (
            <span className="text-xs text-muted-foreground">
              {activeKeys.length} active{revokedKeys.length > 0 ? ` · ${revokedKeys.length} revoked` : ""}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Issue keys so external apps can authenticate against the{" "}
          <span className="font-mono text-xs">/api</span> server.
        </p>
      </div>

      <main className="flex-1 overflow-y-auto px-6 py-5 max-w-3xl space-y-5">
        {newKey && (
          <NewKeyBanner rawKey={newKey.raw} onDismiss={() => setNewKey(null)} />
        )}

        <UsageGuide />

        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Your keys</h2>
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              New key
            </button>
          )}
        </div>

        {creating && (
          <CreateKeyDialog
            onCreated={handleCreated}
            onCancel={() => setCreating(false)}
          />
        )}

        {loadError && (
          <div className="rounded border border-red-300 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-600 dark:text-red-400">
            {loadError}
          </div>
        )}

        {keys === null && !loadError && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading keys...
          </div>
        )}

        {keys !== null && activeKeys.length === 0 && !creating && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <Key className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No active keys yet.</p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="mt-3 text-xs font-semibold text-primary hover:underline"
            >
              Generate your first key
            </button>
          </div>
        )}

        {activeKeys.length > 0 && (
          <div className="space-y-2">
            {activeKeys.map((k) => (
              <KeyRow key={k.id} apiKey={k} onRevoke={handleRevoke} />
            ))}
          </div>
        )}

        {revokedKeys.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Revoked keys
            </p>
            <div className="space-y-2">
              {revokedKeys.map((k) => (
                <KeyRow key={k.id} apiKey={k} onRevoke={handleRevoke} />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
