import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
type Status = {
  sourceFetchedAt?: string | null; lastSuccessAt?: string | null;
  activeRowCount?: number; sourceRowCount?: number; ageHours?: number | null;
  freshness?: "current" | "warning" | "critical"; lastError?: string | null;
};
type Coverage = {
  source?: string;
  exactAuthorityGap?: { pct: number; status: "current" | "warning" | "critical" };
  resolverUnresolved?: { pct: number; status: "current" | "warning" | "critical" };
};

export function MrpFreshnessIndicator({ detailed = false }: { detailed?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [statusResponse, coverageResponse] = await Promise.all([
          fetch(`${BASE}/api/mrp/sync-status`, { credentials: "include" }),
          fetch(`${BASE}/api/mrp/coverage`, { credentials: "include" }),
        ]);
        if (statusResponse.ok && !cancelled) setStatus(await statusResponse.json() as Status);
        if (coverageResponse.ok && !cancelled) setCoverage(await coverageResponse.json() as Coverage);
      } catch { /* indicator is non-blocking */ }
    };
    void load();
    const timer = window.setInterval(load, 5 * 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  if (!status) return null;
  const coverageSeverity = coverage?.exactAuthorityGap?.status === "critical" || coverage?.resolverUnresolved?.status === "critical"
    ? "critical"
    : coverage?.exactAuthorityGap?.status === "warning" || coverage?.resolverUnresolved?.status === "warning"
      ? "warning"
      : "current";
  const overallSeverity = status.freshness === "critical" || coverageSeverity === "critical"
    ? "critical"
    : status.freshness === "warning" || coverageSeverity === "warning"
      ? "warning"
      : "current";
  const tone = overallSeverity === "critical" ? "text-destructive" : overallSeverity === "warning" ? "text-amber-600" : "text-emerald-600";
  const age = status.ageHours == null ? "—" : `${status.ageHours.toFixed(1)}h`;
  const gapSummary = coverage?.exactAuthorityGap && coverage.resolverUnresolved
    ? `Exact gap ${(coverage.exactAuthorityGap.pct * 100).toFixed(1)}% · unresolved ${(coverage.resolverUnresolved.pct * 100).toFixed(1)}%`
    : null;
  return detailed ? (
    <div className="rounded-md border bg-card p-4 text-sm">
      <div className={cn("font-semibold", tone)}>MRP freshness: {status.freshness ?? "unknown"}</div>
      <div className="mt-2 grid gap-1 text-muted-foreground sm:grid-cols-2">
        <span>Last successful fetch: {status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : "None"}</span>
        <span>Age: {age}</span>
        <span>Active rows: {status.activeRowCount ?? 0}</span>
        <span>Source rows: {status.sourceRowCount ?? 0}</span>
        <span>Latest error: {status.lastError ?? "None"}</span>
        {gapSummary && <span>Sold-value coverage: {gapSummary}</span>}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">History records successful generations only; failed transactions roll back and retain only the latest error.</p>
    </div>
  ) : (
    <span
      className={cn("text-[11px] font-medium", tone)}
      title={`${coverage?.source ?? "sale_line_current + active MRP cache"}; exact-code and resolver-unresolved bases are separate.${status.lastError ? ` Latest error: ${status.lastError}` : ""}`}
    >
      MRP {status.freshness ?? "unknown"} · {age} · {status.activeRowCount ?? 0}/{status.sourceRowCount ?? 0} rows{gapSummary ? ` · ${gapSummary}` : ""}
    </span>
  );
}