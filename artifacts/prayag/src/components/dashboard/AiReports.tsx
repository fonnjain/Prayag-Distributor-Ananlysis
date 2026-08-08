import { trunc2 } from "@/lib/trunc";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import FullDistributorReport, { type FullDistributorReportData } from "@/components/ai/FullDistributorReport";
import FullStateHeadReport, { type FullStateHeadReportData } from "@/components/ai/FullStateHeadReport";
import FullGrowthReport, { type FullGrowthReportData } from "@/components/ai/FullGrowthReport";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, FileDown, Presentation, CheckSquare, Square, ChevronDown, ChevronRight, Download, Loader2, Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { useGlobalFilter } from "@/data/global-filter-context";

// ── Payload type subsets (only fields needed for chart rendering) ──────────────

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

type DistributorPayloadSubset = {
  channelStructure?: {
    namedDistributorRetailers: number;
    directDealerRetailers: number;
    unassignedRetailers: number;
    distributorCount: number;
    partyObTotal: number;
    directDealerOb: number;
    unassignedOb: number;
  };
  distributors?: Array<{
    name: string;
    orderBooking: number;
    obSharePct: number | null;
    isConcentrationRisk: boolean;
    retailerCount: number;
    activeCount: number;
    dormantCount: number;
    flows: { primaryDispatch: number; secondaryOut: number; flowGap: number | null; hasPrimaryData: boolean } | null;
    tier: { tier: "A" | "B" | "C"; score: number; visitCadence: string; creditPosture: string; isOverridden: boolean } | null;
    effectiveDiscountPct: number | null;
    topRetailerName: string | null;
    topRetailerSharePct: number | null;
  }>;
  whitespace?: {
    totalAssignmentGapRetailers: number;
    totalAssignmentGapDistricts: number;
    totalCoverageGapRetailers: number;
    totalCoverageGapDistricts: number;
    coverageGapPriorYearOb: number;
    channelConflictCount: number;
    coverageGapDistricts: { district: string; priorYearOb: number }[];
    assignmentGapDistricts: { district: string; noneCount: number }[];
  } | null;
  dataQuality?: { code: string; message: string }[];
};

// ── Shared result types ───────────────────────────────────────────────────────

type MemberRankingEntry = {
  name: string; totalOB: number; target: number | null; achievementPct: number | null;
};

type GuardResult = {
  status: "ok" | "requires_review";
  unmatched: { extracted: string; value: number; sentence: string }[];
  checked: number;
};

type PeriodGuardResult = {
  status: "ok" | "requires_review";
  flagged: { sentence: string; termMentioned: string; reason: string }[];
};

// Period metadata returned by every AI report API response
type PeriodMeta = {
  periodCoveredLabel?: string;   // "year to date, April to June 2026"
  periodCoveredShort?: string;   // "YTD-Apr-Jun-2026"
  selectedPeriod?: string;       // what the user had selected ("ytd", "q1", etc.)
  periodMismatch?: boolean;      // selectedPeriod !== "ytd"
  periodGuard?: PeriodGuardResult;
};

// Helper to extract PeriodMeta from a result object
function periodMetaOf(r: PeriodMeta): { coveredLabel: string; coveredShort: string; mismatch: boolean; selectedPeriod: string } {
  return {
    coveredLabel: r.periodCoveredLabel ?? "year to date",
    coveredShort: r.periodCoveredShort ?? "YTD",
    mismatch: r.periodMismatch ?? false,
    selectedPeriod: r.selectedPeriod ?? "ytd",
  };
}

type Section = { title: string; body: string };

// ── Batch types ───────────────────────────────────────────────────────────────

type BatchDocStatus = {
  member: string;
  status: "queued" | "generating" | "done" | "cached" | "failed";
  source?: "api" | "cache";
  error?: string;
};

type BatchDoc = {
  member: string;
  reportType: string;
  dataCutoff: string;
  source: "api" | "cache";
  result: Record<string, unknown>;
  periodCoveredLabel?: string;
  periodCoveredShort?: string;
  periodMismatch?: boolean;
  selectedPeriod?: string;
};

type BatchSummary = { total: number; cached: number; generated: number; failed: number };

type BatchEvent =
  | { type: "batch_start"; total: number; memberNames: string[] }
  | { type: "member_start"; member: string }
  | { type: "doc_done"; member: string; reportType: string; source: "api" | "cache"; dataCutoff: string; result: Record<string, unknown> }
  | { type: "doc_failed"; member: string; reportType: string; error: string }
  | { type: "batch_done"; summary: BatchSummary }
  | { type: "error"; error: string };

// ── Chat types ────────────────────────────────────────────────────────────────

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  guard?: GuardResult;
};

type SuggestionItem = {
  rank: number; title: string; metric: string; payloadField: string;
  expectedEffect: string; effort: "low" | "medium" | "high"; action: string;
};

type VisitTarget = {
  name: string; district: string | null; distanceKm: number | null;
  ob: number; priority: "maintain" | "develop" | "reduce"; reason: string;
};

type DeckMemberSlide = {
  memberName: string;
  achievementBadge: "teal" | "amber";
  bullets: string[];
  commentary: string;
  unmapped: boolean;
};

type MonthPlan = {
  month: string; workingDays: number; capacity: number;
  maintenanceVisits: number; developmentVisits: number; targets: VisitTarget[];
  poolExhausted?: boolean;
};

type SlideSpec = {
  slideNumber: number; title: string; subtitle?: string;
  bullets: string[]; commentary: string;
  chartType: "bar" | "pie" | "line" | "none";
  chartDataRef: string;
};

// ── Artifact types ────────────────────────────────────────────────────────────

type MemberArtifactType = "statehead-report" | "full-statehead-report" | "suggestions" | "travel-plan" | "performance-review" | "presentation";
type DistributorArtifactType = "distributor-statehead-report" | "distributor-report" | "full-distributor-report" | "distributor-suggestions" | "distributor-review" | "distributor-presentation";
type GrowthReportType = "full-growth-report";
type ArtifactType = MemberArtifactType | DistributorArtifactType | GrowthReportType;

// ── Generation result union ───────────────────────────────────────────────────

type GenerationResult =
  // ── Member / team ──
  | ({ type: "statehead-report"; fy: string; stateHead: string; dataCutoff: string; generatedAt?: string; sections: Record<string, Section>; guard: GuardResult; memberRanking: (MemberRankingEntry & { sale: number })[] } & PeriodMeta)
  | ({ type: "suggestions"; fy: string; member: string; dataCutoff: string; generatedAt?: string; intro: string; suggestions: SuggestionItem[]; guard: GuardResult } & PeriodMeta)
  | ({ type: "travel-plan"; fy: string; member: string; dataCutoff: string; generatedAt?: string; sections: Record<string, Section>; guard: GuardResult; monthPlans: MonthPlan[]; visitCapacity: { gap: number; feasibleRemainingVisits: number; remainingRequired: number } | null } & PeriodMeta)
  | ({ type: "performance-review"; fy: string; member: string; dataCutoff: string; generatedAt?: string; sections: Record<string, Section>; guard: GuardResult; dataQualityFlags: string[] } & PeriodMeta)
  | ({ type: "presentation"; fy: string; member: string | null; stateHead: string | null; dataCutoff: string; generatedAt?: string; deckTitle: string; deckSubtitle: string; slides: SlideSpec[]; teamSlides: SlideSpec[] | null; memberSlides: DeckMemberSlide[] | null; closingSlides: SlideSpec[] | null; guard: GuardResult; payload: AiPayloadSubset; memberRanking: MemberRankingEntry[] | null } & PeriodMeta)
  // ── Full structured reports ──
  | FullDistributorReportData
  | FullStateHeadReportData
  | FullGrowthReportData
  // ── Distributor ──
  | { type: "distributor-statehead-report"; fy: string; stateHead: string; dataCutoff: string; sections: Record<string, Section>; guard: GuardResult; payload: DistributorPayloadSubset }
  | { type: "distributor-report"; fy: string; stateHead: string; distributor: string; dataCutoff: string; sections: Record<string, Section>; guard: GuardResult; payload: DistributorPayloadSubset }
  | { type: "distributor-suggestions"; fy: string; stateHead: string; dataCutoff: string; intro: string; suggestions: SuggestionItem[]; guard: GuardResult; payload: DistributorPayloadSubset }
  | { type: "distributor-review"; fy: string; stateHead: string; distributor: string; dataCutoff: string; sections: Record<string, Section>; guard: GuardResult; payload: DistributorPayloadSubset }
  | { type: "distributor-presentation"; fy: string; stateHead: string; dataCutoff: string; deckTitle: string; deckSubtitle: string; slides: SlideSpec[]; guard: GuardResult; payload: DistributorPayloadSubset };

// ── Chart helpers ─────────────────────────────────────────────────────────────

const COLORS = ["#1D4ED8", "#475569", "#94A3B8", "#CBD5E1", "#E2E8F0"];
const TIER_COLORS: Record<string, string> = { A: "#1D4ED8", B: "#F59E0B", C: "#94A3B8" };
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

function getDistributorSlideChartData(ref: string, payload: DistributorPayloadSubset): RechartsRow[] | null {
  const dists = payload.distributors ?? [];
  switch (ref) {
    case "dist_channel_structure": {
      const cs = payload.channelStructure;
      if (!cs) return null;
      return [
        { name: "Distributor Retailers", value: cs.namedDistributorRetailers },
        { name: "Direct Dealers", value: cs.directDealerRetailers },
        { name: "Unassigned", value: cs.unassignedRetailers },
      ].filter((d) => (d.value as number) > 0);
    }
    case "dist_performance":
      return dists.map((d) => ({ name: d.name.split(" ")[0] ?? d.name, "OB (Cr)": cr(d.orderBooking) })).filter((d) => (d["OB (Cr)"] as number) > 0);
    case "dist_flow_gap":
      return dists
        .filter((d) => d.flows?.hasPrimaryData)
        .map((d) => ({
          name: d.name.split(" ")[0] ?? d.name,
          "Primary In (Cr)": cr(d.flows?.primaryDispatch),
          "Secondary Out (Cr)": cr(d.flows?.secondaryOut),
        }));
    case "dist_whitespace": {
      const ws = payload.whitespace;
      if (!ws) return null;
      return [
        { name: "Assignment Gap Retailers", value: ws.totalAssignmentGapRetailers },
        { name: "Coverage Gap Retailers", value: ws.totalCoverageGapRetailers },
        { name: "Channel Conflicts", value: ws.channelConflictCount },
      ].filter((d) => (d.value as number) > 0);
    }
    case "dist_tier": {
      const tierCount: Record<string, number> = { A: 0, B: 0, C: 0 };
      for (const d of dists) if (d.tier) tierCount[d.tier.tier] = (tierCount[d.tier.tier] ?? 0) + 1;
      return [
        { name: "Tier A", value: tierCount.A },
        { name: "Tier B", value: tierCount.B },
        { name: "Tier C", value: tierCount.C },
      ].filter((d) => (d.value as number) > 0);
    }
    default: return null;
  }
}

// ── PDF export helpers ────────────────────────────────────────────────────────

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
  .meta { color: #64748b; font-size: 11px; margin-bottom: 4px; }
  .period-cover { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 4px; padding: 8px 12px; font-size: 12px; color: #1e40af; margin-bottom: 4px; }
  .period-mismatch { background: #fef9c3; border: 1px solid #fde047; border-radius: 4px; padding: 8px 12px; font-size: 12px; color: #713f12; margin-bottom: 4px; }
  .period-sep { margin-bottom: 16px; }
  h2 { font-size: 15px; font-weight: 600; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-top: 20px; color: #1e293b; }
  p { margin: 6px 0; font-size: 13px; }
  .footer { margin-top: 32px; padding-top: 10px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 10px; }
  @media print { body { margin: 20px; } .footer { position: running(footer); } }
`;

type PdfPeriodInfo = {
  coveredLabel: string;   // "year to date, April to June 2026"
  dataCutoff: string;
  fy: string;
  mismatch: boolean;
  selectedPeriod?: string;
};

function makePeriodCoverHtml(pi: PdfPeriodInfo): string {
  const mismatchNote = pi.mismatch && pi.selectedPeriod && pi.selectedPeriod !== "ytd"
    ? `<div class="period-mismatch"><strong>${pi.selectedPeriod.toUpperCase()} was selected.</strong> This report covers ${pi.coveredLabel} because AI reports always use year-to-date data from the start of the financial year.</div>`
    : "";
  return `${mismatchNote}<div class="period-cover">Coverage: ${pi.coveredLabel} &nbsp;·&nbsp; Data to ${pi.dataCutoff} &nbsp;·&nbsp; FY${pi.fy}</div><div class="period-sep"></div>`;
}

function makePeriodFooterText(pi: PdfPeriodInfo): string {
  return `FY${pi.fy} · ${pi.coveredLabel} · Data to ${pi.dataCutoff} · Generated ${new Date().toLocaleString()}`;
}

function exportSectionsPdf(title: string, meta: string, sections: Record<string, Section>, extra?: string, period?: PdfPeriodInfo): void {
  const sectionHtml = Object.values(sections).map((s) => `
    <h2>${s.title}</h2>
    <p>${s.body.replace(/\n/g, "<br/>")}</p>
  `).join("");
  const periodCover = period ? makePeriodCoverHtml(period) : "";
  const footer = period ? makePeriodFooterText(period) : `Generated ${new Date().toLocaleString()}`;
  openPrintWindow(`<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title><style>${PDF_BASE_STYLE}</style></head><body>
    <div class="brand">Prayag India - Sales Intelligence</div>
    <div class="meta">${title} &middot; ${meta}</div>
    ${periodCover}
    ${sectionHtml}${extra ?? ""}
    <div class="footer">${footer} · Figures are grounded in the verified payload.</div>
  </body></html>`, title);
}

function exportPerformanceReviewPdf(member: string, sections: Record<string, Section>, period?: PdfPeriodInfo): void {
  const sectionHtml = Object.values(sections).map((s) => `<h2>${s.title}</h2><p>${s.body.replace(/\n/g, "<br/>")}</p>`).join("");
  const style = `${PDF_BASE_STYLE}
    .watermark { background: #DC2626; color: white; text-align: center; padding: 6px; font-size: 11px; font-weight: 700; border-radius: 4px; margin-bottom: 16px; }
    @media print { .watermark { position: fixed; top: 0; left: 0; right: 0; border-radius: 0; margin-bottom: 0; z-index: 9999; } body { padding-top: 36px; } }
  `;
  const periodCover = period ? makePeriodCoverHtml(period) : "";
  const footer = period ? makePeriodFooterText(period) : `Generated ${new Date().toLocaleString()}`;
  openPrintWindow(`<!doctype html><html><head><meta charset="utf-8"/><title>Performance Review — ${member}</title><style>${style}</style></head><body>
    <div class="watermark">MANAGEMENT ONLY — NOT FOR DISTRIBUTION TO THE INDIVIDUAL | DRAFT — REQUIRES HUMAN SIGN-OFF</div>
    <div class="brand">Prayag India - Sales Intelligence</div>
    <div class="meta">Performance Review: ${member}</div>
    ${periodCover}
    ${sectionHtml}
    <div class="footer">MANAGEMENT ONLY — Draft, requires sign-off. ${footer}</div>
  </body></html>`, "Performance Review");
}

function exportSuggestionsPdf(member: string, intro: string, suggestions: SuggestionItem[], extraHtml?: string, period?: PdfPeriodInfo): void {
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
  const periodCover = period ? makePeriodCoverHtml(period) : "";
  const footer = period ? makePeriodFooterText(period) : `Generated ${new Date().toLocaleString()}`;
  openPrintWindow(`<!doctype html><html><head><meta charset="utf-8"/><title>Suggestions — ${member}</title><style>${PDF_BASE_STYLE}</style></head><body>
    <div class="brand">Prayag India - Sales Intelligence</div>
    <div class="meta">Suggestions and Actions: ${member}</div>
    ${periodCover}
    <h2>Introduction</h2><p>${intro}</p>
    <h2>Ranked Suggestions</h2>${items}${extraHtml ?? ""}
    <div class="footer">${footer} · Figures are grounded in the verified payload.</div>
  </body></html>`, "Suggestions");
}

function exportTravelPlanPdf(member: string, sections: Record<string, Section>, monthPlans: MonthPlan[], period?: PdfPeriodInfo): void {
  const monthHtml = monthPlans.map((mp) => `
    <h3 style="font-size:13px;margin-top:14px;color:#1e293b;">${mp.month} — ${mp.workingDays} working days, ${mp.capacity} visits allocated (${mp.maintenanceVisits} maintenance, ${mp.developmentVisits} development)</h3>
    <table style="border-collapse:collapse;width:100%;margin:6px 0;font-size:11px;">
      <tr style="background:#f1f5f9;"><th style="padding:4px 8px;text-align:left;border:1px solid #cbd5e1;">Name</th><th style="padding:4px 8px;border:1px solid #cbd5e1;">District</th><th style="padding:4px 8px;border:1px solid #cbd5e1;">Dist km</th><th style="padding:4px 8px;border:1px solid #cbd5e1;">Priority</th><th style="padding:4px 8px;border:1px solid #cbd5e1;">Reason</th></tr>
      ${mp.targets.map((t) => `<tr><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.name}</td><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.district ?? "—"}</td><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.distanceKm ?? "—"}</td><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.priority}</td><td style="padding:3px 8px;border:1px solid #e2e8f0;">${t.reason}</td></tr>`).join("")}
    </table>
  `).join("");
  exportSectionsPdf(`Travel and Visit Plan — ${member}`, member, sections, `<h2>Month-by-Month Visit Plan (App-Computed)</h2>${monthHtml}`, period);
}

// ── PPTX exports ──────────────────────────────────────────────────────────────

async function exportPptx(result: Extract<GenerationResult, { type: "presentation" }>): Promise<void> {
  const pptxgen = (await import("pptxgenjs")).default;
  const prs = new pptxgen();
  prs.layout = "LAYOUT_WIDE";

  const titleSlide = prs.addSlide();
  titleSlide.background = { color: "1E3A8A" };
  titleSlide.addText(result.deckTitle, { x: 0.5, y: 2.2, w: 9, h: 1.2, fontSize: 36, color: "FFFFFF", bold: true, align: "center" });
  titleSlide.addText(result.deckSubtitle, { x: 0.5, y: 3.6, w: 9, h: 0.7, fontSize: 18, color: "BFDBFE", align: "center" });
  titleSlide.addText(`Data as of ${result.dataCutoff} | FY${result.fy} | Prayag India Sales Intelligence`, { x: 0.5, y: 4.6, w: 9, h: 0.4, fontSize: 11, color: "93C5FD", align: "center" });

  for (const slide of result.slides) {
    const pSlide = prs.addSlide();
    pSlide.addText(slide.title, { x: 0.4, y: 0.18, w: 9.2, h: 0.6, fontSize: 20, bold: true, color: "1E293B" });
    if (slide.subtitle) pSlide.addText(slide.subtitle, { x: 0.4, y: 0.78, w: 9.2, h: 0.32, fontSize: 12, color: "64748B" });

    const hasChart = slide.chartType !== "none" && slide.chartDataRef !== "none";
    const recharts = hasChart ? getSlideChartData(slide.chartDataRef, result.payload, result.memberRanking) : null;

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
        } catch { /* edge-case chart shapes */ }
      }
    }

    if (slide.bullets.length > 0) {
      const bulletRows = slide.bullets.map((b) => ({ text: b, options: { bullet: { type: "bullet" as const }, fontSize: 11, color: "1E293B" } }));
      pSlide.addText(bulletRows, { x: recharts ? 5.95 : 0.4, y: 1.15, w: recharts ? 3.7 : 9.2, h: 3.5, fontSize: 11, color: "374151", valign: "top" } as any);
    }
    if (slide.commentary) pSlide.addText(slide.commentary, { x: 0.4, y: 4.78, w: 9.2, h: 0.5, fontSize: 10, italic: true, color: "64748B" });
  }

  await prs.writeFile({ fileName: `${result.deckTitle}.pptx` } as any);
}

async function exportDistributorPptx(result: Extract<GenerationResult, { type: "distributor-presentation" }>): Promise<void> {
  const pptxgen = (await import("pptxgenjs")).default;
  const prs = new pptxgen();
  prs.layout = "LAYOUT_WIDE";

  const titleSlide = prs.addSlide();
  titleSlide.background = { color: "1E3A8A" };
  titleSlide.addText(result.deckTitle, { x: 0.5, y: 2.2, w: 9, h: 1.2, fontSize: 36, color: "FFFFFF", bold: true, align: "center" });
  titleSlide.addText(result.deckSubtitle, { x: 0.5, y: 3.6, w: 9, h: 0.7, fontSize: 18, color: "BFDBFE", align: "center" });
  titleSlide.addText(`Data as of ${result.dataCutoff} | FY${result.fy} | Prayag India Sales Intelligence`, { x: 0.5, y: 4.6, w: 9, h: 0.4, fontSize: 11, color: "93C5FD", align: "center" });

  for (const slide of result.slides) {
    const pSlide = prs.addSlide();
    pSlide.addText(slide.title, { x: 0.4, y: 0.18, w: 9.2, h: 0.6, fontSize: 20, bold: true, color: "1E293B" });
    if (slide.subtitle) pSlide.addText(slide.subtitle, { x: 0.4, y: 0.78, w: 9.2, h: 0.32, fontSize: 12, color: "64748B" });

    const hasChart = slide.chartType !== "none" && slide.chartDataRef !== "none";
    const recharts = hasChart ? getDistributorSlideChartData(slide.chartDataRef, result.payload) : null;

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
        } catch { /* edge-case chart shapes */ }
      }
    }

    if (slide.bullets.length > 0) {
      const bulletRows = slide.bullets.map((b) => ({ text: b, options: { bullet: { type: "bullet" as const }, fontSize: 11, color: "1E293B" } }));
      pSlide.addText(bulletRows, { x: recharts ? 5.95 : 0.4, y: 1.15, w: recharts ? 3.7 : 9.2, h: 3.5, fontSize: 11, color: "374151", valign: "top" } as any);
    }
    if (slide.commentary) pSlide.addText(slide.commentary, { x: 0.4, y: 4.78, w: 9.2, h: 0.5, fontSize: 10, italic: true, color: "64748B" });
  }

  await prs.writeFile({ fileName: `${result.deckTitle}.pptx` } as any);
}

// ── Guard banners ─────────────────────────────────────────────────────────────

function GuardBanner({ guard }: { guard: GuardResult }) {
  if (guard.status === "ok") return null;
  return (
    <div className="flex gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800 mb-4">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{guard.unmatched.length} figure(s) in this report could not be matched to the verified payload. Review before distributing.</span>
    </div>
  );
}

function PeriodMismatchBanner({ result }: { result: PeriodMeta & { dataCutoff: string } }) {
  const { periodCoveredLabel, selectedPeriod, periodMismatch, periodGuard } = result;
  const showMismatch = periodMismatch && selectedPeriod && selectedPeriod !== "ytd";
  const showPeriodGuard = periodGuard && periodGuard.status === "requires_review";
  if (!showMismatch && !showPeriodGuard) return null;
  return (
    <div className="space-y-2 mb-4">
      {showMismatch && (
        <div className="flex gap-2 p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            <strong>{selectedPeriod.toUpperCase()}</strong> was selected. This report covers{" "}
            <strong>{periodCoveredLabel ?? "year to date"}</strong> because AI reports always use
            year-to-date data from the start of the financial year.
          </span>
        </div>
      )}
      {showPeriodGuard && (
        <div className="flex gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            <p className="font-medium">
              {periodGuard.flagged.length} period attribution{periodGuard.flagged.length !== 1 ? "s" : ""} flagged — a sentence attributes a figure to a single month while data is year-to-date. Review before distributing.
            </p>
            {periodGuard.flagged.slice(0, 3).map((f, i) => (
              <p key={i} className="text-xs text-amber-700 truncate" title={f.sentence}>
                "{f.termMentioned}": {f.sentence.slice(0, 120)}{f.sentence.length > 120 ? "…" : ""}
              </p>
            ))}
            {periodGuard.flagged.length > 3 && (
              <p className="text-xs text-amber-600">+{periodGuard.flagged.length - 3} more</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

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

function SlidePreview({ slide, payload, distPayload, memberRanking }: {
  slide: SlideSpec;
  payload?: AiPayloadSubset;
  distPayload?: DistributorPayloadSubset;
  memberRanking: MemberRankingEntry[] | null;
}) {
  const chartData = slide.chartType !== "none" && slide.chartDataRef !== "none"
    ? distPayload
      ? getDistributorSlideChartData(slide.chartDataRef, distPayload)
      : payload
      ? getSlideChartData(slide.chartDataRef, payload, memberRanking)
      : null
    : null;
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
                  {numericKeys.map((k, i) => <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} />)}
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

function DeckMemberSlideCard({ slide }: { slide: DeckMemberSlide }) {
  return (
    <div className={cn(
      "border rounded-lg p-4 bg-card space-y-2 min-h-[160px]",
      slide.achievementBadge === "teal" ? "border-teal-200" : "border-amber-200",
    )}>
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-sm">{slide.memberName}</div>
        <Badge className={cn(
          "text-xs flex-shrink-0 text-white",
          slide.achievementBadge === "teal" ? "bg-teal-600 hover:bg-teal-600" : "bg-amber-500 hover:bg-amber-500",
        )}>
          {slide.achievementBadge === "teal" ? "On Track" : "Needs Attention"}
        </Badge>
      </div>
      {slide.bullets.length > 0 && (
        <ul className="space-y-1">
          {slide.bullets.map((b, i) => (
            <li key={i} className="text-xs text-foreground flex gap-1.5 items-start">
              <span className="text-primary mt-0.5">-</span>{b}
            </li>
          ))}
        </ul>
      )}
      {slide.commentary && (
        <p className={cn(
          "text-xs italic border-t border-border/40 pt-2",
          slide.unmapped ? "text-amber-700" : "text-muted-foreground",
        )}>{slide.commentary}</p>
      )}
    </div>
  );
}

function MonthPlanCard({ mp }: { mp: MonthPlan }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 text-sm font-medium text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate">{mp.month} — {mp.workingDays} working days · {mp.capacity} visits ({mp.maintenanceVisits} maintenance, {mp.developmentVisits} development)</span>
          {mp.poolExhausted && (
            <Badge variant="outline" className="text-xs text-amber-700 border-amber-300 flex-shrink-0">pool exhausted</Badge>
          )}
        </div>
        {open ? <ChevronDown className="w-4 h-4 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 flex-shrink-0" />}
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
                  <td className="px-3 py-1.5">{t.ob > 0 ? `₹${trunc2((t.ob / 100000))}L` : "—"}</td>
                  <td className="px-3 py-1.5">
                    <Badge variant={t.priority === "maintain" ? "default" : t.priority === "develop" ? "secondary" : "outline"} className="text-xs">{t.priority}</Badge>
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

// ── Distributor-specific sub-components ───────────────────────────────────────

function DistributorTable({ payload }: { payload: DistributorPayloadSubset }) {
  const dists = payload.distributors ?? [];
  if (!dists.length) return null;
  return (
    <Card className="border-border/50">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm font-semibold">Distributor Performance Ranking</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40">
              {["Distributor", "OB (Cr)", "OB%", "Retailers", "Active", "Tier", "Flow Gap (Cr)"].map((h) => (
                <th key={h} className="py-2 px-2 text-left font-medium text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dists.map((d, i) => (
              <tr key={i} className={cn("border-t border-border/30 hover:bg-muted/20", d.isConcentrationRisk && "bg-amber-50/40")}>
                <td className="py-1.5 px-2 font-medium">
                  {d.name}
                  {d.isConcentrationRisk && <span className="ml-1 text-[10px] text-amber-700 font-semibold">SPD</span>}
                </td>
                <td className="py-1.5 px-2">{trunc2(cr(d.orderBooking))}</td>
                <td className="py-1.5 px-2">{d.obSharePct != null ? `${trunc2(d.obSharePct)}%` : "—"}</td>
                <td className="py-1.5 px-2">{d.retailerCount}</td>
                <td className="py-1.5 px-2">{d.activeCount}</td>
                <td className="py-1.5 px-2">
                  {d.tier ? (
                    <span style={{ color: TIER_COLORS[d.tier.tier] }} className="font-bold">
                      {d.tier.tier}{d.tier.isOverridden ? "*" : ""}
                    </span>
                  ) : "—"}
                </td>
                <td className="py-1.5 px-2">
                  {d.flows && d.flows.hasPrimaryData
                    ? <span className={cn(d.flows.flowGap != null && d.flows.flowGap > 0 ? "text-amber-700" : "")}>{d.flows.flowGap != null ? trunc2(cr(d.flows.flowGap)) : "—"}</span>
                    : <span className="text-muted-foreground/60">no data</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[10px] text-muted-foreground mt-2">SPD = single-point dependency (OB% ≥ 60). * = tier manually overridden. Tier colour: A=blue, B=amber, C=grey.</p>
      </CardContent>
    </Card>
  );
}

function WhitespaceCard({ payload }: { payload: DistributorPayloadSubset }) {
  const ws = payload.whitespace;
  const cs = payload.channelStructure;
  if (!ws && !cs) return null;
  return (
    <Card className="border-border/50">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm font-semibold">Channel Structure and Whitespace</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        {cs && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Distributor Retailers", value: cs.namedDistributorRetailers },
              { label: "Direct Dealers (parallel)", value: cs.directDealerRetailers },
              { label: "Unassigned", value: cs.unassignedRetailers },
              { label: "Distributor OB (Cr)", value: trunc2(cr(cs.partyObTotal)) },
            ].map((k) => (
              <div key={k.label} className="rounded-lg border border-border/50 p-3 text-center">
                <p className="text-base font-bold">{k.value}</p>
                <p className="text-[10px] text-muted-foreground">{k.label}</p>
              </div>
            ))}
          </div>
        )}
        {ws && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-1">
              <p className="text-xs font-semibold text-blue-800">Assignment Gap</p>
              <p className="text-xs text-blue-700">{ws.totalAssignmentGapRetailers} retailers across {ws.totalAssignmentGapDistricts} districts — distributor exists, admin fix (immediate)</p>
              {ws.assignmentGapDistricts.slice(0, 4).map((d) => (
                <p key={d.district} className="text-[10px] text-blue-600">{d.district}: {d.noneCount} unassigned</p>
              ))}
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 space-y-1">
              <p className="text-xs font-semibold text-amber-800">Coverage Gap</p>
              <p className="text-xs text-amber-700">{ws.totalCoverageGapRetailers} retailers across {ws.totalCoverageGapDistricts} districts — no distributor, appoint one (strategic)</p>
              {ws.coverageGapDistricts.slice(0, 4).map((d) => (
                <p key={d.district} className="text-[10px] text-amber-600">{d.district}: ₹{trunc2((d.priorYearOb / 100000))}L prior-year demand</p>
              ))}
            </div>
          </div>
        )}
        {ws && ws.channelConflictCount > 0 && (
          <p className="text-xs text-destructive/80">Channel conflict: {ws.channelConflictCount} direct dealer(s) in districts that also have a named distributor.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Batch helpers (module-level) ──────────────────────────────────────────────

const BATCHABLE_MEMBER_TYPES = ["suggestions", "travel-plan", "performance-review"] as const;
type BatchableMemberType = typeof BATCHABLE_MEMBER_TYPES[number];

function generateBatchDocHtml(doc: BatchDoc, fy: string): string {
  const { member, reportType, dataCutoff, result } = doc;
  const generatedAt = new Date().toLocaleString();
  const title = `${member} — ${reportType === "travel-plan" ? "Travel and Visit Plan" : reportType === "performance-review" ? "Performance Review" : "Suggestions and Actions"}`;
  const coveredLabel = doc.periodCoveredLabel ?? "year to date";
  const mismatch = doc.periodMismatch ?? false;
  const selPeriod = doc.selectedPeriod;
  const periodCoverHtml = mismatch && selPeriod && selPeriod !== "ytd"
    ? `<div class="period-mismatch"><strong>${selPeriod.toUpperCase()} was selected.</strong> This report covers ${coveredLabel} because AI reports always use year-to-date data.</div><div class="period-cover">Coverage: ${coveredLabel} &nbsp;·&nbsp; Data to ${dataCutoff} &nbsp;·&nbsp; FY${fy}</div><div class="period-sep"></div>`
    : `<div class="period-cover">Coverage: ${coveredLabel} &nbsp;·&nbsp; Data to ${dataCutoff} &nbsp;·&nbsp; FY${fy}</div><div class="period-sep"></div>`;

  let bodyHtml = "";

  if (reportType === "suggestions") {
    const intro = (result.intro as string) ?? "";
    const suggs = (result.suggestions as SuggestionItem[]) ?? [];
    const items = suggs.map((s) => `
      <div style="margin:10px 0;padding:10px;border:1px solid #e2e8f0;border-radius:4px;">
        <div style="font-weight:600;font-size:13px;">${s.rank}. ${s.title}
          <span style="margin-left:6px;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700;background:${s.effort === "low" ? "#D1FAE5" : s.effort === "medium" ? "#FEF3C7" : "#FEE2E2"};color:${s.effort === "low" ? "#065F46" : s.effort === "medium" ? "#92400E" : "#991B1B"};">${s.effort} effort</span>
        </div>
        <p style="font-size:12px;margin:4px 0"><strong>Metric:</strong> ${s.metric}</p>
        <p style="font-size:12px;margin:4px 0"><strong>Expected effect:</strong> ${s.expectedEffect}</p>
        <p style="font-size:12px;margin-top:6px;"><strong>Action:</strong> ${s.action}</p>
      </div>`).join("");
    bodyHtml = `<h2>Introduction</h2><p>${intro}</p><h2>Ranked Suggestions</h2>${items}`;
  } else if (reportType === "performance-review") {
    const sections = (result.sections as Record<string, Section>) ?? {};
    const watermark = `<div style="background:#DC2626;color:white;text-align:center;padding:6px;font-size:11px;font-weight:700;border-radius:4px;margin-bottom:16px;">MANAGEMENT ONLY — NOT FOR DISTRIBUTION TO THE INDIVIDUAL | DRAFT — REQUIRES HUMAN SIGN-OFF</div>`;
    bodyHtml = watermark + Object.values(sections).map((s) => `<h2>${s.title}</h2><p>${s.body.replace(/\n/g, "<br/>")}</p>`).join("");
  } else if (reportType === "travel-plan") {
    const sections = (result.sections as Record<string, Section>) ?? {};
    bodyHtml = Object.values(sections).map((s) => `<h2>${s.title}</h2><p>${s.body.replace(/\n/g, "<br/>")}</p>`).join("");
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
  <style>${PDF_BASE_STYLE}</style>
</head>
<body>
  <div class="brand">Prayag India - Sales Intelligence</div>
  <div class="meta">${title}</div>
  ${periodCoverHtml}
  ${bodyHtml}
  <div class="footer">FY${fy} · ${coveredLabel} · Data to ${dataCutoff} · Generated ${generatedAt} · Figures are grounded in the verified payload.</div>
</body>
</html>`;
}

async function downloadBatchZip(
  docs: BatchDoc[],
  fy: string,
  stateHead: string,
  reportType: string,
): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const sanitize = (s: string) => s.replace(/[/\\:*?"<>|]/g, "_");
  // Use the period short from the first document (all docs in a batch share the same cutoff/period)
  const periodShort = docs[0]?.periodCoveredShort ?? "YTD";
  const folderName = `${sanitize(stateHead)}_FY${fy}_${reportType}_${periodShort}`;
  const root = zip.folder(folderName)!;

  for (const doc of docs) {
    const html = generateBatchDocHtml(doc, fy);
    const safeMember = sanitize(doc.member);
    const docPeriodShort = doc.periodCoveredShort ?? periodShort;
    root.folder(safeMember)!.file(`${safeMember}_${reportType}_FY${fy}_${docPeriodShort}.html`, html);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${folderName}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Chat PDF export ───────────────────────────────────────────────────────────

function exportQaPdf(question: string, answer: string, contextLabel: string): void {
  openPrintWindow(
    `<!doctype html><html><head><meta charset="utf-8"/><title>Q&A Export</title><style>${PDF_BASE_STYLE}</style></head><body>
      <div class="brand">Prayag India - Sales Intelligence</div>
      <div class="meta">Q&A Export: ${contextLabel} &middot; Generated ${new Date().toLocaleString()}</div>
      <h2>Question</h2>
      <p>${question.replace(/</g, "&lt;")}</p>
      <h2>Answer</h2>
      <p>${answer.replace(/</g, "&lt;").replace(/\n/g, "<br/>")}</p>
      <div class="footer">Generated by Prayag India Sales Intelligence. Figures are grounded in the verified payload.</div>
    </body></html>`,
    "Q&A Export",
  );
}

// ── Compact batch result card (shown when ≤ 5 members) ───────────────────────

function BatchMemberCard({ doc }: { doc: BatchDoc }) {
  const r = doc.result;
  const reportLabel = doc.reportType === "travel-plan" ? "Travel Plan" : doc.reportType === "performance-review" ? "Performance Review" : "Suggestions";

  return (
    <Card className="border-border/50">
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold">{doc.member} — {reportLabel}</CardTitle>
          <Badge variant="outline" className="text-[10px]">
            {doc.source === "cache" ? "from cache" : "generated"}
          </Badge>
        </div>
        <p className="text-[10px] text-muted-foreground">Data to {doc.dataCutoff}</p>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-2">
        {doc.reportType === "suggestions" && (() => {
          const intro = r.intro as string ?? "";
          const suggs = r.suggestions as SuggestionItem[] ?? [];
          return (
            <>
              <p className="text-xs text-muted-foreground">{intro}</p>
              {suggs.slice(0, 3).map((s) => (
                <div key={s.rank} className="text-xs rounded p-2 bg-muted/30 space-y-0.5">
                  <span className="font-semibold">{s.rank}. {s.title}</span>
                  {" — "}<span className="text-muted-foreground">{s.action}</span>
                </div>
              ))}
              {suggs.length > 3 && <p className="text-[10px] text-muted-foreground">+{suggs.length - 3} more suggestion(s) in the ZIP.</p>}
            </>
          );
        })()}
        {(doc.reportType === "performance-review" || doc.reportType === "travel-plan") && (() => {
          const sections = r.sections as Record<string, Section> ?? {};
          const vals = Object.values(sections).slice(0, 3);
          return (
            <>
              {doc.reportType === "performance-review" && (
                <p className="text-[10px] font-semibold text-destructive">MANAGEMENT ONLY — DRAFT</p>
              )}
              {vals.map((s, i) => (
                <div key={i} className="space-y-0.5">
                  <p className="text-[10px] font-semibold text-foreground">{s.title}</p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    {s.body.length > 220 ? s.body.slice(0, 220) + "…" : s.body}
                  </p>
                </div>
              ))}
              {Object.keys(sections).length > 3 && (
                <p className="text-[10px] text-muted-foreground">+{Object.keys(sections).length - 3} more section(s) in the ZIP.</p>
              )}
            </>
          );
        })()}
      </CardContent>
    </Card>
  );
}

// ── Report type config ────────────────────────────────────────────────────────

const MEMBER_REPORT_TYPES: { id: MemberArtifactType; label: string; requiresMember?: true; requiresStateHead?: true }[] = [
  { id: "full-statehead-report", label: "State Head Report (Full)",  requiresStateHead: true },
  { id: "statehead-report",      label: "State Head Report (Legacy)", requiresStateHead: true },
  { id: "suggestions",           label: "Suggestions",               requiresMember: true },
  { id: "travel-plan",           label: "Travel Plan",               requiresMember: true },
  { id: "performance-review",    label: "Performance Review",        requiresMember: true },
  { id: "presentation",          label: "Presentation" },
];

const DISTRIBUTOR_REPORT_TYPES: { id: DistributorArtifactType; label: string; requiresStateHead: true; requiresDistributor?: true }[] = [
  { id: "full-distributor-report",       label: "Distributor Report (Full)",  requiresStateHead: true, requiresDistributor: true },
  { id: "distributor-statehead-report",  label: "Territory Report",           requiresStateHead: true },
  { id: "distributor-suggestions",       label: "Suggestions",                requiresStateHead: true },
  { id: "distributor-report",            label: "Distributor Report (Legacy)", requiresStateHead: true, requiresDistributor: true },
  { id: "distributor-review",            label: "Distributor Review",         requiresStateHead: true, requiresDistributor: true },
  { id: "distributor-presentation",      label: "Presentation",               requiresStateHead: true },
];

// ── Main component ────────────────────────────────────────────────────────────

export default function AiReports() {
  const { fy, periodMode, effectivePeriodFrom, effectivePeriodTo } = useGlobalFilter();
  const [stateHead, setStateHead]       = useState("");
  const [member, setMember]             = useState("");
  const [distributorName, setDistributorName] = useState("");
  const [reportType, setReportType]     = useState<ArtifactType>("statehead-report");
  const [isLoading, setIsLoading]       = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [result, setResult]             = useState<GenerationResult | null>(null);
  const [signedOff, setSignedOff]       = useState(false);

  // ── Growth report scope ──────────────────────────────────────────────────────
  const [growthScope, setGrowthScope]   = useState<"company"|"statehead"|"state">("statehead");
  const [growthState, setGrowthState]   = useState("");
  const [dormantRevivalPct, setDormantRevivalPct] = useState(25);
  const [atRiskRecoveryPct, setAtRiskRecoveryPct] = useState(35);
  const [rangeUptakePct, setRangeUptakePct]       = useState(40);

  // ── Batch state ─────────────────────────────────────────────────────────────
  const [batchMode, setBatchMode]       = useState(false);
  const [isBatching, setIsBatching]     = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchDocStatus[]>([]);
  const [batchDocs, setBatchDocs]       = useState<BatchDoc[]>([]);
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);
  const [batchError, setBatchError]     = useState<string | null>(null);

  const isBatchableType = (BATCHABLE_MEMBER_TYPES as readonly string[]).includes(reportType);

  // ── Salespeople tree (for dropdowns) ────────────────────────────────────────
  type RepNode = { name: string; children: RepNode[] };
  const [treeHeads, setTreeHeads]       = useState<RepNode[]>([]);

  useEffect(() => {
    fetch(`/api/salespeople/tree?fy=${encodeURIComponent(fy)}`)
      .then((r) => r.ok ? r.json() as Promise<{ heads: RepNode[] }> : Promise.reject())
      .then((d) => setTreeHeads(d.heads ?? []))
      .catch(() => setTreeHeads([]));
  }, [fy]);

  const stateHeadOptions = useMemo(() => treeHeads.map((h) => h.name), [treeHeads]);
  const memberOptions    = useMemo(() => {
    const head = treeHeads.find((h) => h.name === stateHead);
    return head ? head.children.map((c) => c.name) : [];
  }, [treeHeads, stateHead]);

  // ── Voice input ───────────────────────────────────────────────────────────
  const appendChatTranscript = useCallback((text: string) => {
    setChatInput((prev) => (prev ? `${prev} ${text}` : text));
  }, []);
  const chatVoice = useVoiceInput(appendChatTranscript);

  // ── Chat state ───────────────────────────────────────────────────────────────
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput]       = useState("");
  const [isChatting, setIsChatting]     = useState(false);
  const [chatError, setChatError]       = useState<string | null>(null);
  const chatScrollRef                   = useRef<HTMLDivElement>(null);

  // Clear conversation when the selection changes.
  useEffect(() => {
    setChatMessages([]);
    setChatInput("");
    setChatError(null);
  }, [fy, stateHead, member]);

  // Auto-scroll to the bottom after each new message.
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, isChatting]);

  const isDistributorType = (t: ArtifactType): t is DistributorArtifactType =>
    t.startsWith("distributor-") || t === "full-distributor-report";

  const isEnabled = useCallback((type: ArtifactType) => {
    if (type === "full-growth-report") {
      if (growthScope === "statehead" && !stateHead.trim()) return false;
      if (growthScope === "state" && !growthState.trim()) return false;
      return true;
    }
    if (isDistributorType(type)) {
      const def = DISTRIBUTOR_REPORT_TYPES.find((r) => r.id === type)!;
      if (!stateHead.trim()) return false;
      if (def.requiresDistributor && !distributorName.trim()) return false;
      return true;
    } else {
      const def = MEMBER_REPORT_TYPES.find((r) => r.id === type)!;
      if (def.requiresMember && !member.trim()) return false;
      if (def.requiresStateHead && !stateHead.trim()) return false;
      return true;
    }
  }, [member, stateHead, distributorName, growthScope, growthState]);

  const canGenerate = isEnabled(reportType);

  const generate = async () => {
    setIsLoading(true);
    setError(null);
    setResult(null);
    setSignedOff(false);

    // Full structured reports use a different endpoint and accept monthFrom/monthTo.
    const isFullReport = reportType === "full-distributor-report" || reportType === "full-statehead-report";
    const isGrowthReport = reportType === ("full-growth-report" as ArtifactType);
    let endpoint: string;
    let bodyObj: Record<string, unknown>;

    if (isGrowthReport) {
      endpoint = "/api/ai/full-report/growth";
      bodyObj = {
        fy,
        scope: growthScope,
        stateHead: growthScope === "statehead" ? (stateHead.trim() || undefined) : undefined,
        state:     growthScope === "state"     ? (growthState.trim() || undefined)  : undefined,
        monthFrom: effectivePeriodFrom,
        monthTo: effectivePeriodTo,
        dormantRevivalPct: dormantRevivalPct / 100,
        atRiskRecoveryPct: atRiskRecoveryPct / 100,
        rangeUptakePct:    rangeUptakePct    / 100,
      };
    } else if (isFullReport) {
      endpoint = reportType === "full-distributor-report"
        ? "/api/ai/full-report/distributor"
        : "/api/ai/full-report/statehead";
      bodyObj = {
        fy,
        stateHead: stateHead.trim() || undefined,
        distributor: distributorName.trim() || undefined,
        monthFrom: effectivePeriodFrom,
        monthTo: effectivePeriodTo,
      };
    } else {
      endpoint = `/api/ai/${reportType}`;
      bodyObj = { fy, period: periodMode } as Record<string, unknown>;
      if (stateHead.trim()) bodyObj.stateHead = stateHead.trim();
      if (member.trim()) bodyObj.member = member.trim();
      if (distributorName.trim()) bodyObj.distributor = distributorName.trim();
    }

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
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

  // ── Chat ─────────────────────────────────────────────────────────────────────

  const sendChat = async () => {
    const q = chatInput.trim();
    if (!q || isChatting) return;

    const userMsg: ChatMessage = { role: "user", content: q };
    const nextHistory: ChatMessage[] = [...chatMessages, userMsg];
    setChatMessages(nextHistory);
    setChatInput("");
    setIsChatting(true);
    setChatError(null);

    try {
      const resp = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fy,
          stateHead: stateHead.trim() || undefined,
          member:    member.trim()    || undefined,
          // Send only role+content — strip guard from history sent to server.
          messages:  nextHistory.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!resp.ok) {
        const e = await resp.json().catch(() => ({ error: resp.statusText }));
        setChatError((e as { error?: string }).error ?? "Chat failed");
        // Remove the user message from history if the request failed.
        setChatMessages((prev) => prev.slice(0, -1));
        return;
      }

      const data = await resp.json() as { answer: string; guard: GuardResult; dataCutoff: string };
      const assistantMsg: ChatMessage = { role: "assistant", content: data.answer, guard: data.guard };
      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "Chat failed");
      setChatMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsChatting(false);
    }
  };

  // ── Batch generation ─────────────────────────────────────────────────────────

  const runBatch = async () => {
    if (!stateHead.trim() || !isBatchableType) return;
    setIsBatching(true);
    setBatchProgress([]);
    setBatchDocs([]);
    setBatchSummary(null);
    setBatchError(null);
    setResult(null);

    const collectedDocs: BatchDoc[] = [];

    try {
      const response = await fetch("/api/ai/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fy, stateHead: stateHead.trim(), reportType, period: periodMode }),
      });

      if (!response.ok || !response.body) {
        const errData = await response.json().catch(() => ({ error: response.statusText }));
        setBatchError((errData as { error?: string }).error ?? "Request failed");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as BatchEvent;

            switch (event.type) {
              case "batch_start":
                // Pre-populate all member rows as queued immediately.
                setBatchProgress(event.memberNames.map((name) => ({ member: name, status: "queued" as const })));
                break;

              case "member_start":
                setBatchProgress((prev) =>
                  prev.map((p) => p.member === event.member ? { ...p, status: "generating" as const } : p),
                );
                break;

              case "doc_done": {
                const doc: BatchDoc = {
                  member: event.member,
                  reportType: event.reportType,
                  dataCutoff: event.dataCutoff,
                  source: event.source,
                  result: event.result,
                  periodCoveredLabel: event.result.periodCoveredLabel as string | undefined,
                  periodCoveredShort: event.result.periodCoveredShort as string | undefined,
                  periodMismatch: event.result.periodMismatch as boolean | undefined,
                  selectedPeriod: event.result.selectedPeriod as string | undefined,
                };
                collectedDocs.push(doc);
                setBatchDocs((prev) => [...prev, doc]);
                setBatchProgress((prev) =>
                  prev.map((p) =>
                    p.member === event.member
                      ? { ...p, status: event.source === "cache" ? "cached" : "done", source: event.source }
                      : p,
                  ),
                );
                break;
              }

              case "doc_failed":
                setBatchProgress((prev) =>
                  prev.map((p) =>
                    p.member === event.member
                      ? { ...p, status: "failed" as const, error: event.error }
                      : p,
                  ),
                );
                break;

              case "batch_done":
                setBatchSummary(event.summary);
                // Auto-download ZIP when > 5 documents; otherwise keep inline previews.
                if (collectedDocs.length > 5) {
                  await downloadBatchZip(collectedDocs, fy, stateHead.trim(), reportType);
                }
                break;

              case "error":
                setBatchError(event.error);
                break;
            }
          } catch {
            // Ignore malformed SSE lines.
          }
        }
      }
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : "Batch failed");
    } finally {
      setIsBatching(false);
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
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {/* Financial Year — set via the global filter bar */}
            <div className="space-y-1.5">
              <Label className="text-xs">Financial Year</Label>
              <div className="h-8 px-2 text-sm rounded-md border border-input bg-muted/40 flex items-center text-muted-foreground">
                FY {fy}
              </div>
            </div>

            {/* State Head */}
            <div className="space-y-1.5">
              <Label htmlFor="ai-sh" className="text-xs">State Head</Label>
              <select
                id="ai-sh"
                value={stateHead}
                onChange={(e) => { setStateHead(e.target.value); setMember(""); }}
                className="w-full h-8 px-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">— select —</option>
                {stateHeadOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>

            {/* Member */}
            <div className="space-y-1.5">
              <Label htmlFor="ai-mb" className="text-xs">Member (member reports)</Label>
              <select
                id="ai-mb"
                value={member}
                onChange={(e) => setMember(e.target.value)}
                disabled={!stateHead || memberOptions.length === 0}
                className="w-full h-8 px-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">— select —</option>
                {memberOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>

            {/* Distributor — free text (no roster API available) */}
            <div className="space-y-1.5">
              <Label htmlFor="ai-dist" className="text-xs">Distributor (distributor reports)</Label>
              <Input id="ai-dist" value={distributorName} onChange={(e) => setDistributorName(e.target.value)} placeholder="e.g. Jagdamba Traders" className="h-8 text-sm" />
            </div>
          </div>

          {/* ── Master Growth Report ── */}
          <div className="space-y-1.5 border border-border/40 rounded-lg p-3 bg-muted/10">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Company-Wide Growth Report</p>
              <button
                onClick={() => { setReportType("full-growth-report"); setResult(null); setSignedOff(false); }}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                  reportType === "full-growth-report"
                    ? "bg-primary text-primary-foreground border-primary"
                    : isEnabled("full-growth-report")
                    ? "border-border text-foreground hover:bg-muted"
                    : "border-border/40 text-muted-foreground/50 cursor-not-allowed",
                )}
              >
                Master Growth Report
              </button>
            </div>

            {/* Scope — shown only when this type is selected */}
            {reportType === "full-growth-report" && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                {/* Scope selector */}
                <div className="space-y-1">
                  <Label className="text-xs">Scope</Label>
                  <div className="flex gap-2">
                    {(["company", "statehead", "state"] as const).map(s => (
                      <button
                        key={s}
                        onClick={() => setGrowthScope(s)}
                        className={cn(
                          "px-2.5 py-1 rounded text-xs font-medium border transition-colors",
                          growthScope === s ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted",
                        )}
                      >
                        {s === "company" ? "Company" : s === "statehead" ? "State Head" : "State"}
                      </button>
                    ))}
                  </div>
                </div>

                {/* State Head — only when scope = statehead */}
                {growthScope === "statehead" && (
                  <div className="space-y-1">
                    <Label htmlFor="gr-sh" className="text-xs">State Head</Label>
                    <select
                      id="gr-sh"
                      value={stateHead}
                      onChange={(e) => setStateHead(e.target.value)}
                      className="w-full h-8 px-2 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="">— select —</option>
                      {stateHeadOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </div>
                )}

                {/* State — only when scope = state */}
                {growthScope === "state" && (
                  <div className="space-y-1">
                    <Label htmlFor="gr-state" className="text-xs">State</Label>
                    <Input
                      id="gr-state"
                      value={growthState}
                      onChange={(e) => setGrowthState(e.target.value)}
                      placeholder="e.g. RAJASTHAN"
                      className="h-8 text-sm"
                    />
                  </div>
                )}

                {/* Conversion assumptions */}
                <div className="space-y-1 col-span-full sm:col-span-1">
                  <Label className="text-xs">Conversion assumptions</Label>
                  <div className="flex flex-wrap gap-3">
                    {[
                      { label: "Dormant revival %", value: dormantRevivalPct, set: setDormantRevivalPct },
                      { label: "At-risk recovery %", value: atRiskRecoveryPct, set: setAtRiskRecoveryPct },
                      { label: "Range uptake %", value: rangeUptakePct, set: setRangeUptakePct },
                    ].map(a => (
                      <div key={a.label} className="flex items-center gap-1">
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">{a.label}:</span>
                        <input
                          type="number"
                          min={0} max={100} step={1}
                          value={a.value}
                          onChange={(e) => a.set(Math.max(0, Math.min(100, Number(e.target.value))))}
                          className="w-14 h-7 px-2 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Member / team reports */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Member and Team Reports</p>
            <div className="flex flex-wrap gap-2">
              {MEMBER_REPORT_TYPES.map((rt) => (
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
                  {rt.requiresMember && !member.trim() && <span className="ml-1 text-[10px] opacity-60">(needs member)</span>}
                  {rt.requiresStateHead && !stateHead.trim() && <span className="ml-1 text-[10px] opacity-60">(needs state head)</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Distributor reports */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Distributor Reports</p>
            <div className="flex flex-wrap gap-2">
              {DISTRIBUTOR_REPORT_TYPES.map((rt) => (
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
                  {!stateHead.trim() && <span className="ml-1 text-[10px] opacity-60">(needs state head)</span>}
                  {rt.requiresDistributor && stateHead.trim() && !distributorName.trim() && <span className="ml-1 text-[10px] opacity-60">(needs distributor)</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* All Members toggle — only shown for batchable member-level report types */}
            {isBatchableType && !isDistributorType(reportType) && stateHead.trim() && (
              <button
                onClick={() => {
                  setBatchMode((v) => !v);
                  setBatchProgress([]);
                  setBatchDocs([]);
                  setBatchSummary(null);
                  setBatchError(null);
                }}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {batchMode ? <CheckSquare className="w-3.5 h-3.5 text-primary" /> : <Square className="w-3.5 h-3.5" />}
                All members
              </button>
            )}

            {batchMode ? (
              <Button onClick={runBatch} disabled={isBatching || !stateHead.trim()} size="sm">
                {isBatching ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Generating batch…</>
                ) : (
                  "Generate for all members"
                )}
              </Button>
            ) : (
              <Button onClick={generate} disabled={isLoading || !canGenerate} size="sm">
                {isLoading ? "Generating..." : "Generate"}
              </Button>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {/* ── Batch progress card ── */}
      {(isBatching || batchProgress.length > 0) && (
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">
                {isBatching ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    Generating batch…
                  </span>
                ) : "Batch complete"}
              </CardTitle>
              {/* Summary pills */}
              {batchSummary && (
                <div className="flex gap-2 text-[10px] flex-wrap">
                  {[
                    { label: `${batchSummary.total} total`, cls: "bg-muted text-foreground" },
                    { label: `${batchSummary.generated} generated`, cls: "bg-primary/10 text-primary" },
                    { label: `${batchSummary.cached} from cache`, cls: "bg-green-100 text-green-800" },
                    ...(batchSummary.failed > 0 ? [{ label: `${batchSummary.failed} failed`, cls: "bg-destructive/10 text-destructive" }] : []),
                  ].map((p) => (
                    <span key={p.label} className={cn("px-2 py-0.5 rounded-full font-medium", p.cls)}>{p.label}</span>
                  ))}
                  {batchSummary.generated > 0 && (
                    <span className="px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800">
                      {batchSummary.generated} API call{batchSummary.generated !== 1 ? "s" : ""} used
                    </span>
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {batchError && (
              <p className="text-sm text-destructive">{batchError}</p>
            )}

            {/* Per-member progress table */}
            {batchProgress.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/40">
                      {["Member", "Status", "Source"].map((h) => (
                        <th key={h} className="py-2 px-2 text-left font-medium text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {batchProgress.map((p) => (
                      <tr key={p.member} className="border-t border-border/30">
                        <td className="py-1.5 px-2 font-medium">{p.member}</td>
                        <td className="py-1.5 px-2">
                          <span className={cn(
                            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium",
                            p.status === "queued"     && "bg-muted text-muted-foreground",
                            p.status === "generating" && "bg-primary/10 text-primary",
                            p.status === "done"       && "bg-green-100 text-green-800",
                            p.status === "cached"     && "bg-green-50 text-green-700",
                            p.status === "failed"     && "bg-destructive/10 text-destructive",
                          )}>
                            {p.status === "generating" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                            {p.status}
                          </span>
                          {p.error && <span className="ml-1 text-muted-foreground truncate max-w-[200px]" title={p.error}>— {p.error.slice(0, 60)}</span>}
                        </td>
                        <td className="py-1.5 px-2 text-muted-foreground">
                          {p.source === "cache" ? "cache" : p.source === "api" ? "API call" : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Actions + inline previews when batch done */}
            {batchSummary && batchDocs.length > 0 && (
              <div className="space-y-3 pt-1">
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => downloadBatchZip(batchDocs, fy, stateHead.trim(), reportType)}
                  >
                    <Download className="w-3.5 h-3.5 mr-1.5" />
                    Download ZIP ({batchDocs.length} document{batchDocs.length !== 1 ? "s" : ""})
                  </Button>
                  {batchDocs.length > 5 && (
                    <p className="text-xs text-muted-foreground">More than 5 documents — ZIP was auto-downloaded. Use the button above to re-download.</p>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Format note: batch packs download as print-ready HTML documents (open any file and use the
                  browser&rsquo;s Print &rarr; Save as PDF for a PDF copy). Individual reports export as PDF via
                  the preview window, and decks export as editable PowerPoint (PPTX). This difference is deliberate:
                  HTML keeps large batches fast to generate and easy to review, while single documents are
                  print-finalised.
                </p>

                {/* Inline compact previews for ≤ 5 members */}
                {batchDocs.length <= 5 && (
                  <div className="space-y-3">
                    {batchDocs.map((doc, i) => <BatchMemberCard key={i} doc={doc} />)}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          <GuardBanner guard={result.guard as GuardResult} />
          {"dataCutoff" in result && <PeriodMismatchBanner result={result as PeriodMeta & { dataCutoff: string }} />}

          {/* ── Full Distributor Report ── */}
          {result.type === "full-distributor-report" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.distributor} — Distributor Report (Full)</p>
                  <p className="text-xs text-muted-foreground">{result.stateHead} · {result.periodLabel} · Data cutoff: {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => {
                  const w = window.open("", "_blank");
                  if (!w) return;
                  const el = document.getElementById("full-report-print-zone");
                  w.document.write(`<html><head><title>Distributor Report — ${result.distributor}</title><style>
                    body{font-family:system-ui,sans-serif;font-size:11px;max-width:900px;margin:2rem auto;color:#111}
                    h1{font-size:1rem;font-weight:600}h2{font-size:0.8rem;font-weight:600;border-bottom:1px solid #ddd;padding-bottom:2px;margin-top:1.5rem}
                    table{width:100%;border-collapse:collapse}td,th{padding:2px 4px;border-bottom:1px solid #eee;text-align:left}th{color:#666}
                    @media print{body{margin:1rem}}
                  </style></head><body>${el?.innerHTML ?? ""}</body></html>`);
                  w.document.close(); w.print();
                }}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              <div id="full-report-print-zone">
                <FullDistributorReport data={result} />
              </div>
            </>
          )}

          {/* ── Full Growth Report ── */}
          {result.type === "full-growth-report" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">Master Growth Report — {result.scopeLabel}</p>
                  <p className="text-xs text-muted-foreground">{result.periodLabel} · Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => {
                  const w = window.open("", "_blank");
                  if (!w) return;
                  const el = document.getElementById("full-growth-print-zone");
                  w.document.write(`<html><head><title>Master Growth Report — ${result.scopeLabel}</title><style>
                    body{font-family:system-ui,sans-serif;font-size:11px;max-width:960px;margin:2rem auto;color:#111}
                    h1{font-size:1rem;font-weight:600}h2{font-size:0.8rem;font-weight:600;border-bottom:1px solid #ddd;padding-bottom:2px;margin-top:1.5rem}
                    table{width:100%;border-collapse:collapse}td,th{padding:2px 4px;border-bottom:1px solid #eee;text-align:left}th{color:#666}
                    @media print{body{margin:1rem}}
                  </style></head><body>${el?.innerHTML ?? ""}</body></html>`);
                  w.document.close(); w.print();
                }}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              <div id="full-growth-print-zone">
                <FullGrowthReport data={result} />
              </div>
            </>
          )}

          {/* ── Full State Head Report ── */}
          {result.type === "full-statehead-report" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.stateHead} — State Head Report (Full)</p>
                  <p className="text-xs text-muted-foreground">{result.periodLabel} · Data cutoff: {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => {
                  const w = window.open("", "_blank");
                  if (!w) return;
                  const el = document.getElementById("full-statehead-print-zone");
                  w.document.write(`<html><head><title>State Head Report — ${result.stateHead}</title><style>
                    body{font-family:system-ui,sans-serif;font-size:11px;max-width:900px;margin:2rem auto;color:#111}
                    h1{font-size:1rem;font-weight:600}h2{font-size:0.8rem;font-weight:600;border-bottom:1px solid #ddd;padding-bottom:2px;margin-top:1.5rem}
                    table{width:100%;border-collapse:collapse}td,th{padding:2px 4px;border-bottom:1px solid #eee;text-align:left}th{color:#666}
                    @media print{body{margin:1rem}}
                  </style></head><body>${el?.innerHTML ?? ""}</body></html>`);
                  w.document.close(); w.print();
                }}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              <div id="full-statehead-print-zone">
                <FullStateHeadReport data={result} />
              </div>
            </>
          )}

          {/* ── State Head Report ── */}
          {result.type === "statehead-report" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.stateHead} — State Head Report</p>
                  <p className="text-xs text-muted-foreground">Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => {
                  const pm = periodMetaOf(result);
                  exportSectionsPdf(`State Head Report — ${result.stateHead}`, result.dataCutoff, result.sections, undefined, { coveredLabel: pm.coveredLabel, dataCutoff: result.dataCutoff, fy: result.fy, mismatch: pm.mismatch, selectedPeriod: pm.selectedPeriod });
                }}>
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
                            <td className="py-1.5 px-2">{trunc2(cr(m.totalOB))}</td>
                            <td className="py-1.5 px-2">{m.target != null ? trunc2(cr(m.target)) : "—"}</td>
                            <td className="py-1.5 px-2">{m.achievementPct != null ? `${trunc2(m.achievementPct)}%` : "—"}</td>
                            <td className="py-1.5 px-2">{trunc2(cr((m as any).sale))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          {/* ── Member Suggestions ── */}
          {result.type === "suggestions" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.member} — Suggestions and Actions</p>
                  <p className="text-xs text-muted-foreground">Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => {
                  const pm = periodMetaOf(result);
                  exportSuggestionsPdf(result.member, result.intro, result.suggestions, undefined, { coveredLabel: pm.coveredLabel, dataCutoff: result.dataCutoff, fy: result.fy, mismatch: pm.mismatch, selectedPeriod: pm.selectedPeriod });
                }}>
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
                        <Badge variant={s.effort === "low" ? "default" : s.effort === "medium" ? "secondary" : "destructive"} className="text-xs flex-shrink-0">{s.effort} effort</Badge>
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
                <Button size="sm" variant="outline" onClick={() => {
                  const pm = periodMetaOf(result);
                  exportTravelPlanPdf(result.member, result.sections, result.monthPlans, { coveredLabel: pm.coveredLabel, dataCutoff: result.dataCutoff, fy: result.fy, mismatch: pm.mismatch, selectedPeriod: pm.selectedPeriod });
                }}>
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
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
                <p className="text-sm font-medium text-amber-900">This document is a draft. It must not be distributed to {result.member}. Sign off below to enable export.</p>
                <button onClick={() => setSignedOff((v) => !v)} className="flex items-center gap-2 text-sm text-amber-800 hover:text-amber-900">
                  {signedOff ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                  I confirm this review is for internal management use only and will not be shared with the individual named above.
                </button>
                {signedOff && (
                  <Button size="sm" variant="outline" onClick={() => {
                    const pm = periodMetaOf(result);
                    exportPerformanceReviewPdf(result.member, result.sections, { coveredLabel: pm.coveredLabel, dataCutoff: result.dataCutoff, fy: result.fy, mismatch: pm.mismatch, selectedPeriod: pm.selectedPeriod });
                  }}>
                    <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF (Management Only)
                  </Button>
                )}
              </div>
            </>
          )}

          {/* ── Presentation (member-level 8-12 slides OR state-head 27-slide A4A) ── */}
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

              {/* A4-A 27-slide state-head deck */}
              {result.teamSlides && result.teamSlides.length > 0 ? (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Team Slides (1–11)</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {result.teamSlides.map((slide, i) => (
                        <SlidePreview key={i} slide={slide} payload={result.payload} memberRanking={result.memberRanking} />
                      ))}
                    </div>
                  </div>

                  {result.memberSlides && result.memberSlides.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Member Slides ({result.memberSlides.length} members)</p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {result.memberSlides.map((slide, i) => (
                          <DeckMemberSlideCard key={i} slide={slide} />
                        ))}
                      </div>
                    </div>
                  )}

                  {result.closingSlides && result.closingSlides.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Closing Slides (25–27)</p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {result.closingSlides.map((slide, i) => (
                          <SlidePreview key={i} slide={slide} payload={result.payload} memberRanking={null} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* Original member-level deck */
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {result.slides.map((slide, i) => (
                    <SlidePreview key={i} slide={slide} payload={result.payload} memberRanking={result.memberRanking} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Distributor Territory Report ── */}
          {result.type === "distributor-statehead-report" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.stateHead} — Distributor Channel Report</p>
                  <p className="text-xs text-muted-foreground">Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => exportSectionsPdf(`Distributor Channel Report — ${result.stateHead}`, result.dataCutoff, result.sections)}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              <DistributorTable payload={result.payload} />
              <WhitespaceCard payload={result.payload} />
              <div className="space-y-3">
                {Object.values(result.sections).map((s, i) => <SectionCard key={i} section={s} />)}
              </div>
            </>
          )}

          {/* ── Single Distributor Report ── */}
          {result.type === "distributor-report" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.distributor} — Distributor Report</p>
                  <p className="text-xs text-muted-foreground">{result.stateHead} · Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => exportSectionsPdf(`Distributor Report — ${result.distributor}`, `${result.stateHead} · ${result.dataCutoff}`, result.sections)}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              {result.payload.dataQuality && result.payload.dataQuality.length > 0 && (
                <div className="space-y-1">
                  {result.payload.dataQuality.map((f) => (
                    <div key={f.code} className="flex gap-2 p-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800">
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span><span className="font-mono font-semibold mr-1">{f.code}</span>{f.message}</span>
                    </div>
                  ))}
                </div>
              )}
              <DistributorTable payload={result.payload} />
              <div className="space-y-3">
                {Object.values(result.sections).map((s, i) => <SectionCard key={i} section={s} />)}
              </div>
            </>
          )}

          {/* ── Distributor Suggestions ── */}
          {result.type === "distributor-suggestions" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.stateHead} — Distributor Channel Suggestions</p>
                  <p className="text-xs text-muted-foreground">Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => exportSuggestionsPdf(`${result.stateHead} — Distributor Channel`, result.intro, result.suggestions)}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              <WhitespaceCard payload={result.payload} />
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
                        <Badge variant={s.effort === "low" ? "default" : s.effort === "medium" ? "secondary" : "destructive"} className="text-xs flex-shrink-0">{s.effort} effort</Badge>
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

          {/* ── Distributor Review ── */}
          {result.type === "distributor-review" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{result.distributor} — Channel Review</p>
                  <p className="text-xs text-muted-foreground">{result.stateHead} · Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => exportSectionsPdf(`Channel Review — ${result.distributor}`, `${result.stateHead} · ${result.dataCutoff}`, result.sections)}>
                  <FileDown className="w-3.5 h-3.5 mr-1.5" />Export PDF
                </Button>
              </div>
              <DistributorTable payload={result.payload} />
              <div className="space-y-3">
                {Object.values(result.sections).map((s, i) => <SectionCard key={i} section={s} />)}
              </div>
            </>
          )}

          {/* ── Distributor Presentation ── */}
          {result.type === "distributor-presentation" && (
            <>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <p className="text-sm font-semibold">{result.deckTitle}</p>
                  <p className="text-xs text-muted-foreground">{result.deckSubtitle} · Data to {result.dataCutoff}</p>
                </div>
                <Button size="sm" onClick={() => exportDistributorPptx(result)}>
                  <Presentation className="w-3.5 h-3.5 mr-1.5" />Download PPTX
                </Button>
              </div>
              <WhitespaceCard payload={result.payload} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {result.slides.map((slide, i) => (
                  <SlidePreview key={i} slide={slide} distPayload={result.payload} memberRanking={null} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Ask Claude chat box ── */}
      {(stateHead.trim() || member.trim()) && (
        <Card className="border-border/50">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base">Ask about this data</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Scoped to{" "}
                  <span className="font-medium text-foreground">
                    {member.trim() || stateHead.trim()}
                  </span>
                  {" "}· FY{fy}. Change the filter to ask about someone else.
                </p>
              </div>
              {chatMessages.length > 0 && (
                <button
                  onClick={() => { setChatMessages([]); setChatError(null); setChatInput(""); }}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                >
                  Clear
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">

            {/* Message history */}
            {chatMessages.length > 0 && (
              <div
                ref={chatScrollRef}
                className="space-y-4 max-h-[520px] overflow-y-auto pr-1"
              >
                {chatMessages.map((msg, i) => (
                  <div key={i} className={msg.role === "user" ? "flex justify-end" : "space-y-1.5"}>
                    {msg.role === "user" ? (
                      <div className="max-w-[80%] px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm leading-relaxed">
                        {msg.content}
                      </div>
                    ) : (
                      <>
                        <div className="text-sm leading-relaxed text-foreground whitespace-pre-line">
                          {msg.content}
                        </div>

                        {/* Inline guard warning for unmatched figures */}
                        {msg.guard && msg.guard.status !== "ok" && msg.guard.unmatched.length > 0 && (
                          <div className="flex gap-2 p-2 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
                            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                            <span>
                              {msg.guard.unmatched.length} figure(s) not matched to the verified payload:{" "}
                              {msg.guard.unmatched.map((u, j) => (
                                <span key={j}>
                                  {j > 0 ? ", " : ""}
                                  <code className="font-mono bg-amber-100 px-0.5 rounded">{u.extracted}</code>
                                </span>
                              ))}
                            </span>
                          </div>
                        )}

                        {/* Per-answer action buttons */}
                        {i > 0 && chatMessages[i - 1].role === "user" && (
                          <div className="flex items-center gap-4">
                            <button
                              onClick={() => exportQaPdf(
                                chatMessages[i - 1].content,
                                msg.content,
                                `${member.trim() || stateHead.trim()} · FY${fy}`,
                              )}
                              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                            >
                              <FileDown className="w-3 h-3" />Export Q&A
                            </button>

                            {/* Add to suggestions PDF when suggestions result is in view */}
                            {result?.type === "suggestions" && (() => {
                              const r = result as Extract<GenerationResult, { type: "suggestions" }>;
                              return (
                                <button
                                  onClick={() => {
                                    const qaHtml = `
                                      <h2>Q&amp;A Appendix</h2>
                                      <p><strong>Question:</strong> ${chatMessages[i - 1].content.replace(/</g, "&lt;")}</p>
                                      <p><strong>Answer:</strong> ${msg.content.replace(/</g, "&lt;").replace(/\n/g, "<br/>")}</p>`;
                                    exportSuggestionsPdf(r.member ?? "", r.intro, r.suggestions, qaHtml);
                                  }}
                                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                                >
                                  <FileDown className="w-3 h-3" />Add to suggestions PDF
                                </button>
                              );
                            })()}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}

                {isChatting && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    Thinking…
                  </div>
                )}
              </div>
            )}

            {chatError && <p className="text-sm text-destructive">{chatError}</p>}

            {/* Input row */}
            <div className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendChat();
                  }
                }}
                placeholder={`Ask about ${member.trim() || stateHead.trim() || "the selected report"}…`}
                className="flex-1 h-9 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                disabled={isChatting}
              />
              {chatVoice.state !== "unsupported" && (
                <Button
                  type="button"
                  size="sm"
                  variant={chatVoice.state === "listening" ? "destructive" : "outline"}
                  onClick={chatVoice.start}
                  title={chatVoice.state === "listening" ? "Stop listening" : "Speak your question"}
                  className="px-2.5"
                >
                  {chatVoice.state === "listening" ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </Button>
              )}
              <Button
                onClick={() => void sendChat()}
                disabled={!chatInput.trim() || isChatting}
                size="sm"
              >
                {isChatting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
