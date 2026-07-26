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

const router: IRouter = Router();

// ── GET /api/graph/index ──────────────────────────────────────────────────────

router.get("/graph/index", async (req: Request, res: Response): Promise<void> => {
  const fy     = String(req.query.fy     ?? "2026-27");
  const period = req.query.period ? String(req.query.period) : undefined;

  try {
    const index = await buildGraphIndex(fy, period);
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
