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
  rowsMatched: number;             // matched by (invoice_no, serial_no)
  rowsMatchedByFallback: number;   // matched by (invoice_no, code, qty) fallback — single variant
  rowsFallbackCollision: number;   // fallback found 2+ colours — stayed NULL
  rowsUnmatched: number;           // no match by either method — stayed NULL
  rowsAlreadyColored: number;      // already had a color (skipped)
  durationMs: number;
};

// ── Step 1: Backfill colour ───────────────────────────────────────────────────

/**
 * Reads the live SALE SHEET for the given FY and batch-updates DB rows whose
 * color is NULL using a two-pass matching strategy:
 *
 * Primary match  — (invoice_no, serial_no): exact join on the source-sheet
 *   row number. Works for rows whose serial was not renumbered by editing.
 *
 * Fallback match — (invoice_no, code, qty): used when the primary key fails
 *   (e.g. heavy editing renumbered the serial column).
 *   GUARD: assigns colour ONLY when the tuple maps to exactly one distinct
 *   colour variant in the sheet. Two or more variants means the colour is
 *   ambiguous; those rows are left NULL and logged as collisions.
 *   This guard must stay in place even when today's data has zero collisions —
 *   future months and other FYs may have multi-variant tuples.
 *
 * dryRun=true reports counts without writing anything.
 */
export async function backfillColor(
  fy: string,
  spreadsheetId: string,
  dryRun: boolean,
): Promise<BackfillColorResult> {
  const t0 = Date.now();

  // 1. One sheet-read pass: build BOTH match maps simultaneously.
  //
  //    colorBySerial     : "inv|serial"         → color | null
  //    colorByInvCodeQty : "inv|code|qty"       → Set<color>
  //
  // qty is normalised to a plain number-string so DB and sheet values
  // compare equal regardless of decimal representation.
  const colorBySerial     = new Map<string, string | null>();
  const colorByInvCodeQty = new Map<string, Set<string>>();
  let rowsScanned = 0;

  await readRegisterFromSheets(spreadsheetId, fy, (values, columns, tabMonthLabel) => {
    const result = parseRegisterRow(values, columns, fy, tabMonthLabel);
    if (result.kind !== "row") return;
    const { row } = result;
    rowsScanned++;

    // Primary map: (invoice, serial) → color
    if (row.invoiceNo != null && row.serialNo != null) {
      const key = `${row.invoiceNo}|${row.serialNo}`;
      if (!colorBySerial.has(key)) colorBySerial.set(key, row.color ?? null);
    }

    // Fallback map: (invoice, code, qty) → Set<color>
    // Only build if all three fields are present.
    if (row.invoiceNo != null && row.code != null && row.qty != null) {
      const qtyStr = String(row.qty); // already a number from parseRegisterRow
      const key = `${row.invoiceNo}|${row.code}|${qtyStr}`;
      const colorToken = row.color != null && row.color !== ""
        ? row.color       // real colour value ("WHITE", ".", etc.)
        : "__BLANK__";    // treat blank colour as a distinct sentinel
      const set = colorByInvCodeQty.get(key) ?? new Set<string>();
      set.add(colorToken);
      colorByInvCodeQty.set(key, set);
    }
  });

  logger.info(
    {
      fy,
      rowsScanned,
      serialMappings: colorBySerial.size,
      invCodeQtyMappings: colorByInvCodeQty.size,
      dryRun,
    },
    "backfillColor: sheet read complete",
  );

  // 2. Load all DB rows for this FY (current + superseded both get colour).
  const dbRows = await db
    .select({
      lineUid: saleLines.lineUid,
      invoiceNo: saleLines.invoiceNo,
      serialNo: saleLines.serialNo,
      code: saleLines.code,
      qty: saleLines.qty,
      color: saleLines.color,
    })
    .from(saleLines)
    .where(eq(saleLines.fy, fy));

  let rowsMatched          = 0;
  let rowsMatchedByFallback = 0;
  let rowsFallbackCollision = 0;
  let rowsUnmatched        = 0;
  let rowsAlreadyColored   = 0;

  type Update = { lineUid: string; color: string | null };
  const updates: Update[] = [];

  for (const row of dbRows) {
    // Already has a colour — skip entirely.
    if (row.color != null) {
      rowsAlreadyColored++;
      continue;
    }

    // ── Primary match: (invoice, serial) ────────────────────────────────────
    if (row.invoiceNo != null && row.serialNo != null) {
      const key = `${row.invoiceNo}|${row.serialNo}`;
      if (colorBySerial.has(key)) {
        updates.push({ lineUid: row.lineUid, color: colorBySerial.get(key) ?? null });
        rowsMatched++;
        continue;
      }
    }

    // ── Fallback match: (invoice, code, qty) — single-variant guard ─────────
    //
    // Attempt only when primary match fails (no serial, or serial not in map).
    // qty from Drizzle is a string representation of the numeric column.
    if (row.invoiceNo != null && row.code != null && row.qty != null) {
      const qtyStr = String(row.qty);
      const key = `${row.invoiceNo}|${row.code}|${qtyStr}`;
      const variants = colorByInvCodeQty.get(key);

      if (variants && variants.size === 1) {
        // Single variant: unambiguous — assign it.
        const colorToken = [...variants][0]!;
        // Convert the __BLANK__ sentinel back to null so we don't persist the
        // internal sentinel string into the database.
        const colorToStore = colorToken === "__BLANK__" ? null : colorToken;
        updates.push({ lineUid: row.lineUid, color: colorToStore });
        rowsMatchedByFallback++;
        continue;
      }

      if (variants && variants.size > 1) {
        // Multi-variant tuple: COLLISION — cannot determine the correct colour.
        // Leave NULL and log so the operator can investigate.
        rowsFallbackCollision++;
        logger.warn(
          {
            fy,
            invoiceNo: row.invoiceNo,
            code: row.code,
            qty: qtyStr,
            variants: [...variants],
          },
          "backfillColor: fallback collision — tuple has multiple colour variants; row left NULL",
        );
        continue;
      }
    }

    // No match by either method.
    rowsUnmatched++;
  }

  logger.info(
    {
      fy,
      rowsMatched,
      rowsMatchedByFallback,
      rowsFallbackCollision,
      rowsUnmatched,
      rowsAlreadyColored,
      dryRun,
    },
    "backfillColor: match summary",
  );

  // 3. Apply updates in batches (skip if dry run).
  if (!dryRun && updates.length > 0) {
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      // Group by color value to minimise round-trips.
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
    logger.info(
      { fy, updated: updates.length, bySerial: rowsMatched, byFallback: rowsMatchedByFallback },
      "backfillColor: DB updated",
    );
  }

  return {
    fy,
    dryRun,
    rowsScanned,
    rowsMatched,
    rowsMatchedByFallback,
    rowsFallbackCollision,
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
     FROM sale_line_all
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
     FROM sale_line_all
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
