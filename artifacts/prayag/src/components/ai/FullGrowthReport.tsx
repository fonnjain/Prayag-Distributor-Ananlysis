// Master Growth Report rendering component.
// All figures come from the server payload — this component renders and exports only.

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type Assumption = { label: string; defaultValue: number; currentValue: number; drives: string };
type LedgerRow = {
  rank: number; lever: string; entityType: string; entityName: string; whatToDo: string;
  valueLow: number | null; valueHigh: number | null;
  effort: "Low" | "Medium" | "High"; confidence: "High" | "Medium" | "Low";
  conversionAssumption?: number; basisNote?: string;
};

export type FullGrowthReportData = {
  type: "full-growth-report";
  fy: string; scope: string; scopeLabel: string;
  stateHead?: string; state?: string;
  periodLabel: string; priorPeriodLabel: string;
  dataCutoff: string; generatedAt: string;
  assumptions: { dormantRevival: number; atRiskRecovery: number; rangeUptake: number };
  executiveSummary: {
    scopeLabel: string; periodLabel: string; priorPeriodLabel: string;
    totalOpportunityLow: number | null; totalOpportunityHigh: number | null;
    preDedupTotal: number | null; postDedupTotal: number | null;
    deduplicationNote: string;
    leverRanking: Array<{ lever: string; value: number; entityCount: number }>;
    largestOpportunity: { lever: string; entityName: string; valueHigh: number | null } | null;
    largestRisk: { customer: string; netGrowthPct: number | null; qtyGrowthPct: number | null } | null;
    conversionNote: string; excludesProjectNote: string;
  };
  opportunityLedger: {
    rows: LedgerRow[]; totalRows: number; omittedCount: number; omittedValue: number | null;
  };
  activate: {
    dormantRevivalAssumption: number; medianActiveCustomerValue: number | null;
    medianNote: string; totalDormantCount: number; afterDedupCount: number;
    dedupNote: string | null; valueHigh: number | null; valueLow: number | null;
    lowActivationDistributors: Array<{
      name: string; retailerCount: number; activeCount: number;
      dormantCount: number; activationPct: number;
      dormantValueLow: number | null; dormantValueHigh: number | null;
    }>;
    distributorNote: string | null;
    unassignedRetailers: { total: number | null; assignmentGap: number | null; coverageGap: number | null; assignmentNote: string; topGapDistricts: Array<{ district: string; count: number }> } | null;
    notAvailable: boolean; notAvailableReason: string;
  };
  widen: {
    rangeUptakeAssumption: number; peerNote: string; excludesProjectNote: string;
    top20Distributors: Array<{ name: string; distinctBrands: number | null; broadSegments: number | null; rangeGapNote: string; valueHigh: number | null; valueLow: number | null }>;
    valueHigh: number | null; valueLow: number | null;
    segmentRollup: Array<{ segment: string; codesLost: number; priorNet: number | null }>;
    notAvailable: boolean; notAvailableReason: string;
  };
  recover: {
    periodLabel: string; priorPeriodLabel: string; basisBreakNote: string;
    atRiskCount: number; atRiskPriorValue: number | null; afterDedupCount: number;
    dedupNote: string | null; recoveryAssumption: number;
    valueHigh: number | null; valueLow: number | null;
    silentCount: number; reducingCount: number;
    top30AtRisk: Array<{ customer: string; priorNet: number | null; curNet: number | null; isSilent: boolean; netChangePct: number | null }>;
    lostCodes: Array<{ segment: string; codesLost: number; priorNet: number | null }>;
    notAvailable: boolean; notAvailableReason: string;
  };
  protect: {
    protectNote: string;
    hiddenShrinkers: Array<{ name: string; net: number | null; priorNet: number | null; netGrowthPct: number | null; qtyGrowthPct: number | null }>;
    narrowers: Array<{ customer: string; curCodes: number; priorCodes: number; codeDrop: number; priorNet: number | null }>;
    silentDistributors: Array<{ name: string; daysSilent: number; lastOrderDate: string | null }>;
    concentrationFlags: Array<{ name: string; sharePct: number }>;
    distributorDataNote: string | null;
  };
  close: {
    quarter: string; deadline: string | null; daysToDeadline: number | null;
    nudges: Array<{ customer: string; extraEarn: number | null; extraRoi: number | null; gap: number; billedSoFar: number | null; isBlocked: boolean }>;
    totalExtraEarnAt8pct: number | null; totalExtraEarnAt5to8: number | null;
    blockedAccounts: Array<{ customer: string; schemeValue: number | null }>;
    blockedNote: string; notAvailable: boolean; notAvailableReason: string;
  };
  whereNotToLook: {
    projectGaps: Array<{ customer: string; projectNet: number | null; projectPct: number | null }>;
    projectGapNote: string;
    concentratedGaps: Array<{ description: string; topCustomerCount: number; totalValue: number | null }>;
    mandatoryNote: string;
  };
  capacityCheck: {
    teamMemberCount: number; workingDaysActual: number | null; workingDaysNote: string;
    visitImpliedByLedger: number; currentVisitRate: number | null;
    capacityShortfall: number | null; capacityNote: string;
  };
  assumptionsAndLimits: {
    conversionAssumptions: Assumption[];
    comparisonBasis: string; basisBreakNote: string;
    unavailableItems: Array<{ item: string; reason: string }>;
  };
  deduplication: {
    preDedupValue: number | null; postDedupValue: number | null; adjustmentValue: number | null;
    multiLeverEntityCount: number;
    examples: Array<{ entity: string; claimedByLever: string; reason: string }>;
    precedenceRules: string[]; note: string;
  };
  narrative: Record<string, string>;
  guard: { passed: boolean; flagged: Array<{ sentence: string; termMentioned: string }> };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const cr = (v: number | null | undefined) =>
  v != null ? (Math.trunc(v / 10_000_000 * 100) / 100).toFixed(2) : "—";
const lac = (v: number | null | undefined) =>
  v != null ? (Math.trunc(v / 100_000 * 100) / 100).toFixed(2) : "—";

function NarrativePara({ text }: { text: string | undefined }) {
  if (!text) return null;
  return <p className="text-sm text-muted-foreground leading-relaxed mt-2 italic border-l-2 border-primary/20 pl-3">{text}</p>;
}

function SectionHeader({ num, title, badge }: { num: number; title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-[10px] font-bold text-muted-foreground bg-muted/60 rounded px-1.5 py-0.5">{num}</span>
      <h2 className="text-sm font-semibold">{title}</h2>
      {badge && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium">{badge}</span>}
    </div>
  );
}

function ConfidenceBadge({ v }: { v: "High"|"Medium"|"Low" }) {
  return <Badge variant="outline" className={cn("text-[10px]",
    v==="High"?"text-teal-700 border-teal-300":v==="Medium"?"text-amber-700 border-amber-300":"text-muted-foreground border-border")}>{v}</Badge>;
}
function EffortBadge({ v }: { v: "Low"|"Medium"|"High" }) {
  return <Badge variant="outline" className={cn("text-[10px]",
    v==="Low"?"text-teal-700 border-teal-300":v==="Medium"?"text-amber-700 border-amber-300":"text-destructive/80 border-destructive/30")}>{v} effort</Badge>;
}
function LeverBadge({ v }: { v: string }) {
  const colours: Record<string, string> = { CLOSE: "bg-teal-100 text-teal-800", RECOVER: "bg-blue-100 text-blue-800", ACTIVATE: "bg-purple-100 text-purple-800", WIDEN: "bg-orange-100 text-orange-800" };
  return <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded", colours[v] ?? "bg-muted text-muted-foreground")}>{v}</span>;
}

function CollapseCard({ title, badge, defaultOpen = true, children }: { title: React.ReactNode; badge?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="border-border/50">
      <CardHeader className="py-2.5 px-4 cursor-pointer select-none" onClick={() => setOpen(v => !v)}>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">{title}{badge}</CardTitle>
          <span className="text-muted-foreground text-xs">{open ? "▲" : "▼"}</span>
        </div>
      </CardHeader>
      {open && <CardContent className="px-4 pb-4 pt-0">{children}</CardContent>}
    </Card>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FullGrowthReport({ data }: { data: FullGrowthReportData }) {
  const { executiveSummary: ex, opportunityLedger: ledger, activate, widen, recover, protect, close, whereNotToLook, capacityCheck: cap, assumptionsAndLimits: al, deduplication: dedup, narrative } = data;

  return (
    <div className="space-y-4 text-foreground" data-testid="full-growth-report">
      {/* Header */}
      <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3 space-y-0.5">
        <p className="text-base font-bold">Master Growth Report — {data.scopeLabel}</p>
        <p className="text-xs text-muted-foreground">{data.periodLabel} · Prior period: {data.priorPeriodLabel} · FY {data.fy} · Data to {data.dataCutoff}</p>
        <p className="text-[10px] text-muted-foreground">All figures are computed from the data layer. This report names entities and carries quantified opportunities only — it is not a strategy document.</p>
      </div>

      {/* §1 Executive Summary */}
      <CollapseCard title={<><SectionHeader num={1} title="Executive Summary" /><span /></>} defaultOpen>
        <SectionHeader num={1} title="Executive Summary" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          {[
            { label: "Opportunity Low (Cr)", value: cr(ex.totalOpportunityLow != null ? ex.totalOpportunityLow * 10_000_000 : null) },
            { label: "Opportunity High (Cr)", value: cr(ex.totalOpportunityHigh != null ? ex.totalOpportunityHigh * 10_000_000 : null) },
            { label: "Pre-dedup Total (Cr)", value: cr(ex.preDedupTotal != null ? ex.preDedupTotal * 10_000_000 : null) },
            { label: "Post-dedup Total (Cr)", value: cr(ex.postDedupTotal != null ? ex.postDedupTotal * 10_000_000 : null) },
          ].map(k => (
            <div key={k.label} className="rounded-lg border border-border/50 p-3 text-center">
              <p className="text-lg font-bold">₹{k.value}</p>
              <p className="text-[10px] text-muted-foreground">{k.label}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-1.5 mb-3">{ex.deduplicationNote}</p>
        <table className="w-full text-xs mb-3">
          <thead><tr className="border-b border-border/40">
            {["Rank", "Lever", "Post-dedup Value (₹ Cr)", "Entities"].map(h => <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground">{h}</th>)}
          </tr></thead>
          <tbody>
            {ex.leverRanking.map((l, i) => (
              <tr key={l.lever} className="border-t border-border/30">
                <td className="py-1.5 px-2 text-muted-foreground">{i+1}</td>
                <td className="py-1.5 px-2"><LeverBadge v={l.lever} /></td>
                <td className="py-1.5 px-2 font-medium">₹{cr(l.value)}</td>
                <td className="py-1.5 px-2 text-muted-foreground">{l.entityCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {ex.largestOpportunity && (
          <p className="text-xs mb-1"><span className="font-medium">Largest opportunity:</span> <LeverBadge v={ex.largestOpportunity.lever} /> <span className="font-medium">{ex.largestOpportunity.entityName}</span> — ₹{cr(ex.largestOpportunity.valueHigh != null ? ex.largestOpportunity.valueHigh * 10_000_000 : null)} Cr (high estimate)</p>
        )}
        {ex.largestRisk && (
          <p className="text-xs mb-1"><span className="font-medium">Largest risk to existing revenue:</span> <span className="font-medium">{ex.largestRisk.customer}</span> — value {ex.largestRisk.netGrowthPct != null ? `+${ex.largestRisk.netGrowthPct}%` : "up"} but qty {ex.largestRisk.qtyGrowthPct != null ? `${ex.largestRisk.qtyGrowthPct}%` : "down"} (hidden shrinkage)</p>
        )}
        <p className="text-[10px] text-muted-foreground border-t border-border/30 mt-2 pt-2">{ex.conversionNote}</p>
        <p className="text-[10px] text-muted-foreground">{ex.excludesProjectNote}</p>
        <NarrativePara text={narrative.executiveSummary} />
      </CollapseCard>

      {/* §2 Opportunity Ledger */}
      <CollapseCard title="§2 Opportunity Ledger" badge={<Badge variant="outline" className="text-[10px]">{ledger.rows.length} rows</Badge>} defaultOpen>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="border-b border-border/40">
              {["#", "Lever", "Entity", "What to Do", "Low (₹ Cr)", "High (₹ Cr)", "Effort", "Confidence"].map(h => (
                <th key={h} className="py-2 px-2 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {ledger.rows.map(r => (
                <tr key={r.rank} className="border-t border-border/30 hover:bg-muted/20">
                  <td className="py-1.5 px-2 text-muted-foreground">{r.rank}</td>
                  <td className="py-1.5 px-2"><LeverBadge v={r.lever} /></td>
                  <td className="py-1.5 px-2 font-medium max-w-[160px] truncate" title={r.entityName}>{r.entityName}</td>
                  <td className="py-1.5 px-2 max-w-[240px] text-muted-foreground">{r.whatToDo}</td>
                  <td className="py-1.5 px-2">₹{cr(r.valueLow != null ? r.valueLow * 10_000_000 : null)}</td>
                  <td className="py-1.5 px-2 font-medium">₹{cr(r.valueHigh != null ? r.valueHigh * 10_000_000 : null)}</td>
                  <td className="py-1.5 px-2"><EffortBadge v={r.effort} /></td>
                  <td className="py-1.5 px-2"><ConfidenceBadge v={r.confidence} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ledger.omittedCount > 0 && (
          <p className="text-[10px] text-muted-foreground mt-2">{ledger.omittedCount} row(s) omitted (cap: 40). Combined value: ₹{cr(ledger.omittedValue != null ? ledger.omittedValue * 10_000_000 : null)} Cr.</p>
        )}
      </CollapseCard>

      {/* §3 Activate */}
      <CollapseCard title="§3 Activate — Dormant and Unassigned" defaultOpen={false}>
        {activate.notAvailable ? (
          <p className="text-sm text-muted-foreground">{activate.notAvailableReason}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
              {[
                { label: "Dormant (total)", value: String(activate.totalDormantCount) },
                { label: "After dedup", value: String(activate.afterDedupCount) },
                { label: "Value Low–High (Cr)", value: `₹${cr(activate.valueLow != null ? activate.valueLow * 10_000_000 : null)}–₹${cr(activate.valueHigh != null ? activate.valueHigh * 10_000_000 : null)}` },
              ].map(k => (
                <div key={k.label} className="rounded border border-border/50 p-3 text-center">
                  <p className="text-base font-bold">{k.value}</p>
                  <p className="text-[10px] text-muted-foreground">{k.label}</p>
                </div>
              ))}
            </div>
            {activate.dedupNote && <p className="text-xs text-amber-700 mb-2">{activate.dedupNote}</p>}
            <p className="text-[10px] text-muted-foreground mb-2">{activate.medianNote} Median active customer value: ₹{lac(activate.medianActiveCustomerValue != null ? activate.medianActiveCustomerValue * 100_000 : null)}L · Assumption: {Math.round(activate.dormantRevivalAssumption * 100)}%</p>
            {activate.distributorNote && (
              <p className="text-xs text-muted-foreground italic mb-2">{activate.distributorNote}</p>
            )}
            {activate.lowActivationDistributors.length > 0 && (
              <div className="overflow-x-auto mb-3">
                <p className="text-xs font-medium mb-1">Distributors below 40% activation</p>
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border/40">
                    {["Distributor", "Active%", "Active", "Dormant", "Value Low (Cr)", "Value High (Cr)"].map(h => (
                      <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {activate.lowActivationDistributors.map((d, i) => (
                      <tr key={i} className="border-t border-border/30">
                        <td className="py-1.5 px-2 font-medium">{d.name}</td>
                        <td className="py-1.5 px-2 text-amber-700">{d.activationPct}%</td>
                        <td className="py-1.5 px-2">{d.activeCount}</td>
                        <td className="py-1.5 px-2">{d.dormantCount}</td>
                        <td className="py-1.5 px-2">₹{cr(d.dormantValueLow != null ? d.dormantValueLow * 10_000_000 : null)}</td>
                        <td className="py-1.5 px-2 font-medium">₹{cr(d.dormantValueHigh != null ? d.dormantValueHigh * 10_000_000 : null)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {activate.unassignedRetailers && (
              <div className="rounded border border-blue-200 bg-blue-50/40 p-3 space-y-1">
                <p className="text-xs font-semibold text-blue-800">Unassigned Retailers</p>
                <p className="text-xs text-blue-700">Total: {activate.unassignedRetailers.total ?? "—"} · Assignment gap (fix this week): {activate.unassignedRetailers.assignmentGap ?? "—"} · Coverage gap (appoint distributor): {activate.unassignedRetailers.coverageGap ?? "—"}</p>
                {activate.unassignedRetailers.topGapDistricts.slice(0, 5).map(d => (
                  <p key={d.district} className="text-[10px] text-blue-600">{d.district}: {d.count} unassigned</p>
                ))}
              </div>
            )}
          </>
        )}
        <NarrativePara text={narrative.activate} />
      </CollapseCard>

      {/* §4 Widen */}
      <CollapseCard title="§4 Widen — Range Gap" defaultOpen={false}>
        {widen.notAvailable ? (
          <p className="text-sm text-muted-foreground">{widen.notAvailableReason}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-2">{widen.peerNote}</p>
            <p className="text-[10px] text-muted-foreground mb-3">{widen.excludesProjectNote} · Assumption: {Math.round(widen.rangeUptakeAssumption * 100)}% uptake · Value: ₹{cr(widen.valueLow != null ? widen.valueLow * 10_000_000 : null)}–₹{cr(widen.valueHigh != null ? widen.valueHigh * 10_000_000 : null)} Cr</p>
            {widen.top20Distributors.length > 0 && (
              <div className="overflow-x-auto mb-3">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border/40">
                    {["Distributor", "Brands", "Segments", "Gap Note", "Value Low", "Value High"].map(h => (
                      <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {widen.top20Distributors.map((d, i) => (
                      <tr key={i} className="border-t border-border/30">
                        <td className="py-1.5 px-2 font-medium">{d.name}</td>
                        <td className="py-1.5 px-2">{d.distinctBrands ?? "—"}</td>
                        <td className="py-1.5 px-2">{d.broadSegments ?? "—"}</td>
                        <td className="py-1.5 px-2 text-muted-foreground text-[10px]">{d.rangeGapNote}</td>
                        <td className="py-1.5 px-2">₹{cr(d.valueLow != null ? d.valueLow * 10_000_000 : null)}</td>
                        <td className="py-1.5 px-2 font-medium">₹{cr(d.valueHigh != null ? d.valueHigh * 10_000_000 : null)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {widen.segmentRollup.length > 0 && (
              <div>
                <p className="text-xs font-medium mb-1">Segment rollup — codes lost year-on-year</p>
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border/40">
                    {["Segment", "Codes Lost", "Prior-yr Value (Cr)"].map(h => (
                      <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {widen.segmentRollup.map((s, i) => (
                      <tr key={i} className="border-t border-border/30">
                        <td className="py-1.5 px-2">{s.segment}</td>
                        <td className="py-1.5 px-2">{s.codesLost}</td>
                        <td className="py-1.5 px-2">₹{cr(s.priorNet != null ? s.priorNet * 10_000_000 : null)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <NarrativePara text={narrative.widen} />
      </CollapseCard>

      {/* §5 Recover */}
      <CollapseCard title="§5 Recover — At-Risk and Lost Codes" defaultOpen={false}>
        {recover.notAvailable ? (
          <p className="text-sm text-muted-foreground">{recover.notAvailableReason}</p>
        ) : (
          <>
            <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-3">{recover.basisBreakNote}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              {[
                { label: "At-risk (total)", value: String(recover.atRiskCount) },
                { label: "After dedup", value: String(recover.afterDedupCount) },
                { label: "Silent (no orders)", value: String(recover.silentCount) },
                { label: "Reducing", value: String(recover.reducingCount) },
              ].map(k => (
                <div key={k.label} className="rounded border border-border/50 p-3 text-center">
                  <p className="text-base font-bold">{k.value}</p>
                  <p className="text-[10px] text-muted-foreground">{k.label}</p>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mb-2">Prior-year value at risk: ₹{cr(recover.atRiskPriorValue != null ? recover.atRiskPriorValue * 10_000_000 : null)} Cr · Assumption: {Math.round(recover.recoveryAssumption * 100)}% · Value range: ₹{cr(recover.valueLow != null ? recover.valueLow * 10_000_000 : null)}–₹{cr(recover.valueHigh != null ? recover.valueHigh * 10_000_000 : null)} Cr</p>
            {recover.dedupNote && <p className="text-xs text-amber-700 mb-2">{recover.dedupNote}</p>}
            <div className="overflow-x-auto mb-3">
              <p className="text-xs font-medium mb-1">Top at-risk accounts (by prior-year value)</p>
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border/40">
                  {["Customer", "Silent?", "Prior-yr (Cr)", "Current (Cr)", "Change %"].map(h => (
                    <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {recover.top30AtRisk.slice(0, 20).map((r, i) => (
                    <tr key={i} className={cn("border-t border-border/30", r.isSilent && "bg-red-50/30")}>
                      <td className="py-1.5 px-2 font-medium">{r.customer}</td>
                      <td className="py-1.5 px-2">{r.isSilent ? <span className="text-destructive font-semibold">Yes</span> : "—"}</td>
                      <td className="py-1.5 px-2">₹{cr(r.priorNet != null ? r.priorNet * 10_000_000 : null)}</td>
                      <td className="py-1.5 px-2">₹{cr(r.curNet != null ? r.curNet * 10_000_000 : null)}</td>
                      <td className={cn("py-1.5 px-2", r.netChangePct != null && r.netChangePct < 0 ? "text-destructive" : "")}>{r.netChangePct != null ? `${r.netChangePct}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {recover.lostCodes.length > 0 && (
              <div>
                <p className="text-xs font-medium mb-1">Lost item codes by segment (bought prior year, not current)</p>
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border/40">
                    {["Segment", "Codes Lost", "Prior-yr Value (Cr)"].map(h => (
                      <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {recover.lostCodes.slice(0, 10).map((r, i) => (
                      <tr key={i} className="border-t border-border/30">
                        <td className="py-1.5 px-2">{r.segment}</td>
                        <td className="py-1.5 px-2">{r.codesLost}</td>
                        <td className="py-1.5 px-2">₹{cr(r.priorNet != null ? r.priorNet * 10_000_000 : null)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        <NarrativePara text={narrative.recover} />
      </CollapseCard>

      {/* §6 Protect */}
      <CollapseCard title={<>§6 Protect — Value at Risk <span className="text-[10px] font-normal text-destructive/80">(not added to opportunity total)</span></>} defaultOpen={false}>
        <p className="text-xs font-semibold text-destructive mb-3">{protect.protectNote}</p>
        {protect.distributorDataNote && <p className="text-xs text-muted-foreground italic mb-2">{protect.distributorDataNote}</p>}
        {protect.hiddenShrinkers.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium mb-1">Hidden shrinkers — value up, quantity down</p>
            <table className="w-full text-xs">
              <thead><tr className="border-b border-border/40">
                {["Customer", "Net ₹ Cr", "Prior Net ₹ Cr", "Net Change %", "Qty Change %"].map(h => (
                  <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {protect.hiddenShrinkers.slice(0, 10).map((r, i) => (
                  <tr key={i} className="border-t border-border/30 bg-amber-50/20">
                    <td className="py-1.5 px-2 font-medium">{r.name}</td>
                    <td className="py-1.5 px-2">₹{cr(r.net != null ? r.net * 10_000_000 : null)}</td>
                    <td className="py-1.5 px-2">₹{cr(r.priorNet != null ? r.priorNet * 10_000_000 : null)}</td>
                    <td className="py-1.5 px-2 text-teal-700">{r.netGrowthPct != null ? `+${r.netGrowthPct}%` : "—"}</td>
                    <td className="py-1.5 px-2 text-destructive">{r.qtyGrowthPct != null ? `${r.qtyGrowthPct}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {protect.narrowers.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium mb-1">Narrowers — biggest drop in item-code count</p>
            <table className="w-full text-xs">
              <thead><tr className="border-b border-border/40">
                {["Customer", "Prior codes", "Current codes", "Drop", "Prior-yr value (Cr)"].map(h => (
                  <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {protect.narrowers.slice(0, 10).map((r, i) => (
                  <tr key={i} className="border-t border-border/30">
                    <td className="py-1.5 px-2 font-medium">{r.customer}</td>
                    <td className="py-1.5 px-2">{r.priorCodes}</td>
                    <td className="py-1.5 px-2">{r.curCodes}</td>
                    <td className="py-1.5 px-2 text-destructive font-semibold">−{r.codeDrop}</td>
                    <td className="py-1.5 px-2">₹{cr(r.priorNet != null ? r.priorNet * 10_000_000 : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {protect.concentrationFlags.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium mb-1">Concentration — distributors above 60% of state</p>
            {protect.concentrationFlags.map((f, i) => (
              <p key={i} className="text-xs text-destructive">{f.name}: {f.sharePct}% share</p>
            ))}
          </div>
        )}
        {protect.silentDistributors.length > 0 && (
          <div>
            <p className="text-xs font-medium mb-1">Silent distributors — no order in 6+ weeks</p>
            {protect.silentDistributors.map((d, i) => (
              <p key={i} className="text-xs text-muted-foreground">{d.name}: {d.daysSilent} days silent{d.lastOrderDate ? ` · last: ${d.lastOrderDate}` : ""}</p>
            ))}
          </div>
        )}
        <NarrativePara text={narrative.protect} />
      </CollapseCard>

      {/* §7 Close */}
      <CollapseCard title="§7 Close — Scheme Nudges" defaultOpen={false}>
        {close.notAvailable ? (
          <p className="text-sm text-muted-foreground">{close.notAvailableReason}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
              {[
                { label: "Extra Earn ≥8% ROI (₹ Cr)", value: cr(close.totalExtraEarnAt8pct != null ? close.totalExtraEarnAt8pct * 10_000_000 : null) },
                { label: "Extra Earn 5–8% ROI (₹ Cr)", value: cr(close.totalExtraEarnAt5to8 != null ? close.totalExtraEarnAt5to8 * 10_000_000 : null) },
                { label: "Days to 25th cut-off", value: close.daysToDeadline != null ? String(close.daysToDeadline) : "—" },
              ].map(k => (
                <div key={k.label} className={cn("rounded border p-3 text-center", k.label.includes("Days") && close.daysToDeadline != null && close.daysToDeadline <= 5 ? "border-destructive/40 bg-destructive/5" : "border-border/50")}>
                  <p className={cn("text-base font-bold", k.label.includes("Days") && close.daysToDeadline != null && close.daysToDeadline <= 5 ? "text-destructive" : "")}>{k.value !== "—" ? `₹${k.value}` : k.value}{k.label.includes("Days") && close.daysToDeadline != null ? ` days` : ""}</p>
                  <p className="text-[10px] text-muted-foreground">{k.label}</p>
                </div>
              ))}
            </div>
            <div className="overflow-x-auto mb-3">
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border/40">
                  {["Customer", "Extra Earn (₹)", "Extra ROI%", "Gap to Tier (₹)", "Billed So Far (₹)", "Status"].map(h => (
                    <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {close.nudges.map((n, i) => (
                    <tr key={i} className={cn("border-t border-border/30", n.isBlocked && "opacity-50")}>
                      <td className="py-1.5 px-2 font-medium">{n.customer}{n.isBlocked && <span className="ml-1 text-[9px] text-destructive">BLOCKED</span>}</td>
                      <td className="py-1.5 px-2 text-teal-700">₹{n.extraEarn != null ? (n.extraEarn * 100_000).toFixed(0) : "—"}</td>
                      <td className="py-1.5 px-2">{n.extraRoi != null ? `${n.extraRoi}%` : "—"}</td>
                      <td className="py-1.5 px-2">₹{n.gap != null ? (n.gap * 100_000).toFixed(0) : "—"}</td>
                      <td className="py-1.5 px-2">₹{n.billedSoFar != null ? (n.billedSoFar * 100_000).toFixed(0) : "—"}</td>
                      <td className="py-1.5 px-2 text-muted-foreground">{n.isBlocked ? "Collections" : "Active"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-muted-foreground">{close.blockedNote}</p>
            {close.blockedAccounts.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-amber-800 mb-1">Blocked accounts — collections opportunity (scheme value as argument)</p>
                {close.blockedAccounts.map((a, i) => (
                  <p key={i} className="text-xs text-amber-700">{a.customer}: scheme value ₹{a.schemeValue != null ? (a.schemeValue * 100_000).toFixed(0) : "—"}</p>
                ))}
              </div>
            )}
          </>
        )}
        <NarrativePara text={narrative.close} />
      </CollapseCard>

      {/* §8 Where Not to Look */}
      <CollapseCard title="§8 Where Not to Look" badge={<Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">mandatory — not suppressed</Badge>} defaultOpen={false}>
        <p className="text-[10px] text-muted-foreground mb-2">{whereNotToLook.mandatoryNote}</p>
        <p className="text-xs mb-2">{whereNotToLook.projectGapNote}</p>
        {whereNotToLook.projectGaps.length > 0 && (
          <table className="w-full text-xs mb-3">
            <thead><tr className="border-b border-border/40">
              {["Customer", "Project Net (Cr)", "Project %"].map(h => (
                <th key={h} className="py-1.5 px-2 text-left font-medium text-muted-foreground">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {whereNotToLook.projectGaps.map((g, i) => (
                <tr key={i} className="border-t border-border/30">
                  <td className="py-1.5 px-2 font-medium">{g.customer}</td>
                  <td className="py-1.5 px-2">₹{cr(g.projectNet != null ? g.projectNet * 10_000_000 : null)}</td>
                  <td className="py-1.5 px-2">{g.projectPct != null ? `${g.projectPct}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {whereNotToLook.concentratedGaps.length > 0 && (
          <div>
            <p className="text-xs font-medium mb-1">Concentrated gaps — fewer than 6 customers</p>
            {whereNotToLook.concentratedGaps.map((g, i) => (
              <p key={i} className="text-xs text-muted-foreground">{g.description}: {g.topCustomerCount} customer{g.topCustomerCount !== 1 ? "s" : ""}, ₹{cr(g.totalValue != null ? g.totalValue * 10_000_000 : null)} Cr</p>
            ))}
          </div>
        )}
        <NarrativePara text={narrative.whereNotToLook} />
      </CollapseCard>

      {/* §9 Capacity Check */}
      <CollapseCard title="§9 Capacity Check" defaultOpen={false}>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
          {[
            { label: "Team members", value: String(cap.teamMemberCount) },
            { label: "Visits implied by ledger", value: String(cap.visitImpliedByLedger) },
            { label: "Capacity shortfall", value: cap.capacityShortfall != null ? String(cap.capacityShortfall) : "Within capacity", highlight: cap.capacityShortfall != null },
          ].map(k => (
            <div key={k.label} className={cn("rounded border p-3 text-center", k.highlight ? "border-destructive/40 bg-destructive/5" : "border-border/50")}>
              <p className={cn("text-base font-bold", k.highlight ? "text-destructive" : "")}>{k.value}</p>
              <p className="text-[10px] text-muted-foreground">{k.label}</p>
            </div>
          ))}
        </div>
        <p className={cn("text-xs px-3 py-2 rounded border",
          cap.capacityShortfall != null ? "text-destructive bg-destructive/5 border-destructive/30" : "text-muted-foreground border-border/50")}>
          {cap.capacityNote}
        </p>
        <p className="text-[10px] text-muted-foreground mt-1">{cap.workingDaysNote}</p>
        <NarrativePara text={narrative.capacityCheck} />
      </CollapseCard>

      {/* §10 Assumptions and Limits */}
      <CollapseCard title="§10 Assumptions and Limits" defaultOpen={false}>
        <div className="space-y-2 mb-3">
          {al.conversionAssumptions.map(a => (
            <div key={a.label} className="flex items-baseline gap-2 text-xs">
              <span className="font-medium w-52 shrink-0">{a.label}:</span>
              <span>{Math.round(a.currentValue * 100)}%</span>
              {a.currentValue !== a.defaultValue && (
                <span className="text-amber-700">(default {Math.round(a.defaultValue * 100)}%)</span>
              )}
              <span className="text-muted-foreground">— drives {a.drives}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mb-2">{al.comparisonBasis}</p>
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-3">{al.basisBreakNote}</p>
        {al.unavailableItems.length > 0 && (
          <div>
            <p className="text-xs font-medium mb-1">Cannot be computed:</p>
            {al.unavailableItems.map((u, i) => (
              <p key={i} className="text-xs text-muted-foreground">• <span className="font-medium">{u.item}</span> — {u.reason}</p>
            ))}
          </div>
        )}
        <NarrativePara text={narrative.assumptionsAndLimits} />
      </CollapseCard>

      {/* Deduplication detail */}
      <CollapseCard title="Deduplication Detail" defaultOpen={false}>
        <div className="grid grid-cols-3 gap-3 mb-3">
          {[
            { label: "Pre-dedup (₹ Cr)", value: cr(dedup.preDedupValue != null ? dedup.preDedupValue * 10_000_000 : null) },
            { label: "Post-dedup (₹ Cr)", value: cr(dedup.postDedupValue != null ? dedup.postDedupValue * 10_000_000 : null) },
            { label: "Multi-lever entities", value: String(dedup.multiLeverEntityCount) },
          ].map(k => (
            <div key={k.label} className="rounded border border-border/50 p-3 text-center">
              <p className="text-base font-bold">{k.label.includes("Cr") ? `₹${k.value}` : k.value}</p>
              <p className="text-[10px] text-muted-foreground">{k.label}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mb-2">{dedup.note}</p>
        <div className="text-xs space-y-0.5 mb-2">
          {dedup.precedenceRules.map((r, i) => <p key={i} className="text-muted-foreground">{r}</p>)}
        </div>
        {dedup.examples.length > 0 && (
          <div>
            <p className="text-xs font-medium mb-1">Sample entities that appeared in multiple levers:</p>
            {dedup.examples.map((e, i) => (
              <p key={i} className="text-xs text-muted-foreground">• <span className="font-medium">{e.entity}</span> → {e.claimedByLever}: {e.reason}</p>
            ))}
          </div>
        )}
      </CollapseCard>
    </div>
  );
}
