/**
 * Phase A8-A — Metrics graph routes.
 *
 * GET  /api/graph/index?fy=&period=   → GraphIndex (shape only, no values)
 * POST /api/graph/resolve             → GraphNode[] for requested paths
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { buildGraphIndex } from "../lib/mgmt/graph/graphIndex.js";
import { resolvePath, resolveWildcard } from "../lib/mgmt/graph/resolvers.js";
import type { ResolveRequest, ResolveResponse } from "../lib/mgmt/graph/types.js";
import { MAX_NODES_PER_RESOLVE } from "../lib/mgmt/graph/types.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";

const router: IRouter = Router();

// Graph index shape is cheap to rebuild but its roster read hits Sheets on a
// cold start — snapshot-first keeps the Analyst panel instant after restarts.
// No frozen flag: counts come from live roster/dashboard caches.
const GRAPH_INDEX_TTL_MS = 15 * 60 * 1000;

// ── GET /api/graph/index ──────────────────────────────────────────────────────

router.get("/graph/index", async (req: Request, res: Response): Promise<void> => {
  const fy     = String(req.query.fy     ?? "2026-27");
  const period = req.query.period ? String(req.query.period) : undefined;

  try {
    // Snapshot only validated-FY, periodless requests (the Analyst page-load
    // variant); free-form period values stay live so the key space is bounded.
    const index =
      /^\d{4}-\d{2}$/.test(fy) && period === undefined
        ? await serveWithSnapshot({
            key: `graph-index|${fy}`,
            ttlMs: GRAPH_INDEX_TTL_MS,
            build: () => buildGraphIndex(fy, period) as Promise<Record<string, unknown>>,
            log: req.log,
          })
        : await buildGraphIndex(fy, period);
    res.json(index);
  } catch (err) {
    req.log.error({ err, fy }, "graph/index failed");
    res.status(500).json({ error: "Failed to build graph index" });
  }
});

// ── POST /api/graph/resolve ───────────────────────────────────────────────────

router.post("/graph/resolve", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<ResolveRequest>;
  const paths     = Array.isArray(body.paths) ? (body.paths as string[]) : [];
  const defaultFy = String(body.fy ?? "2026-27");

  if (paths.length === 0) {
    res.status(400).json({ error: "paths[] is required and must be non-empty" });
    return;
  }

  const allNodes: ResolveResponse["nodes"] = [];
  const allErrors: ResolveResponse["errors"] = [];
  let truncated = false;

  for (const rawPath of paths) {
    if (allNodes.length >= MAX_NODES_PER_RESOLVE) {
      truncated = true;
      break;
    }

    const isWildcard = rawPath.includes("/*");

    if (isWildcard) {
      const { nodes, errors } = await resolveWildcard(rawPath, defaultFy);
      for (const n of nodes) {
        if (allNodes.length >= MAX_NODES_PER_RESOLVE) { truncated = true; break; }
        allNodes.push(n);
      }
      allErrors.push(...errors);
    } else {
      const { node, error } = await resolvePath(rawPath, defaultFy);
      if (node)  allNodes.push(node);
      if (error) allErrors.push({ path: rawPath, error });
    }
  }

  const response: ResolveResponse = {
    nodes: allNodes,
    truncated,
    truncationReason: truncated
      ? `Result capped at ${MAX_NODES_PER_RESOLVE} nodes. Refine your paths to request fewer nodes per call.`
      : undefined,
    errors: allErrors,
  };

  res.json(response);
});

export default router;
