// GET  /primary-state-targets/by-head?fy=2026-27
// PUT  /primary-state-targets/by-head
//
// Unified read/write interface for state-head monthly targets stored in
// primary_state_targets.  Used by the Data Sources "State Head Targets" editor.
//
// GET: returns head-level monthly totals + company totals for all 12 FY months.
// PUT: body { fy, updates: [{ stateHead, monthLabel, targetLakh }] }
//      - If state rows already exist for (fy, head, month): scale them
//        proportionally to the new total and set source='user'.
//      - If no rows exist: insert a single "(Total)" row with source='user'.
import { Router, type Request, type Response } from "express";
import { db, primaryStateTargets } from "@workspace/db";
import { pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getSeasonalCalibration } from "../lib/seasonal.js";

const router = Router();
const FY_PATTERN = /^\d{4}-\d{2}$/;

// ── All 12 fiscal month labels for a given FY ─────────────────────────────────

function fyMonths(fy: string): string[] {
  const start = Number(fy.slice(2, 4)); // "26" from "2026-27"
  const end   = Number(fy.slice(5, 7)); // "27"
  return [
    `Apr-${start}`, `May-${start}`, `Jun-${start}`,
    `Jul-${start}`, `Aug-${start}`, `Sep-${start}`,
    `Oct-${start}`, `Nov-${start}`, `Dec-${start}`,
    `Jan-${end}`,   `Feb-${end}`,   `Mar-${end}`,
  ];
}

// ── GET /primary-state-targets/by-head ───────────────────────────────────────

router.get(
  "/primary-state-targets/by-head",
  async (req: Request, res: Response): Promise<void> => {
    const fy =
      typeof req.query.fy === "string" && FY_PATTERN.test(req.query.fy.trim())
        ? req.query.fy.trim()
        : "2026-27";

    try {
      const rows = await db
        .select()
        .from(primaryStateTargets)
        .where(eq(primaryStateTargets.fy, fy));

      const months = fyMonths(fy);

      // Aggregate: head → month → { total, source }
      const headMonthTotal = new Map<string, Map<string, number>>();
      const headMonthSource = new Map<string, Map<string, string>>();
      const companyMap = new Map<string, number>();

      for (const row of rows) {
        if (!headMonthTotal.has(row.stateHead)) {
          headMonthTotal.set(row.stateHead, new Map());
          headMonthSource.set(row.stateHead, new Map());
        }
        const mTotal  = headMonthTotal.get(row.stateHead)!;
        const mSource = headMonthSource.get(row.stateHead)!;

        mTotal.set(row.monthLabel, (mTotal.get(row.monthLabel) ?? 0) + row.targetLakh);
        // If any row for this head+month is user-entered, mark the whole cell as user.
        if (row.source === "user" || !mSource.has(row.monthLabel)) {
          mSource.set(row.monthLabel, row.source);
        }

        companyMap.set(row.monthLabel, (companyMap.get(row.monthLabel) ?? 0) + row.targetLakh);
      }

      // Sorted alphabetically by display name
      const headKeys = [...headMonthTotal.keys()].sort();

      const heads = headKeys.map((stateHead) => {
        const mTotal  = headMonthTotal.get(stateHead)!;
        const mSource = headMonthSource.get(stateHead)!;
        return {
          stateHead,
          monthly: Object.fromEntries(
            months.map((m) => [m, Math.round((mTotal.get(m) ?? 0) * 100) / 100]),
          ),
          monthlySource: Object.fromEntries(
            months.map((m) => [m, mSource.get(m) ?? null]),
          ),
        };
      });

      const companyTotals = Object.fromEntries(
        months.map((m) => [m, Math.round((companyMap.get(m) ?? 0) * 100) / 100]),
      );

      res.json({ fy, months, companyTotals, heads, seasonalCalibration: getSeasonalCalibration() });
    } catch (err) {
      req.log.error({ err, fy }, "primary-state-targets/by-head GET failed");
      res.status(500).json({ error: "Could not load state head targets." });
    }
  },
);

// ── PUT /primary-state-targets/by-head ───────────────────────────────────────

type UpdateItem = { stateHead: string; monthLabel: string; targetLakh: number };

router.put(
  "/primary-state-targets/by-head",
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fy = typeof body.fy === "string" ? body.fy.trim() : "";
    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "fy must look like 2026-27" });
      return;
    }

    if (!Array.isArray(body.updates) || body.updates.length === 0) {
      res.status(400).json({ error: "updates must be a non-empty array" });
      return;
    }

    const updates: UpdateItem[] = [];
    for (const u of body.updates as unknown[]) {
      const item = u as Record<string, unknown>;
      const stateHead  = typeof item.stateHead  === "string" ? item.stateHead.trim() : "";
      const monthLabel = typeof item.monthLabel  === "string" ? item.monthLabel.trim() : "";
      const raw        = item.targetLakh;
      const targetLakh = typeof raw === "number" ? raw : parseFloat(String(raw));
      if (!stateHead || !monthLabel || !Number.isFinite(targetLakh) || targetLakh < 0) continue;
      updates.push({ stateHead, monthLabel, targetLakh });
    }

    if (updates.length === 0) {
      res.status(400).json({ error: "No valid updates provided." });
      return;
    }

    try {
      let applied = 0;

      for (const { stateHead, monthLabel, targetLakh } of updates) {
        // Load existing state rows for this head + month
        const existing = await db
          .select()
          .from(primaryStateTargets)
          .where(
            and(
              eq(primaryStateTargets.fy, fy),
              eq(primaryStateTargets.stateHead, stateHead),
              eq(primaryStateTargets.monthLabel, monthLabel),
            ),
          );

        const existingTotal = existing.reduce((s, r) => s + r.targetLakh, 0);

        if (existing.length > 0 && existingTotal > 0) {
          // Scale existing rows proportionally and mark as user-entered.
          const scale = targetLakh / existingTotal;
          for (const row of existing) {
            await db
              .update(primaryStateTargets)
              .set({
                targetLakh: Math.round(row.targetLakh * scale * 100) / 100,
                source: "user",
              })
              .where(eq(primaryStateTargets.id, row.id));
          }
        } else {
          // No rows exist for this head + month: insert a single head-level row.
          await pool.query(
            `INSERT INTO primary_state_targets
               (fy, state_head, state, month_label, target_lakh, source)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (fy, state_head, state, month_label)
             DO UPDATE SET target_lakh = EXCLUDED.target_lakh,
                           source      = EXCLUDED.source`,
            [fy, stateHead, "(Total)", monthLabel, targetLakh, "user"],
          );
        }

        applied++;
      }

      req.log.info({ fy, applied }, "primary-state-targets/by-head PUT: updated");
      res.json({ applied });
    } catch (err) {
      req.log.error({ err, fy }, "primary-state-targets/by-head PUT failed");
      res.status(500).json({ error: "Could not save state head targets." });
    }
  },
);

export default router;
