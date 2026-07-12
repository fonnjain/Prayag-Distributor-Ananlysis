// Data Health — comprehensive multi-anchor-set verification dashboard.
// Calls GET /api/mgmt/verify?fy=<fy> and renders all check groups
// with pass / warn / fail / pending / skip status chips.
import { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle, AlertTriangle, XCircle, Clock, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Group card ────────────────────────────────────────────────────────────────

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

const FYS = ["2025-26", "2026-27", "2024-25"];

export default function DataHealth() {
  const [fy, setFy] = useState("2025-26");
  const [report, setReport] = useState<FullVerifyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const runVerify = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/mgmt/verify?fy=${encodeURIComponent(fy)}`)
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

  useEffect(() => { runVerify(); }, [runVerify]);

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
          onClick={runVerify}
          disabled={loading}
          className="flex items-center gap-2 h-8 px-3 rounded-md border border-border/60 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          {loading ? "Running" : "Run Checks"}
        </button>

        {lastRun && !loading && (
          <span className="text-xs text-muted-foreground self-end pb-1.5">
            Last run {lastRun}
          </span>
        )}
      </div>

      {/* Fail banner */}
      {report?.overall === "fail" && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-red-600 text-white text-sm font-medium">
          <XCircle className="w-4 h-4 shrink-0" />
          One or more verification checks failed. Review the groups below.
        </div>
      )}

      {/* Overall badge */}
      {report && (
        <div className={cn("border rounded-md px-4 py-2.5 text-sm font-medium", overallColor)}>
          {report.overall === "fail" && "Fail — data does not match approved anchors"}
          {report.overall === "warn" && "Warning — minor discrepancies detected"}
          {report.overall === "pass" && "Pass — all checks within tolerance"}
          <span className="text-xs font-normal opacity-70 ml-2">({report.fy})</span>
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
