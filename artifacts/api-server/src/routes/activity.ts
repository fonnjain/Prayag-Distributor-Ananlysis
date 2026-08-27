import { Router } from "express";
import { requireAdmin, requireSameOrigin } from "../lib/auth.js";
import { activityReport, ingestActivity, validateActivityBatch, validateDateRange } from "../lib/activity/service.js";

const router = Router();

router.post("/activity/events", requireSameOrigin, async (req, res) => {
  // A cookie-authenticated session is deliberately stricter than the global gate.
  if (!req.authUser || !req.authSessionId || req.apiKey) return void res.status(401).json({ error: "Cookie session required" });
  try {
    const result = await ingestActivity(req.authUser.id, req.authSessionId, validateActivityBatch(req.body));
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid")) return void res.status(400).json({ error: err.message });
    req.log.error({ err }, "activity event ingestion failed");
    res.status(500).json({ error: "Unable to record activity" });
  }
});

router.get("/auth/activity", requireAdmin, async (req, res) => {
  try {
    const { from, to } = validateDateRange(req.query.from, req.query.to);
    const rawUserId = req.query.userId;
    const userId = rawUserId === undefined ? undefined : Number(rawUserId);
    if (rawUserId !== undefined && (!Number.isInteger(userId) || userId! <= 0)) return void res.status(400).json({ error: "Invalid userId" });
    res.json(await activityReport(from, to, userId));
  } catch (err) {
    if (err instanceof Error && (err.message.includes("YYYY-MM-DD") || err.message.includes("Date range"))) return void res.status(400).json({ error: err.message });
    req.log.error({ err }, "activity report failed");
    res.status(500).json({ error: "Unable to load activity" });
  }
});

export default router;