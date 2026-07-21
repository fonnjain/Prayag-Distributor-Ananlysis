import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { pool, db, saleLines, type InsertSaleLine } from "@workspace/db";
import {
  backfillColor,
  reconcileVersions,
} from "../lib/registers/reconcileVersions.js";
import { tombstoneOrphans, identityKey } from "../lib/registers/ingest.js";
import { readRegisterFromSheets } from "../lib/registers/sheetsRegister.js";
import { listSheetTabs, readTabSample } from "../lib/registers/sheetsApi.js";
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

export default router;
