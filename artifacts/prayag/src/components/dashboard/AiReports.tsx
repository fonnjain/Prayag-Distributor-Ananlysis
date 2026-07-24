import { useState, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, FileDown, Presentation, CheckSquare, Square, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Lightweight payload types (subset used for chart rendering) ────────────────

type AiPayloadSubset = {
  performance?: { secondaryOB: number | null; directDealerOB: number | null; salesReceived: number | null } | null;
  targets?: { toDateTotal: number | null; toDateSecondary: number | null; toDatePrimary: number | null } | null;
  achievement?: { secondaryOBPct: number | null; directDealerPct: number | null; salePct: number | null; totalOBPct: number | null } | null;
  coverage?: { active: number | null; dormant: number | null; nonVisited: number | null } | null;
  customerStates?: {
    retained: { count: number };
    reactivated: { count: number };
    atRisk: { count: number };
    never: { count: number };
  } | null;
  visits?: { distanceBands: { label: string; visitsDone: number; activeCount: number }[] } | null;
  capacity?: { projectionBand: { scenario: string; annual: number }[] } | null;
  priorYears?: { fy: string; visitsDone: number | null }[];
};

type MemberRankingEntry = {
  name: string; totalOB: number; target: number | null; achievementPct: number | null;
};

type GuardResult = {
  status: "ok" | "requires_review";
  unmatched: { extracted: string; value: number; sentence: string }[];
  checked: number;
};

type Section = { title: string; body: string };

type SuggestionItem = {
  rank: number; title: string; metric: string; payloadField: string;
  expectedEffect: string; effort: "low" | "medium" | "high"; action: string;
};

type VisitTarget = {
  name: string; district: string | null; distanceKm: number | null;
  ob: number; priority: "maintain" | "develop" | "reduce"; reason: string;
};

type MonthPlan = {
  month: string; workingDays: number; capacity: number;
  maintenanceVisits: number; developmentVisits: number; targets: VisitTarget[];
};

type ArtifactType = "statehead-report" | "suggestions" | "travel-plan" | "performance-review" | "presentation";

type SlideSpec = {
  slideNumber: number; title: string; subtitle?: string;
  bullets: string[]; commentary: string;
  chartType: "bar" | "pie" | "line" | "none";
  chartDataRef: string;
};

type GenerationResult =
  | { type: "statehead-report"; fy: string; stateHead: string; dataCutoff: string; sections: Record<string, Section>; guard: GuardResult; memberRanking: (MemberRankingEntry & { sale: number })[] }
  | { type: "suggestions"; fy: string; member: string; dataCutoff: string; intro: string; suggestions: SuggestionItem[]; guard: GuardResult }
  | { type: "travel-plan"; fy: string; member: string; dataCutoff: string; sections: Record<string, Section>; guard: GuardResult; monthPlans: MonthPlan[]; visitCapacity: { gap: number; feasibleRemainingVisits: number; remainingRequired: number } | null }
  | { type: "performance-review"; fy: string; member: string; dataCutoff: string; sections: Record<string, Section>; guard: GuardResult; dataQualityFlags: string[] }
  | { type: "presentation"; fy: string; member: string | null; stateHead: string | null; dataCutoff: string; deckTitle: string; deckSubtitle: string; slides: SlideSpec[]; guard: GuardResult; payload: AiPayloadSubset; memberRanking: MemberRankingEntry[] | null };

// ── Chart data helpers ────────────────────────────────────────────────────────

const COLORS = ["#1D4ED8", "#475569", "#94A3B8", "#CBD5E1", "#E2E8F0"];
const cr = (n: number | null | undefined) => n != null ? Math.round(n / 10_000_000 * 100) / 100 : 0;

type RechartsRow = Record<string, string | number>;

function getSlideChartData(
  ref: string,
  payload: AiPayloadSubset,
  memberRanking: MemberRankingEntry[] | null,
): RechartsRow[] | null {
  switch (ref) {
    case "performance": return [
      { name: "Secondary OB", value: cr(payload.performance?.secondaryOB) },
      { name: "Direct Dealer", value: cr(payload.performance?.directDealerOB) },
      { name: "Sale Received", value: cr(payload.performance?.salesReceived) },
      { name: "Target", value: cr(payload.targets?.toDateTotal) },
    ].filter((d) => (d.value as number) > 0);

    case "achievement": return [
      { name: "Sec OB%", value: Math.round(payload.achievement?.secondaryOBPct ?? 0) },
      { name: "DD%", value: Math.round(payload.achievement?.directDealerPct ?? 0) },
      { name: "Sale%", value: Math.round(payload.achievement?.salePct ?? 0) },
      { name: "Total OB%", value: Math.round(payload.achievement?.totalOBPct ?? 0) },
    ].filter((d) => (d.value as number) > 0);

    case "coverage": return [
      { name: "Active", value: payload.coverage?.active ?? 0 },
      { name: "Dormant", value: payload.coverage?.dormant ?? 0 },
      { name: "Not Visited", value: payload.coverage?.nonVisited ?? 0 },
    ].filter((d) => (d.value as number) > 0);

    case "customerStates":
      if (!payload.customerStates) return null;
      return [
        { name: "Retained", value: payload.customerStates.retained.count },
        { name: "Reactivated", value: payload.customerStates.reactivated.count },
        { name: "At Risk", value: payload.customerStates.atRisk.count },
        { name: "Never Active", value: payload.customerStates.never.count },
      ].filter((d) => (d.value as number) > 0);

    case "distanceBands":
      return payload.visits?.distanceBands?.map((b) => ({
        name: b.label, Visits: b.visitsDone, "Active Retailers": b.activeCount,
      })) ?? null;

    case "projectionBand":
      return payload.capacity?.projectionBand?.map((s) => ({
        name: s.scenario, value: cr(s.annual),
      })) ?? null;

    case "teamRanking":
      return memberRanking?.map((m) => ({
        name: m.name.split(" ")[0] ?? m.name,
        "OB (Cr)": cr(m.totalOB),
      })) ?? null;

    case "priorYears":
      return payload.priorYears?.filter((p) => p.visitsDone != null).map((p) => ({
        name: p.fy, Visits: p.visitsDone ?? 0,
      })) ?? null;

    default: return null;
  }
}

// ── Shared PDF export helper ───────────────────────────────────────────────────

function openPrintWindow(html: string, title: string): void {
  const win = window.open("", "_blank", "width=860,height=960");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 350);
}

const PDF_BASE_STYLE = `
  body { font-family: 'Inter', system-ui, sans-serif; color: #0f172a; margin: 40px; line-height: 1.6; }
  .brand { color: #1d4ed8; font-weight: 700; font-size: 18px; margin-bottom: 2px; }
  .meta { color: #64748b; font-size: 11px; margin-bottom: 20px; }
  h2 { font-size: 15px; font-weight: 600; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-top: 20px; color: #1e293b; }
  p { margin: 6px 0; font-size: 13px; }
  .footer { margin-top: 32px; padding-top: 10px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 10px; }
  @media print { body { margin: 20px; } }
`;

function exportSectionsPdf(title: string, meta: string, sections: Record<string, Section>, extra?: string): void {
  const sectionHtml = Object.values(sections).map((s) => `
    <h2>${s.title}</h2>
    <p>${s.body.replace(/\n/g, "<br/>")}</p>
  `).join("");

  openPrintWindow(`<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title><style>${PDF_BASE_STYLE}</style></head><body>
    <div class="brand">Prayag India - Sales Intelligence</div>
    <div class="meta">${title} &middot; ${meta} &middot; Generated ${new Date().toLocaleString()}</div>
    ${sectionHtml}${extra ?? ""}
    <div class="footer">Generated by Prayag India Sales Intelligence. Figures are grounded in the verified payload.</div>
  </body></html>`, title);
}

function exportPerformanceReviewPdf(member: string, sections: Record<string, Section>): void {
  const sectionHtml = Object.values(sections).map((s) => `<h2>${s.title}</h2><p>${s.body.replace(/\n/g, "<br/>")}</p>`).join("");
  const style = `${PDF_BASE_STYLE}
    .watermark { background: #DC2626; color: white; text-align: center; padding: 6px; font-size: 11px; font-weight: 700; border-radius: 4px; margin-bottom: 16px; }
    @media print { .watermark { position: fixed; top: 0; left: 0; right: 0; border-radius: 0; margin-bottom: 0; z-index: 9999; } body { padding-top: 36px; } }
  `;
  openPrintWindow(`<!doctype html><html><head><meta charset="utf-8"/><title>Performance Review — ${member}</title><style>${style}</style></head><body>
    <div class="watermark">MANAGEMENT ONLY — NOT FOR DISTRIBUTION TO THE INDIVIDUAL | DRAFT — REQUIRES HUMAN SIGN-OFF</div>
    <div class="brand">Prayag India - Sales Intelligence</div>
    <div class="meta">Performance Review: ${member} &middot; Generated ${new Date().toLocaleString()}</div>
    ${sectionHtml}
    <div class="footer">MANAGEMENT ONLY. This document must not be shared with the individual named above. Draft status — human sign-off required before use or distribution.</div>
  </body></html>`, "Performance Review");
}

function exportSuggestionsPdf(member: string, intro: string, suggestions: SuggestionItem[]): void {
  const items = suggestions.map((s) => `
    <div style="margin: 14px 0; padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px;">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${s.rank}. ${s.title}
        <span style="margin-left:8px;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:${s.effort === "low" ? "#D1FAE5" : s.effort === "medium" ? "#FEF3C7" : "#FEE2E2"};color:${s.effort === "low" ? "#065F46" : s.effort === "medium" ? "#92400E" : "#991B1B"};">${s.effort} effort</span>
      </div>
      <p style="font-size:12px;color:#475569;margin:2px 0"><strong>Metric:</strong> ${s.metric}</p>
      <p style="font-size:12px;color:#475569;margin:2px 0"><strong>Expected effect:</strong> ${s.expectedEffect}</p>
      <p style="font-size:12px;margin-top:6px;"><strong>Action:</strong> ${s.action}</p>
    </div>
  `).join("");
  openPrintWindow(`<!doctype html><html><head><meta charset="utf-8"/><title>Suggestions — ${member}</title><style>${PDF_BASE_STYLE}</style></head><body>
    <div class="brand">Prayag India - Sales Intelligence</div>
    <div class="meta">Suggestions and Actions: ${member} &middot; Generated ${new Date().toLocaleString()}</div>
    <h2>Introduction</h2><p>${intro}</p>
    <h2>Ranked Suggestions</h2>${items}
    <div class="footer">Generated by Prayag India Sales Intelligence. Figures are grounded in the verified payload.</div>
  </body></html>`, "Suggestions");
}

function exportTravelPlanPdf(member: string, sections: Record<string, Section>, monthPlans: MonthPlan[]): void {
  const monthHtml = monthPlans.map((mp) => `
    <h3 style="font-size:13px;margin-top:14px;color:#1e293b;">${mp.month} — ${mp.workingDays} working days, ${mp.capacity} visits allocated (${mp.maintenanceVisits} maintenance, ${mp.developmentVisits} development)</h3>
    <table style="border-collapse:collapse;width:100%;margin:6px 0;font-size:11px;">
      <tr style="background:#f1f5f9;"><th style="padding:4px 8px;text-align:left;border:1px solid #cbd5e1;">Name</th><th style="padding:4px 8px;border:1px solid #cbd5e1;">District</th><th style="padding:4px 8px;border:1px solid #cbd5e1;">Dist km</th><th style="padding:4px 8px;border:1px solid #cbd5e1;">Priority</th><th style="padding:4px 8px;border:1px solid #cbd5e1;">Reason</th></tr>
      ${mp.targets.map((t) => `<tr><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.name}</td><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.district ?? "—"}</td><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.distanceKm ?? "—"}</td><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.priority}</td><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.reason}</td></tr>`).join("")}
    </table>
  `).join("");
  exportSectionsPdf(`Travel and Visit Plan — ${member}`, member, sections, `<h2>Month-by-Month Visit Plan (App-Computed)</h2>${monthHtml}`);
}

// ── PPTX export ───────────────────────────────────────────────────────────────

async function exportPptx(result: Extract<GenerationResult, { type: "presentation" }>): Promise<void> {
  const pptxgen = (await import("pptxgenjs")).default;
  const prs = new pptxgen();
  prs.layout = "LAYOUT_WIDE";

  // Title slide
  const titleSlide = prs.addSlide();
  titleSlide.background = { color: "1E3A8A" };
  titleSlide.addText(result.deckTitle, { x: 0.5, y: 2.2, w: 9, h: 1.2, fontSize: 36, color: "FFFFFF", bold: true, align: "center" });
  titleSlide.addText(result.deckSubtitle, { x: 0.5, y: 3.6, w: 9, h: 0.7, fontSize: 18, color: "BFDBFE", align: "center" });
  titleSlide.addText(`Data as of ${result.dataCutoff} | FY${result.fy} | Prayag India Sales Intelligence`, { x: 0.5, y: 4.6, w: 9, h: 0.4, fontSize: 11, color: "93C5FD", align: "center" });

  for (const slide of result.slides) {
    const pSlide = prs.addSlide();
    pSlide.addText(slide.title, { x: 0.4, y: 0.18, w: 9.2, h: 0.6, fontSize: 20, bold: true, color: "1E293B" });
    if (slide.subtitle) {
      pSlide.addText(slide.subtitle, { x: 0.4, y: 0.78, w: 9.2, h: 0.32, fontSize: 12, color: "64748B" });
    }

    const hasChart = slide.chartType !== "none" && slide.chartDataRef !== "none";
    const recharts = hasChart ? getSlideChartData(slide.chartDataRef, result.payload, result.memberRanking) : null;

    // Build pptxgenjs chart data
    if (recharts && recharts.length > 0) {
      const numericKeys = Object.keys(recharts[0]).filter((k) => k !== "name" && typeof recharts[0][k] === "number");
      if (numericKeys.length > 0) {
        const pptxData = numericKeys.map((key) => ({
          name: key,
          labels: recharts.map((r) => String(r.name)),
          values: recharts.map((r) => Number(r[key] ?? 0)),
        }));
        try {
          pSlide.addChart(slide.chartType === "pie" ? "pie" : "bar" as any, pptxData as any, {
            x: 0.4, y: 1.15, w: hasChart && slide.bullets.length > 0 ? 5.4 : 9.2, h: 3.5,
            showValue: true, dataLabelFontSize: 9,
          } as any);
        } catch { /* chart creation can fail for edge-case data shapes */ }
      }
    }

    // Bullets
    if (slide.bullets.length > 0) {
      const bulletRows = slide.bullets.map((b) => ({ text: b, options: { bullet: { type: "bullet" as const }, fontSize: 11, color: "1E293B" } }));
      pSlide.addText(bulletRows, {
        x: recharts ? 5.95 : 0.4,
        y: 1.15, w: recharts ? 3.7 : 9.2, h: 3.5,
        fontSize: 11, color: "374151", valign: "top",
      } as any);
    }

    if (slide.commentary) {
      pSlide.addText(slide.commentary, { x: 0.4, y: 4.78, w: 9.2, h: 0.5, fontSize: 10, italic: true, color: "64748B" });
    }
  }

  await prs.writeFile({ fileName: `${result.deckTitle}.pptx` } as any);
}

// ── Guard warning banner ───────────────────────────────────────────────────────

function GuardBanner({ guard }: { guard: GuardResult }) {
  if (guard.status === "ok") return null;
  return (
    <div className="flex gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800 mb-4">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{guard.unmatched.length} figure(s) in this report could not be matched to the verified payload. Review before distributing.</span>
    </div>
  );
}

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({ section }: { section: Section }) {
  return (
    <Card className="border-border/50">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm font-semibold">{section.title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-line">{section.body}</p>
      </CardContent>
    </Card>
  );
}

// ── Slide preview ─────────────────────────────────────────────────────────────

function SlidePreview({ slide, payload, memberRanking }: { slide: SlideSpec; payload: AiPayloadSubset; memberRanking: MemberRankingEntry[] | null }) {
  const chartData = slide.chartType !== "none" && slide.chartDataRef !== "none"
    ? getSlideChartData(slide.chartDataRef, payload, memberRanking) : null;
  const hasChart = !!chartData && chartData.length > 0;
  const numericKeys = hasChart ? Object.keys(chartData[0]).filter((k) => k !== "name" && typeof chartData[0][k] === "number") : [];

  return (
    <div className="border rounded-lg p-4 bg-card space-y-2 min-h-[200px]">
      <div className="font-semibold text-sm text-foreground">{slide.title}</div>
      {slide.subtitle && <div className="text-xs text-muted-foreground">{slide.subtitle}</div>}
      <div className={cn("flex gap-4", !hasChart && "flex-col")}>
        {hasChart && (
          <div className="flex-1 min-w-0" style={{ height: 160 }}>
            {slide.chartType === "pie" ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={chartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} label={false}>
                    {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: number) => v.toLocaleString()} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip formatter={(v: number) => v.toLocaleString()} />
                  {numericKeys.map((k, i) => (
                    <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        )}
        {slide.bullets.length > 0 && (
          <ul className="space-y-1 flex-1">
            {slide.bullets.map((b, i) => (
              <li key={i} className="text-xs text-foreground flex gap-1.5 items-start">
                <span className="text-primary mt-0.5">-</span>{b}
              </li>
            ))}
          </ul>
        )}
      </div>
      {slide.commentary && (
        <p className="text-xs text-muted-foreground italic border-t border-border/40 pt-2">{slide.commentary}</p>
      )}
    </div>
  );
}

// ── Month plan accordion ──────────────────────────────────────────────────────

function MonthPlanCard({ mp }: { mp: MonthPlan }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 text-sm font-medium text-left hover:bg-muted/50 transition-colors"
      >
        <span>{mp.month} — {mp.workingDays} working days · {mp.capacity} visits ({mp.maintenanceVisits} maintenance, {mp.developmentVisits} development)</span>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      {open && mp.targets.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/20">
              <tr>
                {["Name", "District", "Dist km", "OB", "Priority", "Reason"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mp.targets.map((t, i) => (
                <tr key={i} className="border-t border-border/40 hover:bg-muted/10">
                  <td className="px-3 py-1.5 font-medium">{t.name}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{t.district ?? "—"}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{t.distanceKm ?? "—"}</td>
                  <td className="px-3 py-1.5">{t.ob > 0 ? `₹${(t.ob / 100000).toFixed(1)}L` : "—"}</td>
                  <td className="px-3 py-1.5">
                    <Badge variant={t.priority === "maintain" ? "default" : t.priority === "develop" ? "secondary" : "outline"} className="text-xs">
                      {t.priority}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground max-w-[200px] truncate">{t.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

const REPORT_TYPES: { id: ArtifactType; label: string; requiresMember?: true; requiresStateHead?: true }[] = [
  { id: "statehead-report",   label: "State Head Report", requiresStateHead: true },
  { id: "suggestions",        label: "Suggestions",       requiresMember: true },
  { id: "travel-plan",        label: "Travel Plan",       requiresMember: true },
  { id: "performance-review", label: "Performance Review",requiresMember: true },
  { id: "presentation",       label: "Presentation" },
];

export default function AiReports() {
  const [fy, setFy]             = useState("2026-27");
  const [stateHead, setStateHead] = useState("");
  const [member, setMember]     = useState("");
  const [reportType, setReportType] = useState<ArtifactType>("statehead-report");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [result, setResult]     = useState<GenerationResult | null>(null);
  const [signedOff, setSignedOff] = useState(false);

  const isEnabled = useCallback((type: ArtifactType) => {
    const def = REPORT_TYPES.find((r) => r.id === type)!;
    if (def.requiresMember && !member.trim()) return false;
    if (def.requiresStateHead && !stateHead.trim()) return false;
    return true;
  }, [member, stateHead]);

  const canGenerate = isEnabled(reportType);

  const generate = async () => {
    setIsLoading(true);
    setError(null);
    setResult(null);
    setSignedOff(false);

    const body: Record<string, string> = { fy };
    if (stateHead.trim()) body.stateHead = stateHead.trim();
    if (member.trim()) body.member = member.trim();

    const endpoint = `/api/ai/${reportType}`;
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error((e as { error?: string }).error ?? "Request failed");
      }
      const data = await resp.json() as Record<string, unknown>;
      setResult({ type: reportType, ...data } as GenerationResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Inputs */}
      <Card className="border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">AI Report Generator</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ai-fy" className="text-xs">Financial Year</Label>
              <Input id="ai-fy" value={fy} onChange={(e) => setFy(e.target.value)} placeholder="2026-27" className="h-8 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-sh" className="text-xs">State Head (exact name)</Label>
              <Input id="ai-sh" value={stateHead} onChange={(e) => setStateHead(e.target.value)} placeholder="e.g. Anant Singh" className="h-8 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-mb" className="text-xs">Member (for member-level reports)</Label>
              <Input id="ai-mb" value={member} onChange={(e) => setMember(e.target.value)} placeholder="e.g. Rahul Singh" className="h-8 text-sm" />
            </div>
          </div>

          {/* Report type selector */}
          <div className="flex flex-wrap gap-2">
            {REPORT_TYPES.map((rt) => (
              <button
                key={rt.id}
                onClick={() => { setReportType(rt.id); setResult(null); setSignedOff(false); }}
                disabled={!isEnabled(rt.id)}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                  reportType === rt.id
                    ? "bg-primary text-primary-foreground border-primary"
                    : isEnabled(rt.id)
                    ? "border-border text-foreground hover:bg-muted"
                    : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
                )}
              >
                {rt.label}
                {rt.requiresMember && !member.trim() && (
                  <span className="ml-1 text-[10px] opacity-60">(needs member)</span>
                )}
                {rt.requiresStateHead && !stateHead.trim() && (
                  <span className="ml-1 text-[10px] opacity-60">(needs state head)</span>
                )}
              </button>
            ))}
          </div>

          <Button onClick={generate} disabled={isLoading || !canGenerate} size="sm">
            {isLoading ? "Generating..." : "Generate"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {/* Results */}
      {result && (
        <div className="space-y-4">
          <GuardBanner guard={result.guard} />

          {/* ── State Head Report ── */}
          {result.type === "statehead-report" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.stateHead} — State Head Report</p>
                  <p className="text-xs text-muted-foreground">Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => exportSectionsPdf(`State Head Report — ${result.stateHead}`, result.dataCutoff, result.sections)}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              <div className="space-y-3">
                {Object.values(result.sections).map((s, i) => <SectionCard key={i} section={s} />)}
              </div>
              {result.memberRanking.length > 0 && (
                <Card className="border-border/50">
                  <CardHeader className="py-3 px-4"><CardTitle className="text-sm font-semibold">Member Ranking by Total OB</CardTitle></CardHeader>
                  <CardContent className="px-4 pb-4 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="border-b border-border/40">
                        {["Rank", "Member", "Total OB (Cr)", "Target (Cr)", "Achievement %", "Sale (Cr)"].map((h) => (
                          <th key={h} className="py-2 px-2 text-left font-medium text-muted-foreground">{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {result.memberRanking.map((m, i) => (
                          <tr key={i} className="border-t border-border/30 hover:bg-muted/20">
                            <td className="py-1.5 px-2 text-muted-foreground">{i + 1}</td>
                            <td className="py-1.5 px-2 font-medium">{m.name}</td>
                            <td className="py-1.5 px-2">{cr(m.totalOB).toFixed(2)}</td>
                            <td className="py-1.5 px-2">{m.target != null ? cr(m.target).toFixed(2) : "—"}</td>
                            <td className="py-1.5 px-2">{m.achievementPct != null ? `${m.achievementPct.toFixed(1)}%` : "—"}</td>
                            <td className="py-1.5 px-2">{cr(m.sale).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* ── Suggestions ── */}
          {result.type === "suggestions" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.member} — Suggestions and Actions</p>
                  <p className="text-xs text-muted-foreground">Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => exportSuggestionsPdf(result.member, result.intro, result.suggestions)}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              <Card className="border-border/50">
                <CardContent className="px-4 py-3">
                  <p className="text-sm text-muted-foreground">{result.intro}</p>
                </CardContent>
              </Card>
              <div className="space-y-3">
                {result.suggestions.map((s) => (
                  <Card key={s.rank} className="border-border/50">
                    <CardContent className="px-4 py-3 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold">{s.rank}. {s.title}</p>
                        <Badge variant={s.effort === "low" ? "default" : s.effort === "medium" ? "secondary" : "destructive"} className="text-xs flex-shrink-0">
                          {s.effort} effort
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground"><span className="font-medium">Metric:</span> {s.metric}</p>
                      <p className="text-xs text-muted-foreground"><span className="font-medium">Expected effect:</span> {s.expectedEffect}</p>
                      <p className="text-xs mt-1 p-2 bg-muted/30 rounded"><span className="font-medium">Action:</span> {s.action}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}

          {/* ── Travel Plan ── */}
          {result.type === "travel-plan" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.member} — Travel and Visit Plan</p>
                  <p className="text-xs text-muted-foreground">Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => exportTravelPlanPdf(result.member, result.sections, result.monthPlans)}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              {result.visitCapacity && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Visits Feasible", value: result.visitCapacity.feasibleRemainingVisits },
                    { label: "Visits Required", value: result.visitCapacity.remainingRequired },
                    { label: "Shortfall", value: result.visitCapacity.gap, highlight: result.visitCapacity.gap < 0 },
                  ].map((kpi) => (
                    <div key={kpi.label} className={cn("rounded-lg border p-3 text-center", kpi.highlight ? "border-destructive/30 bg-destructive/5" : "border-border/50")}>
                      <p className="text-lg font-bold">{kpi.value}</p>
                      <p className="text-xs text-muted-foreground">{kpi.label}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-3">
                {Object.values(result.sections).map((s, i) => <SectionCard key={i} section={s} />)}
              </div>
              {result.monthPlans.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">Month-by-Month Plan (App-Computed)</p>
                  {result.monthPlans.map((mp, i) => <MonthPlanCard key={i} mp={mp} />)}
                </div>
              )}
            </>
          )}

          {/* ── Performance Review ── */}
          {result.type === "performance-review" && (
            <>
              <div className="rounded-lg p-3 bg-destructive/10 border border-destructive/30 text-sm font-semibold text-destructive">
                MANAGEMENT ONLY — NOT FOR DISTRIBUTION TO THE INDIVIDUAL | DRAFT — REQUIRES HUMAN SIGN-OFF
              </div>
              <div>
                <p className="text-sm font-semibold">{result.member} — Performance Review</p>
                <p className="text-xs text-muted-foreground">Data to {result.dataCutoff} · Flags: {result.dataQualityFlags.join(", ") || "none"}</p>
              </div>
              <div className="space-y-3">
                {Object.values(result.sections).map((s, i) => <SectionCard key={i} section={s} />)}
              </div>
              {/* Sign-off gate */}
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
                <p className="text-sm font-medium text-amber-900">This document is a draft. It must not be distributed to {result.member}. Sign off below to enable export.</p>
                <button
                  onClick={() => setSignedOff((v) => !v)}
                  className="flex items-center gap-2 text-sm text-amber-800 hover:text-amber-900"
                >
                  {signedOff ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                  I confirm this review is for internal management use only and will not be shared with the individual named above.
                </button>
                {signedOff && (
                  <Button size="sm" variant="outline" onClick={() => exportPerformanceReviewPdf(result.member, result.sections)}>
                    <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF (Management Only)
                  </Button>
                )}
              </div>
            </>
          )}

          {/* ── Presentation ── */}
          {result.type === "presentation" && (
            <>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <p className="text-sm font-semibold">{result.deckTitle}</p>
                  <p className="text-xs text-muted-foreground">{result.deckSubtitle} · Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" onClick={() => exportPptx(result)}>
                  <Presentation className="w-3.5 h-3.5 mr-1.5" />Download PPTX
                </Button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {result.slides.map((slide, i) => (
                  <SlidePreview key={i} slide={slide} payload={result.payload} memberRanking={result.memberRanking} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
