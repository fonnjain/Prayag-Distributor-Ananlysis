// Targets tab: read roster + saved targets, preview pro-rata splits.
// Google Sheets access is strictly read-only. The POST /targets upsert
// endpoint has been removed — the Target Master sheet is read-only like
// every other sheet in the pipeline.
import { Router, type IRouter, type Request, type Response } from "express";
import { loadRoster } from "../lib/mgmt/roster.js";
import { normName } from "../lib/mgmt/names.js";
import {
  TARGET_FIELDS,
  type FieldValues,
  loadTargetsForFy,
  priorYearActuals,
  activeMembers,
  computeSplit,
  balanceSplit,
} from "../lib/mgmt/targets.js";
import { getCachedStateDashboard, loadStateDashboard } from "../lib/mgmt/stateDashboard.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;
const DEFAULT_FY = "2026-27";

function parseFy(v: unknown): string | null {
  const fy = typeof v === "string" && v.trim() !== "" ? v.trim() : DEFAULT_FY;
  return FY_PATTERN.test(fy) ? fy : null;
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

router.get("/targets", async (req: Request, res: Response): Promise<void> => {
  const fy = parseFy(req.query.fy);
  if (!fy) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }
  const stateHead =
    typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : "";
  try {
    const roster = await loadRoster();
    const members = activeMembers(roster.members);
    const stateHeads = [...new Set(members.map((m) => m.stateHead).filter(Boolean))].sort();
    const [saved, priors] = await Promise.all([
      loadTargetsForFy(fy),
      priorYearActuals(fy),
    ]);

    const secDash = getCachedStateDashboard(fy);
    if (!secDash) {
      void loadStateDashboard(fy).catch(() => {});
    }

    const secPlanByKey = new Map<string, (number | null)[]>();
    if (secDash) {
      for (const m of secDash.members) {
        if (!secPlanByKey.has(m.joinKey)) {
          secPlanByKey.set(m.joinKey, m.months.map((mo) => mo.planAmount));
        }
      }
    }

    const scoped = stateHead
      ? members.filter((m) => normName(m.stateHead) === normName(stateHead))
      : members;
    const rows = scoped.map((m) => {
      const s = saved.get(m.normKey) ?? null;
      return {
        name: m.name,
        stateHead: m.stateHead,
        state: m.state,
        headquarter: m.headquarter,
        priorYearActual: priors.get(m.normKey) ?? 0,
        saved: s
          ? {
              level: s.level,
              annual: s.annual,
              monthly: s.monthly,
              updatedBy: s.updatedBy,
              updatedAt: s.updatedAt,
            }
          : null,
        secMonthlyPlan: secPlanByKey.get(m.normKey) ?? null,
      };
    });
    res.json({ fy, stateHeads, members: rows });
  } catch (err) {
    req.log.error({ err, fy }, "targets load failed");
    res.status(500).json({ error: "Could not load targets. Try again in a minute." });
  }
});

router.get(
  "/targets/split-preview",
  async (req: Request, res: Response): Promise<void> => {
    const fy = parseFy(req.query.fy);
    if (!fy) {
      res.status(400).json({ error: "fy must look like 2026-27" });
      return;
    }
    const stateHead =
      typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : "";
    if (!stateHead) {
      res.status(400).json({ error: "stateHead is required" });
      return;
    }
    const totals: FieldValues = {
      primary: numOrNull(req.query.primary),
      secondary: numOrNull(req.query.secondary),
      directDealer: numOrNull(req.query.directDealer),
      businessPlan: numOrNull(req.query.businessPlan),
    };
    for (const f of TARGET_FIELDS) {
      const v = totals[f];
      if (v != null && v < 0) {
        res.status(400).json({ error: "Totals must be numbers >= 0" });
        return;
      }
    }
    try {
      const roster = await loadRoster();
      const members = activeMembers(roster.members).filter(
        (m) => normName(m.stateHead) === normName(stateHead),
      );
      if (members.length === 0) {
        res.status(422).json({ error: `No active team members found for "${stateHead}"` });
        return;
      }
      const priors = await priorYearActuals(fy);
      const input = members.map((m) => ({
        name: m.name,
        priorYearActual: priors.get(m.normKey) ?? 0,
      }));
      const split = computeSplit(input, totals);
      balanceSplit(split, totals);
      res.json({
        fy,
        stateHead,
        members: split.map((s, i) => ({
          name: s.name,
          priorYearActual: input[i].priorYearActual,
          allocated: s.allocated,
        })),
      });
    } catch (err) {
      req.log.error({ err, fy, stateHead }, "split preview failed");
      res.status(500).json({ error: "Could not compute the split. Try again in a minute." });
    }
  },
);

// POST /targets is not available. Google Sheets access is read-only.
router.post("/targets", (_req: Request, res: Response): void => {
  res.status(405).json({
    error: "Sheets access is read-only. Writing targets to Google Sheets is not permitted.",
  });
});

export default router;
