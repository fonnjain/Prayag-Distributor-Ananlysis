import { useMemo, useState } from "react";
import {
  useGetMgmtOptions,
  useGenerateMgmtReport,
  type MgmtSourceStatus,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  FileSpreadsheet,
  Download,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
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

export default function MgmtReports() {
  const options = useGetMgmtOptions();
  const report = useGenerateMgmtReport();
  const [fy, setFy] = useState<string | null>(null);
  const [regions, setRegions] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<Set<string>>(new Set());
  const [monthFrom, setMonthFrom] = useState(1);
  const [monthTo, setMonthTo] = useState(12);
  const [lowPerfPct, setLowPerfPct] = useState(60);
  const [error, setError] = useState<string | null>(null);

  const data = options.data;
  const effectiveFy = fy ?? data?.defaultFy ?? "2026-27";

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
              <label className="text-sm font-medium block mb-1.5">Fiscal year</label>
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
