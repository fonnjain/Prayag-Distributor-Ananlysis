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
import {
  REGISTER_SHEET_IDS,
  getAnchorHealth,
  runScheduledTick,
} from "../lib/customers/registerSync.js";

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

/**
 * GET /registers/anchor-health
 *
 * Returns the most recent per-month anchor check results for the open FY
 * (DB current rows/total vs sheet rows/total). Populated after each scheduled
 * or manual sync tick; empty before the first sync completes.
 */
router.get("/registers/anchor-health", (_req, res) => {
  res.json(getAnchorHealth());
});

/**
 * POST /registers/run-sync-tick
 *
 * Manually triggers one scheduled-sync tick (same logic as the 6-hour timer).
 * Skips closed FYs. Useful for confirming the freeze guard and refreshing
 * anchor-health results without waiting for the next scheduled cycle.
 */
router.post("/registers/run-sync-tick", (req, res) => {
  runScheduledTick();
  req.log.info("manual sync tick triggered");
  res.json({ triggered: true, message: "Sync tick started — check anchor-health in ~60s" });
});

// ── Orphan audit ───────────────────────────────────────────────────────────────
// Supervised one-off cleanup for months where the blast-radius guard halted.
// Splits orphan rows into two groups:
//   Group A — invoice+code exists in sheet (different color/qty/amount)
//             These are rate-edit or re-parse orphans: safe to supersede.
//   Group B — invoice+code absent entirely from sheet
//             These are genuinely gone. Never auto-superseded; shown for review.

type OrphanRow = {
  lineUid: string;
  invoiceNo: string | null;
  code: string;
  color: string | null;
  qty: string | null;
  amount: string;
  saleRate: string | null;
  ingestedAt: string | null;
};

type SheetMatchRow = {
  invoiceNo: string | null;
  code: string;
  color: string | null;
  qty: string | null;
  amount: string;
  saleRate: string | null;
};

type OrphanAuditReport = {
  fy: string;
  month: string;
  sheetRows: number;
  dbCurrentRows: number;
  orphanCount: number;
  orphanAmount: number;
  groupA: {
    description: string;
    count: number;
    amount: number;
    rows: Array<OrphanRow & { sheetMatch: SheetMatchRow[] }>;
  };
  groupB: {
    description: string;
    count: number;
    amount: number;
    rows: OrphanRow[];
  };
  auditedAt: string;
};

async function doOrphanAudit(
  fy: string,
  spreadsheetId: string,
  month: string,
): Promise<OrphanAuditReport> {
  // 1. Read live sheet for all tabs in this FY
  const occurrence = new OccurrenceCounter();
  const unmapped = emptyUnmapped();
  const allLines: ReturnType<typeof toSaleLine>[] = [];

  await readRegisterFromSheets(spreadsheetId, fy, (values, columns) => {
    const result = parseRegisterRow(values, columns, fy);
    if (result.kind !== "row") return;
    allLines.push(toSaleLine(result.row, occurrence, unmapped, "sheets"));
  });

  const monthLines = allLines.filter((l) => l.monthLabel === month);
  if (monthLines.length === 0) {
    throw new Error(`Zero rows for month ${month} in sheet — aborting`);
  }

  // 2. Build lookup structures from sheet
  // Exact identity set (invoice_no|code|color|qty|month_label — amount excluded)
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

  // Loose match map: invoice_no|code → matching sheet rows
  // Used to detect Group A (same invoice+product, different color/qty/amount)
  const sheetByLooseKey = new Map<string, SheetMatchRow[]>();
  for (const l of monthLines) {
    if (l.invoiceNo == null) continue;
    const key = `${l.invoiceNo}|${l.code}`;
    const existing = sheetByLooseKey.get(key) ?? [];
    existing.push({
      invoiceNo: l.invoiceNo ?? null,
      code: l.code,
      color: l.color ?? null,
      qty: l.qty ?? null,
      amount: String(l.amount ?? ""),
      saleRate: l.saleRate ?? null,
    });
    sheetByLooseKey.set(key, existing);
  }

  // 3. Query DB for all current rows in this (fy, month)
  const dbResult = await pool.query<{
    line_uid: string;
    invoice_no: string | null;
    code: string;
    color: string | null;
    qty: string | null;
    amount: string;
    sale_rate: string | null;
    ingested_at: string | null;
  }>(
    `SELECT line_uid, invoice_no, code, color, qty, amount, sale_rate,
            to_char(ingested_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ingested_at
       FROM sale_line
      WHERE fy = $1 AND month_label = $2 AND version_status = 'current'
      ORDER BY ingested_at`,
    [fy, month],
  );

  const dbCurrentRows = dbResult.rows.length;

  // 4. Classify each DB row: confirmed (in sheet) vs orphan → Group A or Group B
  const groupARows: Array<OrphanRow & { sheetMatch: SheetMatchRow[] }> = [];
  const groupBRows: OrphanRow[] = [];

  for (const r of dbResult.rows) {
    const key = identityKey(r.invoice_no, r.code, r.color, r.qty, month);
    if (seenIdentities.has(key)) continue; // confirmed — not an orphan

    const row: OrphanRow = {
      lineUid: r.line_uid,
      invoiceNo: r.invoice_no,
      code: r.code,
      color: r.color,
      qty: r.qty,
      amount: r.amount,
      saleRate: r.sale_rate,
      ingestedAt: r.ingested_at,
    };

    // Group A: same invoice+code still in sheet (color/qty/amount differs)
    const looseKey = r.invoice_no != null ? `${r.invoice_no}|${r.code}` : null;
    const sheetMatch = looseKey != null ? (sheetByLooseKey.get(looseKey) ?? []) : [];

    if (sheetMatch.length > 0) {
      groupARows.push({ ...row, sheetMatch });
    } else {
      groupBRows.push(row);
    }
  }

  const orphanCount = groupARows.length + groupBRows.length;
  const orphanAmount = [...groupARows, ...groupBRows].reduce(
    (s, r) => s + parseFloat(r.amount || "0"),
    0,
  );
  const groupAAmount = groupARows.reduce((s, r) => s + parseFloat(r.amount || "0"), 0);
  const groupBAmount = groupBRows.reduce((s, r) => s + parseFloat(r.amount || "0"), 0);

  return {
    fy,
    month,
    sheetRows: monthLines.length,
    dbCurrentRows,
    orphanCount,
    orphanAmount: Math.round(orphanAmount),
    groupA: {
      description:
        "invoice+code exists in sheet with different color/qty/amount — rate-edit or re-parse orphan; safe to supersede",
      count: groupARows.length,
      amount: Math.round(groupAAmount),
      rows: groupARows,
    },
    groupB: {
      description:
        "invoice+code absent entirely from sheet — genuinely gone; do NOT auto-supersede; review before any action",
      count: groupBRows.length,
      amount: Math.round(groupBAmount),
      rows: groupBRows,
    },
    auditedAt: new Date().toISOString(),
  };
}

/**
 * GET /registers/:fy/orphan-audit?month=Jul-26
 *
 * Dry-run report for supervised orphan cleanup.
 * Re-reads the live sheet, classifies all current DB orphans into Group A
 * (invoice+code still in sheet, different amount/color/qty — safe to supersede)
 * and Group B (invoice+code absent entirely — must review before any action).
 * Never writes anything.
 */
router.get("/registers/:fy/orphan-audit", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";

  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    const report = await doOrphanAudit(fy, spreadsheetId, month);
    res.json(report);
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "orphan-audit failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /registers/:fy/orphan-audit/apply?month=Jul-26
 *
 * Applies the orphan-audit supersede to Group A ONLY.
 * Re-reads the sheet fresh (never applies stale audit data) and supersedes
 * rows whose invoice+code still exists in the sheet but with different values.
 * Group B rows are never touched.
 *
 * Supersede only — never deletes. Safe to re-run: double-guards with
 * WHERE version_status='current' so concurrent syncs cannot cause double-supersede.
 */
router.post("/registers/:fy/orphan-audit/apply", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";

  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    // Always re-read sheet fresh — never apply a cached audit result
    const report = await doOrphanAudit(fy, spreadsheetId, month);

    if (report.groupA.count === 0) {
      res.json({
        applied: 0,
        amount: 0,
        groupBCount: report.groupB.count,
        groupBAmount: report.groupB.amount,
        message: "Nothing to apply — Group A is empty",
        auditedAt: report.auditedAt,
      });
      return;
    }

    const syncRunId = `orphan-audit|${report.auditedAt}`;
    const lineUids = report.groupA.rows.map((r) => r.lineUid);

    // Supersede Group A only. WHERE version_status='current' is a safety guard
    // against double-supersede if a concurrent sync ran between audit and apply.
    const updateResult = await pool.query<never>(
      `UPDATE sale_line
          SET version_status = 'superseded',
              superseded_at  = NOW(),
              superseded_by  = $1
        WHERE line_uid       = ANY($2)
          AND version_status = 'current'`,
      [syncRunId, lineUids],
    );

    res.json({
      syncRunId,
      applied: updateResult.rowCount ?? 0,
      amount: report.groupA.amount,
      groupBCount: report.groupB.count,
      groupBAmount: report.groupB.amount,
      sheetRows: report.sheetRows,
      dbCurrentRowsBefore: report.dbCurrentRows,
      auditedAt: report.auditedAt,
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "orphan-audit/apply failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
