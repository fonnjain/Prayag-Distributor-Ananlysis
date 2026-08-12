// Scheme Nudge Engine routes.
import { currentOpenFy } from "../lib/fyAnchors.js";
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
//   Reference: all schemes and slabs from the DB (JSON retired).
import { Router } from "express";
import {
  computeNudgeList,
  buildCockpit,
  computeAnnualTracker,
  computeSuccessList,
  getQuarterMonths,
} from "../lib/schemes/nudge.js";
import { getBlockedCustomers } from "../lib/schemes/dues.js";
import { pool } from "@workspace/db";
import { getCompleteMonths } from "../lib/customers/analytics.js";

const router = Router();

// Returns the last quarter for which ALL three months appear in completeMonths.
// Data-driven: stable across day boundaries, never uses wall-clock date.
function lastCompleteQuarter(
  fy: string,
  completeMonths: string[]
): "Q1" | "Q2" | "Q3" | "Q4" {
  const [yr] = fy.split("-").map(Number);
  const s = String(yr).slice(-2);
  const e = String(yr + 1).slice(-2);
  const quarters: ["Q1" | "Q2" | "Q3" | "Q4", string[]][] = [
    ["Q1", [`Apr-${s}`, `May-${s}`, `Jun-${s}`]],
    ["Q2", [`Jul-${s}`, `Aug-${s}`, `Sep-${s}`]],
    ["Q3", [`Oct-${s}`, `Nov-${s}`, `Dec-${s}`]],
    ["Q4", [`Jan-${e}`, `Feb-${e}`, `Mar-${e}`]],
  ];
  const set = new Set(completeMonths);
  let last: "Q1" | "Q2" | "Q3" | "Q4" = "Q1";
  for (const [q, months] of quarters) {
    if (months.every((m) => set.has(m))) last = q;
  }
  return last;
}

// Resolves the quarter parameter. When q is explicit, uses it directly.
// When absent, derives from the last fully-complete quarter in the data —
// never from the wall clock.
async function resolveQ(
  raw: unknown,
  fy: string
): Promise<"Q1" | "Q2" | "Q3" | "Q4"> {
  if (raw === "Q1" || raw === "Q2" || raw === "Q3" || raw === "Q4") return raw;
  const complete = await getCompleteMonths(fy);
  return lastCompleteQuarter(fy, complete);
}

// ── Nudge list ────────────────────────────────────────────────────────────────

router.get("/schemes/nudge", async (req, res) => {
  const fy = String(req.query.fy ?? currentOpenFy());
  const q = await resolveQ(req.query.q, fy);
  const roiThreshold = parseFloat(String(req.query.roi ?? "0.05")) || 0.05;
  const head = String(req.query.head ?? "");

  try {
    const dues = await getBlockedCustomers();
    const result = await computeNudgeList(fy, q, dues.blocked, dues.available, roiThreshold, head);
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
  const fy = String(req.query.fy ?? currentOpenFy());
  const q = await resolveQ(req.query.q, fy);
  const head = String(req.query.head ?? "");

  try {
    const dues = await getBlockedCustomers();
    const nudgeResult = await computeNudgeList(fy, q, dues.blocked, dues.available, undefined, head);
    const cockpit = buildCockpit(nudgeResult);
    res.json(cockpit);
  } catch (err) {
    req.log.error({ err }, "schemes/cockpit error");
    res.status(500).json({ error: "Failed to compute cockpit" });
  }
});

// ── Annual tracker ────────────────────────────────────────────────────────────

router.get("/schemes/annual", async (req, res) => {
  const fy = String(req.query.fy ?? currentOpenFy());

  try {
    const completeMonths = await getCompleteMonths(fy);
    const rows = await computeAnnualTracker(fy, completeMonths);
    res.json({ fy, completeMonths, rows });
  } catch (err) {
    req.log.error({ err }, "schemes/annual error");
    res.status(500).json({ error: "Failed to compute annual tracker" });
  }
});

// ── Success list ──────────────────────────────────────────────────────────────
//
// GET /api/schemes/success?fy=2026-27&q=Q2&head=&family=
//   Distributors who have already crossed at least one slab this quarter,
//   ranked by earned ₹. Includes settlement breakdown (company / pass_through / primary).

router.get("/schemes/success", async (req, res) => {
  const fy = String(req.query.fy ?? currentOpenFy());
  const q = await resolveQ(req.query.q, fy);
  const head = String(req.query.head ?? "");

  try {
    const result = await computeSuccessList(fy, q, head);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "schemes/success error");
    res.status(500).json({ error: "Failed to compute success list" });
  }
});

// ── Scheme master (reference) — reads from DB ─────────────────────────────────

router.get("/schemes/master", async (_req, res) => {
  try {
    const [schemesRes, slabsRes, territoryRes, itemGroupRes, specialRes] = await Promise.all([
      pool.query(`SELECT * FROM scheme ORDER BY scheme_id`),
      pool.query(`SELECT * FROM scheme_reward_slab ORDER BY scheme_id, slab_order`),
      pool.query(`SELECT * FROM territory_group ORDER BY group_raw`),
      pool.query(`SELECT * FROM scheme_item_group ORDER BY item_group, scheme_id`),
      pool.query(`SELECT * FROM special_pricing ORDER BY customer_name`),
    ]);
    res.json({
      schemes: schemesRes.rows,
      slabs: slabsRes.rows,
      territoryGroups: territoryRes.rows,
      itemGroups: itemGroupRes.rows,
      specialPricing: specialRes.rows,
      _source: "database",
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load scheme master from DB" });
  }
});

export default router;
