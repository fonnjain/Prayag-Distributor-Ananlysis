// monthlyReplace.ts — full-replace sync for the open month(s) of the open FY.
//
// DESIGN (Aug 2026, replaces versionedSyncLines/tombstoneOrphans in the sync path)
//
// The register sheet has no stable row identifier: column-A serials renumber on
// every re-sort, and ~0.3% of rows are genuinely indistinguishable on every
// field. Any identity-key or positional scheme is therefore hostage to sort
// order — twice (30 Jul, 1 Aug 2026) that churn doubled July in production.
//
// So there is no identity key at all. Each sync:
//   1. Reads every row for each non-frozen month.
//   2. GUARD: if the read holds materially fewer rows than the last successful
//      read of that month (stored in register_month_state IN THE DATABASE, so
//      it survives restarts), abort and leave the month untouched.
//   3. In ONE transaction: delete the month, insert the read in full.
//      If the sheet holds two identical rows, both are written.
//      Acceptance: rows written equals rows read, exactly.
//
// FREEZE RULE: a month freezes permanently on the 7th of the following month
// (seven days of grace for late entries). Derived from the clock, never a
// config list. A frozen month is skipped entirely — no read, no write. Its row
// count and amount total are recorded once at freeze time and asserted on
// startup via assertMonthAnchors().

import { and, eq, sql as dsql } from "drizzle-orm";
import { db, saleLines, registerMonthState, type InsertSaleLine } from "@workspace/db";
import { allowDelete } from "../deleteGuard.js";
import { logger } from "../logger.js";

const BATCH_SIZE = 1000;

// A read is "materially fewer" when it is below 98% of the last good read.
// Legitimate small deletions (corrections) pass; a truncated tab read does not.
// A genuine shrink beyond 2% requires the manual force route to accept the
// lower count — an explicit human decision, never silent.
export const SHORT_READ_TOLERANCE = 0.98;

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** UTC instant at which a month label like "Jul-26" freezes: 7th of the
 *  following month. Null for unparseable labels (they never freeze). */
export function monthFreezeAt(monthLabel: string): Date | null {
  const m = /^([A-Z][a-z]{2})-(\d{2})$/.exec(monthLabel);
  if (!m) return null;
  const mon = MONTH_INDEX[m[1]];
  if (mon === undefined) return null;
  const year = 2000 + parseInt(m[2], 10);
  // 7th of the following month, midnight UTC.
  return new Date(Date.UTC(mon === 11 ? year + 1 : year, (mon + 1) % 12, 7));
}

export function isMonthFrozen(monthLabel: string, now: Date = new Date()): boolean {
  const freezeAt = monthFreezeAt(monthLabel);
  return freezeAt != null && now.getTime() >= freezeAt.getTime();
}

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Every month label of the FY whose calendar month has STARTED as of `now`
 * and which is not yet frozen. This is the rule-based sync scope: between the
 * 1st and 6th of a month it contains BOTH the prior month (still in its edit
 * window) and the current month (even if its tab is empty); from the 7th only
 * the current month. Future months are excluded.
 * FY format "2026-27" → Apr-26 … Mar-27.
 */
export function openMonthLabels(fy: string, now: Date = new Date()): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m) return [];
  const startYear = parseInt(m[1], 10);
  const labels: string[] = [];
  for (let i = 0; i < 12; i++) {
    const mon = (3 + i) % 12; // Apr=3 … Mar=2
    const year = startYear + (mon < 3 ? 1 : 0);
    const monthStart = Date.UTC(year, mon, 1);
    if (now.getTime() < monthStart) continue; // month not started yet
    const label = `${MONTH_ABBR[mon]}-${String(year % 100).padStart(2, "0")}`;
    if (!isMonthFrozen(label, now)) labels.push(label);
  }
  return labels;
}

export interface MonthReplaceResult {
  month: string;
  action: "replaced" | "frozen-skipped" | "frozen-anchored" | "aborted-short-read" | "failed";
  sheetRows: number;
  sheetAmount: number;
  dbRowsBefore: number | null;
  rowsWritten: number | null;
  lastGoodRows: number | null;
  detail?: string;
}

export interface ReplaceSummary {
  fy: string;
  months: MonthReplaceResult[];
  /** Rows excluded because month_label could not be derived. Always logged loudly. */
  unlabelledRows: number;
}

interface MonthState {
  lastGoodRows: number | null;
  frozenAt: Date | null;
  frozenRows: number | null;
  frozenAmount: string | null;
}

async function loadState(fy: string): Promise<Map<string, MonthState>> {
  const rows = await db.select().from(registerMonthState).where(eq(registerMonthState.fy, fy));
  const map = new Map<string, MonthState>();
  for (const r of rows) {
    map.set(r.monthLabel, {
      lastGoodRows: r.lastGoodRows,
      frozenAt: r.frozenAt,
      frozenRows: r.frozenRows,
      frozenAmount: r.frozenAmount,
    });
  }
  return map;
}

async function dbMonthCounts(fy: string, month: string): Promise<{ rows: number; amount: number }> {
  const res = await db
    .select({
      rows: dsql<number>`count(*)::int`,
      amount: dsql<string>`coalesce(sum(${saleLines.amount}::numeric), 0)::text`,
    })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, month)));
  return { rows: res[0]?.rows ?? 0, amount: parseFloat(res[0]?.amount ?? "0") };
}

/** Refuse writes to a frozen month. Throws with a clear message. Used by any
 *  manual route that mutates a specific (fy, month). */
export function assertMonthWritable(fy: string, monthLabel: string, now: Date = new Date()): void {
  if (isMonthFrozen(monthLabel, now)) {
    throw new Error(
      `month ${monthLabel} (${fy}) froze on ${monthFreezeAt(monthLabel)?.toISOString().slice(0, 10)} — writes are permanently refused`,
    );
  }
}

/**
 * Replace each non-frozen month of the FY with the rows just read from the
 * sheet. Frozen months are skipped (and anchored on first encounter after
 * their freeze date). `now` is injectable for tests ("simulate 8 September").
 *
 * `force` (manual route only): accept a read below the short-read tolerance
 * and reset the baseline to it.
 */
export async function replaceOpenMonths(opts: {
  fy: string;
  lines: InsertSaleLine[];
  now?: Date;
  force?: boolean;
}): Promise<ReplaceSummary> {
  const { fy, lines, force = false } = opts;
  const now = opts.now ?? new Date();

  // Group the read by month label.
  const byMonth = new Map<string, InsertSaleLine[]>();
  let unlabelledRows = 0;
  for (const line of lines) {
    if (!line.monthLabel) {
      unlabelledRows++;
      continue;
    }
    const arr = byMonth.get(line.monthLabel);
    if (arr) arr.push(line);
    else byMonth.set(line.monthLabel, [line]);
  }
  if (unlabelledRows > 0) {
    logger.error({ fy, unlabelledRows }, "monthly replace: rows without month_label EXCLUDED — investigate the sheet read");
  }

  // RULE-BASED SCOPE: attempt every unfrozen, already-started month of the FY
  // even when the sheet read holds zero rows for it. An empty tab (e.g. "Aug"
  // on 1 Aug) must still be attempted so that (a) the attempt is visible in
  // the log rather than inferred, and (b) a baseline of 0 is recorded — the
  // short-read guard then rises naturally with the first real invoices.
  for (const label of openMonthLabels(fy, now)) {
    if (!byMonth.has(label)) byMonth.set(label, []);
  }

  const months: MonthReplaceResult[] = [];

  for (const [month, monthLines] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    months.push(await processOneMonth(fy, month, monthLines, now, force));
  }

  logger.info(
    {
      fy,
      attempted: months.map((r) => `${r.month}:${r.action}(${r.sheetRows} rows)`),
    },
    "monthly replace: month scope attempted (rule-based, no-ops included)",
  );

  return { fy, months, unlabelledRows };
}

/**
 * Process one month ATOMICALLY: a single transaction, serialized by a
 * transaction-scoped advisory lock on (fy, month), covers the baseline read,
 * the short-read guard, the delete+insert, and the state upsert. Two
 * concurrent callers (scheduler tick + manual route) cannot interleave: the
 * second waits on the lock, then re-reads the baseline the first just wrote.
 */
async function processOneMonth(
  fy: string,
  month: string,
  monthLines: InsertSaleLine[],
  now: Date,
  force: boolean,
): Promise<MonthReplaceResult> {
  const sheetRows = monthLines.length;
  const sheetAmount = monthLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const frozen = isMonthFrozen(month, now);

  try {
    return await allowDelete(async (tx) => {
      // Serialize all writers of this (fy, month). Transaction-scoped: the
      // lock releases automatically on COMMIT/ROLLBACK.
      await tx.execute(dsql`SELECT pg_advisory_xact_lock(hashtext(${`register-month|${fy}|${month}`}))`);

      // Baseline and freeze state read INSIDE the lock, so a concurrent
      // replace that just committed is fully visible here.
      const stRows = await tx.select().from(registerMonthState)
        .where(and(eq(registerMonthState.fy, fy), eq(registerMonthState.monthLabel, month)));
      const st = stRows[0] ?? null;

      // ── Frozen month, already anchored: skip entirely ────────────────────
      if (frozen && st?.frozenAt != null) {
        if (st.frozenRows != null && st.frozenRows !== sheetRows) {
          logger.warn(
            { fy, month, frozenRows: st.frozenRows, sheetRows },
            "monthly replace: sheet edited after freeze — ignored (month is permanent)",
          );
        }
        return {
          month, action: "frozen-skipped" as const, sheetRows, sheetAmount,
          dbRowsBefore: null, rowsWritten: null, lastGoodRows: st.lastGoodRows,
        };
      }

      // ── Short-read guard (applies to open months AND the final freeze-
      //    transition replace — a truncated read must never become an anchor).
      const lastGood = st?.lastGoodRows ?? null;
      // Fires when a month with a POSITIVE baseline reads materially fewer
      // rows. The explicit `sheetRows === 0` branch closes a rounding gap:
      // for tiny baselines (e.g. 1 row) floor(1 × 0.98) = 0 and an empty read
      // would otherwise slip past the `<` comparison and delete real data.
      // A 0 baseline never trips the guard — empty months stay normal no-ops.
      if (
        !force &&
        lastGood != null &&
        lastGood > 0 &&
        (sheetRows === 0 || sheetRows < Math.floor(lastGood * SHORT_READ_TOLERANCE))
      ) {
        logger.error(
          { fy, month, sheetRows, lastGood, frozen },
          "monthly replace: read materially below last good read — ABORTED, month left untouched",
        );
        return {
          month, action: "aborted-short-read" as const, sheetRows, sheetAmount,
          dbRowsBefore: null, rowsWritten: null, lastGoodRows: lastGood,
          detail: `read ${sheetRows} < ${Math.floor(lastGood * SHORT_READ_TOLERANCE)} (98% of last good ${lastGood})`,
        };
      }

      // ── Replace: delete + insert the month, verified, in THIS transaction.
      const beforeRes = await tx
        .select({ rows: dsql<number>`count(*)::int` })
        .from(saleLines)
        .where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, month)));
      const dbRowsBefore = beforeRes[0]?.rows ?? 0;

      await tx.delete(saleLines).where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, month)));
      let written = 0;
      for (let i = 0; i < monthLines.length; i += BATCH_SIZE) {
        const batch = monthLines.slice(i, i + BATCH_SIZE).map((l) => ({
          ...l,
          versionStatus: "current",
          supersededAt: null,
          supersededBy: null,
          sheetConfirmedAt: now,
        }));
        const inserted = await tx.insert(saleLines).values(batch).returning({ uid: saleLines.lineUid });
        written += inserted.length;
      }
      if (written !== sheetRows) {
        // Fail loudly: rolls back the delete, the insert, and the state write.
        throw new Error(`rows written (${written}) != rows read (${sheetRows}) — rolled back`);
      }
      // Empty month, empty DB: a normal no-op (e.g. the current month's tab
      // before its first invoices). Logged with a distinct detail so the
      // nightly log shows the attempt explicitly.
      const noOp = sheetRows === 0 && dbRowsBefore === 0;

      // ── State upsert in the SAME transaction as the data it describes ────
      // Freeze transition: the month passed its freeze date without an anchor
      // — this verified replace becomes its final content and the anchor is
      // recorded atomically with it (never from an unverified DB snapshot).
      const patch = {
        lastGoodRows: sheetRows,
        lastGoodAmount: String(sheetAmount),
        lastReplacedAt: now,
        ...(frozen ? { frozenAt: now, frozenRows: written, frozenAmount: String(sheetAmount) } : {}),
      };
      await tx
        .insert(registerMonthState)
        .values({ fy, monthLabel: month, ...patch })
        .onConflictDoUpdate({
          target: [registerMonthState.fy, registerMonthState.monthLabel],
          set: patch,
        });

      logger.info(
        { fy, month, dbRowsBefore, rowsWritten: written, amountCr: (sheetAmount / 1e7).toFixed(2), frozen, noOp },
        frozen
          ? "monthly replace: final verified replace + freeze anchor recorded"
          : noOp
            ? "monthly replace: empty month no-op (baseline 0 recorded)"
            : "monthly replace: month replaced",
      );
      return {
        month,
        action: (frozen ? "frozen-anchored" : "replaced") as MonthReplaceResult["action"],
        sheetRows, sheetAmount, dbRowsBefore, rowsWritten: written, lastGoodRows: sheetRows,
        ...(noOp ? { detail: "no-op (empty month)" } : {}),
      };
    });
  } catch (err) {
    logger.error({ fy, month, err }, "monthly replace: FAILED — transaction rolled back, month unchanged");
    return {
      month, action: "failed", sheetRows, sheetAmount,
      dbRowsBefore: null, rowsWritten: null, lastGoodRows: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface MonthAnchorViolation {
  fy: string;
  month: string;
  anchorRows: number;
  anchorAmount: number;
  dbRows: number;
  dbAmount: number;
}

let monthAnchorViolations: MonthAnchorViolation[] = [];
let monthAnchorsCheckedAt: string | null = null;

export function getMonthAnchorViolations(): { violations: MonthAnchorViolation[]; checkedAt: string | null } {
  return { violations: monthAnchorViolations, checkedAt: monthAnchorsCheckedAt };
}

/** Startup assertion: every frozen month's DB rows/amount must equal its anchor. */
export async function assertMonthAnchors(fy: string): Promise<void> {
  const state = await loadState(fy);
  const violations: MonthAnchorViolation[] = [];
  for (const [month, st] of state) {
    if (st.frozenAt == null || st.frozenRows == null) continue;
    const dbNow = await dbMonthCounts(fy, month);
    const anchorAmount = st.frozenAmount != null ? parseFloat(st.frozenAmount) : 0;
    if (dbNow.rows !== st.frozenRows || Math.abs(dbNow.amount - anchorAmount) > 1) {
      violations.push({
        fy, month, anchorRows: st.frozenRows, anchorAmount,
        dbRows: dbNow.rows, dbAmount: dbNow.amount,
      });
      logger.error(
        { fy, month, anchorRows: st.frozenRows, dbRows: dbNow.rows, anchorAmount: Math.round(anchorAmount), dbAmount: Math.round(dbNow.amount) },
        "FROZEN MONTH ANCHOR VIOLATION — data changed after freeze",
      );
    }
  }
  monthAnchorViolations = violations;
  monthAnchorsCheckedAt = new Date().toISOString();
  if (violations.length === 0) {
    logger.info({ fy, frozenMonths: [...state.entries()].filter(([, s]) => s.frozenAt != null).length }, "frozen month anchors verified");
  }
}
