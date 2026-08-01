// Data Health — comprehensive multi-anchor-set verification dashboard.
// Calls GET /api/audit?fy=<fy> (which wraps runFullVerify + extra groups) and renders
// all check groups with pass / warn / fail / pending / skip status chips.
import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, CheckCircle, AlertTriangle, XCircle, Clock, Minus, Download, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDashboard } from "@/data/dashboard-context";

// ── Types ─────────────────────────────────────────────────────────────────────

type AnchorCheckResult = {
  fy: string;
  month: string;
  dbCurrentRows: number;
  sheetRows: number;
  dbCurrentTotal: number;
  sheetTotal: number;
  rowDelta: number;
  totalDelta: number;
  divergencePct: number;
  status: "ok" | "diverged" | "suspected-read-failure";
  checkedAt: string;
};

type CheckStatus = "pass" | "warn" | "fail" | "skip" | "pending";

type HealthCheck = {
  key: string;
  label: string;
  unit: "money" | "count" | "pct" | "text";
  expected: number | null;
  actual: number | null;
  deltaPct: number | null;
  status: CheckStatus;
  note?: string;
};

type CheckGroup = {
  id: string;
  label: string;
  available: boolean;
  pendingNote?: string;
  checks: HealthCheck[];
};

type FullVerifyReport = {
  fy: string;
  overall: "pass" | "warn" | "fail";
  groups: CheckGroup[];
  computedAt: string;
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCr(n: number): string {
  return "\u20b9" + (Math.abs(n) / 1e7).toFixed(2) + " Cr";
}

function fmtActual(c: HealthCheck): string {
  if (c.actual == null) return "—";
  if (c.unit === "money") return fmtCr(c.actual);
  if (c.unit === "count") return c.actual.toLocaleString("en-IN");
  if (c.unit === "pct") return c.actual.toFixed(1) + "%";
  return "—";
}

function fmtExpected(c: HealthCheck): string {
  if (c.expected == null) return "—";
  if (c.unit === "money") return fmtCr(c.expected);
  if (c.unit === "count") return c.expected.toLocaleString("en-IN");
  if (c.unit === "pct") return c.expected.toFixed(1) + "%";
  return "—";
}

function fmtDelta(n: number | null): string {
  if (n == null) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

// ── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: CheckStatus }) {
  if (status === "pass") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 whitespace-nowrap">
        <CheckCircle className="w-3 h-3 shrink-0" /> Pass
      </span>
    );
  }
  if (status === "warn") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 whitespace-nowrap">
        <AlertTriangle className="w-3 h-3 shrink-0" /> Warn
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 whitespace-nowrap">
        <XCircle className="w-3 h-3 shrink-0" /> Fail
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 whitespace-nowrap">
        <Clock className="w-3 h-3 shrink-0" /> Pending
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground whitespace-nowrap">
      <Minus className="w-3 h-3 shrink-0" /> Skip
    </span>
  );
}

// ── Group summary ─────────────────────────────────────────────────────────────

function GroupSummary({ checks }: { checks: HealthCheck[] }) {
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const pass = checks.filter((c) => c.status === "pass").length;
  if (fail > 0) return <span className="text-xs text-red-600 dark:text-red-400 font-medium">{fail} fail{fail > 1 ? "s" : ""}</span>;
  if (warn > 0) return <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">{warn} warn{warn > 1 ? "s" : ""}</span>;
  if (pass > 0) return <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">All pass</span>;
  return <span className="text-xs text-muted-foreground">No checks</span>;
}

// ── Check row ─────────────────────────────────────────────────────────────────

function CheckRow({ c }: { c: HealthCheck }) {
  return (
    <tr className={cn(
      "border-b border-border/40 last:border-0",
      c.status === "fail" && "bg-red-50/60 dark:bg-red-950/20",
      c.status === "warn" && "bg-amber-50/60 dark:bg-amber-950/20",
    )}>
      <td className="py-2.5 pl-4 pr-2 align-top w-20">
        <StatusChip status={c.status} />
      </td>
      <td className="py-2.5 px-2 text-sm font-medium align-top">
        {c.label}
        {c.note && <p className="mt-0.5 text-xs text-muted-foreground font-normal">{c.note}</p>}
      </td>
      <td className="py-2.5 px-2 text-sm text-right align-top tabular-nums whitespace-nowrap">
        {fmtActual(c)}
      </td>
      <td className="py-2.5 px-2 text-sm text-right align-top tabular-nums whitespace-nowrap text-muted-foreground">
        {fmtExpected(c)}
      </td>
      <td className="py-2.5 pl-2 pr-4 text-sm text-right align-top tabular-nums whitespace-nowrap">
        {c.deltaPct == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className={cn(
            "font-medium",
            Math.abs(c.deltaPct) <= 1 ? "text-emerald-600 dark:text-emerald-400"
              : Math.abs(c.deltaPct) <= 2 ? "text-amber-600 dark:text-amber-400"
              : "text-red-600 dark:text-red-400",
          )}>
            {fmtDelta(c.deltaPct)}
          </span>
        )}
      </td>
    </tr>
  );
}

// ── Group card ─────────────────────────────────────────────────────────────────

function GroupCard({ group }: { group: CheckGroup }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-card hover:bg-muted/50 transition-colors text-left gap-3"
      >
        <span className="font-medium text-sm">{group.label}</span>
        <div className="flex items-center gap-3 ml-auto">
          {group.checks.length > 0 && <GroupSummary checks={group.checks} />}
          {!group.available && group.checks.length === 0 && (
            <span className="text-xs text-muted-foreground">Unavailable</span>
          )}
          <span className="text-muted-foreground text-xs">{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {open && (
        <>
          {!group.available && group.pendingNote && (
            <div className="px-4 py-3 text-sm text-muted-foreground border-t border-border/40 bg-muted/30">
              {group.pendingNote}
            </div>
          )}
          {group.checks.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr className="border-b border-border/40 bg-muted/30">
                    <th className="py-2 pl-4 pr-2 text-left text-xs text-muted-foreground font-medium w-20">Status</th>
                    <th className="py-2 px-2 text-left text-xs text-muted-foreground font-medium">Check</th>
                    <th className="py-2 px-2 text-right text-xs text-muted-foreground font-medium">Actual</th>
                    <th className="py-2 px-2 text-right text-xs text-muted-foreground font-medium">Expected</th>
                    <th className="py-2 pl-2 pr-4 text-right text-xs text-muted-foreground font-medium">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {group.checks.map((c) => (
                    <CheckRow key={c.key} c={c} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {group.available && group.checks.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground border-t border-border/40">
              No checks defined for this group.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

const FYS = ["2026-27", "2025-26", "2024-25"];

export default function DataHealth() {
  const [fy, setFy] = useState("2026-27");
  const [report, setReport] = useState<FullVerifyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  type VersionStats = {
    fy: string;
    totalRows: number;
    currentRows: number;
    supersededRows: number;
    currentAmount: number;
    supersededAmount: number;
    reconciled: boolean;
  };
  const [versionStats, setVersionStats] = useState<VersionStats | null>(null);

  type LockMonth = {
    month: string;
    locked: boolean;
    frozen: boolean;
    deadline: string | null;
    freezesAt: string | null;
    overdue: boolean;
  };
  type LockStatus = { fy: string; closedMonths: string[]; months: LockMonth[] };
  const [lockStatus, setLockStatus] = useState<LockStatus | null>(null);
  const [locking, setLocking] = useState<string | null>(null);
  const [lockMsg, setLockMsg] = useState<string | null>(null);
  const [anchorHealth, setAnchorHealth] = useState<AnchorCheckResult[]>([]);
  const [syncingTick, setSyncingTick] = useState(false);

  const { syncedAt } = useDashboard();

  const runAudit = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/audit?fy=${encodeURIComponent(fy)}`)
      .then((r) => {
        if (!r.ok) {
          return r.json().then((d: { error?: string }) => {
            throw new Error(d.error ?? r.statusText);
          });
        }
        return r.json() as Promise<FullVerifyReport>;
      })
      .then((d) => {
        setReport(d);
        setLastRun(
          new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true }),
        );
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [fy]);

  // Run on mount and when FY changes.
  useEffect(() => { runAudit(); }, [runAudit]);

  // Fetch version-stats (deduplication health) whenever FY changes.
  useEffect(() => {
    setVersionStats(null);
    fetch(`/api/registers/${encodeURIComponent(fy)}/version-stats`)
      .then((r) => r.ok ? r.json() as Promise<VersionStats> : null)
      .then((d) => d && setVersionStats(d))
      .catch(() => {});
  }, [fy]);

  // Fetch anchor health (DB vs sheet per-month comparison). Always the open FY
  // regardless of the audit FY selector — anchor data only exists for synced FYs.
  const fetchAnchorHealth = useCallback(() => {
    fetch("/api/registers/anchor-health")
      .then((r) => r.ok ? r.json() as Promise<AnchorCheckResult[]> : [])
      .then((d) => Array.isArray(d) && setAnchorHealth(d))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchAnchorHealth(); }, [fetchAnchorHealth]);

  // Fetch month anchor-lock status whenever FY changes.
  const fetchLockStatus = useCallback(() => {
    fetch(`/api/registers/${encodeURIComponent(fy)}/lock-status`)
      .then((r) => (r.ok ? (r.json() as Promise<LockStatus>) : null))
      .then((d) => setLockStatus(d))
      .catch(() => setLockStatus(null));
  }, [fy]);

  useEffect(() => {
    setLockStatus(null);
    setLockMsg(null);
    fetchLockStatus();
  }, [fetchLockStatus]);

  const lockAnchorNow = useCallback((month: string) => {
    const secret = window.prompt(
      `Lock the ${month} anchor now?\n\nThis writes the current DB total into verify_anchors.json permanently.\nEnter the admin secret to confirm:`,
    );
    if (!secret) return;
    setLocking(month);
    setLockMsg(null);
    fetch(`/api/registers/${encodeURIComponent(fy)}/lock-month-anchor?month=${encodeURIComponent(month)}`, {
      method: "POST",
      headers: { "X-Admin-Secret": secret },
    })
      .then((r) => r.json().then((d: { error?: string; locked?: boolean; dbRows?: number; amountCr?: number }) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error ?? "Lock failed");
        setLockMsg(`${month} locked: ${d.dbRows?.toLocaleString("en-IN")} rows / \u20b9${d.amountCr} Cr`);
        fetchLockStatus();
      })
      .catch((err: Error) => setLockMsg(`Lock failed: ${err.message}`))
      .finally(() => setLocking(null));
  }, [fy, fetchLockStatus]);

  const triggerSyncTick = useCallback(() => {
    setSyncingTick(true);
    fetch("/api/registers/run-sync-tick", { method: "POST" })
      .then(() => {
        // Poll anchor-health after a short delay to pick up the result.
        setTimeout(fetchAnchorHealth, 5000);
        setTimeout(fetchAnchorHealth, 20000);
        setTimeout(fetchAnchorHealth, 60000);
      })
      .catch(() => {})
      .finally(() => setTimeout(() => setSyncingTick(false), 3000));
  }, [fetchAnchorHealth]);

  const downloadAudit = useCallback(() => {
    setDownloading(true);
    fetch(`/api/audit/download?fy=${encodeURIComponent(fy)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Server returned ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const now = new Date();
        const ts =
          now.getFullYear().toString() +
          String(now.getMonth() + 1).padStart(2, "0") +
          String(now.getDate()).padStart(2, "0") +
          "-" +
          String(now.getHours()).padStart(2, "0") +
          String(now.getMinutes()).padStart(2, "0");
        a.download = `Audit_${fy.replace("-", "")}_${ts}.xlsx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      })
      .catch((err: Error) => setError(`Download failed: ${err.message}`))
      .finally(() => setDownloading(false));
  }, [fy]);

  // Auto-rerun after a dashboard refresh (syncedAt advances).
  const prevSyncedAt = useRef<string | null>(null);
  useEffect(() => {
    if (syncedAt && syncedAt !== prevSyncedAt.current) {
      prevSyncedAt.current = syncedAt;
      runAudit();
    }
  }, [syncedAt, runAudit]);

  const overallColor =
    report?.overall === "fail"
      ? "border-red-400 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300"
      : report?.overall === "warn"
        ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300"
        : "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300";

  return (
    <div className="flex flex-col gap-4">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">FY</label>
          <select
            value={fy}
            onChange={(e) => setFy(e.target.value)}
            className="h-8 px-2 rounded-md border border-border/60 bg-background text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {FYS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>

        <button
          onClick={runAudit}
          disabled={loading}
          className="flex items-center gap-2 h-8 px-3 rounded-md border border-border/60 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          {loading ? "Running" : "Run Checks"}
        </button>

        <button
          onClick={downloadAudit}
          disabled={!report || downloading}
          className="flex items-center gap-2 h-8 px-3 rounded-md border border-border/60 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Download className={cn("w-3.5 h-3.5", downloading && "animate-pulse")} />
          {downloading ? "Generating..." : "Download Audit (Excel)"}
        </button>

        {lastRun && !loading && (
          <span className="text-xs text-muted-foreground self-end pb-1.5">
            Last run {lastRun}
            {syncedAt && " (auto-synced after refresh)"}
          </span>
        )}
      </div>

      {/* Fail banner — prominent red stripe at top */}
      {report?.overall === "fail" && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-red-600 text-white text-sm font-medium">
          <XCircle className="w-4 h-4 shrink-0" />
          One or more verification checks failed. Review the groups below and download the audit workbook for details.
        </div>
      )}

      {/* Overall badge */}
      {report && (
        <div className={cn("border rounded-md px-4 py-2.5 text-sm font-medium", overallColor)}>
          {report.overall === "fail" && "Fail — data does not match approved anchors"}
          {report.overall === "warn" && "Warning — minor discrepancies detected"}
          {report.overall === "pass" && "Pass — all checks within tolerance"}
          <span className="text-xs font-normal opacity-70 ml-2">({report.fy})</span>
          <span className="text-xs font-normal opacity-50 ml-2">
            {report.groups.length} groups · {report.groups.flatMap((g) => g.checks).length} checks
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-3 rounded-md border border-red-300 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !report && (
        <div className="flex flex-col gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 rounded-lg border border-border/40 bg-muted/30 animate-pulse" />
          ))}
        </div>
      )}

      {/* Check groups */}
      {report && (
        <div className="flex flex-col gap-3">
          {report.groups.map((g) => (
            <GroupCard key={g.id} group={g} />
          ))}
        </div>
      )}

      {/* Live sync anchor health — DB current vs sheet, per month */}
      {anchorHealth.length > 0 && (() => {
        const alerts = anchorHealth.filter((r) => r.status !== "ok");
        const isFail = alerts.some((r) => r.status === "suspected-read-failure");
        const isWarn = !isFail && alerts.length > 0;
        const allOk = alerts.length === 0;
        return (
          <div className="border border-border/60 rounded-lg overflow-hidden">
            <div className={cn(
              "flex items-center justify-between px-4 py-3 gap-3",
              isFail ? "bg-red-50 dark:bg-red-950/20 border-b border-red-200 dark:border-red-900/40"
                : isWarn ? "bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-900/40"
                : "bg-emerald-50 dark:bg-emerald-950/20 border-b border-emerald-200 dark:border-emerald-900/40"
            )}>
              <div className="flex items-center gap-2">
                <Activity className={cn("w-4 h-4 shrink-0",
                  isFail ? "text-red-500" : isWarn ? "text-amber-500" : "text-emerald-500"
                )} />
                <span className="font-medium text-sm">
                  Live sync anchor — DB vs sheet ({anchorHealth[0]?.fy})
                </span>
                {isFail && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                    Suspected read failure
                  </span>
                )}
                {isWarn && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    {alerts.length} month{alerts.length > 1 ? "s" : ""} diverged
                  </span>
                )}
                {allOk && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                    All months match
                  </span>
                )}
              </div>
              <button
                onClick={triggerSyncTick}
                disabled={syncingTick}
                title="Run a sync tick now (open FY only) and refresh anchor results"
                className="flex items-center gap-1.5 h-7 px-2.5 rounded border border-border/60 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw className={cn("w-3 h-3", syncingTick && "animate-spin")} />
                {syncingTick ? "Syncing" : "Sync now"}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border/40 bg-muted/20">
                    <th className="py-2 pl-4 pr-2 text-left text-xs text-muted-foreground font-medium w-20">Status</th>
                    <th className="py-2 px-2 text-left text-xs text-muted-foreground font-medium">Month</th>
                    <th className="py-2 px-2 text-right text-xs text-muted-foreground font-medium">DB rows</th>
                    <th className="py-2 px-2 text-right text-xs text-muted-foreground font-medium">Sheet rows</th>
                    <th className="py-2 px-2 text-right text-xs text-muted-foreground font-medium">DB total</th>
                    <th className="py-2 px-2 text-right text-xs text-muted-foreground font-medium">Sheet total</th>
                    <th className="py-2 pl-2 pr-4 text-right text-xs text-muted-foreground font-medium">Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {anchorHealth.map((r) => (
                    <tr key={`${r.fy}|${r.month}`} className={cn(
                      "border-b border-border/30 last:border-0",
                      r.status === "suspected-read-failure" && "bg-red-50/60 dark:bg-red-950/20",
                      r.status === "diverged" && "bg-amber-50/60 dark:bg-amber-950/20",
                    )}>
                      <td className="py-2 pl-4 pr-2 align-middle">
                        {r.status === "ok" ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                            <CheckCircle className="w-3 h-3" /> OK
                          </span>
                        ) : r.status === "suspected-read-failure" ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 whitespace-nowrap">
                            <XCircle className="w-3 h-3" /> Read fail?
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                            <AlertTriangle className="w-3 h-3" /> Diverged
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 font-medium align-middle">{r.month}</td>
                      <td className="py-2 px-2 text-right tabular-nums align-middle">{r.dbCurrentRows.toLocaleString("en-IN")}</td>
                      <td className="py-2 px-2 text-right tabular-nums align-middle">{r.sheetRows.toLocaleString("en-IN")}</td>
                      <td className="py-2 px-2 text-right tabular-nums align-middle whitespace-nowrap">
                        {"\u20b9"}{(r.dbCurrentTotal / 1e7).toFixed(2)} Cr
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums align-middle whitespace-nowrap">
                        {"\u20b9"}{(r.sheetTotal / 1e7).toFixed(2)} Cr
                      </td>
                      <td className={cn(
                        "py-2 pl-2 pr-4 text-right tabular-nums font-medium align-middle whitespace-nowrap",
                        r.status === "ok" ? "text-emerald-600 dark:text-emerald-400"
                          : r.status === "suspected-read-failure" ? "text-red-600 dark:text-red-400"
                          : "text-amber-600 dark:text-amber-400"
                      )}>
                        {r.rowDelta === 0 ? "—" : (r.rowDelta > 0 ? "+" : "") + r.rowDelta.toLocaleString("en-IN") + " rows"}
                        {r.rowDelta !== 0 && (
                          <span className="text-xs font-normal ml-1 opacity-70">
                            ({r.divergencePct.toFixed(1)}%)
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border/30 bg-muted/10">
              DB current = rows with version_status=&apos;current&apos; in sale_line. Sheet = rows parsed from
              the last sync read. Gap &gt;10% flagged as suspected read failure (also covers blast-radius-halted
              months). Last checked:{" "}
              {anchorHealth[0]?.checkedAt
                ? new Date(anchorHealth[0].checkedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })
                : "—"}
            </div>
          </div>
        );
      })()}

      {/* Month anchor lock status */}
      {lockStatus && lockStatus.months.length > 0 && (() => {
        const pending = lockStatus.months.filter((mo) => !mo.locked);
        const anyOverdue = pending.some((mo) => mo.overdue);
        return (
          <div className="border border-border/60 rounded-lg overflow-hidden">
            <div className={cn(
              "flex items-center gap-2 px-4 py-3",
              anyOverdue ? "bg-red-50 dark:bg-red-950/20 border-b border-red-200 dark:border-red-900/40"
                : pending.length > 0 ? "bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-900/40"
                : "bg-emerald-50 dark:bg-emerald-950/20 border-b border-emerald-200 dark:border-emerald-900/40"
            )}>
              <Clock className={cn("w-4 h-4 shrink-0",
                anyOverdue ? "text-red-500" : pending.length > 0 ? "text-amber-500" : "text-emerald-500"
              )} />
              <span className="font-medium text-sm">Month anchor locks ({lockStatus.fy})</span>
              {pending.length > 0 ? (
                <span className={cn(
                  "text-xs font-medium px-2 py-0.5 rounded-full",
                  anyOverdue ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                )}>
                  {pending.length} pending lock{pending.length > 1 ? "s" : ""}{anyOverdue ? " — deadline passed" : ""}
                </span>
              ) : (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  All months locked
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border/40 bg-muted/20">
                    <th className="py-2 pl-4 pr-2 text-left text-xs text-muted-foreground font-medium w-28">Status</th>
                    <th className="py-2 px-2 text-left text-xs text-muted-foreground font-medium">Month</th>
                    <th className="py-2 px-2 text-left text-xs text-muted-foreground font-medium">Lock deadline</th>
                    <th className="py-2 px-2 text-left text-xs text-muted-foreground font-medium">Auto-freeze</th>
                    <th className="py-2 pl-2 pr-4 text-right text-xs text-muted-foreground font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lockStatus.months.map((mo) => (
                    <tr key={mo.month} className={cn(
                      "border-b border-border/30 last:border-0",
                      !mo.locked && mo.overdue && "bg-red-50/60 dark:bg-red-950/20",
                      !mo.locked && !mo.overdue && "bg-amber-50/40 dark:bg-amber-950/10",
                    )}>
                      <td className="py-2 pl-4 pr-2 align-middle">
                        {mo.locked ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                            <CheckCircle className="w-3 h-3" /> Locked
                          </span>
                        ) : mo.overdue ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300 whitespace-nowrap">
                            <XCircle className="w-3 h-3" /> Overdue
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 whitespace-nowrap">
                            <Clock className="w-3 h-3" /> Pending lock
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 font-medium align-middle">{mo.month}</td>
                      <td className={cn(
                        "py-2 px-2 align-middle tabular-nums",
                        !mo.locked && mo.overdue && "text-red-600 dark:text-red-400 font-medium",
                      )}>
                        {mo.deadline ?? "—"}
                      </td>
                      <td className="py-2 px-2 align-middle tabular-nums text-muted-foreground">
                        {mo.freezesAt ?? "—"}{mo.frozen ? " (frozen)" : ""}
                      </td>
                      <td className="py-2 pl-2 pr-4 text-right align-middle">
                        {!mo.locked && (
                          <button
                            onClick={() => lockAnchorNow(mo.month)}
                            disabled={locking != null}
                            className={cn(
                              "h-7 px-2.5 rounded border text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                              mo.overdue
                                ? "border-red-300 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30"
                                : "border-border/60 hover:bg-muted",
                            )}
                          >
                            {locking === mo.month ? "Locking…" : "Lock anchor now"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lockMsg && (
              <div className={cn(
                "px-4 py-2 text-xs border-t border-border/30",
                lockMsg.startsWith("Lock failed") ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400",
              )}>
                {lockMsg}
              </div>
            )}
            <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border/30 bg-muted/10">
              Data owners must confirm the register sheet and lock each month's anchor by the deadline
              (the day before the automatic freeze on the 7th of the following month). Locking requires
              the admin secret and writes the DB total into verify_anchors.json permanently.
            </div>
          </div>
        );
      })()}

      {/* Register deduplication status */}
      {versionStats && versionStats.totalRows > 0 && (
        <div className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 rounded-md border text-sm",
          versionStats.reconciled
            ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300"
            : "border-amber-300 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300"
        )}>
          <span className="font-medium">Register deduplication ({versionStats.fy}):</span>
          {versionStats.reconciled ? (
            <span>
              Reconciled — {versionStats.currentRows.toLocaleString("en-IN")} current rows,{" "}
              {versionStats.supersededRows.toLocaleString("en-IN")} superseded
            </span>
          ) : (
            <span>
              Not yet reconciled — {versionStats.totalRows.toLocaleString("en-IN")} total rows.
              Run <code className="font-mono text-xs">POST /api/registers/{versionStats.fy}/backfill-color</code> then{" "}
              <code className="font-mono text-xs">reconcile-versions</code>.
            </span>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground pt-2 border-t border-border/30">
        <span className="font-medium text-foreground">Legend:</span>
        <span>Pass: within 1% (money) / 2% (count)</span>
        <span>Warn: within 2% (money) / 4% (count)</span>
        <span>Fail: beyond warn threshold</span>
        <span>Pending: expected unavailable</span>
        <span>Skip: no anchor or not probed</span>
      </div>
    </div>
  );
}
