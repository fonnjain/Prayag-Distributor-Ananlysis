// Targets tab: read roster + saved targets, preview pro-rata splits, and
// upsert rows into the Target Master sheet (the app's only Sheets write path).
import { Router, type IRouter, type Request, type Response } from "express";
import { loadRoster } from "../lib/mgmt/roster.js";
import { normName } from "../lib/mgmt/names.js";
import {
  TARGET_FIELDS,
  type FieldValues,
  type FieldMonthly,
  type TargetRow,
  loadTargetsForFy,
  priorYearActuals,
  activeMembers,
  computeSplit,
  balanceSplit,
  validateRow,
  upsertTargets,
} from "../lib/mgmt/targets.js";

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

function parseFieldValues(v: unknown): FieldValues {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    primary: numOrNull(o.primary),
    secondary: numOrNull(o.secondary),
    directDealer: numOrNull(o.directDealer),
    businessPlan: numOrNull(o.businessPlan),
  };
}

function parseFieldMonthly(v: unknown): FieldMonthly {
  const o = (v ?? {}) as Record<string, unknown>;
  const arr = (raw: unknown): Array<number | null> => {
    const src = Array.isArray(raw) ? raw : [];
    const out: Array<number | null> = [];
    for (let i = 0; i < 12; i++) out.push(numOrNull(src[i]));
    return out;
  };
  return {
    primary: arr(o.primary),
    secondary: arr(o.secondary),
    directDealer: arr(o.directDealer),
    businessPlan: arr(o.businessPlan),
  };
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

router.post("/targets", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fy = parseFy(body.fy);
  if (!fy) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (rawRows.length === 0) {
    res.status(400).json({ error: "rows must be a non-empty array" });
    return;
  }
  if (rawRows.length > 300) {
    res.status(400).json({ error: "Too many rows in one save" });
    return;
  }
  try {
    const roster = await loadRoster();
    const members = activeMembers(roster.members);
    const byKey = new Map(members.map((m) => [m.normKey, m]));
    const now = new Date().toISOString();
    const updatedBy =
      typeof body.updatedBy === "string" && body.updatedBy.trim() !== ""
        ? body.updatedBy.trim().slice(0, 80)
        : "app";

    const rows: TargetRow[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawRows) {
      const o = (raw ?? {}) as Record<string, unknown>;
      const teamMember = typeof o.teamMember === "string" ? o.teamMember.trim() : "";
      if (!teamMember) {
        errors.push("A row is missing teamMember");
        continue;
      }
      const key = normName(teamMember);
      if (seen.has(key)) {
        errors.push(`"${teamMember}" appears more than once`);
        continue;
      }
      seen.add(key);
      const member = byKey.get(key);
      const level =
        typeof o.level === "string" && o.level.toUpperCase() === "STATE_HEAD"
          ? "STATE_HEAD"
          : "TM";
      const row: TargetRow = {
        fy,
        teamMember: member?.name ?? teamMember,
        stateHead: member?.stateHead ?? "",
        level,
        annual: parseFieldValues(o.annual),
        monthly: parseFieldMonthly(o.monthly),
        updatedBy,
        updatedAt: now,
      };
      errors.push(...validateRow(row, new Set(byKey.keys())));
      rows.push(row);
    }
    if (errors.length > 0) {
      res.status(422).json({ error: errors.slice(0, 10).join("; ") });
      return;
    }
    const result = await upsertTargets(rows);
    req.log.info(
      { fy, updated: result.updated, appended: result.appended },
      "targets saved",
    );
    res.json({ fy, updated: result.updated, appended: result.appended });
  } catch (err) {
    req.log.error({ err, fy }, "targets save failed");
    res.status(500).json({ error: "Could not save targets. Try again in a minute." });
  }
});

export default router;
