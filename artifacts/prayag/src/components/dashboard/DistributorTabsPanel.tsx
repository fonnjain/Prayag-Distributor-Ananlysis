// Distributor Deep Dive — the three analysis tabs (Secondary Sales, SKU
// Evolution, Push) plus the vocabulary-reconciliation panel that underpins
// every figure joining the primary and sheet vocabularies.
//
// Rules carried from the spec:
//  - Every figure names its source (primary register / secondary register /
//    member sheets / K3 push engine).
//  - The unattributed share is shown prominently, never in a footnote.
//  - Flow-gap language always states BOTH readings (stock building OR business
//    outside the attributed channel) — never an accusation.
//  - Similar names are listed for confirmation, never merged.
import { useEffect, useState } from "react";
import { Loader2, AlertTriangle, Info, CheckCircle2 } from "lucide-react";
import { formatCompact } from "@/data/dataset";

const API = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";

// ── Payload types (mirror distributorTabs.ts) ────────────────────────────────

type ReconCandidate = {
  saleName: string; saleState: string | null; saleDistrict: string | null;
  saleValue: number; saleMonths: string[];
  sheetName: string; sheetStates: string[]; sheetHeads: string[];
  sheetPrimaryValue: number; sheetMonths: string[];
  similarity: number; resolvedDifferent: boolean; overlapMonths: string[];
};

export type DistributorRecon = {
  fy: string; sheetDistributors: number; saleCustomers: number;
  saleTerritoryValue: number; exactMatches: number; normMatches: number;
  matchedCustomers: number; matchedSheetKeys: number;
  matchedValue: number; unmatchedValue: number; unmatchedPct: number;
  needsConfirmation: ReconCandidate[]; resolvedDifferent: ReconCandidate[];
  unmatchedTop: { name: string; state: string | null; district: string | null; value: number }[];
  monthsLoaded: string[];
};

type FlowGapCode = {
  code: string; group: string | null;
  primaryInQty: number; primaryInValue: number;
  secondaryOutQty: number; secondaryOutValue: number;
  gapValue: number; flagged: boolean;
  /**
   * GROSS CONTRIBUTION — factory cost only. Not profit.
   * = (primaryInQty − secondaryOutQty) × contributionPerUnit.
   * null = no cost data; rows sort last.
   */
  opportunityContribution: number | null;
  contributionPerUnit: number | null;
};

type SecondaryTab = {
  distributor: { name: string };
  monthsLoaded: string[]; coverageNote: string;
  netAmount: number; grossAmount: number; effectiveDiscountPct: number | null;
  retailerCount: number; activeRetailerCount: number; codeCount: number;
  segments: { segment: string; net: number; qty: number; codes: number }[];
  monthly: { month: string; net: number; retailers: number }[];
  topRetailers: { name: string; net: number; sharePct: number; salesperson: string | null }[];
  top5SharePct: number | null;
  primaryMatched: boolean; primarySaleNames: string[];
  primaryInTotal: number; secondaryOutTotal: number; flowGapTotal: number | null;
  flowGapBySegment: { segment: string; primaryIn: number; secondaryOut: number; gap: number }[];
  flowGapByCode: FlowGapCode[]; flaggedCodes: number; unattributedNote: string;
};

type SkuSide = {
  source: string; baselineMonths: string[]; currentMonths: string[]; baselineNote: string;
  existing: { value: number; baselineValue: number; codes: number; growth: number };
  fresh: { value: number; codes: number; segments: string[] };
  lost: { codes: { code: string; group: string | null; baselineValue: number }[]; value: number };
  totalCurrent: number; totalBaseline: number; totalGrowth: number;
  existingGrowthShare: number | null; newGrowthShare: number | null;
  deflator: number | null; realCurrent: number | null; realGrowth: number | null; mixNote: string;
};

type SkuTab = {
  baselineFy: string; distributor: { name: string };
  primary: SkuSide | null; secondary: SkuSide | null; reading: string;
};

type PushRec = {
  code: string; itemName: string | null; segment: string;
  tier: number; tierLabel: string; peerCount: number; segmentPeerCount: number; peerNet: number;
  peakQuarter: string | null; peakQuarterSharePct: number | null; timingNote: string | null;
  candidateRetailers: { name: string; segmentNet: number; salesperson: string | null }[];
  ownDiscountPct: number | null; territoryNormPct: number | null; overDiscounted: boolean;
  /**
   * GROSS CONTRIBUTION — factory cost only. Not profit.
   * null = no cost data in margin_fact trailing 12 months; sorts last.
   */
  contributionPerUnit: number | null;
  contributionPct: number | null;
};

type PushTab = {
  distributor: { name: string };
  verdict: "PUSH" | "CLEAR_STOCK_FIRST" | "NO_PRIMARY_DATA";
  verdictDetail: string;
  flowSummary: { primaryIn: number; secondaryOut: number; ratio: number | null; flaggedCodes: number };
  pushListSource: string; peerNames: string[]; suppressed: boolean; suppressReason: string | null;
  recommendations: PushRec[];
  coverage: {
    unassignedByMember: { member: string; state: string; unassigned: number; assignedActivePct: number | null; unassignedActivePct: number | null }[];
    dormantRetailers: { name: string; priorYearValue: number; salesperson: string | null }[];
    soleCoverageDistricts: string[]; districts: string[]; note: string;
  };
};

// ── Shared bits ───────────────────────────────────────────────────────────────

function useApi<T>(url: string | null): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url) { setData(null); setError(null); return; }
    let live = true;
    setLoading(true); setError(null); setData(null);
    fetch(url)
      .then(async (r) => {
        const j = await r.json();
        if (!live) return;
        if (!r.ok || j.error) setError(j.error ?? `HTTP ${r.status}`);
        else setData(j);
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [url]);
  return { data, error, loading };
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground text-sm">
      <Loader2 className="w-5 h-5 animate-spin" /> <span>{label}</span>
    </div>
  );
}

function Source({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-muted-foreground italic">source: {children}</span>;
}

function Card({ title, value, sub, testId }: { title: string; value: string; sub?: React.ReactNode; testId?: string }) {
  return (
    <div className="border border-border rounded-lg p-3 bg-card" data-testid={testId}>
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="text-lg font-semibold mt-0.5">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

/** The prominent unattributed-value banner — required on every joined figure. */
function UnattributedBanner({ recon }: { recon: DistributorRecon | null }) {
  if (!recon) return null;
  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-50/70 px-4 py-3 text-sm text-amber-900 dark:bg-amber-900/10 dark:text-amber-300"
      data-testid="banner-unattributed-primary"
    >
      <strong>{recon.unmatchedPct.toFixed(1)}% of territory primary value ({formatCompact(recon.unmatchedValue)}) is
      unattributed</strong> — those register names match no sheet distributor under the identity rule
      (name + state, never similarity). Every figure below that joins the two registers covers matched
      names only ({formatCompact(recon.matchedValue)} of {formatCompact(recon.saleTerritoryValue)} territory value).
    </div>
  );
}

// ── Reconciliation panel ─────────────────────────────────────────────────────

export function ReconPanel({ fy }: { fy: string }) {
  const { data, error, loading } = useApi<DistributorRecon>(
    `${API}/mgmt/distributor-recon?fy=${encodeURIComponent(fy)}`);
  if (loading) return <Spinner label="Reconciling the two distributor vocabularies…" />;
  if (error) return <div className="text-sm text-destructive">{error}</div>;
  if (!data) return null;
  const matchPct = data.saleTerritoryValue > 0 ? (data.matchedValue / data.saleTerritoryValue) * 100 : 0;
  return (
    <div className="space-y-4" data-testid="panel-recon">
      <UnattributedBanner recon={data} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card title="Sheet distributors" value={String(data.sheetDistributors)} sub={<Source>member working sheets</Source>} />
        <Card title="Primary register names" value={String(data.saleCustomers)} sub={<Source>primary register (sale_line)</Source>} />
        <Card title="Matched (identity rule)" value={`${data.matchedCustomers} names → ${data.matchedSheetKeys} distributors`}
          sub={`exact ${data.exactMatches} · normalised ${data.normMatches} · + location-suffix & state check`} />
        <Card title="Territory value matched" value={`${matchPct.toFixed(1)}%`} sub={`${formatCompact(data.matchedValue)} of ${formatCompact(data.saleTerritoryValue)}`} testId="card-match-rate" />
      </div>

      {data.needsConfirmation.length > 0 && (
        <div className="border border-border rounded-lg p-4">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            Needs confirmation — similar names, never auto-merged ({data.needsConfirmation.length})
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            Resolve each pair from state, district and value — not from the name alone. A matching
            state removes a disproof; it is not evidence of sameness.
          </p>
          <table className="w-full text-xs mt-2">
            <thead><tr className="text-left text-muted-foreground border-b border-border">
              <th className="py-1.5 pr-2">Register name</th><th className="py-1.5 pr-2">State · District</th>
              <th className="py-1.5 pr-2 text-right">Value</th><th className="py-1.5 pr-2">≈ Sheet distributor</th>
              <th className="py-1.5 pr-2">State · Head</th><th className="py-1.5 text-right">Matched value</th>
            </tr></thead>
            <tbody>
              {data.needsConfirmation.map((c) => (
                <tr key={c.saleName} className="border-b border-border/50" data-testid={`row-cand-${c.saleName}`}>
                  <td className="py-1.5 pr-2 font-medium">{c.saleName}</td>
                  <td className="py-1.5 pr-2">{c.saleState ?? "—"}{c.saleDistrict ? ` · ${c.saleDistrict}` : ""}</td>
                  <td className="py-1.5 pr-2 text-right">{formatCompact(c.saleValue)}</td>
                  <td className="py-1.5 pr-2">{c.sheetName}</td>
                  <td className="py-1.5 pr-2">{c.sheetStates.join("/")} · {c.sheetHeads.join(", ")}</td>
                  <td className="py-1.5 text-right">{formatCompact(c.sheetPrimaryValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.resolvedDifferent.length > 0 && (
        <div className="border border-border rounded-lg p-4">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            Resolved — different entities ({data.resolvedDifferent.length})
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            Both sides transact in the same months — positive proof of two distributors. No action needed.
          </p>
          <ul className="text-xs mt-2 space-y-1">
            {data.resolvedDifferent.map((c) => (
              <li key={c.saleName}>
                <span className="font-medium">{c.saleName}</span> ≠ {c.sheetName}
                <span className="text-muted-foreground"> — both active {c.overlapMonths.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border border-border rounded-lg p-4">
        <h4 className="text-sm font-semibold">Largest unattributed register names</h4>
        <table className="w-full text-xs mt-2">
          <thead><tr className="text-left text-muted-foreground border-b border-border">
            <th className="py-1.5 pr-2">Name</th><th className="py-1.5 pr-2">State</th>
            <th className="py-1.5 pr-2">District</th><th className="py-1.5 text-right">FY value</th>
          </tr></thead>
          <tbody>
            {data.unmatchedTop.slice(0, 15).map((u) => (
              <tr key={u.name} className="border-b border-border/50">
                <td className="py-1.5 pr-2">{u.name}</td>
                <td className="py-1.5 pr-2">{u.state ?? "—"}</td>
                <td className="py-1.5 pr-2">{u.district ?? "—"}</td>
                <td className="py-1.5 text-right">{formatCompact(u.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Source>primary register (sale_line), FY {data.fy ?? fy}</Source>
      </div>
    </div>
  );
}

// ── Tab 1: Secondary Sales ───────────────────────────────────────────────────

function BothReadings() {
  return (
    <p className="text-xs text-muted-foreground flex gap-1.5 items-start">
      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span>
        A positive gap means either <strong>stock building at the distributor</strong>, or{" "}
        <strong>business moving outside the attributed channel</strong>. No stock statements exist,
        so the two cannot be distinguished — this is an observation, not an accusation.
      </span>
    </p>
  );
}

export function SecondaryTabView({ fy, scope, recon, monthsParam = "" }: { fy: string; scope: string; recon: DistributorRecon | null; monthsParam?: string }) {
  const { data, error, loading } = useApi<SecondaryTab>(
    `${API}/mgmt/distributor-tab?fy=${encodeURIComponent(fy)}&${scope}&tab=secondary${monthsParam}`);
  if (loading) return <Spinner label="Reading the secondary register…" />;
  if (error) return <div className="text-sm text-destructive">{error}</div>;
  if (!data) return null;
  const maxMonth = Math.max(1, ...data.monthly.map((m) => m.net));
  return (
    <div className="space-y-4" data-testid="tab-secondary">
      <UnattributedBanner recon={recon} />
      <div className="text-sm font-medium">{data.coverageNote} <Source>secondary register</Source></div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card title="Secondary NET" value={formatCompact(data.netAmount)} sub={<Source>secondary register</Source>} testId="card-secondary-net" />
        <Card title="Gross" value={formatCompact(data.grossAmount)} sub={<Source>secondary register</Source>} />
        <Card title="Effective discount" value={data.effectiveDiscountPct != null ? `${data.effectiveDiscountPct.toFixed(1)}%` : "—"} sub={<>gross → net · <Source>secondary register</Source></>} />
        <Card title="Retailers buying" value={`${data.retailerCount} (${data.activeRetailerCount} active)`} sub={<Source>secondary register</Source>} />
        <Card title="Codes · segments" value={`${data.codeCount} · ${data.segments.length}`} sub={<>{data.segments.slice(0, 3).map((s) => s.segment).join(", ")} · <Source>secondary register</Source></>} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="border border-border rounded-lg p-4">
          <h4 className="text-sm font-semibold">Month distribution</h4>
          <div className="mt-2 space-y-1.5">
            {data.monthly.map((m) => (
              <div key={m.month} className="flex items-center gap-2 text-xs">
                <span className="w-12 text-muted-foreground">{m.month}</span>
                <div className="flex-1 bg-muted rounded h-3">
                  <div className="bg-primary/70 h-3 rounded" style={{ width: `${(m.net / maxMonth) * 100}%` }} />
                </div>
                <span className="w-20 text-right">{formatCompact(m.net)}</span>
                <span className="w-16 text-right text-muted-foreground">{m.retailers} ret.</span>
              </div>
            ))}
          </div>
          <div className="mt-2"><Source>secondary register</Source></div>
        </div>
        <div className="border border-border rounded-lg p-4">
          <h4 className="text-sm font-semibold">Top retailers {data.top5SharePct != null && <span className="font-normal text-muted-foreground">— top 5 hold {data.top5SharePct.toFixed(1)}%</span>}</h4>
          <table className="w-full text-xs mt-2">
            <tbody>
              {data.topRetailers.map((r) => (
                <tr key={r.name} className="border-b border-border/50">
                  <td className="py-1 pr-2">{r.name}</td>
                  <td className="py-1 pr-2 text-muted-foreground">{r.salesperson ?? ""}</td>
                  <td className="py-1 text-right">{formatCompact(r.net)} <span className="text-muted-foreground">({r.sharePct.toFixed(1)}%)</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2"><Source>secondary register (salesperson = register head)</Source></div>
        </div>
      </div>

      {/* ── Flow gap — the point of the tab ─────────────────────────── */}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <h4 className="text-sm font-semibold">Flow gap — primary in vs secondary out, at item-code level</h4>
        {!data.primaryMatched ? (
          <p className="text-sm text-muted-foreground">
            No primary-register name matches this distributor under the identity rule, so the flow
            gap cannot be computed. See the Reconciliation panel.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Card title="Primary in (bought from Prayag)" value={formatCompact(data.primaryInTotal)}
                sub={<Source>primary register — {data.primarySaleNames.join("; ")}</Source>} testId="card-flow-in" />
              <Card title="Secondary out (sold to retailers)" value={formatCompact(data.secondaryOutTotal)}
                sub={<Source>secondary register</Source>} testId="card-flow-out" />
              <Card title="Gap" value={data.flowGapTotal != null ? formatCompact(data.flowGapTotal) : "—"}
                sub={`${data.flaggedCodes} code(s) flagged`} testId="card-flow-gap" />
            </div>
            <BothReadings />
            <div>
              <h5 className="text-xs font-semibold text-muted-foreground uppercase">By segment</h5>
              <table className="w-full text-xs mt-1">
                <thead><tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-1 pr-2">Segment</th><th className="py-1 pr-2 text-right">Primary in</th>
                  <th className="py-1 pr-2 text-right">Secondary out</th><th className="py-1 text-right">Gap</th>
                </tr></thead>
                <tbody>
                  {data.flowGapBySegment.slice(0, 12).map((s) => (
                    <tr key={s.segment} className="border-b border-border/50">
                      <td className="py-1 pr-2">{s.segment}</td>
                      <td className="py-1 pr-2 text-right">{formatCompact(s.primaryIn)}</td>
                      <td className="py-1 pr-2 text-right">{formatCompact(s.secondaryOut)}</td>
                      <td className={`py-1 text-right ${s.gap > 0 ? "text-amber-700 dark:text-amber-400" : ""}`}>{formatCompact(s.gap)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h5 className="text-xs font-semibold text-muted-foreground uppercase">
                By code — gross contribution descending (no-cost-data last)
              </h5>
              <p className="text-[11px] text-muted-foreground mb-1">
                Gross contribution = factory cost only. Not profit.
              </p>
              <table className="w-full text-xs mt-1">
                <thead><tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-1 pr-2">Code</th><th className="py-1 pr-2">Segment</th>
                  <th className="py-1 pr-2 text-right">In (qty)</th><th className="py-1 pr-2 text-right">In (₹)</th>
                  <th className="py-1 pr-2 text-right">Out (qty)</th><th className="py-1 pr-2 text-right">Out (₹)</th>
                  <th className="py-1 pr-2 text-right">Gap</th>
                  <th className="py-1 text-right text-emerald-700 dark:text-emerald-400" title="GROSS CONTRIBUTION — factory cost only. Not profit.">Gross contrib</th>
                </tr></thead>
                <tbody>
                  {data.flowGapByCode.slice(0, 25).map((c) => (
                    <tr key={c.code} className={`border-b border-border/50 ${c.flagged ? "bg-amber-50/60 dark:bg-amber-900/10" : ""}`}
                      data-testid={c.flagged ? `row-flagged-${c.code}` : undefined}>
                      <td className="py-1 pr-2 font-medium">{c.flagged && <AlertTriangle className="w-3 h-3 inline mr-1 text-amber-600" />}{c.code}</td>
                      <td className="py-1 pr-2">{c.group ?? "—"}</td>
                      <td className="py-1 pr-2 text-right">{Math.round(c.primaryInQty)}</td>
                      <td className="py-1 pr-2 text-right">{formatCompact(c.primaryInValue)}</td>
                      <td className="py-1 pr-2 text-right">{Math.round(c.secondaryOutQty)}</td>
                      <td className="py-1 pr-2 text-right">{formatCompact(c.secondaryOutValue)}</td>
                      <td className="py-1 pr-2 text-right">{formatCompact(c.gapValue)}</td>
                      <td className="py-1 text-right text-emerald-700 dark:text-emerald-400 font-medium">
                        {c.opportunityContribution != null
                          ? formatCompact(c.opportunityContribution)
                          : <span className="text-muted-foreground italic font-normal text-[10px]">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Tab 2: Existing vs New SKU ───────────────────────────────────────────────

function SkuSideView({ side, label }: { side: SkuSide; label: string }) {
  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <h4 className="text-sm font-semibold">{label} <Source>{side.source}</Source></h4>
      <p className="text-xs text-muted-foreground">{side.baselineNote}</p>
      <div className="grid grid-cols-3 gap-2">
        <Card title="EXISTING SKU" value={formatCompact(side.existing.value)}
          sub={`${side.existing.codes} codes · baseline ${formatCompact(side.existing.baselineValue)} · growth ${formatCompact(side.existing.growth)}`} />
        <Card title="NEW SKU" value={formatCompact(side.fresh.value)}
          sub={`${side.fresh.codes} codes · ${side.fresh.segments.slice(0, 3).join(", ")}`} />
        <Card title="LOST SKU (baseline value)" value={formatCompact(side.lost.value)}
          sub={`${side.lost.codes.length}+ codes gone`} />
      </div>
      <div className="text-sm">
        Growth {formatCompact(side.totalGrowth)}
        {side.existingGrowthShare != null && (
          <span className="text-muted-foreground"> — {side.existingGrowthShare.toFixed(0)}% from existing SKU, {side.newGrowthShare?.toFixed(0)}% from new SKU (share of growth)</span>
        )}
      </div>
      {side.realCurrent != null && (
        <div className="text-sm">
          Real terms: {formatCompact(side.realCurrent)} current ({formatCompact(side.totalCurrent)} nominal)
          {side.realGrowth != null && <> · real growth {formatCompact(side.realGrowth)}</>}
          <div className="text-xs text-muted-foreground mt-0.5">{side.mixNote}</div>
        </div>
      )}
      {side.lost.codes.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Lost codes ranked by baseline value</summary>
          <table className="w-full mt-1">
            <tbody>
              {side.lost.codes.slice(0, 15).map((c) => (
                <tr key={c.code} className="border-b border-border/50">
                  <td className="py-1 pr-2 font-medium">{c.code}</td>
                  <td className="py-1 pr-2">{c.group ?? "—"}</td>
                  <td className="py-1 text-right">{formatCompact(c.baselineValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

export function SkuTabView({ fy, scope, recon, monthsParam = "" }: { fy: string; scope: string; recon: DistributorRecon | null; monthsParam?: string }) {
  const { data, error, loading } = useApi<SkuTab>(
    `${API}/mgmt/distributor-tab?fy=${encodeURIComponent(fy)}&${scope}&tab=sku${monthsParam}`);
  if (loading) return <Spinner label="Comparing SKU populations against the like-months baseline…" />;
  if (error) return <div className="text-sm text-destructive">{error}</div>;
  if (!data) return null;
  return (
    <div className="space-y-4" data-testid="tab-sku">
      <UnattributedBanner recon={recon} />
      <div className="rounded-md border border-sky-500/30 bg-sky-50/60 px-4 py-3 text-sm text-sky-900 dark:bg-sky-900/10 dark:text-sky-300" data-testid="sku-reading">
        {data.reading}
      </div>
      {data.primary && <SkuSideView side={data.primary} label="What they buy (primary)" />}
      {!data.primary && (
        <p className="text-sm text-muted-foreground">No matched primary-register purchases — primary side unavailable (see Reconciliation).</p>
      )}
      {data.secondary && <SkuSideView side={data.secondary} label="What their retailers buy (secondary)" />}
      {!data.secondary && <p className="text-sm text-muted-foreground">No secondary-register rows for this distributor.</p>}
    </div>
  );
}

// ── Tab 3: Where and how to push ─────────────────────────────────────────────

export function PushTabView({ fy, scope, recon, monthsParam = "" }: { fy: string; scope: string; recon: DistributorRecon | null; monthsParam?: string }) {
  const { data, error, loading } = useApi<PushTab>(
    `${API}/mgmt/distributor-tab?fy=${encodeURIComponent(fy)}&${scope}&tab=push${monthsParam}`);
  if (loading) return <Spinner label="Checking the flow gap and building the push list…" />;
  if (error) return <div className="text-sm text-destructive">{error}</div>;
  if (!data) return null;
  const v = data.verdict;
  return (
    <div className="space-y-4" data-testid="tab-push">
      <UnattributedBanner recon={recon} />
      {/* Verdict FIRST */}
      <div
        className={`rounded-lg border px-4 py-3 ${
          v === "PUSH"
            ? "border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-900/10"
            : v === "CLEAR_STOCK_FIRST"
              ? "border-amber-500/50 bg-amber-50/70 dark:bg-amber-900/10"
              : "border-border bg-muted/40"
        }`}
        data-testid="push-verdict"
      >
        <div className="text-base font-bold">
          {v === "PUSH" ? "PUSH" : v === "CLEAR_STOCK_FIRST" ? "CLEAR STOCK FIRST" : "STOCK POSITION UNKNOWN"}
        </div>
        <p className="text-sm mt-1">{data.verdictDetail}</p>
        <p className="text-xs text-muted-foreground mt-1">
          Primary in {formatCompact(data.flowSummary.primaryIn)} vs secondary out {formatCompact(data.flowSummary.secondaryOut)}
          {data.flowSummary.ratio != null && <> · {(data.flowSummary.ratio * 100).toFixed(0)}% flows through</>}
          {" "}· <Source>primary + secondary registers</Source>
        </p>
        {v === "CLEAR_STOCK_FIRST" && <div className="mt-1"><BothReadings /></div>}
      </div>

      {/* Push list — K3 engine */}
      <div className="border border-border rounded-lg p-4 space-y-2">
        <h4 className="text-sm font-semibold">Push list — top {data.recommendations.length}</h4>
        <p className="text-xs text-muted-foreground">{data.pushListSource}</p>
        {data.suppressed && <p className="text-sm text-amber-700">{data.suppressReason}</p>}
        {data.peerNames.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Peer cohort ({data.peerNames.length}): {data.peerNames.join(", ")}
          </p>
        )}
        <div className="space-y-3">
          {data.recommendations.map((r) => (
            <div key={r.code} className="border border-border/60 rounded-md p-3" data-testid={`push-rec-${r.code}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                  r.tier === 1 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
                  : r.tier === 2 ? "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300"
                  : r.tier === 3 ? "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300"
                  : "bg-muted text-muted-foreground"}`}>
                  TIER {r.tier} {r.tierLabel.toUpperCase()}
                </span>
                <span className="font-semibold">{r.code}</span>
                {r.itemName && <span className="text-muted-foreground">{r.itemName}</span>}
                <span className="text-xs text-muted-foreground">· {r.segment}</span>
                {r.overDiscounted && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" data-testid={`flag-overdisc-${r.code}`}>
                    OVER-DISCOUNTED
                  </span>
                )}
              </div>
              <p className="text-xs mt-1">
                <strong>{r.peerCount} of {r.segmentPeerCount} peers your size in your territory buy this and this distributor does not</strong>
                {" "}(peer net {formatCompact(r.peerNet)}).{" "}
                {r.contributionPct != null ? (
                  <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                    Gross contrib {Math.round(r.contributionPct * 100)}%{" "}
                    <span className="font-normal text-muted-foreground text-[10px]">(factory cost only)</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground text-[10px] italic">no cost data</span>
                )}{" "}
                <Source>K3 push engine, peer cohort</Source>
              </p>
              {r.timingNote && (
                <p className="text-xs text-muted-foreground mt-1">
                  Peak quarter {r.peakQuarter}{r.peakQuarterSharePct != null && ` (${r.peakQuarterSharePct}% of FY25-26)`} — {r.timingNote}{" "}
                  <Source>primary register, FY25-26 territory curve</Source>
                </p>
              )}
              {(r.ownDiscountPct != null || r.territoryNormPct != null) && (
                <p className="text-xs text-muted-foreground mt-1">
                  Discount position: own {r.ownDiscountPct != null ? `${r.ownDiscountPct.toFixed(1)}%` : "—"} vs territory
                  norm {r.territoryNormPct != null ? `${r.territoryNormPct.toFixed(1)}%` : "—"}
                  {r.overDiscounted && " — volume on an over-discounted code is a margin question first"}.
                  {" "}<Source>secondary register discount_pct</Source>
                </p>
              )}
              {r.candidateRetailers.length > 0 && (
                <p className="text-xs mt-1">
                  Retailers who could take it:{" "}
                  {r.candidateRetailers.map((cr, i) => (
                    <span key={cr.name}>
                      {i > 0 && ", "}
                      {cr.name} ({formatCompact(cr.segmentNet)} in segment{cr.salesperson ? `, via ${cr.salesperson}` : ""})
                    </span>
                  ))}{" "}
                  <Source>secondary register</Source>
                </p>
              )}
            </div>
          ))}
          {data.recommendations.length === 0 && !data.suppressed && (
            <p className="text-sm text-muted-foreground">No qualifying gap codes from the peer cohort.</p>
          )}
        </div>
      </div>

      {/* Coverage — the administrative push */}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <h4 className="text-sm font-semibold">Coverage — a different kind of push</h4>
        <p className="text-xs text-muted-foreground">{data.coverage.note}</p>
        {data.coverage.unassignedByMember.length > 0 && (
          <div>
            <h5 className="text-xs font-semibold text-muted-foreground uppercase">Unassigned retailers under the serving salespeople</h5>
            <table className="w-full text-xs mt-1">
              <thead><tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-1 pr-2">Salesperson</th><th className="py-1 pr-2">State</th>
                <th className="py-1 pr-2 text-right">Unassigned</th>
                <th className="py-1 pr-2 text-right">Assigned active %</th>
                <th className="py-1 text-right">Unassigned active %</th>
              </tr></thead>
              <tbody>
                {data.coverage.unassignedByMember.map((m) => (
                  <tr key={m.member} className="border-b border-border/50" data-testid={`row-unassigned-${m.member}`}>
                    <td className="py-1 pr-2">{m.member}</td>
                    <td className="py-1 pr-2">{m.state}</td>
                    <td className="py-1 pr-2 text-right">{m.unassigned}</td>
                    <td className="py-1 pr-2 text-right">{m.assignedActivePct != null ? `${m.assignedActivePct.toFixed(1)}%` : "—"}</td>
                    <td className="py-1 text-right">{m.unassignedActivePct != null ? `${m.unassignedActivePct.toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground mt-1">
              Assigning these retailers is an administrative fix — the fastest push available.{" "}
              <Source>member working sheets</Source>
            </p>
          </div>
        )}
        {data.coverage.dormantRetailers.length > 0 && (
          <div>
            <h5 className="text-xs font-semibold text-muted-foreground uppercase">Dormant retailers beneath this distributor (by prior-year value)</h5>
            <table className="w-full text-xs mt-1">
              <tbody>
                {data.coverage.dormantRetailers.slice(0, 12).map((r) => (
                  <tr key={r.name} className="border-b border-border/50">
                    <td className="py-1 pr-2">{r.name}</td>
                    <td className="py-1 pr-2 text-muted-foreground">{r.salesperson ?? ""}</td>
                    <td className="py-1 text-right">{formatCompact(r.priorYearValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Source>secondary register, prior FY</Source>
          </div>
        )}
        {data.coverage.soleCoverageDistricts.length > 0 && (
          <p className="text-xs">
            <strong>Districts only this distributor serves:</strong> {data.coverage.soleCoverageDistricts.join(", ")}{" "}
            <Source>member working sheets</Source>
          </p>
        )}
      </div>
    </div>
  );
}

// ── Panel wrapper ────────────────────────────────────────────────────────────

export type DdTab = "overview" | "secondary" | "sku" | "push";

export function DistributorTabsPanel({ tab, fy, dist, distName, stateHead, geoStates, monthsParam, periodLabel }: {
  tab: Exclude<DdTab, "overview">; fy: string; dist: string; distName: string | null;
  /** Selected state head — scopes Secondary/SKU tabs when no single distributor is picked. */
  stateHead?: string;
  /** Canonical geography states from filter 1 (empty/undefined = All India). */
  geoStates?: string[];
  /** Query fragment from usePeriodMonths().param ("&months=..." or ""). */
  monthsParam?: string;
  /** Human label of the selected period, shown when a sub-year period is active. */
  periodLabel?: string | null;
}) {
  const mp = monthsParam ?? "";
  const { data: recon } = useApi<DistributorRecon>(
    `${API}/mgmt/distributor-recon?fy=${encodeURIComponent(fy)}`);

  // Scope: a single distributor when picked; otherwise the selected head's
  // whole team (Secondary / SKU only — the push tab is per-distributor).
  const headScoped = !dist && !!stateHead && tab !== "push";
  const scope = dist
    ? `dist=${encodeURIComponent(dist)}`
    : `head=${encodeURIComponent(stateHead ?? "")}${geoStates && geoStates.length ? `&states=${encodeURIComponent(geoStates.join(","))}` : ""}`;

  if (!dist && !headScoped) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground border border-border rounded-lg p-4">
          {tab === "push"
            ? <>The push list is built per distributor (peer-cohort comparison). Pick a single distributor in filter&nbsp;2 above to open it. Meanwhile, here is how the two distributor vocabularies reconcile.</>
            : <>Pick a state head in filter&nbsp;3 or a single distributor in filter&nbsp;2 above to open this tab. Meanwhile, here is how the two distributor vocabularies reconcile — the foundation every joined figure rests on.</>}
        </div>
        <ReconPanel fy={fy} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {dist
        ? (distName && <h3 className="text-base font-semibold">{distName}</h3>)
        : (
          <div className="text-xs text-muted-foreground border border-border rounded px-3 py-1.5" data-testid="dd-head-scope-note">
            Showing <strong>{stateHead}</strong>'s whole team — every distributor served by this head
            {geoStates && geoStates.length ? " in the selected geography" : ""}, aggregated. Pick a single
            distributor in filter&nbsp;2 to drill in.
          </div>
        )}
      {mp && periodLabel && (
        <div className="text-xs text-muted-foreground border border-border rounded px-3 py-1.5" data-testid="dd-period-note">
          Register figures below are filtered to <strong>{periodLabel}</strong>. Name reconciliation stays FY-wide.
        </div>
      )}
      {tab === "secondary" && <SecondaryTabView fy={fy} scope={scope} recon={recon} monthsParam={mp} />}
      {tab === "sku" && <SkuTabView fy={fy} scope={scope} recon={recon} monthsParam={mp} />}
      {tab === "push" && <PushTabView fy={fy} scope={scope} recon={recon} monthsParam={mp} />}
    </div>
  );
}
