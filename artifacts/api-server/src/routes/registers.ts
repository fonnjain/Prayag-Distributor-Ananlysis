import { Router } from "express";
import { pool } from "@workspace/db";
import {
  backfillColor,
  reconcileVersions,
} from "../lib/registers/reconcileVersions.js";
import { tombstoneOrphans, identityKey } from "../lib/registers/ingest.js";
import { readRegisterFromSheets } from "../lib/registers/sheetsRegister.js";
import {
  OccurrenceCounter,
  emptyUnmapped,
  parseRegisterRow,
  toSaleLine,
} from "../lib/registers/normalize.js";
import { REGISTER_SHEET_IDS } from "../lib/customers/registerSync.js";

const router = Router();

/**
 * POST /registers/:fy/backfill-color?dryRun=true
 *
 * Reads the live SALE SHEET for the given FY and stamps colour on any
 * sale_line rows whose color column is NULL.
 *
 * Run this ONCE after deploying the colour-capture code, before reconciling.
 * dryRun=true reports counts without writing anything.
 */
router.post("/registers/:fy/backfill-color", async (req, res) => {
  const { fy } = req.params;
  const dryRun = req.query.dryRun === "true";

  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet ID configured for FY ${fy}` });
    return;
  }

  try {
    const result = await backfillColor(fy, spreadsheetId, dryRun);
    res.json(result);
  } catch (err: unknown) {
    req.log.error({ err, fy, dryRun }, "backfill-color failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /registers/:fy/reconcile-versions?dryRun=true
 *
 * One-off pass to mark superseded duplicate rows for a given FY.
 * Within each identity group (invoice_no, code, color, qty, month_label)
 * the row with the latest ingested_at wins; the rest become version_status='superseded'.
 *
 * Run AFTER backfill-color. dryRun=true reports counts without writing anything.
 *
 * Expected deployment sequence:
 *   1. POST /registers/2026-27/backfill-color?dryRun=true   (review counts)
 *   2. POST /registers/2026-27/backfill-color               (apply)
 *   3. POST /registers/2026-27/reconcile-versions?dryRun=true (review)
 *   4. POST /registers/2026-27/reconcile-versions           (apply)
 */
router.post("/registers/:fy/reconcile-versions", async (req, res) => {
  const { fy } = req.params;
  const dryRun = req.query.dryRun === "true";

  try {
    const result = await reconcileVersions(fy, dryRun);
    res.json(result);
  } catch (err: unknown) {
    req.log.error({ err, fy, dryRun }, "reconcile-versions failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /registers/:fy/tombstone-orphans?month=Jul-26&dryRun=true
 *
 * One-off cleanup for orphan rows (DB rows no longer present in the live sheet).
 * Reads the live sheet for the given FY, identifies current DB rows whose
 * identity is absent from the sheet's latest state, and marks them superseded.
 *
 * ALL FIVE GUARDS APPLY:
 *   1. Scoped to (fy, month) only
 *   2. Aborts if sheet returns 0 rows for that month
 *   3. Halts if candidates > blastRadiusLimitPct (default 10%) of current rows
 *   4. dryRun=true (default) never writes — always returns full report
 *   5. Every tombstone logged with syncRunId
 *
 * For the July 2026-27 one-off backlog (26%): pass blastRadiusLimitPct=30 with
 * dryRun=false only after reviewing the dry-run output and obtaining approval.
 */
router.post("/registers/:fy/tombstone-orphans", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const dryRun = req.query.dryRun !== "false";
  const blastRadiusLimitPct = req.query.blastRadiusLimitPct != null
    ? Number(req.query.blastRadiusLimitPct)
    : undefined;

  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    const occurrence = new OccurrenceCounter();
    const unmapped = emptyUnmapped();
    const allLines: ReturnType<typeof toSaleLine>[] = [];

    const { rowsScanned, tabsRead } = await readRegisterFromSheets(
      spreadsheetId,
      fy,
      (values, columns) => {
        const result = parseRegisterRow(values, columns, fy);
        if (result.kind !== "row") return;
        allLines.push(toSaleLine(result.row, occurrence, unmapped, "sheets"));
      },
    );

    const monthLines = allLines.filter((l) => l.monthLabel === month);

    const seenIdentities = new Set(
      monthLines.map((l) =>
        identityKey(
          l.invoiceNo ?? null,
          l.code,
          l.color ?? null,
          l.qty ?? null,
          l.monthLabel ?? null,
        ),
      ),
    );

    const syncRunId = `manual-tombstone-${new Date().toISOString()}`;

    const result = await tombstoneOrphans({
      fy,
      month,
      seenIdentities,
      incomingRowCount: monthLines.length,
      syncRunId,
      dryRun,
      blastRadiusLimitPct,
    });

    res.json({
      ...result,
      sheetRowsScanned: rowsScanned,
      tabsRead,
      monthLinesFromSheet: monthLines.length,
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month, dryRun }, "tombstone-orphans failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /registers/:fy/version-stats
 *
 * Returns row counts split by version_status for a given FY.
 * Used by the Data Health panel to surface deduplication status.
 */
router.get("/registers/:fy/version-stats", async (req, res) => {
  const { fy } = req.params;
  try {
    const rows = await pool.query<{ status: string; cnt: string; total_amount: string }>(
      `SELECT
         COALESCE(version_status, 'current') AS status,
         COUNT(*)::text AS cnt,
         COALESCE(SUM(amount::numeric), 0)::text AS total_amount
       FROM sale_line
       WHERE fy = $1
       GROUP BY COALESCE(version_status, 'current')`,
      [fy],
    );

    const byStatus: Record<string, { rows: number; amount: number }> = {};
    for (const r of rows.rows) {
      byStatus[r.status] = {
        rows: parseInt(r.cnt, 10),
        amount: parseFloat(r.total_amount),
      };
    }

    const current = byStatus["current"] ?? { rows: 0, amount: 0 };
    const superseded = byStatus["superseded"] ?? { rows: 0, amount: 0 };
    const totalRows = current.rows + superseded.rows;

    res.json({
      fy,
      totalRows,
      currentRows: current.rows,
      supersededRows: superseded.rows,
      currentAmount: Math.round(current.amount),
      supersededAmount: Math.round(superseded.amount),
      reconciled: superseded.rows > 0 || totalRows === 0,
    });
  } catch (err: unknown) {
    req.log.error({ err, fy }, "version-stats failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
