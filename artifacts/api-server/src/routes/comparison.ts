// ── C1 — POST /api/comparison ────────────────────────────────────────────────
// Contract layer only: selection schema in, basis block + guard report +
// value matrix out. Blocked comparisons return 422 with the reason.
// No rendering, no charts, no suggestions — those are C2 to C4.

import { Router, type Request, type Response } from "express";
import { runComparison, ComparisonError, CATALOGUE_SUMMARY } from "../lib/comparison/comparison.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/comparison/catalogue", (_req: Request, res: Response): void => {
  res.json(CATALOGUE_SUMMARY());
});

router.post("/comparison", async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await runComparison(req.body ?? {});
    if (result.blocked) {
      res.status(422).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    if (err instanceof ComparisonError) {
      res.status(err.status).json({ error: err.message, detail: err.detail ?? null });
      return;
    }
    logger.error({ err }, "comparison failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
