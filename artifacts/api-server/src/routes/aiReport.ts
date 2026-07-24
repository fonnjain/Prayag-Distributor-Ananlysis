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
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { loadDeepDiveData, normSecKey } from "../lib/mgmt/deepDiveData.js";
import {
  buildMemberPayload,
  type AiPayload,
} from "../lib/mgmt/aiPayload.js";
import { runNumericGuard, type GuardResult } from "../lib/mgmt/numericGuard.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;

// ── Request parsing ───────────────────────────────────────────────────────────

type AiReportRequest = {
  fy:        string;
  stateHead: string | undefined;
  member:    string;
  period:    string;
  corrupt:   boolean;
};

function parseRequest(body: unknown): AiReportRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required." };
  const b = body as Record<string, unknown>;
  if (typeof b.member !== "string" || !b.member.trim()) return { error: "member is required." };
  return {
    fy:        typeof b.fy === "string" && b.fy.trim() ? b.fy.trim() : "2026-27",
    stateHead: typeof b.stateHead === "string" && b.stateHead.trim() ? b.stateHead.trim() : undefined,
    member:    b.member.trim(),
    period:    typeof b.period === "string" && b.period.trim() ? b.period.trim() : "ytd",
    corrupt:   b.corrupt === true,
  };
}

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
1. Use ONLY numbers present in the payload. Never compute, estimate, subtract, add, or derive any figure that does not appear explicitly as a numeric value in the payload JSON. If you feel you must compute something (e.g. dormant = total − active), stop — write that the breakdown is not available instead.
2. Every quantitative claim must name its payload field in brackets immediately after the value — e.g. "Rs 26.21 lakh [performance.totalOB]". The guard uses these citations to verify provenance.
3. Where a dataQuality flag is relevant to a claim, state the caveat in the SAME SENTENCE as the figure, not in a footnote or a later section.
4. Write in English. No emojis. This is a management report; it refers to the salesperson in the third person (not "you").
5. If a field is null, absent, or a dataQuality code signals absence, state that the data is unavailable and why. NEVER substitute a plausible estimate or a number derived from other fields. Null means null.
6. For order booking: always present performance.secondaryOB and performance.directDealerOB separately before stating performance.totalOB. Never report only the blended total.
7. Present all four achievement ratios separately: achievement.totalOBPct, achievement.secondaryOBPct, achievement.directDealerPct, achievement.salePct. Never blend them into one figure.
8. For the SKU/product section: if productSpread is null or productSpread.available is false, write exactly this sentence in the costAndReturn or risksAndDataCaveats section: "Item-code level data is not available for this financial year as this analysis requires a completed financial year; SKU-level breakdown will be available after year-end."
9. For dormant retailers: if the UNASSIGNED_RETAILERS flag appears in dataQuality, include its message in the SAME SENTENCE as any mention of the dormant count or total retailer count.
10. Do NOT invent prior-year OB or prior-year sale figures. priorYears entries have null ob and null sale for current open FY — if those fields are null, state visit history only.
11. Distance band thresholds and labels (e.g. "Mid (15-40 km)") appear verbatim in visits.distanceBands[].label. Copy them exactly. Do not invent alternative km ranges or bins.
12. Numeric range boundaries in labels (the "15", "40" in "Mid (15-40 km)") are payload values embedded in strings. You may quote them as part of citing the label. Do not introduce any other numeric thresholds.
13. Do NOT use "per Rs 100" or "for every Rs 100" normalization phrases. Express cost ratios as percentages or as a direct value from the payload. Do not introduce 100 as a normalization denominator — it is not a payload value and the guard will flag it.

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

function isSection(v: unknown): v is { title: string; body: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).title === "string" &&
    typeof (v as Record<string, unknown>).body === "string"
  );
}

function parseSections(raw: string): ReportSections {
  // Strip markdown fences if Claude wrapped anyway
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const parsed = JSON.parse(stripped) as Record<string, unknown>;

  const keys: (keyof ReportSections)[] = [
    "executiveSummary",
    "performanceAgainstTarget",
    "coverageAndCustomerBase",
    "visitEffectiveness",
    "costAndReturn",
    "risksAndDataCaveats",
  ];

  for (const key of keys) {
    if (!isSection(parsed[key])) {
      throw new Error(`Missing or malformed section: ${key}`);
    }
  }

  return parsed as unknown as ReportSections;
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
  const parseResult = parseRequest(req.body);
  if ("error" in parseResult) {
    res.status(400).json({ error: parseResult.error });
    return;
  }

  const { fy, stateHead, member: memberRaw, period, corrupt } = parseResult;

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
