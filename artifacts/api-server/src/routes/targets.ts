// Targets tab: read roster + saved targets, preview pro-rata splits, and
// save member targets. Google Sheets stays strictly read-only — saves land
// in the member_targets database table, which overlays the (frozen) Target
// Master sheet per member.
import { Router, type IRouter, type Request, type Response } from "express";
import { loadRoster } from "../lib/mgmt/roster.js";
import { normName } from "../lib/mgmt/names.js";
import {
  TARGET_FIELDS,
  type FieldValues,
  type FieldMonthly,
  loadTargetsForFy,
  priorYearActuals,
  activeMembers,
  computeSplit,
  balanceSplit,
  validateRow,
} from "../lib/mgmt/targets.js";
import { upsertMemberTargets } from "../lib/mgmt/memberTargetsStore.js";
import { invalidateMgmtDataCache } from "./mgmt.js";
import { getCachedStateDashboard, loadStateDashboard } from "../lib/mgmt/stateDashboard.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";
import { isFrozen } from "../lib/customers/registerSync.js";

const router: IRouter = Router();

const TARGETS_SNAPSHOT_TTL_MS = 15 * 60 * 1000;

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
  const build = async (): Promise<Record<string, unknown>> => {
    const roster = await loadRoster();
    const members = activeMembers(roster.members);
    const stateHeads = [...new Set(members.map((m) => m.stateHead).filter(Boolean))].sort();
    const [saved, priors] = await Promise.all([
      loadTargetsForFy(fy),
      priorYearActuals(fy),
    ]);

    let secDash = getCachedStateDashboard(fy);
    if (!secDash) {
      if (isFrozen(fy)) {
        // Frozen FY: the snapshot may be served as final, so it must not be
        // persisted with missing secondary plans — block on the load once.
        secDash = await loadStateDashboard(fy).catch(() => null);
      } else {
        void loadStateDashboard(fy).catch(() => {});
      }
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
    return { fy, stateHeads, members: rows };
  };

  try {
    // Snapshot only the unscoped page-load variant (fy is already validated
    // by parseFy). Free-form stateHead filters stay live so the snapshot key
    // space stays bounded.
    const payload = !stateHead
      ? await serveWithSnapshot({
          key: `targets|${fy}`,
          ttlMs: TARGETS_SNAPSHOT_TTL_MS,
          build,
          log: req.log,
          frozen: isFrozen(fy),
        })
      : await build();
    res.json(payload);
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
          // A new joiner (no prior-year history) gets an equal per-head
          // share — surfaced so the UI can say so instead of implying zero.
          basis: input[i].priorYearActual > 0 ? "prior-year" : "equal-share",
        })),
      });
    } catch (err) {
      req.log.error({ err, fy, stateHead }, "split preview failed");
      res.status(500).json({ error: "Could not compute the split. Try again in a minute." });
    }
  },
);

// POST /targets — save member targets to the member_targets database table.
// The Target Master Google Sheet stays read-only (it is the seed); explicit
// user saves land in the DB and overlay the sheet per member. DB rows carry
// source='user' and are never touched by any seed or background job.
router.post("/targets", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as {
    fy?: unknown;
    updatedBy?: unknown;
    rows?: unknown;
  };
  const fy = typeof body.fy === "string" && FY_PATTERN.test(body.fy) ? body.fy : null;
  if (!fy) {
    res.status(400).json({ error: "fy must look like 2026-27" });
    return;
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    res.status(400).json({ error: "rows must be a non-empty array" });
    return;
  }
  if (body.rows.length > 300) {
    res.status(400).json({ error: "Too many rows in one save (max 300)" });
    return;
  }
  const updatedBy = (
    typeof body.updatedBy === "string" && body.updatedBy.trim() !== ""
      ? body.updatedBy.trim()
      : "targets-page"
  ).slice(0, 80);

  try {
    const roster = await loadRoster();
    const rosterByKey = new Map(
      activeMembers(roster.members).map((m) => [m.normKey, m]),
    );

    const parsed: Array<{
      teamMember: string;
      stateHead: string;
      annual: FieldValues;
      monthly: FieldMonthly;
    }> = [];
    const errors: string[] = [];
    const seenKeys = new Set<string>();

    for (const raw of body.rows as Array<Record<string, unknown>>) {
      const teamMember = typeof raw?.teamMember === "string" ? raw.teamMember.trim() : "";
      if (!teamMember) {
        errors.push("A row is missing teamMember");
        continue;
      }
      const memberKey = normName(teamMember);
      if (seenKeys.has(memberKey)) {
        errors.push(`"${teamMember}" appears more than once in this save`);
        continue;
      }
      seenKeys.add(memberKey);
      const rosterMember = rosterByKey.get(memberKey);
      const annualRaw = (raw.annual ?? {}) as Record<string, unknown>;
      const monthlyRaw = (raw.monthly ?? {}) as Record<string, unknown>;
      const annual: FieldValues = {
        primary: numOrNull(annualRaw.primary),
        secondary: numOrNull(annualRaw.secondary),
        directDealer: numOrNull(annualRaw.directDealer),
        businessPlan: numOrNull(annualRaw.businessPlan),
      };
      const monthly: FieldMonthly = {
        primary: [], secondary: [], directDealer: [], businessPlan: [],
      };
      for (const f of TARGET_FIELDS) {
        const arr = Array.isArray(monthlyRaw[f]) ? (monthlyRaw[f] as unknown[]) : [];
        monthly[f] = Array.from({ length: 12 }, (_, i) => numOrNull(arr[i]));
      }
      const row = {
        fy,
        // Store the canonical roster spelling so DB rows join cleanly.
        teamMember: rosterMember?.name ?? teamMember,
        stateHead: rosterMember?.stateHead ?? "",
        level: "TM" as const,
        annual,
        monthly,
        updatedBy,
        updatedAt: new Date().toISOString(),
      };
      const rowErrors = validateRow(row, new Set(rosterByKey.keys()));
      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }
      parsed.push({
        teamMember: row.teamMember,
        stateHead: row.stateHead,
        annual,
        monthly,
      });
    }

    if (errors.length > 0) {
      res.status(422).json({ error: errors.slice(0, 8).join("; ") });
      return;
    }

    const result = await upsertMemberTargets(fy, parsed, updatedBy);
    // Reports and management snapshots read targets via loadTargetsForFy;
    // drop cached payloads so the new values show up immediately.
    invalidateMgmtDataCache(fy);
    req.log.info(
      { fy, updated: result.updated, appended: result.appended, updatedBy },
      "member targets saved",
    );
    res.json({ fy, updated: result.updated, appended: result.appended });
  } catch (err) {
    req.log.error({ err, fy }, "member targets save failed");
    res.status(500).json({ error: "Could not save targets. Try again in a minute." });
  }
});

export default router;
