// Admin-only evidence view for the append-only secondary head-month ledger.
// This is deliberately narrow: callers must name one FY, member and month.
import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { isAdminToken } from "../lib/adminAuth.js";
import { logger } from "../lib/logger.js";

const router = Router();

function requireAdmin(req: Request, res: Response): boolean {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin authorisation required." });
    return false;
  }
  return true;
}

type HistoryRow = {
  revision_id: number;
  ingest_run_id: number;
  source: string | null;
  run_status: string | null;
  started_at: Date | null;
  recorded_at: Date;
  head_raw: string | null;
  state_head: string | null;
  month_idx: number;
  plan_amount: string | null;
  ordered_amount: string | null;
  received_amount: string | null;
  achievement_pct: string | null;
  is_anomaly: boolean;
  not_yet_recorded: boolean;
  source_sheet_id: string | null;
  prior_revision_id: number | null;
  prior_plan_amount: string | null;
  prior_ordered_amount: string | null;
  prior_received_amount: string | null;
  prior_achievement_pct: string | null;
};

type CurrentRow = Omit<
  HistoryRow,
  | "revision_id"
  | "recorded_at"
  | "prior_revision_id"
  | "prior_plan_amount"
  | "prior_ordered_amount"
  | "prior_received_amount"
  | "prior_achievement_pct"
> & {
  ingested_at: Date | null;
};

function asNumber(value: string | null): number | null {
  return value == null ? null : Number(value);
}

function valuesOf(row: Pick<
  HistoryRow,
  "plan_amount" | "ordered_amount" | "received_amount" | "achievement_pct" | "is_anomaly" | "not_yet_recorded"
>) {
  return {
    planAmount: asNumber(row.plan_amount),
    orderedAmount: asNumber(row.ordered_amount),
    receivedAmount: asNumber(row.received_amount),
    achievementPct: asNumber(row.achievement_pct),
    isAnomaly: row.is_anomaly,
    notYetRecorded: row.not_yet_recorded,
  };
}

function movement(after: number | null, before: number | null): number | null {
  return after == null || before == null ? null : after - before;
}

// GET /api/admin/secondary/head-month-history?fy=2026-27&headCanon=...&monthLabel=Apr-26
router.get("/admin/secondary/head-month-history", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;

  const fy = String(req.query.fy ?? "").trim();
  const headCanon = String(req.query.headCanon ?? req.query.head ?? "").trim();
  const monthLabel = String(req.query.monthLabel ?? req.query.month ?? "").trim();
  if (!fy || !headCanon || !monthLabel) {
    res.status(400).json({
      error: "fy, headCanon, and monthLabel are required.",
    });
    return;
  }

  try {
    // Keep the ledger and current-value reads on one repeatable-read snapshot.
    // Without this, a dashboard load that commits between two pool queries can
    // yield a current run whose corresponding revision is absent from history.
    const client = await pool.connect();
    let transactionStarted = false;
    let historyResult;
    let currentResult;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionStarted = true;
      historyResult = await client.query<HistoryRow>(
        `
          SELECT
            r.id AS revision_id,
            r.ingest_run_id,
            run.source,
            run.status AS run_status,
            run.started_at,
            r.recorded_at,
            r.head_raw,
            r.state_head,
            r.month_idx,
            r.plan_amount,
            r.ordered_amount,
            r.received_amount,
            r.achievement_pct,
            r.is_anomaly,
            r.not_yet_recorded,
            r.source_sheet_id,
            LAG(r.id) OVER (ORDER BY r.id) AS prior_revision_id,
            LAG(r.plan_amount) OVER (ORDER BY r.id) AS prior_plan_amount,
            LAG(r.ordered_amount) OVER (ORDER BY r.id) AS prior_ordered_amount,
            LAG(r.received_amount) OVER (ORDER BY r.id) AS prior_received_amount,
            LAG(r.achievement_pct) OVER (ORDER BY r.id) AS prior_achievement_pct
          FROM secondary_head_month_revision r
          JOIN secondary_ingest_run run ON run.id = r.ingest_run_id
          WHERE r.fy = $1
            AND r.head_canon = $2
            AND r.month_label = $3
          ORDER BY r.id ASC
        `,
        [fy, headCanon, monthLabel],
      );
      currentResult = await client.query<CurrentRow>(
        `
          SELECT
            current.ingest_run_id,
            run.source,
            run.status AS run_status,
            run.started_at,
            current.head_raw,
            current.state_head,
            current.month_idx,
            current.plan_amount,
            current.ordered_amount,
            current.received_amount,
            current.achievement_pct,
            current.is_anomaly,
            current.not_yet_recorded,
            current.source_sheet_id,
            current.ingested_at
          FROM secondary_head_month current
          JOIN secondary_ingest_run run ON run.id = current.ingest_run_id
          WHERE current.fy = $1
            AND current.head_canon = $2
            AND current.month_label = $3
        `,
        [fy, headCanon, monthLabel],
      );
      await client.query("COMMIT");
    } catch (err) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (historyResult.rows.length === 0 || currentResult.rows.length === 0) {
      res.status(404).json({ error: "No secondary head-month history found for the requested key." });
      return;
    }

    const current = currentResult.rows[0]!;
    res.json({
      fy,
      headCanon,
      monthLabel,
      current: {
        sourceRun: {
          id: current.ingest_run_id,
          source: current.source,
          status: current.run_status,
          startedAt: current.started_at,
        },
        ingestedAt: current.ingested_at,
        sourceSheetId: current.source_sheet_id,
        values: valuesOf(current),
      },
      revisions: historyResult.rows.map((row) => {
        const before = {
          planAmount: asNumber(row.prior_plan_amount),
          orderedAmount: asNumber(row.prior_ordered_amount),
          receivedAmount: asNumber(row.prior_received_amount),
          achievementPct: asNumber(row.prior_achievement_pct),
        };
        const after = valuesOf(row);
        return {
          revisionId: row.revision_id,
          sourceRun: {
            id: row.ingest_run_id,
            source: row.source,
            status: row.run_status,
            startedAt: row.started_at,
          },
          recordedAt: row.recorded_at,
          sourceSheetId: row.source_sheet_id,
          before: row.prior_revision_id == null ? null : before,
          after,
          movement: {
            planAmount: movement(after.planAmount, before.planAmount),
            orderedAmount: movement(after.orderedAmount, before.orderedAmount),
            receivedAmount: movement(after.receivedAmount, before.receivedAmount),
            achievementPct: movement(after.achievementPct, before.achievementPct),
          },
        };
      }),
    });
  } catch (err) {
    logger.error({ err, fy, headCanon, monthLabel }, "secondary head-month history query failed");
    res.status(500).json({ error: "Could not load secondary head-month history." });
  }
});

export default router;