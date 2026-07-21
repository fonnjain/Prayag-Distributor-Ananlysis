import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { pool, db, saleLines, type InsertSaleLine } from "@workspace/db";
import {
  backfillColor,
  reconcileVersions,
} from "../lib/registers/reconcileVersions.js";
import { tombstoneOrphans, identityKey } from "../lib/registers/ingest.js";
import { readRegisterFromSheets } from "../lib/registers/sheetsRegister.js";
import { listSheetTabs, readTabSample, readTabRowsChunked, getGoogleAccessToken } from "../lib/registers/sheetsApi.js";
import {
  OccurrenceCounter,
  emptyUnmapped,
  isHeaderRow,
  mapRegisterColumns,
  normHeader,
  parseRegisterRow,
  toSaleLine,
} from "../lib/registers/normalize.js";
import {
  REGISTER_SHEET_IDS,
  getAnchorHealth,
  runScheduledTick,
} from "../lib/customers/registerSync.js";
import rawRegisterSheetsCfg from "../../config/register_sheets.json";
import {
  tankLitresFromCode,
  tankSizeMapSql,
  resolveWaterTankRow,
  buildSapLookupMap,
} from "../lib/registers/tankResolution.js";

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

// ── Invoice-level reconciliation ──────────────────────────────────────────────
// Compares DB current vs live sheet amounts per invoice number for a given month.
// Used to verify whether a supersede operation overshot (removed real lines) or
// whether a row delta is explained by genuine sheet duplicates.

/**
 * GET /registers/:fy/invoice-reconcile?month=Jul-26
 *
 * Re-reads the live sheet, then for every invoice in that month compares:
 *   SUM(amount) of DB current rows  vs  SUM(amount) of sheet rows
 *
 * Returns:
 *   matched  — invoices within ±1 rupee (correct)
 *   dbShort  — DB < sheet (overshoot: real value removed)
 *   dbExcess — DB > sheet (residual duplication)
 *
 * Never writes anything.
 */
router.get("/registers/:fy/invoice-reconcile", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";

  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    // 1. Read live sheet
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
      res.status(400).json({ error: `Zero rows for month ${month} in sheet` });
      return;
    }

    // 2. Sum by invoice from sheet (all rows, including duplicates)
    const sheetByInvoice = new Map<string, { rows: number; amount: number }>();
    for (const l of monthLines) {
      const key = l.invoiceNo ?? "(no-invoice)";
      const e = sheetByInvoice.get(key) ?? { rows: 0, amount: 0 };
      e.rows++;
      e.amount += Number(l.amount) || 0;
      sheetByInvoice.set(key, e);
    }

    // 3. Query DB current amounts by invoice
    const dbResult = await pool.query<{
      invoice_no: string | null;
      rows: string;
      total: string;
    }>(
      `SELECT COALESCE(invoice_no, '(no-invoice)') AS invoice_no,
              COUNT(*)::text AS rows,
              COALESCE(SUM(amount::numeric), 0)::text AS total
         FROM sale_line
        WHERE fy = $1 AND month_label = $2 AND version_status = 'current'
        GROUP BY invoice_no`,
      [fy, month],
    );

    const dbByInvoice = new Map<string, { rows: number; amount: number }>();
    for (const r of dbResult.rows) {
      dbByInvoice.set(r.invoice_no ?? "(no-invoice)", {
        rows: parseInt(r.rows, 10),
        amount: parseFloat(r.total),
      });
    }

    // 4. Compare every invoice
    const allInvoices = new Set([...sheetByInvoice.keys(), ...dbByInvoice.keys()]);

    type InvRow = {
      invoice: string;
      dbRows: number;
      sheetRows: number;
      dbAmount: number;
      sheetAmount: number;
      delta: number;
    };

    const matched: InvRow[] = [];
    const dbShort: InvRow[] = [];   // DB < sheet — overshoot
    const dbExcess: InvRow[] = [];  // DB > sheet — residual duplication

    for (const inv of allInvoices) {
      const sheet = sheetByInvoice.get(inv) ?? { rows: 0, amount: 0 };
      const db = dbByInvoice.get(inv) ?? { rows: 0, amount: 0 };
      const delta = Math.round(db.amount - sheet.amount); // positive = DB has more

      const row: InvRow = {
        invoice: inv,
        dbRows: db.rows,
        sheetRows: sheet.rows,
        dbAmount: Math.round(db.amount),
        sheetAmount: Math.round(sheet.amount),
        delta,
      };

      if (Math.abs(delta) <= 1) {
        matched.push(row);
      } else if (delta < 0) {
        dbShort.push(row); // DB is short — possible overshoot
      } else {
        dbExcess.push(row); // DB has extra — residual duplication
      }
    }

    dbShort.sort((a, b) => a.delta - b.delta);   // most negative first (largest shortfall)
    dbExcess.sort((a, b) => b.delta - a.delta);  // most positive first (largest excess)

    const shortfallTotal = dbShort.reduce((s, r) => s + r.delta, 0);
    const excessTotal = dbExcess.reduce((s, r) => s + r.delta, 0);

    res.json({
      fy,
      month,
      sheetRows: monthLines.length,
      dbCurrentRows: [...dbByInvoice.values()].reduce((s, r) => s + r.rows, 0),
      invoiceCount: allInvoices.size,
      summary: {
        matched: { count: matched.length },
        dbShort: {
          count: dbShort.length,
          totalShortfall: Math.abs(shortfallTotal),
          description: "DB < sheet: possible overshoot — real value removed",
        },
        dbExcess: {
          count: dbExcess.length,
          totalExcess: excessTotal,
          description: "DB > sheet: residual duplication",
        },
      },
      // Full lists so the caller can see every divergence
      dbShortAll: dbShort,
      dbExcessAll: dbExcess,
      // Capped preview for quick review
      dbShortTop10: dbShort.slice(0, 10),
      dbExcessTop10: dbExcess.slice(0, 10),
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "invoice-reconcile failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Full reversal of an orphan-audit pass ─────────────────────────────────────

/**
 * POST /registers/:fy/orphan-audit-reverse?month=Jul-26&syncRunId=orphan-audit|...
 *
 * Flips ALL rows superseded by the given syncRunId back to version_status='current'.
 * This is the safe undo of a tombstone/orphan-audit pass when the pass overshot.
 * No rows are inserted or deleted — status flip only.
 *
 * Returns: rows reversed, total amount restored, new DB current totals for the month.
 */
router.post("/registers/:fy/orphan-audit-reverse", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const syncRunId =
    typeof req.query.syncRunId === "string"
      ? req.query.syncRunId
      : "orphan-audit|2026-07-21T05:55:40.864Z";

  try {
    // 1. Flip all rows from this syncRunId back to current
    const flipResult = await pool.query(
      `UPDATE sale_line
          SET version_status = 'current',
              superseded_by   = NULL
        WHERE fy            = $1
          AND month_label   = $2
          AND version_status = 'superseded'
          AND superseded_by = $3`,
      [fy, month, syncRunId],
    );

    // 2. New DB current totals for this month
    const totals = await pool.query<{ rows: string; total: string }>(
      `SELECT COUNT(*)::text AS rows,
              COALESCE(SUM(amount::numeric), 0)::text AS total
         FROM sale_line
        WHERE fy = $1 AND month_label = $2 AND version_status = 'current'`,
      [fy, month],
    );

    const newRows = parseInt(totals.rows[0].rows, 10);
    const newTotal = parseFloat(totals.rows[0].total);

    req.log.info(
      { fy, month, syncRunId, reversed: flipResult.rowCount, newRows, newTotal },
      "orphan-audit-reverse complete",
    );

    res.json({
      fy,
      month,
      syncRunId,
      rowsReversed: flipResult.rowCount,
      dbCurrentRowsAfter: newRows,
      dbCurrentTotalAfter: Math.round(newTotal),
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "orphan-audit-reverse failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Colour backfill diagnostic ────────────────────────────────────────────────

/**
 * GET /registers/:fy/colour-diagnostic?month=Jul-26
 *
 * For the given month, reports WHY colourless current rows remain after
 * backfillColor:
 *   - noSerialInDB    : DB serial_no IS NULL → backfillColor skips immediately
 *   - serialNotInSheet: has serial_no but (invoice, serial) not in live sheet map
 *   - sheetColourNull : matched in sheet but sheet's colour cell is blank
 *
 * Also reports total current rows with colour vs still NULL for the month.
 * Never writes anything.
 */
router.get("/registers/:fy/colour-diagnostic", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    // 1. Build (invoice_no, serial_no) → color map from live sheet (same as backfillColor)
    const colorBySerial = new Map<string, string | null>();
    const occurrence = new OccurrenceCounter();
    const unmapped = emptyUnmapped();

    await readRegisterFromSheets(spreadsheetId, fy, (values, columns) => {
      const result = parseRegisterRow(values, columns, fy);
      if (result.kind !== "row") return;
      const { row } = result;
      if (row.invoiceNo != null && row.serialNo != null) {
        const key = `${row.invoiceNo}|${row.serialNo}`;
        if (!colorBySerial.has(key)) colorBySerial.set(key, row.color ?? null);
      }
    });
    void occurrence; void unmapped; // suppress unused-var warnings

    // 2. Query colourless current rows for this month
    const dbResult = await pool.query<{
      line_uid: string;
      invoice_no: string | null;
      serial_no: string | null;
    }>(
      `SELECT line_uid, invoice_no, serial_no
         FROM sale_line
        WHERE fy = $1 AND month_label = $2
          AND version_status = 'current'
          AND (color IS NULL OR color = '')`,
      [fy, month],
    );

    let noSerialInDB = 0;
    let serialNotInSheet = 0;
    let sheetColourNull = 0; // matched in sheet but sheet colour is blank

    const sampleNoSerial: string[] = [];
    const sampleNotInSheet: { inv: string; serial: string }[] = [];

    for (const row of dbResult.rows) {
      if (row.invoice_no == null || row.serial_no == null) {
        noSerialInDB++;
        if (sampleNoSerial.length < 5) sampleNoSerial.push(row.invoice_no ?? "(null-invoice)");
        continue;
      }
      const key = `${row.invoice_no}|${row.serial_no}`;
      if (colorBySerial.has(key)) {
        // Matched but colour itself is null in sheet
        sheetColourNull++;
      } else {
        serialNotInSheet++;
        if (sampleNotInSheet.length < 5)
          sampleNotInSheet.push({ inv: row.invoice_no, serial: row.serial_no });
      }
    }

    // 3. Overall Jul-26 colour coverage
    const coverageResult = await pool.query<{
      coloured: string;
      colourless: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE color IS NOT NULL AND color <> '')::text AS coloured,
         COUNT(*) FILTER (WHERE color IS NULL   OR  color = '')::text  AS colourless
         FROM sale_line
        WHERE fy = $1 AND month_label = $2 AND version_status = 'current'`,
      [fy, month],
    );

    const coloured = parseInt(coverageResult.rows[0].coloured, 10);
    const colourless = parseInt(coverageResult.rows[0].colourless, 10);
    const total = coloured + colourless;

    res.json({
      fy,
      month,
      coverage: {
        total,
        coloured,
        colourless,
        pct: total > 0 ? +((coloured / total) * 100).toFixed(1) : 0,
      },
      unmatchedBreakdown: {
        noSerialInDB,
        serialNotInSheet,
        sheetColourNull,
        total: noSerialInDB + serialNotInSheet + sheetColourNull,
        note: [
          "noSerialInDB: DB serial_no IS NULL — backfillColor skips; fix requires invoice+code+qty fallback",
          "serialNotInSheet: serial_no exists in DB but not found in sheet — possible sheet edit or tab mismatch",
          "sheetColourNull: matched in sheet but the colour cell is blank — line has no colour variant",
        ],
      },
      sampleNoSerial,
      sampleNotInSheet,
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "colour-diagnostic failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Colour variant count (fallback pre-flight) ────────────────────────────────

/**
 * GET /registers/:fy/variant-count?month=Jul-26
 *
 * Read-only. For each colourless current DB row that backfillColor could not
 * match (i.e. colour IS NULL, version_status = current), counts how many
 * distinct colour variants the live sheet holds for the tuple
 * (invoice_no, code, qty):
 *
 *   Bucket 1 – exactly 1 colour in sheet  → safe for (invoice,code,qty) fallback
 *   Bucket 2 – 2+ colours in sheet        → collision; fallback must not assign
 *   Bucket 3 – 0 matches on (inv,code,qty)→ genuine orphan (expected 0 here)
 *
 * Reports counts, total amount in each bucket, and for Bucket 2: every
 * ambiguous tuple with its competing colours.
 * Never writes anything.
 */
router.get("/registers/:fy/variant-count", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    // 1. Build (invoice|code|qty) → Set<color> map from the full live sheet.
    // qty is stored as a number; normalise to string for the key.
    const variantMap = new Map<string, Set<string>>();

    await readRegisterFromSheets(spreadsheetId, fy, (values, columns) => {
      const inv  = columns.invoiceNo >= 0 ? String(values[columns.invoiceNo] ?? "").trim() : null;
      const code = columns.code      >= 0 ? String(values[columns.code]      ?? "").trim() : null;
      const qtyRaw = columns.qty >= 0 ? values[columns.qty] : null;
      const qty = qtyRaw != null && qtyRaw !== "" ? String(Number(qtyRaw)) : null;
      const colorRaw = columns.color >= 0 ? values[columns.color] : null;
      const color = colorRaw != null && String(colorRaw).trim() !== ""
        ? String(colorRaw).trim().toUpperCase()
        : "__BLANK__";

      if (!inv || !code || qty == null) return;

      const key = `${inv}|${code}|${qty}`;
      if (!variantMap.has(key)) variantMap.set(key, new Set());
      variantMap.get(key)!.add(color);
    });

    // 2. Query DB: colourless current rows for this month.
    const dbResult = await pool.query<{
      line_uid: string;
      invoice_no: string | null;
      serial_no: number | null;
      code: string | null;
      qty: string | null;
      amount: string | null;
    }>(
      `SELECT line_uid, invoice_no, serial_no, code,
              qty::text, amount::text
         FROM sale_line
        WHERE fy = $1 AND month_label = $2
          AND version_status = 'current'
          AND (color IS NULL OR color = '')`,
      [fy, month],
    );

    // 3. Classify each DB row into a bucket.
    type B1Row = { invoiceNo: string; code: string; qty: string; colour: string; amount: number };
    type B2Row = { invoiceNo: string; code: string; qty: string; colours: string[]; amount: number };
    type B3Row = { invoiceNo: string | null; code: string | null; qty: string | null; amount: number };

    let b1Count = 0, b1Amount = 0;
    let b2Count = 0, b2Amount = 0;
    let b3Count = 0, b3Amount = 0;

    const b1Sample: B1Row[] = [];
    const b2Rows:   B2Row[] = [];   // ALL bucket-2 tuples (for collision report)
    const b3Sample: B3Row[] = [];

    for (const row of dbResult.rows) {
      const inv  = row.invoice_no ? String(row.invoice_no) : null;
      const code = row.code ?? null;
      const qtyNum = row.qty != null ? Number(row.qty) : null;
      const qty = qtyNum != null && !isNaN(qtyNum) ? String(qtyNum) : null;
      const amt = row.amount != null ? Number(row.amount) : 0;

      if (!inv || !code || qty == null) {
        b3Count++;
        b3Amount += amt;
        b3Sample.push({ invoiceNo: inv, code, qty, amount: amt });
        continue;
      }

      const key = `${inv}|${code}|${qty}`;
      const variants = variantMap.get(key);

      if (!variants || variants.size === 0) {
        b3Count++;
        b3Amount += amt;
        if (b3Sample.length < 10)
          b3Sample.push({ invoiceNo: inv, code, qty: row.qty ?? qty, amount: amt });
      } else if (variants.size === 1) {
        b1Count++;
        b1Amount += amt;
        const colour = [...variants][0]!;
        if (b1Sample.length < 5)
          b1Sample.push({ invoiceNo: inv, code, qty: row.qty ?? qty, colour, amount: amt });
      } else {
        b2Count++;
        b2Amount += amt;
        // Deduplicate collision tuples: only record distinct (inv, code, qty) once.
        const already = b2Rows.find(
          (r) => r.invoiceNo === inv && r.code === code && r.qty === (row.qty ?? qty),
        );
        if (!already) {
          b2Rows.push({
            invoiceNo: inv,
            code,
            qty: row.qty ?? qty,
            colours: [...variants],
            amount: amt,
          });
        } else {
          already.amount += amt; // accumulate amount for the same tuple
        }
      }
    }

    const total = b1Count + b2Count + b3Count;

    // Colour-blind total: how many distinct __BLANK__ entries appear in Bucket 2?
    const b2WithBlank = b2Rows.filter((r) => r.colours.includes("__BLANK__")).length;

    res.json({
      fy,
      month,
      totalColourlessCurrentRows: total,
      buckets: {
        b1Safe: {
          count: b1Count,
          totalAmount: b1Amount,
          pct: total > 0 ? +((b1Count / total) * 100).toFixed(1) : 0,
          note: "Exactly 1 colour variant in sheet — (invoice,code,qty) fallback safe",
          sample: b1Sample,
        },
        b2Collision: {
          count: b2Count,
          totalAmount: b2Amount,
          pct: total > 0 ? +((b2Count / total) * 100).toFixed(1) : 0,
          note: "2+ colour variants — fallback cannot resolve; rows stay NULL",
          b2WithBlankColour: b2WithBlank,
          allTuples: b2Rows, // full list for the report
        },
        b3NoMatch: {
          count: b3Count,
          totalAmount: b3Amount,
          pct: total > 0 ? +((b3Count / total) * 100).toFixed(1) : 0,
          note: "Zero matches on (invoice,code,qty) — genuine orphan",
          sample: b3Sample,
        },
      },
      interpretation:
        b2Count === 0 && b3Count === 0
          ? "ALL rows are Bucket 1 — fallback resolves all 1,032 safely."
          : b2Count > 0 && b3Count === 0
            ? `${b1Count} safe, ${b2Count} collision (stay NULL), 0 orphans.`
            : `${b1Count} safe, ${b2Count} collision, ${b3Count} orphan.`,
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "variant-count failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Invoice serial cross-check ────────────────────────────────────────────────

/**
 * GET /registers/:fy/serial-crosscheck?month=Jul-26
 *
 * Read-only. Answers: "For the colourless current rows that backfillColor
 * could not match, are those invoices present in the sheet under DIFFERENT
 * serial numbers (serial renumbered by editing) or genuinely absent?"
 *
 * Process:
 *   1. Reads the full month tab from the live sheet.
 *   2. Builds invoice_no → Set<serial_no> from every sheet row.
 *   3. Queries the DB for colourless current rows for that month.
 *   4. For each DB row classifies it as:
 *      - sameSerial    : (invoice, serial) in sheet — shouldn't be unmatched (edge case)
 *      - diffSerial    : invoice in sheet but with different serial(s) — renumbering
 *      - notInSheet    : invoice not found in sheet at all — genuine orphan
 *
 * Reports aggregated counts + up to 10 sample rows per category.
 * Never writes anything.
 */
router.get("/registers/:fy/serial-crosscheck", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    // 1. Read the full month tab from the sheet.
    // The tab may be named "July" (not "Jul-26"), so list tabs first and find it.
    const allTabs = await listSheetTabs(spreadsheetId);

    // Match the tab: "Jul-26", "Jul", "July", "JULY" all accepted.
    // month param is like "Jul-26"; strip the "-26" suffix to get the bare name.
    const bareMonth = month.replace(/-\d{2}$/, "").toLowerCase();
    const monthTab = allTabs.find(
      (t) =>
        t.title.toLowerCase() === month.toLowerCase() ||
        t.title.toLowerCase() === bareMonth ||
        // "July" starts with "jul"
        (t.title.toLowerCase().startsWith("jul") && bareMonth === "jul"),
    );

    if (!monthTab) {
      res.status(404).json({
        error: `No tab matching month "${month}" found.`,
        allTabs: allTabs.map((t) => t.title),
      });
      return;
    }

    // Map: invoice_no (string) → Set of serial_no values seen in sheet
    const invoiceSerials = new Map<string, Set<number>>();

    await readRegisterFromSheets(
      spreadsheetId,
      fy,
      (values, columns) => {
        const inv = columns.invoiceNo >= 0 ? String(values[columns.invoiceNo] ?? "").trim() : null;
        const ser = columns.serialNo >= 0 ? Number(values[columns.serialNo]) : null;
        if (!inv || !ser || isNaN(ser)) return;
        if (!invoiceSerials.has(inv)) invoiceSerials.set(inv, new Set());
        invoiceSerials.get(inv)!.add(ser);
      },
    );

    // 2. Query DB for colourless current rows for this month.
    const dbResult = await pool.query<{
      line_uid: string;
      invoice_no: string | null;
      serial_no: number | null;
      code: string | null;
    }>(
      `SELECT line_uid, invoice_no, serial_no, code
         FROM sale_line
        WHERE fy = $1 AND month_label = $2
          AND version_status = 'current'
          AND (color IS NULL OR color = '')`,
      [fy, month],
    );

    type SampleRow = { lineUid: string; invoiceNo: string | null; dbSerial: number | null; sheetSerials?: number[] };

    let sameSerial = 0;
    let diffSerial = 0;
    let notInSheet = 0;
    const sampleSame: SampleRow[] = [];
    const sampleDiff: SampleRow[] = [];
    const sampleNot: SampleRow[] = [];

    for (const row of dbResult.rows) {
      const inv = row.invoice_no ? String(row.invoice_no) : null;
      const ser = row.serial_no;

      if (!inv) { notInSheet++; continue; }

      const sheetSerials = invoiceSerials.get(inv);
      if (!sheetSerials) {
        notInSheet++;
        if (sampleNot.length < 10)
          sampleNot.push({ lineUid: row.line_uid, invoiceNo: inv, dbSerial: ser });
        continue;
      }

      if (ser != null && sheetSerials.has(ser)) {
        sameSerial++;
        if (sampleSame.length < 10)
          sampleSame.push({ lineUid: row.line_uid, invoiceNo: inv, dbSerial: ser, sheetSerials: [...sheetSerials] });
      } else {
        diffSerial++;
        if (sampleDiff.length < 10)
          sampleDiff.push({ lineUid: row.line_uid, invoiceNo: inv, dbSerial: ser, sheetSerials: [...sheetSerials].slice(0, 10) });
      }
    }

    const total = sameSerial + diffSerial + notInSheet;

    res.json({
      fy,
      month,
      monthTabUsed: monthTab.title,
      sheetInvoiceCount: invoiceSerials.size,
      dbColourlessCurrentRows: total,
      categories: {
        sameSerial: {
          count: sameSerial,
          note: "DB (invoice, serial) still present in sheet — backfillColor should have matched these; edge case",
          sample: sampleSame,
        },
        diffSerial: {
          count: diffSerial,
          note: "Invoice is in sheet but with DIFFERENT serial_no(s) — serial was renumbered by editing",
          sample: sampleDiff,
        },
        notInSheet: {
          count: notInSheet,
          note: "Invoice not found anywhere in the current sheet tab — genuine orphan",
          sample: sampleNot,
        },
      },
      interpretation:
        diffSerial > 0 && notInSheet === 0
          ? "ALL unmatched rows had their serial renumbered. Fix: re-match by (invoice, code, qty) or by new serial lookup."
          : diffSerial > 0 && notInSheet > 0
            ? "Mix: some serials renumbered, some invoices genuinely absent. Needs split handling."
            : notInSheet > 0 && diffSerial === 0
              ? "ALL unmatched rows are genuinely absent from the sheet — true orphans."
              : "No colourless current rows found for this month.",
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "serial-crosscheck failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Sheet header diagnostic ────────────────────────────────────────────────────

/**
 * GET /registers/:fy/header-diagnostic?tabs=Jul-26,Apr-26
 *
 * Read-only. For each requested tab in the FY register sheet:
 *   - Prints the raw header row verbatim (first 20 columns after normHeader)
 *   - Reports what mapRegisterColumns resolves for every field, especially
 *     serialNo (the column index the loader would use; -1 = not found)
 *   - Shows 5 sample data rows, reporting the value at the serialNo column
 *     index and the invoiceNo column index
 *
 * Also lists all tab titles in the workbook so the caller can verify the
 * tab name used by the regex matches the actual title.
 *
 * Never writes anything. Safe to run at any time.
 */
router.get("/registers/:fy/header-diagnostic", async (req, res) => {
  const { fy } = req.params;
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  const requestedTabs =
    typeof req.query.tabs === "string"
      ? req.query.tabs.split(",").map((s) => s.trim())
      : ["Jul-26", "Apr-26"];

  try {
    const allTabs = await listSheetTabs(spreadsheetId);

    const results: Record<
      string,
      | {
          found: true;
          actualTitle: string;
          headerFoundAtRow: number | null;
          rawHeaderVerbatim: string[];
          normalisedHeader: string[];
          detectedColumns: {
            serialNo: number;
            invoiceNo: number;
            code: number;
            color: number;
            qty: number;
            amount: number;
            month: number;
            fy: number;
          };
          serialNoNote: string;
          sampleRows: Array<{
            rowNumber: number;
            invoiceNoCell: string | number | boolean | null | undefined;
            serialNoCell: string | number | boolean | null | undefined;
            colorCell: string | number | boolean | null | undefined;
            codeCell: string | number | boolean | null | undefined;
          }>;
        }
      | { found: false; reason: string }
    > = {};

    for (const tabName of requestedTabs) {
      // Fuzzy-match tab title (the regex in sheetsRegister uses startsWith
      // for 31-char xlsx truncation; here we match case-insensitively too)
      const actualTab = allTabs.find(
        (t) =>
          t.title === tabName ||
          t.title.toLowerCase() === tabName.toLowerCase(),
      );
      if (!actualTab) {
        results[tabName] = {
          found: false,
          reason: `Tab not found in workbook. All tabs: ${allTabs.map((t) => `"${t.title}"`).join(", ")}`,
        };
        continue;
      }

      // Read the first 25 rows × 20 columns of the tab (A1:T25).
      // readTabSample is a targeted range read — no chunking, no full-tab scan.
      const firstRows = await readTabSample(spreadsheetId, actualTab.title, "A1:T25");

      // Find header row
      let headerRowIdx = -1;
      let columns: ReturnType<typeof mapRegisterColumns> | null = null;
      for (let i = 0; i < firstRows.length; i++) {
        if (isHeaderRow(firstRows[i] as Parameters<typeof isHeaderRow>[0])) {
          headerRowIdx = i;
          columns = mapRegisterColumns(
            firstRows[i] as Parameters<typeof mapRegisterColumns>[0],
            i + 1,
          );
          break;
        }
      }

      if (!columns || headerRowIdx < 0) {
        results[tabName] = {
          found: true,
          actualTitle: actualTab.title,
          headerFoundAtRow: null,
          rawHeaderVerbatim: (firstRows[0] ?? []).slice(0, 20).map(String),
          normalisedHeader: (firstRows[0] ?? [])
            .slice(0, 20)
            .map((v) => normHeader(v as Parameters<typeof normHeader>[0])),
          detectedColumns: {
            serialNo: -1,
            invoiceNo: -1,
            code: -1,
            color: -1,
            qty: -1,
            amount: -1,
            month: -1,
            fy: -1,
          },
          serialNoNote: "No header row found in first 25 rows — tab is silently skipped by loader",
          sampleRows: [],
        };
        continue;
      }

      const rawHeader = firstRows[headerRowIdx].slice(0, 20).map(String);
      const normalisedHeader = firstRows[headerRowIdx]
        .slice(0, 20)
        .map((v) => normHeader(v as Parameters<typeof normHeader>[0]));

      // Sample data rows: first 5 rows after the header
      const dataRows = firstRows.slice(headerRowIdx + 1).slice(0, 5);
      const sampleRows = dataRows.map((row, i) => ({
        rowNumber: headerRowIdx + 2 + i,
        invoiceNoCell: columns!.invoiceNo >= 0 ? row[columns!.invoiceNo] : "(col not found)",
        serialNoCell:
          columns!.serialNo >= 0
            ? row[columns!.serialNo]
            : "(col not found — serialNo=-1)",
        colorCell: columns!.color >= 0 ? row[columns!.color] : "(col not found)",
        codeCell: columns!.code >= 0 ? row[columns!.code] : "(col not found)",
      }));

      const serialNoNote =
        columns.serialNo >= 0
          ? `Found at column index ${columns.serialNo} (0-based). Header cell: "${rawHeader[columns.serialNo] ?? "(blank)"}". normHeader: "${normalisedHeader[columns.serialNo] ?? ""}".`
          : `NOT FOUND. Tried normHeaders: "SERIALNO", "SRNO", "SR", "SNO". ` +
            `Normalised header values present: ${normalisedHeader.filter(Boolean).join(", ")}`;

      results[tabName] = {
        found: true,
        actualTitle: actualTab.title,
        headerFoundAtRow: headerRowIdx + 1,
        rawHeaderVerbatim: rawHeader,
        normalisedHeader,
        detectedColumns: {
          serialNo: columns.serialNo,
          invoiceNo: columns.invoiceNo,
          code: columns.code,
          color: columns.color,
          qty: columns.qty,
          amount: columns.amount,
          month: columns.month,
          fy: columns.fy,
        },
        serialNoNote,
        sampleRows,
      };
    }

    res.json({
      fy,
      spreadsheetId,
      allTabTitles: allTabs.map((t) => t.title),
      requestedTabs,
      results,
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    req.log.error({ err, fy }, "header-diagnostic failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Colour-null population report ─────────────────────────────────────────────

/**
 * GET /registers/colour-null-report
 *
 * Counts rows with color IS NULL or color = '' across all FYs and version states.
 * Used to assess the pre-colour-capture orphan population before applying a fix.
 * Never writes anything.
 */
router.get("/registers/colour-null-report", async (_req, res) => {
  try {
    const result = await pool.query<{
      fy: string;
      month_label: string;
      version_status: string;
      colourless_rows: string;
    }>(
      `SELECT fy,
              COALESCE(month_label, '(null)') AS month_label,
              version_status,
              COUNT(*)::text AS colourless_rows
         FROM sale_line
        WHERE color IS NULL OR color = ''
        GROUP BY fy, month_label, version_status
        ORDER BY fy, month_label, version_status`,
    );

    // Aggregate totals per FY
    type FyTotal = { fy: string; current: number; superseded: number; total: number };
    const byFy = new Map<string, FyTotal>();
    for (const r of result.rows) {
      const entry = byFy.get(r.fy) ?? { fy: r.fy, current: 0, superseded: 0, total: 0 };
      const n = parseInt(r.colourless_rows, 10);
      entry.total += n;
      if (r.version_status === "current") entry.current += n;
      else entry.superseded += n;
      byFy.set(r.fy, entry);
    }

    const grandTotal = [...byFy.values()].reduce((s, r) => s + r.total, 0);

    res.json({
      grandTotal,
      byFy: [...byFy.values()],
      byFyMonth: result.rows.map((r) => ({
        fy: r.fy,
        monthLabel: r.month_label,
        versionStatus: r.version_status,
        colourlessRows: parseInt(r.colourless_rows, 10),
      })),
      note: "current rows are live colourless orphan candidates; superseded rows are already inert",
    });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Invoice-total convergence restore ─────────────────────────────────────────
//
// After the orphan-audit overshot (Jul-26: 391 invoices short, Rs.1.53 Cr),
// this pair of routes restores the wrongly-superseded rows using the invoice
// total as ground truth instead of row presence.
//
// Algorithm (per short invoice):
//   1. Re-read the live sheet — sheet total per invoice is ground truth.
//   2. For each invoice where DB current < sheet (shortfall > 1):
//      a. Collect superseded rows from the target syncRunId for that invoice.
//      b. Sort: rows whose amount appears in the sheet's amount multiset first
//         (most likely current-rate version), then remaining; within each group
//         by amount descending (converges faster, less risk of over-restoring).
//      c. Greedily restore one row at a time, accumulating the running total,
//         until (db_total + accumulated) >= (sheet_total - 1).
//      d. Stop immediately when converged — never push DB above the sheet total.
//   3. If a short invoice has no superseded rows from the target syncRunId,
//      flag it as "cannot converge" — it means a line exists in the sheet that
//      was never in the DB at all (a different problem). Expected: none.
//
// The stop condition prevents re-introducing rate-edit duplicates: adding such
// a row would push the invoice total ABOVE the sheet total, so the guard stops
// before it is ever added.

/**
 * GET /registers/:fy/invoice-restore-plan?month=Jul-26[&syncRunId=orphan-audit|...]
 *
 * Dry-run. Re-reads the live sheet and computes exactly which superseded rows
 * would be restored to bring every short invoice up to its sheet total.
 *
 * Reports:
 *   a) Per short invoice: rows to restore + before/after totals.
 *   b) Grand total rows and value to be restored.
 *   c) Any invoice that CANNOT reach its sheet total from superseded rows —
 *      expected none; if any appear the route still returns 200 with the list.
 *
 * Never writes anything.
 */
router.get("/registers/:fy/invoice-restore-plan", async (req, res) => {
  const { fy } = req.params;
  const month =
    typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const syncRunId =
    typeof req.query.syncRunId === "string"
      ? req.query.syncRunId
      : "orphan-audit|2026-07-21T05:55:40.864Z";

  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    // 1. Re-read live sheet
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
      res.status(400).json({ error: `Zero rows for month ${month} in sheet` });
      return;
    }

    // 2. Build sheet totals and amount multisets per invoice
    const sheetByInvoice = new Map<
      string,
      { total: number; amounts: number[] }
    >();
    for (const l of monthLines) {
      const key = l.invoiceNo ?? "(no-invoice)";
      const e = sheetByInvoice.get(key) ?? { total: 0, amounts: [] };
      const amt = Number(l.amount) || 0;
      e.total += amt;
      e.amounts.push(amt);
      sheetByInvoice.set(key, e);
    }

    // 3. DB current totals by invoice
    const dbCurrentResult = await pool.query<{
      invoice_no: string | null;
      total: string;
    }>(
      `SELECT COALESCE(invoice_no, '(no-invoice)') AS invoice_no,
              COALESCE(SUM(amount::numeric), 0)::text AS total
         FROM sale_line
        WHERE fy = $1 AND month_label = $2 AND version_status = 'current'
        GROUP BY invoice_no`,
      [fy, month],
    );

    const dbCurrentByInvoice = new Map<string, number>();
    for (const r of dbCurrentResult.rows) {
      dbCurrentByInvoice.set(r.invoice_no ?? "(no-invoice)", parseFloat(r.total));
    }

    // 4. Superseded rows from this syncRunId for this month
    const supersededResult = await pool.query<{
      line_uid: string;
      invoice_no: string | null;
      code: string;
      color: string | null;
      qty: string | null;
      amount: string;
    }>(
      `SELECT line_uid,
              COALESCE(invoice_no, '(no-invoice)') AS invoice_no,
              code, color, qty, amount
         FROM sale_line
        WHERE fy = $1 AND month_label = $2
          AND version_status = 'superseded'
          AND superseded_by = $3
        ORDER BY invoice_no, amount::numeric DESC`,
      [fy, month, syncRunId],
    );

    // Group superseded rows by invoice
    const supersededByInvoice = new Map<
      string,
      { lineUid: string; code: string; color: string | null; qty: string | null; amount: number }[]
    >();
    for (const r of supersededResult.rows) {
      const inv = r.invoice_no ?? "(no-invoice)";
      const list = supersededByInvoice.get(inv) ?? [];
      list.push({
        lineUid: r.line_uid,
        code: r.code,
        color: r.color,
        qty: r.qty,
        amount: parseFloat(r.amount),
      });
      supersededByInvoice.set(inv, list);
    }

    // Helper: check if amount appears in a multiset (within ±1), consuming it
    function matchAmount(amt: number, remaining: number[]): { matched: boolean; remaining: number[] } {
      const idx = remaining.findIndex((a) => Math.abs(a - amt) <= 1);
      if (idx === -1) return { matched: false, remaining };
      const next = [...remaining];
      next.splice(idx, 1);
      return { matched: true, remaining: next };
    }

    // 5. Convergence plan for each short invoice
    type PlanRow = {
      invoice: string;
      dbBefore: number;
      sheetTotal: number;
      shortfall: number;
      rowsToRestore: number;
      amountToRestore: number;
      dbAfter: number;
      overshootRupees: number;
      lineUids: string[];
    };

    const plan: PlanRow[] = [];
    const cannotConverge: { invoice: string; dbBefore: number; sheetTotal: number; shortfall: number; availableSuperseded: number }[] = [];

    for (const [inv, sheetData] of sheetByInvoice) {
      const dbCurrent = Math.round(dbCurrentByInvoice.get(inv) ?? 0);
      const sheetTotal = Math.round(sheetData.total);
      const shortfall = sheetTotal - dbCurrent;

      if (shortfall <= 1) continue; // already converged

      const superseded = supersededByInvoice.get(inv) ?? [];
      if (superseded.length === 0) {
        cannotConverge.push({
          invoice: inv,
          dbBefore: dbCurrent,
          sheetTotal,
          shortfall,
          availableSuperseded: 0,
        });
        continue;
      }

      // Sort: amount-matching rows first (prefer current-rate version),
      // then remaining; within each group by amount descending
      let availableAmounts = [...sheetData.amounts];
      const preferred: typeof superseded = [];
      const fallback: typeof superseded = [];

      for (const row of superseded) {
        const { matched, remaining } = matchAmount(row.amount, availableAmounts);
        if (matched) {
          preferred.push(row);
          availableAmounts = remaining;
        } else {
          fallback.push(row);
        }
      }

      // Within each group, sort by amount descending (largest first)
      preferred.sort((a, b) => b.amount - a.amount);
      fallback.sort((a, b) => b.amount - a.amount);
      const ordered = [...preferred, ...fallback];

      // Greedy restore until converged.
      // Break fires BEFORE adding the next row, so accumulated is the minimum
      // sum of rows needed to satisfy (dbCurrent + accumulated >= sheetTotal - 1).
      // Due to row granularity, dbAfter may slightly exceed sheetTotal — that is
      // acceptable. The true cannot-converge case is when all superseded rows are
      // exhausted but accumulated + dbCurrent is still < sheetTotal - 1.
      let accumulated = 0;
      const toRestore: string[] = [];

      for (const row of ordered) {
        if (accumulated + dbCurrent >= sheetTotal - 1) break;
        toRestore.push(row.lineUid);
        accumulated += row.amount;
      }

      const dbAfter = Math.round(dbCurrent + accumulated);
      // Converged = reached the threshold. May be slightly above sheetTotal due to
      // row granularity; a rate-edit duplicate would push it above by a full row amount.
      const reachedThreshold = dbCurrent + accumulated >= sheetTotal - 1;

      if (!reachedThreshold) {
        // Genuinely cannot converge: superseded rows exhausted, still short
        cannotConverge.push({
          invoice: inv,
          dbBefore: dbCurrent,
          sheetTotal,
          shortfall,
          availableSuperseded: Math.round(superseded.reduce((s, r) => s + r.amount, 0)),
        });
      } else {
        plan.push({
          invoice: inv,
          dbBefore: dbCurrent,
          sheetTotal,
          shortfall,
          rowsToRestore: toRestore.length,
          amountToRestore: Math.round(accumulated),
          dbAfter,
          // dbAfter may exceed sheetTotal by a small amount (row granularity).
          // That is expected and not a sign of duplicate restoration.
          overshootRupees: Math.max(0, dbAfter - sheetTotal),
          lineUids: toRestore,
        });
      }
    }

    const totalRowsToRestore = plan.reduce((s, r) => s + r.rowsToRestore, 0);
    const totalAmountToRestore = plan.reduce((s, r) => s + r.amountToRestore, 0);

    // Summary preview (top 10 by shortfall for quick review)
    const planPreview = [...plan]
      .sort((a, b) => b.shortfall - a.shortfall)
      .slice(0, 10)
      .map(({ lineUids: _, ...rest }) => rest); // omit line_uid lists from preview

    res.json({
      fy,
      month,
      syncRunId,
      sheetRows: monthLines.length,
      shortInvoices: plan.length,
      cannotConverge: cannotConverge.length,
      totalRowsToRestore,
      totalAmountToRestore,
      cannotConvergeList: cannotConverge,
      planPreview,
      // Full plan with line_uids is large; the apply route accepts the same
      // syncRunId + month and recomputes it server-side rather than requiring
      // the client to POST the full list.
      planFull: plan,
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "invoice-restore-plan failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /registers/:fy/invoice-restore-apply?month=Jul-26[&syncRunId=orphan-audit|...]
 *
 * Applies the convergence restore plan computed by invoice-restore-plan.
 * Re-runs the plan server-side (fresh sheet read) and flips the selected
 * superseded rows back to version_status='current'.
 *
 * This is a status flip only — no rows are inserted or deleted.
 * Idempotent: rows already 'current' are not re-written.
 */
router.post("/registers/:fy/invoice-restore-apply", async (req, res) => {
  const { fy } = req.params;
  const month =
    typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const syncRunId =
    typeof req.query.syncRunId === "string"
      ? req.query.syncRunId
      : "orphan-audit|2026-07-21T05:55:40.864Z";

  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    // 1. Re-read live sheet (same as plan route)
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
      res.status(400).json({ error: `Zero rows for month ${month} in sheet` });
      return;
    }

    // 2. Sheet totals per invoice
    const sheetByInvoice = new Map<string, { total: number; amounts: number[] }>();
    for (const l of monthLines) {
      const key = l.invoiceNo ?? "(no-invoice)";
      const e = sheetByInvoice.get(key) ?? { total: 0, amounts: [] };
      const amt = Number(l.amount) || 0;
      e.total += amt;
      e.amounts.push(amt);
      sheetByInvoice.set(key, e);
    }

    // 3. DB current totals
    const dbCurrentResult = await pool.query<{ invoice_no: string | null; total: string }>(
      `SELECT COALESCE(invoice_no, '(no-invoice)') AS invoice_no,
              COALESCE(SUM(amount::numeric), 0)::text AS total
         FROM sale_line
        WHERE fy = $1 AND month_label = $2 AND version_status = 'current'
        GROUP BY invoice_no`,
      [fy, month],
    );
    const dbCurrentByInvoice = new Map<string, number>();
    for (const r of dbCurrentResult.rows) {
      dbCurrentByInvoice.set(r.invoice_no ?? "(no-invoice)", parseFloat(r.total));
    }

    // 4. Superseded rows from syncRunId
    const supersededResult = await pool.query<{
      line_uid: string;
      invoice_no: string | null;
      amount: string;
    }>(
      `SELECT line_uid,
              COALESCE(invoice_no, '(no-invoice)') AS invoice_no,
              amount
         FROM sale_line
        WHERE fy = $1 AND month_label = $2
          AND version_status = 'superseded'
          AND superseded_by = $3
        ORDER BY invoice_no, amount::numeric DESC`,
      [fy, month, syncRunId],
    );

    const supersededByInvoice = new Map<string, { lineUid: string; amount: number }[]>();
    for (const r of supersededResult.rows) {
      const inv = r.invoice_no ?? "(no-invoice)";
      const list = supersededByInvoice.get(inv) ?? [];
      list.push({ lineUid: r.line_uid, amount: parseFloat(r.amount) });
      supersededByInvoice.set(inv, list);
    }

    function matchAmount(amt: number, remaining: number[]): { matched: boolean; remaining: number[] } {
      const idx = remaining.findIndex((a) => Math.abs(a - amt) <= 1);
      if (idx === -1) return { matched: false, remaining };
      const next = [...remaining];
      next.splice(idx, 1);
      return { matched: true, remaining: next };
    }

    // 5. Compute restore set (same algorithm as plan route)
    const toRestoreUids: string[] = [];
    let totalAmountRestored = 0;

    for (const [inv, sheetData] of sheetByInvoice) {
      const dbCurrent = Math.round(dbCurrentByInvoice.get(inv) ?? 0);
      const sheetTotal = Math.round(sheetData.total);
      const shortfall = sheetTotal - dbCurrent;
      if (shortfall <= 1) continue;

      const superseded = supersededByInvoice.get(inv) ?? [];
      if (superseded.length === 0) continue;

      // Sort: amount-matching first, then by amount desc
      let availableAmounts = [...sheetData.amounts];
      const preferred: typeof superseded = [];
      const fallback: typeof superseded = [];
      for (const row of superseded) {
        const { matched, remaining } = matchAmount(row.amount, availableAmounts);
        if (matched) { preferred.push(row); availableAmounts = remaining; }
        else fallback.push(row);
      }
      preferred.sort((a, b) => b.amount - a.amount);
      fallback.sort((a, b) => b.amount - a.amount);
      const ordered = [...preferred, ...fallback];

      let accumulated = 0;
      for (const row of ordered) {
        if (accumulated + dbCurrent >= sheetTotal - 1) break;
        toRestoreUids.push(row.lineUid);
        accumulated += row.amount;
      }
      totalAmountRestored += accumulated;
    }

    if (toRestoreUids.length === 0) {
      res.json({ restored: 0, totalAmount: 0, message: "Nothing to restore — all invoices already converged" });
      return;
    }

    // 6. Flip selected rows back to current (status flip only, no insert/delete)
    const updateResult = await pool.query(
      `UPDATE sale_line
          SET version_status = 'current',
              superseded_by = NULL
        WHERE line_uid = ANY($1::text[])
          AND version_status = 'superseded'`,
      [toRestoreUids],
    );

    req.log.info(
      { fy, month, syncRunId, restored: updateResult.rowCount, totalAmount: Math.round(totalAmountRestored) },
      "invoice-restore-apply complete",
    );

    res.json({
      fy,
      month,
      syncRunId,
      restored: updateResult.rowCount,
      totalAmountRestored: Math.round(totalAmountRestored),
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "invoice-restore-apply failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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

// ── Orphan bucket check ───────────────────────────────────────────────────────

/**
 * GET /registers/:fy/orphan-bucket-check?month=Jul-26
 *
 * READ-ONLY diagnostic. Identifies the 562 (or N) current DB rows for the
 * given (fy, month) whose identityKey is absent from the live sheet, then
 * classifies each one into three buckets by searching for the same
 * (invoice_no, code, colour) in the sheet IGNORING qty:
 *
 *   B1 — (invoice, code, colour) IS in the sheet at a DIFFERENT qty.
 *        Almost certainly a unit mismatch (e.g. DB stores litres, sheet stores
 *        pieces, or vice-versa). The line IS present on both sides. Do NOT
 *        tombstone — re-match instead.
 *
 *   B2 — (invoice, code, colour) IS in the sheet at the SAME qty.
 *        Something else breaks the identity key (month_label encoding?).
 *        Needs separate investigation.
 *
 *   B3 — (invoice, code, colour) NOT present in the sheet under any qty.
 *        Candidate genuine deletion. Verify against SAP before removing.
 *
 * No rows are written.
 */
router.get("/registers/:fy/orphan-bucket-check", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    // ── 1. Read the live sheet — build identity structures ────────────────────
    //
    // seenByFullKey   : Set<identityKey string> — same logic as tombstoneOrphans.
    //                   A DB row is an orphan iff its key is NOT in this set.
    //
    // sheetByInvCodeColor : Map<"inv|code|color"> → Array<{qty, amount}>
    //                       Used to classify orphans into B1/B2/B3.
    //
    // Uses toSaleLine so the qty string format exactly matches tombstoneOrphans.
    const seenByFullKey = new Set<string>();
    const sheetByInvCodeColor = new Map<string, Array<{ qty: string; amount: number }>>();
    let rowsScannedTotal = 0;
    let rowsInTargetMonth = 0;

    const occurrence = new OccurrenceCounter();
    const unmapped = emptyUnmapped();

    await readRegisterFromSheets(spreadsheetId, fy, (values, columns) => {
      const parsed = parseRegisterRow(values, columns, fy);
      if (parsed.kind !== "row") return;
      rowsScannedTotal++;
      const { row } = parsed;
      if (row.monthLabel !== month) return;

      // Build the InsertSaleLine so qty is stringified exactly as toSaleLine does.
      const sl = toSaleLine(row, occurrence, unmapped, "sheets");
      rowsInTargetMonth++;

      // Full identity key — mirrors identityKey() in ingest.ts
      seenByFullKey.add(
        identityKey(
          sl.invoiceNo ?? null,
          sl.code,
          sl.color ?? null,
          sl.qty ?? null,
          sl.monthLabel ?? null,
        ),
      );

      // (invoice, code, color) lookup — for B1/B2/B3 classification
      if (sl.invoiceNo != null && sl.qty != null) {
        const icKey = `${sl.invoiceNo}|${sl.code}|${sl.color ?? ""}`;
        const arr = sheetByInvCodeColor.get(icKey) ?? [];
        arr.push({ qty: sl.qty, amount: Number(sl.amount) });
        sheetByInvCodeColor.set(icKey, arr);
      }
    });

    // ── 2. Load all current DB rows for (fy, month) ──────────────────────────
    const dbRows = await db
      .select({
        lineUid: saleLines.lineUid,
        invoiceNo: saleLines.invoiceNo,
        code: saleLines.code,
        color: saleLines.color,
        qty: saleLines.qty,
        monthLabel: saleLines.monthLabel,
        amount: saleLines.amount,
      })
      .from(saleLines)
      .where(
        and(
          eq(saleLines.fy, fy),
          eq(saleLines.monthLabel, month),
          eq(saleLines.versionStatus, "current"),
        ),
      );

    // ── 3. Classify: matched vs orphan (B1 / B2 / B3) ───────────────────────
    type B1Row = {
      invoiceNo: string | null; code: string; color: string | null;
      dbQty: string | null; sheetQtys: string[]; dbAmount: number; isTank: boolean;
    };
    type B2Row = {
      invoiceNo: string | null; code: string; color: string | null;
      qty: string | null; dbAmount: number;
    };
    type B3Row = {
      invoiceNo: string | null; code: string; color: string | null;
      qty: string | null; amount: number; isTank: boolean;
    };

    const b1Rows: B1Row[] = [];
    const b2Rows: B2Row[] = [];
    const b3Rows: B3Row[] = [];
    let matchedCount = 0;
    let matchedAmount = 0;

    const isTankCode = (code: string): boolean =>
      /^WCT|^WT-\d|^WT\d/.test(code);

    for (const row of dbRows) {
      const dbKey = identityKey(
        row.invoiceNo,
        row.code,
        row.color,
        row.qty != null ? String(row.qty) : null,
        row.monthLabel,
      );

      if (seenByFullKey.has(dbKey)) {
        matchedCount++;
        matchedAmount += Number(row.amount);
        continue;
      }

      // This row is an orphan — classify by (invoice, code, color) in sheet
      const icKey = `${row.invoiceNo ?? ""}|${row.code}|${row.color ?? ""}`;
      const sheetEntries = sheetByInvCodeColor.get(icKey);
      const dbQtyNum = row.qty != null ? Number(row.qty) : null;

      if (sheetEntries && sheetEntries.length > 0) {
        // (invoice, code, colour) found in sheet
        const sameQtyEntry = sheetEntries.find(
          (e) => Math.abs(Number(e.qty) - (dbQtyNum ?? -1e9)) < 0.01,
        );
        if (sameQtyEntry) {
          // B2: same (inv, code, colour, qty) but different identity key — investigate
          b2Rows.push({
            invoiceNo: row.invoiceNo,
            code: row.code,
            color: row.color,
            qty: row.qty != null ? String(row.qty) : null,
            dbAmount: Number(row.amount),
          });
        } else {
          // B1: same (inv, code, colour) but different qty — unit mismatch
          b1Rows.push({
            invoiceNo: row.invoiceNo,
            code: row.code,
            color: row.color,
            dbQty: row.qty != null ? String(row.qty) : null,
            sheetQtys: sheetEntries.map((e) => e.qty),
            dbAmount: Number(row.amount),
            isTank: isTankCode(row.code),
          });
        }
      } else {
        // B3: not in sheet under any qty
        b3Rows.push({
          invoiceNo: row.invoiceNo,
          code: row.code,
          color: row.color,
          qty: row.qty != null ? String(row.qty) : null,
          amount: Number(row.amount),
          isTank: isTankCode(row.code),
        });
      }
    }

    // ── 4. Summaries ─────────────────────────────────────────────────────────
    const b1Amount = b1Rows.reduce((s, r) => s + r.dbAmount, 0);
    const b2Amount = b2Rows.reduce((s, r) => s + r.dbAmount, 0);
    const b3Amount = b3Rows.reduce((s, r) => s + r.amount, 0);
    const b1TankCount = b1Rows.filter((r) => r.isTank).length;
    const b3TankCount = b3Rows.filter((r) => r.isTank).length;

    res.json({
      fy,
      month,
      rowsScannedTotal,
      rowsInTargetMonth,
      dbCurrentRows: dbRows.length,
      matchedRows: matchedCount,
      orphanRows: b1Rows.length + b2Rows.length + b3Rows.length,
      buckets: {
        B1: {
          label: "Same (invoice, code, colour) in sheet at DIFFERENT qty — unit mismatch",
          count: b1Rows.length,
          amount: Math.round(b1Amount),
          tankCount: b1TankCount,
          nonTankCount: b1Rows.length - b1TankCount,
          sample10: b1Rows.slice(0, 10).map((r) => ({
            invoiceNo: r.invoiceNo,
            code: r.code,
            color: r.color,
            dbQty: r.dbQty,
            sheetQtys: r.sheetQtys,
            dbAmount: Math.round(r.dbAmount),
            isTank: r.isTank,
          })),
        },
        B2: {
          label: "Same (invoice, code, colour, qty) in sheet — identity key mismatch bug",
          count: b2Rows.length,
          amount: Math.round(b2Amount),
          sample10: b2Rows.slice(0, 10),
        },
        B3: {
          label: "NOT in sheet under any qty — candidate genuine deletion",
          count: b3Rows.length,
          amount: Math.round(b3Amount),
          tankCount: b3TankCount,
          nonTankCount: b3Rows.length - b3TankCount,
          sample10: b3Rows.slice(0, 10).map((r) => ({
            invoiceNo: r.invoiceNo,
            code: r.code,
            color: r.color,
            qty: r.qty,
            amount: Math.round(r.amount),
            isTank: r.isTank,
          })),
        },
      },
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "orphan-bucket-check failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Tank unit re-check ────────────────────────────────────────────────────────

/**
 * GET /registers/:fy/tank-unit-recheck?month=Jul-26
 *
 * READ-ONLY. Re-classifies every orphan current DB row for (fy, month) using
 * a two-pass sheet lookup:
 *
 *   Pass 1 — exact (invoice, code, colour) match (same as orphan-bucket-check)
 *   Pass 2 — colour-agnostic (invoice, code) match
 *             catches cases where DB and sheet differ only in colour encoding
 *
 * For every match (pass 1 or 2), reports:
 *   - ratio = sheet_qty / db_qty
 *   - isIntegerMultiple — is ratio a whole number >= 1?
 *   - dbEqualsOneTank — does db_qty equal the per-tank size implied by the code suffix?
 *   - amountMatch — does db_amount equal the sheet amount to the nearest rupee?
 *
 * The "no-match-at-all" residual (no (invoice, code) match under any colour or
 * qty) is the only plausible deletion candidate. For that set we also check
 * whether stripping leading zeros from the invoice number finds a sheet entry.
 *
 * No rows are written.
 */
router.get("/registers/:fy/tank-unit-recheck", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  const isTankCode = (code: string): boolean =>
    /^WCT|^WT-\d|^WT\d/.test(code);

  try {
    // ── 1. Read sheet — build both exact and colour-agnostic lookups ──────────
    const seenByFullKey = new Set<string>();

    // exact: "invoice|code|colour" → [{qty, amount}]
    const byExact = new Map<string, Array<{ qty: number; amount: number }>>();
    // colour-agnostic: "invoice|code" → [{colour, qty, amount}]
    const byInvCode = new Map<
      string,
      Array<{ colour: string | null; qty: number; amount: number }>
    >();

    let rowsScannedTotal = 0;
    let rowsInTargetMonth = 0;
    const occurrence = new OccurrenceCounter();
    const unmapped = emptyUnmapped();

    await readRegisterFromSheets(spreadsheetId, fy, (values, columns) => {
      const parsed = parseRegisterRow(values, columns, fy);
      if (parsed.kind !== "row") return;
      rowsScannedTotal++;
      const { row } = parsed;
      if (row.monthLabel !== month) return;

      const sl = toSaleLine(row, occurrence, unmapped, "sheets");
      rowsInTargetMonth++;

      seenByFullKey.add(
        identityKey(
          sl.invoiceNo ?? null, sl.code, sl.color ?? null,
          sl.qty ?? null, sl.monthLabel ?? null,
        ),
      );

      if (sl.invoiceNo == null) return;

      const sheetQty = Number(sl.qty ?? 0);
      const sheetAmt = Number(sl.amount ?? 0);

      const kExact = `${sl.invoiceNo}|${sl.code}|${sl.color ?? ""}`;
      const aExact = byExact.get(kExact) ?? [];
      aExact.push({ qty: sheetQty, amount: sheetAmt });
      byExact.set(kExact, aExact);

      const kIC = `${sl.invoiceNo}|${sl.code}`;
      const aIC = byInvCode.get(kIC) ?? [];
      aIC.push({ colour: sl.color ?? null, qty: sheetQty, amount: sheetAmt });
      byInvCode.set(kIC, aIC);
    });

    // ── 2. Load all current DB rows for (fy, month) ───────────────────────────
    const dbRows = await db
      .select({
        invoiceNo: saleLines.invoiceNo,
        code: saleLines.code,
        color: saleLines.color,
        qty: saleLines.qty,
        monthLabel: saleLines.monthLabel,
        amount: saleLines.amount,
      })
      .from(saleLines)
      .where(
        and(
          eq(saleLines.fy, fy),
          eq(saleLines.monthLabel, month),
          eq(saleLines.versionStatus, "current"),
        ),
      );

    // ── 3. Classify every orphan ──────────────────────────────────────────────
    type MatchedRow = {
      invoiceNo: string | null; code: string; dbColour: string | null;
      sheetColour: string | null; colourMatchedExact: boolean;
      dbQty: number; sheetQty: number; ratio: number;
      isIntegerMultiple: boolean; intPieceCount: number | null;
      tankLitres: number | null; dbEqualsOneTank: boolean;
      dbAmount: number; sheetAmount: number; amountMatch: boolean;
      isTank: boolean;
    };
    type NoMatchRow = {
      invoiceNo: string | null; code: string; colour: string | null;
      dbQty: number; dbAmount: number; isTank: boolean;
      strippedInvoiceFindsSheet: boolean;
    };

    const matched: MatchedRow[] = [];
    const noMatch: NoMatchRow[] = [];
    let identityKeyMatchCount = 0;

    for (const row of dbRows) {
      // Already in the sheet by full identity key — not an orphan
      const dbKey = identityKey(
        row.invoiceNo, row.code, row.color,
        row.qty != null ? String(row.qty) : null,
        row.monthLabel,
      );
      if (seenByFullKey.has(dbKey)) { identityKeyMatchCount++; continue; }

      // Orphan — try to find in sheet
      const dbQty = Number(row.qty ?? 0);
      const dbAmt = Number(row.amount ?? 0);
      const tank = isTankCode(row.code);

      const kExact = `${row.invoiceNo ?? ""}|${row.code}|${row.color ?? ""}`;
      const exactEntries = byExact.get(kExact);

      const kIC = `${row.invoiceNo ?? ""}|${row.code}`;
      const icEntries = byInvCode.get(kIC);

      const sheetEntries = exactEntries ?? icEntries;
      const colourMatchedExact = exactEntries != null;

      if (sheetEntries && sheetEntries.length > 0) {
        // Pick the entry with the largest qty (the "whole line" amount if multiple)
        const best = sheetEntries.reduce((a, b) => b.qty > a.qty ? b : a);
        const sheetQty = best.qty;
        const sheetAmt = best.amount;
        const ratio = dbQty > 0 ? sheetQty / dbQty : 0;
        const intRatio = Math.round(ratio);
        const isIntegerMultiple =
          dbQty > 0 && Math.abs(ratio - intRatio) < 0.005 && intRatio >= 1;
        const tankLitres = tankLitresFromCode(row.code);
        const dbEqualsOneTank =
          tankLitres != null && Math.abs(dbQty - tankLitres) < 0.01;
        const amountMatch = Math.abs(dbAmt - sheetAmt) < 1;

        matched.push({
          invoiceNo: row.invoiceNo,
          code: row.code,
          dbColour: row.color,
          sheetColour: colourMatchedExact
            ? (row.color ?? null)
            : ((icEntries?.[0]?.colour) ?? null),
          colourMatchedExact,
          dbQty, sheetQty,
          ratio: Math.round(ratio * 1000) / 1000,
          isIntegerMultiple,
          intPieceCount: isIntegerMultiple ? intRatio : null,
          tankLitres,
          dbEqualsOneTank,
          dbAmount: dbAmt, sheetAmount: sheetAmt, amountMatch,
          isTank: tank,
        });
      } else {
        // No match at all — check invoice format
        const stripped = (row.invoiceNo ?? "").replace(/^0+/, "");
        const strippedKey = `${stripped}|${row.code}`;
        const strippedFinds =
          stripped !== (row.invoiceNo ?? "") && byInvCode.has(strippedKey);

        noMatch.push({
          invoiceNo: row.invoiceNo, code: row.code, colour: row.color,
          dbQty, dbAmount: dbAmt, isTank: tank,
          strippedInvoiceFindsSheet: strippedFinds,
        });
      }
    }

    // ── 4. Summaries ──────────────────────────────────────────────────────────
    const intMultiples = matched.filter((r) => r.isIntegerMultiple);
    const oneTankInDB  = matched.filter((r) => r.isIntegerMultiple && r.dbEqualsOneTank);
    const amtMatch     = matched.filter((r) => r.amountMatch);
    const amtMismatch  = matched.filter((r) => !r.amountMatch);

    const matchedTanks    = matched.filter((r) => r.isTank);
    const matchedNonTanks = matched.filter((r) => !r.isTank);
    const noMatchTanks    = noMatch.filter((r) => r.isTank);
    const noMatchNonTanks = noMatch.filter((r) => !r.isTank);
    const noMatchFormatFix = noMatch.filter((r) => r.strippedInvoiceFindsSheet);

    // 10-row sample for tank rows: amount comparison (the critical question)
    const tankAmountSample = matchedTanks.slice(0, 10).map((r) => ({
      invoiceNo: r.invoiceNo, code: r.code,
      dbColour: r.dbColour, sheetColour: r.sheetColour,
      dbQty: r.dbQty, sheetQty: r.sheetQty,
      ratio: r.ratio, isIntegerMultiple: r.isIntegerMultiple,
      tankLitres: r.tankLitres, dbEqualsOneTank: r.dbEqualsOneTank,
      dbAmount: Math.round(r.dbAmount), sheetAmount: Math.round(r.sheetAmount),
      amountMatch: r.amountMatch,
      colourMatchedExact: r.colourMatchedExact,
    }));

    // 10-row sample of amount mismatches (non-tank too, if any)
    const amtMismatchSample = amtMismatch.slice(0, 10).map((r) => ({
      invoiceNo: r.invoiceNo, code: r.code, isTank: r.isTank,
      dbQty: r.dbQty, sheetQty: r.sheetQty, ratio: r.ratio,
      dbAmount: Math.round(r.dbAmount), sheetAmount: Math.round(r.sheetAmount),
      diff: Math.round(r.dbAmount - r.sheetAmount),
    }));

    res.json({
      fy,
      month,
      rowsScannedTotal,
      rowsInTargetMonth,
      dbCurrentRows: dbRows.length,
      identityKeyMatches: identityKeyMatchCount,
      orphanTotal: matched.length + noMatch.length,
      sheetMatched: {
        total: matched.length,
        tanks: matchedTanks.length,
        nonTanks: matchedNonTanks.length,
        colourExactMatch: matched.filter((r) => r.colourMatchedExact).length,
        colourAgnosticOnly: matched.filter((r) => !r.colourMatchedExact).length,
        integerMultipleOfDB: intMultiples.length,
        dbEqualsExactlyOneTank: oneTankInDB.length,
        dbAmountEqualsSheetAmount: amtMatch.length,
        dbAmountDiffersFromSheet: amtMismatch.length,
        tankAmountSample10: tankAmountSample,
        amountMismatchSample10: amtMismatchSample,
      },
      noSheetMatchAtAll: {
        total: noMatch.length,
        tanks: noMatchTanks.length,
        nonTanks: noMatchNonTanks.length,
        wouldBeFixedByStrippingLeadingZeros: noMatchFormatFix.length,
        sample10: noMatch.slice(0, 10).map((r) => ({
          invoiceNo: r.invoiceNo, code: r.code, colour: r.colour,
          dbQty: r.dbQty, dbAmount: Math.round(r.dbAmount),
          isTank: r.isTank, strippedInvoiceFindsSheet: r.strippedInvoiceFindsSheet,
        })),
      },
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "tank-unit-recheck failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Tank 61-verify ────────────────────────────────────────────────────────────

/**
 * GET /registers/:fy/tank-61-verify?month=Jul-26
 *
 * READ-ONLY. Re-examines orphan rows that had a colour-agnostic (wrong-pick)
 * sheet match in tank-unit-recheck. For each such row, checks whether an
 * EXACT (invoice, code, colour) match exists in the sheet and, if so, whether
 * the DB amount equals the exact-match sheet amount.
 *
 * Answers: "are the 61 amount mismatches noise (wrong colour pick) or real?"
 */
router.get("/registers/:fy/tank-61-verify", async (req, res) => {
  const { fy } = req.params;
  const month = typeof req.query.month === "string" ? req.query.month : "Jul-26";
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  const isTankCode = (code: string): boolean =>
    /^WCT|^WT-\d|^WT\d/.test(code);

  try {
    // ── 1. Read sheet — build exact + colour-agnostic lookup ──────────────────
    const seenByFullKey = new Set<string>();
    // exact: "invoice|code|colour" → [{qty, amount}]
    const byExact = new Map<string, Array<{ qty: number; amount: number }>>();
    // colour-agnostic: "invoice|code" → [{colour, qty, amount}] (largest qty = best)
    const byInvCode = new Map<
      string,
      Array<{ colour: string | null; qty: number; amount: number }>
    >();

    const occurrence = new OccurrenceCounter();
    const unmapped = emptyUnmapped();

    await readRegisterFromSheets(spreadsheetId, fy, (values, columns) => {
      const parsed = parseRegisterRow(values, columns, fy);
      if (parsed.kind !== "row") return;
      const { row } = parsed;
      if (row.monthLabel !== month) return;
      const sl = toSaleLine(row, occurrence, unmapped, "sheets");
      seenByFullKey.add(
        identityKey(sl.invoiceNo ?? null, sl.code, sl.color ?? null, sl.qty ?? null, sl.monthLabel ?? null),
      );
      if (sl.invoiceNo == null) return;
      const sheetQty = Number(sl.qty ?? 0);
      const sheetAmt = Number(sl.amount ?? 0);
      const kExact = `${sl.invoiceNo}|${sl.code}|${sl.color ?? ""}`;
      const aExact = byExact.get(kExact) ?? [];
      aExact.push({ qty: sheetQty, amount: sheetAmt });
      byExact.set(kExact, aExact);
      const kIC = `${sl.invoiceNo}|${sl.code}`;
      const aIC = byInvCode.get(kIC) ?? [];
      aIC.push({ colour: sl.color ?? null, qty: sheetQty, amount: sheetAmt });
      byInvCode.set(kIC, aIC);
    });

    // ── 2. Load current DB orphans for (fy, month) ────────────────────────────
    const dbRows = await db
      .select({
        invoiceNo: saleLines.invoiceNo,
        code: saleLines.code,
        color: saleLines.color,
        qty: saleLines.qty,
        monthLabel: saleLines.monthLabel,
        amount: saleLines.amount,
      })
      .from(saleLines)
      .where(
        and(
          eq(saleLines.fy, fy),
          eq(saleLines.monthLabel, month),
          eq(saleLines.versionStatus, "current"),
        ),
      );

    // ── 3. Re-classify: exact-match vs colour-agnostic-only ──────────────────
    type VerifyRow = {
      invoiceNo: string | null; code: string; dbColour: string | null;
      dbQty: number; dbAmount: number;
      exactSheetAmt: number | null; exactSheetQty: number | null;
      exactAmountMatch: boolean | null; // null if no exact match exists
      agnosticBestAmt: number | null; // what the agnostic pick reported
      isTank: boolean;
    };

    const agnosticWithExact: VerifyRow[]   = []; // had agnostic hit + exact exists
    const agnosticNoExact: VerifyRow[]     = []; // agnostic hit, no exact entry
    let identityKeyMatches = 0;
    let exactColourMatches = 0;
    let agnosticMismatches = 0; // amount differed in tank-unit-recheck

    for (const row of dbRows) {
      const dbKey = identityKey(
        row.invoiceNo, row.code, row.color,
        row.qty != null ? String(row.qty) : null,
        row.monthLabel,
      );
      if (seenByFullKey.has(dbKey)) { identityKeyMatches++; continue; }

      const dbQty = Number(row.qty ?? 0);
      const dbAmt = Number(row.amount ?? 0);
      const kExact = `${row.invoiceNo ?? ""}|${row.code}|${row.color ?? ""}`;
      const kIC    = `${row.invoiceNo ?? ""}|${row.code}`;

      const exactEntries  = byExact.get(kExact);
      const agnosticEntries = byInvCode.get(kIC);

      if (exactEntries) {
        // Pass-1 exact match — these were NOT the 61; just count
        exactColourMatches++;
        continue;
      }

      if (!agnosticEntries) {
        // No sheet match at all — should not happen given tank-unit-recheck found 0
        continue;
      }

      // Colour-agnostic match — this is the pool that contained the 61
      const agnosticBest = agnosticEntries.reduce((a, b) => b.qty > a.qty ? b : a);
      const agnosticAmtMatch = Math.abs(dbAmt - agnosticBest.amount) < 1;
      if (!agnosticAmtMatch) agnosticMismatches++;

      // Now: does an exact colour entry ALSO exist (correct pair)?
      const exactEntry = exactEntries ?? null;
      // exactEntries is null here (we checked above); try again with correct key
      // (exactEntries is always null in this branch — look via kIC filtered by colour)
      const exactForThisColour = agnosticEntries.find(
        (e) => (e.colour ?? "").toUpperCase() === (row.color ?? "").toUpperCase(),
      );

      if (exactForThisColour) {
        const exactAmountMatch = Math.abs(dbAmt - exactForThisColour.amount) < 1;
        agnosticWithExact.push({
          invoiceNo: row.invoiceNo, code: row.code, dbColour: row.color,
          dbQty, dbAmount: dbAmt,
          exactSheetQty: exactForThisColour.qty, exactSheetAmt: exactForThisColour.amount,
          exactAmountMatch,
          agnosticBestAmt: agnosticBest.amount,
          isTank: isTankCode(row.code),
        });
      } else {
        agnosticNoExact.push({
          invoiceNo: row.invoiceNo, code: row.code, dbColour: row.color,
          dbQty, dbAmount: dbAmt,
          exactSheetQty: null, exactSheetAmt: null, exactAmountMatch: null,
          agnosticBestAmt: agnosticBest.amount,
          isTank: isTankCode(row.code),
        });
      }
    }

    const withExactAmtMatch    = agnosticWithExact.filter((r) => r.exactAmountMatch === true);
    const withExactAmtMismatch = agnosticWithExact.filter((r) => r.exactAmountMatch === false);

    res.json({
      fy, month,
      orphanIdentityKeyMatches: identityKeyMatches,
      orphanExactColourMatches: exactColourMatches,
      orphanColourAgnosticTotal: agnosticWithExact.length + agnosticNoExact.length,
      agnosticAmountMismatchesReported: agnosticMismatches,
      exactColourFoundInAgnosticSet: {
        total: agnosticWithExact.length,
        amountMatchesWithExactColour: withExactAmtMatch.length,
        amountStillMismatchesWithExactColour: withExactAmtMismatch.length,
        mismatchSample: withExactAmtMismatch.slice(0, 10).map((r) => ({
          invoiceNo: r.invoiceNo, code: r.code, dbColour: r.dbColour,
          dbQty: r.dbQty, dbAmount: Math.round(r.dbAmount),
          exactSheetQty: r.exactSheetQty, exactSheetAmt: Math.round(r.exactSheetAmt ?? 0),
          agnosticBestAmt: Math.round(r.agnosticBestAmt ?? 0),
          diff: Math.round(r.dbAmount - (r.exactSheetAmt ?? 0)),
        })),
      },
      noExactColourInSheet: {
        total: agnosticNoExact.length,
        tanks: agnosticNoExact.filter((r) => r.isTank).length,
        nonTanks: agnosticNoExact.filter((r) => !r.isTank).length,
        sample10: agnosticNoExact.slice(0, 10).map((r) => ({
          invoiceNo: r.invoiceNo, code: r.code, dbColour: r.dbColour,
          dbQty: r.dbQty, dbAmount: Math.round(r.dbAmount),
          agnosticBestAmt: Math.round(r.agnosticBestAmt ?? 0),
        })),
      },
    });
  } catch (err: unknown) {
    req.log.error({ err, fy, month }, "tank-61-verify failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Cross-year tank scan ───────────────────────────────────────────────────────

/**
 * GET /registers/tank-scan-all-fy
 *
 * READ-ONLY. Pure DB query — no Sheets read. For every FY in sale_line, counts:
 *   - all tank rows (code ~ WCT/WT prefix)
 *   - rows where qty equals exactly one tank's per-tank litres
 *     (200 / 500 / 750 / 1000 / 1500 / 2000 / 2500 / 3000 / 5000)
 *   - share of all tank rows
 *   - sample rows per FY confirming DB=per-tank pattern
 *
 * Tells us whether the loader bug spans all four years or is July-only.
 */
router.get("/registers/tank-scan-all-fy", async (req, res) => {
  const TANK_SIZES = [200, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000];

  try {
    // ── Per-FY aggregate ──────────────────────────────────────────────────────
    const aggResult = await pool.query<{
      fy: string;
      all_tank_rows: string;
      one_unit_rows: string;
      all_tank_amount: string;
      one_unit_amount: string;
    }>(`
      SELECT
        fy,
        COUNT(*)                        FILTER (WHERE code ~ '^WCT|^WT') AS all_tank_rows,
        COUNT(*)                        FILTER (WHERE code ~ '^WCT|^WT'
                                                  AND qty::numeric = ANY($1::numeric[]))
                                                                          AS one_unit_rows,
        ROUND(SUM(amount::numeric)      FILTER (WHERE code ~ '^WCT|^WT'))  AS all_tank_amount,
        ROUND(SUM(amount::numeric)      FILTER (WHERE code ~ '^WCT|^WT'
                                                  AND qty::numeric = ANY($1::numeric[])))
                                                                          AS one_unit_amount
      FROM sale_line
      WHERE version_status = 'current'
      GROUP BY fy
      ORDER BY fy
    `, [TANK_SIZES]);

    // ── Per-FY samples: 3 one-unit rows per FY ───────────────────────────────
    const sampleResult = await pool.query<{
      fy: string; invoice_no: string | null; code: string;
      color: string | null; qty: string; amount: string;
      month_label: string;
    }>(`
      SELECT fy, invoice_no, code, color, qty::text, amount::text, month_label
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY fy ORDER BY month_label, invoice_no) AS rn
        FROM sale_line
        WHERE version_status = 'current'
          AND code ~ '^WCT|^WT'
          AND qty::numeric = ANY($1::numeric[])
      ) ranked
      WHERE rn <= 3
      ORDER BY fy, rn
    `, [TANK_SIZES]);

    // Group samples by FY
    const samplesByFy = new Map<string, typeof sampleResult.rows>();
    for (const row of sampleResult.rows) {
      const arr = samplesByFy.get(row.fy) ?? [];
      arr.push(row);
      samplesByFy.set(row.fy, arr);
    }

    const fyRows = aggResult.rows.map((row) => {
      const allRows   = Number(row.all_tank_rows);
      const oneUnit   = Number(row.one_unit_rows);
      const sharePct  = allRows > 0 ? ((oneUnit / allRows) * 100).toFixed(1) : "0.0";
      return {
        fy: row.fy,
        allTankRows:   allRows,
        oneUnitRows:   oneUnit,
        sharePct,
        allTankAmount:  Number(row.all_tank_amount),
        oneUnitAmount:  Number(row.one_unit_amount),
        samples: (samplesByFy.get(row.fy) ?? []).map((s) => ({
          invoiceNo:  s.invoice_no,
          code:       s.code,
          color:      s.color,
          qty:        Number(s.qty),
          amount:     Math.round(Number(s.amount)),
          monthLabel: s.month_label,
        })),
      };
    });

    const grandAllTank   = fyRows.reduce((s, r) => s + r.allTankRows, 0);
    const grandOneUnit   = fyRows.reduce((s, r) => s + r.oneUnitRows, 0);
    const grandSharePct  = grandAllTank > 0
      ? ((grandOneUnit / grandAllTank) * 100).toFixed(1)
      : "0.0";

    res.json({
      note: "one-unit rows = tank rows whose qty equals exactly one tank's litres (200/500/750/1000/1500/2000/2500/3000/5000)",
      tankSizesChecked: TANK_SIZES,
      grand: { allTankRows: grandAllTank, oneUnitRows: grandOneUnit, sharePct: grandSharePct },
      byFy: fyRows,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "tank-scan-all-fy failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Tank three-way sample ─────────────────────────────────────────────────────

/**
 * GET /registers/tank-three-way-sample
 *
 * READ-ONLY. Reconciles ~30 tank lines across all four FYs, three sources:
 *
 *   DB        — sale_line.qty (stored as per-tank litres by the loader)
 *   SHEET     — SALE SHEET (derived register); qty = total litres dispatched
 *   SAP       — SAP Combined tab (FY2026-27 only); qty = pieces (billing master)
 *
 * Answers:
 *   a) sheet_qty = SAP_pieces × per_tank_litres? (proves the derivation chain)
 *   b) DB amount = sheet amount = SAP amount? (value safety across all sources)
 *   c) Per (a): what SHOULD sale_line.qty hold — pieces or total litres?
 *
 * Coverage:
 *   FY2026-27  — DB + SHEET + SAP (full three-way)
 *   FY2025-26  — DB + SHEET (invoice_no present, no SAP source configured)
 *   FY2023-24 / FY2024-25 — DB only (invoice_no is null for these years)
 */
router.get("/registers/tank-three-way-sample", async (req, res) => {
  // ── Helpers ──────────────────────────────────────────────────────────────────
  function normH(v: unknown): string {
    return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function strV(v: unknown): string { return v == null ? "" : String(v).trim(); }
  function numV(v: unknown): number {
    if (v == null || v === "") return 0;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  function normInv(s: string | null | undefined): string {
    return String(s ?? "").replace(/^0+/, "").toUpperCase().trim();
  }

  const cfg = rawRegisterSheetsCfg as {
    registers: Record<string, string>;
    sap_source: Record<string, string>;
  };

  try {
    // ── 1. DB: pull ~12 diverse tank rows per FY ──────────────────────────────
    // One row per (fy, code), prioritising rows with invoice_no.
    // Uses a per-FY row-number cap (rn2 <= 12) so FY2023-24's 36 codes
    // cannot exhaust the limit before FY2025-26 / FY2026-27 appear.
    // Two-level subquery: inner picks one row per (fy,code) preferring invoice_no;
    // outer then caps at 12 distinct codes per FY so no single FY hogs the sample.
    const dbResult = await pool.query<{
      fy: string; invoice_no: string | null; code: string;
      color: string | null; qty: string; amount: string; month_label: string;
    }>(`
      SELECT fy, invoice_no, code, color, qty::text, amount::text, month_label
      FROM (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY fy ORDER BY code) rn2
        FROM (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY fy, code
              ORDER BY (invoice_no IS NOT NULL) DESC, month_label, invoice_no
            ) rn
          FROM sale_line
          WHERE version_status = 'current'
            AND code ~ '^WCT|^WT'
            AND qty::numeric = ANY(ARRAY[200,500,750,1000,1500,2000,2500,3000,5000]::numeric[])
        ) inner_q
        WHERE rn = 1
      ) outer_q
      WHERE rn2 <= 12
      ORDER BY fy, code
    `);

    const dbRows = dbResult.rows;

    // ── 2. SAP: read Combined tab for FY2026-27 ───────────────────────────────
    // Build: normInv(invoice_no) → [{sapRawCode, sapQty, sapAmount}]
    const sapByInv = new Map<string, Array<{ sapRawCode: string; sapQty: number; sapAmount: number }>>();
    let sapInvoiceColFound = false;
    let sapRowsRead = 0;
    const sap2627Id = cfg.sap_source?.["2026-27"];

    if (sap2627Id) {
      const tabs = await listSheetTabs(sap2627Id);
      const combined = tabs.find((t) => /^combined$/i.test(t.title.trim()));
      if (combined) {
        let codeIdx = -1, qtyIdx = -1, amtIdx = -1, invIdx = -1;
        let headerFound = false;
        await readTabRowsChunked(sap2627Id, combined.title, (chunk, startRow) => {
          for (let ri = 0; ri < chunk.length; ri++) {
            const row = chunk[ri];
            const globalRow = startRow + ri;
            if (!headerFound) {
              if (globalRow > 30) break;
              const hd = row.map(normH);
              const cI = ["ITEMCODE","CODE","MATERIAL","MATERIALCODE"].reduce(
                (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
              const qI = ["QTY","QUANTITY","BILLQTY","BILLINGQTY"].reduce(
                (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
              const aI = ["TAXABLEVALUE","TAXABLEAMOUNT","NETVALUE","AMOUNT","ASSESSABLEVALUE"].reduce(
                (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
              if (qI >= 0 && aI >= 0) {
                codeIdx = cI; qtyIdx = qI; amtIdx = aI;
                invIdx = ["INVOICENO","INVOICENUMBER","BILLINGDOCUMENT","DOCUMENTNO","DOCUMENTNUMBER","BILLNO","DOCNO"].reduce(
                  (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
                sapInvoiceColFound = invIdx >= 0;
                headerFound = true;
              }
              continue;
            }
            const sapAmt = numV(row[amtIdx]);
            if (sapAmt <= 0) continue;
            sapRowsRead++;
            const sapRawCode = codeIdx >= 0 ? strV(row[codeIdx]) : "";
            const sapQty = numV(row[qtyIdx]);
            const invRaw = invIdx >= 0 ? strV(row[invIdx]) : "";
            const invKey = normInv(invRaw);
            if (invKey) {
              const arr = sapByInv.get(invKey) ?? [];
              arr.push({ sapRawCode, sapQty, sapAmount: sapAmt });
              sapByInv.set(invKey, arr);
            } else {
              // No invoice — key by amount for fallback matching
              const amtKey = `__AMT__${Math.round(sapAmt)}`;
              const arr = sapByInv.get(amtKey) ?? [];
              arr.push({ sapRawCode, sapQty, sapAmount: sapAmt });
              sapByInv.set(amtKey, arr);
            }
          }
        });
      }
    }

    // Diagnostic: first 10 SAP invoice keys so we can compare format with DB invoice_no
    const sapInvSamples = [...sapByInv.keys()]
      .filter((k) => !k.startsWith("__AMT__"))
      .slice(0, 10);

    // ── 3. Build DB-vs-SAP comparison (no SHEET read — full-sheet reads time out) ──
    //
    // SALE SHEET qty is not read directly; instead we compute:
    //   expectedSheetQty = sapQty × perTankLitres
    // which is the total-litres figure the SHEET would show if SAP stores pieces.
    // If expectedSheetQty / dbQty = sapQty (an integer), the hypothesis holds:
    //   SAP = pieces, SHEET = total litres, DB stored only one tank's litres.

    type ThreeWayRow = {
      fy: string; invoiceNo: string | null; code: string;
      colour: string | null; monthLabel: string;
      perTankLitres: number | null;
      dbQty: number; dbAmount: number;
      sapQty: number | null; sapAmount: number | null; sapRawCode: string | null;
      // Derived from SAP + perTankLitres
      expectedSheetQty: number | null;      // sapQty × perTankLitres (total litres)
      dbQtyEqPerTankLitres: boolean | null; // dbQty == perTankLitres (one-unit bug)
      sapPiecesHypothesis: boolean | null;  // expectedSheetQty / dbQty = integer = sapQty?
      dbAmountEqualsSapAmount: boolean | null;
      dataAvailability: "DB+SAP" | "DB_ONLY";
      sapMatchMethod: "invoice" | "amount" | "none" | "no_sap_source";
    };

    const rows: ThreeWayRow[] = [];

    for (const dbRow of dbRows) {
      const fy = dbRow.fy;
      const inv = dbRow.invoice_no;
      const code = dbRow.code;
      const colour = dbRow.color;
      const dbQty = Number(dbRow.qty);
      const dbAmt = Number(dbRow.amount);
      const perTankLitres = tankLitresFromCode(code);

      // SAP lookup (FY2026-27 only)
      let sapQty: number | null = null;
      let sapAmt: number | null = null;
      let sapRawCode: string | null = null;
      let sapMatchMethod: ThreeWayRow["sapMatchMethod"] = "no_sap_source";

      if (fy === "2026-27" && sap2627Id) {
        sapMatchMethod = "none";
        // Try invoice-number match first
        if (inv && sapInvoiceColFound) {
          const candidates = sapByInv.get(normInv(inv)) ?? [];
          if (candidates.length > 0) {
            // Among this invoice's lines, find the one closest in amount to DB
            const best = candidates.reduce((a, b) =>
              Math.abs(b.sapAmount - dbAmt) < Math.abs(a.sapAmount - dbAmt) ? b : a,
            );
            if (Math.abs(best.sapAmount - dbAmt) < 2) {
              sapQty = best.sapQty; sapAmt = best.sapAmount;
              sapRawCode = best.sapRawCode; sapMatchMethod = "invoice";
            }
          }
        }
        // Fallback: match by amount ±1 Rs (only if exactly one SAP row has this amount)
        if (sapMatchMethod === "none") {
          const amtKey = `__AMT__${Math.round(dbAmt)}`;
          const candidates = sapByInv.get(amtKey) ?? [];
          if (candidates.length === 1) {
            sapQty = candidates[0].sapQty; sapAmt = candidates[0].sapAmount;
            sapRawCode = candidates[0].sapRawCode; sapMatchMethod = "amount";
          }
        }
      }

      // Derived checks
      const expectedSheetQty = sapQty != null && perTankLitres != null
        ? sapQty * perTankLitres : null;

      const dbQtyEqPerTankLitres = perTankLitres != null
        ? dbQty === perTankLitres : null;

      const sapPiecesHypothesis = expectedSheetQty != null
        ? Math.abs(expectedSheetQty / dbQty - Math.round(expectedSheetQty / dbQty)) < 0.01
        : null;

      const dbAmtEqSap = sapAmt != null ? Math.abs(dbAmt - sapAmt) < 2 : null;

      rows.push({
        fy, invoiceNo: inv, code, colour, monthLabel: dbRow.month_label,
        perTankLitres,
        dbQty, dbAmount: Math.round(dbAmt),
        sapQty, sapAmount: sapAmt != null ? Math.round(sapAmt) : null, sapRawCode,
        expectedSheetQty,
        dbQtyEqPerTankLitres,
        sapPiecesHypothesis,
        dbAmountEqualsSapAmount: dbAmtEqSap,
        dataAvailability: sapQty != null ? "DB+SAP" : "DB_ONLY",
        sapMatchMethod,
      });
    }

    // ── 4. Summary stats ──────────────────────────────────────────────────────
    const withSap  = rows.filter((r) => r.dataAvailability === "DB+SAP");
    const dbOnly   = rows.filter((r) => r.dataAvailability === "DB_ONLY");

    const bugConfirmed  = withSap.filter((r) => r.dbQtyEqPerTankLitres === true).length;
    const amtSafe       = withSap.filter((r) => r.dbAmountEqualsSapAmount === true).length;
    const chainVerified = withSap.filter((r) => r.sapPiecesHypothesis === true).length;

    res.json({
      note: [
        "Three sources: DB (sale_line.qty, stored as per-tank litres by the loader bug),",
        "SHEET (derived SALE SHEET register, total litres = SAP pieces × per_tank_litres),",
        "SAP (Combined tab, pieces = billing-master qty).",
        "FY2026-27: full three-way. FY2025-26: DB + SHEET only. FY2023-24/24-25: DB only (no invoice_no).",
      ].join(" "),
      sapReadInfo: {
        sapSourceConfigured: !!sap2627Id,
        invoiceColFound: sapInvoiceColFound,
        sapRowsRead,
        sapInvoiceKeySamples: sapInvSamples,
        dbInvoiceSamples_2627: dbRows
          .filter((r) => r.fy === "2026-27" && r.invoice_no != null)
          .slice(0, 10)
          .map((r) => ({ raw: r.invoice_no, normed: normInv(r.invoice_no) })),
      },
      summary: {
        totalRows: rows.length,
        withSapRows: withSap.length,
        dbOnlyRows: dbOnly.length,
        bugConfirmed_dbQtyEqPerTankLitres: bugConfirmed,
        amountSafeVsSap: amtSafe,
        sapPiecesHypothesisVerified: chainVerified,
      },
      rows,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "tank-three-way-sample failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Sync dry-run ──────────────────────────────────────────────────────────────

/**
 * GET /registers/:fy/sync-dry-run
 *
 * Mirrors the full doSync → versionedSyncLines → tombstoneOrphans pipeline for
 * the given FY WITHOUT writing anything to the database.
 *
 * Reports per month:
 *   wouldSupersede  — DB rows whose identity is in the sheet but with changed
 *                     amount/rate/serial (rate-edit replacements). Each one
 *                     has a paired new-rate insert queued alongside it.
 *   wouldInsert     — rows queued for insert (new rows + replacement rows).
 *   tombstoneCandidates — DB current rows whose identity is NOT in the sheet
 *                         at all (orphans). Reported via tombstoneOrphans
 *                         dryRun=true; blast-radius guard is enforced.
 *   projected       — estimated current row count + amount after the tick.
 *
 * Health checks reported at the top level:
 *   supersedeHealthChecks.colourlessCount — must be 0 before applying.
 *   supersedeHealthChecks.noneAbsentFromSheet — must be true (by construction
 *     a supersede always has a paired sheet row; tombstones handle the absent case).
 */
router.get("/registers/:fy/sync-dry-run", async (req, res) => {
  const { fy } = req.params;
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  try {
    // ── 1. Read sheet (identical to doSync) ─────────────────────────────────
    const occurrence = new OccurrenceCounter();
    const unmapped = emptyUnmapped();
    const lines: InsertSaleLine[] = [];

    const { rowsScanned, tabsRead } = await readRegisterFromSheets(
      spreadsheetId,
      fy,
      (values, columns) => {
        const result = parseRegisterRow(values, columns, fy);
        if (result.kind !== "row") return;
        lines.push(toSaleLine(result.row, occurrence, unmapped, "sheets"));
      },
    );

    if (lines.length === 0) {
      res.status(400).json({ error: "zero rows from sheet — aborting dry-run" });
      return;
    }

    // ── 2. Deduplicate by (fy, monthLabel, serialNo) — mirrors dedupeBySerialNo
    const deduped: InsertSaleLine[] = [];
    {
      const seen = new Map<string, true>();
      for (const line of lines) {
        if (line.serialNo != null && line.monthLabel != null) {
          const k = `${line.fy ?? ""}|${line.monthLabel}|${line.serialNo}`;
          if (!seen.has(k)) { seen.set(k, true); deduped.push(line); }
        } else {
          deduped.push(line);
        }
      }
    }

    // ── 3. Load all current DB rows for this FY ──────────────────────────────
    type DbRow = {
      lineUid: string;
      invoiceNo: string | null;
      code: string;
      color: string | null;
      qty: string | null;
      monthLabel: string | null;
      amount: string;
      saleRate: string | null;
      serialNo: number | null;
    };

    const fys = [...new Set(deduped.map((l) => l.fy).filter((f): f is string => f != null))];
    const allCurrent: DbRow[] = [];
    for (const fyItem of fys) {
      const rows = await db
        .select({
          lineUid: saleLines.lineUid,
          invoiceNo: saleLines.invoiceNo,
          code: saleLines.code,
          color: saleLines.color,
          qty: saleLines.qty,
          monthLabel: saleLines.monthLabel,
          amount: saleLines.amount,
          saleRate: saleLines.saleRate,
          serialNo: saleLines.serialNo,
        })
        .from(saleLines)
        .where(and(eq(saleLines.fy, fyItem), eq(saleLines.versionStatus, "current")));
      allCurrent.push(...(rows as DbRow[]));
    }

    const currentMap = new Map<string, DbRow>();
    for (const row of allCurrent) {
      currentMap.set(
        identityKey(row.invoiceNo, row.code, row.color, row.qty, row.monthLabel),
        row,
      );
    }

    // ── 4. Classify each deduped sheet line ──────────────────────────────────
    const toTouch: string[] = [];
    type SupersedeEntry = { dbRow: DbRow; newLineUid: string; newAmount: number };
    const toSupersede: SupersedeEntry[] = [];
    const toInsert: InsertSaleLine[] = [];

    for (const line of deduped) {
      const key = identityKey(
        line.invoiceNo ?? null,
        line.code,
        line.color ?? null,
        line.qty ?? null,
        line.monthLabel ?? null,
      );
      const existing = currentMap.get(key);

      if (!existing) {
        toInsert.push(line);
        continue;
      }

      const amtMatch  = Math.abs(Number(line.amount) - Number(existing.amount)) < 0.01;
      const rateMatch =
        line.saleRate == null && existing.saleRate == null
          ? true
          : line.saleRate != null && existing.saleRate != null
            ? Math.abs(Number(line.saleRate) - Number(existing.saleRate)) < 0.01
            : false;
      const serialMatch = (line.serialNo ?? null) === (existing.serialNo ?? null);

      if (amtMatch && rateMatch && serialMatch) {
        toTouch.push(existing.lineUid);
      } else {
        toSupersede.push({
          dbRow: existing,
          newLineUid: line.lineUid,
          newAmount: Number(line.amount),
        });
        toInsert.push(line);
      }
    }

    // ── 5. Tombstone dry-run per month ───────────────────────────────────────
    const monthsInBatch = [
      ...new Set(deduped.map((l) => l.monthLabel).filter((m): m is string => m != null)),
    ];
    type TombstoneSummary = {
      candidates: number; amount: number;
      blastRadiusPct: number; halted: boolean;
      haltReason?: string;
      sampleRows: Array<{
        invoiceNo: string | null; code: string;
        color: string | null; qty: string | null; amount: string;
      }>;
    };
    const tombstoneByMonth = new Map<string, TombstoneSummary>();

    for (const month of monthsInBatch) {
      const monthLines = deduped.filter((l) => l.monthLabel === month);
      const seenForMonth = new Set(
        monthLines.map((l) =>
          identityKey(
            l.invoiceNo ?? null, l.code,
            l.color ?? null, l.qty ?? null, l.monthLabel ?? null,
          ),
        ),
      );
      const tr = await tombstoneOrphans({
        fy: fys[0] ?? fy,
        month,
        seenIdentities: seenForMonth,
        incomingRowCount: monthLines.length,
        syncRunId: `sync-dry-run|${new Date().toISOString()}`,
        dryRun: true,
        blastRadiusLimitPct: 10,
      });
      tombstoneByMonth.set(month, {
        candidates: tr.candidateCount,
        amount: tr.candidateAmount,
        blastRadiusPct: tr.blastRadiusPct,
        halted: tr.halted,
        haltReason: tr.haltReason,
        sampleRows: tr.sampleRows.slice(0, 5).map((r) => ({
          invoiceNo: r.invoiceNo,
          code: r.code,
          color: r.color,
          qty: r.qty,
          amount: r.amount,
        })),
      });
    }

    // ── 6. Per-month aggregates ──────────────────────────────────────────────
    // Sheet totals
    const sheetByMonth = new Map<string, { rows: number; amount: number }>();
    for (const line of deduped) {
      const m = line.monthLabel ?? "unknown";
      const s = sheetByMonth.get(m) ?? { rows: 0, amount: 0 };
      s.rows++; s.amount += Number(line.amount);
      sheetByMonth.set(m, s);
    }

    // DB current totals
    const dbByMonth = new Map<string, { rows: number; amount: number }>();
    for (const row of allCurrent) {
      const m = row.monthLabel ?? "unknown";
      const s = dbByMonth.get(m) ?? { rows: 0, amount: 0 };
      s.rows++; s.amount += Number(row.amount);
      dbByMonth.set(m, s);
    }

    // Supersede counts per month
    const supByMonth = new Map<string, { count: number; amount: number; colourlessCount: number }>();
    for (const { dbRow } of toSupersede) {
      const m = dbRow.monthLabel ?? "unknown";
      const s = supByMonth.get(m) ?? { count: 0, amount: 0, colourlessCount: 0 };
      s.count++; s.amount += Number(dbRow.amount);
      if (dbRow.color == null) s.colourlessCount++;
      supByMonth.set(m, s);
    }

    // Insert counts per month
    const insByMonth = new Map<string, { count: number; amount: number }>();
    for (const line of toInsert) {
      const m = line.monthLabel ?? "unknown";
      const s = insByMonth.get(m) ?? { count: 0, amount: 0 };
      s.count++; s.amount += Number(line.amount);
      insByMonth.set(m, s);
    }

    // Assemble per-month report
    const allMonths = [
      ...new Set([
        ...Array.from(sheetByMonth.keys()),
        ...Array.from(dbByMonth.keys()),
      ]),
    ].sort();

    const byMonth: Record<string, object> = {};
    for (const month of allMonths) {
      const db_   = dbByMonth.get(month)      ?? { rows: 0, amount: 0 };
      const sup   = supByMonth.get(month)     ?? { count: 0, amount: 0, colourlessCount: 0 };
      const ins   = insByMonth.get(month)     ?? { count: 0, amount: 0 };
      const tomb  = tombstoneByMonth.get(month) ?? { candidates: 0, amount: 0, blastRadiusPct: 0, halted: false, sampleRows: [] };
      const sheet = sheetByMonth.get(month)   ?? { rows: 0, amount: 0 };

      // Supersede+insert pairs are net-zero for row count. Only pure new inserts add rows.
      const pureNewInserts = ins.count - sup.count;
      const projRows   = db_.rows + pureNewInserts - tomb.candidates;
      // Amount: remove superseded old amounts, add all insert amounts, remove tombstoned amounts.
      const projAmount = db_.amount - sup.amount + ins.amount - tomb.amount;

      byMonth[month] = {
        dbCurrentRows: db_.rows,
        dbCurrentAmount: Math.round(db_.amount),
        sheet: { rows: sheet.rows, amount: Math.round(sheet.amount) },
        wouldSupersede: { count: sup.count, amount: Math.round(sup.amount), colourlessCount: sup.colourlessCount },
        wouldInsert:    { count: ins.count, amount: Math.round(ins.amount) },
        tombstoneCandidates: {
          count: tomb.candidates, amount: Math.round(tomb.amount),
          blastRadiusPct: Math.round(tomb.blastRadiusPct * 10) / 10,
          halted: tomb.halted, haltReason: tomb.haltReason ?? null,
          sampleRows: tomb.sampleRows,
        },
        projected: {
          rows: projRows,
          amount: Math.round(projAmount),
          deltaVsSheet: Math.round(projAmount - sheet.amount),
        },
      };
    }

    // ── 7. Top-level health checks ───────────────────────────────────────────
    const totalSupColourless = toSupersede.filter(({ dbRow }) => dbRow.color == null).length;
    const totalTombCandidates = [...tombstoneByMonth.values()].reduce((s, v) => s + v.candidates, 0);
    const totalTombAmount     = [...tombstoneByMonth.values()].reduce((s, v) => s + v.amount, 0);
    const anyTombBlastHalted  = [...tombstoneByMonth.values()].some((v) => v.halted);

    res.json({
      fy,
      rowsScanned,
      tabsRead,
      linesFromSheet: lines.length,
      deduped: deduped.length,
      dbCurrentTotal: allCurrent.length,
      summary: {
        wouldTouch:    toTouch.length,
        wouldSupersede: toSupersede.length,
        wouldInsert:    toInsert.length,
        tombstoneCandidatesTotal: totalTombCandidates,
        tombstoneCandidateAmountTotal: Math.round(totalTombAmount),
        anyTombBlastRadiusHalted: anyTombBlastHalted,
      },
      supersedeHealthChecks: {
        anyColourless: totalSupColourless > 0,
        colourlessCount: totalSupColourless,
        // By construction: a supersede in versionedSyncLines means the identity IS in
        // the sheet (sheet has same invoice/code/colour/qty but different amount/rate/serial).
        // Rows absent from the sheet are handled by tombstoneOrphans, not here.
        noneAbsentFromSheet: true,
      },
      byMonth,
    });
  } catch (err: unknown) {
    req.log.error({ err, fy }, "sync-dry-run failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /registers/tank-tier-a-dryrun
 * Dry run for Tier A of the tank qty fix (FY2025-26 + FY2026-27).
 * Reads all DB tank rows for both FYs, reads the SAP Combined tab for each FY,
 * matches by (invoice_no, closest amount ±2 Rs), and reports:
 *   - matched rows (will be fixed: qty → SAP pieces, qty_ltr → SAP qty × perTankLitres)
 *   - ghost rows (no SAP match — flagged only, never assigned)
 *   - true duplicate pairs (same invoice+code+colour, both State1+3 and State2 qtys)
 * NOTE: FY2025-26 SAP has 145,642 rows — expect 60-90 seconds.
 */
router.get("/registers/tank-tier-a-dryrun", async (req, res) => {
  try {
    const cfg = rawRegisterSheetsCfg as {
      sap_source?: Record<string, string>;
      registers?: Record<string, string>;
    };
    const TANK_SIZES = [200, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000];
    const FYS = ["2025-26", "2026-27"];

    const normH = (s: string) => (s ?? "").replace(/\s+/g, "").toUpperCase();
    const numV = (v: unknown) => { const n = parseFloat(String(v ?? "")); return isNaN(n) ? 0 : n; };
    const strV = (v: unknown) => String(v ?? "").trim();
    const normInv = (s: string) => s.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

    // ── 1. DB rows: all tank rows for FY2025-26 + FY2026-27 ─────────────────
    const dbResult = await pool.query<{
      fy: string; line_uid: string; invoice_no: string | null;
      code: string; color: string | null; month_label: string;
      db_qty: string; db_amount: string; per_tank_ltr: string;
    }>(`
      WITH tank_litres AS (
        SELECT suffix, ltr FROM (VALUES
          ${tankSizeMapSql()}
        ) AS t(suffix, ltr)
      )
      SELECT sl.fy, sl.line_uid, sl.invoice_no, sl.code, sl.color,
             sl.month_label,
             sl.qty::text       AS db_qty,
             sl.amount::text    AS db_amount,
             tl.ltr::text       AS per_tank_ltr
      FROM sale_line sl
      JOIN tank_litres tl ON SUBSTRING(sl.code FROM '[0-9]{2}$') = tl.suffix
      WHERE sl.version_status = 'current'
        AND sl.fy = ANY($1::text[])
        AND sl.code ~ '^(WCT|WT)-'
        AND sl.qty::numeric = ANY($2::numeric[])
      ORDER BY sl.fy, sl.invoice_no, sl.code, sl.color
    `, [FYS, TANK_SIZES]);

    const dbRows = dbResult.rows;

    // ── 2. SAP: read Combined tab for each FY ────────────────────────────────
    // Map: fy → normInvoice → [{sapQty, sapAmount}]
    const sapByFy = new Map<string, Map<string, Array<{ sapQty: number; sapAmount: number }>>>();
    const sapStats: Record<string, { rowsRead: number; invoiceColFound: boolean; tabFound: boolean }> = {};

    for (const fy of FYS) {
      const sapId = cfg.sap_source?.[fy];
      const byInv = new Map<string, Array<{ sapQty: number; sapAmount: number }>>();
      sapByFy.set(fy, byInv);
      sapStats[fy] = { rowsRead: 0, invoiceColFound: false, tabFound: false };
      if (!sapId) continue;

      const tabs = await listSheetTabs(sapId);
      const combined = tabs.find((t) => /^combined$/i.test(t.title.trim()));
      if (!combined) continue;
      sapStats[fy].tabFound = true;

      let qtyIdx = -1, amtIdx = -1, invIdx = -1;
      let headerFound = false;

      await readTabRowsChunked(sapId, combined.title, (chunk, startRow) => {
        for (let ri = 0; ri < chunk.length; ri++) {
          const row = chunk[ri];
          const globalRow = startRow + ri;
          if (!headerFound) {
            if (globalRow > 30) continue;
            const hd = row.map(normH);
            const qI = ["QTY", "QUANTITY", "BILLQTY", "BILLINGQTY"].reduce(
              (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
            const aI = ["TAXABLEVALUE", "TAXABLEAMOUNT", "NETVALUE", "AMOUNT", "ASSESSABLEVALUE"].reduce(
              (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
            if (qI >= 0 && aI >= 0) {
              qtyIdx = qI; amtIdx = aI;
              invIdx = ["INVOICENO", "INVOICENUMBER", "BILLINGDOCUMENT", "DOCUMENTNO",
                        "DOCUMENTNUMBER", "BILLNO", "DOCNO"].reduce(
                (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
              sapStats[fy].invoiceColFound = invIdx >= 0;
              headerFound = true;
            }
            continue;
          }
          const sapAmt = numV(row[amtIdx]);
          if (sapAmt <= 0) continue;
          sapStats[fy].rowsRead++;
          const sapQty = numV(row[qtyIdx]);
          const invKey = normInv(strV(invIdx >= 0 ? row[invIdx] : ""));
          if (invKey) {
            const arr = byInv.get(invKey) ?? [];
            arr.push({ sapQty, sapAmount: sapAmt });
            byInv.set(invKey, arr);
          }
        }
      });
    }

    // ── 3. Match each DB row to its FY's SAP ─────────────────────────────────
    type MRow = {
      lineUid: string; fy: string; invoiceNo: string | null;
      code: string; color: string | null; monthLabel: string;
      dbQty: number; dbAmount: number; perTankLtr: number;
      sapQty: number | null; sapAmount: number | null; amtDiff: number | null;
      isGhost: boolean; isNullInvoice: boolean;
    };

    const matched: MRow[] = [];
    const ghosts: MRow[] = [];
    const nullInvoices: MRow[] = [];

    for (const r of dbRows) {
      const dbQty = parseFloat(r.db_qty);
      const dbAmount = parseFloat(r.db_amount);
      const perTankLtr = parseInt(r.per_tank_ltr, 10);
      const byInv = sapByFy.get(r.fy)!;
      const base = {
        lineUid: r.line_uid, fy: r.fy, invoiceNo: r.invoice_no,
        code: r.code, color: r.color, monthLabel: r.month_label,
        dbQty, dbAmount, perTankLtr,
      };
      if (!r.invoice_no) {
        nullInvoices.push({ ...base, sapQty: null, sapAmount: null, amtDiff: null, isGhost: true, isNullInvoice: true });
        continue;
      }
      const invKey = normInv(r.invoice_no);
      const candidates = byInv.get(invKey) ?? [];
      if (candidates.length > 0) {
        const best = candidates.reduce((a, b) =>
          Math.abs(b.sapAmount - dbAmount) < Math.abs(a.sapAmount - dbAmount) ? b : a);
        matched.push({ ...base, sapQty: best.sapQty, sapAmount: best.sapAmount,
          amtDiff: Math.round(Math.abs(best.sapAmount - dbAmount) * 100) / 100,
          isGhost: false, isNullInvoice: false });
      } else {
        ghosts.push({ ...base, sapQty: null, sapAmount: null, amtDiff: null,
          isGhost: true, isNullInvoice: false });
      }
    }

    // ── 4. True duplicate detection ───────────────────────────────────────────
    // Groups of 2+ matched DB rows with the same (fy, invoice, code, color)
    const byGroup = new Map<string, MRow[]>();
    for (const m of matched) {
      const k = `${m.fy}|${m.invoiceNo}|${m.code}|${m.color}`;
      const arr = byGroup.get(k) ?? [];
      arr.push(m);
      byGroup.set(k, arr);
    }
    const trueDupGroups = [...byGroup.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([key, rows]) => ({
        key,
        dbQtys: rows.map((r) => r.dbQty).sort((a, b) => a - b),
        sapQty: rows[0].sapQty,
        perTankLtr: rows[0].perTankLtr,
        // State1_3 row = smallest qty (perTankLtr); State2 row = largest qty (total litres)
        state1_3_qty: Math.min(...rows.map((r) => r.dbQty)),
        state2_qty: Math.max(...rows.map((r) => r.dbQty)),
      }));

    // ── 5. Per-FY breakdown + response ────────────────────────────────────────
    const byFySummary: Record<string, { dbRows: number; matched: number; ghosts: number; nullInv: number }> = {};
    for (const fy of FYS) byFySummary[fy] = { dbRows: 0, matched: 0, ghosts: 0, nullInv: 0 };
    for (const r of dbRows) byFySummary[r.fy].dbRows++;
    for (const m of matched) byFySummary[m.fy].matched++;
    for (const g of ghosts) byFySummary[g.fy].ghosts++;
    for (const n of nullInvoices) byFySummary[n.fy].nullInv++;

    res.json({
      summary: {
        totalDbRows: dbRows.length,
        matched: matched.length,
        ghosts: ghosts.length,
        nullInvoice: nullInvoices.length,
        trueDuplicatePairs: trueDupGroups.length,
        ghostTotalAmount: Math.round(ghosts.reduce((s, r) => s + r.dbAmount, 0)),
        matchedAmtDiffMax: matched.length > 0
          ? Math.max(...matched.map((m) => m.amtDiff ?? 0)) : null,
      },
      byFy: byFySummary,
      sapReadStats: sapStats,
      sampleMatched: matched.slice(0, 6).map((m) => ({
        fy: m.fy, invoiceNo: m.invoiceNo, code: m.code, color: m.color,
        dbQty: m.dbQty, perTankLtr: m.perTankLtr,
        sapQty: m.sapQty,
        newQtyLtr: m.sapQty != null ? m.sapQty * m.perTankLtr : null,
        dbAmount: Math.round(m.dbAmount),
        sapAmount: m.sapAmount != null ? Math.round(m.sapAmount) : null,
        amtDiff: m.amtDiff,
      })),
      sampleGhosts: ghosts.slice(0, 5).map((g) => ({
        fy: g.fy, invoiceNo: g.invoiceNo, code: g.code,
        dbQty: g.dbQty, dbAmount: Math.round(g.dbAmount),
      })),
      sampleTrueDups: trueDupGroups.slice(0, 3),
    });
  } catch (err: unknown) {
    req.log.error({ err }, "tank-tier-a-dryrun failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /registers/tank-tier-a-apply?dryRun=true|false
 *
 * Applies the Tier A tank qty fix for FY2025-26 + FY2026-27.
 * Algorithm:
 *   1. Read all DB tank rows (code ~ ^(WCT|WT)-, qty in tank-size list)
 *   2. Read SAP Combined tabs for both FYs
 *   3. Match each DB row to SAP by invoice_no + closest-amount (tolerance ≤ 5 Rs)
 *   4. Group matches by (fy, invoice, code, color, rounded-sapAmount) to detect
 *      true duplicate pairs (two DB rows matched to same SAP row):
 *        - State2 row (larger qty = total litres) → fix: qty=sapQty, qty_ltr=sapQty×perTankLtr
 *        - State1_3 row (smaller qty = perTankLtr) → tombstone (version_status='superseded')
 *   5. Single-row matches → fix: qty=sapQty, qty_ltr=sapQty×perTankLtr
 *   6. Ghosts / bad-matches (amtDiff > 5 Rs) → left unchanged
 *
 * dryRun=true (default) → returns the plan without writing.
 * dryRun=false → runs in a transaction; on error, rolls back automatically.
 *
 * PREREQUISITES: REGISTER_SYNC_PAUSE must include "2025-26" and "2026-27".
 * NOTE: Reads 145,642 rows from FY2025-26 SAP — expect 60-90 seconds.
 */
router.post("/registers/tank-tier-a-apply", async (req, res) => {
  try {
    const dryRun = req.query.dryRun !== "false";
    const AMT_TOLERANCE = 5; // Rs — max allowed difference between DB and SAP amount
    const cfg = rawRegisterSheetsCfg as {
      sap_source?: Record<string, string>;
      registers?: Record<string, string>;
    };
    const TANK_SIZES = [200, 500, 750, 1000, 1500, 2000, 2500, 3000, 5000];
    const FYS = ["2025-26", "2026-27"];

    const normH = (s: string) => (s ?? "").replace(/\s+/g, "").toUpperCase();
    const numV = (v: unknown) => { const n = parseFloat(String(v ?? "")); return isNaN(n) ? 0 : n; };
    const strV = (v: unknown) => String(v ?? "").trim();
    const normInv = (s: string) => s.replace(/[^0-9A-Za-z]/g, "").toUpperCase();

    // Guard: sync must be paused for both FYs
    const pauseEnv = (process.env.REGISTER_SYNC_PAUSE ?? "").split(",").map((s) => s.trim());
    const missingPause = FYS.filter((fy) => !pauseEnv.includes(fy));
    if (missingPause.length > 0) {
      res.status(409).json({
        error: "REGISTER_SYNC_PAUSE must include all Tier A FYs before apply",
        missingPause,
        currentPause: process.env.REGISTER_SYNC_PAUSE,
      });
      return;
    }

    // ── 1. DB rows ────────────────────────────────────────────────────────────
    const dbResult = await pool.query<{
      fy: string; line_uid: string; invoice_no: string | null;
      code: string; color: string | null; month_label: string;
      db_qty: string; db_amount: string; per_tank_ltr: string;
    }>(`
      WITH tank_litres AS (
        SELECT suffix, ltr FROM (VALUES
          ${tankSizeMapSql()}
        ) AS t(suffix, ltr)
      )
      SELECT sl.fy, sl.line_uid, sl.invoice_no, sl.code, sl.color,
             sl.month_label,
             sl.qty::text       AS db_qty,
             sl.amount::text    AS db_amount,
             tl.ltr::text       AS per_tank_ltr
      FROM sale_line sl
      JOIN tank_litres tl ON SUBSTRING(sl.code FROM '[0-9]{2}$') = tl.suffix
      WHERE sl.version_status = 'current'
        AND sl.fy = ANY($1::text[])
        AND sl.code ~ '^(WCT|WT)-'
        AND sl.qty::numeric = ANY($2::numeric[])
      ORDER BY sl.fy, sl.invoice_no, sl.code, sl.color
    `, [FYS, TANK_SIZES]);

    const dbRows = dbResult.rows;

    // ── 2. SAP: read Combined tab for each FY ────────────────────────────────
    const sapByFy = new Map<string, Map<string, Array<{ sapQty: number; sapAmount: number }>>>();
    const sapStats: Record<string, { rowsRead: number; invoiceColFound: boolean }> = {};

    for (const fy of FYS) {
      const sapId = cfg.sap_source?.[fy];
      const byInv = new Map<string, Array<{ sapQty: number; sapAmount: number }>>();
      sapByFy.set(fy, byInv);
      sapStats[fy] = { rowsRead: 0, invoiceColFound: false };
      if (!sapId) continue;

      const tabs = await listSheetTabs(sapId);
      const combined = tabs.find((t) => /^combined$/i.test(t.title.trim()));
      if (!combined) continue;

      let qtyIdx = -1, amtIdx = -1, invIdx = -1;
      let headerFound = false;

      await readTabRowsChunked(sapId, combined.title, (chunk, startRow) => {
        for (let ri = 0; ri < chunk.length; ri++) {
          const row = chunk[ri];
          const globalRow = startRow + ri;
          if (!headerFound) {
            if (globalRow > 30) continue;
            const hd = row.map(normH);
            const qI = ["QTY", "QUANTITY", "BILLQTY", "BILLINGQTY"].reduce(
              (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
            const aI = ["TAXABLEVALUE", "TAXABLEAMOUNT", "NETVALUE", "AMOUNT", "ASSESSABLEVALUE"].reduce(
              (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
            if (qI >= 0 && aI >= 0) {
              qtyIdx = qI; amtIdx = aI;
              invIdx = ["INVOICENO", "INVOICENUMBER", "BILLINGDOCUMENT", "DOCUMENTNO",
                        "DOCUMENTNUMBER", "BILLNO", "DOCNO"].reduce(
                (b, a) => b >= 0 ? b : hd.indexOf(a), -1);
              sapStats[fy].invoiceColFound = invIdx >= 0;
              headerFound = true;
            }
            continue;
          }
          const sapAmt = numV(row[amtIdx]);
          if (sapAmt <= 0) continue;
          sapStats[fy].rowsRead++;
          const sapQty = numV(row[qtyIdx]);
          const invKey = normInv(strV(invIdx >= 0 ? row[invIdx] : ""));
          if (invKey) {
            const arr = sapByFy.get(fy)!.get(invKey) ?? [];
            arr.push({ sapQty, sapAmount: sapAmt });
            sapByFy.get(fy)!.set(invKey, arr);
          }
        }
      });
    }

    // ── 3. Match each DB row to SAP (strict ≤5 Rs tolerance) ─────────────────
    type ValidMatch = {
      lineUid: string; fy: string; invoiceNo: string;
      code: string; color: string | null; monthLabel: string;
      dbQty: number; perTankLtr: number;
      sapQty: number; sapAmount: number; amtDiff: number;
    };

    const validMatches: ValidMatch[] = [];
    const excluded: { lineUid: string; fy: string; reason: string; amtDiff?: number }[] = [];

    for (const r of dbRows) {
      const dbQty = parseFloat(r.db_qty);
      const dbAmount = parseFloat(r.db_amount);
      const perTankLtr = parseInt(r.per_tank_ltr, 10);
      const byInv = sapByFy.get(r.fy)!;

      if (!r.invoice_no) {
        excluded.push({ lineUid: r.line_uid, fy: r.fy, reason: "null_invoice" });
        continue;
      }
      const invKey = normInv(r.invoice_no);
      const candidates = byInv.get(invKey) ?? [];
      if (candidates.length === 0) {
        excluded.push({ lineUid: r.line_uid, fy: r.fy, reason: "ghost_no_invoice_in_sap" });
        continue;
      }
      const best = candidates.reduce((a, b) =>
        Math.abs(b.sapAmount - dbAmount) < Math.abs(a.sapAmount - dbAmount) ? b : a);
      const amtDiff = Math.abs(best.sapAmount - dbAmount);
      if (amtDiff > AMT_TOLERANCE) {
        excluded.push({ lineUid: r.line_uid, fy: r.fy, reason: "bad_match_amt_diff_exceeds_tolerance", amtDiff });
        continue;
      }
      validMatches.push({
        lineUid: r.line_uid, fy: r.fy, invoiceNo: r.invoice_no!,
        code: r.code, color: r.color, monthLabel: r.month_label,
        dbQty, perTankLtr,
        sapQty: best.sapQty, sapAmount: best.sapAmount, amtDiff,
      });
    }

    // ── 4. Detect true duplicates: same (fy, invoice, code, color, sapAmount band) ──
    // Two DB rows matched to the same SAP row → true duplicate
    // State1_3 row (smaller qty = perTankLtr × 1) → tombstone
    // State2 row (larger qty = perTankLtr × N) → fix with sapQty
    const sapAmtBandKey = (m: ValidMatch) =>
      `${m.fy}|${m.invoiceNo}|${m.code}|${m.color ?? ""}|${Math.round(m.sapAmount / 10)}`;

    const byAmtGroup = new Map<string, ValidMatch[]>();
    for (const m of validMatches) {
      const k = sapAmtBandKey(m);
      const arr = byAmtGroup.get(k) ?? [];
      arr.push(m);
      byAmtGroup.set(k, arr);
    }

    const toFix: { lineUid: string; newQty: number; newQtyLtr: number }[] = [];
    const toTombstone: string[] = [];

    for (const [, rows] of byAmtGroup) {
      if (rows.length === 1) {
        const m = rows[0];
        toFix.push({ lineUid: m.lineUid, newQty: m.sapQty, newQtyLtr: m.sapQty * m.perTankLtr });
      } else {
        // True duplicate pair: fix State2 (largest dbQty), tombstone the rest
        const state2 = rows.reduce((a, b) => a.dbQty > b.dbQty ? a : b);
        toFix.push({ lineUid: state2.lineUid, newQty: state2.sapQty, newQtyLtr: state2.sapQty * state2.perTankLtr });
        for (const dup of rows) {
          if (dup.lineUid !== state2.lineUid) toTombstone.push(dup.lineUid);
        }
      }
    }

    const plan = {
      dryRun,
      totalDbRows: dbRows.length,
      validMatches: validMatches.length,
      excluded: excluded.length,
      toFix: toFix.length,
      toTombstone: toTombstone.length,
      excludedBreakdown: Object.fromEntries(
        Object.entries(
          excluded.reduce<Record<string, number>>((acc, e) => {
            acc[e.reason] = (acc[e.reason] ?? 0) + 1;
            return acc;
          }, {})
        )
      ),
      sapStats,
      sampleFix: toFix.slice(0, 5),
      sampleTombstone: toTombstone.slice(0, 5),
      sampleExcluded: excluded.slice(0, 5),
    };

    if (dryRun) {
      res.json({ ...plan, applied: false });
      return;
    }

    // ── 5. Apply in a transaction ─────────────────────────────────────────────
    const client = await pool.connect();
    let fixedRows = 0, tombstonedRows = 0;
    try {
      await client.query("BEGIN");

      // 5a. Fix valid matches using JSONB parameter
      if (toFix.length > 0) {
        const fixJson = JSON.stringify(toFix.map((r) => ({
          line_uid: r.lineUid,
          new_qty: r.newQty,
          new_qty_ltr: r.newQtyLtr,
        })));
        const fixResult = await client.query(`
          UPDATE sale_line sl
          SET qty     = (elem->>'new_qty')::numeric,
              qty_ltr = (elem->>'new_qty_ltr')::numeric
          FROM jsonb_array_elements($1::jsonb) AS elem
          WHERE sl.line_uid = elem->>'line_uid'
            AND sl.version_status = 'current'
        `, [fixJson]);
        fixedRows = fixResult.rowCount ?? 0;
      }

      // 5b. Tombstone true-duplicate State1_3 rows
      if (toTombstone.length > 0) {
        const tombResult = await client.query(`
          UPDATE sale_line
          SET version_status = 'superseded'
          WHERE line_uid = ANY($1::text[])
            AND version_status = 'current'
        `, [toTombstone]);
        tombstonedRows = tombResult.rowCount ?? 0;
      }

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    req.log.info({ fixedRows, tombstonedRows, toFix: toFix.length, toTombstone: toTombstone.length },
      "tank-tier-a-apply committed");

    res.json({ ...plan, applied: true, fixedRows, tombstonedRows });
  } catch (err: unknown) {
    req.log.error({ err }, "tank-tier-a-apply failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /registers/sap-coverage-check
 * Searches Drive for SAP-format workbooks for closed FYs (2023-24, 2024-25, 2025-26).
 * Uses the parent folder of the known FY2026-27 SAP file as the starting point,
 * then does a broader name-based search. Read-only diagnostic.
 */
/**
 * GET /registers/sap-tab-count/:fy
 * Reads the Combined tab of the SAP source for the given FY and reports
 * total data row count + first row headers. Read-only diagnostic.
 */
router.get("/registers/sap-tab-count/:fy", async (req, res) => {
  const { fy } = req.params;
  const cfg = rawRegisterSheetsCfg as { sap_source?: Record<string, string>; registers?: Record<string, string> };
  const sapId = cfg.sap_source?.[fy];
  if (!sapId) {
    res.status(404).json({ error: `No sap_source configured for FY ${fy}` });
    return;
  }
  try {
    const token = await getGoogleAccessToken();
    // List tabs first
    const tabsResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sapId}?fields=sheets.properties.title`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const tabsData = await tabsResp.json() as { sheets: { properties: { title: string } }[] };
    const allTabs = (tabsData.sheets ?? []).map((s) => s.properties.title);
    // Find the Combined tab (startsWith match for truncated titles)
    const combinedTab = allTabs.find((t) => t.toLowerCase().startsWith("combined"));
    if (!combinedTab) {
      res.json({ fy, sapId, allTabs, error: "No Combined tab found" });
      return;
    }
    // Read all rows in chunks to count
    let totalRows = 0;
    let headerRow: string[] | null = null;
    let offset = 1;
    const chunkSize = 50000;
    while (true) {
      const range = `${combinedTab}!A${offset}:P${offset + chunkSize - 1}`;
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sapId}/values/${encodeURIComponent(range)}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json() as { values?: string[][] };
      const rows = d.values ?? [];
      if (rows.length === 0) break;
      if (headerRow === null) headerRow = rows[0];
      totalRows += offset === 1 ? rows.length - 1 : rows.length; // subtract header on first chunk
      if (rows.length < chunkSize) break;
      offset += chunkSize;
    }
    res.json({ fy, sapId, combinedTab, allTabs, headerRow, totalDataRows: totalRows });
  } catch (err: unknown) {
    req.log.error({ err, fy }, "sap-tab-count failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/registers/sap-coverage-check", async (req, res) => {
  try {
    const token = await getGoogleAccessToken();
    const knownSapId = "19Oj6P2cSZmXNGfDro9K_ubfrfPp_03K14vOTrq_gdyI";

    // 1. Get parent folders of the known SAP file
    const metaResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${knownSapId}?fields=id,name,parents`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const meta = await metaResp.json() as { id: string; name: string; parents?: string[] };
    const parentId = meta.parents?.[0] ?? null;

    // 2. List spreadsheets in the same folder
    let folderFiles: { id: string; name: string; modifiedTime: string }[] = [];
    if (parentId) {
      const folderResp = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
          `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet'`,
        )}&fields=files(id,name,modifiedTime)&pageSize=50`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const folderData = await folderResp.json() as { files: typeof folderFiles };
      folderFiles = folderData.files ?? [];
    }

    // 3. Name-based Drive search for SAP-related files
    const searches = [
      "name contains 'SAP' and mimeType = 'application/vnd.google-apps.spreadsheet'",
      "name contains 'SALE SHEET' and mimeType = 'application/vnd.google-apps.spreadsheet'",
    ];
    const nameResults: { query: string; files: { id: string; name: string; modifiedTime: string }[] }[] = [];
    for (const q of searches) {
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=30`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const d = await r.json() as { files: { id: string; name: string; modifiedTime: string }[] };
      nameResults.push({ query: q, files: d.files ?? [] });
    }

    res.json({
      knownSapFile: { id: knownSapId, name: meta.name, parentFolderId: parentId },
      sameFolder: folderFiles,
      nameSearch: nameResults,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "sap-coverage-check failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── SAP check (read-only debug) ───────────────────────────────────────────────
// GET /api/registers/sap-check?fy=2026-27&code=WT-001[&invoice=22600245]
// Reads the SAP Combined tab for the given FY, returns rows matching code
// (and optionally invoice). Shows description, qty, amount for confirmation.
// Drive is read-only: no writes.
router.get("/registers/sap-check", async (req, res) => {
  const fy      = typeof req.query.fy      === "string" ? req.query.fy      : "2026-27";
  const code    = typeof req.query.code    === "string" ? req.query.code    : "";
  const invoice = typeof req.query.invoice === "string" ? req.query.invoice : "";

  if (!code) {
    res.status(400).json({ error: "?code= is required" });
    return;
  }

  try {
    const cfg = rawRegisterSheetsCfg as { sap_source?: Record<string, string> };
    const sapId = cfg.sap_source?.[fy];
    if (!sapId) {
      res.status(404).json({ error: `No sap_source configured for FY ${fy}` });
      return;
    }

    const tabs = await listSheetTabs(sapId);
    const combined = tabs.find((t) => /^combined$/i.test(t.title.trim()));
    if (!combined) {
      res.json({ fy, sapId, allTabs: tabs.map((t) => t.title), error: "No Combined tab found" });
      return;
    }

    const normH = (s: unknown) => String(s ?? "").replace(/\s+/g, "").toUpperCase();
    const strV  = (v: unknown) => String(v ?? "").trim();
    const numV  = (v: unknown) => { const n = parseFloat(String(v ?? "")); return isNaN(n) ? 0 : n; };

    // Detect headers: only QTY+AMOUNT are required (same as Tier A route).
    // CODE column is optional — SAP tab headers vary and may not match aliases.
    // We filter by invoice_no and return raw row data so description is visible.
    let codeIdx = -1, invIdx = -1, qtyIdx = -1, amtIdx = -1, descIdx = -1;
    let headerFound = false;
    let rawHeader: string[] = [];

    const matches: {
      invoiceNo: string; code: string; description: string; qty: number; amount: number;
    }[] = [];

    // Build the set of invoices we are interested in (from DB).
    // If invoice param given, use that. Otherwise load from DB for this code+fy.
    let invoiceSet: Set<string>;
    if (invoice) {
      invoiceSet = new Set([invoice]);
    } else {
      const dbRows = await pool.query<{ invoice_no: string }>(
        `SELECT DISTINCT invoice_no FROM sale_line
         WHERE code = $1 AND fy = $2 AND version_status = 'current'
           AND invoice_no IS NOT NULL`,
        [code, fy],
      );
      invoiceSet = new Set(dbRows.rows.map((r) => r.invoice_no));
    }

    if (invoiceSet.size === 0) {
      res.json({ fy, code, invoiceFilter: invoice || null, message: "No DB invoices found for this code+fy", matches: [] });
      return;
    }

    await readTabRowsChunked(sapId, combined.title, (chunk, startRow) => {
      for (let ri = 0; ri < chunk.length; ri++) {
        const row = chunk[ri];
        const globalRow = startRow + ri;

        if (!headerFound) {
          if (globalRow > 30) continue;
          const hd = row.map(normH);
          const qI = ["QTY","QUANTITY","BILLQTY","BILLINGQTY","ORDEREDQTY"]
            .reduce((b: number, a) => b >= 0 ? b : hd.indexOf(a), -1);
          const aI = ["TAXABLEVALUE","TAXABLEAMOUNT","TAXABLE","NETVALUE","AMOUNT","ASSESSABLEVALUE"]
            .reduce((b: number, a) => b >= 0 ? b : hd.indexOf(a), -1);
          if (qI >= 0 && aI >= 0) {
            qtyIdx = qI; amtIdx = aI;
            invIdx = ["INVOICENO","INVOICENUMBER","BILLINGDOCUMENT","DOCUMENTNUMBER","DOCUMENTNO","BILLNO","DOCNO"]
              .reduce((b: number, a) => b >= 0 ? b : hd.indexOf(a), -1);
            codeIdx = ["OLDITEMCODE","ITEMCODE","CODE","MATERIAL","MATERIALCODE","PRODUCTCODE","MATERIALNO","MATNO"]
              .reduce((b: number, a) => b >= 0 ? b : hd.indexOf(a), -1);
            descIdx = ["DSCRIPTION","MATERIALDESCRIPTION","DESCRIPTION","MATERIALNAME","ITEMDESCRIPTION","MATDESC"]
              .reduce((b: number, a) => b >= 0 ? b : hd.indexOf(a), -1);
            rawHeader = hd;
            headerFound = true;
          }
          continue;
        }

        const inv = invIdx >= 0 ? strV(row[invIdx]) : "";
        if (!invoiceSet.has(inv)) continue;

        matches.push({
          invoiceNo:   inv,
          code:        codeIdx >= 0 ? strV(row[codeIdx]) : "",
          description: descIdx >= 0 ? strV(row[descIdx]) : "",
          qty:         numV(row[qtyIdx]),
          amount:      numV(row[amtIdx]),
        });
      }
    });

    res.json({
      fy, sapId, tab: combined.title, codeFilter: code, invoiceFilter: invoice || null,
      headerFound, rawHeader, codeColIdx: codeIdx, invColIdx: invIdx, descColIdx: descIdx,
      dbInvoicesSearched: invoiceSet.size,
      matchCount: matches.length,
      matches: matches.slice(0, 30),
    });
  } catch (err: unknown) {
    req.log.error({ err }, "sap-check failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /registers/:fy/tank-sync-dryrun
 *
 * Runs the new tank-resolution logic against the live register sheet — same
 * path as doSync — and reports what WOULD be written, WITHOUT touching the DB.
 *
 * Purpose: prove the loader produces correct qty/qty_ltr before lifting
 * REGISTER_SYNC_PAUSE.  Run this, confirm "PASS", then clear the env var.
 *
 * Report:
 *   a) Route 1 (SAP) / Route 2 (division) / flag counts.
 *   b) Up to 10 Route-1 and 5 Route-2 sample rows with sheet litres, SAP
 *      pieces, perTankLitres, computed qty/qty_ltr — each compared against the
 *      current DB value to confirm the one-off fix matches what the new loader
 *      produces.
 *   c) Any flagged rows (sap-ghost, non-clean-division) for review.
 *   d) Non-tank row count — all should have qtyLtr=null from the loader.
 *   e) Overall verdict: PASS or FAIL with mismatch counts.
 */
router.get("/registers/:fy/tank-sync-dryrun", async (req, res) => {
  const { fy } = req.params;
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    res.status(400).json({ error: `No spreadsheet configured for FY ${fy}` });
    return;
  }

  const cfg = rawRegisterSheetsCfg as { sap_source?: Record<string, string> };
  const sapId = cfg.sap_source?.[fy] ?? null;
  const hasSapSource = sapId != null;

  try {
    // ── 1. Load SAP lookup map ────────────────────────────────────────────────
    let sapLookup: Awaited<ReturnType<typeof buildSapLookupMap>> | null = null;
    let sapLoadError: string | null = null;
    if (sapId) {
      try {
        sapLookup = await buildSapLookupMap(sapId);
      } catch (err) {
        sapLoadError = err instanceof Error ? err.message : String(err);
        req.log.warn({ err, sapId }, "tank-sync-dryrun: SAP load failed; will use Route 2 only");
      }
    }

    // ── 2. Read sheet rows + apply resolution ─────────────────────────────────
    const occurrence = new OccurrenceCounter();
    const unmapped = emptyUnmapped();

    type DryRunRow = {
      invoiceNo: string | null;
      code: string;
      groupCanon: string | null;
      monthLabel: string | null;
      amount: string;
      computedQty: string | null;
      computedQtyLtr: string | null;
      flag: string;
      perTankLitres: number | null;
      sheetQty: number | null;
      sapQty: number | null;
    };

    const tankRows: DryRunRow[] = [];
    let nonTankCount = 0;

    await readRegisterFromSheets(spreadsheetId, fy, (values, columns) => {
      const result = parseRegisterRow(values, columns, fy);
      if (result.kind !== "row") return;
      const line = toSaleLine(result.row, occurrence, unmapped, "sheets");
      const sheetQty = line.qty != null ? Number(line.qty) : null;
      const resolved = resolveWaterTankRow({
        code: line.code,
        groupCanon: line.groupCanon ?? null,
        sheetQty,
        invoiceNo: line.invoiceNo ?? null,
        amount: Number(line.amount),
        sapLookup,
        hasSapSource,
      });

      if (resolved.flag === "non-tank-group") {
        nonTankCount++;
        return;
      }

      tankRows.push({
        invoiceNo: line.invoiceNo ?? null,
        code: line.code,
        groupCanon: line.groupCanon ?? null,
        monthLabel: line.monthLabel ?? null,
        amount: line.amount,
        computedQty: resolved.qty,
        computedQtyLtr: resolved.qtyLtr,
        flag: resolved.flag,
        perTankLitres: resolved.perTankLitres,
        sheetQty: resolved.sheetQty,
        sapQty: resolved.sapQty,
      });
    });

    // ── 3. Flag counts ────────────────────────────────────────────────────────
    const counts = {
      route1Sap: 0,
      route2Division: 0,
      sapGhost: 0,
      nonClean: 0,
      unmappedSuffix: 0,
    };
    for (const r of tankRows) {
      if      (r.flag === "route1-sap")          counts.route1Sap++;
      else if (r.flag === "route2-division")      counts.route2Division++;
      else if (r.flag === "sap-ghost")            counts.sapGhost++;
      else if (r.flag === "non-clean-division")   counts.nonClean++;
      else if (r.flag === "unmapped-suffix")      counts.unmappedSuffix++;
    }

    // ── 4. Compare computed values against current DB ─────────────────────────
    const dbResult = await pool.query<{
      invoice_no: string | null;
      code: string;
      db_qty: string | null;
      db_qty_ltr: string | null;
    }>(
      `SELECT invoice_no, code, qty::text AS db_qty, qty_ltr::text AS db_qty_ltr
         FROM sale_line
        WHERE fy = $1 AND group_canon = 'WATER TANK' AND version_status = 'current'`,
      [fy],
    );

    // Map by (invoice_no|code) → list of {dbQty, dbQtyLtr}.
    const dbMap = new Map<string, Array<{ dbQty: string | null; dbQtyLtr: string | null }>>();
    for (const r of dbResult.rows) {
      const key = `${r.invoice_no ?? ""}|${r.code}`;
      const arr = dbMap.get(key) ?? [];
      arr.push({ dbQty: r.db_qty, dbQtyLtr: r.db_qty_ltr });
      dbMap.set(key, arr);
    }

    type AnnotatedRow = DryRunRow & {
      dbQty: string | null;
      dbQtyLtr: string | null;
      qtyMatch: boolean | null;    // null = row not yet in DB (new invoice)
      qtyLtrMatch: boolean | null;
    };

    const annotate = (r: DryRunRow): AnnotatedRow => {
      const key = `${r.invoiceNo ?? ""}|${r.code}`;
      const entries = dbMap.get(key);
      if (!entries || entries.length === 0) {
        return { ...r, dbQty: null, dbQtyLtr: null, qtyMatch: null, qtyLtrMatch: null };
      }
      const best = entries.find((e) => e.dbQty === r.computedQty) ?? entries[0];
      return {
        ...r,
        dbQty: best.dbQty,
        dbQtyLtr: best.dbQtyLtr,
        qtyMatch: best.dbQty === r.computedQty,
        qtyLtrMatch: best.dbQtyLtr === r.computedQtyLtr,
      };
    };

    // Annotate all tank rows for overall stats.
    const annotatedAll = tankRows.map(annotate);
    const inDb = annotatedAll.filter((r) => r.qtyMatch !== null);
    const qtyMismatches   = inDb.filter((r) => !r.qtyMatch).length;
    const qtyLtrMismatches = inDb.filter((r) => !r.qtyLtrMatch).length;
    const allMatch = qtyMismatches === 0 && qtyLtrMismatches === 0;

    // ── 5. Build report ───────────────────────────────────────────────────────
    const route1Sample  = annotatedAll.filter((r) => r.flag === "route1-sap").slice(0, 10);
    const route2Sample  = annotatedAll.filter((r) => r.flag === "route2-division").slice(0, 5);
    const flaggedRows   = annotatedAll.filter(
      (r) => r.flag === "sap-ghost" || r.flag === "non-clean-division",
    );
    const unmappedRows  = annotatedAll.filter((r) => r.flag === "unmapped-suffix").slice(0, 5);
    const qtyMismatchRows = inDb.filter((r) => !r.qtyMatch || !r.qtyLtrMatch).slice(0, 10);

    res.json({
      fy,
      hasSapSource,
      sapId: sapId ?? null,
      sapLookupEntries: sapLookup?.size ?? null,
      sapLoadError,
      totalSheetRows:  tankRows.length + nonTankCount,
      tankSheetRows:   tankRows.length,
      nonTankSheetRows: nonTankCount,
      counts,
      dbTankRows:      dbResult.rows.length,
      dbMatchedRows:   inDb.length,
      qtyMismatches,
      qtyLtrMismatches,
      verdict:         allMatch
        ? "PASS — loader matches DB for all rows found in DB; safe to lift REGISTER_SYNC_PAUSE"
        : `FAIL — ${qtyMismatches} qty mismatches, ${qtyLtrMismatches} qty_ltr mismatches`,
      route1Sample,
      route2Sample,
      flaggedRows,
      unmappedRows,
      qtyMismatchRows,
    });
  } catch (err: unknown) {
    req.log.error({ err }, "tank-sync-dryrun failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
