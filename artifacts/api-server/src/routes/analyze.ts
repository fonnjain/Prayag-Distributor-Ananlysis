/**
 * POST /api/analyze  — Phase A8-B: graph-traversal AI Analyst.
 *
 * Replaces the fixed-payload approach with a two-step traversal:
 *   1. The graph INDEX (shape / gaps / available measures) is sent in every prompt.
 *   2. Claude calls the `resolve_nodes` tool to fetch specific nodes on demand,
 *      several rounds if needed.
 *   3. The final answer cites node paths and lists the traversal.
 *
 * GUARDRAILS (none may be relaxed):
 *   - Use ONLY values present in returned nodes. Never calculate a new figure.
 *   - Selecting, comparing, ranking, explaining across nodes is allowed. Arithmetic is not.
 *   - Cite the node path behind every number given.
 *   - Never compare two nodes whose MEASURE or POPULATION differ without saying so.
 *   - If answering needs a gap node, say what is missing using the gap reason.
 *   - Volunteer any flag on a node used in the answer.
 *   - CROSS_FY_KEY_SPLIT nodes must not be presented as a year-on-year comparison.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { currentOpenFy } from "../lib/fyAnchors.js";
import { AnalyzeSalesBody, AnalyzeSalesResponse } from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { buildGraphIndex, graphIndexToPromptText } from "../lib/mgmt/graph/graphIndex.js";
import { normalizeGraphNode, resolvePath, resolveWildcard } from "../lib/mgmt/graph/resolvers.js";
import { MAX_NODES_PER_RESOLVE } from "../lib/mgmt/graph/types.js";
import { MEASURE_LABELS, type GraphNode, type MeasureValue } from "../lib/mgmt/graph/types.js";

const router: IRouter = Router();

const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{2122}\u{2139}\u{2328}\u{23E9}-\u{23FA}\u{24C2}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]/gu;

function stripEmojis(text: string): string {
  return text.replace(EMOJI_PATTERN, "").replace(/[ \t]+\n/g, "\n").trim();
}

// Maximum traversal rounds before we force a final answer.
const MAX_ROUNDS = 5;
const MAX_TOOL_CALLS = 20;
const MAX_TOTAL_TRAVERSAL_NODES = 100;
const MAX_TOTAL_TRAVERSAL_ERRORS = 100;

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(indexText: string): string {
  return `You are the "Prayag India Sales Analyst", an expert data analyst for Prayag India.

You answer questions by TRAVERSING the metrics graph described below.
The graph holds every reconciled figure in the application — primary sale, secondary OB, secondary sales received, targets, retailer counts, distributor flows, concentration, visit data, cost ratios.

GUARDRAILS — these are absolute and none may be relaxed:
1. USE ONLY values present in nodes returned by the resolve_nodes tool. NEVER calculate a new figure, derive a ratio not present in a node, estimate, or interpolate.
2. Selecting, comparing, ranking, and explaining across returned nodes is allowed and is the point. Arithmetic on node values is not.
3. Cite the NODE PATH behind every number given (e.g. "salesperson/Prasun Chatterjee/2026-27").
4. Never compare two nodes whose MEASURE or POPULATION differ without explicitly stating the difference. Primary and secondary bases will never reconcile — say that rather than reporting a discrepancy.
4a. DENOMINATOR DISCIPLINE. When a question implies a ratio (e.g. "sales per partner"), NAME THE DENOMINATOR before answering. "Partner" has at least two valid denominators — per distributor and per retailer — that rank State Heads differently. One head (Nasir Hussain Khan) has zero distributors, so a per-distributor ratio for him is undefined. Either ask which denominator is meant, or answer on BOTH bases and state both explicitly, including which heads have undefined figures on which basis.
5. If answering needs a node that does not exist, say what is missing using the gap node's own reason. Do not answer anyway.
6. Volunteer any flag on a node used in the answer (e.g. CROSS_FY_KEY_SPLIT, MONTH_ABSENT, FLOW_GAP).
7. If a node is flagged CROSS_FY_KEY_SPLIT, do not present its year-on-year comparison as fact.
8. Never use emojis, pictographs, or decorative Unicode. Text and standard punctuation only.
9. Format all INR values using Indian convention: crore (Cr = 10,000,000) and lakh (lakh = 100,000).
10. Respond in clear, well-structured Markdown. Lead with the answer, then support with specific numbers.

MULTI-YEAR QUESTIONS:
11. Every loaded fiscal year is resolvable in one question — NEVER tell the user to change a filter. Resolve the same path per FY (e.g. head/Anant Singh/2025-26 and head/Anant Singh/2026-27) and ALWAYS name the years used in the answer.
12. Any comparison that touches the open FY must be on LIKE MONTHS: append /likemonths to company or head paths (e.g. company/2025-26/likemonths vs company/2026-27/likemonths) and say which months the window covers. Never compare a partial year to a full year.

BASIS DISCIPLINE (apply these unprompted, whenever relevant):
13. PRIMARY (company→distributor dispatches, sale_line) and SECONDARY (distributor→retailer, register/dashboard) are DIFFERENT POPULATIONS. Never sum them; any secondary/primary coverage ratio must be flagged as comparing different populations.
14. ACHIEVEMENT means Sales Received / Business Plan — never OB / Target. Name the denominator whenever you say "achievement".
15. A plan with no recorded actuals is "not recorded yet" — NEVER report it as zero performance.
16. Project / Non-territory / Govt business is EXCLUDED from territory baselines (gap lists, breadth, seasonality). Say so when it matters.
17. Retailer counts and visit figures each have multiple sources that disagree (dashboard point-in-time, member working sheet, secondary register). Name the source of any retailer count or visit figure you cite.

COMPARISONS:
18. Comparing two entities (head vs head, member vs peers, month vs same month last year, territory vs company) in one answer is expected — resolve both sides' nodes and present them together, stating basis and period for each.

SAFE CLARIFICATIONS:
19. If a projected year-end question does not name an entity, ask which entity. Do not resolve a wildcard just to list candidates. State that a projection may be reported only from a typed projection measure carrying seasonal-service, observed-month, and calibration metadata; otherwise it is unavailable.
20. If a member-in-August "sales" question does not name the member, ask for the member and clarify the basis in the same answer: secondary order booking is distributor-to-retailer booking, while primary dispatch is company-to-distributor sale. Never use the unqualified word "sales" as if those were one measure.

HOW TO USE THE GRAPH:
- Call resolve_nodes with a list of paths to fetch those nodes.
- Wildcards: "head/*/2026-27" returns all heads (hard cap: ${MAX_NODES_PER_RESOLVE} nodes per call).
- Make as many resolve_nodes calls as needed, but be targeted — fetch only what you need to answer the question.
- For "top 10 retailers by August order value and their SKU breadth" (or the same
  request with minor wording changes), resolve
  secondary-booking/2026-27/august-top-retailers. It is the bounded complete
  Product-Wise August answer: rank by Basic Order Value ex-GST and report the
  distinct product_code count. Do not use gap/live-year-sku or gap/mapping-confidence
  for this request; customer_name is a label and dealer_id is the durable retailer key.
- After fetching, include a "## Traversal" section listing all node paths consulted.

${indexText}`;
}

// ── Tool definition ───────────────────────────────────────────────────────────

const RESOLVE_NODES_TOOL = {
  name: "resolve_nodes",
  description:
    "Fetch one or more graph nodes by path. " +
    "Returns reconciled figures with population, source, cutoff, and flags. " +
    "Use paths like: company/2026-27, company/2025-26/likemonths, head/Anant Singh/2026-27, " +
    "head/Anant Singh/2025-26/likemonths, salesperson/Prasun Chatterjee/2026-27, " +
    "salesperson/Prasun Chatterjee/2026-27/month/Jun, distributor/Jagdamba Traders/2026-27, " +
    "sku/gaps/2026-27, sku/gaps/Anant Singh/2026-27, sku/push/{distributor}/2026-27, " +
    "sku/discounts/2026-27, sku/detail/2026-27, segment/CP/2026-27, " +
     "sales-deep-dive/{member}/2026-27, distributor-deep-dive/{name}/2026-27, " +
     "sku-deep-dive/2026-27, resolution/2026-27, margin/PTMT/2026-27, " +
     "penetration/2026-27, secondary-booking/2026-27, pending-orders/2026-27, " +
      "secondary-booking/2026-27/august-top-retailers, " +
     "company-report/{1-7}/2026-27, momentum/2026-27, growth/2026-27, targets/2026-27, " +
     "coverage/2026-27, comparison/2026-27, alerts/2026-27, data-health/2026-27, " +
     "category-registry/2026-27, top80/{snapshot-date}, gap/live-year-sku, head/*/2026-27 (wildcard). " +
    `Hard cap: ${MAX_NODES_PER_RESOLVE} nodes per call. If truncated, refine your paths.`,
  input_schema: {
    type: "object" as const,
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "List of node paths to resolve.",
      },
      fy: {
        type: "string",
        description: "Default fiscal year when a path omits it (e.g. '2026-27').",
      },
    },
    required: ["paths"],
  },
};

// ── Node resolver for tool calls ──────────────────────────────────────────────

async function runResolveTool(
  paths: string[],
  defaultFy: string,
): Promise<{ nodes: GraphNode[]; errors: { path: string; error: string }[]; truncated: boolean }> {
  const nodes: GraphNode[] = [];
  const errors: { path: string; error: string }[] = [];
  let truncated = false;
  if (paths.length > MAX_NODES_PER_RESOLVE) {
    errors.push({ path: "(request)", error: `Input path cap is ${MAX_NODES_PER_RESOLVE}` });
    truncated = true;
  }

  for (const rawPath of paths.slice(0, MAX_NODES_PER_RESOLVE)) {
    if (rawPath.length > 240 || rawPath.split("/").length > 8) {
      if (errors.length < MAX_NODES_PER_RESOLVE) errors.push({ path: rawPath, error: "Path exceeds bounded resolver grammar" });
      continue;
    }
    if (nodes.length >= MAX_NODES_PER_RESOLVE) { truncated = true; break; }

    if (rawPath.includes("/*")) {
      const { nodes: wNodes, errors: wErrors } = await resolveWildcard(rawPath, defaultFy);
      for (const n of wNodes) {
        if (nodes.length >= MAX_NODES_PER_RESOLVE) { truncated = true; break; }
        nodes.push(normalizeGraphNode(n));
      }
      errors.push(...wErrors.slice(0, Math.max(0, MAX_NODES_PER_RESOLVE - errors.length)));
    } else {
      const { node, error } = await resolvePath(rawPath, defaultFy);
      if (node)  nodes.push(normalizeGraphNode(node));
      if (error && errors.length < MAX_NODES_PER_RESOLVE) errors.push({ path: rawPath, error });
    }
  }

  return { nodes, errors, truncated };
}

// ── Numeric guard ─────────────────────────────────────────────────────────────

export function runNumericGuard(
  answer: string,
  nodes: GraphNode[],
): { status: "clean" | "unmatched"; unmatched: string[] } {
  const unmatched: string[] = [];

  const approved = { INR: new Set<string>(), pct: new Set<string>(), count: new Set<string>() };
  const normalizeToken = (token: string) => token.toLowerCase()
    .replace(/(?:₹|rs\.?|inr)/g, "").replace(/[,\s]/g, "")
    .replace(/(\d+)\.00(?=\s*[a-z%]|$)/g, "$1");
  const indian = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const add = (unit: keyof typeof approved, token: string) => approved[unit].add(normalizeToken(token));
  const typed: MeasureValue[] = [];
  const collectTyped = (value: unknown, depth = 0): void => {
    if (depth > 8 || value == null || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.measure === "string" && Object.prototype.hasOwnProperty.call(MEASURE_LABELS, candidate.measure) &&
          ["INR", "count", "pct"].includes(String(candidate.unit)) &&
          ["measured", "partial"].includes(String(candidate.availability)) && Number.isFinite(candidate.value)) {
        typed.push(candidate as unknown as MeasureValue);
      }
      for (const child of Object.values(candidate)) collectTyped(child, depth + 1);
    } else for (const child of value) collectTyped(child, depth + 1);
  };
  const addMeasureTokens = (m: MeasureValue) => {
    if (m.value == null) return;
    if (m.unit === "INR") {
      for (const marker of ["₹", "Rs ", "INR "]) add("INR", `${marker}${indian(m.value)}`);
      for (const [div, suffixes] of [[1e3, ["K", "thousand"]], [1e5, ["L", "Lakh"]], [1e7, ["Cr", "crore"]]] as const) {
        const rounded = (m.value / div).toFixed(2).replace(/\.00$/, "");
        for (const suffix of suffixes) {
          add("INR", `₹${rounded}${suffix}`); add("INR", `Rs ${rounded}${suffix}`); add("INR", `INR ${rounded}${suffix}`); add("INR", `${rounded}${suffix}`);
        }
      }
    } else if (m.unit === "pct") {
      add("pct", `${m.value}%`); add("pct", `${m.value.toFixed(2).replace(/\.00$/, "")}%`);
    } else {
      add("count", String(m.value)); add("count", indian(m.value));
    }
  };
  for (const n of nodes) {
    for (const m of n.measures) addMeasureTokens(m);
    collectTyped(n.detail);
  }
  for (const m of typed) addMeasureTokens(m);
  const protectedAnswer = answer
    .replace(/\b(?:company|head|salesperson|distributor|segment|sku|margin|resolution|penetration|top80|gap|company-report|momentum|growth|targets|coverage|comparison|alerts|data-health|category-registry|secondary-booking|pending-orders)\/[^\s,.;]+/gi, "")
    .replace(/\b(?:FY\s*)?20\d{2}\s*[-–—]\s*\d{2}\b/gi, "")
    .replace(/\b20\d{2}[/-]\d{1,2}[/-]\d{1,2}\b/g, "")
    .replace(/\b[A-Za-z][A-Za-z_-]*#\d+\b/g, "")
    // Presentation metadata is not a business figure. Remove only complete
    // textual dates, line-leading ordered-list markers, and bounded ranking
    // descriptors; arbitrary nearby numbers remain guarded.
    .replace(/\b(?:[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}\b/gi, "")
    .replace(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?,?\s+20\d{2}\b/gi, "")
    .replace(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+20\d{2}\b/gi, "")
    .replace(/^\s*\|\s*\d{1,3}\s*\|/gm, "| |")
    .replace(/^\s*(?:#{1,6}\s*|[-*]\s+)?(?:\*\*)?(?:\(\d{1,3}\)|\d{1,3}(?:[.):]|(?:\*\*)?\s*[-–—]))(?:\*\*)?(?=\s)/gm, "")
    .replace(/^\s*[-*]\s+\*\*\d{1,3}\*\*(?=\s)/gm, "")
    .replace(/\b(?:top|bottom|first|last)\s+\d{1,3}\b/gi, "");
  for (const match of protectedAnswer.matchAll(
    /(?<![\w#])(?:₹|Rs\.?|INR)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(Cr|crore|L|lakh|K|thousand|%)?(?![\w])/gi,
  )) {
    const raw = match[0].trim();
    const start = match.index ?? 0;
    const context = protectedAnswer.slice(Math.max(0, start - 16), start + raw.length + 16);
    const after = protectedAnswer.slice(start + raw.length);
    const isNumericDisplay = /₹|rs\.?|inr|%|[a-z]/i.test(raw) || /[,.]/.test(raw);
    if (/^\s*(?:st|nd|rd|th)\b/i.test(after) || (!isNumericDisplay && /^\s*\./.test(after))) continue;
    // Only an exact date/FY/ID token is metadata, never an arbitrary nearby number.
    if (/^(?:20\d{2}-\d{2}|20\d{2}[/-]\d{1,2}[/-]\d{1,2})$/.test(raw) ||
        /(?:^|\s)FY\s*20\d{2}-\d{2}(?:\s|$)/i.test(context) ||
        /(?:^|[\s(])[A-Za-z][A-Za-z_-]*#\d+(?:\s|$)/.test(context)) continue;
    const num = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(num)) continue;
    const suffix = (match[2] ?? "").toLowerCase();
    const normalized = normalizeToken(raw);
    const hasCurrency = /₹|rs\.?|inr/i.test(raw);
    const isInrSuffix = /^(cr|crore|l|lakh|k|thousand)$/i.test(suffix);
    const surroundingUnit = /\b(?:customers?|items?|retailers?|distributors?|heads?|members?|rows?|codes?|rupees?|rs\.?|inr|cr|crore|lakh|k|%)\b/i.test(context);
    if (/^\d{4}$/.test(match[1]!) && num >= 1900 && num <= 2100 &&
        !hasCurrency && !suffix && !surroundingUnit) continue;
    const token = normalized;
    const unit: keyof typeof approved = suffix === "%" ? "pct" : (hasCurrency || isInrSuffix ? "INR" : "count");
    if (!approved[unit].has(token)) {
      unmatched.push(raw);
    }
  }

  return unmatched.length === 0
    ? { status: "clean", unmatched: [] }
    : { status: "unmatched", unmatched };
}

// ── Helpers for content block handling (avoids SDK type complexity) ───────────

type AnyBlock = { type: string; [key: string]: unknown };

function blocksText(content: AnyBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b["text"] as string) ?? "")
    .join("\n")
    .trim();
}

function toolUseBlocks(content: AnyBlock[]): AnyBlock[] {
  return content.filter((b) => b.type === "tool_use");
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post("/analyze", async (req: Request, res: Response): Promise<void> => {
  const parsed = AnalyzeSalesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const question = parsed.data.question;
  const defaultFy = ((parsed.data as Record<string, unknown>)["fy"] as string | undefined) ?? currentOpenFy();

  try {
    // Build graph index (uses cached data — fast).
    const index     = await buildGraphIndex(defaultFy);
    const indexText = graphIndexToPromptText(index);
    const systemPrompt = buildSystemPrompt(indexText);

    // Use `any[]` for messages to avoid fighting the SDK's own union types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = [{ role: "user", content: question }];
    const allNodes: GraphNode[] = [];
    let totalTraversalErrors = 0;
    let totalToolCalls = 0;
    let finalAnswer = "";
    let round = 0;

    // Multi-round traversal loop.
    while (round < MAX_ROUNDS && !finalAnswer) {
      round++;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (anthropic.messages.create as any)({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: systemPrompt,
        tools: [RESOLVE_NODES_TOOL],
        messages,
      });

      const content: AnyBlock[] = Array.isArray(response.content) ? response.content : [];
      const toolCalls = toolUseBlocks(content);

      if (response.stop_reason === "end_turn" || toolCalls.length === 0) {
        finalAnswer = blocksText(content);
        break;
      }

      // Append assistant turn (full content block array).
      messages.push({ role: "assistant", content });

      // Resolve all tool calls in this round.
      const toolResults: unknown[] = [];

      for (const toolCall of toolCalls) {
        totalToolCalls++;
        if (totalToolCalls > MAX_TOOL_CALLS) {
          finalAnswer = "Traversal limit reached before a bounded answer could be assembled.";
          break;
        }
        if (toolCall["name"] !== "resolve_nodes") {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall["id"],
            content: JSON.stringify({ error: `Unknown tool: ${String(toolCall["name"])}` }),
          });
          continue;
        }

        const toolInput = (toolCall["input"] as Record<string, unknown>) ?? {};
        const paths  = (toolInput["paths"] as string[]) ?? [];
        const callFy = (toolInput["fy"] as string | undefined) ?? defaultFy;
        const result = await runResolveTool(paths, callFy);

        if (allNodes.length + result.nodes.length > MAX_TOTAL_TRAVERSAL_NODES) {
          result.nodes = result.nodes.slice(0, Math.max(0, MAX_TOTAL_TRAVERSAL_NODES - allNodes.length));
          result.truncated = true;
        }
        totalTraversalErrors += result.errors.length;
        if (totalTraversalErrors > MAX_TOTAL_TRAVERSAL_ERRORS) {
          result.errors = result.errors.slice(0, Math.max(0, MAX_TOTAL_TRAVERSAL_ERRORS - (totalTraversalErrors - result.errors.length)));
        }
        allNodes.push(...result.nodes);

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall["id"],
          content: JSON.stringify({
            nodes: result.nodes,
            errors: result.errors,
            truncated: result.truncated,
            truncationReason: result.truncated
              ? `Capped at ${MAX_NODES_PER_RESOLVE} nodes. Refine your paths.`
              : undefined,
          }),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    // If we hit MAX_ROUNDS with no final answer, force one.
    if (!finalAnswer) {
      messages.push({
        role: "user",
        content:
          "You have reached the maximum number of traversal rounds. " +
          "Please give your final answer now using only the nodes already fetched.",
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finalResp = await (anthropic.messages.create as any)({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      });

      const finalContent: AnyBlock[] = Array.isArray(finalResp.content) ? finalResp.content : [];
      finalAnswer = blocksText(finalContent);
    }

    // Numeric guard. One bounded rewrite is allowed so the caller receives a
    // useful safe answer when the first draft performs prohibited arithmetic.
    // The rewrite sees the same traversal and is guarded identically.
    let guard = runNumericGuard(finalAnswer, allNodes);
    if (guard.status === "unmatched" && guard.unmatched.length > 0) {
      messages.push({ role: "assistant", content: [{ type: "text", text: finalAnswer }] });
      messages.push({
        role: "user",
        content:
          "Your draft was rejected because it contains numeric claims that are not typed measures in the resolved nodes. " +
          `Unsupported displays: ${JSON.stringify(guard.unmatched.slice(0, 50))}. ` +
          "Rewrite the answer once. Remove every unsupported figure and every calculation. " +
          "You may still compare or rank approved measures already returned. " +
          "If the requested difference, ratio, projection, or total is not an approved typed measure, say that it is unavailable rather than calculating it. " +
          "Keep node-path citations and the Traversal section.",
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const retryResp = await (anthropic.messages.create as any)({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      });
      const retryContent: AnyBlock[] = Array.isArray(retryResp.content) ? retryResp.content : [];
      finalAnswer = blocksText(retryContent);
      guard = runNumericGuard(finalAnswer, allNodes);
    }
    // A model answer containing an unsupported figure must never reach the
    // caller. Warnings were explicitly rejected by Prompt 115 A7.
    if (guard.status === "unmatched" && guard.unmatched.length > 0) {
      res.status(422).json({
        error: "Numeric guard rejected the answer: one or more figures were not present in resolved graph nodes.",
        unmatched: guard.unmatched,
      });
      return;
    }

    const cleanAnswer = stripEmojis(finalAnswer);

    const data = AnalyzeSalesResponse.parse({
      answer: cleanAnswer || "I could not generate an answer for that question.",
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "analyst request failed");
    res.status(502).json({ error: "The analyst is temporarily unavailable. Please try again." });
  }
});

export default router;
