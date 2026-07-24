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
import { loadDeepDiveData, normSecKey } from "../lib/mgmt/deepDiveData.js";
import type { MemberKpis } from "../lib/mgmt/deepDiveData.js";
import {
  buildMemberPayload,
  buildStateHeadPayload,
  type AiPayload,
} from "../lib/mgmt/aiPayload.js";
import { runNumericGuard, type GuardResult } from "../lib/mgmt/numericGuard.js";
import type { VisitPlan } from "../lib/mgmt/visitPlan.js";

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
12. Do NOT invent prior-year OB or sale figures. priorYears.ob and priorYears.sale may be null for open FYs.`;

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
14. The memberRanking array lists every team member with their name, totalOB, target, achievementPct, and sale. You may cite any of these figures — they are verified. Write each member's own figures alongside their name.
15. Do NOT write one member's figures as a direct comparison to another named member in the same sentence. You may use positional language ("the highest-ranked member accounts for X% of team OB") or ordinal rank ("third of Y members").
16. The dataQuality array lists members in the NO_MEMBER_SHEET message by name. Name every such member in the dataQualityAndRisks section. State explicitly that the aggregate is built on partial detail where membersWithoutSheet > 0.
17. memberPerformance body: rank members from highest to lowest totalOB. Cite each member's totalOB and achievementPct alongside their name. Do not omit any member.

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
    const { members, error: loadErr } = await resolveStateHeadMembers(fy, stateHead);
    if (loadErr) { res.status(404).json({ error: loadErr }); return; }
    if (members.length === 0) { res.status(404).json({ error: "No member data found for this state head." }); return; }

    const payload = buildStateHeadPayload(fy, stateHead, period, members);

    const memberRanking = members
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

    const userMsg = `Verified state-head aggregate payload (JSON):\n${JSON.stringify(payload, null, 2)}\n\nMember ranking by total OB (app-computed, verified — cite freely):\n${JSON.stringify(memberRanking, null, 2)}`;

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: STATEHEAD_REPORT_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const sections = JSON.parse(stripFences(rawJson)) as Record<string, { title: string; body: string }>;

    const guard = guardCustom(sections, payload, memberRanking);

    req.log.info({ stateHead, guardStatus: guard.status, unmatched: guard.unmatched.length }, "ai/statehead-report: done");

    res.json({ fy, stateHead, dataCutoff: payload.identity.dataCutoff, generatedAt: payload.identity.generatedAt, sections, guard, memberRanking });
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

  const memberKey = normSecKey(memberRaw);
  req.log.info({ fy, stateHead, member: memberRaw }, "ai/suggestions: request");

  try {
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

    req.log.info({ member: data.kpis.name, count: result.suggestions.length, guardStatus: guard.status }, "ai/suggestions: done");

    res.json({ fy, member: data.kpis.name, stateHead: data.kpis.stateHead, dataCutoff: payload.identity.dataCutoff, generatedAt: payload.identity.generatedAt, ...result, guard });
  } catch (err) {
    req.log.error({ err, fy, member: memberRaw }, "ai/suggestions: error");
    res.status(502).json({ error: "Suggestions generation failed. Please retry." });
  }
});

// ── 3. Travel and Visit Plan ───────────────────────────────────────────────────

const TRAVEL_PLAN_PROMPT = `You are writing the covering narrative for a Prayag India sales member's visit plan.

The app has already computed the month-by-month visit plan. You write the covering explanation ONLY. Do NOT invent a schedule; the plan is provided.

Your SOLE data sources are the verified payload and the monthPlanSummary provided. An automated numeric guard will flag every number not matched to these sources.

${CORE_NUMERIC_RULES}

TRAVEL PLAN ADDITIONAL RULES:
14. State EXPLICITLY in the batchingBasis section: "Visit batching in this plan is by district and distance from base, not route optimisation. The data includes district, city, and distance from base, but no coordinates. Precision beyond this cannot be implied."
15. Do NOT list individual retailer names — they are not in the payload and must not be referenced.
16. monthPlanSummary shows each remaining month with workingDays, capacity (visits allocated), maintenanceVisits, developmentVisits, targetCount (number of retailers on the list). Write a brief narrative for each month based on these figures. Do not reference individual retailers.
17. The shortfall (capacity.gap) may be negative (more required than feasible). State it plainly.
18. Do NOT invent visit routes, sequences, or day-by-day schedules. The plan is month-level only.

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

  const memberKey = normSecKey(memberRaw);
  req.log.info({ fy, stateHead, member: memberRaw }, "ai/travel-plan: request");

  try {
    const data = await loadDeepDiveData(fy, stateHead, memberKey);
    if (!data.kpis) { res.status(404).json({ error: `Member '${memberRaw}' not found.` }); return; }

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
    }));

    const userMsg = `Verified payload (JSON):\n${JSON.stringify(payload, null, 2)}\n\nMonth-by-month visit plan summary (app-computed — cite these figures freely):\n${JSON.stringify(monthSummary, null, 2)}`;

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: TRAVEL_PLAN_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const sections = JSON.parse(stripFences(rawJson)) as Record<string, { title: string; body: string }>;

    const guard = guardCustom(sections, payload, monthSummary);

    req.log.info({ member: data.kpis.name, monthCount: monthPlans.length, guardStatus: guard.status }, "ai/travel-plan: done");

    res.json({
      fy,
      member: data.kpis.name,
      stateHead: data.kpis.stateHead,
      dataCutoff: payload.identity.dataCutoff,
      generatedAt: payload.identity.generatedAt,
      sections,
      guard,
      monthPlans,
      visitCapacity: visitPlan?.capacity ?? null,
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

  const memberKey = normSecKey(memberRaw);
  req.log.info({ fy, stateHead, member: memberRaw }, "ai/performance-review: request");

  try {
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

    req.log.info({ member: data.kpis.name, guardStatus: guard.status, flags: payload.dataQuality.map((f) => f.code) }, "ai/performance-review: done");

    res.json({
      fy,
      member: data.kpis.name,
      stateHead: data.kpis.stateHead,
      dataCutoff: payload.identity.dataCutoff,
      generatedAt: payload.identity.generatedAt,
      sections,
      guard,
      dataQualityFlags: payload.dataQuality.map((f) => f.code),
    });
  } catch (err) {
    req.log.error({ err, fy, member: memberRaw }, "ai/performance-review: error");
    res.status(502).json({ error: "Performance review generation failed. Please retry." });
  }
});

// ── 5. Presentation ────────────────────────────────────────────────────────────

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
    let memberName: string | null = null;
    let memberRanking: Array<{ name: string; totalOB: number; target: number | null; achievementPct: number | null }> | null = null;

    if (memberRaw) {
      const memberKey = normSecKey(memberRaw);
      const data = await loadDeepDiveData(fy, stateHead, memberKey);
      if (!data.kpis) { res.status(404).json({ error: `Member '${memberRaw}' not found.` }); return; }
      memberName = data.kpis.name;
      payload = buildMemberPayload(fy, stateHead ?? data.kpis.stateHead ?? null, period, data.kpis, data.retailerDetail, data.roiCost, data.skuSpread);
    } else {
      const { members, error: loadErr } = await resolveStateHeadMembers(fy, stateHead!);
      if (loadErr) { res.status(404).json({ error: loadErr }); return; }
      payload = buildStateHeadPayload(fy, stateHead!, period, members);
      memberRanking = members
        .map((m) => ({
          name: m.name,
          totalOB: (m.orderBooking ?? 0) + (m.directDealersOrder ?? 0),
          target: m.totalTargetToDate ?? null,
          achievementPct:
            m.totalTargetToDate && m.totalTargetToDate > 0
              ? Math.round(((m.orderBooking ?? 0) + (m.directDealersOrder ?? 0)) / m.totalTargetToDate * 1000) / 10
              : null,
        }))
        .sort((a, b) => b.totalOB - a.totalOB);
    }

    const userMsg = memberRanking
      ? `Verified state-head aggregate payload (JSON):\n${JSON.stringify(payload, null, 2)}\n\nMember ranking (app-computed, cite freely):\n${JSON.stringify(memberRanking, null, 2)}`
      : `Verified payload (JSON):\n${JSON.stringify(payload, null, 2)}`;

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: PRESENTATION_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const deck = JSON.parse(stripFences(rawJson)) as { deckTitle: string; deckSubtitle: string; slides: unknown[] };
    if (!Array.isArray(deck.slides)) throw new Error("slides array missing");

    const guard = guardCustom(deck, payload, memberRanking);

    req.log.info({ stateHead, member: memberName, slideCount: deck.slides.length, guardStatus: guard.status }, "ai/presentation: done");

    res.json({
      fy,
      stateHead: stateHead ?? payload.identity.stateHead,
      member: memberName,
      dataCutoff: payload.identity.dataCutoff,
      generatedAt: payload.identity.generatedAt,
      ...deck,
      guard,
      payload,
      memberRanking,
    });
  } catch (err) {
    req.log.error({ err, fy, stateHead, member: memberRaw }, "ai/presentation: error");
    res.status(502).json({ error: "Presentation generation failed. Please retry." });
  }
});

export default router;
