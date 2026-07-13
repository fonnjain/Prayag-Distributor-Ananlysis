// Auto-populates sale_line from the live order-register Sheets on server
// startup. Runs per-FY: if the table already has rows for the FY the sync is a
// no-op. A background promise is kept in-flight so concurrent requests share
// the same load instead of spawning duplicate reads.
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
import { insertSaleLineBatches } from "../registers/ingest.js";

export const REGISTER_SHEET_IDS: Record<string, string> =
  registerSheets.registers;

export type SyncPhase = "idle" | "syncing" | "done" | "error";

type FyState = {
  phase: SyncPhase;
  rows: number;
  error?: string;
  inFlight: Promise<void> | null;
};

const byFy = new Map<string, FyState>();

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

    const { inserted } = await insertSaleLineBatches(lines);
    s.rows = lines.length;
    s.phase = "done";
    logger.info(
      {
        fy,
        spreadsheetId,
        tabsRead,
        rowsScanned,
        linesBuilt: lines.length,
        inserted,
        unmappedGroups: Object.keys(unmapped.unmapped_groups).length,
        unmappedHeads: Object.keys(unmapped.unmapped_heads).length,
      },
      "register sync: complete",
    );
  } catch (err) {
    s.phase = "error";
    s.error = err instanceof Error ? err.message : String(err);
    logger.error({ fy, spreadsheetId, err }, "register sync: failed");
  } finally {
    s.inFlight = null;
  }
}

// Ensures sale_line is being populated for this FY. If already synced or in
// progress, returns immediately. Otherwise starts a background sync and
// returns without blocking the caller.
export function ensureRegisterSynced(fy: string): void {
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) return;

  const s = stateFor(fy);
  if (s.phase === "done" || s.phase === "syncing") return;
  if (s.inFlight) return;

  s.inFlight = (async () => {
    try {
      const already = await hasRows(fy);
      if (already) {
        s.phase = "done";
        s.inFlight = null;
        return;
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
