import { useMemo, useState } from "react";
import {
  useGetMgmtOptions,
  getGetMgmtOptionsQueryKey,
  useGenerateMgmtReport,
  useVerifyMgmtReport,
  getVerifyMgmtReportQueryKey,
  type MgmtSourceStatus,
  type MgmtVerifyCheck,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { QuotaWaitBanner } from "./quotaWait";
import { isQuotaWaitError, quotaRetryDelayMs } from "@/data/dashboard-context";
import { useGlobalFilter } from "@/data/global-filter-context";
import {
  FileSpreadsheet,
  Download,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ShieldCheck,
} from "lucide-react";

const FISCAL_MONTHS = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
];

function SourceBadge({ source }: { source: MgmtSourceStatus }) {
  const Icon =
    source.status === "connected"
      ? CheckCircle2
      : source.status === "partial"
        ? AlertTriangle
        : XCircle;
  const color =
    source.status === "connected"
      ? "text-green-600 dark:text-green-400"
      : source.status === "partial"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border border-border/50 bg-background/50">
      <Icon className={cn("w-4 h-4 mt-0.5 shrink-0", color)} />
      <div className="min-w-0">
        <p className="text-sm font-medium">{source.name}</p>
        <p className="text-xs text-muted-foreground">{source.detail}</p>
      </div>
    </div>
  );
}

function formatCr(rupees: number): string {
  return `${(rupees / 1e7).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} Cr`;
}

function CheckChip({ status }: { status: MgmtVerifyCheck["status"] }) {
  const map = {
    pass: {
      Icon: CheckCircle2,
      cls: "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/30",
      label: "Pass",
    },
    warn: {
      Icon: AlertTriangle,
      cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30",
      label: "Warn",
    },
    fail: {
      Icon: XCircle,
      cls: "text-destructive bg-destructive/10 border-destructive/30",
      label: "Fail",
    },
  } as const;
  const { Icon, cls, label } = map[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border shrink-0",
        cls,
      )}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

function CheckRow({ check }: { check: MgmtVerifyCheck }) {
  const fmt = (v: number) =>
    check.unit === "money" ? formatCr(v) : v.toLocaleString("en-IN");
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-border/40 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{check.label}</p>
        <p className="text-xs text-muted-foreground">
          App {fmt(check.actual)} · Expected {fmt(check.expected)}
          {check.deltaPct != null && (
            <>
              {" "}
              · Δ {check.deltaPct > 0 ? "+" : ""}
              {check.deltaPct}%
            </>
          )}
        </p>
      </div>
      <CheckChip status={check.status} />
    </div>
  );
}

export default function MgmtReports() {
  // Auto-recover from the ~60s Sheets quota window: keep retrying quota 503s
  // (the banner explains the wait); other errors retry twice.
  const options = useGetMgmtOptions({
    query: {
      queryKey: getGetMgmtOptionsQueryKey(),
      retry: (failureCount, error) =>
        isQuotaWaitError(error) ? failureCount < 10 : failureCount < 2,
      retryDelay: (failureCount, error) =>
        isQuotaWaitError(error)
          ? quotaRetryDelayMs(error)
          : Math.min(30_000, 1000 * 2 ** failureCount),
    },
  });
  const report = useGenerateMgmtReport();
  const { fy: globalFy } = useGlobalFilter();
  const [fy, setFy] = useState<string | null>(null);
  const [regions, setRegions] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<Set<string>>(new Set());
  const [monthFrom, setMonthFrom] = useState(1);
  const [monthTo, setMonthTo] = useState(12);
  // Unified low-performer threshold: 50% across all pages (dashboard filter,
  // workbook generator, and the "below 50%" achievement band boundary).
  const [lowPerfPct, setLowPerfPct] = useState(50);
  const [error, setError] = useState<string | null>(null);

  const data = options.data;
  // Follow the global FY filter by default; the local selector is an explicit
  // override (labelled below) so two selectors on screen can't silently disagree.
  const effectiveFy =
    fy ?? (data?.fys?.includes(globalFy) ? globalFy : undefined) ?? data?.defaultFy ?? "2026-27";
  const isOverride = fy !== null && fy !== globalFy;

  const verify = useVerifyMgmtReport(
    { fy: effectiveFy },
    {
      query: {
        retry: false,
        queryKey: getVerifyMgmtReportQueryKey({ fy: effectiveFy }),
      },
    },
  );

  const regionStates = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const r of data?.regions ?? []) map.set(r.name, r.states);
    return map;
  }, [data]);

  const toggleRegion = (name: string) => {
    setRegions((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleState = (name: string) => {
    setStates((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const coveredByRegion = useMemo(() => {
    const set = new Set<string>();
    for (const r of regions) {
      for (const s of regionStates.get(r) ?? []) set.add(s.toLowerCase());
    }
    return set;
  }, [regions, regionStates]);

  const scopeSummary =
    regions.size === 0 && states.size === 0
      ? "All states"
      : [...regions, ...states].join(", ");

  const generate = async () => {
    setError(null);
    try {
      const blob = await report.mutateAsync({
        data: {
          fy: effectiveFy,
          regions: [...regions],
          states: [...states],
          monthFrom,
          monthTo,
          lowPerfPct,
        },
      });
      const scope =
        regions.size > 0
          ? [...regions].join("-")
          : states.size > 0
            ? "Custom"
            : "All";
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `StateHeadDashboard_${effectiveFy}_${scope}_${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const msg =
        e && typeof e === "object" && "data" in e &&
        e.data && typeof e.data === "object" && "error" in e.data &&
        typeof (e.data as { error?: unknown }).error === "string"
          ? (e.data as { error: string }).error
          : "Could not generate the report. Please try again in a minute.";
      setError(msg);
    }
  };

  // While the Sheets quota window is open, react-query keeps retrying in the
  // background (see the retry config above) — show the friendly amber notice
  // instead of a spinner or a red error.
  if (isQuotaWaitError(options.failureReason) || isQuotaWaitError(options.error)) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <QuotaWaitBanner testId="banner-quota-wait-reports" />
      </div>
    );
  }

  if (options.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading report options
      </div>
    );
  }

  if (options.isError || !data) {
    return (
      <div className="py-24 text-center text-sm text-destructive">
        Could not load report options. Please refresh the page.
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-xl flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-primary" />
            State Head Dashboard Report
          </CardTitle>
          <CardDescription>
            Generates the STATE HEAD DASHBOARD Excel workbook from live Google
            Sheets. Columns whose source is not connected yet stay blank with a
            grey fill and are listed in the Missing Data tab, so a blank never
            reads as a zero.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6 space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="text-sm font-medium block mb-1.5">
                Fiscal year
                {isOverride && (
                  <span className="ml-2 text-[11px] font-normal text-amber-600">
                    override — global filter is {globalFy}
                  </span>
                )}
              </label>
              <select
                value={effectiveFy}
                onChange={(e) => setFy(e.target.value)}
                className="w-full h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
              >
                {data.fys.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1.5">From month</label>
              <select
                value={monthFrom}
                onChange={(e) => setMonthFrom(Number(e.target.value))}
                className="w-full h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
              >
                {FISCAL_MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1.5">To month</label>
              <select
                value={monthTo}
                onChange={(e) => setMonthTo(Number(e.target.value))}
                className="w-full h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
              >
                {FISCAL_MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium block mb-1.5">Regions</label>
            <div className="flex flex-wrap gap-2">
              {data.regions.map((r) => (
                <button
                  key={r.name}
                  onClick={() => toggleRegion(r.name)}
                  className={cn(
                    "px-3 py-1.5 rounded-full text-sm font-medium border transition-colors",
                    regions.has(r.name)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border/50 text-muted-foreground hover:bg-muted",
                  )}
                >
                  {r.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium block mb-1.5">
              States <span className="text-xs text-muted-foreground font-normal">(optional, adds to regions)</span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {data.states.map((s) => {
                const viaRegion = coveredByRegion.has(s.toLowerCase());
                const active = states.has(s) || viaRegion;
                return (
                  <button
                    key={s}
                    onClick={() => !viaRegion && toggleState(s)}
                    disabled={viaRegion}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                      active
                        ? viaRegion
                          ? "bg-primary/15 text-primary border-primary/30 cursor-default"
                          : "bg-primary text-primary-foreground border-primary"
                        : "border-border/50 text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 items-end">
            <div>
              <label className="text-sm font-medium block mb-1.5">
                Low performer threshold (% achievement)
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={lowPerfPct}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setLowPerfPct(Math.min(100, Math.max(1, Math.round(n))));
                }}
                className="w-full h-9 rounded-md border border-border/50 bg-background px-2 text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Flags members below this achievement percent once targets are connected.
              </p>
            </div>
            <div className="text-sm text-muted-foreground sm:text-right">
              Scope: <span className="font-medium text-foreground">{scopeSummary}</span>
            </div>
          </div>

          {error && (
            <div className="text-sm text-destructive border border-destructive/30 rounded-md p-3">
              {error}
            </div>
          )}

          <button
            onClick={generate}
            disabled={report.isPending}
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {report.isPending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generating (first run can take a minute or two)
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Generate and Download Excel
              </>
            )}
          </button>
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Data health
          </CardTitle>
          <CardDescription>
            Reconciles the computed {effectiveFy} report against the signed-off
            dashboard figures. A failed check blocks a final export.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          {verify.isLoading ? (
            <div className="flex items-center py-6 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Reconciling {effectiveFy}
            </div>
          ) : verify.isError || !verify.data?.available ? (
            <div className="text-sm text-muted-foreground border border-border/50 rounded-md p-3">
              {verify.data?.reason ??
                `No verification anchors are configured for ${effectiveFy}. Data health checks run for years with a signed-off dashboard (e.g. 2025-26).`}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Overall</span>
                <CheckChip status={verify.data.overall} />
                <button
                  onClick={() => verify.refetch()}
                  disabled={verify.isFetching}
                  className="ml-auto text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  {verify.isFetching ? "Refreshing…" : "Re-run"}
                </button>
              </div>
              {verify.data.missingHeads.length > 0 && (
                <div className="text-xs text-destructive border border-destructive/30 rounded-md p-2">
                  Missing from output (computed to zero):{" "}
                  {verify.data.missingHeads.join(", ")}
                </div>
              )}
              <div className="rounded-lg border border-border/50 bg-background/50 px-3">
                {verify.data.checks.map((c) => (
                  <CheckRow key={c.key} check={c} />
                ))}
              </div>
              {verify.data.context && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                    <p className="text-xs text-muted-foreground">Retailers</p>
                    <p className="text-sm font-medium">
                      {verify.data.context.activeRetailers.toLocaleString("en-IN")} active
                      {verify.data.context.registeredRetailers != null && (
                        <>
                          {" / "}
                          {verify.data.context.registeredRetailers.toLocaleString("en-IN")} registered
                        </>
                      )}
                    </p>
                    {verify.data.context.activeRetailerPct != null && (
                      <p className="text-xs text-muted-foreground">
                        Active {verify.data.context.activeRetailerPct}%
                      </p>
                    )}
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                    <p className="text-xs text-muted-foreground">Members</p>
                    <p className="text-sm font-medium">
                      {verify.data.context.activeMembers.toLocaleString("en-IN")} active /{" "}
                      {verify.data.context.registeredMembers.toLocaleString("en-IN")} registered
                    </p>
                    {verify.data.context.activeMemberPct != null && (
                      <p className="text-xs text-muted-foreground">
                        Active {verify.data.context.activeMemberPct}%
                      </p>
                    )}
                  </div>
                  {verify.data.context.unmatchedNames > 0 && (
                    <div className="col-span-2 text-xs text-muted-foreground border border-border/50 rounded-md p-2">
                      {verify.data.context.unmatchedNames} order-booking name
                      {verify.data.context.unmatchedNames === 1 ? "" : "s"} did not match the
                      roster, carrying {formatCr(verify.data.context.unmatchedSale)} of net Sale
                      that is counted in the company total but not attributed to a member or head.
                    </div>
                  )}
                </div>
              )}
              {verify.data.crossFoot && (
                <div className="flex items-start gap-2 text-xs text-muted-foreground">
                  {verify.data.crossFoot.withinTolerance ? (
                    <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-green-600 dark:text-green-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 mt-0.5 text-destructive shrink-0" />
                  )}
                  <span>
                    Cross-foot: member split {formatCr(verify.data.crossFoot.memberSaleTotal)},
                    head split {formatCr(verify.data.crossFoot.headSaleTotal)}, company total{" "}
                    {formatCr(verify.data.crossFoot.companyTotal)}
                    {verify.data.crossFoot.withinTolerance
                      ? " agree."
                      : " do not agree."}
                  </span>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="px-6 pt-6 pb-4">
          <CardTitle className="text-base">Data sources</CardTitle>
          <CardDescription>
            What feeds this report today, and what is still needed to fill the
            remaining columns.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <div className="grid gap-3">
            {data.sources.map((s) => (
              <SourceBadge key={s.key} source={s} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
