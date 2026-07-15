import { Router, type Request, type Response } from "express";
import {
  loadPrimaryTargetEntries,
  savePrimaryTargetEntries,
  loadPrimaryRoster,
  expandToMonthly,
  type PrimaryTargetRow,
  type Cadence,
} from "../lib/mgmt/primaryTargets.js";
import { invalidateMgmtDataCache } from "./mgmt.js";

const router = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const VALID_ROLES = new Set(["state_head", "team_member"]);
const VALID_CADENCES = new Set(["annual", "half_yearly", "quarterly", "monthly"]);
const CADENCE_LENGTHS: Record<string, number> = {
  annual: 1,
  half_yearly: 2,
  quarterly: 4,
  monthly: 12,
};

// GET /primary-targets?fy=2026-27
// Returns the roster (state heads + primary team members) for the FY plus any
// saved primary target entries from the database.
router.get("/primary-targets", async (req: Request, res: Response): Promise<void> => {
  const fy =
    typeof req.query.fy === "string" && req.query.fy.trim()
      ? req.query.fy.trim()
      : "2026-27";
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }
  try {
    const [roster, entries] = await Promise.all([
      loadPrimaryRoster(fy),
      loadPrimaryTargetEntries(fy),
    ]);

    // Attach precomputed monthly expansion to each entry so the frontend can
    // display period breakdowns without needing the seasonal weights.
    const entriesWithMonthly = entries.map((e) => ({
      ...e,
      monthlyExpanded: expandToMonthly(e.cadence, e.values),
    }));

    res.json({
      fy,
      stateHeads: roster.stateHeads,
      teamMembers: roster.teamMembers,
      entries: entriesWithMonthly,
    });
  } catch (err) {
    req.log.error({ err, fy }, "primary-targets GET failed");
    res.status(500).json({ error: "Could not load primary target entries." });
  }
});

// POST /primary-targets
// Upserts primary target rows into the database (keyed by fy + name).
// Body: { fy, rows: [{ name, role, cadence, values }] }
router.post("/primary-targets", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fy = typeof body.fy === "string" ? body.fy.trim() : "";
  if (!FY_PATTERN.test(fy)) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    res.status(400).json({ error: "rows must be a non-empty array" });
    return;
  }

  const rows: PrimaryTargetRow[] = [];
  for (let i = 0; i < body.rows.length; i++) {
    const r = body.rows[i] as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const role = typeof r.role === "string" ? r.role.trim() : "";
    const cadence = typeof r.cadence === "string" ? r.cadence.trim() : "";

    if (!name) {
      res.status(400).json({ error: `rows[${i}].name is required` });
      return;
    }
    if (!VALID_ROLES.has(role)) {
      res.status(400).json({ error: `rows[${i}].role must be state_head or team_member` });
      return;
    }
    if (!VALID_CADENCES.has(cadence)) {
      res.status(400).json({
        error: `rows[${i}].cadence must be annual, half_yearly, quarterly, or monthly`,
      });
      return;
    }

    const expectedLen = CADENCE_LENGTHS[cadence];
    if (!Array.isArray(r.values) || r.values.length !== expectedLen) {
      res.status(400).json({
        error: `rows[${i}].values must have exactly ${expectedLen} element(s) for cadence "${cadence}"`,
      });
      return;
    }

    const values = (r.values as unknown[]).map((v) => {
      const n = typeof v === "number" ? v : parseFloat(String(v));
      return Number.isFinite(n) ? n : 0;
    });

    rows.push({
      name,
      role: role as "state_head" | "team_member",
      cadence: cadence as Cadence,
      values,
    });
  }

  try {
    const saved = await savePrimaryTargetEntries(fy, rows);
    // Invalidate the mgmt/data response cache so the updated primary targets
    // flow through immediately on the next request.
    invalidateMgmtDataCache(fy);
    req.log.info({ fy, saved }, "primary-targets saved");
    res.json({ saved });
  } catch (err) {
    req.log.error({ err, fy }, "primary-targets POST failed");
    res.status(500).json({ error: "Could not save primary target entries." });
  }
});

export default router;
