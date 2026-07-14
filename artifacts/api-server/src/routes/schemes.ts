// Scheme Nudge Engine routes.
//
// GET /api/schemes/nudge?fy=2026-27&q=Q2&roi=0.05
//   Full nudge list — ranked by what the distributor earns.
//
// GET /api/schemes/cockpit?fy=2026-27&q=Q2
//   Management summary: total live opportunity, scheme cost, days to deadline.
//
// GET /api/schemes/annual?fy=2026-27
//   Annual tracker: progress toward annual slab + anti-decline projection.
//
// GET /api/schemes/master
//   Reference: all schemes and slabs from the master config.
import { Router } from "express";
import {
  computeNudgeList,
  buildCockpit,
  computeAnnualTracker,
  getCurrentQuarter,
  getQuarterMonths,
} from "../lib/schemes/nudge.js";
import { getBlockedCustomers } from "../lib/schemes/dues.js";
import schemeMaster from "../../config/scheme_master.json";
import { getCompleteMonths } from "../lib/customers/analytics.js";

const router = Router();

function parseQ(raw: unknown): "Q1" | "Q2" | "Q3" | "Q4" {
  if (raw === "Q1" || raw === "Q2" || raw === "Q3" || raw === "Q4") return raw;
  return getCurrentQuarter("2026-27");
}

// ── Nudge list ────────────────────────────────────────────────────────────────

router.get("/schemes/nudge", async (req, res) => {
  const fy = String(req.query.fy ?? "2026-27");
  const q = parseQ(req.query.q);
  const roiThreshold = parseFloat(String(req.query.roi ?? "0.05")) || 0.05;

  try {
    const dues = await getBlockedCustomers();
    const result = await computeNudgeList(fy, q, dues.blocked, dues.available, roiThreshold);
    res.json({
      ...result,
      duesError: dues.error ?? null,
      duesFetchedAt: dues.fetchedAt,
    });
  } catch (err) {
    req.log.error({ err }, "schemes/nudge error");
    res.status(500).json({ error: "Failed to compute nudge list" });
  }
});

// ── Cockpit ───────────────────────────────────────────────────────────────────

router.get("/schemes/cockpit", async (req, res) => {
  const fy = String(req.query.fy ?? "2026-27");
  const q = parseQ(req.query.q);

  try {
    const dues = await getBlockedCustomers();
    const nudgeResult = await computeNudgeList(fy, q, dues.blocked, dues.available);
    const cockpit = buildCockpit(nudgeResult);
    res.json(cockpit);
  } catch (err) {
    req.log.error({ err }, "schemes/cockpit error");
    res.status(500).json({ error: "Failed to compute cockpit" });
  }
});

// ── Annual tracker ────────────────────────────────────────────────────────────

router.get("/schemes/annual", async (req, res) => {
  const fy = String(req.query.fy ?? "2026-27");

  try {
    const completeMonths = await getCompleteMonths(fy);
    const rows = await computeAnnualTracker(fy, completeMonths);
    res.json({ fy, completeMonths, rows });
  } catch (err) {
    req.log.error({ err }, "schemes/annual error");
    res.status(500).json({ error: "Failed to compute annual tracker" });
  }
});

// ── Scheme master (reference) ─────────────────────────────────────────────────

router.get("/schemes/master", (_req, res) => {
  res.json(schemeMaster);
});

export default router;
