// Persistence layer for secondary data ingestion.
// Mirrors lib/registers/ingest.ts structure.
// All write paths accept a dryRun flag: when true, nothing is committed to
// the database and the audit run is recorded with status='dry_run'.
import { sql, inArray } from "drizzle-orm";
import {
  db,
  secondaryRegisterLines,
  secondaryHeadMonths,
  secondaryIngestRuns,
  type InsertSecRegLine,
  type InsertSecHeadMonth,
  type InsertSecIngestRun,
} from "@workspace/db";
import type { SecIngestAssertion } from "./types.js";

export const BATCH_SIZE = 1000;

// ── Register lines ────────────────────────────────────────────────────────────

// Count how many of the given line_uids already exist in the DB.
// Used for dry-run reporting.
export async function countExistingSecLineUids(uids: string[]): Promise<number> {
  let existing = 0;
  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    const batch = uids.slice(i, i + BATCH_SIZE);
    const rows = await db
      .select({ lineUid: secondaryRegisterLines.lineUid })
      .from(secondaryRegisterLines)
      .where(inArray(secondaryRegisterLines.lineUid, batch));
    existing += rows.length;
  }
  return existing;
}

// Insert secondary register lines in batches.
// ON CONFLICT DO NOTHING — first source wins, idempotent.
// When dryRun=true, skips all inserts and returns { inserted: 0 }.
export async function insertSecRegLineBatches(
  lines: InsertSecRegLine[],
  dryRun = false,
): Promise<{ inserted: number }> {
  if (dryRun) return { inserted: 0 };
  let inserted = 0;
  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, i + BATCH_SIZE);
    const rows = await db
      .insert(secondaryRegisterLines)
      .values(batch)
      .onConflictDoNothing()
      .returning({ lineUid: secondaryRegisterLines.lineUid });
    inserted += rows.length;
  }
  return { inserted };
}

// ── Secondary head months ─────────────────────────────────────────────────────

// Upsert secondary_head_month rows keyed by (fy, head_canon, month_label).
// ON CONFLICT: update all metric fields (last write wins — these figures are
// re-read from Sheets every sync cycle and the sheet is authoritative).
// When dryRun=true, skips all writes and returns { upserted: 0 }.
export async function upsertSecHeadMonths(
  rows: InsertSecHeadMonth[],
  dryRun = false,
): Promise<{ upserted: number }> {
  if (dryRun) return { upserted: 0 };
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(secondaryHeadMonths)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          secondaryHeadMonths.fy,
          secondaryHeadMonths.headCanon,
          secondaryHeadMonths.monthLabel,
        ],
        set: {
          headRaw: sql`excluded.head_raw`,
          stateHead: sql`excluded.state_head`,
          monthIdx: sql`excluded.month_idx`,
          planAmount: sql`excluded.plan_amount`,
          orderedAmount: sql`excluded.ordered_amount`,
          receivedAmount: sql`excluded.received_amount`,
          achievementPct: sql`excluded.achievement_pct`,
          isAnomaly: sql`excluded.is_anomaly`,
          notYetRecorded: sql`excluded.not_yet_recorded`,
          sourceSheetId: sql`excluded.source_sheet_id`,
          ingestedAt: sql`now()`,
        },
      });
    upserted += batch.length;
  }
  return { upserted };
}

// ── Audit run ────────────────────────────────────────────────────────────────

export async function recordSecIngestRun(
  run: InsertSecIngestRun,
  dryRun = false,
): Promise<void> {
  const record: InsertSecIngestRun = dryRun
    ? { ...run, status: "dry_run" }
    : run;
  await db.insert(secondaryIngestRuns).values(record);
}

// ── Helpers for dry-run summary ───────────────────────────────────────────────

export function buildSecIngestRun(opts: {
  source: string;
  fy: string;
  rowsRead: number;
  rowsInserted: number;
  rowsSkipped: number;
  unmapped: object;
  assertions: SecIngestAssertion[];
  status: "ok" | "fail" | "dry_run";
}): InsertSecIngestRun {
  return {
    startedAt: new Date(),
    source: opts.source,
    fy: opts.fy,
    rowsRead: opts.rowsRead,
    rowsInserted: opts.rowsInserted,
    rowsSkipped: opts.rowsSkipped,
    unmapped: opts.unmapped,
    assertions: opts.assertions,
    status: opts.status,
  };
}
