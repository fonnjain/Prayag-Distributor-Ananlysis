import { trunc2 } from "@/lib/trunc";
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useDashboard } from "@/data/dashboard-context";
import { useAuth } from "@/data/auth-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FileText, Database, FolderGit2, CheckCircle2, Clock, Target, UserX, Upload, Users, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import Organisation from "./Organisation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ── Unmatched order-booking names ────────────────────────────────────────────
// Net Sale counted in the company total but attributed to no member or head —
// the largest single data-quality item on this page. Each name is checked
// against the identity registry so spelling variants the app can already
// resolve are separated from genuinely unknown names before anyone is asked
// to fix them by hand.

type UnmatchedName = {
  name: string;
  amount: number;
  registryStatus: "resolvable" | "ambiguous" | "unknown" | "unchecked";
  resolvedTo: string | null;
  candidates: string[] | null;
};

type UnmatchedPayload = {
  fy: string;
  count: number;
  totalAmount: number;
  registryAvailable: boolean;
  names: UnmatchedName[];
};

const fmtL = (n: number) =>
  n >= 1e7 ? `₹${trunc2((n / 1e7))} Cr` : `₹${trunc2((n / 1e5))} L`;

const STATUS_BADGE: Record<UnmatchedName["registryStatus"], { label: string; cls: string }> = {
  resolvable: { label: "Registry match", cls: "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300" },
  ambiguous: { label: "Ambiguous", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300" },
  unknown: { label: "Unknown", cls: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300" },
  unchecked: { label: "Not checked", cls: "bg-muted text-muted-foreground" },
};

// ── Frozen source drift ───────────────────────────────────────────────────────
// Frozen months are intentionally never changed by a sync. This small review
// surface is therefore hidden unless a saved comparison needs a human decision.
type FrozenDriftCheck = {
  id: string;
  monthLabel: string;
  frozenAt: string;
  appRows: number;
  appNet: number;
  sheetRows: number | null;
  sheetNet: number | null;
  rowDelta: number | null;
  netDelta: number | null;
  status: string;
  detail: string | null;
  checkedAt: string;
  resolution: { resolution?: "accepted" | "ignored" | "refreshed"; operator?: string; reason?: string; resolvedAt?: string } | null;
};

type FrozenDriftPayload = { fy: string; checks: FrozenDriftCheck[] };
type FrozenPreview = {
  previewHash: string;
  additions?: unknown[];
  removals?: unknown[];
  changes?: unknown[];
  rowImpact?: number;
  netImpact?: number;
  rowDelta?: number;
  netDelta?: number;
};

type InvoiceEvidence = { invoice: string; date: string | null; lineCount: number; net: number };
type SavedInvoiceEvidence = {
  additions?: InvoiceEvidence[];
  removals?: InvoiceEvidence[];
  changes?: Array<{ invoice: string; app: InvoiceEvidence; sheet: InvoiceEvidence }>;
  sourceError?: string;
};

function money(n: number | null | undefined) {
  if (n == null) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function signed(n: number | null | undefined, formatter: (value: number) => string) {
  if (n == null) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatter(Math.abs(n))}`;
}

function isUnreadable(check: FrozenDriftCheck) {
  return /unreadable|read.?fail|error/i.test(check.status);
}

function needsFrozenReview(check: FrozenDriftCheck) {
  if (check.resolution) return false;
  return isUnreadable(check) || !/^(ok|pass|match(?:ed)?)$/i.test(check.status);
}

function InvoiceEvidenceTable({ title, invoices }: { title: string; invoices: InvoiceEvidence[] }) {
  if (!invoices.length) return null;
  return (
    <div className="mt-3 overflow-x-auto rounded-md border bg-background">
      <p className="border-b px-3 py-2 text-xs font-medium">{title} ({invoices.length})</p>
      <table className="w-full min-w-[480px] text-xs">
        <thead className="bg-muted/40 text-left text-muted-foreground">
          <tr><th className="px-3 py-1.5">Invoice</th><th className="px-3 py-1.5">Date</th><th className="px-3 py-1.5 text-right">Lines</th><th className="px-3 py-1.5 text-right">Net</th></tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => <tr key={`${title}-${invoice.invoice}`} className="border-t">
            <td className="px-3 py-1.5 font-medium">{invoice.invoice}</td><td className="px-3 py-1.5">{invoice.date ?? "—"}</td><td className="px-3 py-1.5 text-right tabular-nums">{invoice.lineCount}</td><td className="px-3 py-1.5 text-right tabular-nums">{money(invoice.net)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  );
}

function SavedEvidence({ evidence, fallback }: { evidence: unknown; fallback: string | null }) {
  const saved = evidence && typeof evidence === "object" ? evidence as SavedInvoiceEvidence : null;
  if (!saved) return <p className="mt-1 text-muted-foreground">{fallback || "No invoice evidence was returned for this check."}</p>;
  if (saved.sourceError) return <p className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">Sheet source unavailable: {saved.sourceError}</p>;
  const additions = Array.isArray(saved.additions) ? saved.additions : [];
  const removals = Array.isArray(saved.removals) ? saved.removals : [];
  const changes = Array.isArray(saved.changes) ? saved.changes : [];
  if (!additions.length && !removals.length && !changes.length) return <p className="mt-1 text-muted-foreground">No invoice-level differences were saved for this check.</p>;
  return <>
    <InvoiceEvidenceTable title="Additions in sheet" invoices={additions} />
    <InvoiceEvidenceTable title="Removals from app" invoices={removals} />
    {changes.length > 0 && <div className="mt-3 overflow-x-auto rounded-md border bg-background">
      <p className="border-b px-3 py-2 text-xs font-medium">Changed invoices ({changes.length})</p>
      <table className="w-full min-w-[760px] text-xs">
        <thead className="bg-muted/40 text-left text-muted-foreground">
          <tr><th className="px-3 py-1.5">Invoice</th><th className="px-3 py-1.5" colSpan={3}>App</th><th className="px-3 py-1.5 border-l" colSpan={3}>Sheet</th></tr>
          <tr className="bg-muted/20 text-muted-foreground"><th /><th className="px-3 py-1.5">Date</th><th className="px-3 py-1.5 text-right">Lines</th><th className="px-3 py-1.5 text-right">Net</th><th className="border-l px-3 py-1.5">Date</th><th className="px-3 py-1.5 text-right">Lines</th><th className="px-3 py-1.5 text-right">Net</th></tr>
        </thead>
        <tbody>
          {changes.map((change) => <tr key={change.invoice} className="border-t"><td className="px-3 py-1.5 font-medium">{change.invoice}</td><td className="px-3 py-1.5">{change.app.date ?? "—"}</td><td className="px-3 py-1.5 text-right tabular-nums">{change.app.lineCount}</td><td className="px-3 py-1.5 text-right tabular-nums">{money(change.app.net)}</td><td className="border-l px-3 py-1.5">{change.sheet.date ?? "—"}</td><td className="px-3 py-1.5 text-right tabular-nums">{change.sheet.lineCount}</td><td className="px-3 py-1.5 text-right tabular-nums">{money(change.sheet.net)}</td></tr>)}
        </tbody>
      </table>
    </div>}
  </>;
}

async function frozenJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body: { error?: string } = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body as unknown as T;
}

function FrozenDriftCard() {
  const [payload, setPayload] = useState<FrozenDriftPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<FrozenDriftCheck | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FrozenPreview | null>(null);
  const [operator, setOperator] = useState("");
  const [reason, setReason] = useState("");
  const [mutating, setMutating] = useState<"preview" | "apply" | "resolve" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refetch = async () => {
    setLoading(true);
    setError(null);
    try {
      setPayload(await frozenJson<FrozenDriftPayload>("/api/registers/frozen-drift"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refetch(); }, []);

  const openCheck = async (check: FrozenDriftCheck) => {
    setSelected(check);
    setPreview(null);
    setOperator("");
    setReason("");
    setActionError(null);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await frozenJson<unknown>(`/api/registers/frozen-drift/${encodeURIComponent(check.id)}`));
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    }
  };

  const withSecret = (message: string) => window.prompt(message) || null;

  const runChecks = async () => {
    const secret = withSecret("Run frozen source drift checks?\n\nEnter the admin secret to continue:");
    if (!secret) return;
    setRunning(true);
    setError(null);
    try {
      await frozenJson("/api/registers/frozen-drift/run", { method: "POST", headers: { "X-Admin-Secret": secret } });
      await refetch();
    } catch (e) {
      setError(`Could not run checks: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  const previewRefresh = async () => {
    if (!selected) return;
    const secret = withSecret("Preview the frozen-source refresh?\n\nEnter the admin secret to continue:");
    if (!secret) return;
    setMutating("preview");
    setActionError(null);
    try {
      setPreview(await frozenJson<FrozenPreview>(`/api/registers/frozen-drift/${encodeURIComponent(selected.id)}/preview`, {
        method: "POST", headers: { "X-Admin-Secret": secret },
      }));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(null);
    }
  };

  const applyRefresh = async () => {
    if (!selected || !preview) return;
    const secret = withSecret("Apply this previewed frozen-source refresh?\n\nEnter the admin secret to continue:");
    if (!secret) return;
    setMutating("apply");
    setActionError(null);
    try {
      await frozenJson(`/api/registers/frozen-drift/${encodeURIComponent(selected.id)}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": secret },
        body: JSON.stringify({ operator: operator.trim(), reason: reason.trim(), previewHash: preview.previewHash }),
      });
      setSelected(null);
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(null);
    }
  };

  const resolve = async (resolution: "accepted" | "ignored") => {
    if (!selected) return;
    const secret = withSecret(`Mark this saved drift as ${resolution}?\n\nEnter the admin secret to continue:`);
    if (!secret) return;
    setMutating("resolve");
    setActionError(null);
    try {
      await frozenJson(`/api/registers/frozen-drift/${encodeURIComponent(selected.id)}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Secret": secret },
        body: JSON.stringify({ operator: operator.trim(), reason: reason.trim(), resolution }),
      });
      setSelected(null);
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setMutating(null);
    }
  };

  const checks = payload?.checks.filter(needsFrozenReview) ?? [];
  // The source endpoint is diagnostic; avoid a permanent empty card when all
  // frozen months are healthy, while retaining an actionable error if it fails.
  if (!loading && !error && checks.length === 0) return null;

  const formValid = operator.trim().length > 0 && reason.trim().length >= 10;
  const detailEvidence = detail && typeof detail === "object"
    ? (detail as Record<string, unknown>).savedInvoiceEvidence
      ?? (detail as Record<string, unknown>).invoiceEvidence
      ?? (detail as Record<string, unknown>).evidence
    : null;

  return (
    <>
      <Card className="border-amber-300/70 bg-amber-50/30 dark:bg-amber-950/10">
        <CardHeader className="px-6 pt-6 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-xl">
                <ShieldAlert className="size-5 text-amber-600" /> Frozen source drift
              </CardTitle>
              <CardDescription className="mt-1">Frozen registers are read-only. Review saved invoice evidence before recording a decision or applying a previewed refresh.</CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => void runChecks()} disabled={running}>
              {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
              {running ? "Running…" : "Run checks"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          {loading && <p className="text-sm text-muted-foreground">Checking frozen source drift…</p>}
          {error && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">Frozen drift checks unavailable: {error}</div>}
          {!loading && !error && <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full min-w-[780px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-3 py-2">Month / status</th><th className="px-3 py-2">Frozen</th><th className="px-3 py-2 text-right">App rows / net</th><th className="px-3 py-2 text-right">Sheet rows / net</th><th className="px-3 py-2 text-right">Delta</th><th className="px-3 py-2" /></tr>
              </thead>
              <tbody>
                {checks.map((check) => <tr key={check.id} className="border-t border-border/50 align-top">
                  <td className="px-3 py-2"><p className="font-medium">{check.monthLabel}</p><p className="text-xs text-muted-foreground">{isUnreadable(check) ? "Source unreadable" : check.status}</p></td>
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(check.frozenAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{check.appRows.toLocaleString("en-IN")}<br /><span className="text-xs text-muted-foreground">{money(check.appNet)}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{check.sheetRows == null ? <><span className="text-xs text-muted-foreground">Source unavailable</span><br />—</> : <>{check.sheetRows.toLocaleString("en-IN")}<br /><span className="text-xs text-muted-foreground">{money(check.sheetNet)}</span></>}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{check.rowDelta == null ? "—" : <>{signed(check.rowDelta, (n) => n.toLocaleString("en-IN"))} rows<br />{signed(check.netDelta, money)}</>}</td>
                  <td className="px-3 py-2 text-right"><Button size="sm" variant="outline" onClick={() => void openCheck(check)}>Review</Button></td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open && !mutating) setSelected(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Review frozen source drift — {selected?.monthLabel}</DialogTitle><DialogDescription>No refresh is automatic. A refresh can only be applied from its current preview hash.</DialogDescription></DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="rounded-md border bg-muted/30 p-3"><p className="font-medium">Saved invoice evidence</p>{detailError ? <p className="mt-1 text-destructive">{detailError}</p> : <SavedEvidence evidence={detailEvidence} fallback={selected?.detail ?? null} />}</div>
            <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">App</p><p>{selected?.appRows.toLocaleString("en-IN")} rows · {money(selected?.appNet)}</p></div><div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Sheet</p><p>{selected?.sheetRows == null ? "Source unavailable · —" : `${selected.sheetRows.toLocaleString("en-IN")} rows · ${money(selected.sheetNet)}`}</p></div></div>
            <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="frozen-operator">Operator</Label><Input id="frozen-operator" value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Your name or ID" /></div><div className="space-y-1.5"><Label htmlFor="frozen-reason">Reason (at least 10 characters)</Label><Textarea id="frozen-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div></div>
            <Button type="button" variant="outline" onClick={() => void previewRefresh()} disabled={mutating !== null}>{mutating === "preview" && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}Preview refresh impact</Button>
            {preview && <div className="rounded-md border border-amber-300 bg-amber-50/50 p-3"><p className="font-medium">Live preview (not applied)</p><p className="mt-1 text-muted-foreground">{preview.additions?.length ?? 0} addition(s) · {preview.removals?.length ?? 0} removal(s) · {preview.changes?.length ?? 0} change(s) · {signed(preview.rowImpact ?? preview.rowDelta ?? 0, (n) => n.toLocaleString("en-IN"))} rows · {signed(preview.netImpact ?? preview.netDelta ?? 0, money)}</p></div>}
            {actionError && <p className="text-sm text-destructive">{actionError}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSelected(null)} disabled={mutating !== null}>Cancel</Button>
            <Button variant="outline" disabled={!formValid || mutating !== null} onClick={() => void resolve("ignored")}>Mark ignored</Button>
            <Button variant="outline" disabled={!formValid || mutating !== null} onClick={() => void resolve("accepted")}>Mark accepted</Button>
            <Button disabled={!formValid || !preview || mutating !== null} onClick={() => void applyRefresh()}>{mutating === "apply" && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}Apply previewed refresh</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UnmatchedNamesCard() {
  const [data, setData] = useState<UnmatchedPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/mgmt/unmatched-names", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: UnmatchedPayload) => setData(d))
      .catch((e) => {
        if (e?.name !== "AbortError") setError(String(e?.message ?? e));
      });
    return () => ctrl.abort();
  }, []);

  if (error) return null; // panel is diagnostic; never block the page on it
  const resolvable = data?.names.filter((n) => n.registryStatus === "resolvable").length ?? 0;
  const shown = data ? (expanded ? data.names : data.names.slice(0, 15)) : [];

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 pt-6 pb-3">
        <CardTitle className="text-xl flex items-center gap-2">
          <UserX className="w-5 h-5 text-amber-600" />
          Unmatched Order-Booking Names
        </CardTitle>
        <CardDescription>
          {data
            ? <>Order-booking names in {data.fy} that match no roster member — {data.count} names carrying {fmtL(data.totalAmount)} of net Sale counted in the company total but attributed to no member or head. {resolvable > 0 && <>The identity registry already resolves {resolvable} of them as spelling variants — fix those by mapping, not by hand.</>}</>
            : "Checking order-booking names against the roster and identity registry…"}
        </CardDescription>
      </CardHeader>
      {data && data.count > 0 && (
        <CardContent className="px-6 pb-6">
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Name in order file</th>
                  <th className="px-3 py-2 font-medium text-right">Value</th>
                  <th className="px-3 py-2 font-medium">Registry check</th>
                  <th className="px-3 py-2 font-medium">Likely member</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((n) => {
                  const badge = STATUS_BADGE[n.registryStatus];
                  return (
                    <tr key={n.name} className="border-t border-border/50">
                      <td className="px-3 py-1.5">{n.name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtL(n.amount)}</td>
                      <td className="px-3 py-1.5">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {n.resolvedTo ?? (n.candidates ? n.candidates.join("; ") : "—")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.names.length > 15 && (
            <button
              className="mt-2 text-xs text-primary underline underline-offset-2"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show fewer" : `Show all ${data.names.length} names`}
            </button>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ── Roster refresh card ───────────────────────────────────────────────────────
// Lets an admin upload a fresh User_List.csv from the HR SFA system without
// requiring a redeploy. The endpoint overwrites config/hr_roster.csv, clears
// the roster cache, and invalidates all mgmt-data snapshots.

type RosterRefreshResult = {
  ok: boolean;
  memberCount: number;
  activeCount: number;
  source: string;
  csvPath: string;
  refreshedAt: string;
};

function RosterRefreshCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [result, setResult] = useState<RosterRefreshResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleFile(file: File) {
    // Collect the admin secret before reading the file — abort early if the
    // user cancels the prompt (matches the lockAnchorNow pattern in DataHealth).
    const secret = window.prompt(
      "Enter the ADMIN_SECRET to authorise the roster update:",
    );
    if (!secret) return;

    setStatus("uploading");
    setResult(null);
    setErrorMsg(null);
    try {
      const text = await file.text();
      const res = await fetch("/api/admin/roster/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "text/csv",
          "X-Admin-Secret": secret,
        },
        body: text,
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json?.error ?? `Server error ${res.status}`);
        setStatus("error");
        return;
      }
      setResult(json as RosterRefreshResult);
      setStatus("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 pt-6 pb-3">
        <CardTitle className="text-xl flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" />
          Refresh HR Roster
        </CardTitle>
        <CardDescription>
          Upload the latest <code className="text-xs font-mono">User_List.csv</code> from the HR SFA system to
          bring the team list up to date without a server redeploy.
          The file replaces <code className="text-xs font-mono">config/hr_roster.csv</code> and
          invalidates all cached report data immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6 pb-6 space-y-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            // reset so the same file can be re-uploaded if needed
            e.target.value = "";
          }}
        />
        <button
          disabled={status === "uploading"}
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium
                     hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Upload className="w-4 h-4" />
          {status === "uploading" ? "Uploading…" : "Upload User_List.csv"}
        </button>

        {status === "done" && result && (
          <div className="rounded-lg border border-green-500/30 bg-green-50/50 dark:bg-green-950/20 px-4 py-3 text-sm space-y-1">
            <p className="font-medium text-green-700 dark:text-green-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" /> Roster updated
            </p>
            <p className="text-muted-foreground">
              {result.memberCount} members loaded ({result.activeCount} active) · Source: <span className="font-mono text-xs">{result.source}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Refreshed at {new Date(result.refreshedAt).toLocaleString()}
            </p>
          </div>
        )}

        {status === "error" && errorMsg && (
          <div className="rounded-lg border border-red-500/30 bg-red-50/50 dark:bg-red-950/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
            {errorMsg}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Expected format: the 35-column <strong>User_List.csv</strong> exported from the SFA system
          (columns: Name, Employee Code, Designation, Status, Date of Joining, Date of Leaving, CTC, …).
          The roster is enrichment-only — the member list itself comes from the live STATE HEAD DASHBOARD,
          so uploading this file updates HR metadata (emp code, designation, CTC, active status) but does
          not add or remove members from the dashboard.
        </p>
      </CardContent>
    </Card>
  );
}

export default function DataSources() {
  const { manifest } = useDashboard();
  const { user } = useAuth();
  const generatedDate = new Date(manifest.generated);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      {/* Organisation model — State Heads, States, Employees */}
      <Organisation />

      {/* Largest single data-quality item on this page */}
      <UnmatchedNamesCard />

      {user?.role === "admin" && <FrozenDriftCard />}

      {/* HR roster CSV refresh — lets admin update the team list without a redeploy */}
      <RosterRefreshCard />

      {/* Target editors moved to the Targets page — Data Sources describes sources, it does not edit targets. */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardContent className="px-6 py-5 flex items-start gap-3">
          <Target className="w-5 h-5 text-primary mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium">Looking for the target editors?</p>
            <p className="text-muted-foreground mt-0.5">
              State Head Targets and Secondary Targets are now edited on the{" "}
              <Link href="/targets" className="text-primary underline underline-offset-2">Targets page</Link>.
              This page describes where data comes from; it no longer edits targets.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-xl flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            Dataset Provenance
          </CardTitle>
          <CardDescription>
            Transparency audit of all source files merged into this intelligence view.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 mb-8">
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <Clock className="w-4 h-4" /> Last Generated
              </p>
              <p className="text-sm font-medium">{generatedDate.toLocaleString()}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <FolderGit2 className="w-4 h-4" /> Source Drive
              </p>
              <p className="text-sm font-medium truncate" title={manifest.drive_account}>{manifest.drive_account}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Pipeline Status
              </p>
              <p className="text-sm font-medium text-green-600 dark:text-green-400">Validated & Normalized</p>
            </div>
          </div>

          <div className="space-y-8">
            <div>
              <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-4">Primary Sources</h3>
              <div className="grid gap-3">
                {Object.entries(manifest.primary_sources).map(([key, source]) => (
                  <div key={key} className="flex items-start gap-3 p-3 rounded-lg border border-border/50 bg-background/50">
                    <FileText className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{key.replace(/_/g, " ")}</p>
                      <p className="text-xs text-muted-foreground">{source.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-8">
              <div>
                <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-purple-500"></span> Sales Data Files
                </h3>
                <ul className="space-y-2">
                  {manifest.sales_files.map((file, i) => (
                    <li key={i} className="text-sm text-foreground flex items-start gap-2">
                      <span className="text-muted-foreground mt-0.5">•</span>
                      <span>
                        {file.name}
                        <span className="text-xs text-muted-foreground"> — {file.category} ({file.fy})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500"></span> Orders & Support
                </h3>
                <ul className="space-y-2">
                  {manifest.order_and_support_files.map((file, i) => (
                    <li key={i} className="text-sm text-foreground flex items-start gap-2">
                      <span className="text-muted-foreground mt-0.5">•</span>
                      <span>
                        {file.name}
                        <span className="text-xs text-muted-foreground"> — {file.category} ({file.period})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {manifest.notes && manifest.notes.length > 0 && (
              <div className="pt-4 border-t border-border/50">
                <h3 className="text-sm font-bold tracking-wider text-muted-foreground uppercase mb-3">Processing Notes</h3>
                <ul className="space-y-2">
                  {manifest.notes.map((note, i) => (
                    <li key={i} className="text-sm text-muted-foreground italic">
                      Note: {note}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
