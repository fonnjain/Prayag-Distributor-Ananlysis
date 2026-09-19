import { Router } from "express";
import {
  GenerateAiSchemesHistoryBody,
  GenerateAiSchemesHistoryResponse,
  GetAiSchemesAnalyticsQueryParams,
  GetAiSchemesAnalyticsResponse,
  GetAiSchemesHistoryQueryParams,
  GetAiSchemesHistoryResponse,
} from "@workspace/api-zod";
import { currentOpenFy } from "../lib/fyAnchors.js";
import { getAiSchemesAnalytics } from "../lib/aiSchemesAnalytics.js";
import { SecondarySourceSeamError } from "../lib/secondary/sourceContract.js";
import {
  generateAiSchemesHistoryProposal,
  readAiSchemesHistory,
} from "../lib/aiSchemesHistory.js";

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
    if (err instanceof SecondarySourceSeamError) {
      res.status(409).json({
        error: err.message,
        code: err.code,
        comparability: "unprovable_from_crm",
      });
      return;
    }
    res.status(500).json({ error: "Failed to compute AI Schemes analytics" });
  }
});

router.get("/ai-schemes/history", async (req, res): Promise<void> => {
  const parsed = GetAiSchemesHistoryQueryParams.safeParse({
    itemGroup: typeof req.query.itemGroup === "string" ? req.query.itemGroup : undefined,
    skuBand: typeof req.query.skuBand === "string" ? req.query.skuBand : undefined,
    territory: typeof req.query.territory === "string" ? req.query.territory : undefined,
    year: typeof req.query.year === "string" ? req.query.year : undefined,
    fy: typeof req.query.fy === "string" ? req.query.fy : undefined,
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await readAiSchemesHistory(parsed.data);
    res.json(GetAiSchemesHistoryResponse.parse(result));
  } catch (err) {
    req.log.error({ err }, "ai-schemes history error");
    res.status(500).json({ error: "Failed to compute AI Schemes historical basis" });
  }
});

router.post("/ai-schemes/history/generate", async (req, res): Promise<void> => {
  const parsed = GenerateAiSchemesHistoryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await generateAiSchemesHistoryProposal(parsed.data);
    res.json(GenerateAiSchemesHistoryResponse.parse(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid historical-basis proposal";
    if (/required|provide|held|unknown|no observed precedent/i.test(message)) {
      res.status(400).json({ error: message });
      return;
    }
    req.log.error({ err }, "ai-schemes history proposal error");
    res.status(500).json({ error: "Failed to generate historical-basis proposal" });
  }
});

export default router;