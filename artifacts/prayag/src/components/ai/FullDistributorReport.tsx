// Renderer for the full structured distributor report (10 sections).
// Every number was pre-computed by the server; this component only displays.
import { trunc2 } from "@/lib/trunc";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle, XCircle, Info } from "lucide-react";

// ── Types (mirrors aiFullReport.ts response) ─────────────────────────────────

type LeverPriority = "High" | "Medium" | "Low" | "None";

type Lever = {
  name: string;
  priority: LeverPriority;
  position: string;
  dataContext: string;
};

type SegmentRow = {
  segment: string;
  net: number | null;
  sharePct: number | null;
  codesBought: number | null;
  peerMedianCodes: number | null;
  gap: number | null;
};

type LostCode = { code: string; segment: string; priorNet: number | null };

type TierInput = { label: string; value: string; score: number; note: string };

type YoyDispatch = {
  current: number | null;
  prior: number | null;
  period: string;
  growthPct: number | null;
};

export type FullDistributorReportData = {
  type: "full-distributor-report";
  fy: string;
  stateHead: string;
  distributor: string;
  normKey: string;
  periodLabel: string;
  priorPeriodLabel: string;
  monthFrom: number;
  monthTo: number;
  dataCutoff: string;
  generatedAt: string;
  headline: {
    periodLabel: string;
    priorPeriodLabel: string;
    net: number | null;
    qty: number | null;
    codesBought: number | null;
    realisedPerPiece: number | null;
    priorNet: number | null;
    priorQty: number | null;
    priorCodesBought: number | null;
    priorRealisedPerPiece: number | null;
    activeRetailers: number | null;
    activeRetailersSource: string;
    priorActiveRetailersSource: string;
    netDelta: number | null;
    netDeltaPct: number | null;
  };
  levers: Lever[];
  reach: {
    periodLabel: string;
    retailersOnBook: number | null;
    retailersOnBookSource: string;
    active: number | null;
    activeSource: string;
    dormant: number | null;
    activationPct: number | null;
    top5RetailerSharePct: number | null;
    effectiveRetailers: number | null;
    unassignedNote: string;
  };
  range: {
    excludesProject: true;
    excludesProjectNote: string;
    periodLabel: string;
    segments: SegmentRow[];
    peerCount: number | null;
    rank: number | null;
    rankOutOf: number | null;
    rankNote: string;
    recommendations: { rank: number; code: string; segment: string; peersBuying: number | null; peerMedianQtrNet: number | null }[];
  };
  recovery: {
    periodLabel: string;
    atRiskCount: number | null;
    atRiskCountSource: string;
    atRiskPriorYearValue: number | null;
    atRiskPriorYearValueNote: string;
    lostCodes: LostCode[];
    reactivatedCount: number | null;
    reactivatedNote: string;
  };
  rhythm: {
    periodLabel: string;
    priorPeriodLabel: string;
    hasPrimaryData: boolean;
    ordersThisPeriod: number | null;
    ordersPerMonth: number | null;
    daysSinceLastOrder: number | null;
    lastOrderDate: string | null;
    priorNote: string;
    yoyDispatch: YoyDispatch | null;
  };
  scheme: {
    quarter: string | null;
    deadline: string | null;
    billedSoFar: number | null;
    currentSlab: number | null;
    currentRate: number | null;
    nextSlab: number | null;
    nextRate: number | null;
    gap: number | null;
    extraEarn: number | null;
    extraRoi: number | null;
    extraEarnNewPurchase: number | null;
    extraEarnRePricing: number | null;
    status: string | null;
    blockedReason: string | null;
    unavailableReason: string | null;
  };
  tier: {
    tier: "A" | "B" | "C" | null;
    score: number | null;
    inputs: TierInput[];
    recommendedCadence: string | null;
    isOverridden: boolean;
    overrideReason: string | null;
    unavailableReason: string | null;
  };
  whatToDo: {
    thisWeek: string[];
    visitPlan: string;
  };
  notAvailable: { items: { item: string; reason: string }[] };
  guard: { status: "ok" | "requires_review"; unmatched: unknown[]; checked: number };
};

// ── Layout helpers ────────────────────────────────────────────────────────────

function Section({ n, title, period, children }: {
  n: number; title: string; period: string; children: React.ReactNode;
}) {
  return (
    <div className="mb-8 break-inside-avoid-page">
      <div className="flex items-baseline gap-3 mb-2 border-b pb-1">
        <span className="text-xs font-mono text-muted-foreground w-5">{n}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="ml-auto text-[10px] text-muted-foreground">{period}</span>
      </div>
      {children}
    </div>
  );
}

function Row({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="flex gap-2 py-0.5 text-[11px]">
      <span className="text-muted-foreground w-44 shrink-0">{label}</span>
      <span className="font-medium">{value ?? <span className="text-muted-foreground italic">—</span>}</span>
      {note && <span className="text-muted-foreground text-[10px] ml-1">({note})</span>}
    </div>
  );
}

function Cr(v: number | null) {
  if (v == null) return "not recorded";
  return `₹${trunc2(v / 1e7)} Cr`;
}

function Lk(v: number | null) {
  if (v == null) return "not recorded";
  return `₹${trunc2(v / 1e5)} L`;
}

function priorityBadge(p: LeverPriority) {
  const cls: Record<LeverPriority, string> = {
    High:   "bg-red-100   text-red-800   dark:bg-red-900/40   dark:text-red-300",
    Medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    Low:    "bg-blue-100  text-blue-800  dark:bg-blue-900/40  dark:text-blue-300",
    None:   "bg-muted     text-muted-foreground",
  };
  return <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold", cls[p])}>{p}</span>;
}

function tierBadge(t: "A" | "B" | "C" | null) {
  if (!t) return null;
  const cls = { A: "bg-emerald-100 text-emerald-800", B: "bg-amber-100 text-amber-800", C: "bg-red-100 text-red-800" };
  return <span className={cn("px-2 py-0.5 rounded text-sm font-bold", cls[t])}>{t}</span>;
}

function Note({ text }: { text: string }) {
  return (
    <p className="text-[10px] text-muted-foreground italic mt-1 flex gap-1">
      <Info className="h-3 w-3 shrink-0 mt-0.5" />{text}
    </p>
  );
}

function GuardBanner({ guard }: { guard: FullDistributorReportData["guard"] }) {
  if (guard.status === "ok") return (
    <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400 mb-4">
      <CheckCircle className="h-3.5 w-3.5" />
      Numeric guard passed — {guard.checked} figures verified.
    </div>
  );
  return (
    <div className="mb-4 rounded border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
      <div className="flex items-center gap-1.5 font-semibold mb-1">
        <AlertTriangle className="h-3.5 w-3.5" /> Numeric guard: {guard.status}
      </div>
      {(guard.unmatched as { extracted: string; sentence: string }[]).slice(0, 3).map((u, i) => (
        <p key={i}>{u.extracted} — "{u.sentence.slice(0, 80)}"</p>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FullDistributorReport({ data }: { data: FullDistributorReportData }) {
  const { headline, levers, reach, range, recovery, rhythm, scheme, tier, whatToDo, notAvailable, guard } = data;

  return (
    <div className="text-sm max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6 pb-3 border-b">
        <h1 className="text-base font-semibold">{data.distributor}</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Distributor Report · {data.stateHead} · FY {data.fy} · {data.periodLabel}
        </p>
        <p className="text-[10px] text-muted-foreground">
          Data cutoff: {data.dataCutoff} · Generated: {new Date(data.generatedAt).toLocaleString()}
        </p>
      </div>

      <GuardBanner guard={guard} />

      {/* §1 Headline */}
      <Section n={1} title="Headline" period={`${headline.periodLabel} vs ${headline.priorPeriodLabel}`}>
        <div className="grid grid-cols-2 gap-x-8">
          {/* Current period */}
          <div>
            <p className="text-[10px] font-medium text-muted-foreground mb-1">{headline.periodLabel}</p>
            <Row label="Net sales"         value={Cr(headline.net)} />
            <Row label="Quantity"          value={headline.qty != null ? `${headline.qty.toLocaleString("en-IN")} pcs` : "not recorded"} />
            <Row label="Realised per piece" value={headline.realisedPerPiece != null ? `₹${headline.realisedPerPiece.toFixed(2)}` : "not recorded"} />
            <Row label="Codes bought"      value={headline.codesBought != null ? headline.codesBought : "not recorded"} />
            <Row label="Active retailers"  value={headline.activeRetailers != null ? headline.activeRetailers : "not recorded"}
                  note={headline.activeRetailersSource} />
          </div>
          {/* Prior period */}
          <div>
            <p className="text-[10px] font-medium text-muted-foreground mb-1">{headline.priorPeriodLabel}</p>
            <Row label="Net sales"         value={Cr(headline.priorNet)} />
            <Row label="Quantity"          value={headline.priorQty != null ? `${headline.priorQty.toLocaleString("en-IN")} pcs` : "not recorded"} />
            <Row label="Realised per piece" value={headline.priorRealisedPerPiece != null ? `₹${headline.priorRealisedPerPiece.toFixed(2)}` : "not recorded"} />
            <Row label="Codes bought"      value={headline.priorCodesBought != null ? headline.priorCodesBought : "not recorded"} />
            <Row label="Active retailers"  value="not recorded" note={headline.priorActiveRetailersSource} />
          </div>
        </div>
        {headline.netDelta != null && (
          <div className="mt-2 flex gap-4 text-[11px]">
            <span>Change: {headline.netDelta > 0 ? "+" : ""}{Lk(headline.netDelta)}</span>
            {headline.netDeltaPct != null && (
              <span className={headline.netDeltaPct >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}>
                {headline.netDeltaPct > 0 ? "+" : ""}{headline.netDeltaPct.toFixed(2)}%
              </span>
            )}
          </div>
        )}
      </Section>

      {/* §2 Five Levers */}
      <Section n={2} title="Five Levers" period={data.periodLabel}>
        {levers.length === 0 && <p className="text-[11px] text-muted-foreground italic">Not generated.</p>}
        <div className="space-y-2">
          {levers.map((lv) => (
            <div key={lv.name} className="flex gap-3 items-start py-1 border-b border-muted last:border-0">
              <span className="w-20 text-[11px] font-medium shrink-0">{lv.name}</span>
              {priorityBadge(lv.priority as LeverPriority)}
              <p className="text-[11px] text-muted-foreground flex-1">{lv.position}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* §3 Reach */}
      <Section n={3} title="Reach" period={reach.periodLabel}>
        <Row label="Retailers on book"     value={reach.retailersOnBook != null ? reach.retailersOnBook : "not recorded"} note={reach.retailersOnBookSource} />
        <Row label="Active"                value={reach.active   != null ? reach.active   : "not recorded"} note={reach.activeSource} />
        <Row label="Dormant"               value={reach.dormant  != null ? reach.dormant  : "not recorded"} />
        <Row label="Activation %"          value={reach.activationPct != null ? `${reach.activationPct.toFixed(2)}%` : "not recorded"} />
        <Row label="Top-5 retailer share"  value={reach.top5RetailerSharePct != null ? `${reach.top5RetailerSharePct.toFixed(2)}%` : "not recorded"} />
        <Row label="Effective retailers"   value={reach.effectiveRetailers != null ? reach.effectiveRetailers.toFixed(1) : "not recorded"} />
        <Note text={reach.unassignedNote} />
      </Section>

      {/* §4 Range */}
      <Section n={4} title="Range" period={range.periodLabel}>
        <p className="text-[10px] text-muted-foreground mb-2 italic">{range.excludesProjectNote}</p>
        {range.segments.length > 0 ? (
          <table className="w-full text-[11px] mb-3">
            <thead>
              <tr className="border-b text-muted-foreground text-left">
                <th className="pb-1 font-medium">Segment</th>
                <th className="pb-1 font-medium text-right">Net</th>
                <th className="pb-1 font-medium text-right">Share</th>
                <th className="pb-1 font-medium text-right">Codes</th>
                <th className="pb-1 font-medium text-right">Peer median</th>
                <th className="pb-1 font-medium text-right">Gap</th>
              </tr>
            </thead>
            <tbody>
              {range.segments.map(s => (
                <tr key={s.segment} className="border-b border-muted/40">
                  <td className="py-0.5">{s.segment}</td>
                  <td className="py-0.5 text-right">{Lk(s.net)}</td>
                  <td className="py-0.5 text-right">{s.sharePct != null ? `${s.sharePct.toFixed(1)}%` : "—"}</td>
                  <td className="py-0.5 text-right">{s.codesBought ?? "—"}</td>
                  <td className="py-0.5 text-right">{s.peerMedianCodes != null ? s.peerMedianCodes.toFixed(1) : "—"}</td>
                  <td className={cn("py-0.5 text-right", s.gap != null && s.gap > 0 ? "text-amber-700 dark:text-amber-400" : "")}>
                    {s.gap != null ? (s.gap > 0 ? `+${s.gap.toFixed(1)}` : s.gap.toFixed(1)) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-[11px] text-muted-foreground italic">No range data available for this period.</p>}
        {range.peerCount != null && (
          <p className="text-[10px] text-muted-foreground">Peer group: {range.peerCount} distributors in the territory (company-wide median).</p>
        )}
        <Note text={range.rankNote} />
      </Section>

      {/* §5 Recovery */}
      <Section n={5} title="Recovery" period={recovery.periodLabel}>
        <Row label="At-risk retailers"      value={recovery.atRiskCount != null ? recovery.atRiskCount : "not recorded"} note={recovery.atRiskCountSource} />
        <Row label="At-risk prior-year value" value="not recorded" note={recovery.atRiskPriorYearValueNote} />
        <Row label="Reactivated"            value="not recorded" note={recovery.reactivatedNote} />
        {recovery.lostCodes.length > 0 && (
          <div className="mt-2">
            <p className="text-[10px] font-medium text-muted-foreground mb-1">Lost codes — bought in {data.fy === "2026-27" ? "2025-26" : "prior FY"}, absent this period</p>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b text-muted-foreground text-left">
                  <th className="pb-1 font-medium">Code</th>
                  <th className="pb-1 font-medium">Segment</th>
                  <th className="pb-1 font-medium text-right">Prior net</th>
                </tr>
              </thead>
              <tbody>
                {recovery.lostCodes.slice(0, 10).map((c, i) => (
                  <tr key={i} className="border-b border-muted/40">
                    <td className="py-0.5 font-mono text-[10px]">{c.code}</td>
                    <td className="py-0.5">{c.segment}</td>
                    <td className="py-0.5 text-right">{Lk(c.priorNet)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {recovery.lostCodes.length > 10 && (
              <p className="text-[10px] text-muted-foreground mt-1">+{recovery.lostCodes.length - 10} more not shown.</p>
            )}
          </div>
        )}
        {recovery.lostCodes.length === 0 && (
          <p className="text-[11px] text-muted-foreground italic mt-2">No lost codes detected for this period.</p>
        )}
      </Section>

      {/* §6 Rhythm */}
      <Section n={6} title="Rhythm" period={`${rhythm.periodLabel} / ${rhythm.priorPeriodLabel}`}>
        {!rhythm.hasPrimaryData && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 mb-2">No primary dispatch data matched for this distributor — rhythm figures are not available.</p>
        )}
        <Row label="Orders this period"    value={rhythm.ordersThisPeriod != null ? rhythm.ordersThisPeriod : "not recorded"} />
        <Row label="Orders per month"      value={rhythm.ordersPerMonth != null ? rhythm.ordersPerMonth.toFixed(2) : "not recorded"} />
        <Row label="Days since last order" value={rhythm.daysSinceLastOrder != null ? `${rhythm.daysSinceLastOrder} days` : "not recorded"} />
        <Row label="Last order date"       value={rhythm.lastOrderDate ?? "not recorded"} />
        {rhythm.yoyDispatch && (
          <>
            <div className="mt-2 border-t pt-2">
              <p className="text-[10px] font-medium text-muted-foreground mb-1">Year-on-year dispatch · {rhythm.yoyDispatch.period}</p>
              <Row label={`${data.fy}`}          value={Cr(rhythm.yoyDispatch.current)} />
              <Row label={`Prior FY`}            value={Cr(rhythm.yoyDispatch.prior)} />
              <Row label="Growth"                value={rhythm.yoyDispatch.growthPct != null
                ? `${rhythm.yoyDispatch.growthPct.toFixed(2)}%` : "not recorded"} />
            </div>
          </>
        )}
        <Note text={rhythm.priorNote} />
      </Section>

      {/* §7 Scheme */}
      <Section n={7} title="Scheme" period={scheme.quarter ?? data.fy}>
        {scheme.unavailableReason ? (
          <p className="text-[11px] text-muted-foreground italic">{scheme.unavailableReason}</p>
        ) : (
          <>
            {scheme.status === "BLOCKED" && (
              <div className="flex items-center gap-1.5 text-[11px] text-red-700 dark:text-red-400 mb-2">
                <XCircle className="h-3.5 w-3.5" />
                Blocked — {scheme.blockedReason ?? "overdue bills"}
              </div>
            )}
            <Row label="Quarter"           value={scheme.quarter ?? "—"} />
            <Row label="Deadline"          value={scheme.deadline ?? "not recorded"} />
            <Row label="Billed so far"     value={Cr(scheme.billedSoFar)} />
            <Row label="Current slab"      value={scheme.currentSlab != null ? Cr(scheme.currentSlab) : "below first slab"} />
            <Row label="Current rate"      value={scheme.currentRate != null ? `${scheme.currentRate.toFixed(2)}%` : "—"} />
            <Row label="Next slab"         value={scheme.nextSlab != null ? Cr(scheme.nextSlab) : "at maximum"} />
            <Row label="Next rate"         value={scheme.nextRate != null ? `${scheme.nextRate.toFixed(2)}%` : "—"} />
            <Row label="Gap to next slab"  value={Cr(scheme.gap)} />
            <Row label="Extra Earn"        value={Lk(scheme.extraEarn)} />
            <Row label="Extra ROI"         value={scheme.extraRoi != null ? `${scheme.extraRoi.toFixed(2)}%` : "not recorded"} />
            {(scheme.extraEarnNewPurchase != null || scheme.extraEarnRePricing != null) && (
              <div className="mt-2 border-t pt-2">
                <p className="text-[10px] font-medium text-muted-foreground mb-1">Extra Earn split</p>
                <Row label="New-purchase component"
                     value={Lk(scheme.extraEarnNewPurchase)}
                     note="gap × next rate — earn on incremental billing" />
                <Row label="Re-pricing component"
                     value={Lk(scheme.extraEarnRePricing)}
                     note="(next rate − current rate) × billed so far" />
              </div>
            )}
          </>
        )}
      </Section>

      {/* §8 Tier */}
      <Section n={8} title="Tier" period={data.fy}>
        {tier.unavailableReason ? (
          <p className="text-[11px] text-muted-foreground italic">{tier.unavailableReason}</p>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3">
              {tierBadge(tier.tier)}
              <span className="text-sm font-medium">Score: {tier.score ?? "—"}</span>
              {tier.isOverridden && (
                <span className="text-[10px] text-amber-700 dark:text-amber-400">(overridden: {tier.overrideReason})</span>
              )}
            </div>
            {tier.inputs.length > 0 && (
              <table className="w-full text-[11px] mb-3">
                <thead>
                  <tr className="border-b text-muted-foreground text-left">
                    <th className="pb-1 font-medium">Component</th>
                    <th className="pb-1 font-medium text-right">Value</th>
                    <th className="pb-1 font-medium text-right">Score</th>
                    <th className="pb-1 font-medium">Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {tier.inputs.map((inp, i) => (
                    <tr key={i} className="border-b border-muted/40">
                      <td className="py-0.5">{inp.label}</td>
                      <td className="py-0.5 text-right">{inp.value}</td>
                      <td className="py-0.5 text-right">{inp.score}</td>
                      <td className="py-0.5 text-muted-foreground text-[10px]">{inp.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <Row label="Recommended cadence" value={tier.recommendedCadence ?? "not recorded"} />
          </>
        )}
      </Section>

      {/* §9 What to do */}
      <Section n={9} title="What to Do" period={data.periodLabel}>
        {whatToDo.thisWeek.length > 0 && (
          <div className="mb-3">
            <p className="text-[10px] font-medium text-muted-foreground mb-1">This week</p>
            <ol className="list-decimal list-inside space-y-1">
              {whatToDo.thisWeek.map((a, i) => (
                <li key={i} className="text-[11px]">{a}</li>
              ))}
            </ol>
          </div>
        )}
        {whatToDo.visitPlan && (
          <div>
            <p className="text-[10px] font-medium text-muted-foreground mb-1">Visit plan</p>
            <p className="text-[11px]">{whatToDo.visitPlan}</p>
          </div>
        )}
        {whatToDo.thisWeek.length === 0 && !whatToDo.visitPlan && (
          <p className="text-[11px] text-muted-foreground italic">Not generated.</p>
        )}
      </Section>

      {/* §10 Not available */}
      <Section n={10} title="Not Available" period="">
        <div className="space-y-1">
          {notAvailable.items.map((it, i) => (
            <div key={i} className="flex gap-2 text-[11px]">
              <span className="font-medium w-52 shrink-0">{it.item}</span>
              <span className="text-muted-foreground">{it.reason}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
