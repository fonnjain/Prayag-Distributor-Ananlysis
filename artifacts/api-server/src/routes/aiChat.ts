// Phase A7 — Ask Claude: stateless Q&A grounded in the current selection's payload.
import { currentOpenFy } from "../lib/fyAnchors.js";
//
// POST /api/ai/chat
//   Body: {
//     fy: string,
//     stateHead?: string,
//     member?: string,
//     period?: string,
//     messages: { role: "user" | "assistant"; content: string }[]
//   }
//   Response: { answer: string, guard: GuardResult, dataCutoff: string, displayName: string }
//
// Rules:
//   - Payload built identically to suggestions/travel-plan — same AiPayload shape.
//   - System prompt embeds the payload + field-citation rules.
//   - Full conversation history sent on every call (API is stateless).
//   - Numeric guard runs on the raw answer text.
//   - Never console.log — use req.log / logger.
//   - Never write to Google Drive.

import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { loadDeepDiveData, normSecKey } from "../lib/mgmt/deepDiveData.js";
import type { MemberKpis } from "../lib/mgmt/deepDiveData.js";
import {
  buildMemberPayload,
  buildStateHeadPayload,
  type AiPayload,
} from "../lib/mgmt/aiPayload.js";
import { runNumericGuard } from "../lib/mgmt/numericGuard.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 4096; // Chat answers are concise; 4k is ample.

// ── System prompt ─────────────────────────────────────────────────────────────
//
// The payload is appended after this string at call time so Claude always has
// the most up-to-date verified data for the current selection.

function buildSystemPrompt(fy: string, stateHead: string, displayName: string, payload: AiPayload): string {
  return `You are an AI analyst for Prayag India Sales Intelligence, answering questions about sales data.

Your SOLE data source is the verified payload appended below. An automated numeric guard checks every figure you cite and will flag any number not matched to a payload field.

ABSOLUTE RULES:
1. Answer ONLY from figures explicitly present in the verified payload. Never compute, estimate, subtract, add, or derive a figure not present as a numeric value. If a derived figure is needed (e.g. a percentage not in the payload), state that it is not available rather than computing it.
2. Cite the exact payload field in square brackets immediately after every number — e.g. "39 [coverage.dormant]". Without a citation the figure will be flagged by the guard.
3. When a dataQuality flag is relevant to the answer, state the caveat in the SAME SENTENCE as the affected figure — not in a footnote.
4. If the question requires data not in the payload — for example, item-code/SKU breakdowns (which require a completed financial year), retailer names for a member with the NO_MEMBER_SHEET flag, or prior-year figures that are null — state clearly what is missing and why. Do NOT attempt to answer using invented figures.
5. If the question is about a different member, state head, or period than the current selection, say so explicitly and ask the user to change the filter selection before asking again. Do NOT guess or answer from memory about any other person's data.
6. If productSpread is null or productSpread.available is false, state verbatim: "Item-code level data is not available for this financial year — this analysis requires a completed financial year."
7. When coverage.dormant has both an UNASSIGNED_RETAILERS flag and a DORMANT_CUSTOMERS flag in dataQuality, explain both components separately in your answer: (a) retailers who cannot place orders because no distributor is mapped [coverage.unassigned or the flag count], and (b) retailers who were visited but placed no orders [the remainder]. Cite both figures with field paths.
8. For top-customer questions: customers.topCustomers[] lists name, share, channel, totalOB. Identify channel="direct" as direct dealers by name.
9. Do NOT use "per Rs 100" normalisation phrases. Express ratios as percentages or direct values.
10. 4-digit calendar years (2020-2030) in FY notation (e.g. "FY2026-27") are excluded from the numeric guard — you do not need to cite years.
11. Null means null. Never substitute a plausible estimate for a null field — state the field is unavailable.
12. Write in plain prose. No emojis. Management register. Concise — 3-6 sentences unless the question genuinely requires more. No JSON output.
13. Do NOT invent prior-year OB or sale figures. priorYears.ob and priorYears.sale may be null for open FYs.

CURRENT SELECTION: FY${fy} | State Head: ${stateHead || "N/A"} | Member: ${displayName}
Any question about a different member, state head, or period must be redirected — do not answer it.

VERIFIED PAYLOAD (JSON):
${JSON.stringify(payload, null, 2)}`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post("/ai/chat", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

  const fy        = typeof body.fy        === "string" && body.fy.trim()        ? body.fy.trim()        : currentOpenFy();
  const stateHead = typeof body.stateHead === "string" && body.stateHead.trim() ? body.stateHead.trim() : undefined;
  const memberRaw = typeof body.member    === "string" && body.member.trim()    ? body.member.trim()    : undefined;
  const period    = typeof body.period    === "string" && body.period.trim()    ? body.period.trim()    : "ytd";

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  type RawMsg = { role: string; content: string };
  const messages = (rawMessages as RawMsg[]).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim(),
  );

  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" }); return;
  }
  if (!memberRaw && !stateHead) {
    res.status(400).json({ error: "Either member or stateHead is required." }); return;
  }
  if (messages.length === 0) {
    res.status(400).json({ error: "messages array must have at least one entry." }); return;
  }
  if (messages[messages.length - 1].role !== "user") {
    res.status(400).json({ error: "The last message must be a user question." }); return;
  }

  req.log.info({ fy, stateHead, member: memberRaw, turns: messages.length }, "ai/chat: request");

  try {
    let payload: AiPayload;
    let displayName: string;

    if (memberRaw) {
      // ── Member-scoped chat ─────────────────────────────────────────────────
      const memberKey = normSecKey(memberRaw);
      const data = await loadDeepDiveData(fy, stateHead, memberKey);
      if (!data.kpis) {
        res.status(404).json({ error: `Member '${memberRaw}' not found.` }); return;
      }
      payload = buildMemberPayload(
        fy,
        stateHead ?? data.kpis.stateHead ?? null,
        period,
        data.kpis,
        data.retailerDetail,
        data.roiCost,
        data.skuSpread,
      );
      displayName = data.kpis.name ?? memberRaw;
    } else {
      // ── State-head-scoped chat ─────────────────────────────────────────────
      const topData = await loadDeepDiveData(fy, stateHead!, undefined);
      const refs = topData.members;
      if (refs.length === 0) {
        res.status(404).json({ error: `State head '${stateHead}' not found or has no members.` }); return;
      }
      const kpiList = await Promise.all(
        refs.map((ref) => loadDeepDiveData(fy, ref.stateHead, ref.normKey).then((d) => d.kpis)),
      );
      const members = kpiList.filter((k): k is MemberKpis => k !== null);
      payload = buildStateHeadPayload(fy, stateHead!, period, members);
      displayName = stateHead!;
    }

    // ── Call Claude with full conversation history ──────────────────────────
    const systemPrompt = buildSystemPrompt(fy, stateHead ?? "", displayName, payload);

    const anthropicMessages = messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: anthropicMessages,
    });

    const answer = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    // ── Run numeric guard on the free-text answer ──────────────────────────
    const guard = runNumericGuard(
      { content: { title: "", body: answer } },
      payload,
    );

    req.log.info(
      { displayName, guardStatus: guard.status, unmatched: guard.unmatched.length, turns: messages.length },
      "ai/chat: done",
    );

    res.json({
      answer,
      guard,
      dataCutoff: payload.identity.dataCutoff,
      displayName,
    });
  } catch (err) {
    req.log.error({ err, fy, stateHead, member: memberRaw }, "ai/chat: error");
    res.status(502).json({ error: "Chat failed. Please retry." });
  }
});

export default router;
