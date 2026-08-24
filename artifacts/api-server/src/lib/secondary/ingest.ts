// Persistence layer for secondary data ingestion.
// Mirrors lib/registers/ingest.ts structure.
// All write paths accept a dryRun flag: when true, nothing is committed to
// the database and the audit run is recorded with status='dry_run'.
import { eq, sql, inArray } from "drizzle-orm";
import {
  db,
  secondaryRegisterLines,
  secondaryHeadMonths,
  secondaryHeadMonthRevisions,
  secondaryIngestRuns,
  type InsertSecRegLine,
  type InsertSecHeadMonth,
  type InsertSecIngestRun,
} from "@workspace/db";
import type { SecIngestAssertion } from "./types.js";

export const BATCH_SIZE = 1000;
export type ValidatedSecHeadMonthInput = Omit<InsertSecHeadMonth, "ingestRunId">;

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

// Persist one validated State Head Dashboard load. The run, immutable source
// revisions, current rows, and run completion marker share one transaction:
// an aborted batch cannot leave either current data or audit evidence behind.
//
// Revisions are written for every source row, even when the values are
// unchanged from the prior run. That makes the source run itself reconstructible
// and keeps "unchanged" distinct from "not loaded".
export async function persistValidatedSecHeadMonths(
  rows: ValidatedSecHeadMonthInput[],
  run: InsertSecIngestRun,
): Promise<{ ingestRunId: number; upserted: number; revisionsInserted: number }> {
  return db.transaction(async (tx) => {
    const [createdRun] = await tx
      .insert(secondaryIngestRuns)
      .values({ ...run, status: "running" })
      .returning({ id: secondaryIngestRuns.id });

    if (!createdRun) throw new Error("secondary ingest run was not created");

    let revisionsInserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const revisionRows = batch.map((row) => ({
        ingestRunId: createdRun.id,
        fy: row.fy,
        headRaw: row.headRaw,
        headCanon: row.headCanon,
        stateHead: row.stateHead,
        monthLabel: row.monthLabel,
        monthIdx: row.monthIdx,
        planAmount: row.planAmount,
        orderedAmount: row.orderedAmount,
        receivedAmount: row.receivedAmount,
        achievementPct: row.achievementPct,
        isAnomaly: row.isAnomaly,
        notYetRecorded: row.notYetRecorded,
        sourceSheetId: row.sourceSheetId,
      }));
      const inserted = await tx
        .insert(secondaryHeadMonthRevisions)
        .values(revisionRows)
        .onConflictDoNothing()
        .returning({ id: secondaryHeadMonthRevisions.id });
      revisionsInserted += inserted.length;

      const currentRows = batch.map((row) => ({
        ...row,
        ingestRunId: createdRun.id,
      }));
      await tx
        .insert(secondaryHeadMonths)
        .values(currentRows)
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
            ingestRunId: sql`excluded.ingest_run_id`,
            ingestedAt: sql`now()`,
          },
        });
    }

    await tx
      .update(secondaryIngestRuns)
      .set({
        status: "ok",
        rowsInserted: rows.length,
      })
      .where(eq(secondaryIngestRuns.id, createdRun.id));

    return {
      ingestRunId: createdRun.id,
      upserted: rows.length,
      revisionsInserted,
    };
  });
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
