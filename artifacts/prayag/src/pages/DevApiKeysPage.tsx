import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Copy, Check, Trash2, Plus, Key, AlertTriangle, Loader2, Eye, EyeOff, Search } from "lucide-react";

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
    code: `# Dashboard summary
curl "${BASE}/api/dashboard?fy=2026-27" \\
  -H "Authorization: Bearer YOUR_API_KEY"

# Company-wide sales report
curl "${BASE}/api/company-reports?fy=2026-27" \\
  -H "Authorization: Bearer YOUR_API_KEY"

# Customer performance
curl "${BASE}/api/customers/performance?fy=2026-27" \\
  -H "Authorization: Bearer YOUR_API_KEY"`,
  },
  {
    lang: "js",
    label: "JavaScript",
    code: `const headers = { "Authorization": "Bearer YOUR_API_KEY" };
const base = "${BASE}/api";

// Dashboard summary
const dashboard = await fetch(\`\${base}/dashboard?fy=2026-27\`, { headers })
  .then(r => r.json());

// Company reports
const reports = await fetch(\`\${base}/company-reports?fy=2026-27\`, { headers })
  .then(r => r.json());

// Customer performance
const perf = await fetch(\`\${base}/customers/performance?fy=2026-27\`, { headers })
  .then(r => r.json());`,
  },
  {
    lang: "python",
    label: "Python",
    code: `import requests

BASE = "${BASE}/api"
HEADERS = {"Authorization": "Bearer YOUR_API_KEY"}

# Dashboard summary
dashboard = requests.get(f"{BASE}/dashboard", params={"fy": "2026-27"}, headers=HEADERS).json()

# Company reports
reports = requests.get(f"{BASE}/company-reports", params={"fy": "2026-27"}, headers=HEADERS).json()

# Customer performance
perf = requests.get(f"{BASE}/customers/performance", params={"fy": "2026-27"}, headers=HEADERS).json()`,
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
      <h2 className="font-semibold text-sm">Authentication</h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Include the key in an <span className="font-mono">Authorization</span> header on every request. Replace{" "}
        <span className="font-mono">YOUR_API_KEY</span> with the full key you copied at creation time.
        All endpoints accept <span className="font-mono">fy</span> (financial year, e.g. <span className="font-mono">2026-27</span>) as the primary query parameter.
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
        <p><span className="font-medium text-foreground">Export endpoints</span> return <span className="font-mono">application/vnd.openxmlformats</span> (.xlsx) — set <span className="font-mono">Accept</span> accordingly or stream to a file.</p>
      </div>
    </div>
  );
}

// ── API Catalogue ──────────────────────────────────────────────────────────────

type MethodBadge = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

interface EndpointEntry {
  method: MethodBadge;
  path: string;
  description: string;
  params?: string;
}

interface EndpointGroup {
  group: string;
  endpoints: EndpointEntry[];
}

const API_CATALOGUE: EndpointGroup[] = [
  {
    group: "Dashboard & Analytics",
    endpoints: [
      { method: "GET",  path: "/dashboard",        description: "Full dashboard snapshot — OB, sales, targets, achievement, per-member summary.", params: "fy" },
      { method: "GET",  path: "/analytics",         description: "Secondary analytics data (monthly trends, customer states, velocity).", params: "fy, stateHead, period" },
      { method: "GET",  path: "/analytics/export",  description: "Analytics data as .xlsx download.", params: "fy, stateHead" },
      { method: "GET",  path: "/healthz",           description: "Server health check. Returns 200 with status: ok." },
    ],
  },
  {
    group: "Company Reports",
    endpoints: [
      { method: "GET",  path: "/company-reports",         description: "Full company-level sales & OB report with per-head and per-state breakdowns.", params: "fy, monthFrom, monthTo, stateHead, states, level" },
      { method: "GET",  path: "/company-reports/filters", description: "Available filter options (state heads, states, levels) for the current FY.", params: "fy" },
      { method: "GET",  path: "/company-reports/export",  description: "Company report as .xlsx download.", params: "fy, monthFrom, monthTo, stateHead, states, level" },
    ],
  },
  {
    group: "Regional Reports",
    endpoints: [
      { method: "GET",  path: "/regional-reports",        description: "State-level aggregated sales and OB with per-member drill-down.", params: "fy, stateHead, monthFrom, monthTo" },
      { method: "GET",  path: "/regional-reports/export", description: "Regional report as .xlsx download.", params: "fy, stateHead" },
    ],
  },
  {
    group: "Coverage Reports",
    endpoints: [
      { method: "GET",  path: "/coverage-reports",        description: "Retailer coverage metrics — active, dormant, unvisited, new additions.", params: "fy, stateHead, member" },
      { method: "GET",  path: "/coverage-reports/export", description: "Coverage report as .xlsx download.", params: "fy, stateHead" },
    ],
  },
  {
    group: "Product / SKU Reports",
    endpoints: [
      { method: "GET",  path: "/product-reports",        description: "Brand and category sales breakdown with YoY comparison.", params: "fy, stateHead, member" },
      { method: "GET",  path: "/product-reports/export", description: "Product report as .xlsx download.", params: "fy, stateHead" },
    ],
  },
  {
    group: "Momentum",
    endpoints: [
      { method: "GET",  path: "/momentum/insights",         description: "One-scope momentum panel — Grow, Maintain, Recover, Win-Back by period.", params: "fy, stateHead, monthFrom, monthTo" },
      { method: "GET",  path: "/momentum-reports/export",   description: "Momentum report as .xlsx download.", params: "fy, stateHead" },
    ],
  },
  {
    group: "Customers",
    endpoints: [
      { method: "GET",  path: "/customers/performance",     description: "Customer-level sales, OB, units, Laspeyres price index, YoY change.", params: "fy, stateHead, member, monthFrom, monthTo, level" },
      { method: "GET",  path: "/customers/churn",           description: "At-risk and dormant customer scoring with median-gap model.", params: "fy, stateHead" },
      { method: "GET",  path: "/customers/history",         description: "Full purchase history timeline for a single customer.", params: "fy, customer" },
      { method: "GET",  path: "/customers/detail",          description: "Single-customer detail — OB, sale, codes, scheme nudge.", params: "fy, customer" },
      { method: "GET",  path: "/customers/shrinkers",       description: "Hidden shrinkers — customers where value is up but quantity is down.", params: "fy, stateHead" },
      { method: "GET",  path: "/customers/distributor-risk","description": "Distributor concentration risk per customer.", params: "fy, stateHead" },
      { method: "GET",  path: "/customers/months",          description: "Closed months available for a given FY (used to build month pickers).", params: "fy" },
      { method: "GET",  path: "/customers/multiplier",      description: "Per-customer category revenue multipliers for scheme engine.", params: "fy, stateHead" },
      { method: "GET",  path: "/customers/export",          description: "Customer performance data as .xlsx download.", params: "fy, stateHead, monthFrom, monthTo" },
      { method: "GET",  path: "/customers/schemes",         description: "List all scheme definitions.", params: "fy" },
      { method: "GET",  path: "/customers/schemes/:id",     description: "Single scheme — tiers, nudge list, tracking.", params: "fy" },
      { method: "GET",  path: "/customers/schemes/:id/push-list", description: "Customers ranked by incremental billing needed to hit next scheme tier.", params: "fy" },
      { method: "GET",  path: "/customers/schemes/:id/tracking", description: "Real-time scheme achievement tracking for all enrolled customers.", params: "fy" },
    ],
  },
  {
    group: "SKU Deep Dive",
    endpoints: [
      { method: "GET",  path: "/sku/facts",         description: "Item-level secondary sales facts — net, qty, discount, Laspeyres.", params: "fy, stateHead, member, level, page, limit" },
      { method: "GET",  path: "/sku/capability",    description: "Which SKU pages and filters are available for the requested scope.", params: "fy, stateHead" },
      { method: "GET",  path: "/sku/catalogue",     description: "Full product catalogue with ever-sold flags per channel.", params: "fy" },
      { method: "GET",  path: "/sku/trend",         description: "Monthly secondary sales trend by item code.", params: "fy, code, stateHead" },
      { method: "GET",  path: "/sku/recommendations","description": "Peer-cohort SKU recommendations ranked by headroom.", params: "fy, stateHead" },
      { method: "GET",  path: "/sku/distributors",  description: "Distributor SKU spread — breadth, active brands, segment coverage.", params: "fy, stateHead" },
      { method: "GET",  path: "/sku/push-list",     description: "Per-distributor peer-cohort push list (K3 Review + Push tabs).", params: "fy, stateHead, distributor" },
      { method: "GET",  path: "/sku/discounts",     description: "Discount distribution and movement analysis.", params: "fy, stateHead" },
      { method: "GET",  path: "/sku/breadth-trend", description: "Brand breadth over time — how many brands each customer buys.", params: "fy, stateHead" },
      { method: "GET",  path: "/sku/first-orders",  description: "First-order cohort analysis — new codes by month.", params: "fy, stateHead" },
      { method: "GET",  path: "/sku/lost-codes",    description: "Item codes bought in prior FY but absent in current FY.", params: "fy, stateHead" },
      { method: "GET",  path: "/sku/seasonality",   description: "Seasonal index by brand/segment from prior-year history.", params: "fy, stateHead" },
      { method: "GET",  path: "/sku/export",        description: "SKU facts as .xlsx download.", params: "fy, stateHead" },
    ],
  },
  {
    group: "Comparison",
    endpoints: [
      { method: "GET",  path: "/comparison/entities",  description: "List entities (distributors, state heads, states) available for comparison.", params: "fy, type" },
      { method: "GET",  path: "/comparison/catalogue", description: "Metric definitions and basis notes for the comparison engine.", params: "fy" },
      { method: "POST", path: "/comparison",           description: "Run a comparison between two entities — produces cost, sales, OB, and SKU spread metrics.", params: "body: { fy, entityA, entityB, type, monthFrom?, monthTo? }" },
      { method: "POST", path: "/comparison/cohort",    description: "Cohort comparison — benchmark an entity against its territory peer group.", params: "body: { fy, entity, type }" },
      { method: "POST", path: "/comparison/export",    description: "Export comparison results as .xlsx.", params: "body: { fy, entityA, entityB, type }" },
    ],
  },
  {
    group: "Distributor Management",
    endpoints: [
      { method: "GET",  path: "/mgmt/distributor-directory",  description: "Full distributor directory with identity registry status.", params: "fy" },
      { method: "GET",  path: "/mgmt/distributor-identity",   description: "Identity registry — DIST# resolutions, ambiguous name pairs.", params: "fy" },
      { method: "GET",  path: "/mgmt/distributor-deep-dive",  description: "Multi-section deep dive: flows, SKU spread, investment, tiering.", params: "fy, stateHead, monthFrom?, monthTo?" },
      { method: "GET",  path: "/mgmt/distributor-recon",      description: "Distribution reconciliation — secondary-out vs primary-in gap.", params: "fy, stateHead" },
      { method: "GET",  path: "/mgmt/distributor-tab",        description: "Secondary / SKU / Push tab data for one distributor or a full state-head scope.", params: "fy, dist? OR head=&states=, tab" },
      { method: "GET",  path: "/mgmt/distributor-tier-override", description: "List active distributor tier overrides.", params: "fy, stateHead" },
      { method: "PUT",  path: "/mgmt/distributor-tier-override", description: "Set a tier override for a distributor.", params: "body: { fy, dist, tier, reason }" },
      { method: "DELETE", path: "/mgmt/distributor-tier-override", description: "Remove a tier override.", params: "body: { fy, dist }" },
    ],
  },
  {
    group: "Management Data",
    endpoints: [
      { method: "GET",  path: "/mgmt/data",                description: "State head dashboard — OB, sale, team targets, plan vs actual.", params: "fy, stateHead" },
      { method: "GET",  path: "/mgmt/primary",             description: "Primary sales (SAP) for a state head with period filter.", params: "fy, stateHead, monthFrom, monthTo" },
      { method: "GET",  path: "/mgmt/deep-dive",           description: "State head deep dive — state-level correlation, intra-team analysis.", params: "fy, stateHead" },
      { method: "GET",  path: "/mgmt/pending-orders",      description: "Pending order book — not yet converted to sale.", params: "fy, stateHead" },
      { method: "GET",  path: "/mgmt/options",             description: "Available state heads and members for filter dropdowns.", params: "fy" },
      { method: "GET",  path: "/mgmt/member-sheet-coverage", description: "Which members have working sheets and their last-read status.", params: "fy, stateHead" },
      { method: "GET",  path: "/mgmt/retailer-drift",      description: "Retailers that changed distributor assignment between FYs.", params: "fy, stateHead" },
      { method: "GET",  path: "/mgmt/retailer-identity",   description: "Retailer identity registry — RET# resolutions.", params: "fy, stateHead" },
      { method: "GET",  path: "/mgmt/unmatched-names",     description: "Names in secondary register that don't match any known member.", params: "fy, stateHead" },
      { method: "GET",  path: "/mgmt/bridge/status",       description: "Distributor-TM bridge build status (background task).", params: "fy" },
      { method: "GET",  path: "/mgmt/verify",              description: "Cross-check control totals against verified anchors.", params: "fy" },
      { method: "POST", path: "/mgmt/report",              description: "Generate a management summary report for a state head.", params: "body: { fy, stateHead }" },
    ],
  },
  {
    group: "AI Reports",
    endpoints: [
      { method: "GET",  path: "/ai/payload",                    description: "Raw analytics payload used as AI report input — useful for debugging.", params: "fy, stateHead, member" },
      { method: "POST", path: "/ai/statehead-report",           description: "State head narrative report (sections + guard result).", params: "body: { fy, stateHead, period? }" },
      { method: "POST", path: "/ai/suggestions",                description: "Ranked action suggestions for a member.", params: "body: { fy, member, stateHead }" },
      { method: "POST", path: "/ai/travel-plan",                description: "AI-generated monthly visit plan for a member.", params: "body: { fy, member, stateHead, period? }" },
      { method: "POST", path: "/ai/performance-review",         description: "Structured performance review narrative for a member.", params: "body: { fy, member, stateHead, period? }" },
      { method: "POST", path: "/ai/presentation",               description: "Slide deck script for a member review meeting.", params: "body: { fy, member, stateHead, period? }" },
      { method: "POST", path: "/ai/distributor-report",         description: "Distributor-level analytics narrative.", params: "body: { fy, stateHead, distributor }" },
      { method: "POST", path: "/ai/distributor-statehead-report","description": "Distributor state-head narrative.", params: "body: { fy, stateHead }" },
      { method: "POST", path: "/ai/distributor-suggestions",    description: "Action suggestions focused on distributor improvement.", params: "body: { fy, stateHead, distributor }" },
      { method: "POST", path: "/ai/distributor-review",         description: "Structured distributor review.", params: "body: { fy, stateHead, distributor }" },
      { method: "POST", path: "/ai/distributor-presentation",   description: "Slide deck script for a distributor review meeting.", params: "body: { fy, stateHead, distributor }" },
      { method: "POST", path: "/ai/full-report/distributor",    description: "Full structured distributor report (10 sections, numeric guard, PDF-ready).", params: "body: { fy, stateHead, distributor, monthFrom?, monthTo? }" },
      { method: "POST", path: "/ai/full-report/statehead",      description: "Full structured state-head report (10 sections, numeric guard, PDF-ready).", params: "body: { fy, stateHead, monthFrom?, monthTo? }" },
      { method: "POST", path: "/ai/full-report/growth",         description: "Master Growth Report — Activate, Widen, Recover, Protect, Close, Where-Not-To-Look (company / state-head / state scope).", params: "body: { fy, scope, stateHead?, state?, monthFrom?, monthTo?, dormantRevivalPct?, atRiskRecoveryPct?, rangeUptakePct? }" },
      { method: "POST", path: "/ai/batch",                      description: "Batch AI report generation for all members of a state head (SSE stream).", params: "body: { fy, stateHead, reportType }" },
      { method: "POST", path: "/ai/chat",                       description: "Conversational follow-up on an existing AI report.", params: "body: { fy, stateHead, member?, reportType, question }" },
      { method: "POST", path: "/ai/report",                     description: "Legacy single-section AI report (prefer /ai/full-report/* for new integrations).", params: "body: { fy, stateHead, member, reportType }" },
    ],
  },
  {
    group: "Organisation",
    endpoints: [
      { method: "GET",  path: "/org/state-heads",            description: "Full roster of state heads with members, targets, and designation.", params: "fy" },
      { method: "GET",  path: "/org/state-heads/alias-check","description": "Detect head_canon aliases that span multiple state heads.", params: "fy" },
      { method: "GET",  path: "/org/state-heads/audit",      description: "Roster audit — missing members, mismatched designations.", params: "fy" },
      { method: "POST", path: "/org/state-heads",            description: "Add a new state head to the roster.", params: "body: { name, state, fy }" },
      { method: "PATCH", path: "/org/state-heads/:id",       description: "Update state head fields (name, state, targets).", params: "body: partial StateHead" },
    ],
  },
  {
    group: "Salespeople",
    endpoints: [
      { method: "GET",  path: "/salespeople/tree",       description: "Org tree of state heads and their members (used for dropdowns).", params: "fy" },
      { method: "GET",  path: "/salespeople/deep-dive",  description: "Deep performance dive for one salesperson.", params: "fy, member" },
      { method: "GET",  path: "/salespeople/verify",     description: "Verify a salesperson's data integrity.", params: "fy, member" },
    ],
  },
  {
    group: "Primary Sales (SAP)",
    endpoints: [
      { method: "GET",  path: "/primary-targets",        description: "FY primary sales targets per state head.", params: "fy" },
      { method: "GET",  path: "/drive/files",            description: "List SAP xlsx files available in Google Drive for upload.", params: "fy" },
    ],
  },
  {
    group: "Audit & Verification",
    endpoints: [
      { method: "GET",  path: "/audit",          description: "Full 10-group data audit — cross-foots, SAP lag, register health, truncation checks.", params: "fy" },
      { method: "GET",  path: "/audit/download", description: "Audit report as .xlsx download.", params: "fy" },
      { method: "GET",  path: "/verify",         description: "Quick anchor-vs-DB verification for a given FY.", params: "fy" },
    ],
  },
  {
    group: "Customer Master",
    endpoints: [
      { method: "GET",  path: "/customer-master",               description: "Full customer master list with deduplication status.", params: "fy, stateHead" },
      { method: "GET",  path: "/customer-master/:id",           description: "Single customer master record.", params: "—" },
      { method: "PUT",  path: "/customer-master/:id",           description: "Update a customer master record (name, channel, mapping).", params: "body: partial CustomerMaster" },
      { method: "GET",  path: "/customer-master/mismatch",      description: "Customers whose master record conflicts with register data.", params: "fy" },
      { method: "GET",  path: "/customer-master/mismatch/count","description": "Count of active mismatches.", params: "fy" },
      { method: "GET",  path: "/customer-master/export",        description: "Customer master as .xlsx download.", params: "fy" },
    ],
  },
  {
    group: "API Keys",
    endpoints: [
      { method: "GET",    path: "/keys",      description: "List all API keys (hashes never returned).", params: "—" },
      { method: "POST",   path: "/keys",      description: "Create a new API key. Raw key returned once only.", params: "body: { name, description? }" },
      { method: "DELETE", path: "/keys/:id",  description: "Revoke a key by its numeric ID.", params: "—" },
    ],
  },
];

const METHOD_COLOURS: Record<MethodBadge, string> = {
  GET:    "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
  POST:   "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  PUT:    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  PATCH:  "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  DELETE: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

function ApiCatalogue() {
  const [query, setQuery] = useState("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return API_CATALOGUE;
    return API_CATALOGUE.map((g) => ({
      ...g,
      endpoints: g.endpoints.filter(
        (e) =>
          e.path.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.method.toLowerCase().includes(q) ||
          g.group.toLowerCase().includes(q),
      ),
    })).filter((g) => g.endpoints.length > 0);
  }, [query]);

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-semibold text-sm">API Endpoint Reference</h2>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpenGroup(null); }}
            placeholder="Filter endpoints…"
            className="pl-8 pr-3 py-1.5 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary w-52"
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        All paths are relative to <span className="font-mono">{BASE}/api</span>. Every request must carry <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.
        FY format is <span className="font-mono">YYYY-YY</span> (e.g. <span className="font-mono">2026-27</span>).
        Export endpoints return <span className="font-mono">.xlsx</span>; stream to a file or open in Excel directly.
      </p>

      <div className="space-y-1">
        {filtered.map((g) => {
          const isOpen = query.trim() !== "" || openGroup === g.group;
          return (
            <div key={g.group} className="rounded border border-border/60 overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenGroup(isOpen && !query ? null : g.group)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-left hover:bg-muted/40 transition-colors bg-muted/20"
              >
                <span>{g.group}</span>
                <span className="text-muted-foreground font-normal">{g.endpoints.length} endpoint{g.endpoints.length !== 1 ? "s" : ""} {isOpen ? "▲" : "▼"}</span>
              </button>

              {isOpen && (
                <div className="divide-y divide-border/40">
                  {g.endpoints.map((e, i) => (
                    <div key={i} className="flex gap-3 px-3 py-2.5 items-start hover:bg-muted/10 transition-colors">
                      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide mt-0.5", METHOD_COLOURS[e.method])}>
                        {e.method}
                      </span>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-start gap-2 flex-wrap">
                          <span className="font-mono text-xs font-medium">{e.path}</span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug">{e.description}</p>
                        {e.params && e.params !== "—" && (
                          <p className="text-[10px] text-muted-foreground/70">
                            <span className="font-medium text-muted-foreground">Params:</span> <span className="font-mono">{e.params}</span>
                          </p>
                        )}
                      </div>
                      <CopyButton text={`${BASE}/api${e.path}`} className="shrink-0 mt-0.5" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground py-4 text-center">No endpoints match "{query}"</p>
        )}
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

      <main className="flex-1 overflow-y-auto px-6 py-5 max-w-4xl space-y-5">
        {newKey && (
          <NewKeyBanner rawKey={newKey.raw} onDismiss={() => setNewKey(null)} />
        )}

        <UsageGuide />

        <ApiCatalogue />

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
