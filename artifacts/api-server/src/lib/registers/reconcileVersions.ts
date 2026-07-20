// Step 1: Backfill colour for existing rows from the live SALE SHEET.
// Step 3: One-off pass to mark superseded rows after colour is in place.
//
// BACKGROUND
// ----------
// Prior to Jul 2026, line_uid hashed the amount. When the SALE SHEET had rates
// rounded (e.g. 490.92 → 491 on 18 and 20 Jul), the hash changed and the sync
// inserted new rows without removing the old ones. This created 2-3 copies of
// each affected line, all with version_status = 'current' (the column's
// DEFAULT — added retroactively).
//
// RECONCILE STRATEGY
// ------------------
// Group all current rows by identity (invoice_no, code, COALESCE(color,''),
// qty, month_label). Within each group, the row with the latest ingested_at
// is the authoritative version (current); the rest become superseded.
//
// NOTHING IS DELETED. Superseded rows stay in the table with
//   version_status = 'superseded'
//   superseded_at  = ingested_at of the winner row
//   superseded_by  = line_uid of the winner row
//
// EVERY reported figure must filter to version_status = 'current'.
// The sale_line_current view handles this for raw SQL consumers.

import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { db, pool, saleLines } from "@workspace/db";
import { logger } from "../logger.js";
import {
  OccurrenceCounter,
  emptyUnmapped,
  parseRegisterRow,
  toSaleLine,
} from "./normalize.js";
import { readRegisterFromSheets } from "./sheetsRegister.js";
import { BATCH_SIZE } from "./ingest.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MonthStat = {
  month: string;
  examined: number;
  superseded: number;
  current: number;
  amountBefore: number; // sum of all version_status='current' before the pass
  amountAfter: number;  // sum after
};

export type ReconcileResult = {
  fy: string;
  dryRun: boolean;
  totalExamined: number;
  totalSuperseded: number;
  totalCurrent: number;
  byMonth: MonthStat[];
  durationMs: number;
};

export type BackfillColorResult = {
  fy: string;
  dryRun: boolean;
  rowsScanned: number;
  rowsMatched: number;        // DB rows that got a color from the sheet
  rowsUnmatched: number;      // DB rows whose (invoice_no, serial_no) wasn't in sheet
  rowsAlreadyColored: number; // DB rows that already had a color (skipped)
  durationMs: number;
};

// ── Step 1: Backfill colour ───────────────────────────────────────────────────

/**
 * Reads the live SALE SHEET for the given FY, builds a
 * (invoice_no, serial_no) → color map, and batch-updates any DB row for that
 * FY whose color is currently NULL.
 *
 * Matching key: (invoice_no, serial_no) when both are present in the sheet.
 * Rows in the DB that have no serial_no, or whose identity is not in the
 * sheet read, are counted as unmatched and left unchanged.
 *
 * dryRun=true reports counts without writing anything.
 */
export async function backfillColor(
  fy: string,
  spreadsheetId: string,
  dryRun: boolean,
): Promise<BackfillColorResult> {
  const t0 = Date.now();

  // 1. Read the live sheet — build (invoice_no, serial_no) → color map.
  const colorBySerial = new Map<string, string | null>(); // key: "inv|serial"
  let rowsScanned = 0;

  await readRegisterFromSheets(spreadsheetId, fy, (values, columns) => {
    const result = parseRegisterRow(values, columns, fy);
    if (result.kind !== "row") return;
    const { row } = result;
    rowsScanned++;
    if (row.invoiceNo != null && row.serialNo != null) {
      const key = `${row.invoiceNo}|${row.serialNo}`;
      // color may be null if the cell is blank — still record the mapping
      if (!colorBySerial.has(key)) {
        colorBySerial.set(key, row.color);
      }
    }
  });

  logger.info(
    { fy, rowsScanned, mappings: colorBySerial.size, dryRun },
    "backfillColor: sheet read complete",
  );

  // 2. Load all DB rows for this FY that still need color.
  //    Include all version_status values (current and superseded both get color).
  const dbRows = await db
    .select({
      lineUid: saleLines.lineUid,
      invoiceNo: saleLines.invoiceNo,
      serialNo: saleLines.serialNo,
      color: saleLines.color,
    })
    .from(saleLines)
    .where(eq(saleLines.fy, fy));

  let rowsMatched = 0;
  let rowsUnmatched = 0;
  let rowsAlreadyColored = 0;

  // Partition rows
  type Update = { lineUid: string; color: string | null };
  const updates: Update[] = [];

  for (const row of dbRows) {
    if (row.color != null) {
      rowsAlreadyColored++;
      continue;
    }
    if (row.invoiceNo == null || row.serialNo == null) {
      rowsUnmatched++;
      continue;
    }
    const key = `${row.invoiceNo}|${row.serialNo}`;
    if (colorBySerial.has(key)) {
      updates.push({ lineUid: row.lineUid, color: colorBySerial.get(key) ?? null });
      rowsMatched++;
    } else {
      rowsUnmatched++;
    }
  }

  logger.info(
    { fy, rowsMatched, rowsUnmatched, rowsAlreadyColored, dryRun },
    "backfillColor: match summary",
  );

  // 3. Apply updates in batches (skip if dry run).
  if (!dryRun && updates.length > 0) {
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      const uids = batch.map((u) => u.lineUid);
      // Group by color value to minimise round-trips; most cells are the same colour.
      const byColor = new Map<string | null, string[]>();
      for (const u of batch) {
        const arr = byColor.get(u.color) ?? [];
        arr.push(u.lineUid);
        byColor.set(u.color, arr);
      }
      for (const [color, lineUids] of byColor) {
        await db
          .update(saleLines)
          .set({ color })
          .where(inArray(saleLines.lineUid, lineUids));
      }
    }
    logger.info({ fy, updated: updates.length }, "backfillColor: DB updated");
  }

  return {
    fy,
    dryRun,
    rowsScanned,
    rowsMatched,
    rowsUnmatched,
    rowsAlreadyColored,
    durationMs: Date.now() - t0,
  };
}

// ── Step 3: Reconcile existing duplicate versions ─────────────────────────────

/**
 * One-off pass over all current rows for a given FY.
 *
 * Groups by identity (invoice_no, code, COALESCE(color,''), qty, month_label).
 * Within each group, the row with the latest ingested_at (tie-break: line_uid
 * DESC) is the winner and stays current. Every other row is marked superseded.
 *
 * dryRun=true computes the full report without writing anything.
 */
export async function reconcileVersions(
  fy: string,
  dryRun: boolean,
): Promise<ReconcileResult> {
  const t0 = Date.now();

  // 1. Capture per-month amounts BEFORE the pass.
  const beforeRows = await pool.query<{ month_label: string; total: string }>(
    `SELECT COALESCE(month_label,'') AS month_label,
            SUM(amount::numeric)::text AS total
     FROM sale_line
     WHERE fy = $1 AND version_status = 'current'
     GROUP BY month_label`,
    [fy],
  );
  const amountBefore = new Map<string, number>(
    beforeRows.rows.map((r) => [r.month_label, parseFloat(r.total ?? "0")]),
  );

  // 2. Load all current rows for the FY.
  const rows = await db
    .select({
      lineUid: saleLines.lineUid,
      invoiceNo: saleLines.invoiceNo,
      code: saleLines.code,
      color: saleLines.color,
      qty: saleLines.qty,
      monthLabel: saleLines.monthLabel,
      ingestedAt: saleLines.ingestedAt,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")));

  // 3. Group by identity key.
  type RowInfo = {
    lineUid: string;
    ingestedAt: Date | null;
    monthLabel: string | null;
  };
  const groups = new Map<string, RowInfo[]>();

  for (const row of rows) {
    const key = [
      row.invoiceNo ?? "",
      row.code,
      row.color ?? "",
      row.qty ?? "",
      row.monthLabel ?? "",
    ].join("|");
    const arr = groups.get(key) ?? [];
    arr.push({
      lineUid: row.lineUid,
      ingestedAt: row.ingestedAt,
      monthLabel: row.monthLabel,
    });
    groups.set(key, arr);
  }

  // 4. Within each group, sort newest-first.  Winner = [0].
  type SupersedeTask = {
    lineUid: string;
    winnerUid: string;
    winnerIngestedAt: Date;
    monthLabel: string | null;
  };
  const tasks: SupersedeTask[] = [];

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => {
      const ta = a.ingestedAt?.getTime() ?? 0;
      const tb = b.ingestedAt?.getTime() ?? 0;
      if (ta !== tb) return tb - ta; // newest first
      return b.lineUid.localeCompare(a.lineUid); // tie-break
    });
    const winner = group[0];
    const winnerAt = winner.ingestedAt ?? new Date();
    for (const loser of group.slice(1)) {
      tasks.push({
        lineUid: loser.lineUid,
        winnerUid: winner.lineUid,
        winnerIngestedAt: winnerAt,
        monthLabel: loser.monthLabel,
      });
    }
  }

  logger.info(
    { fy, totalRows: rows.length, identityGroups: groups.size, toSupersede: tasks.length, dryRun },
    "reconcileVersions: analysis complete",
  );

  // 5. Apply (skip if dry run).
  if (!dryRun && tasks.length > 0) {
    // Use VALUES-table approach via parameterised raw SQL for efficiency.
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);
      const uids = batch.map((t) => t.lineUid);
      // Build a lookup in JS then issue individual per-uid updates in a transaction.
      // For moderate batch sizes (<1000) this is fast enough.
      await db.transaction(async (tx) => {
        for (const task of batch) {
          await tx
            .update(saleLines)
            .set({
              versionStatus: "superseded",
              supersededAt: task.winnerIngestedAt,
              supersededBy: task.winnerUid,
            })
            .where(eq(saleLines.lineUid, task.lineUid));
        }
      });
    }
    logger.info({ fy, superseded: tasks.length }, "reconcileVersions: DB updated");
  }

  // 6. Capture per-month amounts AFTER the pass.
  const afterRows = await pool.query<{ month_label: string; total: string }>(
    `SELECT COALESCE(month_label,'') AS month_label,
            SUM(amount::numeric)::text AS total
     FROM sale_line
     WHERE fy = $1 AND version_status = 'current'
     GROUP BY month_label`,
    [fy],
  );
  const amountAfter = new Map<string, number>(
    afterRows.rows.map((r) => [r.month_label, parseFloat(r.total ?? "0")]),
  );

  // 7. Build per-month breakdown.
  // Count rows per month (examined, superseded, current).
  const examinedByMonth = new Map<string, number>();
  const supersededByMonth = new Map<string, number>();
  for (const row of rows) {
    const m = row.monthLabel ?? "";
    examinedByMonth.set(m, (examinedByMonth.get(m) ?? 0) + 1);
  }
  for (const task of tasks) {
    const m = task.monthLabel ?? "";
    supersededByMonth.set(m, (supersededByMonth.get(m) ?? 0) + 1);
  }

  const months = [...new Set([...examinedByMonth.keys(), ...amountBefore.keys()])].sort();
  const byMonth: MonthStat[] = months
    .filter((m) => m !== "") // skip blank month_label bucket
    .map((m) => {
      const examined = examinedByMonth.get(m) ?? 0;
      const sup = supersededByMonth.get(m) ?? 0;
      return {
        month: m,
        examined,
        superseded: sup,
        current: examined - sup,
        amountBefore: Math.round(amountBefore.get(m) ?? 0),
        amountAfter: Math.round(amountAfter.get(m) ?? 0),
      };
    });

  return {
    fy,
    dryRun,
    totalExamined: rows.length,
    totalSuperseded: tasks.length,
    totalCurrent: rows.length - tasks.length,
    byMonth,
    durationMs: Date.now() - t0,
  };
}
