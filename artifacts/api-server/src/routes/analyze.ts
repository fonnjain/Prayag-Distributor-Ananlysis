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
import { AnalyzeSalesBody, AnalyzeSalesResponse } from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { buildGraphIndex, graphIndexToPromptText } from "../lib/mgmt/graph/graphIndex.js";
import { resolvePath, resolveWildcard } from "../lib/mgmt/graph/resolvers.js";
import { MAX_NODES_PER_RESOLVE } from "../lib/mgmt/graph/types.js";
import type { GraphNode } from "../lib/mgmt/graph/types.js";

const router: IRouter = Router();

const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{2122}\u{2139}\u{2328}\u{23E9}-\u{23FA}\u{24C2}\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]/gu;

function stripEmojis(text: string): string {
  return text.replace(EMOJI_PATTERN, "").replace(/[ \t]+\n/g, "\n").trim();
}

// Maximum traversal rounds before we force a final answer.
const MAX_ROUNDS = 5;

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

HOW TO USE THE GRAPH:
- Call resolve_nodes with a list of paths to fetch those nodes.
- Wildcards: "head/*/2026-27" returns all heads (hard cap: ${MAX_NODES_PER_RESOLVE} nodes per call).
- Make as many resolve_nodes calls as needed, but be targeted — fetch only what you need to answer the question.
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
    "gap/live-year-sku, head/*/2026-27 (wildcard). " +
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

  for (const rawPath of paths) {
    if (nodes.length >= MAX_NODES_PER_RESOLVE) { truncated = true; break; }

    if (rawPath.includes("/*")) {
      const { nodes: wNodes, errors: wErrors } = await resolveWildcard(rawPath, defaultFy);
      for (const n of wNodes) {
        if (nodes.length >= MAX_NODES_PER_RESOLVE) { truncated = true; break; }
        nodes.push(n);
      }
      errors.push(...wErrors);
    } else {
      const { node, error } = await resolvePath(rawPath, defaultFy);
      if (node)  nodes.push(node);
      if (error) errors.push({ path: rawPath, error });
    }
  }

  return { nodes, errors, truncated };
}

// ── Numeric guard ─────────────────────────────────────────────────────────────

// Recursively collect every finite number carried in a node's `detail` blob so
// figures cited from rich detail (push lists, gap segments, discounts) pass the
// guard just like measure values do.
function collectDetailNumbers(value: unknown, out: number[], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === "number") {
    if (isFinite(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectDetailNumbers(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectDetailNumbers(v, out, depth + 1);
    }
  }
}

function runNumericGuard(
  answer: string,
  nodes: GraphNode[],
): { status: "clean" | "unmatched"; unmatched: string[] } {
  const crPatterns = answer.matchAll(/[\d,]+\.?\d*\s*(?:Cr|Lakh|lakh|cr)\b/g);
  const unmatched: string[] = [];

  const detailNumbers: number[] = [];
  for (const n of nodes) {
    if (n.detail) collectDetailNumbers(n.detail, detailNumbers);
  }

  for (const match of crPatterns) {
    const raw = match[0].replace(/[,\s]/g, "");
    const numStr = raw.replace(/(?:Cr|Lakh|lakh|cr)/i, "");
    const num = parseFloat(numStr);
    if (!isFinite(num)) continue;

    const inRupees = raw.toLowerCase().includes("cr") ? num * 1e7 : num * 1e5;
    const close = (v: number) =>
      Math.abs(v - inRupees) / Math.max(Math.abs(inRupees), 1) < 0.02;
    // Allow 2% tolerance; match measure values first, then detail values.
    const found =
      nodes.some((n) =>
        n.measures.some((m) => m.value != null && m.unit === "INR" && close(m.value)),
      ) || detailNumbers.some(close);
    if (!found) unmatched.push(match[0]);
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
  const defaultFy = ((parsed.data as Record<string, unknown>)["fy"] as string | undefined) ?? "2026-27";

  try {
    // Build graph index (uses cached data — fast).
    const index     = await buildGraphIndex(defaultFy);
    const indexText = graphIndexToPromptText(index);
    const systemPrompt = buildSystemPrompt(indexText);

    // Use `any[]` for messages to avoid fighting the SDK's own union types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = [{ role: "user", content: question }];
    const allNodes: GraphNode[] = [];
    let finalAnswer = "";
    let round = 0;

    // Multi-round traversal loop.
    while (round < MAX_ROUNDS) {
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

    // Numeric guard.
    const guard = runNumericGuard(finalAnswer, allNodes);
    const guardNote =
      guard.status === "unmatched" && guard.unmatched.length > 0
        ? `\n\n> **Numeric guard**: ${guard.unmatched.length} figure(s) could not be verified against a graph node: ${guard.unmatched.join(", ")}. Treat with caution.`
        : "";

    const cleanAnswer = stripEmojis(finalAnswer + guardNote);

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
