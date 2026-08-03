// M1 — Momentum page. Momentum is rate + direction, not level: every rate is
// like-months YoY (seasonal shape cancels), the headline is nominal AND real,
// the run-rate uses the seasonal curve, and every red flag carries a size,
// entities and a start date, with a corrective link to an existing list.
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart, Line, Legend,
} from "recharts";
import { Download, TrendingUp, TrendingDown, Minus, ArrowRight, AlertTriangle } from "lucide-react";
import { useTheme } from "next-themes";
import { trunc2 } from "@/lib/trunc";
import { usePeriodMonths } from "@/data/period-months";
import { CustomTooltip } from "./shared";

type Insights = {
  meta: {
    fy: string; likeMonths: string[]; priorLikeMonths: string[];
    channelLabel: string; latestMonthNote: string | null; guards: string[];
  };
  headline: {
    nominal: { current: number; prior: number; growthPct: number | null };
    real: { index: number | null; indexName: string | null; currentReal: number | null; growthPct: number | null };
    series: { fy: string; nominalPct: number | null; realPct: number | null; index: number | null }[];
    consecutiveRealDeclines: number;
  };
  acceleration: {
    months: { month: string; yoyPct: number | null; seasonalNote: string }[];
    latestRate: number | null; previousRate: number | null;
    direction: "accelerating" | "decelerating" | "flat" | null;
  };
  runRate: {
    ytd: number; curveShareOfYear: number; curveName: string;
    projection: number | null; flatProjection: number; priorFyTotal: number | null; note: string;
  };
  pipeline: {
    months: { month: string; booking: number; dispatch: number; pending: number; pendingShare: number | null }[];
    totals: { booking: number; dispatch: number; pending: number; pendingShare: number | null };
    direction: "rising" | "falling" | "flat" | null; directionNote: string;
  };
  leading: {
    id: string; label: string; current: number | null; currentValue?: number | null;
    prior: number | null; note: string; direction: "up" | "down" | "flat" | null; href?: string;
  }[];
  redFlags: {
    id: string; rank: number; severity: "red" | "orange" | "yellow"; title: string;
    size: string; entities: string[]; since: string | null; evidence: string;
    corrective: { label: string; href: string; ease: number; easeLabel: string };
  }[];
};

const sevStyle: Record<string, string> = {
  red: "border-red-500/40 bg-red-500/5",
  orange: "border-amber-500/40 bg-amber-500/5",
  yellow: "border-yellow-400/30 bg-yellow-400/5",
};
const sevBadge: Record<string, string> = {
  red: "bg-red-500/15 text-red-600 dark:text-red-400",
  orange: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  yellow: "bg-yellow-400/15 text-yellow-700 dark:text-yellow-300",
};

function GrowthArrow({ v }: { v: number | null }) {
  if (v == null) return <Minus className="w-4 h-4 text-muted-foreground" />;
  if (v > 0.5) return <TrendingUp className="w-4 h-4 text-emerald-500" />;
  if (v < -0.5) return <TrendingDown className="w-4 h-4 text-red-500" />;
  return <Minus className="w-4 h-4 text-muted-foreground" />;
}
const fmtPct = (v: number | null) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${trunc2(v)}%`);

export default function OrderMomentum() {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const period = usePeriodMonths();
  const gridColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "#98999C" : "#71717a";

  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const monthsQ = period.active ? `?months=${encodeURIComponent(period.labels.join(","))}` : "";
  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError(null);
    fetch(`/api/momentum/insights${monthsQ}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        if (!dead) setData(j);
      })
      .catch((e) => { if (!dead) setError(e.message); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [monthsQ]);

  if (loading) return <div className="py-16 text-center text-sm text-muted-foreground">Reading rate and direction from the registers…</div>;
  if (error || !data) return <div className="py-16 text-center text-sm text-red-500">Momentum insights failed: {error}</div>;

  const h = data.headline;
  const realIsDecline = (h.real.growthPct ?? 0) < 0;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Channel label + guards + export — the channelLabel must appear on the page */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          <span className="font-medium">{data.meta.channelLabel}</span>
          {" · like months "}{data.meta.likeMonths[0]}–{data.meta.likeMonths[data.meta.likeMonths.length - 1]}
          {" vs "}{data.meta.priorLikeMonths[0]}–{data.meta.priorLikeMonths[data.meta.priorLikeMonths.length - 1]}
          {data.meta.latestMonthNote && <span className="block italic">{data.meta.latestMonthNote}</span>}
        </div>
        <a
          href={`/api/momentum-reports/export${monthsQ}`}
          download
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/40"
          data-testid="button-export-excel-momentum"
        >
          <Download className="w-3.5 h-3.5" />
          Export Excel
        </a>
      </div>

      {/* 1. HEADLINE STRIP */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className={realIsDecline ? "border-red-500/40" : "border-emerald-500/30"} data-testid="card-on-pace">
          <CardHeader className="px-5 pt-5 pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Are we on pace?</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-4">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">{fmtPct(h.nominal.growthPct)}</span>
              <span className="text-xs text-muted-foreground">nominal</span>
            </div>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className={`text-2xl font-bold ${realIsDecline ? "text-red-500" : "text-emerald-500"}`}>{fmtPct(h.real.growthPct)}</span>
              <span className="text-xs text-muted-foreground">real (index {h.real.index ?? "n/a"})</span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              ₹{trunc2(h.nominal.current)} Cr vs ₹{trunc2(h.nominal.prior)} Cr like months last year.
              {h.real.indexName && <> Real terms on {h.real.indexName}.</>}
            </p>
            <div className="mt-2 flex gap-3 text-[11px]">
              <span className="text-muted-foreground">3-yr real:</span>
              {h.series.map((s) => (
                <span key={s.fy} className={s.realPct != null && s.realPct < 0 ? "text-red-500 font-medium" : "text-emerald-600 font-medium"}>
                  {s.fy.slice(2)}: {fmtPct(s.realPct)}
                </span>
              ))}
            </div>
            {h.consecutiveRealDeclines >= 2 && (
              <p className="text-[11px] text-red-500 font-medium mt-1">
                {h.consecutiveRealDeclines} consecutive years of real decline.
              </p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-acceleration">
          <CardHeader className="px-5 pt-5 pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Accelerating or decelerating?</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-4">
            <div className="flex items-center gap-2">
              <GrowthArrow v={data.acceleration.latestRate != null && data.acceleration.previousRate != null ? data.acceleration.latestRate - data.acceleration.previousRate : null} />
              <span className="text-2xl font-bold capitalize">{data.acceleration.direction ?? "n/a"}</span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              This month's like-month growth rate {fmtPct(data.acceleration.latestRate)} vs last month's {fmtPct(data.acceleration.previousRate)} — the change in the rate, not the level.
            </p>
            <div className="mt-2 space-y-0.5">
              {data.acceleration.months.map((m) => (
                <div key={m.month} className="flex justify-between text-[11px]">
                  <span className="text-muted-foreground">{m.month}</span>
                  <span className={m.yoyPct != null && m.yoyPct < 0 ? "text-red-500" : "text-emerald-600"}>{fmtPct(m.yoyPct)} YoY</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] italic text-muted-foreground mt-1">Like month vs like month — the seasonal shape cancels by construction.</p>
          </CardContent>
        </Card>

        <Card data-testid="card-run-rate">
          <CardHeader className="px-5 pt-5 pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Run rate to year end</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-4">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">₹{data.runRate.projection != null ? trunc2(data.runRate.projection) : "n/a"} Cr</span>
              <span className="text-xs text-muted-foreground">seasonal curve</span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              YTD ₹{trunc2(data.runRate.ytd)} Cr ÷ {trunc2(data.runRate.curveShareOfYear)}% (the share of the year these months normally carry).
              A flat extrapolation would say ₹{trunc2(data.runRate.flatProjection)} Cr and {data.runRate.note.includes("UNDERSTATE") ? "understate" : "overstate"} the year.
            </p>
            <p className="text-[10px] italic text-muted-foreground mt-1">Curve: {data.runRate.curveName}.</p>
            {data.runRate.priorFyTotal != null && (
              <p className="text-[11px] text-muted-foreground mt-1">Last full year: ₹{trunc2(data.runRate.priorFyTotal)} Cr.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 3. PIPELINE PANEL */}
      <Card data-testid="card-pipeline">
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base font-semibold">
            Pipeline — pending as a share of booking
            <span className={`ml-3 text-xs font-medium px-2 py-0.5 rounded ${data.pipeline.direction === "rising" ? sevBadge.orange : "bg-muted text-muted-foreground"}`}>
              {data.pipeline.direction ?? "n/a"}
            </span>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Booking ₹{trunc2(data.pipeline.totals.booking)} Cr · dispatch ₹{trunc2(data.pipeline.totals.dispatch)} Cr · pending ₹{trunc2(data.pipeline.totals.pending)} Cr
            {data.pipeline.totals.pendingShare != null && <> = {trunc2(data.pipeline.totals.pendingShare)}% of booking</>}
            {" — "}{data.pipeline.directionNote}
          </p>
        </CardHeader>
        <CardContent className="px-2 sm:px-5 pb-5 pt-2">
          <ResponsiveContainer width="100%" height={280} debounce={0}>
            <ComposedChart data={data.pipeline.months} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: tickColor }} dy={10} />
              <YAxis yAxisId="cr" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: tickColor }} tickFormatter={(v) => `₹${v}Cr`} />
              <YAxis yAxisId="pct" orientation="right" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: tickColor }} tickFormatter={(v) => `${v}%`} />
              <Tooltip content={<CustomTooltip />} isAnimationActive={false} cursor={{ fill: gridColor }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="cr" dataKey="booking" name="Booking (Cr)" fill="#8b5cf6" fillOpacity={0.8} radius={[4, 4, 0, 0]} barSize={22} isAnimationActive={false} />
              <Bar yAxisId="cr" dataKey="dispatch" name="Dispatch (Cr)" fill="#3b82f6" fillOpacity={0.8} radius={[4, 4, 0, 0]} barSize={22} isAnimationActive={false} />
              <Line yAxisId="pct" dataKey="pendingShare" name="Pending share (%)" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* 4. LEADING INDICATORS */}
      <div>
        <h3 className="text-sm font-semibold mb-2">Leading indicators <span className="text-xs font-normal text-muted-foreground">— these move before revenue does</span></h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.leading.map((l) => (
            <Card key={l.id} data-testid={`card-leading-${l.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium">{l.label}</span>
                  <GrowthArrow v={l.direction === "up" ? 1 : l.direction === "down" ? -1 : l.direction === "flat" ? 0 : null} />
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-bold">{l.current != null ? (l.id === "effectiveDiscount" ? `${trunc2(l.current)}%` : l.current.toLocaleString("en-IN")) : "not recorded"}</span>
                  {l.currentValue != null && <span className="text-xs text-muted-foreground">₹{trunc2(l.currentValue)} Cr</span>}
                  {l.prior != null && <span className="text-xs text-muted-foreground">was {trunc2(l.prior)}%</span>}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">{l.note}</p>
                {l.href && (
                  <Link href={l.href} className="text-[11px] text-primary inline-flex items-center gap-1 mt-1 hover:underline">
                    open the list <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* 5. RED FLAGS — ranked, sized, with corrective links */}
      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          Red flags <span className="text-xs font-normal text-muted-foreground">— ranked by severity; every flag states what, how big, who and since when</span>
        </h3>
        {data.redFlags.length === 0 && (
          <p className="text-sm text-muted-foreground">No flags fire on the current period.</p>
        )}
        <div className="space-y-3">
          {data.redFlags.map((f) => (
            <Card key={f.id} className={sevStyle[f.severity]} data-testid={`card-flag-${f.id}`}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${sevBadge[f.severity]}`}>#{f.rank} {f.severity.toUpperCase()}</span>
                  <span className="text-sm font-semibold">{f.title}</span>
                  {f.since && <span className="text-[11px] text-muted-foreground">since {f.since}</span>}
                </div>
                <p className="text-sm mt-1 font-medium">{f.size}</p>
                {f.entities.length > 0 && f.entities[0] !== "company" && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {f.entities.join(" · ")}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground mt-1 italic">{f.evidence}</p>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Fix it with:</span>
                  <Link href={f.corrective.href} className="text-primary font-medium inline-flex items-center gap-1 hover:underline">
                    {f.corrective.label} <ArrowRight className="w-3 h-3" />
                  </Link>
                  <span className="text-[10px] text-muted-foreground">({f.corrective.easeLabel})</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">
          Corrective measures are ranked by ease, not by size of prize — range depth inside a segment already bought is the cheapest thing anyone can do.
        </p>
      </div>

      {/* Guards footnote */}
      <div className="text-[10px] text-muted-foreground border-t border-border pt-3 space-y-0.5">
        {data.meta.guards.map((g, i) => <div key={i}>• {g}</div>)}
      </div>
    </div>
  );
}
