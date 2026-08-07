// Phase A4 — Five additional AI artifact routes.
//
// All share the A1 payload, numeric guard, and no-arithmetic constraint.
// Architecture: app = numbers. Claude = judgement.
//
// Routes:
//   POST /api/ai/statehead-report  — team-level narrative (stateHead required)
//   POST /api/ai/suggestions       — ranked member suggestions (member required)
//   POST /api/ai/travel-plan       — visit plan covering narrative (member required)
//   POST /api/ai/performance-review — management-only review (member required)
//   POST /api/ai/presentation      — slide structure, charts native (member or stateHead)
//
// Rules:
//   Never console.log — use req.log / logger.
//   Never write to Google Drive.
//   Never send raw retailer rows to Claude.
//   model: claude-sonnet-4-6
//   max_tokens: 8192

import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { loadDeepDiveData, normSecKey, loadRegistry } from "../lib/mgmt/deepDiveData.js";
import type { MemberKpis } from "../lib/mgmt/deepDiveData.js";
import { buildStateHeadExtras } from "../lib/mgmt/aiStateHeadExtras.js";
import {
  buildMemberPayload,
  buildStateHeadPayload,
  isPeriodMismatch,
  type AiPayload,
} from "../lib/mgmt/aiPayload.js";
import { runNumericGuard, runPeriodGuard, type GuardResult, type PeriodGuardResult } from "../lib/mgmt/numericGuard.js";
import type { VisitPlan } from "../lib/mgmt/visitPlan.js";
import { getMemberFileId } from "../lib/mgmt/memberResolver.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;

// ── Shared helpers ─────────────────────────────────────────────────────────────

const CORE_NUMERIC_RULES = `\
ABSOLUTE RULES (all artifacts):
1. Use ONLY numbers present in the payload or supplementary data provided. Never compute, estimate, subtract, add, or derive any figure not present explicitly as a numeric value. If you need a derived figure (e.g. dormant = total − active), stop — write that the breakdown is not available.
2. Every quantitative claim must cite its source field in brackets immediately after the value — e.g. "Rs 26.21 lakh [performance.totalOB]". The numeric guard uses these citations.
3. Where a dataQuality flag is relevant to a claim, state the caveat in the SAME SENTENCE as the figure, not in a footnote.
4. Write in English. No emojis. Management register; refer to the person in the third person.
5. Null means null. Never substitute a plausible estimate. If a field is null, state the data is unavailable and why.
6. For order booking: always present performance.secondaryOB and performance.directDealerOB separately before stating performance.totalOB.
7. All four achievement ratios must appear separately: totalOBPct, secondaryOBPct, directDealerPct, salePct.
8. If productSpread is null or available is false, write: "Item-code level data is not available for this financial year as this analysis requires a completed financial year."
9. Do NOT use "per Rs 100" normalisation phrases. Express ratios as percentages or direct values.
10. 4-digit calendar years (2020-2030) in "FY2026-27" style text are excluded from the guard.
11. Distance band labels (e.g. "Mid (15-40 km)") appear verbatim in visits.distanceBands[].label. Copy them exactly.
12. Do NOT invent prior-year OB or sale figures. priorYears.ob and priorYears.sale may be null for open FYs.

PERIOD COVERAGE RULE: The figures cover identity.periodCoveredLabel (year to date from April). Do not attribute any payload figure to a single specific month — "in April the team booked Rs X" implies a per-month figure from cumulative data and will be flagged by the period guard. You may reference the coverage window months in context, but never assign a payload number exclusively to one sub-month.`;

async function resolveStateHeadMembers(fy: string, stateHead: string): Promise<{
  members: MemberKpis[];
  error: string | null;
}> {
  const data = await loadDeepDiveData(fy, stateHead, undefined);
  const refs = data.members;
  if (refs.length === 0) {
    return { members: [], error: `State head '${stateHead}' not found or has no members.` };
  }
  const kpiList = await Promise.all(
    refs.map((ref) => loadDeepDiveData(fy, ref.stateHead, ref.normKey).then((d) => d.kpis)),
  );
  return {
    members: kpiList.filter((k): k is MemberKpis => k !== null),
    error: null,
  };
}

function gatherStrings(obj: unknown): string {
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map(gatherStrings).join(" ");
  if (obj !== null && typeof obj === "object") {
    return Object.values(obj as Record<string, unknown>).map(gatherStrings).join(" ");
  }
  return "";
}

function guardCustom(obj: unknown, payload: AiPayload, extra?: unknown): GuardResult {
  const payloadForGuard = extra
    ? ({ ...payload, _extra: extra } as unknown as AiPayload)
    : payload;
  return runNumericGuard(
    { content: { title: "", body: gatherStrings(obj) } },
    payloadForGuard,
  );
}

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function parseBody(body: unknown): {
  fy: string;
  stateHead: string | undefined;
  member: string | undefined;
  period: string;
} {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    fy: typeof b.fy === "string" && b.fy.trim() ? b.fy.trim() : "2026-27",
    stateHead: typeof b.stateHead === "string" && b.stateHead.trim() ? b.stateHead.trim() : undefined,
    member: typeof b.member === "string" && b.member.trim() ? b.member.trim() : undefined,
    period: typeof b.period === "string" && b.period.trim() ? b.period.trim() : "ytd",
  };
}

// ── 1. State Head Report ───────────────────────────────────────────────────────

const STATEHEAD_REPORT_PROMPT = `You are generating a state-head team management report for Prayag India's sales leadership.

Your SOLE data source is the verified aggregate payload and the memberRanking array provided. An automated numeric guard will flag every number not matched to these sources.

${CORE_NUMERIC_RULES}

STATE HEAD REPORT ADDITIONAL RULES:
14. The memberRanking array lists every ACTIVE team member with their name, totalOB, target, achievementPct, and sale. You may cite any of these figures — they are verified. Write each member's own figures alongside their name.
15. Do NOT write one member's figures as a direct comparison to another named member in the same sentence. You may use positional language ("the highest-ranked member accounts for X% of team OB") or ordinal rank ("third of Y members").
16. The dataQuality array lists members in the NO_MEMBER_SHEET message by name. Name every such member in the dataQualityAndRisks section. State explicitly that the aggregate is built on partial detail where membersWithoutSheet > 0.
17. memberPerformance body: rank members from highest to lowest totalOB. Cite each member's totalOB and achievementPct alongside their name. Do not omit any active member.
18. DEPARTED MEMBERS: The user message may include a "Departed members" section listing members whose status is LEFT. If that section is present you MUST:
    a. Open the teamPosition section by naming every departed member explicitly and stating their historical OB, sale, retailers, and visits for the period.
    b. State clearly that the current achievement percentage EXCLUDES the targets of the departed members. This is an organisational change — not commercial improvement. A reader comparing this period's achievement against a prior period when those members were active MUST NOT interpret the difference as performance gain.
    c. Do NOT include departed members in the memberPerformance ranking. They belong only in the teamPosition narrative.
19. ROSTER CHANGES: When a "Roster changes" block is provided, cite BOTH achievement figures (achievementPctActiveOnly and achievementPctIncludingDeparted) side by side and describe the difference in words as an organisational effect — e.g. "the team's achievement reads X% on active members but Y% when departed members' targets are included; the movement is a roster change, not a commercial gain".
20. SKU CONTENT: When an "SKU gap and push content" block is provided, include in the report:
    a. The top gap segments by value (these are territory-only figures) with their peak quarter beside each recommendation.
    b. For each push list: the distributor's name, the top codes with tier labels and peer counts, and NAME the peers from peerNames when explaining the evidence ("N peers including A, B and C are buying this code").
    c. Where discountAboveOwnNormPts is present on a code, state that the code is currently sold at a discount above its own historical norm — a margin question before a volume opportunity.
    d. If the sku block is null or a push list is suppressed, say the SKU evidence is not available for this territory rather than omitting silently.
21. NEVER sum, combine, or otherwise derive totals across the extras blocks (e.g. adding two members' historical OB together). Cite each figure individually as it appears.
22. MULTI-YEAR VIEW: When a "Multi-year like-months view" block is provided, present the years side by side, ALWAYS naming each fiscal year and stating that every year is restricted to the same like-months window. A null year means attribution is unavailable for that year — not zero business (say so).

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "teamPosition":        { "title": "Team Position",             "body": "..." },
  "memberPerformance":   { "title": "Member Performance Ranking","body": "..." },
  "coverageAndEffort":   { "title": "Coverage and Effort",       "body": "..." },
  "dataQualityAndRisks": { "title": "Data Quality and Risks",    "body": "..." },
  "actionsForManagement":{ "title": "Recommended Actions",       "body": "..." }
}`;

router.post("/ai/statehead-report", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead, period } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!stateHead) { res.status(400).json({ error: "stateHead is required for this report." }); return; }

  req.log.info({ fy, stateHead }, "ai/statehead-report: request");

  try {
    const { members: allMembers, error: loadErr } = await resolveStateHeadMembers(fy, stateHead);
    if (loadErr) { res.status(404).json({ error: loadErr }); return; }
    if (allMembers.length === 0) { res.status(404).json({ error: "No member data found for this state head." }); return; }

    // Aggregate figures are computed on ACTIVE members only.
    const activeMembers = allMembers.filter((m) => !m.isLeft);
    const leftMembers   = allMembers.filter((m) => m.isLeft);
    const payloadMembers = activeMembers.length > 0 ? activeMembers : allMembers;

    const payload = buildStateHeadPayload(fy, stateHead, period, payloadMembers);

    const memberRanking = payloadMembers
      .map((m) => ({
        name: m.name,
        totalOB: (m.orderBooking ?? 0) + (m.directDealersOrder ?? 0),
        target: m.totalTargetToDate ?? null,
        achievementPct:
          m.totalTargetToDate && m.totalTargetToDate > 0
            ? Math.round(((m.orderBooking ?? 0) + (m.directDealersOrder ?? 0)) / m.totalTargetToDate * 1000) / 10
            : null,
        sale: m.sale ?? 0,
      }))
      .sort((a, b) => b.totalOB - a.totalOB);

    // Departed members context — passed to Claude so it can name them explicitly.
    const departedContext = leftMembers.length > 0
      ? `\n\nDeparted members (status: LEFT — historical business for this period, excluded from all aggregate figures and the ranking above):\n${JSON.stringify(
          leftMembers.map((m) => ({
            name: m.name,
            historicalOB: Math.round((m.orderBooking ?? 0) + (m.directDealersOrder ?? 0)),
            historicalSale: Math.round(m.sale ?? 0),
            retailers: m.totalOldRetailers ?? 0,
            visits: m.visitedRetailers ?? 0,
            target: Math.round(m.totalTargetToDate ?? 0),
          })),
          null, 2,
        )}`
      : "";

    // Part 4 extras: SKU gap/push content, multi-year like-months view,
    // roster-change achievement (with vs without departed members).
    const extras = await buildStateHeadExtras(fy, stateHead, allMembers).catch((err) => {
      req.log.warn({ err, fy, stateHead }, "ai/statehead-report: extras failed — continuing without");
      return null;
    });

    const extrasContext = extras
      ? `\n\nSKU gap and push content (app-computed, verified — cite freely; peers are NAMED in peerNames):\n${JSON.stringify(extras.sku, null, 2)}` +
        `\n\nMulti-year like-months view (same fiscal window every year — name the years when citing):\n${JSON.stringify(extras.multiYear, null, 2)}` +
        `\n\nRoster changes (organisational effect — achievement with vs without departed members):\n${JSON.stringify(extras.rosterChanges, null, 2)}`
      : "";

    const userMsg =
      `Verified state-head aggregate payload (JSON) — active members only:\n${JSON.stringify(payload, null, 2)}\n\n` +
      `Member ranking by total OB (active members only, app-computed, verified — cite freely):\n${JSON.stringify(memberRanking, null, 2)}` +
      departedContext +
      extrasContext;

    // Richer content (SKU push lists, multi-year, roster changes) needs more
    // output room than the default cap — a truncated response breaks JSON.parse.
    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: 16000,
      system: STATEHEAD_REPORT_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const sections = JSON.parse(stripFences(rawJson)) as Record<string, { title: string; body: string }>;

    // Guard extra includes departed member figures so they can be cited freely.
    const departedForGuard = leftMembers.map((m) => ({
      historicalOB: Math.round((m.orderBooking ?? 0) + (m.directDealersOrder ?? 0)),
      historicalSale: Math.round(m.sale ?? 0),
      retailers: m.totalOldRetailers ?? 0,
      visits: m.visitedRetailers ?? 0,
      target: Math.round(m.totalTargetToDate ?? 0),
    }));
    const guard = guardCustom(sections, payload, { memberRanking, departedMembers: departedForGuard, extras });
    const periodGuard: PeriodGuardResult = runPeriodGuard(sections, payload.identity.periodToFiscalMonth);

    req.log.info({ stateHead, active: activeMembers.length, departed: leftMembers.length, guardStatus: guard.status, unmatched: guard.unmatched.length }, "ai/statehead-report: done");

    res.json({
      fy, stateHead,
      dataCutoff: payload.identity.dataCutoff,
      generatedAt: payload.identity.generatedAt,
      periodCoveredLabel: payload.identity.periodCoveredLabel,
      periodCoveredShort: payload.identity.periodCoveredShort,
      selectedPeriod: period,
      periodMismatch: isPeriodMismatch(period, payload.identity.periodToFiscalMonth),
      sections, guard, periodGuard, memberRanking,
      departedMembersExcluded: leftMembers.length,
      extras,
    });
  } catch (err) {
    req.log.error({ err, fy, stateHead }, "ai/statehead-report: error");
    res.status(502).json({ error: "Report generation failed. Please retry." });
  }
});

// ── 2. Suggestions ─────────────────────────────────────────────────────────────

const SUGGESTIONS_PROMPT = `You are generating ranked sales improvement suggestions for a Prayag India sales member.

Your SOLE data source is the verified payload provided. An automated numeric guard will flag every number not matched to a payload field.

${CORE_NUMERIC_RULES}

SUGGESTIONS ADDITIONAL RULES:
14. Return suggestions ordered strictly by ease of execution, easiest first. The typical ordering for a salesperson is:
    (a) Assign unassigned retailers — low effort, high certainty (management/system action, not field work).
    (b) Redirect field visits away from non-converting visited-but-dormant accounts toward unvisited retailers.
    (c) Range expansion — introduce new product categories with active buyers showing ordering history.
    Only generate suggestions that are motivated by actual payload figures. Do not suggest things not grounded in the data.
15. Each suggestion must name the exact payload field (e.g. "coverage.dormant") that motivates it.
16. "metric" is a plain English description of the motivating figure plus its value (e.g. "31 unassigned retailers [coverage.dormant — UNASSIGNED_RETAILERS flag]").
17. Do NOT suggest anything that requires arithmetic not shown in the payload.

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "intro": "One sentence context for these suggestions.",
  "suggestions": [
    {
      "rank": 1,
      "title": "...",
      "metric": "...",
      "payloadField": "exact.field.path",
      "expectedEffect": "...",
      "effort": "low | medium | high",
      "action": "Specific action statement — who does what."
    }
  ]
}`;

router.post("/ai/suggestions", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead, member: memberRaw, period } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!memberRaw) { res.status(400).json({ error: "member is required for suggestions." }); return; }

  req.log.info({ fy, stateHead, member: memberRaw }, "ai/suggestions: request");

  try {
    const registry = await loadRegistry(fy);
    const sugResolved = registry?.resolve(memberRaw, stateHead ? { stateHead } : undefined);
    if (sugResolved?.kind === "ambiguous") {
      res.status(400).json({ error: sugResolved.message, candidates: sugResolved.candidates.map((p) => ({ displayName: p.displayName, stateHead: p.stateHead, hq: p.hq ?? null })) });
      return;
    }
    const memberKey = sugResolved?.kind === "found" ? sugResolved.person.nsk : normSecKey(memberRaw);
    const data = await loadDeepDiveData(fy, stateHead, memberKey);
    if (!data.kpis) { res.status(404).json({ error: `Member '${memberRaw}' not found.` }); return; }

    const payload = buildMemberPayload(fy, stateHead ?? data.kpis.stateHead ?? null, period, data.kpis, data.retailerDetail, data.roiCost, data.skuSpread);

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: SUGGESTIONS_PROMPT,
      messages: [{ role: "user", content: `Verified payload (JSON):\n${JSON.stringify(payload, null, 2)}` }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const result = JSON.parse(stripFences(rawJson)) as { intro: string; suggestions: unknown[] };
    if (!Array.isArray(result.suggestions)) throw new Error("suggestions array missing");

    const guard = guardCustom(result, payload);
    const periodGuard: PeriodGuardResult = runPeriodGuard(
      { content: { title: "Suggestions", body: JSON.stringify(result) } },
      payload.identity.periodToFiscalMonth,
    );

    req.log.info({ member: data.kpis.name, count: result.suggestions.length, guardStatus: guard.status }, "ai/suggestions: done");

    res.json({
      fy, member: data.kpis.name, stateHead: data.kpis.stateHead,
      dataCutoff: payload.identity.dataCutoff,
      generatedAt: payload.identity.generatedAt,
      periodCoveredLabel: payload.identity.periodCoveredLabel,
      periodCoveredShort: payload.identity.periodCoveredShort,
      selectedPeriod: period,
      periodMismatch: isPeriodMismatch(period, payload.identity.periodToFiscalMonth),
      ...result, guard, periodGuard,
    });
  } catch (err) {
    req.log.error({ err, fy, member: memberRaw }, "ai/suggestions: error");
    res.status(502).json({ error: "Suggestions generation failed. Please retry." });
  }
});

// ── 3. Travel and Visit Plan ───────────────────────────────────────────────────

const TRAVEL_PLAN_PROMPT = `You are writing the covering narrative for a Prayag India sales member's visit plan.

The app has already computed the month-by-month visit plan. You write the covering explanation ONLY. Do NOT invent a schedule; the plan is provided.

Your SOLE data sources are the verified payload, the planContext, and the monthPlanSummary provided. An automated numeric guard will flag every number not matched to these sources.

${CORE_NUMERIC_RULES}

TRAVEL PLAN ADDITIONAL RULES:
14. State EXPLICITLY in the batchingBasis section: "Visit batching in this plan is by district and distance from base, not route optimisation. The data includes district, city, and distance from base, but no coordinates. Precision beyond this cannot be implied."
15. Do NOT list individual retailer names — they are not in the payload and must not be referenced.
16. monthPlanSummary shows each remaining month with workingDays, capacity (visits allocated), maintenanceVisits, developmentVisits, targetCount (number of retailers on the list), and poolExhausted (true when all new retailer prospects have been drawn). Write a brief narrative for each month. When poolExhausted is true, state that no new development targets remain for that month — maintenance visits continue.
17. The shortfall (capacity.gap) may be negative (more required than feasible). State it plainly.
18. Do NOT invent visit routes, sequences, or day-by-day schedules. The plan is month-level only.
19. Demonstrated visit rate: planContext.workingDaysActual is the member's own working days from the State Head Dashboard (AG column). Use this — not a calendar count — when describing the member's demonstrated visit pace.
20. If planContext.unassignedExcluded > 0, state explicitly in the coveringExplanation: how many retailers have been excluded from the forward plan because no distributor is assigned. Visiting them cannot generate orders until a distributor is allocated.

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "coveringExplanation": { "title": "Visit Plan — Covering Explanation", "body": "..." },
  "batchingBasis":       { "title": "Batching Basis and Data Limitations", "body": "..." },
  "capacitySummary":     { "title": "Capacity and Shortfall Summary",     "body": "..." },
  "monthNarratives":     { "title": "Month-by-Month Plan Notes",          "body": "..." },
  "caveats":             { "title": "Caveats",                            "body": "..." }
}`;

function getVisitPlanSafe(retailerDetail: unknown): VisitPlan | null {
  if (!retailerDetail || typeof retailerDetail !== "object") return null;
  const d = retailerDetail as Record<string, unknown>;
  if (d.status !== "ok") return null;
  return (d.visitPlan as VisitPlan | null) ?? null;
}

router.post("/ai/travel-plan", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead, member: memberRaw, period } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!memberRaw) { res.status(400).json({ error: "member is required for travel plan." }); return; }

  req.log.info({ fy, stateHead, member: memberRaw }, "ai/travel-plan: request");

  try {
    const registry = await loadRegistry(fy);
    const tpResolved = registry?.resolve(memberRaw, stateHead ? { stateHead } : undefined);
    if (tpResolved?.kind === "ambiguous") {
      res.status(400).json({ error: tpResolved.message, candidates: tpResolved.candidates.map((p) => ({ displayName: p.displayName, stateHead: p.stateHead, hq: p.hq ?? null })) });
      return;
    }
    const memberKey = tpResolved?.kind === "found" ? tpResolved.person.nsk : normSecKey(memberRaw);
    const data = await loadDeepDiveData(fy, stateHead, memberKey);
    if (!data.kpis) { res.status(404).json({ error: `Member '${memberRaw}' not found.` }); return; }
    if (data.kpis.isLeft) {
      res.status(400).json({ error: `${data.kpis.name} is marked LEFT — visit plans cannot be generated for members who have left the team.` });
      return;
    }

    const payload = buildMemberPayload(fy, stateHead ?? data.kpis.stateHead ?? null, period, data.kpis, data.retailerDetail, data.roiCost, data.skuSpread);

    const visitPlan = getVisitPlanSafe(data.retailerDetail);
    const monthPlans = visitPlan?.monthPlans ?? [];

    const monthSummary = monthPlans.map((mp) => ({
      month: mp.month,
      workingDays: mp.workingDays,
      capacity: mp.capacity,
      maintenanceVisits: mp.maintenanceVisits,
      developmentVisits: mp.developmentVisits,
      targetCount: mp.targets.length,
      poolExhausted: mp.poolExhausted,
    }));

    // A4-B: expose unassigned exclusion count + member's own working days to Claude.
    const planContext = {
      unassignedExcluded: visitPlan?.unassignedExcluded ?? 0,
      workingDaysActual: data.kpis.workingDaysActual ?? null,
    };

    const userMsg = `Verified payload (JSON):\n${JSON.stringify(payload, null, 2)}\n\nPlan context (unassigned exclusion + member working days — cite freely):\n${JSON.stringify(planContext, null, 2)}\n\nMonth-by-month visit plan summary (app-computed — cite these figures freely):\n${JSON.stringify(monthSummary, null, 2)}`;

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: TRAVEL_PLAN_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const sections = JSON.parse(stripFences(rawJson)) as Record<string, { title: string; body: string }>;

    const guard = guardCustom(sections, payload, monthSummary);
    const periodGuard: PeriodGuardResult = runPeriodGuard(sections, payload.identity.periodToFiscalMonth);

    req.log.info({ member: data.kpis.name, monthCount: monthPlans.length, guardStatus: guard.status }, "ai/travel-plan: done");

    res.json({
      fy,
      member: data.kpis.name,
      stateHead: data.kpis.stateHead,
      dataCutoff: payload.identity.dataCutoff,
      generatedAt: payload.identity.generatedAt,
      periodCoveredLabel: payload.identity.periodCoveredLabel,
      periodCoveredShort: payload.identity.periodCoveredShort,
      selectedPeriod: period,
      periodMismatch: isPeriodMismatch(period, payload.identity.periodToFiscalMonth),
      sections,
      guard,
      periodGuard,
      monthPlans,
      visitCapacity: visitPlan?.capacity ?? null,
      unassignedExcluded: visitPlan?.unassignedExcluded ?? 0,
    });
  } catch (err) {
    req.log.error({ err, fy, member: memberRaw }, "ai/travel-plan: error");
    res.status(502).json({ error: "Travel plan generation failed. Please retry." });
  }
});

// ── 4. Performance Review (Management Only) ────────────────────────────────────

const PERFORMANCE_REVIEW_PROMPT = `You are generating a management-only performance review for a Prayag India sales member.

MANDATORY CLASSIFICATION: This document is MANAGEMENT ONLY — NOT FOR DISTRIBUTION TO THE INDIVIDUAL NAMED IN THIS REVIEW. It is a DRAFT requiring human sign-off before any use or distribution.

Your SOLE data source is the verified payload provided. An automated numeric guard will flag every number not matched to a payload field.

${CORE_NUMERIC_RULES}

PERFORMANCE REVIEW MANDATORY RULES:
14. EVERY dataQuality flag in the payload MUST appear in the relevant section of the review — not just in dataQualityContext but also in achievementAssessment where it directly affects interpretation. Omitting a flag is a disqualifying error.
    - PARTIAL_TENURE flag → must appear in achievementAssessment with the working-day count and a statement that YTD achievement comparisons at face value are not valid for this member.
    - ZERO_SALE_WITH_OB flag → must appear in achievementAssessment: state that sale is zero while OB is present, and the Sale column in the State Head Dashboard may be unmaintained.
    - UNASSIGNED_RETAILERS flag → must appear in coverageAndCustomerBase: dormant retailers cannot place orders until a distributor is assigned.
    - NO_MEMBER_SHEET flag → must appear in achievementAssessment and coverageAndCustomerBase: retailer, visit, and distributor detail is unavailable.
15. Distinguish clearly between controllable factors (visit choices, retailer engagement, product ranging decisions the member makes) and non-controllable factors (distributor assignment gaps the member cannot fix, data system issues, partial tenure if newly joined or recently departed).
16. NO comparison to named colleagues. You may say "in the lower half of the team" or "rank 4 of 8" based on payload data, but you may NOT name another individual's figures in this person's review.
17. managementHeader body must include both classification lines verbatim: "Management only — not for distribution to the individual." and "Draft — requires human sign-off before use or distribution."

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "managementHeader":      { "title": "Document Classification",          "body": "Management only — not for distribution to the individual. Draft — requires human sign-off before use or distribution." },
  "achievementAssessment": { "title": "Achievement Assessment",           "body": "..." },
  "dataQualityContext":    { "title": "Data Quality Context",             "body": "..." },
  "controllableFactors":   { "title": "Factors Within the Member's Control","body": "..." },
  "nonControllableFactors":{ "title": "Factors Outside the Member's Control","body":"..." },
  "developmentAreas":      { "title": "Development Areas",               "body": "..." },
  "managementActions":     { "title": "Recommended Management Actions",  "body": "..." }
}`;

router.post("/ai/performance-review", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead, member: memberRaw, period } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!memberRaw) { res.status(400).json({ error: "member is required for performance review." }); return; }

  req.log.info({ fy, stateHead, member: memberRaw }, "ai/performance-review: request");

  try {
    const registry = await loadRegistry(fy);
    const prResolved = registry?.resolve(memberRaw, stateHead ? { stateHead } : undefined);
    if (prResolved?.kind === "ambiguous") {
      res.status(400).json({ error: prResolved.message, candidates: prResolved.candidates.map((p) => ({ displayName: p.displayName, stateHead: p.stateHead, hq: p.hq ?? null })) });
      return;
    }
    const memberKey = prResolved?.kind === "found" ? prResolved.person.nsk : normSecKey(memberRaw);
    const data = await loadDeepDiveData(fy, stateHead, memberKey);
    if (!data.kpis) { res.status(404).json({ error: `Member '${memberRaw}' not found.` }); return; }

    const payload = buildMemberPayload(fy, stateHead ?? data.kpis.stateHead ?? null, period, data.kpis, data.retailerDetail, data.roiCost, data.skuSpread);

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: PERFORMANCE_REVIEW_PROMPT,
      messages: [{ role: "user", content: `Verified payload (JSON):\n${JSON.stringify(payload, null, 2)}` }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const sections = JSON.parse(stripFences(rawJson)) as Record<string, { title: string; body: string }>;
    const guard = runNumericGuard(sections, payload);
    const periodGuard: PeriodGuardResult = runPeriodGuard(sections, payload.identity.periodToFiscalMonth);

    req.log.info({ member: data.kpis.name, guardStatus: guard.status, flags: payload.dataQuality.map((f) => f.code) }, "ai/performance-review: done");

    res.json({
      fy,
      member: data.kpis.name,
      stateHead: data.kpis.stateHead,
      dataCutoff: payload.identity.dataCutoff,
      generatedAt: payload.identity.generatedAt,
      periodCoveredLabel: payload.identity.periodCoveredLabel,
      periodCoveredShort: payload.identity.periodCoveredShort,
      selectedPeriod: period,
      periodMismatch: isPeriodMismatch(period, payload.identity.periodToFiscalMonth),
      sections,
      guard,
      periodGuard,
      dataQualityFlags: payload.dataQuality.map((f) => f.code),
    });
  } catch (err) {
    req.log.error({ err, fy, member: memberRaw }, "ai/performance-review: error");
    res.status(502).json({ error: "Performance review generation failed. Please retry." });
  }
});

// ── 5. Presentation ────────────────────────────────────────────────────────────

// ── A4-A: 27-slide State Head team deck ────────────────────────────────────────

const PRESENTATION_PROMPT_A4A = `You are generating a 27-slide State Head team deck for Prayag India sales leadership. This is a comprehensive team-level review, not a short summary.

Your SOLE data source is the verified state-head aggregate payload and the memberSummary array provided. An automated numeric guard will flag every number not matched to these sources.

${CORE_NUMERIC_RULES}

DECK-SPECIFIC RULES:
13. NEVER include chart data in bullets or commentary. Charts are rendered natively by the application. You supply chartDataRef labels only — never data values.
14. chartDataRef must be ONE of: "performance", "achievement", "coverage", "teamRanking", "none".
15. chartType must be ONE of: "bar", "pie", "line", "none".
16. deckTitle must contain the state head name and FY. No numeric figures.
17. deckSubtitle must state the data cutoff period. No numeric figures.
18. memberSlides must be in EXACTLY the same order as memberSummary (already sorted by totalOB descending). Do not reorder.
19. achievementBadge: "teal" when achievementPct >= 60, "amber" when achievementPct < 60 or null.
20. For unmapped members (hasMappedSheet=false): set unmapped=true. First bullet must be exactly: "Retailer, visit, and distributor detail is ABSENT — not zero. No working sheet is mapped for this member."
21. For each member: write 3–5 bullets citing only fields from memberSummary (secondaryOB, directDealerOB, totalOB, sale, achievementPct, retailers, visitsCompleted, workingDays, totalTargetToDate). Do not invent figures.
22. Do NOT name individual retailers, customers, or distributors. Only member names from memberSummary.
23. teamSlides: EXACTLY 11 items (slides 1–11). memberSlides: one per memberSummary entry. closingSlides: EXACTLY 3 items (slides 25–27).
24. Concentration: compute share of team total OB held by top 2–3 members using payload.performance.totalOB as the team denominator and memberSummary[].totalOB. This is the only derived figure permitted — it is a sum-fraction, not a subtraction.

TEAM SLIDE STRUCTURE (exactly 11):
Slide  1 — Title slide. No bullets. subtitle = state head name + FY + data period. chartType: "none".
Slide  2 — At a Glance: 4–6 KPI bullets from aggregate payload (totalOB, sale, achievement, members). chartType: "bar", chartDataRef: "performance".
Slide  3 — Team vs Target: achievement ratios. chartType: "bar", chartDataRef: "achievement".
Slide  4 — Member Rankings: commentary on tiers; 1 sentence per tier cluster. chartType: "bar", chartDataRef: "teamRanking".
Slide  5 — Member Overview table: 1 bullet per member — name, totalOB, achievementPct. chartType: "none".
Slide  6 — Visit Coverage: team retailer universe, visited vs unvisited. chartType: "bar", chartDataRef: "coverage".
Slide  7 — Effort vs Return: identify which members have high workingDays relative to their OB, which are efficient. chartType: "none".
Slide  8 — Concentration Risk: top-2 members share of team OB (use rule 24 calculation). chartType: "none".
Slide  9 — Data Availability: count hasMappedSheet=true vs false; list members without sheets. chartType: "none".
Slide 10 — Best Performer spotlight: cite top member's OB, sale, achievementPct, workingDays. chartType: "none".
Slide 11 — Priority Actions: 3–5 management action bullets. No invented figures. chartType: "none".

MEMBER SLIDE STRUCTURE (one per member, ordered as per memberSummary):
{ memberName, achievementBadge ("teal"|"amber"), bullets (3–5), commentary (1–2 sentences), unmapped (bool) }

CLOSING SLIDE STRUCTURE (exactly 3):
Slide 25 — Data Quality: full breakdown of mapped vs unmapped members; list names without sheets. chartType: "none".
Slide 26 — Benchmark and Best Practices: what the top performer's pattern suggests for peers. chartType: "none".
Slide 27 — Next Steps: 3–5 placeholder action items for state head to fill in. chartType: "none".

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "deckTitle": "...",
  "deckSubtitle": "...",
  "teamSlides": [
    { "slideNumber": 1, "title": "...", "subtitle": "...", "bullets": [], "commentary": "...", "chartType": "none", "chartDataRef": "none" }
  ],
  "memberSlides": [
    { "memberName": "...", "achievementBadge": "teal", "bullets": ["..."], "commentary": "...", "unmapped": false }
  ],
  "closingSlides": [
    { "slideNumber": 25, "title": "...", "subtitle": "", "bullets": [], "commentary": "...", "chartType": "none", "chartDataRef": "none" }
  ]
}`;

// ── A4 (original): member-level or short state-head deck ───────────────────────

const PRESENTATION_PROMPT = `You are generating a structured slide deck plan for a Prayag India sales presentation.

Your SOLE data source is the verified payload (and memberRanking if provided). An automated numeric guard will flag every number not matched to these sources.

${CORE_NUMERIC_RULES}

PRESENTATION ADDITIONAL RULES:
14. NEVER include chart data in bullets or commentary. Charts are rendered natively by the application from the payload. You supply titles, ordering, and commentary text only.
15. chartDataRef must be ONE of: "performance", "achievement", "coverage", "customerStates", "distanceBands", "projectionBand", "teamRanking", "priorYears", "none".
16. chartType must be ONE of: "bar", "pie", "line", "none".
17. "teamRanking" chartDataRef is available only when memberRanking is provided (state-head level). At member level use "none" for team-level slides.
18. Keep the deck short: 8 to 12 slides total.
19. Slide order: title/position → performance vs target → coverage/effort → product (if available) → risks → actions.
20. You may cite payload numbers in bullets and commentary — the guard will verify them. Cite field paths in brackets.
21. deckTitle and deckSubtitle must not contain any numeric figures — they are labels only.

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "deckTitle": "...",
  "deckSubtitle": "...",
  "slides": [
    {
      "slideNumber": 1,
      "title": "...",
      "subtitle": "...",
      "bullets": ["...", "..."],
      "commentary": "...",
      "chartType": "bar | pie | line | none",
      "chartDataRef": "performance | achievement | coverage | customerStates | distanceBands | projectionBand | teamRanking | priorYears | none"
    }
  ]
}`;

router.post("/ai/presentation", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead, member: memberRaw, period } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!stateHead && !memberRaw) { res.status(400).json({ error: "stateHead or member is required for presentation." }); return; }

  req.log.info({ fy, stateHead, member: memberRaw }, "ai/presentation: request");

  try {
    let payload: AiPayload;

    if (memberRaw) {
      // ── A4 member-level deck (8–12 slides) ──────────────────────────────────
      const registry = await loadRegistry(fy);
      const presResolved = registry?.resolve(memberRaw, stateHead ? { stateHead } : undefined);
      if (presResolved?.kind === "ambiguous") {
        res.status(400).json({ error: presResolved.message, candidates: presResolved.candidates.map((p) => ({ displayName: p.displayName, stateHead: p.stateHead, hq: p.hq ?? null })) });
        return;
      }
      const memberKey = presResolved?.kind === "found" ? presResolved.person.nsk : normSecKey(memberRaw);
      const data = await loadDeepDiveData(fy, stateHead, memberKey);
      if (!data.kpis) { res.status(404).json({ error: `Member '${memberRaw}' not found.` }); return; }
      const memberName = data.kpis.name;
      payload = buildMemberPayload(fy, stateHead ?? data.kpis.stateHead ?? null, period, data.kpis, data.retailerDetail, data.roiCost, data.skuSpread);

      const userMsg = `Verified payload (JSON):\n${JSON.stringify(payload, null, 2)}`;
      const message = await anthropic.messages.create({
        model: MODEL, max_tokens: MAX_TOKENS,
        system: PRESENTATION_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      });
      const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      const deck = JSON.parse(stripFences(rawJson)) as { deckTitle: string; deckSubtitle: string; slides: unknown[] };
      if (!Array.isArray(deck.slides)) throw new Error("slides array missing");
      const guard = guardCustom(deck, payload, null);
      const periodGuard: PeriodGuardResult = runPeriodGuard(
        { content: { title: "Presentation", body: JSON.stringify(deck) } },
        payload.identity.periodToFiscalMonth,
      );
      req.log.info({ member: memberName, slideCount: deck.slides.length, guardStatus: guard.status }, "ai/presentation member: done");
      res.json({
        fy,
        stateHead: stateHead ?? payload.identity.stateHead,
        member: memberName,
        dataCutoff: payload.identity.dataCutoff,
        generatedAt: payload.identity.generatedAt,
        periodCoveredLabel: payload.identity.periodCoveredLabel,
        periodCoveredShort: payload.identity.periodCoveredShort,
        selectedPeriod: period,
        periodMismatch: isPeriodMismatch(period, payload.identity.periodToFiscalMonth),
        deckTitle: deck.deckTitle,
        deckSubtitle: deck.deckSubtitle,
        slides: deck.slides,
        teamSlides: null,
        memberSlides: null,
        closingSlides: null,
        guard,
        periodGuard,
        payload,
        memberRanking: null,
      });
      return;
    }

    // ── A4-A state-head 27-slide deck ─────────────────────────────────────────
    const { members: allA4aMembers, error: loadErr } = await resolveStateHeadMembers(fy, stateHead!);
    if (loadErr) { res.status(404).json({ error: loadErr }); return; }

    // Aggregate figures use active members only; departed shown as context in the deck.
    const a4aActive  = allA4aMembers.filter((m) => !m.isLeft);
    const a4aLeft    = allA4aMembers.filter((m) => m.isLeft);
    const a4aPayloadMembers = a4aActive.length > 0 ? a4aActive : allA4aMembers;

    payload = buildStateHeadPayload(fy, stateHead!, period, a4aPayloadMembers);

    // Extended per-member summary for A4A (active members only — no extra Sheets reads)
    const memberSummary = a4aPayloadMembers
      .map((m) => {
        const totalOB = (m.orderBooking ?? 0) + (m.directDealersOrder ?? 0);
        const achievementPct =
          m.totalTargetToDate && m.totalTargetToDate > 0
            ? Math.round(totalOB / m.totalTargetToDate * 1000) / 10
            : null;
        return {
          name: m.name,
          hq: m.hq,
          hasMappedSheet: !!getMemberFileId(m.normKey),
          secondaryOB: m.orderBooking ?? 0,
          directDealerOB: m.directDealersOrder ?? 0,
          totalOB,
          sale: m.sale ?? 0,
          totalTargetToDate: m.totalTargetToDate ?? null,
          achievementPct,
          retailers: m.totalOldRetailers ?? null,
          visitsCompleted: m.visitedRetailers ?? null,
          workingDays: m.workingDaysActual ?? null,
        };
      })
      .sort((a, b) => b.totalOB - a.totalOB);

    const a4aDepartedContext = a4aLeft.length > 0
      ? `\n\nDeparted members (status: LEFT — historical business only, excluded from all aggregate figures):\n${JSON.stringify(
          a4aLeft.map((m) => ({
            name: m.name,
            historicalOB: Math.round((m.orderBooking ?? 0) + (m.directDealersOrder ?? 0)),
            historicalSale: Math.round(m.sale ?? 0),
            retailers: m.totalOldRetailers ?? 0,
            visits: m.visitedRetailers ?? 0,
          })),
          null, 2,
        )}`
      : "";

    const a4aUserMsg =
      `Verified state-head aggregate payload (JSON) — active members only:\n${JSON.stringify(payload, null, 2)}\n\n` +
      `Member summary — active members only, sorted by totalOB descending, verified, cite freely (JSON):\n${JSON.stringify(memberSummary, null, 2)}` +
      a4aDepartedContext;

    // Use streaming: 32000 max_tokens exceeds the SDK non-streaming 10-min threshold
    const a4aStream = await anthropic.messages.stream({
      model: MODEL, max_tokens: 32000,
      system: PRESENTATION_PROMPT_A4A,
      messages: [{ role: "user", content: a4aUserMsg }],
    });
    const a4aFinal = await a4aStream.finalMessage();
    const a4aRawJson = a4aFinal.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const a4aDeck = JSON.parse(stripFences(a4aRawJson)) as {
      deckTitle: string; deckSubtitle: string;
      teamSlides: unknown[]; memberSlides: unknown[]; closingSlides: unknown[];
    };
    if (!Array.isArray(a4aDeck.teamSlides))   throw new Error("teamSlides array missing");
    if (!Array.isArray(a4aDeck.memberSlides)) throw new Error("memberSlides array missing");
    if (!Array.isArray(a4aDeck.closingSlides)) throw new Error("closingSlides array missing");

    // Pass memberSummary as extra so individual member figures (OB, sale,
    // achievementPct per member) are within the allowed numeric set.
    const guard = guardCustom(a4aDeck, payload, memberSummary);
    const periodGuard: PeriodGuardResult = runPeriodGuard(
      { content: { title: "Presentation", body: JSON.stringify(a4aDeck) } },
      payload.identity.periodToFiscalMonth,
    );
    req.log.info({
      stateHead,
      teamSlides: a4aDeck.teamSlides.length,
      memberSlides: a4aDeck.memberSlides.length,
      closingSlides: a4aDeck.closingSlides.length,
      guardStatus: guard.status,
    }, "ai/presentation A4A: done");

    res.json({
      fy,
      stateHead: stateHead ?? payload.identity.stateHead,
      member: null,
      dataCutoff: payload.identity.dataCutoff,
      generatedAt: payload.identity.generatedAt,
      periodCoveredLabel: payload.identity.periodCoveredLabel,
      periodCoveredShort: payload.identity.periodCoveredShort,
      selectedPeriod: period,
      periodMismatch: isPeriodMismatch(period, payload.identity.periodToFiscalMonth),
      deckTitle: a4aDeck.deckTitle,
      deckSubtitle: a4aDeck.deckSubtitle,
      slides: [],
      teamSlides: a4aDeck.teamSlides,
      memberSlides: a4aDeck.memberSlides,
      closingSlides: a4aDeck.closingSlides,
      guard,
      periodGuard,
      payload,
      memberRanking: null,
    });
  } catch (err) {
    req.log.error({ err, fy, stateHead, member: memberRaw }, "ai/presentation: error");
    res.status(502).json({ error: "Presentation generation failed. Please retry." });
  }
});

export default router;
