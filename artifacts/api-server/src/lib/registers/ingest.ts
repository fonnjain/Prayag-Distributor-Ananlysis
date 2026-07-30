// Shared persistence layer for register ingestion (xlsx backfill and live
// Sheets sync). Idempotency comes from ON CONFLICT (line_uid) DO NOTHING —
// the existing row always wins, so a Sheets row is never overwritten by a
// backfill row.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  saleLines,
  itemMaster,
  ingestRuns,
  type InsertSaleLine,
  type InsertIngestRun,
} from "@workspace/db";
import { allowDelete } from "../deleteGuard.js";
import { logger } from "../logger.js";
import expectedCounts from "../../../config/expected_counts.json";
import type { UnmappedReport } from "./normalize.js";

export const BATCH_SIZE = 1000;

// Expected row counts per FY (spec section A). The prior-year block repeats
// across files with identical counts, so the per-FY expectation is unique.
export const EXPECTED_FY_COUNTS: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const perFile of Object.values(
    expectedCounts.registers as Record<string, Record<string, number>>,
  )) {
    for (const [fyRaw, count] of Object.entries(perFile)) {
      out[fyRaw.replace(/^FY-/, "")] = count;
    }
  }
  return out;
})();

export const EXPECTED_TOTAL_LINES = expectedCounts.total_distinct_sale_lines;

// ── Shared identity key ────────────────────────────────────────────────────────
// Stable across rate edits: invoice_no | code | color | qty | month_label.
// Rate and amount are MUTABLE — intentionally excluded.
// Used by both versionedSyncLines and tombstoneOrphans so the key is consistent.
//
// serialNo (optional): when present, appended as "|sn:<n>" so that two
// physically distinct lines sharing the same invoice+code+colour+qty but
// printed on different rows of the sheet are treated as different identities.
// For FYs without a serial-number column (serialNo = null/undefined) the key
// falls back to the five-field form, preserving backward compatibility.
export function identityKey(
  invoiceNo: string | null,
  code: string,
  color: string | null,
  qty: string | null,
  monthLabel: string | null,
  serialNo?: number | null,
): string {
  const base = `${invoiceNo ?? ""}|${code}|${color ?? ""}|${qty ?? ""}|${monthLabel ?? ""}`;
  return serialNo != null ? `${base}|sn:${serialNo}` : base;
}

// Deduplicate a batch before insert.
// When a row has serial_no set: key = (fy, month_label, serial_no,
// invoice_no, code, color, qty). Combining the serial number with the full
// 5-field natural key ensures that two rows sharing a serial number but
// carrying different invoice/code/colour/qty are both kept (they are distinct
// dispatch lines whose serial happened to collide or be reassigned by the
// sheet author). Only a row that is identical on ALL six dimensions is treated
// as a true double-read and suppressed.
//
// PRIOR BEHAVIOUR (fy|monthLabel|serialNo only) was too broad: it collapsed
// rows that differed by colour or code when they shared a serial, silently
// dropping 16 May and 12 June rows in FY2026-27.
//
// When serial_no is absent (historical FYs without column A): no in-memory
// dedup — trust the occurrence-counter in line_uid to distinguish legitimate
// variant lines. The DB ON CONFLICT (line_uid) DO NOTHING handles residual
// hash collisions.
function dedupeBySerialNo(lines: InsertSaleLine[]): InsertSaleLine[] {
  const seen = new Set<string>();
  const out: InsertSaleLine[] = [];
  for (const line of lines) {
    if (line.serialNo != null && line.monthLabel != null) {
      // Six-field key: serial narrows to a physical row; the natural-key fields
      // distinguish genuinely different rows that share a serial.
      const key = [
        line.fy ?? "",
        line.monthLabel,
        line.serialNo,
        line.invoiceNo ?? "",
        line.code,
        line.color ?? "",
        line.qty ?? "",
      ].join("|");
      if (!seen.has(key)) {
        seen.add(key);
        out.push(line);
      }
    } else {
      out.push(line);
    }
  }
  return out;
}

export async function insertSaleLineBatches(
  lines: InsertSaleLine[],
): Promise<{ inserted: number }> {
  // Dedupe within the incoming set before hitting the DB.
  const deduped = dedupeBySerialNo(lines);

  // Self-healing cleanup: if ALL incoming rows for an FY have serial_no set,
  // the source data is in the serial-aware format (column A present).
  // Any existing NULL-serial rows for that FY are artifacts of an older sync
  // run (before serial_no capture) and would cause apparent doubling because
  // the partial unique index only covers (serial_no IS NOT NULL). Delete them
  // before inserting so the new serial rows become the sole copy.
  const fySet = new Set(deduped.map((r) => r.fy).filter((f): f is string => f != null));
  for (const fy of fySet) {
    const fyRows = deduped.filter((r) => r.fy === fy);
    const allHaveSerial = fyRows.every((r) => r.serialNo != null);
    if (allHaveSerial && fyRows.length > 0) {
      await allowDelete(async (tx) => {
        await tx.delete(saleLines).where(and(eq(saleLines.fy, fy), isNull(saleLines.serialNo)));
      });
    }
  }

  let inserted = 0;
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    const rows = await db
      .insert(saleLines)
      .values(batch)
      .onConflictDoNothing()
      .returning({ lineUid: saleLines.lineUid });
    inserted += rows.length;
  }
  return { inserted };
}

// Counts how many of the given line_uids already exist (dry-run support).
export async function countExistingLineUids(uids: string[]): Promise<number> {
  let existing = 0;
  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    const batch = uids.slice(i, i + BATCH_SIZE);
    const rows = await db
      .select({ lineUid: saleLines.lineUid })
      .from(saleLines)
      .where(inArray(saleLines.lineUid, batch));
    existing += rows.length;
  }
  return existing;
}

export type IngestAssertion = {
  name: string;
  passed: boolean;
  detail: string;
};

export function assertFyCounts(
  fyCounts: Record<string, number>,
): IngestAssertion[] {
  const assertions: IngestAssertion[] = [];
  for (const [fy, count] of Object.entries(fyCounts)) {
    const expected = EXPECTED_FY_COUNTS[fy];
    if (expected == null) {
      assertions.push({
        name: `row_count_${fy}`,
        passed: false,
        detail: `no expected count on record for FY ${fy} (got ${count})`,
      });
    } else {
      assertions.push({
        name: `row_count_${fy}`,
        passed: count === expected,
        detail: `expected ${expected}, got ${count}`,
      });
    }
  }
  return assertions;
}

export function assertUnmappedEmpty(
  unmapped: UnmappedReport,
): IngestAssertion[] {
  return [
    {
      name: "unmapped_groups_empty",
      passed: Object.keys(unmapped.unmapped_groups).length === 0,
      detail: JSON.stringify(unmapped.unmapped_groups),
    },
    {
      name: "unmapped_heads_empty",
      passed: Object.keys(unmapped.unmapped_heads).length === 0,
      detail: JSON.stringify(unmapped.unmapped_heads),
    },
    {
      name: "unmapped_states_empty",
      passed: Object.keys(unmapped.unmapped_states).length === 0,
      detail: JSON.stringify(unmapped.unmapped_states),
    },
  ];
}

// Spec Task 8 assertion 1: sum(amount) grouped by group/head/state must each
// equal the grand total within one rupee. Catches NaN amounts and rows whose
// canon value was dropped during normalization (raw present, canon null).
// Genuinely blank source cells (raw empty too) are an upstream data-entry gap:
// they go into an explicit "(blank)" bucket — mirroring SQL NULL-group
// semantics — so sums stay consistent, and are reported in the detail.
const BLANK_BUCKET = "(blank)";

export function assertSumConsistency(
  lines: Pick<
    InsertSaleLine,
    | "amount"
    | "groupCanon"
    | "headCanon"
    | "stateCanon"
    | "groupRaw"
    | "headRaw"
    | "stateRaw"
  >[],
): IngestAssertion[] {
  let grand = 0;
  let badAmounts = 0;
  const byGroup = new Map<string, number>();
  const byHead = new Map<string, number>();
  const byState = new Map<string, number>();
  // Rows where a raw value exists but normalization produced no canon —
  // this is real bucket loss and fails the run.
  let droppedGroup = 0;
  let droppedHead = 0;
  let droppedState = 0;
  const bump = (map: Map<string, number>, key: string, amount: number) =>
    map.set(key, (map.get(key) ?? 0) + amount);
  const bucket = (
    canon: string | null | undefined,
    raw: string | null | undefined,
  ): { key: string | null; dropped: boolean } => {
    if (canon) return { key: canon, dropped: false };
    if (raw != null && raw.trim() !== "") return { key: null, dropped: true };
    return { key: BLANK_BUCKET, dropped: false };
  };
  for (const line of lines) {
    const amount = Number(line.amount);
    if (!Number.isFinite(amount)) {
      badAmounts++;
      continue;
    }
    grand += amount;
    const g = bucket(line.groupCanon, line.groupRaw);
    if (g.key) bump(byGroup, g.key, amount);
    if (g.dropped) droppedGroup++;
    const h = bucket(line.headCanon, line.headRaw);
    if (h.key) bump(byHead, h.key, amount);
    if (h.dropped) droppedHead++;
    const s = bucket(line.stateCanon, line.stateRaw);
    if (s.key) bump(byState, s.key, amount);
    if (s.dropped) droppedState++;
  }
  const total = (map: Map<string, number>) =>
    [...map.values()].reduce((a, b) => a + b, 0);
  const groupSum = total(byGroup);
  const headSum = total(byHead);
  const stateSum = total(byState);
  const within = (a: number) => Math.abs(a - grand) <= 1;
  const passed =
    badAmounts === 0 &&
    droppedGroup === 0 &&
    droppedHead === 0 &&
    droppedState === 0 &&
    within(groupSum) &&
    within(headSum) &&
    within(stateSum);
  const problems: string[] = [];
  if (badAmounts > 0) problems.push(`${badAmounts} rows with non-numeric amount`);
  if (droppedGroup > 0) problems.push(`${droppedGroup} rows lost group_canon despite raw value`);
  if (droppedHead > 0) problems.push(`${droppedHead} rows lost head_canon despite raw value`);
  if (droppedState > 0) problems.push(`${droppedState} rows lost state_canon despite raw value`);
  if (!within(groupSum)) problems.push(`by_group sum off by ${Math.round(groupSum - grand)}`);
  if (!within(headSum)) problems.push(`by_head sum off by ${Math.round(headSum - grand)}`);
  if (!within(stateSum)) problems.push(`by_state sum off by ${Math.round(stateSum - grand)}`);
  const blanks = [byGroup, byHead, byState]
    .map((m, i) => ({ dim: ["group", "head", "state"][i], amt: m.get(BLANK_BUCKET) }))
    .filter((b) => b.amt != null)
    .map((b) => `${b.dim} blank=${Math.round(b.amt as number)}`);
  return [
    {
      name: "sum_consistency",
      passed,
      detail:
        problems.length > 0
          ? problems.join("; ")
          : `grand=${Math.round(grand)}, by_group=${Math.round(groupSum)} (${byGroup.size} buckets), by_head=${Math.round(headSum)} (${byHead.size}), by_state=${Math.round(stateSum)} (${byState.size})${blanks.length > 0 ? `; source blanks: ${blanks.join(", ")}` : ""}`,
    },
  ];
}

// Spec Task 8 assertion 3: no negative amounts outside flagged returns. The
// registers carry no returns flag, so any negative amount fails the run and
// must be investigated rather than silently ingested.
export function assertNoNegativeAmounts(
  lines: Pick<InsertSaleLine, "amount" | "invoiceNo" | "code">[],
): IngestAssertion[] {
  const negatives = lines.filter((l) => Number(l.amount) < 0);
  const samples = negatives
    .slice(0, 3)
    .map((l) => `${l.invoiceNo ?? "?"}/${l.code}: ${l.amount}`);
  return [
    {
      name: "no_negative_amounts",
      passed: negatives.length === 0,
      detail:
        negatives.length === 0
          ? "none"
          : `${negatives.length} negative amounts, e.g. ${samples.join("; ")}`,
    },
  ];
}

/**
 * Stamps `sheet_confirmed_at` on every sale_line whose line_uid was found in
 * the most recent live-sheet read. Called after every sync (scheduled and
 * manual backfill). Rows absent from the sheet keep their prior value:
 *   null (never confirmed)   → disputed after first run
 *   old timestamp            → previously confirmed, now missing from sheet
 */
export async function markSheetConfirmed(
  lineUids: string[],
  confirmedAt: Date,
): Promise<void> {
  for (let i = 0; i < lineUids.length; i += BATCH_SIZE) {
    const batch = lineUids.slice(i, i + BATCH_SIZE);
    await db
      .update(saleLines)
      .set({ sheetConfirmedAt: confirmedAt })
      .where(inArray(saleLines.lineUid, batch));
  }
}

export async function recordIngestRun(run: InsertIngestRun): Promise<void> {
  await db.insert(ingestRuns).values(run);
}

export type VersionedSyncResult = {
  touched: number;
  superseded: number;
  inserted: number;
  /** Rows that existed as superseded in the DB but were present again in the
   *  sheet — revived back to version_status='current' rather than silently
   *  dropped by INSERT ON CONFLICT DO NOTHING. */
  revived: number;
  tombstoned: number;
};

export type TombstoneResult = {
  fy: string;
  month: string;
  currentInScope: number;
  currentAmountInScope: number;
  candidateCount: number;
  candidateAmount: number;
  blastRadiusPct: number;
  limitPct: number;
  /** true when the pass was skipped due to a guard (zero-row or blast-radius) */
  halted: boolean;
  haltReason?: string;
  dryRun: boolean;
  applied: number;
  /** Up to 20 sample orphan rows, always populated regardless of dryRun / halted */
  sampleRows: Array<{
    lineUid: string;
    invoiceNo: string | null;
    code: string;
    color: string | null;
    qty: string | null;
    amount: string;
    ingestedAt: string | null;
  }>;
};

/**
 * Tombstone (supersede) current rows that are no longer in the live sheet.
 *
 * GUARDS — all six must pass before any row is marked:
 *  1. SCOPE      — only rows for the exact (fy, month) tab that was just read
 *  2. PRECOND    — abort if incomingRowCount === 0 (bad / empty tab read)
 *  2.5 SHORT-READ — abort if incomingRowCount < current DB rows for this month;
 *                   a complete read must return at least as many rows as already
 *                   exist, so fewer means the read is truncated
 *  3. BLAST      — halt if candidates exceed blastRadiusLimitPct of current rows
 *  4. DRY-RUN    — never writes when dryRun = true; always returns full report
 *  5. LOG        — every tombstone is logged with syncRunId for traceability
 */
export async function tombstoneOrphans(opts: {
  fy: string;
  month: string;
  seenIdentities: Set<string>;
  incomingRowCount: number;
  syncRunId: string;
  dryRun: boolean;
  blastRadiusLimitPct?: number;
}): Promise<TombstoneResult> {
  const {
    fy,
    month,
    seenIdentities,
    incomingRowCount,
    syncRunId,
    dryRun,
    blastRadiusLimitPct = 10,
  } = opts;

  // Guard 2: zero incoming rows = bad read; abort without touching the DB
  if (incomingRowCount === 0) {
    logger.warn({ fy, month, syncRunId }, "tombstone: zero incoming rows — aborting to prevent silent wipe");
    return {
      fy, month,
      currentInScope: 0, currentAmountInScope: 0,
      candidateCount: 0, candidateAmount: 0,
      blastRadiusPct: 0, limitPct: blastRadiusLimitPct,
      halted: true,
      haltReason: "incomingRowCount is zero — aborting to prevent silent wipe",
      dryRun, applied: 0, sampleRows: [],
    };
  }

  // Guard 1: scope — query only the exact (fy, month) that was read
  const currentRows = await db
    .select({
      lineUid: saleLines.lineUid,
      invoiceNo: saleLines.invoiceNo,
      code: saleLines.code,
      color: saleLines.color,
      qty: saleLines.qty,
      serialNo: saleLines.serialNo,
      monthLabel: saleLines.monthLabel,
      amount: saleLines.amount,
      ingestedAt: saleLines.ingestedAt,
    })
    .from(saleLines)
    .where(
      and(
        eq(saleLines.fy, fy),
        eq(saleLines.monthLabel, month),
        eq(saleLines.versionStatus, "current"),
      ),
    );

  const currentInScope = currentRows.length;
  const currentAmountInScope = currentRows.reduce((s, r) => s + Number(r.amount), 0);

  // Guard 2.5: short-read — the incoming row count must be >= the number of
  // current rows we already have for this (fy, month). Any complete read of a
  // month should surface at least as many lines as are already stored; fewer
  // means the Sheets API returned a truncated page. Tombstoning against a
  // truncated read would permanently delete rows that are still in the sheet.
  if (incomingRowCount < currentInScope) {
    logger.warn(
      { fy, month, incomingRowCount, currentInScope, syncRunId },
      "tombstone: incoming row count less than current DB rows — read appears short, aborting tombstone pass for this month",
    );
    return {
      fy, month, currentInScope, currentAmountInScope,
      candidateCount: 0, candidateAmount: 0,
      blastRadiusPct: 0, limitPct: blastRadiusLimitPct,
      halted: true,
      haltReason: `incoming ${incomingRowCount} rows < current DB ${currentInScope} rows — read appears short`,
      dryRun, applied: 0, sampleRows: [],
    };
  }

  const orphans = currentRows.filter((r) => {
    const key = identityKey(r.invoiceNo, r.code, r.color, r.qty, r.monthLabel, r.serialNo);
    return !seenIdentities.has(key);
  });

  const candidateCount = orphans.length;
  const candidateAmount = orphans.reduce((s, r) => s + Number(r.amount), 0);
  const blastRadiusPct = currentInScope > 0 ? (candidateCount / currentInScope) * 100 : 0;

  const sampleRows = orphans.slice(0, 20).map((r) => ({
    lineUid: r.lineUid,
    invoiceNo: r.invoiceNo,
    code: r.code,
    color: r.color,
    qty: r.qty != null ? String(r.qty) : null,
    amount: String(r.amount),
    ingestedAt: r.ingestedAt instanceof Date ? r.ingestedAt.toISOString() : (r.ingestedAt ?? null),
  }));

  // Guard 3: blast-radius — always report candidates, only block application
  if (blastRadiusPct > blastRadiusLimitPct) {
    logger.warn(
      { fy, month, candidateCount, currentInScope, blastRadiusPct, limitPct: blastRadiusLimitPct, syncRunId },
      "tombstone: blast-radius limit exceeded — halted",
    );
    return {
      fy, month, currentInScope, currentAmountInScope,
      candidateCount, candidateAmount,
      blastRadiusPct, limitPct: blastRadiusLimitPct,
      halted: true,
      haltReason: `blast-radius ${blastRadiusPct.toFixed(1)}% exceeds limit ${blastRadiusLimitPct}%`,
      dryRun, applied: 0, sampleRows,
    };
  }

  // Guard 4: dry run — return full report without writing anything
  if (dryRun || candidateCount === 0) {
    return {
      fy, month, currentInScope, currentAmountInScope,
      candidateCount, candidateAmount,
      blastRadiusPct, limitPct: blastRadiusLimitPct,
      halted: false, dryRun, applied: 0, sampleRows,
    };
  }

  // Guard 5: apply and log each tombstone with syncRunId
  const now = new Date();
  const tombstoneUids = orphans.map((r) => r.lineUid);
  for (let i = 0; i < tombstoneUids.length; i += BATCH_SIZE) {
    const batch = tombstoneUids.slice(i, i + BATCH_SIZE);
    await db
      .update(saleLines)
      .set({ versionStatus: "superseded", supersededAt: now, supersededBy: `tombstone|${syncRunId}` })
      .where(and(inArray(saleLines.lineUid, batch), eq(saleLines.versionStatus, "current")));
  }

  logger.warn(
    { fy, month, applied: tombstoneUids.length, blastRadiusPct, syncRunId },
    "tombstone: orphan rows superseded",
  );

  return {
    fy, month, currentInScope, currentAmountInScope,
    candidateCount, candidateAmount,
    blastRadiusPct, limitPct: blastRadiusLimitPct,
    halted: false, dryRun: false, applied: tombstoneUids.length, sampleRows,
  };
}

/**
 * Idempotent versioned sync for the open FY.
 *
 * Groups incoming sheet rows by identity key (invoice_no, code, color, qty,
 * month_label). Compares each identity against the current row in the DB:
 *   - No existing row → insert as current
 *   - Existing row, same (amount, saleRate, serialNo) → touch sheet_confirmed_at
 *   - Existing row, different values → mark old as superseded, insert new current
 *
 * Call ONLY for the open FY where invoice_no is always populated.
 * For historical FYs (xlsx backfill) continue using insertSaleLineBatches.
 */
export async function versionedSyncLines(
  lines: InsertSaleLine[],
  confirmedAt: Date,
): Promise<VersionedSyncResult> {
  if (lines.length === 0) return { touched: 0, superseded: 0, inserted: 0, revived: 0, tombstoned: 0 };

  const deduped = dedupeBySerialNo(lines);

  const fys = [...new Set(deduped.map((l) => l.fy).filter((f): f is string => f != null))];

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

  const allCurrent: DbRow[] = [];
  for (const fy of fys) {
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
      .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current")));
    allCurrent.push(...(rows as DbRow[]));
  }

  // Map holds ALL current DB rows per identity key (not just the last-seen).
  // A single-entry Map caused a silent bug: when 2+ current rows shared an
  // identity key (pre-existing duplicates), the first-loaded row was overwritten
  // and became invisible to both the supersession check and the orphan tombstone,
  // so it persisted as current indefinitely.
  const currentMap = new Map<string, DbRow[]>();
  for (const row of allCurrent) {
    const key = identityKey(row.invoiceNo, row.code, row.color, row.qty, row.monthLabel, row.serialNo);
    const bucket = currentMap.get(key) ?? [];
    bucket.push(row);
    currentMap.set(key, bucket);
  }

  const rowMatches = (line: InsertSaleLine, e: DbRow): boolean => {
    const amtMatch = Math.abs(Number(line.amount) - Number(e.amount)) < 0.01;
    const rateMatch =
      line.saleRate == null && e.saleRate == null
        ? true
        : line.saleRate != null && e.saleRate != null
          ? Math.abs(Number(line.saleRate) - Number(e.saleRate)) < 0.01
          : false;
    const serialMatch = (line.serialNo ?? null) === (e.serialNo ?? null);
    return amtMatch && rateMatch && serialMatch;
  };

  const toTouch: string[] = [];
  const toSupersede: Array<{ lineUid: string; supersededBy: string; supersededAt: Date }> = [];
  const toInsert: InsertSaleLine[] = [];

  for (const line of deduped) {
    const key = identityKey(
      line.invoiceNo ?? null,
      line.code,
      line.color ?? null,
      line.qty ?? null,
      line.monthLabel ?? null,
      line.serialNo ?? null,
    );
    const existingAll = currentMap.get(key) ?? [];

    if (existingAll.length === 0) {
      toInsert.push(line);
      continue;
    }

    // Find the current row that matches the incoming line exactly.
    const exactMatch = existingAll.find((e) => rowMatches(line, e));

    if (exactMatch) {
      // Incoming line matches an existing current row → touch it.
      toTouch.push(exactMatch.lineUid);
      // Supersede any OTHER current rows for this identity — they are stale
      // duplicates that accumulated from previous sync runs.
      for (const e of existingAll) {
        if (e.lineUid !== exactMatch.lineUid) {
          toSupersede.push({
            lineUid: e.lineUid,
            supersededBy: exactMatch.lineUid,
            supersededAt: confirmedAt,
          });
        }
      }
    } else {
      // Incoming line is a new version (amount/rate changed) → supersede ALL
      // current rows for this identity and insert the new version.
      for (const e of existingAll) {
        toSupersede.push({
          lineUid: e.lineUid,
          supersededBy: line.lineUid,
          supersededAt: confirmedAt,
        });
      }
      toInsert.push(line);
    }
  }

  for (let i = 0; i < toSupersede.length; i += BATCH_SIZE) {
    const batch = toSupersede.slice(i, i + BATCH_SIZE);
    await db.transaction(async (tx) => {
      for (const { lineUid, supersededBy, supersededAt } of batch) {
        await tx
          .update(saleLines)
          .set({ versionStatus: "superseded", supersededAt, supersededBy })
          .where(eq(saleLines.lineUid, lineUid));
      }
    });
  }

  // ── Insert / revive pass ──────────────────────────────────────────────────
  // A row in toInsert whose line_uid already exists as 'superseded' cannot be
  // re-inserted (ON CONFLICT DO NOTHING silently skips it). Instead, detect
  // those superseded rows up-front and UPDATE them back to 'current'. Only
  // rows with a genuinely new line_uid go to INSERT.
  //
  // Revive guard (symmetric with Guard 2.5 in tombstoneOrphans):
  // A month where incomingRows < currentDbRows is a suspected short read.
  // In that scenario the tombstone pass is also halted (Guard 2.5), so we must
  // NOT revive rows for that month either — doing so would silently inflate the
  // current-row count for months whose sheet read was incomplete.
  const currentCountByMonth = new Map<string, number>();
  for (const row of allCurrent) {
    if (row.monthLabel == null) continue;
    currentCountByMonth.set(row.monthLabel, (currentCountByMonth.get(row.monthLabel) ?? 0) + 1);
  }
  const incomingCountByMonth = new Map<string, number>();
  for (const line of deduped) {
    if (line.monthLabel == null) continue;
    incomingCountByMonth.set(line.monthLabel, (incomingCountByMonth.get(line.monthLabel) ?? 0) + 1);
  }
  // A month is "safe to revive" when the incoming count is at least as large
  // as the current DB count (no evidence of a short read).
  const safeToReviveMonths = new Set<string>();
  for (const [month, incoming] of incomingCountByMonth) {
    const current = currentCountByMonth.get(month) ?? 0;
    if (incoming >= current) safeToReviveMonths.add(month);
  }

  let inserted = 0;
  let revived = 0;
  const revivedUids: string[] = [];
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const batchUids = batch.map((l) => l.lineUid);

    // Pre-flight: which line_uids already exist in any version?
    const existing = await db
      .select({ lineUid: saleLines.lineUid, versionStatus: saleLines.versionStatus })
      .from(saleLines)
      .where(inArray(saleLines.lineUid, batchUids));

    const existingUidSet = new Set(existing.map((r) => r.lineUid));
    const supersededUids = existing
      .filter((r) => r.versionStatus === "superseded")
      .map((r) => r.lineUid);
    const trulyNew = batch.filter((l) => !existingUidSet.has(l.lineUid));

    // Revive: update superseded rows back to current — only for safe months.
    // Build a line_uid → monthLabel map from the batch so we can filter by month.
    const uidToMonth = new Map(batch.map((l) => [l.lineUid, l.monthLabel ?? ""]));
    const safeSupersededUids = supersededUids.filter((uid) =>
      safeToReviveMonths.has(uidToMonth.get(uid) ?? ""),
    );
    if (safeSupersededUids.length > 0) {
      for (let j = 0; j < safeSupersededUids.length; j += BATCH_SIZE) {
        const uidBatch = safeSupersededUids.slice(j, j + BATCH_SIZE);
        await db
          .update(saleLines)
          .set({ versionStatus: "current", supersededAt: null, supersededBy: null })
          .where(
            and(inArray(saleLines.lineUid, uidBatch), eq(saleLines.versionStatus, "superseded")),
          );
      }
      revived += safeSupersededUids.length;
      revivedUids.push(...safeSupersededUids);
    }

    // Insert genuinely new rows.
    if (trulyNew.length > 0) {
      const rows = await db
        .insert(saleLines)
        .values(trulyNew)
        .onConflictDoNothing()
        .returning({ lineUid: saleLines.lineUid });
      inserted += rows.length;
    }
  }

  const confirmedUids = [...toTouch, ...revivedUids, ...toInsert.map((l) => l.lineUid)];
  if (confirmedUids.length > 0) {
    await markSheetConfirmed(confirmedUids, confirmedAt);
  }

  // Tombstone pass: supersede any current DB row whose identity was not seen
  // in this sync batch (deleted/corrected out of the sheet).
  // Guard 3 (10% blast-radius) automatically skips large one-off backlogs —
  // those must be handled via POST /registers/:fy/tombstone-orphans.
  let tombstoned = 0;
  const syncRunId = confirmedAt.toISOString();
  const fyForTombstone = fys[0] ?? "";
  const monthsInBatch = [
    ...new Set(deduped.map((l) => l.monthLabel).filter((m): m is string => m != null)),
  ];
  for (const month of monthsInBatch) {
    const monthLines = deduped.filter((l) => l.monthLabel === month);
    const seenForMonth = new Set(
      monthLines.map((l) =>
        identityKey(l.invoiceNo ?? null, l.code, l.color ?? null, l.qty ?? null, l.monthLabel ?? null, l.serialNo ?? null),
      ),
    );
    const tr = await tombstoneOrphans({
      fy: fyForTombstone,
      month,
      seenIdentities: seenForMonth,
      incomingRowCount: monthLines.length,
      syncRunId,
      dryRun: false,
      blastRadiusLimitPct: 10,
    });
    if (!tr.halted) tombstoned += tr.applied;
  }

  return { touched: toTouch.length, superseded: toSupersede.length, inserted, revived, tombstoned };
}

export async function upsertItemMaster(
  items: Array<{
    code: string;
    itemName: string | null;
    itemGroup: string | null;
    unit: string | null;
    mrp: number | null;
  }>,
): Promise<{ upserted: number }> {
  // Last occurrence wins within the file.
  const byCode = new Map<string, (typeof items)[number]>();
  for (const item of items) byCode.set(item.code, item);
  const rows = [...byCode.values()].map((i) => ({
    code: i.code,
    itemName: i.itemName,
    itemGroup: i.itemGroup,
    unit: i.unit,
    mrp: i.mrp == null ? null : String(i.mrp),
  }));
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(itemMaster)
      .values(batch)
      .onConflictDoUpdate({
        target: itemMaster.code,
        set: {
          itemName: sql`excluded.item_name`,
          itemGroup: sql`excluded.item_group`,
          unit: sql`excluded.unit`,
          mrp: sql`excluded.mrp`,
        },
      });
    upserted += batch.length;
  }
  return { upserted };
}
