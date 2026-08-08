// Phase A5 — Distributor AI artifact routes.
//
// Five routes sharing the A1 numeric guard and no-arithmetic constraint.
// Architecture: app = numbers.  Claude = judgement.
//
// MANDATORY FRAMING RULES (stated in every system prompt):
//   FLOW GAP  — two equally valid readings; never an accusation.
//   GAP TYPES — COVERAGE GAP vs ASSIGNMENT GAP have different fixes; never merged.
//
// Routes:
//   POST /api/ai/distributor-statehead-report  — territory-level narrative
//   POST /api/ai/distributor-report            — single distributor detailed report
//   POST /api/ai/distributor-suggestions       — ranked suggestions (state head level)
//   POST /api/ai/distributor-review            — single distributor review
//   POST /api/ai/distributor-presentation      — slide structure (charts native)
//
// Never console.log — use req.log / logger.
// Never write to Google Drive.

import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { loadDistributorDeepDive } from "../lib/mgmt/distributorDeepDive.js";
import { normDistKey } from "../lib/mgmt/distributorDeepDive.js";
import { loadDistributorRegistry } from "../lib/mgmt/distributorRegistry.js";
import {
  buildDistributorPayload,
  type DistributorAiPayload,
} from "../lib/mgmt/aiDistributorPayload.js";
import { runNumericGuard } from "../lib/mgmt/numericGuard.js";
import type { AiPayload } from "../lib/mgmt/aiPayload.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;

// ── Shared helpers ────────────────────────────────────────────────────────────

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function gatherStrings(obj: unknown): string {
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map(gatherStrings).join(" ");
  if (obj !== null && typeof obj === "object") {
    return Object.values(obj as Record<string, unknown>).map(gatherStrings).join(" ");
  }
  return "";
}

function guardDist(obj: unknown, payload: DistributorAiPayload): ReturnType<typeof runNumericGuard> {
  return runNumericGuard(
    { content: { title: "", body: gatherStrings(obj) } },
    payload as unknown as AiPayload,
  );
}

function parseBody(body: unknown): {
  fy: string; stateHead: string | undefined; distributor: string | undefined;
} {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    fy: typeof b.fy === "string" && b.fy.trim() ? b.fy.trim() : "2026-27",
    stateHead: typeof b.stateHead === "string" && b.stateHead.trim() ? b.stateHead.trim() : undefined,
    distributor: typeof b.distributor === "string" && b.distributor.trim() ? b.distributor.trim() : undefined,
  };
}

// ── Core numeric rules ────────────────────────────────────────────────────────

const CORE_NUMERIC_RULES = `\
ABSOLUTE RULES:
1. Use ONLY numbers from the payload. Never compute, estimate, subtract, add, or derive any figure not present explicitly.
2. Cite every figure as [field.path] immediately after the value.
3. Where a dataQuality flag is relevant, state the caveat in the SAME SENTENCE.
4. Write in English. No emojis. Management register.
5. Null means null — never substitute an estimate.
6. 4-digit years (2020-2030) in "FY2026-27" style text are excluded from the guard.
7. directDealerIsParallelChannel=true means the direct dealer branch is PARALLEL to distributors — never describe it as being beneath or belonging to any named distributor.
8. NO_PRIMARY_DATA flag: when hasPrimaryData=false, write "primary dispatch data is unavailable" — never show zero for that distributor.

MANDATORY FRAMING RULES (apply to every distributor report, no exceptions):
FLOW GAP RULE — A positive flow gap (primaryDispatch > secondaryOut) has TWO equally valid readings:
  (1) The distributor is building stock — normal behaviour ahead of seasonal demand.
  (2) Business is moving outside the attributed channel — secondary sales through routes not in member sheets.
  BOTH readings MUST be stated whenever the flow gap is discussed. Never phrase it as an accusation.
  No distributor stock data exists to distinguish between these two interpretations.

GAP TYPE RULE — COVERAGE GAP and ASSIGNMENT GAP have different fixes and must NEVER be merged:
  COVERAGE GAP (no distributor in district, gapType="coverage"): fix = appoint a distributor. Strategic decision, slow.
  ASSIGNMENT GAP (distributor exists but retailers have "--", gapType="assignment"): fix = assign to existing distributor. Administrative task, immediate.
  Always state which gap type and its specific remedy separately.`;

// ── 1. State Head Distributor Report ─────────────────────────────────────────

const STATEHEAD_DIST_PROMPT = `You are generating a territory-level distributor channel report for Prayag India's sales leadership.

${CORE_NUMERIC_RULES}

STATE HEAD DISTRIBUTOR REPORT ADDITIONAL RULES:
9. channelStructureOverview: describe the channel architecture first — how many distributors, the parallel direct-dealer branch (at channelStructure.directDealerOb, never beneath any distributor), unassigned retailers.
10. distributorPerformanceRanking: rank all distributors by orderBooking. Cite each distributor's name, orderBooking, obSharePct, and tier. Any distributor with obSharePct >= 60 MUST be identified as a single-point dependency risk.
11. flowGapAnalysis: MUST apply the flow gap two-reading rule. State both readings. Never omit either.
12. whitespaceAnalysis: MUST apply the gap type rule. State COVERAGE GAP and ASSIGNMENT GAP separately with their different remedies. Name the coverage-gap districts by name if present.
13. concentrationAndRisk: cite concentration.top5SharePct and the topDistributorSinglePointFlag if true.
14. actionsForManagement: ordered by urgency — administrative (assignment gaps) before strategic (coverage gaps, concentration risk).

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "channelStructureOverview": { "title": "Channel Architecture", "body": "..." },
  "distributorPerformanceRanking": { "title": "Distributor Performance Ranking", "body": "..." },
  "flowGapAnalysis": { "title": "Flow Gap Analysis", "body": "..." },
  "whitespaceAnalysis": { "title": "Whitespace — Coverage and Assignment Gaps", "body": "..." },
  "concentrationAndRisk": { "title": "Concentration and Channel Risk", "body": "..." },
  "actionsForManagement": { "title": "Recommended Actions", "body": "..." }
}`;

router.post("/ai/distributor-statehead-report", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!stateHead) { res.status(400).json({ error: "stateHead is required." }); return; }

  req.log.info({ fy, stateHead }, "ai/distributor-statehead-report: request");

  try {
    const result = await loadDistributorDeepDive(fy, stateHead);
    if (result.error && !result.distributors.length) { res.status(502).json({ error: result.error }); return; }

    const payload = buildDistributorPayload(result);

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: STATEHEAD_DIST_PROMPT,
      messages: [{ role: "user", content: `Verified distributor payload (JSON):\n${JSON.stringify(payload, null, 2)}` }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const sections = JSON.parse(stripFences(rawJson)) as Record<string, { title: string; body: string }>;
    const guard = guardDist(sections, payload);

    req.log.info({ stateHead, distCount: result.distributors.length, guardStatus: guard.status }, "ai/distributor-statehead-report: done");

    res.json({ fy, stateHead, dataCutoff: payload.identity.dataCutoff, generatedAt: payload.identity.generatedAt, sections, guard, payload });
  } catch (err) {
    req.log.error({ err, fy, stateHead }, "ai/distributor-statehead-report: error");
    res.status(502).json({ error: "Distributor state head report generation failed. Please retry." });
  }
});

// ── 2. Single Distributor Report ──────────────────────────────────────────────

const DIST_REPORT_PROMPT = `You are generating a detailed report for a single Prayag India distributor.

${CORE_NUMERIC_RULES}

SINGLE DISTRIBUTOR REPORT ADDITIONAL RULES:
9. distributorProfile: cite name, orderBooking, obSharePct, retailerCount, activeCount, dormantCount, and tier. If isConcentrationRisk=true, state it plainly.
10. flowGapAnalysis: MUST apply the flow gap two-reading rule. State BOTH readings. Never omit either.
11. retailerConcentration: if topRetailerSharePct is high, cite it with topRetailerName. Note whether this creates within-distributor concentration risk.
12. tierAssessment: cite tier, score, visitCadence, creditPosture. If isOverridden=true, note that the tier was manually overridden.
13. risksAndCaveats: cite ALL dataQuality flags relevant to this distributor.
14. recommendedActions: practical steps derived from the data only.

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "distributorProfile": { "title": "Distributor Profile", "body": "..." },
  "flowGapAnalysis":    { "title": "Flow Gap Analysis",   "body": "..." },
  "retailerConcentration":{ "title": "Retailer Concentration", "body": "..." },
  "tierAssessment":     { "title": "Tier Assessment",     "body": "..." },
  "risksAndCaveats":    { "title": "Risks and Caveats",   "body": "..." },
  "recommendedActions": { "title": "Recommended Actions", "body": "..." }
}`;

router.post("/ai/distributor-report", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead, distributor } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!stateHead) { res.status(400).json({ error: "stateHead is required." }); return; }
  if (!distributor) { res.status(400).json({ error: "distributor name is required." }); return; }

  req.log.info({ fy, stateHead, distributor }, "ai/distributor-report: request");

  try {
    // Shared identity registry: an ambiguous name (multiple DIST# identities
    // behind one normKey) errors with every candidate — never a first match.
    const registry = await loadDistributorRegistry();
    const resolved = registry.resolve(distributor);
    if (resolved.kind === "ambiguous") {
      res.status(400).json({ error: resolved.message, candidates: resolved.candidates });
      return;
    }
    const result = await loadDistributorDeepDive(fy, stateHead);
    const normKey = resolved.kind === "found" ? resolved.record.normKey : normDistKey(distributor);
    const found = result.distributors.find((d) => d.normKey === normKey);
    if (!found) {
      res.status(404).json({ error: `Distributor '${distributor}' not found for state head '${stateHead}' in FY${fy}.` });
      return;
    }

    const payload = buildDistributorPayload(result, normKey);

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: DIST_REPORT_PROMPT,
      messages: [{ role: "user", content: `Verified distributor payload (JSON):\n${JSON.stringify(payload, null, 2)}` }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const sections = JSON.parse(stripFences(rawJson)) as Record<string, { title: string; body: string }>;
    const guard = guardDist(sections, payload);

    req.log.info({ stateHead, distributor: found.name, guardStatus: guard.status }, "ai/distributor-report: done");

    res.json({ fy, stateHead, distributor: found.name, dataCutoff: payload.identity.dataCutoff, generatedAt: payload.identity.generatedAt, sections, guard, payload });
  } catch (err) {
    req.log.error({ err, fy, stateHead, distributor }, "ai/distributor-report: error");
    res.status(502).json({ error: "Distributor report generation failed. Please retry." });
  }
});

// ── 3. Distributor Suggestions ────────────────────────────────────────────────

const DIST_SUGGESTIONS_PROMPT = `You are generating ranked channel improvement suggestions for a Prayag India territory.

${CORE_NUMERIC_RULES}

DISTRIBUTOR SUGGESTIONS ADDITIONAL RULES:
9. Order suggestions strictly by ease of execution — easiest first:
   (a) Administrative: assign unassigned retailers to existing distributors (assignment gap — immediate).
   (b) Tactical: redirect distributor visit effort, improve fill rates, address concentration risk.
   (c) Strategic: appoint new distributors for coverage gaps, restructure channel conflicts.
10. Each suggestion must name the payload field(s) that motivate it.
11. "metric" is a plain-English description of the motivating figure with its value and field path.
12. Do NOT suggest anything requiring arithmetic not shown in the payload.
13. Apply the gap type rule: administrative and strategic suggestions must be clearly labelled as such and never merged.

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "intro": "One sentence context.",
  "suggestions": [
    {
      "rank": 1,
      "title": "...",
      "metric": "...",
      "payloadField": "exact.field.path",
      "expectedEffect": "...",
      "effort": "low | medium | high",
      "action": "Specific action — who does what."
    }
  ]
}`;

router.post("/ai/distributor-suggestions", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!stateHead) { res.status(400).json({ error: "stateHead is required." }); return; }

  req.log.info({ fy, stateHead }, "ai/distributor-suggestions: request");

  try {
    const result = await loadDistributorDeepDive(fy, stateHead);
    if (result.error && !result.distributors.length) { res.status(502).json({ error: result.error }); return; }

    const payload = buildDistributorPayload(result);

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: DIST_SUGGESTIONS_PROMPT,
      messages: [{ role: "user", content: `Verified distributor payload (JSON):\n${JSON.stringify(payload, null, 2)}` }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const result2 = JSON.parse(stripFences(rawJson)) as { intro: string; suggestions: unknown[] };
    if (!Array.isArray(result2.suggestions)) throw new Error("suggestions array missing");

    const guard = guardDist(result2, payload);

    req.log.info({ stateHead, count: result2.suggestions.length, guardStatus: guard.status }, "ai/distributor-suggestions: done");

    res.json({ fy, stateHead, dataCutoff: payload.identity.dataCutoff, generatedAt: payload.identity.generatedAt, ...result2, guard, payload });
  } catch (err) {
    req.log.error({ err, fy, stateHead }, "ai/distributor-suggestions: error");
    res.status(502).json({ error: "Distributor suggestions generation failed. Please retry." });
  }
});

// ── 4. Distributor Review ─────────────────────────────────────────────────────

const DIST_REVIEW_PROMPT = `You are generating a channel review for a single Prayag India distributor. This is an internal management document.

${CORE_NUMERIC_RULES}

DISTRIBUTOR REVIEW ADDITIONAL RULES:
9. channelHealthAssessment: state the distributor's overall contribution and health. Cite orderBooking, obSharePct, activeCount, dormantCount, tier.
10. flowGapContext: MUST apply the flow gap two-reading rule. State BOTH readings. Never omit either. Never accuse.
11. whitespaceContext: apply the gap type rule if this distributor's district has gaps. State which gap type and the correct remedy.
12. investmentAndReturn: cite effectiveDiscountPct if available. Note "effective discount data is available only for closed financial years" when effectiveDiscountPct is null.
13. developmentOpportunities: forward-looking — based on payload data only.
14. recommendedActions: ordered by urgency.

RESPONSE FORMAT — return ONLY valid JSON, no fences:
{
  "channelHealthAssessment":  { "title": "Channel Health Assessment",   "body": "..." },
  "flowGapContext":            { "title": "Flow Gap Context",            "body": "..." },
  "whitespaceContext":         { "title": "Territory Whitespace Context","body": "..." },
  "investmentAndReturn":       { "title": "Investment and Return",       "body": "..." },
  "developmentOpportunities":  { "title": "Development Opportunities",  "body": "..." },
  "recommendedActions":        { "title": "Recommended Actions",        "body": "..." }
}`;

router.post("/ai/distributor-review", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead, distributor } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!stateHead) { res.status(400).json({ error: "stateHead is required." }); return; }
  if (!distributor) { res.status(400).json({ error: "distributor name is required." }); return; }

  req.log.info({ fy, stateHead, distributor }, "ai/distributor-review: request");

  try {
    // Shared identity registry: ambiguous names error with candidates.
    const registry = await loadDistributorRegistry();
    const resolved = registry.resolve(distributor);
    if (resolved.kind === "ambiguous") {
      res.status(400).json({ error: resolved.message, candidates: resolved.candidates });
      return;
    }
    const result = await loadDistributorDeepDive(fy, stateHead);
    const normKey = resolved.kind === "found" ? resolved.record.normKey : normDistKey(distributor);
    const found = result.distributors.find((d) => d.normKey === normKey);
    if (!found) {
      res.status(404).json({ error: `Distributor '${distributor}' not found for state head '${stateHead}' in FY${fy}.` });
      return;
    }

    const payload = buildDistributorPayload(result, normKey);

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: DIST_REVIEW_PROMPT,
      messages: [{ role: "user", content: `Verified distributor payload (JSON):\n${JSON.stringify(payload, null, 2)}` }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const sections = JSON.parse(stripFences(rawJson)) as Record<string, { title: string; body: string }>;
    const guard = guardDist(sections, payload);

    req.log.info({ stateHead, distributor: found.name, guardStatus: guard.status }, "ai/distributor-review: done");

    res.json({ fy, stateHead, distributor: found.name, dataCutoff: payload.identity.dataCutoff, generatedAt: payload.identity.generatedAt, sections, guard, payload });
  } catch (err) {
    req.log.error({ err, fy, stateHead, distributor }, "ai/distributor-review: error");
    res.status(502).json({ error: "Distributor review generation failed. Please retry." });
  }
});

// ── 5. Distributor Presentation ───────────────────────────────────────────────

const DIST_PRESENTATION_PROMPT = `You are generating a structured slide deck plan for a Prayag India distributor channel presentation.

${CORE_NUMERIC_RULES}

PRESENTATION ADDITIONAL RULES:
9. NEVER include chart data in bullets or commentary. Charts are rendered natively by the application.
10. chartDataRef must be ONE of: "dist_channel_structure", "dist_performance", "dist_flow_gap", "dist_whitespace", "dist_tier", "none".
11. chartType must be ONE of: "bar", "pie", "none".
12. Keep the deck short: 8 to 10 slides.
13. Slide order: channel architecture → distributor ranking → flow gaps → whitespace gaps → concentration → tier → actions.
14. Apply BOTH mandatory framing rules in the relevant slides — flow gap slide MUST state both readings, whitespace slide MUST separate COVERAGE GAP from ASSIGNMENT GAP.
15. deckTitle and deckSubtitle must not contain numeric figures.

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
      "chartType": "bar | pie | none",
      "chartDataRef": "dist_channel_structure | dist_performance | dist_flow_gap | dist_whitespace | dist_tier | none"
    }
  ]
}`;

router.post("/ai/distributor-presentation", async (req: Request, res: Response): Promise<void> => {
  const { fy, stateHead } = parseBody(req.body);
  if (!FY_PATTERN.test(fy)) { res.status(400).json({ error: "fy must look like 2026-27" }); return; }
  if (!stateHead) { res.status(400).json({ error: "stateHead is required." }); return; }

  req.log.info({ fy, stateHead }, "ai/distributor-presentation: request");

  try {
    const result = await loadDistributorDeepDive(fy, stateHead);
    if (result.error && !result.distributors.length) { res.status(502).json({ error: result.error }); return; }

    const payload = buildDistributorPayload(result);

    const message = await anthropic.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: DIST_PRESENTATION_PROMPT,
      messages: [{ role: "user", content: `Verified distributor payload (JSON):\n${JSON.stringify(payload, null, 2)}` }],
    });

    const rawJson = message.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    const deck = JSON.parse(stripFences(rawJson)) as { deckTitle: string; deckSubtitle: string; slides: unknown[] };
    if (!Array.isArray(deck.slides)) throw new Error("slides array missing");

    const guard = guardDist(deck, payload);

    req.log.info({ stateHead, slideCount: deck.slides.length, guardStatus: guard.status }, "ai/distributor-presentation: done");

    res.json({ fy, stateHead, dataCutoff: payload.identity.dataCutoff, generatedAt: payload.identity.generatedAt, ...deck, guard, payload });
  } catch (err) {
    req.log.error({ err, fy, stateHead }, "ai/distributor-presentation: error");
    res.status(502).json({ error: "Distributor presentation generation failed. Please retry." });
  }
});

export default router;
