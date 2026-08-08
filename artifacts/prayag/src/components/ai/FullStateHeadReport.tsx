// Renderer for the full structured state head report (9 sections).
import { trunc2 } from "@/lib/trunc";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle, Info } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type MemberRow = {
  name: string;
  net: number | null;
  priorNet: number | null;
  netGrowthPct: number | null;
  retailersDeclared: number | null;
  retailersDeclaredSource: string;
  retailersFromSheet: number | null;
  retailersFromSheetSource: string;
  achievementPct: number | null;
  target: number | null;
  hasTarget: boolean;
  targetNote: string | null;
};

type DistrictRow = { district: string; count: number };

type TierCount = { tier: "A" | "B" | "C" | "unscored"; count: number };

type ConcentrationFlag = { name: string; sharePct: number };

type LargestDep = { distributorName: string; retailerName: string; sharePct: number } | null;

type RangeGapRow = {
  distributorName: string;
  codesBought: number | null;
  peerMedianCodes: number | null;
  gapValue: number | null;
  gapValueNote?: string;
};

type Shrinker = {
  name: string;
  net: number | null;
  priorNet: number | null;
  netGrowthPct: number | null;
  qtyGrowthPct: number | null;
};

type SilentDist = { name: string; daysSilent: number; lastOrderDate: string | null };

type SchemeNudge = {
  customer: string;
  extraEarn: number | null;
  extraRoi: number | null;
  gap: number;
  billedSoFar: number | null;
};

type RankedAction = {
  action: string;
  namesInvolved: string[];
  urgency: "immediate" | "this-week" | "this-month";
};

export type FullStateHeadReportData = {
  type: "full-statehead-report";
  fy: string;
  stateHead: string;
  periodLabel: string;
  priorPeriodLabel: string;
  monthFrom: number;
  monthTo: number;
  dataCutoff: string;
  generatedAt: string;
  headline: {
    periodLabel: string;
    priorPeriodLabel: string;
    teamNet: number | null;
    teamNetSource: string;
    teamQty: number | null;
    teamQtySource: string;
    achievementPct: number | null;
    target: number | null;
    targetSource: string;
    activeMemberCount: number | null;
    totalMemberCount: number | null;
  };
  teamTable: { members: MemberRow[] };
  coverage: {
    periodLabel: string;
    distributorCount: number | null;
    retailerCount: number | null;
    distributorRetailerCount: number | null;
    unassignedRetailerCount: number | null;
    assignmentGapDistricts: DistrictRow[];
    assignmentGapDistrictsSource: string;
  };
  distributorMix: {
    tierCounts: TierCount[];
    concentrationFlags: ConcentrationFlag[];
    largestRetailerDependency: LargestDep;
  };
  range: {
    excludesProject: true;
    excludesProjectNote: string;
    stateCodesBought: number | null;
    stateCodesBoughtNote: string;
    nationalMedianCodes: number | null;
    nationalMedianCodesSource: string;
    top5ByGapValue: RangeGapRow[];
  };
  attention: {
    hiddenShrinkers: Shrinker[];
    silentDistributors: SilentDist[];
  };
  schemes: {
    quarter: string | null;
    deadline: string | null;
    nudges: SchemeNudge[];
    totalGapToClose: number | null;
  };
  whatToDo: { rankedActions: RankedAction[] };
  notAvailable: { items: { item: string; reason: string }[] };
  guard: { status: "ok" | "requires_review"; unmatched: unknown[]; checked: number };
};

// ── Layout helpers ─────────────────────────────────────────────────────────────

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

function Note({ text }: { text: string }) {
  return (
    <p className="text-[10px] text-muted-foreground italic mt-1 flex gap-1">
      <Info className="h-3 w-3 shrink-0 mt-0.5" />{text}
    </p>
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

function urgencyBadge(u: RankedAction["urgency"]) {
  const cls: Record<typeof u, string> = {
    immediate:  "bg-red-100   text-red-800   dark:bg-red-900/40   dark:text-red-300",
    "this-week":"bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    "this-month":"bg-blue-100 text-blue-800  dark:bg-blue-900/40  dark:text-blue-300",
  };
  const label: Record<typeof u, string> = {
    immediate: "Now", "this-week": "This week", "this-month": "This month",
  };
  return <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap", cls[u])}>{label[u]}</span>;
}

function GuardBanner({ guard }: { guard: FullStateHeadReportData["guard"] }) {
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

// ── Main component ─────────────────────────────────────────────────────────────

export default function FullStateHeadReport({ data }: { data: FullStateHeadReportData }) {
  const { headline, teamTable, coverage, distributorMix, range, attention, schemes, whatToDo, notAvailable, guard } = data;

  return (
    <div className="text-sm max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6 pb-3 border-b">
        <h1 className="text-base font-semibold">{data.stateHead}</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          State Head Report · FY {data.fy} · {data.periodLabel}
        </p>
        <p className="text-[10px] text-muted-foreground">
          Data cutoff: {data.dataCutoff} · Generated: {new Date(data.generatedAt).toLocaleString()}
        </p>
      </div>

      <GuardBanner guard={guard} />

      {/* §1 Headline */}
      <Section n={1} title="Headline" period={`${headline.periodLabel} vs ${headline.priorPeriodLabel}`}>
        <Row label="Team net sales"      value={Cr(headline.teamNet)} note={headline.teamNetSource} />
        <Row label="Team quantity"       value={headline.teamQty != null ? `${headline.teamQty.toLocaleString("en-IN")} pcs` : "not recorded"} note={headline.teamQtySource} />
        <Row label="Achievement"         value={headline.achievementPct != null ? `${headline.achievementPct.toFixed(2)}%` : "not recorded"} />
        <Row label="Target"              value={Cr(headline.target)} note={headline.targetSource} />
        <Row label="Active members"      value={headline.activeMemberCount != null ? `${headline.activeMemberCount} of ${headline.totalMemberCount ?? "?"}` : "not recorded"} />
      </Section>

      {/* §2 Team table */}
      <Section n={2} title="Team Table" period={headline.periodLabel}>
        <p className="text-[10px] text-muted-foreground mb-2 italic">
          Retailers declared = secondary order file count.
          Retailers from sheet = Retailer Master in member working sheet.
          Both figures are shown where available — they are labelled separately.
        </p>
        {teamTable.members.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">Member data not available.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b text-muted-foreground text-left">
                  <th className="pb-1 font-medium">Name</th>
                  <th className="pb-1 font-medium text-right">Net</th>
                  <th className="pb-1 font-medium text-right">Growth</th>
                  <th className="pb-1 font-medium text-right">Declared</th>
                  <th className="pb-1 font-medium text-right">From sheet</th>
                  <th className="pb-1 font-medium text-right">Achievement</th>
                </tr>
              </thead>
              <tbody>
                {teamTable.members.map((m, i) => (
                  <tr key={i} className="border-b border-muted/40">
                    <td className="py-0.5">{m.name}</td>
                    <td className="py-0.5 text-right">{Cr(m.net)}</td>
                    <td className={cn("py-0.5 text-right",
                      m.netGrowthPct != null && m.netGrowthPct >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"
                    )}>
                      {m.netGrowthPct != null ? `${m.netGrowthPct.toFixed(1)}%` : "—"}
                    </td>
                    <td className="py-0.5 text-right">{m.retailersDeclared ?? "—"}</td>
                    <td className="py-0.5 text-right text-muted-foreground">
                      {m.retailersFromSheet != null ? m.retailersFromSheet : "not loaded"}
                    </td>
                    <td className="py-0.5 text-right">
                      {m.hasTarget
                        ? (m.achievementPct != null ? `${m.achievementPct.toFixed(1)}%` : "—")
                        : <span className="text-muted-foreground italic text-[10px]">{m.targetNote}</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-muted-foreground mt-1">
              Declared retailers: {teamTable.members[0]?.retailersDeclaredSource ?? "secondary order file"}.
              Sheet retailers: {teamTable.members[0]?.retailersFromSheetSource ?? "not loaded in this request"}.
            </p>
          </div>
        )}
      </Section>

      {/* §3 Coverage */}
      <Section n={3} title="Coverage" period={coverage.periodLabel}>
        <Row label="Distributors"         value={coverage.distributorCount != null ? coverage.distributorCount : "not recorded"} />
        <Row label="Total retailers"      value={coverage.retailerCount != null ? coverage.retailerCount : "not recorded"} />
        <Row label="Named to distributors" value={coverage.distributorRetailerCount != null ? coverage.distributorRetailerCount : "not recorded"} />
        <Row label="Unassigned retailers" value={coverage.unassignedRetailerCount != null ? coverage.unassignedRetailerCount : "not recorded"}
             note={coverage.assignmentGapDistrictsSource} />
        {coverage.assignmentGapDistricts.length > 0 && (
          <div className="mt-2">
            <p className="text-[10px] font-medium text-muted-foreground mb-1">Districts with unassigned retailers</p>
            <div className="grid grid-cols-2 gap-x-4">
              {coverage.assignmentGapDistricts.map(d => (
                <div key={d.district} className="flex justify-between text-[11px] border-b border-muted/40 py-0.5">
                  <span>{d.district}</span>
                  <span className="font-medium">{d.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* §4 Distributor mix */}
      <Section n={4} title="Distributor Mix" period={data.fy}>
        {distributorMix.tierCounts.length > 0 && (
          <div className="mb-3">
            <p className="text-[10px] font-medium text-muted-foreground mb-1">Distributors by tier</p>
            <div className="flex gap-6">
              {distributorMix.tierCounts.map(tc => (
                <div key={tc.tier} className="text-center">
                  <div className={cn("text-lg font-bold", {
                    A: "text-emerald-700 dark:text-emerald-400",
                    B: "text-amber-700 dark:text-amber-400",
                    C: "text-red-700 dark:text-red-400",
                    unscored: "text-muted-foreground",
                  }[tc.tier])}>{tc.count}</div>
                  <div className="text-[10px] text-muted-foreground">{tc.tier}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {distributorMix.concentrationFlags.length > 0 && (
          <div className="mb-3">
            <p className="text-[10px] font-medium text-amber-700 dark:text-amber-400 mb-1">
              Concentration above 60% of territory OB
            </p>
            {distributorMix.concentrationFlags.map(f => (
              <div key={f.name} className="text-[11px] flex gap-2">
                <span className="font-medium">{f.name}</span>
                <span className="text-amber-700 dark:text-amber-400">{f.sharePct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        )}
        {distributorMix.concentrationFlags.length === 0 && (
          <p className="text-[11px] text-muted-foreground">No distributor exceeds 60% concentration.</p>
        )}
        {distributorMix.largestRetailerDependency && (
          <div className="mt-2 border-t pt-2">
            <p className="text-[10px] font-medium text-muted-foreground mb-1">Largest single-retailer dependency</p>
            <p className="text-[11px]">
              {distributorMix.largestRetailerDependency.retailerName} at{" "}
              <span className="font-medium">{distributorMix.largestRetailerDependency.sharePct.toFixed(1)}%</span>{" "}
              of {distributorMix.largestRetailerDependency.distributorName}
            </p>
          </div>
        )}
      </Section>

      {/* §5 Range */}
      <Section n={5} title="Range" period={data.periodLabel}>
        <p className="text-[10px] text-muted-foreground mb-2 italic">{range.excludesProjectNote}</p>
        <Row label="State codes bought"   value={range.stateCodesBought != null ? range.stateCodesBought : "not recorded"} note={range.stateCodesBoughtNote} />
        <Row label="National peer median" value={range.nationalMedianCodes != null ? range.nationalMedianCodes.toFixed(1) : "not recorded"} note={range.nationalMedianCodesSource} />
        {range.top5ByGapValue.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-medium text-muted-foreground mb-1">Distributors with widest range gap</p>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b text-muted-foreground text-left">
                  <th className="pb-1 font-medium">Distributor</th>
                  <th className="pb-1 font-medium text-right">Codes bought</th>
                  <th className="pb-1 font-medium text-right">Peer median</th>
                  <th className="pb-1 font-medium text-right">Gap</th>
                </tr>
              </thead>
              <tbody>
                {range.top5ByGapValue.map((r, i) => (
                  <tr key={i} className="border-b border-muted/40">
                    <td className="py-0.5">{r.distributorName}</td>
                    <td className="py-0.5 text-right">{r.codesBought ?? "—"}</td>
                    <td className="py-0.5 text-right">{r.peerMedianCodes != null ? r.peerMedianCodes.toFixed(1) : "—"}</td>
                    <td className="py-0.5 text-right text-amber-700 dark:text-amber-400">
                      {r.codesBought != null && r.peerMedianCodes != null
                        ? `+${(r.peerMedianCodes - r.codesBought).toFixed(1)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {range.top5ByGapValue[0]?.gapValueNote && (
              <Note text={range.top5ByGapValue[0].gapValueNote} />
            )}
          </div>
        )}
        {range.top5ByGapValue.length === 0 && range.stateCodesBought == null && (
          <p className="text-[11px] text-muted-foreground italic mt-2">SKU spread data not available for this state head.</p>
        )}
      </Section>

      {/* §6 Attention */}
      <Section n={6} title="Attention" period={`${data.periodLabel} vs ${data.priorPeriodLabel}`}>
        <div className="space-y-4">
          {/* Hidden shrinkers */}
          <div>
            <p className="text-[10px] font-medium text-muted-foreground mb-1">
              Hidden shrinkers — value up, quantity down (territory; project channel excluded)
            </p>
            {attention.hiddenShrinkers.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">None detected.</p>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b text-muted-foreground text-left">
                    <th className="pb-1 font-medium">Distributor</th>
                    <th className="pb-1 font-medium text-right">Net growth</th>
                    <th className="pb-1 font-medium text-right">Qty growth</th>
                    <th className="pb-1 font-medium text-right">Current net</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.hiddenShrinkers.map((s, i) => (
                    <tr key={i} className="border-b border-muted/40">
                      <td className="py-0.5">{s.name}</td>
                      <td className="py-0.5 text-right text-emerald-700 dark:text-emerald-400">
                        {s.netGrowthPct != null ? `+${s.netGrowthPct.toFixed(1)}%` : "—"}
                      </td>
                      <td className="py-0.5 text-right text-red-700 dark:text-red-400">
                        {s.qtyGrowthPct != null ? `${s.qtyGrowthPct.toFixed(1)}%` : "—"}
                      </td>
                      <td className="py-0.5 text-right">{Cr(s.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Silent distributors */}
          <div>
            <p className="text-[10px] font-medium text-muted-foreground mb-1">
              Silent distributors — no primary order in 6+ weeks (≥42 days)
            </p>
            {attention.silentDistributors.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">None detected.</p>
            ) : (
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b text-muted-foreground text-left">
                    <th className="pb-1 font-medium">Distributor</th>
                    <th className="pb-1 font-medium text-right">Days silent</th>
                    <th className="pb-1 font-medium text-right">Last order</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.silentDistributors.map((d, i) => (
                    <tr key={i} className="border-b border-muted/40">
                      <td className="py-0.5">{d.name}</td>
                      <td className="py-0.5 text-right text-red-700 dark:text-red-400">{d.daysSilent}d</td>
                      <td className="py-0.5 text-right text-muted-foreground">{d.lastOrderDate ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Section>

      {/* §7 Schemes */}
      <Section n={7} title="Schemes" period={schemes.quarter ?? data.fy}>
        {schemes.nudges.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">No qualifying scheme nudges in this state for {schemes.quarter}.</p>
        ) : (
          <>
            <Row label="Total gap to close" value={Cr(schemes.totalGapToClose)} />
            <Row label="Deadline"           value={schemes.deadline ?? "not recorded"} />
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b text-muted-foreground text-left">
                    <th className="pb-1 font-medium">Distributor</th>
                    <th className="pb-1 font-medium text-right">Extra Earn</th>
                    <th className="pb-1 font-medium text-right">Extra ROI</th>
                    <th className="pb-1 font-medium text-right">Gap</th>
                    <th className="pb-1 font-medium text-right">Billed so far</th>
                  </tr>
                </thead>
                <tbody>
                  {schemes.nudges.map((n, i) => (
                    <tr key={i} className="border-b border-muted/40">
                      <td className="py-0.5">{n.customer}</td>
                      <td className="py-0.5 text-right">{Lk(n.extraEarn)}</td>
                      <td className="py-0.5 text-right">{n.extraRoi != null ? `${n.extraRoi.toFixed(2)}%` : "—"}</td>
                      <td className="py-0.5 text-right">{Cr(n.gap)}</td>
                      <td className="py-0.5 text-right text-muted-foreground">{Cr(n.billedSoFar)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      {/* §8 What to do */}
      <Section n={8} title="What to Do" period={data.periodLabel}>
        {whatToDo.rankedActions.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">Not generated.</p>
        ) : (
          <div className="space-y-2">
            {whatToDo.rankedActions.map((a, i) => (
              <div key={i} className="flex gap-3 items-start py-1 border-b border-muted last:border-0">
                <span className="text-[10px] text-muted-foreground w-4 shrink-0 mt-0.5">{i + 1}</span>
                {urgencyBadge(a.urgency)}
                <div className="flex-1">
                  <p className="text-[11px]">{a.action}</p>
                  {a.namesInvolved.length > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      {a.namesInvolved.join(", ")}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* §9 Not available */}
      <Section n={9} title="Not Available" period="">
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
