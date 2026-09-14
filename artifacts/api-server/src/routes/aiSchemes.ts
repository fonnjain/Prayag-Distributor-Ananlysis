import { Router } from "express";
import { GetAiSchemesAnalyticsQueryParams, GetAiSchemesAnalyticsResponse } from "@workspace/api-zod";
import { currentOpenFy } from "../lib/fyAnchors.js";
import { getAiSchemesAnalytics } from "../lib/aiSchemesAnalytics.js";

const router = Router();

router.get("/ai-schemes/analytics", async (req, res): Promise<void> => {
  const rawFy = Array.isArray(req.query.fy)
    ? req.query.fy.map(String).join(",")
    : typeof req.query.fy === "string" ? req.query.fy : undefined;
  const parsed = GetAiSchemesAnalyticsQueryParams.safeParse({ fy: rawFy });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const fys = parsed.data.fy?.split(",").map((fy) => fy.trim()).filter(Boolean) ?? [currentOpenFy()];
  try {
    const result = await getAiSchemesAnalytics(fys);
    res.json(GetAiSchemesAnalyticsResponse.parse(result));
  } catch (err) {
    req.log.error({ err, fys }, "ai-schemes analytics error");
    res.status(500).json({ error: "Failed to compute AI Schemes analytics" });
  }
});

export default router;