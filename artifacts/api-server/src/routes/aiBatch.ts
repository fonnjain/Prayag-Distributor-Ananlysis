// Phase A6 — Batch AI artifact generation.
import { currentOpenFy } from "../lib/fyAnchors.js";
//
// POST /api/ai/batch
//   Streams Server-Sent Events (text/event-stream) for each member of a state head.
//   Supports: suggestions | travel-plan | performance-review
//   Cache: payload-hash keyed in-memory (batchCache.ts). Same hash = no API call.
//   Failure on one member continues the rest. NO_MEMBER_SHEET produces a
//   dashboard-level report with the appropriate dataQuality caveats (not a failure).
//
// SSE event shapes:
//   { type: "batch_start", fy, stateHead, reportType, total, memberNames: string[] }
//   { type: "member_start", member: string }
//   { type: "doc_done", member, reportType, source: "api"|"cache", dataCutoff, result }
//   { type: "doc_failed", member, reportType, error: string }
//   { type: "batch_done", summary: { total, cached, generated, failed } }
//   { type: "error", error: string }
//
// Never console.log — use req.log / logger.

import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { loadDeepDiveData } from "../lib/mgmt/deepDiveData.js";
import { buildMemberPayload, type AiPayload } from "../lib/mgmt/aiPayload.js";
import { runNumericGuard } from "../lib/mgmt/numericGuard.js";
import { hashPayload, makeCacheKey, cacheGet, cacheSet } from "../lib/mgmt/batchCache.js";
import type { VisitPlan } from "../lib/mgmt/visitPlan.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;

const BATCHABLE_TYPES = ["suggestions", "travel-plan", "performance-review"] as const;
type BatchReportType = typeof BATCHABLE_TYPES[number];

// ── Core numeric rules (same contract as aiArtifacts.ts) ──────────────────────

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

// ── Prompts (identical to aiArtifacts.ts) ─────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function gatherStrings(obj: unknown): string {
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map(gatherStrings).join(" ");
  if (obj !== null && typeof obj === "object") {
    return Object.values(obj as Record<string, unknown>).map(gatherStrings).join(" ");
  }
  return "";
}

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function getVisitPlanSafe(retailerDetail: unknown): VisitPlan | null {
  if (!retailerDetail || typeof retailerDetail !== "object") return null;
  const d = retailerDetail as Record<string, unknown>;
  if (d.status !== "ok") return null;
  return (d.visitPlan as VisitPlan | null) ?? null;
}

function callGuard(result: unknown, payload: AiPayload, extra?: unknown) {
  const base = extra ? { ...payload, _extra: extra } as unknown as AiPayload : payload;
  return runNumericGuard(
    { content: { title: "", body: gatherStrings(result) } },
    base,
  );
}

// ── Per-type generation functions ─────────────────────────────────────────────

async function generateSuggestions(payload: AiPayload): Promise<Record<string, unknown>> {
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    system: SUGGESTIONS_PROMPT,
    messages: [{ role: "user", content: `Verified payload (JSON):\n${JSON.stringify(payload, null, 2)}` }],
  });
  const raw = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const result = JSON.parse(stripFences(raw)) as { intro: string; suggestions: unknown[] };
  if (!Array.isArray(result.suggestions)) throw new Error("suggestions array missing");
  const guard = callGuard(result, payload);
  return { intro: result.intro, suggestions: result.suggestions, guard };
}

async function generateTravelPlan(payload: AiPayload, visitPlan: VisitPlan | null): Promise<Record<string, unknown>> {
  const monthPlans = visitPlan?.monthPlans ?? [];
  const monthSummary = monthPlans.map((mp) => ({
    month: mp.month, workingDays: mp.workingDays, capacity: mp.capacity,
    maintenanceVisits: mp.maintenanceVisits, developmentVisits: mp.developmentVisits,
    targetCount: mp.targets.length,
  }));
  const userMsg = `Verified payload (JSON):\n${JSON.stringify(payload, null, 2)}\n\nMonth-by-month visit plan summary (app-computed — cite these figures freely):\n${JSON.stringify(monthSummary, null, 2)}`;
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    system: TRAVEL_PLAN_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });
  const raw = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const sections = JSON.parse(stripFences(raw)) as Record<string, { title: string; body: string }>;
  const guard = callGuard(sections, payload, monthSummary);
  return { sections, guard, monthPlans, visitCapacity: visitPlan?.capacity ?? null };
}

async function generatePerformanceReview(payload: AiPayload): Promise<Record<string, unknown>> {
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    system: PERFORMANCE_REVIEW_PROMPT,
    messages: [{ role: "user", content: `Verified payload (JSON):\n${JSON.stringify(payload, null, 2)}` }],
  });
  const raw = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const sections = JSON.parse(stripFences(raw)) as Record<string, { title: string; body: string }>;
  const guard = runNumericGuard(sections, payload);
  return { sections, guard, dataQualityFlags: payload.dataQuality.map((f) => f.code) };
}

async function generateDoc(reportType: BatchReportType, payload: AiPayload, visitPlan: VisitPlan | null): Promise<Record<string, unknown>> {
  switch (reportType) {
    case "suggestions":        return generateSuggestions(payload);
    case "travel-plan":        return generateTravelPlan(payload, visitPlan);
    case "performance-review": return generatePerformanceReview(payload);
  }
}

// ── Batch SSE route ───────────────────────────────────────────────────────────

router.post("/ai/batch", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const fy         = typeof body.fy         === "string" ? body.fy.trim()         : currentOpenFy();
  const stateHead  = typeof body.stateHead  === "string" ? body.stateHead.trim()  : "";
  const reportType = typeof body.reportType === "string" ? body.reportType.trim() : "";

  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" }); return;
  }
  if (!stateHead) {
    res.status(400).json({ error: "stateHead is required for batch." }); return;
  }
  if (!(BATCHABLE_TYPES as readonly string[]).includes(reportType)) {
    res.status(400).json({ error: `reportType must be one of: ${BATCHABLE_TYPES.join(", ")}` }); return;
  }

  const batchType = reportType as BatchReportType;

  // ── SSE headers ────────────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: unknown): void => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

  req.log.info({ fy, stateHead, reportType: batchType }, "ai/batch: request");

  try {
    // Step 1: resolve member refs
    const topData = await loadDeepDiveData(fy, stateHead, undefined);
    const memberRefs = topData.members;

    if (!memberRefs.length) {
      send({ type: "error", error: `State head '${stateHead}' not found or has no members.` });
      res.end();
      return;
    }

    // Step 2: pre-load all member data in parallel (no Claude, fast) to get display names
    const memberDataList = await Promise.all(
      memberRefs.map((ref) => loadDeepDiveData(fy, ref.stateHead, ref.normKey)),
    );

    type MemberEntry = {
      normKey: string;
      stateHead: string;
      name: string;
      data: (typeof memberDataList)[0];
    };

    const members: MemberEntry[] = memberRefs.map((ref, i) => ({
      normKey: ref.normKey,
      stateHead: ref.stateHead,
      name: memberDataList[i].kpis?.name ?? ref.normKey,
      data: memberDataList[i],
    }));

    // Step 3: exclude LEFT members from batch generation.
    // They must stay in historical figures but must never receive a forward report.
    const activeMembers = members.filter((m) => !m.data.kpis?.isLeft);
    const leftMembersExcluded = members.length - activeMembers.length;

    // Announce only active members so the frontend renders only those as queued rows.
    send({
      type: "batch_start",
      fy,
      stateHead,
      reportType: batchType,
      total: activeMembers.length,
      memberNames: activeMembers.map((m) => m.name),
      ...(leftMembersExcluded > 0 ? { leftMembersExcluded } : {}),
    });

    let cached = 0, generated = 0, failed = 0;

    // Step 4: process active members one at a time (sequential — one Claude call at a time)
    for (const m of activeMembers) {
      send({ type: "member_start", member: m.name });

      try {
        if (!m.data.kpis) {
          // KPIs genuinely absent — treat as failure (rare; means the member row
          // vanished from the State Head Dashboard between the pre-load and now)
          send({ type: "doc_failed", member: m.name, reportType: batchType, error: "KPIs not found for this member." });
          failed++;
          continue;
        }

        // NO_MEMBER_SHEET members still produce a report — buildMemberPayload handles
        // null retailerDetail and stamps the NO_MEMBER_SHEET dataQuality flag, which
        // the prompt rules require to be surfaced in the document body.
        const payload = buildMemberPayload(
          fy, stateHead, "ytd",
          m.data.kpis,
          m.data.retailerDetail,
          m.data.roiCost,
          m.data.skuSpread,
        );

        const hash = hashPayload(payload);
        const cacheKey = makeCacheKey(fy, stateHead, m.normKey, batchType, hash);
        const cachedResult = cacheGet(cacheKey);

        if (cachedResult) {
          req.log.info({ member: m.name }, "ai/batch: cache hit");
          send({
            type: "doc_done",
            member: m.name,
            reportType: batchType,
            source: "cache",
            dataCutoff: payload.identity.dataCutoff,
            result: cachedResult,
          });
          cached++;
        } else {
          const visitPlan = getVisitPlanSafe(m.data.retailerDetail);
          const result = await generateDoc(batchType, payload, visitPlan);
          cacheSet(cacheKey, result, fy);

          req.log.info({ member: m.name }, "ai/batch: generated");
          send({
            type: "doc_done",
            member: m.name,
            reportType: batchType,
            source: "api",
            dataCutoff: payload.identity.dataCutoff,
            result,
          });
          generated++;
        }

        // Yield to the event loop between members so SSE data flushes.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } catch (err) {
        req.log.error({ err, member: m.name }, "ai/batch: member failed");
        send({ type: "doc_failed", member: m.name, reportType: batchType, error: String(err) });
        failed++;
        // Continue with next member — one failure must not abort the batch.
      }
    }

    send({
      type: "batch_done",
      summary: { total: members.length, cached, generated, failed },
    });

    req.log.info({ fy, stateHead, reportType: batchType, cached, generated, failed }, "ai/batch: done");
  } catch (err) {
    req.log.error({ err, fy, stateHead }, "ai/batch: fatal error");
    send({ type: "error", error: String(err) });
  } finally {
    res.end();
  }
});

export default router;
