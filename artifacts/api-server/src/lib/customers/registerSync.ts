// Auto-populates sale_line from the live sale/dispatch register Sheets.
//
// Sync model:
//   • On startup, ensureRegisterSynced(fy) is called for every configured FY.
//   • For COMPLETED fiscal years (end date already past), the sync runs once
//     per process lifetime: hasRows() = true → done, never retried.
//   • For the CURRENT open FY, the sync re-runs every OPEN_FY_RESYNC_MS even
//     when rows already exist, picking up new invoices added to the sheet.
//     ON CONFLICT DO NOTHING means existing rows are never overwritten.
//   • startScheduledRegisterSync() starts a timer that re-syncs all FYs on a
//     fixed interval. The current open FY picks up new rows; completed FYs are
//     fast no-ops (all UIDs already present).
//
// State is module-level (process-scoped). The /api/customers/months route
// reads it to return syncing:true while a load is in progress.
import { pool, type InsertSaleLine } from "@workspace/db";
import { logger } from "../logger.js";
import registerSheets from "../../../config/register_sheets.json";
import { readRegisterFromSheets } from "../registers/sheetsRegister.js";
import {
  OccurrenceCounter,
  emptyUnmapped,
  parseRegisterRow,
  toSaleLine,
} from "../registers/normalize.js";
import { versionedSyncLines } from "../registers/ingest.js";

export const REGISTER_SHEET_IDS: Record<string, string> =
  registerSheets.registers;

// ── Anchor health ──────────────────────────────────────────────────────────────
// Per (fy, month) comparison of DB current rows vs sheet rows after each sync.
// Persists in process memory; refreshed on every doSync run.
export type AnchorCheckResult = {
  fy: string;
  month: string;
  dbCurrentRows: number;
  sheetRows: number;
  dbCurrentTotal: number;
  sheetTotal: number;
  /** positive = DB has more than sheet (orphans); negative = sheet has more (not yet inserted) */
  rowDelta: number;
  totalDelta: number;
  divergencePct: number;
  /** ok: within rounding. diverged: small mismatch. suspected-read-failure: >10% gap */
  status: "ok" | "diverged" | "suspected-read-failure";
  checkedAt: string;
};

const anchorHealthMap = new Map<string, AnchorCheckResult>();

export function getAnchorHealth(): AnchorCheckResult[] {
  return [...anchorHealthMap.values()].sort(
    (a, b) => a.fy.localeCompare(b.fy) || a.month.localeCompare(b.month),
  );
}

export type SyncPhase = "idle" | "syncing" | "done" | "error";

type FyState = {
  phase: SyncPhase;
  rows: number;
  error?: string;
  inFlight: Promise<void> | null;
};

const byFy = new Map<string, FyState>();

// Track last successful full sync time per FY (resets on process restart).
const lastSyncedAtMs = new Map<string, number>();

// Re-sync TTL for the current open FY: 6 hours.
// A completed FY is never re-synced (no new invoices possible).
const OPEN_FY_RESYNC_MS = 6 * 60 * 60 * 1000;

// Scheduled sync interval — same as the resync TTL so a schedule tick always
// finds stale data for the open FY.
const SCHEDULE_INTERVAL_MS = OPEN_FY_RESYNC_MS;

function stateFor(fy: string): FyState {
  let s = byFy.get(fy);
  if (!s) {
    s = { phase: "idle", rows: 0, inFlight: null };
    byFy.set(fy, s);
  }
  return s;
}

export function getRegisterSyncState(fy: string): {
  phase: SyncPhase;
  rows: number;
  error?: string;
} {
  const s = byFy.get(fy);
  return { phase: s?.phase ?? "idle", rows: s?.rows ?? 0, error: s?.error };
}

/** ISO-8601 timestamp of the most recent successful register sync for this FY, or null. */
export function getLastSyncedAt(fy: string): string | null {
  const ms = lastSyncedAtMs.get(fy);
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

// Returns true if today is within the fiscal year (i.e., March 31 of the end
// year is still in the future). Completed FYs never gain new rows.
export function isFyOpen(fy: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!match) return false;
  const endYear = 2000 + parseInt(match[2], 10);
  // FY ends on March 31 of the second year.
  return Date.now() < Date.UTC(endYear, 2, 31); // month is 0-indexed
}

async function hasRows(fy: string): Promise<boolean> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sale_line WHERE fy = $1 LIMIT 1`,
    [fy],
  );
  return parseInt(res.rows[0]?.n ?? "0", 10) > 0;
}

async function doSync(fy: string, spreadsheetId: string): Promise<void> {
  const s = stateFor(fy);
  s.phase = "syncing";
  logger.info({ fy, spreadsheetId }, "register sync: starting");
  try {
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

    // ── Guard: zero-row abort ────────────────────────────────────────────────
    // A silent empty read (API outage, auth error, or wrong tab detection) must
    // NEVER reach versionedSyncLines — the tombstone pass inside it would
    // supersede every row in the month as an orphan.
    if (lines.length === 0) {
      s.phase = "error";
      s.error = "zero rows returned from sheet — sync aborted to prevent silent wipe";
      logger.error(
        { fy, spreadsheetId, tabsRead, rowsScanned },
        "register sync: zero rows — aborting",
      );
      return;
    }

    const syncedAt = new Date();
    // ── Step 3 + 4: upsert + tombstone pass (tombstone is inside versionedSyncLines) ──
    const { touched, superseded, inserted, tombstoned } = await versionedSyncLines(lines, syncedAt);

    lastSyncedAtMs.set(fy, Date.now());
    s.rows = lines.length;
    s.phase = "done";
    logger.info(
      {
        fy,
        spreadsheetId,
        tabsRead,
        rowsScanned,
        linesBuilt: lines.length,
        touched,
        superseded,
        inserted,
        tombstoned,
        unmappedGroups: Object.keys(unmapped.unmapped_groups).length,
        unmappedHeads: Object.keys(unmapped.unmapped_heads).length,
      },
      "register sync: complete",
    );

    // ── Step 5: anchor check — DB current vs sheet, per month ───────────────
    // Runs AFTER the tombstone pass. A healthy month has rowDelta=0 and
    // totalDelta≤1. A halted blast-radius month shows rowDelta>0 with
    // divergencePct>10 and is flagged suspected-read-failure.
    const sheetByMonth = new Map<string, { rows: number; total: number }>();
    for (const line of lines) {
      const m = line.monthLabel ?? "(unknown)";
      const e = sheetByMonth.get(m) ?? { rows: 0, total: 0 };
      e.rows++;
      e.total += Number(line.amount) || 0;
      sheetByMonth.set(m, e);
    }

    const dbResult = await pool.query<{ month_label: string; rows: string; total: string }>(
      `SELECT month_label,
              COUNT(*)::text AS rows,
              COALESCE(SUM(amount::numeric), 0)::text AS total
         FROM sale_line
        WHERE fy = $1 AND version_status = 'current'
        GROUP BY month_label`,
      [fy],
    );
    const dbByMonth = new Map<string, { rows: number; total: number }>();
    for (const r of dbResult.rows) {
      dbByMonth.set(r.month_label, {
        rows: parseInt(r.rows, 10),
        total: parseFloat(r.total),
      });
    }

    const checkedAt = new Date().toISOString();
    const allMonths = new Set([...sheetByMonth.keys(), ...dbByMonth.keys()]);
    for (const month of allMonths) {
      const sheet = sheetByMonth.get(month) ?? { rows: 0, total: 0 };
      const db = dbByMonth.get(month) ?? { rows: 0, total: 0 };
      const rowDelta = db.rows - sheet.rows;
      const totalDelta = db.total - sheet.total;
      const denominator = Math.max(db.rows, sheet.rows, 1);
      const divergencePct = (Math.abs(rowDelta) / denominator) * 100;

      let status: AnchorCheckResult["status"] = "ok";
      if (rowDelta !== 0 || Math.abs(totalDelta) > 1) {
        status = divergencePct > 10 ? "suspected-read-failure" : "diverged";
      }

      const result: AnchorCheckResult = {
        fy, month,
        dbCurrentRows: db.rows, sheetRows: sheet.rows,
        dbCurrentTotal: Math.round(db.total), sheetTotal: Math.round(sheet.total),
        rowDelta, totalDelta: Math.round(totalDelta),
        divergencePct, status, checkedAt,
      };
      anchorHealthMap.set(`${fy}|${month}`, result);

      if (status !== "ok") {
        logger.warn(
          { fy, month, dbCurrentRows: db.rows, sheetRows: sheet.rows,
            rowDelta, divergencePct: divergencePct.toFixed(1), status },
          "anchor check: diverged",
        );
      }
    }
  } catch (err) {
    s.phase = "error";
    s.error = err instanceof Error ? err.message : String(err);
    logger.error({ fy, spreadsheetId, err }, "register sync: failed");
  } finally {
    s.inFlight = null;
  }
}

// Ensures sale_line is being populated for this FY.
//   - Completed FYs: syncs once on first call; subsequent calls are no-ops.
//   - Open (current) FY: syncs on first call and re-syncs after OPEN_FY_RESYNC_MS.
export function ensureRegisterSynced(fy: string): void {
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) return;

  const s = stateFor(fy);
  if (s.phase === "syncing" || s.inFlight) return;

  s.inFlight = (async () => {
    try {
      const already = await hasRows(fy);
      if (already) {
        const open = isFyOpen(fy);
        if (!open) {
          // Completed FY with rows: no new invoices possible, skip forever.
          s.phase = "done";
          s.inFlight = null;
          return;
        }
        const lastSync = lastSyncedAtMs.get(fy);
        const recentlySynced =
          lastSync != null && Date.now() - lastSync < OPEN_FY_RESYNC_MS;
        if (recentlySynced) {
          // Open FY but recently synced this process lifetime: skip for now.
          s.phase = "done";
          s.inFlight = null;
          return;
        }
        // Open FY that has not been synced recently: re-sync to pick up new rows.
      }
      await doSync(fy, spreadsheetId);
    } catch (err) {
      s.phase = "error";
      s.error = err instanceof Error ? err.message : String(err);
      s.inFlight = null;
      logger.error({ fy, err }, "ensureRegisterSynced: outer catch");
    }
  })();
}

// Starts a periodic background sync for all configured FYs.
// Only the OPEN FY is re-read; closed FYs are served from Postgres.
// Overlapping runs are prevented by the inFlight guard in doSync.
let scheduledRegisterSyncTimer: NodeJS.Timeout | null = null;

/**
 * Run one tick of the scheduled sync: skips closed FYs, syncs the open one.
 * Exported so a test/admin endpoint can trigger a manual tick.
 */
export function runScheduledTick(): void {
  for (const [fy, spreadsheetId] of Object.entries(REGISTER_SHEET_IDS)) {
    // CHANGE 1: closed years are frozen — skip on the scheduled path.
    // The startup path (ensureRegisterSynced) already has its own isFyOpen
    // guard; this adds the same protection to the periodic scheduler.
    // Sheet IDs are kept in config for provenance and rare deliberate re-loads.
    if (!isFyOpen(fy)) {
      logger.info({ fy }, "scheduled register sync: closed FY — skipping");
      continue;
    }
    const s = stateFor(fy);
    if (s.inFlight) continue; // already running
    s.inFlight = doSync(fy, spreadsheetId).catch((err: unknown) => {
      logger.error({ fy, err }, "scheduled register sync: failed");
    });
  }
}

export function startScheduledRegisterSync(): void {
  if (scheduledRegisterSyncTimer) return;

  logger.info(
    { intervalHours: SCHEDULE_INTERVAL_MS / 3_600_000 },
    "scheduled register sync enabled",
  );

  scheduledRegisterSyncTimer = setInterval(runScheduledTick, SCHEDULE_INTERVAL_MS);
  // Do not keep the process alive solely for the scheduler.
  scheduledRegisterSyncTimer.unref();
}
