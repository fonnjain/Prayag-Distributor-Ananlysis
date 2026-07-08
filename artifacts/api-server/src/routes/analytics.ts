import { Router, type IRouter, type Request, type Response } from "express";
import { buildAnalytics, priorFy } from "../lib/analytics/analytics.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const DEFAULT_FY = "2026-27";

router.get(
  "/analytics",
  async (req: Request, res: Response): Promise<void> => {
    const fyRaw = req.query["fy"];
    const fy =
      typeof fyRaw === "string" && fyRaw.trim() !== "" ? fyRaw.trim() : DEFAULT_FY;
    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "fy must look like 2026-27" });
      return;
    }
    const compareRaw = req.query["compare"];
    const compareFy =
      typeof compareRaw === "string" && compareRaw.trim() !== ""
        ? compareRaw.trim()
        : priorFy(fy);
    if (!FY_PATTERN.test(compareFy)) {
      res.status(400).json({ error: "compare must look like 2025-26" });
      return;
    }
    try {
      const report = await buildAnalytics(fy, compareFy);
      res.json(report);
    } catch (err) {
      req.log.error({ err, fy, compareFy }, "analytics build failed");
      res.status(500).json({ error: "Could not compute analytics." });
    }
  },
);

export default router;
