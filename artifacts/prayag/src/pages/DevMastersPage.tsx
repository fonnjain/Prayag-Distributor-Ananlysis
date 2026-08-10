// Master Data — admin page to refresh the customer/product masters without curl.
//
// Flow:  1. enter admin secret (SESSION_SECRET)
//        2. upload fresh CSVs (distributor / retailer / product) — stored locally
//           for the loaders AND persisted to object storage so they survive redeploys
//        3. dry-run → row counts / validation errors shown verbatim
//        4. commit → job status polled from GET /api/admin/masters/load-status
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Loader2, Lock, RefreshCw, Upload } from "lucide-react";

// ── Types (mirror the API shapes verbatim) ────────────────────────────────────

type MasterKind = "distributor" | "retailer" | "product";

interface FileInfo {
  label: string;
  local: { file: string; size: number; modified: string } | null;
  objectStorage: { exists: boolean; updated: string | null; size: number | null };
}

interface JobState {
  status: "idle" | "running" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  params: Record<string, unknown> | null;
  result: unknown;
  error: string | null;
}

type Jobs = { customer: JobState; product: JobState };

const KINDS: { kind: MasterKind; title: string; hint: string }[] = [
  { kind: "distributor", title: "Distributor master", hint: "Distributer_Upload_Sample_File_*.csv" },
  { kind: "retailer", title: "Retailer master", hint: "Retailer_Upload_Sample_file_*.csv (~37 MB)" },
  { kind: "product", title: "Product master", hint: "Product_Upload_Sample_File_*.csv" },
];

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DevMastersPage() {
  const [secret, setSecret] = useState<string>(() => sessionStorage.getItem("adminSecret") ?? "");
  const [secretInput, setSecretInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  const [files, setFiles] = useState<Record<MasterKind, FileInfo> | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [uploadMsg, setUploadMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  const [jobs, setJobs] = useState<Jobs | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const hdrs = useCallback(
    (extra?: Record<string, string>) => ({ "X-Admin-Secret": secret, ...(extra ?? {}) }),
    [secret],
  );

  const refreshFiles = useCallback(async () => {
    if (!secret) return;
    try {
      const r = await fetch("/api/admin/masters/files", { headers: hdrs() });
      if (r.status === 401) {
        setAuthError("Secret rejected by the server.");
        setSecret("");
        sessionStorage.removeItem("adminSecret");
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setFiles((await r.json()) as Record<MasterKind, FileInfo>);
      setFilesError(null);
    } catch (e) {
      setFilesError(String(e instanceof Error ? e.message : e));
    }
  }, [secret, hdrs]);

  const refreshJobs = useCallback(async () => {
    if (!secret) return;
    try {
      const r = await fetch("/api/admin/masters/load-status", { headers: hdrs() });
      if (!r.ok) return;
      const j = (await r.json()) as Jobs;
      setJobs(j);
      const anyRunning = j.customer.status === "running" || j.product.status === "running";
      if (anyRunning && pollRef.current == null) {
        pollRef.current = window.setInterval(() => void refreshJobsRef.current(), 2000);
      }
      if (!anyRunning && pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      /* transient poll error — next tick retries */
    }
  }, [secret, hdrs]);
  const refreshJobsRef = useRef(refreshJobs);
  refreshJobsRef.current = refreshJobs;

  useEffect(() => {
    if (!secret) return;
    void refreshFiles();
    void refreshJobs();
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [secret, refreshFiles, refreshJobs]);

  async function submitSecret() {
    const s = secretInput.trim();
    if (!s) return;
    setAuthError(null);
    // Probe with the status route before accepting.
    const r = await fetch("/api/admin/masters/load-status", { headers: { "X-Admin-Secret": s } });
    if (r.status === 401) {
      setAuthError("Secret rejected. Check the SESSION_SECRET value and try again.");
      return;
    }
    sessionStorage.setItem("adminSecret", s);
    setSecret(s);
    setSecretInput("");
  }

  async function uploadCsv(kind: MasterKind, file: File) {
    setUploading((u) => ({ ...u, [kind]: true }));
    setUploadMsg((m) => ({ ...m, [kind]: { ok: true, text: "Uploading…" } }));
    try {
      const r = await fetch(`/api/admin/masters/upload/${kind}`, {
        method: "POST",
        headers: hdrs({ "Content-Type": "text/csv" }),
        body: file,
      });
      const j = (await r.json()) as { ok?: boolean; error?: string; storedAs?: string; bytes?: number; persistedToObjectStorage?: boolean; persistWarning?: string | null };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setUploadMsg((m) => ({
        ...m,
        [kind]: {
          ok: !j.persistWarning,
          text: j.persistWarning
            ? `Stored as ${j.storedAs} — ${j.persistWarning}`
            : `Stored as ${j.storedAs} (${fmtBytes(j.bytes)}) and persisted to object storage.`,
        },
      }));
      void refreshFiles();
    } catch (e) {
      setUploadMsg((m) => ({ ...m, [kind]: { ok: false, text: String(e instanceof Error ? e.message : e) } }));
    } finally {
      setUploading((u) => ({ ...u, [kind]: false }));
    }
  }

  async function startLoad(job: "customer" | "product", commit: boolean) {
    setActionError(null);
    const url =
      job === "customer"
        ? `/api/admin/masters/customer-load${commit ? "" : "?dryRun=1"}`
        : `/api/admin/masters/product-load${commit ? "?write=1" : ""}`;
    if (commit) {
      const label = job === "customer" ? "customer master (customer_master + junction tables)" : "product master (item_master_variant + item_master)";
      if (!window.confirm(`Commit the ${label}? This rewrites the tables inside one transaction.`)) return;
    }
    try {
      const r = await fetch(url, { method: "POST", headers: hdrs() });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      void refreshJobs();
    } catch (e) {
      setActionError(String(e instanceof Error ? e.message : e));
    }
  }

  // ── Secret gate ─────────────────────────────────────────────────────────────
  if (!secret) {
    return (
      <div className="max-w-lg mx-auto mt-16">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Lock className="h-4 w-4" /> Master Data — admin access</CardTitle>
            <CardDescription>
              Refreshing the customer/product masters requires the admin secret (the server's SESSION_SECRET).
              It is kept only in this browser tab.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submitSecret(); }}
              placeholder="Admin secret"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              autoFocus
            />
            {authError && <p className="text-sm text-red-600 dark:text-red-400">{authError}</p>}
            <button
              type="button"
              onClick={() => void submitSecret()}
              disabled={!secretInput.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Unlock
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Master Data</h1>
          <p className="text-sm text-muted-foreground">
            Upload fresh master CSVs, preview with a dry-run, then commit. Files are persisted to object storage so they survive redeploys.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void refreshFiles(); void refreshJobs(); }}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      {/* ── Uploads ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1 · Upload CSVs</CardTitle>
          <CardDescription>Each upload replaces what the next load will read. {filesError && <span className="text-red-600">files status unavailable: {filesError}</span>}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {KINDS.map(({ kind, title, hint }) => {
            const info = files?.[kind];
            const msg = uploadMsg[kind];
            return (
              <div key={kind} className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-medium">{title}</div>
                    <div className="text-xs text-muted-foreground">{hint}</div>
                  </div>
                  <label className={cn(
                    "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm cursor-pointer hover:bg-muted",
                    uploading[kind] && "pointer-events-none opacity-60",
                  )}>
                    {uploading[kind] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    Upload CSV
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadCsv(kind, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div>
                    <span className="font-medium text-foreground">On server: </span>
                    {info?.local ? `${info.local.file} · ${fmtBytes(info.local.size)} · ${fmtTs(info.local.modified)}` : "none"}
                  </div>
                  <div>
                    <span className="font-medium text-foreground">Object storage: </span>
                    {info?.objectStorage.exists ? `${fmtBytes(info.objectStorage.size)} · ${fmtTs(info.objectStorage.updated)}` : "none"}
                  </div>
                </div>
                {msg && (
                  <p className={cn("text-xs", msg.ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400")}>
                    {msg.text}
                  </p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ── Loads ── */}
      {actionError && (
        <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5">
          <AlertTriangle className="h-4 w-4" /> {actionError}
        </p>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LoadCard
          title="2 · Customer master load"
          description="Distributor + retailer CSVs → customer_master, retailer_user, retailer_distributor. Human state-head attribution is preserved."
          job={jobs?.customer ?? null}
          onDryRun={() => void startLoad("customer", false)}
          onCommit={() => void startLoad("customer", true)}
        />
        <LoadCard
          title="3 · Product master load"
          description="Product CSV → item_master_variant + item_master (MRP backfilled only where the rate-list MRP was empty)."
          job={jobs?.product ?? null}
          onDryRun={() => void startLoad("product", false)}
          onCommit={() => void startLoad("product", true)}
        />
      </div>
    </div>
  );
}

// ── Load card (dry-run / commit / status) ─────────────────────────────────────

function LoadCard({
  title, description, job, onDryRun, onCommit,
}: {
  title: string;
  description: string;
  job: JobState | null;
  onDryRun: () => void;
  onCommit: () => void;
}) {
  const running = job?.status === "running";
  const wasDryRun = job?.params ? job.params["dryRun"] === true || job.params["write"] === false : false;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onDryRun}
            disabled={running}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            Dry-run preview
          </button>
          <button
            type="button"
            onClick={onCommit}
            disabled={running}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Commit
          </button>
        </div>

        {job && job.status !== "idle" && (
          <div className="rounded-md border p-3 text-sm space-y-1.5">
            <div className="flex items-center gap-2">
              {running && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
              {job.status === "done" && <CheckCircle2 className="h-4 w-4 text-green-600" />}
              {job.status === "failed" && <AlertTriangle className="h-4 w-4 text-red-600" />}
              <span className="font-medium capitalize">
                {job.status === "done" ? (wasDryRun ? "Dry-run complete" : "Committed") : job.status}
              </span>
              <span className="text-xs text-muted-foreground">
                {fmtTs(job.startedAt)}{job.finishedAt ? ` → ${fmtTs(job.finishedAt)}` : ""}
              </span>
            </div>
            {job.status === "running" && (
              <p className="text-xs text-muted-foreground">Load running in the background — status refreshes every 2 seconds.</p>
            )}
            {job.status === "failed" && job.error && (
              <pre className="whitespace-pre-wrap break-words rounded bg-red-50 dark:bg-red-950/40 p-2 text-xs text-red-800 dark:text-red-300">{job.error}</pre>
            )}
            {job.status === "done" && job.result != null && <ResultView result={job.result} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Renders the loader result: known row-count fields as a table, anything else verbatim.
function ResultView({ result }: { result: unknown }) {
  if (typeof result !== "object" || result == null) {
    return <pre className="text-xs">{String(result)}</pre>;
  }
  const r = result as Record<string, unknown>;
  const LABELS: Record<string, string> = {
    customerMaster: "customer_master rows",
    retailerUser: "retailer_user links",
    retailerDistributor: "retailer_distributor links",
    variants: "product variants",
    codes: "distinct product codes",
  };
  const rows = Object.entries(r).filter(([k]) => k in LABELS);
  const notOk = r["ok"] === false;
  return (
    <div className="space-y-1.5">
      {notOk && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Loader refused to proceed: parsed counts did not match the expected file structure. Nothing was written — check the uploaded CSV.
        </p>
      )}
      <table className="text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="pr-4 text-muted-foreground">{LABELS[k]}</td>
              <td className="font-mono tabular-nums">{Number(v).toLocaleString("en-IN")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r["dryRun"] === true && (
        <p className="text-xs text-muted-foreground">Dry-run only — no database changes were made. Use Commit to apply.</p>
      )}
    </div>
  );
}
