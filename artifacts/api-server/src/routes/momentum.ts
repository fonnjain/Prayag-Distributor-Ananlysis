// M1 — Momentum insights route. Rate + direction, seasonally adjusted / real,
// composed entirely from existing services (see lib/momentum/momentumInsights).
import { Router } from "express";
import { buildMomentumInsights } from "../lib/momentum/momentumInsights.js";
import { parseMonthsParam } from "../lib/periodMonths.js";
import { logger } from "../lib/logger.js";

const router = Router();
const FY = "2026-27";

router.get("/momentum/insights", async (req, res) => {
  try {
    const parsed = parseMonthsParam(req.query.months, FY);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const data = await buildMomentumInsights(FY, parsed.months ?? null);
    res.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A selection with no complete month is a client-side period problem.
    if (msg.startsWith("No complete month")) {
      res.status(400).json({ error: msg });
      return;
    }
    logger.error({ err: e }, "momentum/insights failed");
    res.status(500).json({ error: msg });
  }
});

export default router;
