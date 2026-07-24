// Phase A2 — POST /api/ai/report
//
// Full generation chain: A1 payload  →  Anthropic API  →  structured JSON
// response  →  numeric guard  →  HTTP response.
//
// Claude receives ONLY the pre-computed payload. It never sees raw sheet rows
// and never does arithmetic. The numeric guard runs after generation and flags
// any number that cannot be matched to a payload value. The report is then
// marked "requires_review" rather than silently published.
//
// Architecture: app = numbers. Claude = judgement.
// Rules:
//   Never console.log — use req.log / logger.
//   Never write to Google Drive.
//   model: claude-sonnet-4-6 (per existing convention)
//   max_tokens: 8192

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { loadDeepDiveData, normSecKey } from "../lib/mgmt/deepDiveData.js";
import {
  buildMemberPayload,
  type AiPayload,
} from "../lib/mgmt/aiPayload.js";
import { runNumericGuard, type GuardResult } from "../lib/mgmt/numericGuard.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;

// ── Request schema ────────────────────────────────────────────────────────────

const AiReportRequestSchema = z.object({
  fy:        z.string().default("2026-27"),
  stateHead: z.string().trim().optional(),
  member:    z.string().trim(),
  period:    z.string().optional().default("ytd"),
  corrupt:   z.boolean().optional().default(false), // guard test: inject a wrong number
});

// ── Report section type ───────────────────────────────────────────────────────

type ReportSections = {
  executiveSummary:        { title: string; body: string };
  performanceAgainstTarget: { title: string; body: string };
  coverageAndCustomerBase:  { title: string; body: string };
  visitEffectiveness:       { title: string; body: string };
  costAndReturn:            { title: string; body: string };
  risksAndDataCaveats:      { title: string; body: string };
};

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are generating a management report for Prayag India's sales leadership.

Your SOLE source of data is the verified payload provided in the user message.
An automated numeric guard will run after you respond and flag every number that cannot be
matched to a payload field. Write only numbers that appear in the payload.

ABSOLUTE RULES:
1. Use ONLY numbers present in the payload. Never compute, estimate, derive a new ratio, or round a figure into a value not present in the payload.
2. Every quantitative claim must name its payload field in brackets immediately after the value — e.g. "Rs 26.21 lakh [performance.totalOB]". The guard uses these citations to verify provenance.
3. Where a dataQuality flag is relevant to a claim, state the caveat in the SAME SENTENCE as the figure, not in a footnote or a later section.
4. Write in English. No emojis. This is a management report; it refers to the salesperson in the third person (not "you").
5. If a section lacks data (field is null, section is null, or a dataQuality code signals absence), state that the data is unavailable and why. Never fill a gap with a plausible estimate.
6. For order booking: always present performance.secondaryOB and performance.directDealerOB separately before stating performance.totalOB. Never report only the blended total.
7. Present all four achievement ratios separately: achievement.totalOBPct, achievement.secondaryOBPct, achievement.directDealerPct, achievement.salePct. Never blend them into one figure.
8. For the SKU/product section: if productSpread is null or productSpread.available is false, write exactly this sentence in the costAndReturn or risksAndDataCaveats section: "Item-code level data is not available for this financial year as this analysis requires a completed financial year; SKU-level breakdown will be available after year-end."
9. For dormant retailers: if the UNASSIGNED_RETAILERS flag appears in dataQuality, include its message in the SAME SENTENCE as any mention of the dormant count or total retailer count.
10. Do NOT invent prior-year OB or prior-year sale figures. priorYears entries have null ob and null sale for current open FY — if those fields are null, state visit history only.

RESPONSE FORMAT:
Return ONLY valid JSON with no markdown code fences, no preamble, no trailing commentary:
{
  "executiveSummary":         { "title": "Executive Summary",           "body": "..." },
  "performanceAgainstTarget": { "title": "Performance Against Target",  "body": "..." },
  "coverageAndCustomerBase":  { "title": "Coverage and Customer Base",  "body": "..." },
  "visitEffectiveness":       { "title": "Visit Effectiveness",         "body": "..." },
  "costAndReturn":            { "title": "Cost and Return",             "body": "..." },
  "risksAndDataCaveats":      { "title": "Risks and Data Caveats",      "body": "..." }
}`;

// ── Build user message ────────────────────────────────────────────────────────

function buildUserMessage(payload: AiPayload): string {
  return `Verified payload (JSON) — use ONLY these figures:\n\n${JSON.stringify(payload, null, 2)}`;
}

// ── Parse Claude's JSON response ──────────────────────────────────────────────

const SectionSchema = z.object({
  title: z.string(),
  body:  z.string(),
});

const SectionsSchema = z.object({
  executiveSummary:         SectionSchema,
  performanceAgainstTarget: SectionSchema,
  coverageAndCustomerBase:  SectionSchema,
  visitEffectiveness:       SectionSchema,
  costAndReturn:            SectionSchema,
  risksAndDataCaveats:      SectionSchema,
});

function parseSections(raw: string): ReportSections {
  // Strip markdown fences if Claude wrapped anyway
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const parsed = JSON.parse(stripped) as unknown;
  return SectionsSchema.parse(parsed);
}

// ── Corrupt-test injection ────────────────────────────────────────────────────
// When corrupt=true, inject a clearly wrong monetary figure into the executive
// summary. The numeric guard should flag it, proving the guard works.

function injectCorruption(sections: ReportSections): ReportSections {
  const marker =
    "[GUARD TEST — INJECTED WRONG FIGURE: Rs 55,55,555 which does not match any payload field] ";
  return {
    ...sections,
    executiveSummary: {
      ...sections.executiveSummary,
      body: marker + sections.executiveSummary.body,
    },
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post("/ai/report", async (req: Request, res: Response): Promise<void> => {
  const parsed = AiReportRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { fy, stateHead, member: memberRaw, period, corrupt } = parsed.data;

  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }

  const memberKey = normSecKey(memberRaw);

  req.log.info({ fy, stateHead, member: memberRaw, corrupt }, "ai/report: request received");

  try {
    // ── 1. Build the A1 payload ───────────────────────────────────────────────
    const data = await loadDeepDiveData(fy, stateHead, memberKey);

    if (data.error && !data.kpis) {
      res.status(502).json({ error: `Data unavailable: ${data.error}` });
      return;
    }

    if (!data.kpis) {
      res.status(404).json({
        error: `Member '${memberRaw}' not found in the FY${fy} Data tab.`,
      });
      return;
    }

    const payload = buildMemberPayload(
      fy,
      stateHead ?? data.kpis.stateHead ?? null,
      period ?? "ytd",
      data.kpis,
      data.retailerDetail,
      data.roiCost,
      data.skuSpread,
    );

    req.log.info(
      { member: data.kpis.name, dataCutoff: payload.identity.dataCutoff },
      "ai/report: payload built",
    );

    // ── 2. Call Claude ────────────────────────────────────────────────────────
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(payload) }],
    });

    const rawJson = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    req.log.info(
      { member: data.kpis.name, tokens: message.usage.output_tokens },
      "ai/report: Claude response received",
    );

    // ── 3. Parse and validate the JSON sections ───────────────────────────────
    let sections: ReportSections;
    try {
      sections = parseSections(rawJson);
    } catch (parseErr) {
      req.log.error({ parseErr, rawJson: rawJson.slice(0, 500) }, "ai/report: JSON parse failed");
      res.status(502).json({
        error: "Claude returned malformed JSON. Please retry.",
        rawJson: rawJson.slice(0, 500),
      });
      return;
    }

    // ── 4. Corrupt-test injection (guard self-test) ───────────────────────────
    if (corrupt) {
      sections = injectCorruption(sections);
      req.log.warn({ member: data.kpis.name }, "ai/report: CORRUPT MODE — injecting wrong figure");
    }

    // ── 5. Numeric guard ──────────────────────────────────────────────────────
    const guard: GuardResult = runNumericGuard(sections as unknown as Record<string, { title: string; body: string }>, payload);

    req.log.info(
      {
        member: data.kpis.name,
        guardStatus: guard.status,
        checked: guard.checked,
        unmatched: guard.unmatched.length,
      },
      "ai/report: numeric guard complete",
    );

    if (guard.unmatched.length > 0) {
      req.log.warn(
        { unmatched: guard.unmatched },
        "ai/report: GUARD FLAGGED — unmatched numbers in generated text",
      );
    }

    // ── 6. Response ───────────────────────────────────────────────────────────
    res.json({
      fy,
      member: data.kpis.name,
      stateHead: data.kpis.stateHead ?? stateHead ?? null,
      dataCutoff: payload.identity.dataCutoff,
      generatedAt: payload.identity.generatedAt,
      sections,
      guard,
      ...(corrupt ? { corruptTestMode: true } : {}),
    });
  } catch (err) {
    req.log.error({ err, fy, member: memberRaw }, "ai/report: unexpected error");
    res.status(502).json({ error: "Report generation failed. Please retry." });
  }
});

export default router;
