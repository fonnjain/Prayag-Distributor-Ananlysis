import { Router, type IRouter, type Request, type Response } from "express";
import { GetOverviewPerformanceQueryParams, GetOverviewPerformanceResponse } from "@workspace/api-zod";
import { buildOverviewPerformance } from "../lib/overviewPerformance.js";

const router: IRouter = Router();

router.get(
  "/overview/performance",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = GetOverviewPerformanceQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const report = await buildOverviewPerformance(parsed.data.fy);
      res.json(GetOverviewPerformanceResponse.parse(report));
    } catch (err) {
      req.log.error({ err, fy: parsed.data.fy }, "overview performance build failed");
      res.status(500).json({ error: "Could not compute overview performance." });
    }
  },
);

export default router;