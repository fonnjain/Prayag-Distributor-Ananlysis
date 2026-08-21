import { Router } from "express";
import { loadStateHeadAttributionConflicts } from "../lib/mgmt/stateHeadAttributionConflicts.js";

const router = Router();

/**
 * Authenticated, evidence-only State Head workbook attribution review.
 * Global route registration provides authentication and server-readiness gates.
 */
router.get("/org/attribution-conflicts", async (req, res) => {
  try {
    const report = await loadStateHeadAttributionConflicts();
    return res.json(report);
  } catch (err) {
    req.log.error({ err }, "state-head attribution conflict report failed");
    return res.status(503).json({
      error: "State Head attribution evidence is currently unavailable. Please retry shortly.",
    });
  }
});

export default router;