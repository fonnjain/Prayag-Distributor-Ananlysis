import { Router } from "express";
import { isAdminToken } from "../lib/adminAuth.js";
import {
  listSeasonalCurves,
  rebuildSeasonalCurve,
} from "../lib/seasonal.js";
import { logger } from "../lib/logger.js";

const router = Router();

function hasAdminSecret(value: string | undefined): boolean {
  return isAdminToken(value ?? "");
}

/**
 * Version history is deliberately operator-only. It exposes the same retained
 * source rows/nets and deltas used to answer why a future projection changed.
 */
router.get("/admin/seasonal-curve", async (req, res) => {
  if (!hasAdminSecret(req.header("X-Admin-Secret"))) {
    res.status(401).json({ error: "valid X-Admin-Secret is required" });
    return;
  }
  try {
    res.json({ versions: await listSeasonalCurves() });
  } catch (error) {
    logger.error({ err: error }, "seasonal curve history read failed");
    res.status(500).json({ error: "could not read seasonal curve history" });
  }
});

/**
 * A manual rebuild is auditable by design: the active row is retired, a new
 * version is inserted, and the frozen sales source is read-only throughout.
 */
router.post("/admin/seasonal-curve/rebuild", async (req, res) => {
  if (!hasAdminSecret(req.header("X-Admin-Secret"))) {
    res.status(401).json({ error: "valid X-Admin-Secret is required" });
    return;
  }
  try {
    const result = await rebuildSeasonalCurve({ builtFrom: "manual", force: true });
    res.status(201).json(result);
  } catch (error) {
    logger.error({ err: error }, "manual seasonal curve rebuild failed");
    res.status(500).json({
      error: error instanceof Error ? error.message : "seasonal curve rebuild failed",
    });
  }
});

export default router;