// ── T1 — Engine-Generated Targets routes ────────────────────────────────────
//
// GET  /api/target-engine            — full engine result (proposals + overlays)
//        ?fy=2026-27                 — target FY (default: derived from today)
//        ?today=2027-04-01           — simulate a date; baseline advances with it
// POST /api/target-engine/params     — save user parameters { fy, params }
// POST /api/target-engine/override   — save one user edit { fy, rowKey, value }
// POST /api/target-engine/override/clear — revert one edit { fy, rowKey }
//
// The engine is a generator: proposals are recomputed on every GET, and ONLY
// user edits persist (engine_targets). Regeneration cannot overwrite them.

import { Router, type Request, type Response } from "express";
import {
  computeEngineTargets,
  saveOverride,
  deleteOverride,
  loadOverrides,
  fyForDate,
} from "../lib/mgmt/targetEngine.js";
import { computeSecondaryEngineTargets } from "../lib/mgmt/targetEngineSecondary.js";
import { logger } from "../lib/logger.js";

const router = Router();

// T2 — person-level targets on the SECONDARY basis (salespeople + heads).
// GET /api/target-engine/people?fy=2026-27&scaleTo=<rupees>&today=<date>
router.get("/target-engine/people", async (req: Request, res: Response): Promise<void> => {
  try {
    const todayRaw = typeof req.query.today === "string" ? req.query.today.trim() : "";
    let today: Date | undefined;
    if (todayRaw) {
      const d = new Date(todayRaw);
      if (isNaN(d.getTime())) {
        res.status(400).json({ error: `Invalid today= date: ${todayRaw}` });
        return;
      }
      today = d;
    }
    const fy = typeof req.query.fy === "string" && req.query.fy.trim() ? req.query.fy.trim() : undefined;
    let scaleTo: number | null = null;
    if (typeof req.query.scaleTo === "string" && req.query.scaleTo.trim()) {
      scaleTo = Number(req.query.scaleTo);
      if (!isFinite(scaleTo) || scaleTo <= 0) {
        res.status(400).json({ error: `Invalid scaleTo= value: ${req.query.scaleTo}` });
        return;
      }
    }
    const result = await computeSecondaryEngineTargets({ fy, today, scaleTo });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "target-engine/people failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/target-engine", async (req: Request, res: Response): Promise<void> => {
  try {
    const todayRaw = typeof req.query.today === "string" ? req.query.today.trim() : "";
    let today: Date | undefined;
    if (todayRaw) {
      const d = new Date(todayRaw);
      if (isNaN(d.getTime())) {
        res.status(400).json({ error: `Invalid today= date: ${todayRaw}` });
        return;
      }
      today = d;
    }
    const fy =
      typeof req.query.fy === "string" && req.query.fy.trim()
        ? req.query.fy.trim()
        : fyForDate(today ?? new Date());
    const result = await computeEngineTargets({ fy, today });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "target-engine GET failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/target-engine/params", async (req: Request, res: Response): Promise<void> => {
  try {
    const { fy, params } = req.body ?? {};
    if (typeof fy !== "string" || !fy.trim() || typeof params !== "object" || params == null) {
      res.status(400).json({ error: "fy and params are required" });
      return;
    }
    const w = params.weights;
    if (w != null) {
      const sum = Number(w.oldSku) + Number(w.newSku) + Number(w.newCustomers);
      if (!Number.isFinite(sum) || Math.abs(sum - 100) > 0.01) {
        res.status(400).json({ error: "weights must sum to 100" });
        return;
      }
    }
    if (params.increasePct != null && !(Number(params.increasePct) >= 0)) {
      res.status(400).json({ error: "increasePct must be a non-negative number" });
      return;
    }
    await saveOverride(fy.trim(), "params", params, null, "targets-ui");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "target-engine params save failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/target-engine/override", async (req: Request, res: Response): Promise<void> => {
  try {
    const { fy, rowKey, value, engineValue } = req.body ?? {};
    if (typeof fy !== "string" || !fy.trim() || typeof rowKey !== "string" || !rowKey.trim()) {
      res.status(400).json({ error: "fy and rowKey are required" });
      return;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      res.status(400).json({ error: "value must be a non-negative number" });
      return;
    }
    await saveOverride(fy.trim(), rowKey.trim(), value, engineValue ?? null, "targets-ui");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "target-engine override save failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post(
  "/target-engine/override/clear",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { fy, rowKey } = req.body ?? {};
      if (typeof fy !== "string" || !fy.trim() || typeof rowKey !== "string" || !rowKey.trim()) {
        res.status(400).json({ error: "fy and rowKey are required" });
        return;
      }
      await deleteOverride(fy.trim(), rowKey.trim());
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "target-engine override clear failed");
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

router.get(
  "/target-engine/overrides",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const fy =
        typeof req.query.fy === "string" && req.query.fy.trim()
          ? req.query.fy.trim()
          : fyForDate(new Date());
      const map = await loadOverrides(fy);
      res.json({ fy, overrides: [...map.values()] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

export default router;
