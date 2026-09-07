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
// FREEZE RULE: a month freezes permanently at 00:00 UTC on the 8th of the
// following month, derived from the load date and shared across register sources.
// (seven days of grace for late entries). Derived from the clock, never a
// config list. A frozen month is skipped entirely — no read, no write. Its row
// count and amount total are recorded once at freeze time and asserted on
// startup via assertMonthAnchors().

import { and, eq, sql as dsql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, saleLines, secondarySkuLines, registerMonthState, registerMonthlyIngestLedger, type InsertSaleLine } from "@workspace/db";
import { allowDelete } from "../deleteGuard.js";
import { logger } from "../logger.js";

const BATCH_SIZE = 1000;

// A read is "materially fewer" when it is below 98% of the last good read.
// Legitimate small deletions (corrections) pass; a truncated tab read does not.
// A genuine shrink beyond 2% requires the manual force route to accept the
// lower count — an explicit human decision, never silent.
export const SHORT_READ_TOLERANCE = 0.98;

export function classifyMonthlyReadGuard(args: {
  force: boolean;
  frozen: boolean;
  lastGood: number | null;
  sheetRows: number;
}): "rejected-shrink" | "aborted-short-read" | null {
  const { force, frozen, lastGood, sheetRows } = args;
  if (!force && frozen && lastGood != null && sheetRows < lastGood) {
    return "rejected-shrink";
  }
  if (
    !force &&
    lastGood != null &&
    lastGood > 0 &&
    (sheetRows === 0 || sheetRows < Math.floor(lastGood * SHORT_READ_TOLERANCE))
  ) {
    return "aborted-short-read";
  }
  return null;
}

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** UTC instant at which a month label like "Jul-26" freezes: START OF THE 7TH
 *  of the following month. This is the single freeze clock shared by all
 *  register loaders.
 *  Null for unparseable labels (they never freeze). */
export function monthFreezeAt(monthLabel: string): Date | null {
  const m = /^([A-Z][a-z]{2})-(\d{2})$/.exec(monthLabel);
  if (!m) return null;
  const mon = MONTH_INDEX[m[1]];
  if (mon === undefined) return null;
  const year = 2000 + parseInt(m[2], 10);
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
  action: "replaced" | "frozen-skipped" | "frozen-anchored" | "aborted-short-read" | "rejected-shrink" | "failed";
  sheetRows: number;
  sheetAmount: number;
  dbRowsBefore: number | null;
  rowsWritten: number | null;
  projectedRowsWritten?: number | null;
  lastGoodRows: number | null;
  detail?: string;
  ledgerPreview?: RegisterMonthlyLedgerRecord;
}

export interface ReplaceSummary {
  fy: string;
  months: MonthReplaceResult[];
  /** Rows excluded because month_label could not be derived. Always logged loudly. */
  unlabelledRows: number;
}

// Only replacement-controlled values participate in evidence. Identity,
// timestamps, version metadata, and post-ingest channel enrichment are excluded.
// Decimal and date text are canonicalized before hashing.
const EVIDENCE_FIELDS = ["fy", "serialNo", "invoiceNo", "invoiceDate", "monthLabel", "customer", "code", "color", "qty", "qtyLtr", "saleRate", "amount", "groupRaw", "groupCanon", "station", "stateRaw", "stateCanon", "headRaw", "headCanon", "isTerritory", "typeRaw", "source"] as const;
function canonicalValue(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const raw = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const negative = raw.startsWith("-");
    const [wholeRaw, fractionRaw = ""] = raw.replace(/^[+-]/, "").split(".");
    const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
    const fraction = fractionRaw.replace(/0+$/, "");
    const normalized = fraction ? `${whole}.${fraction}` : whole;
    return negative && normalized !== "0" ? `-${normalized}` : normalized;
  }
  // PostgreSQL date values and sheet ISO dates compare as the date, not a
  // timezone-dependent instant.
  if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(raw)) return raw.slice(0, 10);
  return raw;
}
function evidenceRow(line: Record<string, unknown>): Record<string, string | null> {
  return Object.fromEntries(EVIDENCE_FIELDS.map((field) => [field, canonicalValue(line[field])]));
}
export function canonicalRegisterEvidenceRow(line: Record<string, unknown>): Record<string, string | null> {
  return evidenceRow(line);
}
/** Stable, order-insensitive multiset fingerprint of source-controlled fields. */
export function canonicalRegisterFingerprint(rows: any[]): string {
  const encoded = rows.map(evidenceRow).map((r) => JSON.stringify(r)).sort();
  return createHash("sha256").update(encoded.join("\n")).digest("hex");
}
function decimalParts(value: string): { n: bigint; scale: number } {
  const [whole, fraction = ""] = value.replace(/^\+/, "").split(".");
  const negative = whole.startsWith("-");
  const digits = `${negative ? whole.slice(1) : whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return { n: (negative ? -1n : 1n) * BigInt(digits), scale: fraction.length };
}
function decimalSum(values: string[]): string {
  const parts = values.map(decimalParts); const scale = Math.max(0, ...parts.map((p) => p.scale));
  const total = parts.reduce((sum, p) => sum + p.n * (10n ** BigInt(scale - p.scale)), 0n);
  const negative = total < 0n; const raw = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const out = scale ? `${raw.slice(0, -scale)}.${raw.slice(-scale)}`.replace(/\.?0+$/, "") : raw;
  return negative && out !== "0" ? `-${out}` : out;
}
function decimalSubtract(left: string, right: string): string {
  return decimalSum([left, `-${right}`]);
}
function amountOf(rows: any[]): string {
  return decimalSum(rows.map((r) => canonicalValue(r.amount) ?? "0"));
}
function snapshot(rows: any[]) {
  return { rows: rows.length, amount: amountOf(rows), fingerprint: canonicalRegisterFingerprint(rows) };
}
function multisetDiff(before: any[], sourceRows: any[]) {
  const count = (rows: any[]) => rows.reduce((m, row) => {
    const key = JSON.stringify(evidenceRow(row)); m.set(key, (m.get(key) ?? 0) + 1); return m;
  }, new Map<string, number>());
  const left = count(before), right = count(sourceRows);
  const removed: unknown[] = [], added: unknown[] = [];
  for (const [key, n] of left) for (let i = 0; i < n - (right.get(key) ?? 0); i++) removed.push(JSON.parse(key));
  for (const [key, n] of right) for (let i = 0; i < n - (left.get(key) ?? 0); i++) added.push(JSON.parse(key));
  return { added, removed };
}
function deltas(before: ReturnType<typeof snapshot>, source: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) {
  const sourceRows = source.rows - before.rows, actualRows = after.rows - before.rows;
  const sourceAmount = decimalSubtract(source.amount, before.amount), actualAmount = decimalSubtract(after.amount, before.amount);
  return { source: { rows: sourceRows, amount: sourceAmount }, actual: { rows: actualRows, amount: actualAmount },
    sourceShrink: sourceRows < 0 || sourceAmount.startsWith("-"), actualShrink: actualRows < 0 || actualAmount.startsWith("-") };
}
function changedHeuristic(before: any[], sourceRows: any[]) {
  const diff = multisetDiff(before, sourceRows);
  const bucket = (row: any) => JSON.stringify([
    row.fy ?? null,
    row.monthLabel ?? null,
    row.invoiceNo ?? null,
    row.code ?? null,
    row.color ?? null,
  ]);
  const bucketCounts = (rows: any[]) => rows.reduce((counts, row) => {
    const key = bucket(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const removedBuckets = bucketCounts(diff.removed);
  const addedBuckets = bucketCounts(diff.added);
  let changedRows = 0;
  for (const [key, count] of removedBuckets) {
    if (count === 1 && addedBuckets.get(key) === 1) changedRows++;
  }
  return {
    addedRows: diff.added.length,
    removedRows: diff.removed.length,
    changedRows,
    confidence: "heuristic",
    unpairedResidualRows: diff.added.length + diff.removed.length - (changedRows * 2),
  };
}

export type RegisterMonthlyLedgerRecord = typeof registerMonthlyIngestLedger.$inferInsert;

function buildLedgerRecord(args: {
  runId: string;
  actor: "scheduler" | "manual";
  operator: string | null;
  source: string;
  fy: string;
  month: string;
  attemptedAt: Date;
  outcome: MonthReplaceResult["action"];
  writeAtomicity: "same-replacement-transaction" | "ledger-only-transaction" | "post-rollback";
  rowsWritten: number | null;
  projectedRowsWritten: number | null;
  beforeLines: any[];
  sourceLines: any[];
  afterAudit: ReturnType<typeof snapshot>;
  spreadsheet: { id?: string; monthSources?: Record<string, Array<{ tab: string; contentHash: string }>>; fallbackSources?: Array<{ tab: string; contentHash: string }> };
  detail?: string;
}): RegisterMonthlyLedgerRecord {
  const beforeAudit = snapshot(args.beforeLines);
  const sourceAudit = snapshot(args.sourceLines);
  const change = deltas(beforeAudit, sourceAudit, args.afterAudit);
  return {
    runId: args.runId,
    actor: args.actor,
    operator: args.operator,
    source: args.source,
    fy: args.fy,
    monthLabel: args.month,
    attemptedAt: args.attemptedAt,
    completedAt: new Date(),
    outcome: args.outcome,
    writeAtomicity: args.writeAtomicity,
    rowsWritten: args.rowsWritten,
    projectedRowsWritten: args.projectedRowsWritten,
    beforeRows: beforeAudit.rows,
    beforeAmount: beforeAudit.amount,
    beforeFingerprint: beforeAudit.fingerprint,
    sourceRows: sourceAudit.rows,
    sourceAmount: sourceAudit.amount,
    sourceFingerprint: sourceAudit.fingerprint,
    afterRows: args.afterAudit.rows,
    afterAmount: args.afterAudit.amount,
    afterFingerprint: args.afterAudit.fingerprint,
    sourceRowDelta: change.source.rows,
    sourceAmountDelta: change.source.amount,
    sourceShrink: change.sourceShrink,
    actualRowDelta: change.actual.rows,
    actualAmountDelta: change.actual.amount,
    actualShrink: change.actualShrink,
    ...changedHeuristic(args.beforeLines, args.sourceLines),
    spreadsheetId: args.spreadsheet.id ?? null,
    sourceEvidence: {
      month: args.month,
      sources: args.spreadsheet.monthSources?.[args.month] ?? args.spreadsheet.fallbackSources ?? [],
    },
    detail: args.detail,
  };
}

export function buildRegisterMonthlyLedgerPreview(args: {
  beforeLines: any[];
  sourceLines: any[];
  fy: string;
  month: string;
  attemptedAt: Date;
  runId?: string;
  actor?: "scheduler" | "manual";
  operator?: string | null;
  source?: string;
  spreadsheet?: { id?: string; monthSources?: Record<string, Array<{ tab: string; contentHash: string }>>; fallbackSources?: Array<{ tab: string; contentHash: string }> };
}): RegisterMonthlyLedgerRecord {
  return buildLedgerRecord({
    runId: args.runId ?? `register-${args.attemptedAt.toISOString()}`,
    actor: args.actor ?? "scheduler",
    operator: args.operator ?? null,
    source: args.source ?? "register_sheets_sync",
    fy: args.fy,
    month: args.month,
    attemptedAt: args.attemptedAt,
    outcome: "replaced",
    writeAtomicity: "same-replacement-transaction",
    rowsWritten: null,
    projectedRowsWritten: args.sourceLines.length,
    beforeLines: args.beforeLines,
    sourceLines: args.sourceLines,
    afterAudit: snapshot(args.sourceLines),
    spreadsheet: args.spreadsheet ?? {},
    detail: "dry-run preview; no rows, state, ledger, secondary data, or channel data written",
  });
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
  /** A dry run reads and projects only: it deliberately writes neither data nor ledger. */
  dryRun?: boolean;
  runId?: string;
  actor?: "scheduler" | "manual";
  operator?: string | null;
  source?: string;
  spreadsheet?: { id?: string; monthSources?: Record<string, Array<{ tab: string; contentHash: string }>>; fallbackSources?: Array<{ tab: string; contentHash: string }> };
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
    months.push(await processOneMonth(fy, month, monthLines, now, force, opts));
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
  opts: Pick<Parameters<typeof replaceOpenMonths>[0], "dryRun" | "runId" | "actor" | "operator" | "source" | "spreadsheet">,
): Promise<MonthReplaceResult> {
  const sheetRows = monthLines.length;
  const sheetAmount = monthLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const frozen = isMonthFrozen(month, now);
  const freezeAt = monthFreezeAt(month);
  const runId = opts.runId ?? `register-${now.toISOString()}`;
  const actor = opts.actor ?? "scheduler";
  const operator = opts.operator ?? null;
  const source = opts.source ?? "register_sheets_sync";
  const sourceAudit = snapshot(monthLines);
  const spreadsheet = opts.spreadsheet ?? {};
  const failureContext: { before: ReturnType<typeof snapshot> | null } = { before: null };
  const attemptedAt = new Date();

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
      const beforeLines = await tx.select().from(saleLines)
        .where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, month)));
      const beforeAudit = snapshot(beforeLines);
      failureContext.before = beforeAudit;
      const ledger = async (
        outcome: "replaced" | "frozen-skipped" | "frozen-anchored" | "aborted-short-read" | "rejected-shrink" | "failed",
        rowsWritten: number | null,
        afterAudit = beforeAudit,
        detail?: string,
      ) => {
        return tx.insert(registerMonthlyIngestLedger).values(buildLedgerRecord({
          runId, actor, operator, source, fy, month, attemptedAt, outcome,
          writeAtomicity:
            outcome === "replaced" || outcome === "frozen-anchored"
              ? "same-replacement-transaction"
              : "ledger-only-transaction",
          rowsWritten,
          projectedRowsWritten: null,
          beforeLines, sourceLines: monthLines, afterAudit, spreadsheet, detail,
        }));
      };

      // dry run intentionally occurs after locked reads, but before every write.
      if (opts.dryRun) {
        const ledgerPreview = buildRegisterMonthlyLedgerPreview({
          beforeLines,
          sourceLines: monthLines,
          fy,
          month,
          attemptedAt,
          runId,
          actor,
          operator,
          source,
          spreadsheet,
        });
        return { month, action: frozen ? "frozen-skipped" as const : "replaced" as const,
          sheetRows, sheetAmount, dbRowsBefore: beforeAudit.rows, rowsWritten: null,
          projectedRowsWritten: sheetRows, lastGoodRows: st?.lastGoodRows ?? null,
          detail: "dry-run: no writes", ledgerPreview };
      }

      // ── Frozen month, already anchored: skip entirely ────────────────────
      // A Product-Wise range upload can establish the shared freeze state
      // before this primary-register worker reaches its final anchor read.
      // It must still be allowed to record frozen_rows/frozen_amount once;
      // only a complete anchor makes this source safe to skip forever.
      if (frozen && st?.frozenAt != null && st.frozenRows != null) {
        if (st.frozenRows != null && st.frozenRows !== sheetRows) {
          logger.warn(
            { fy, month, frozenRows: st.frozenRows, sheetRows },
            "monthly replace: sheet edited after freeze — ignored (month is permanent)",
          );
        }
        await ledger("frozen-skipped", null);
        return {
          month, action: "frozen-skipped" as const, sheetRows, sheetAmount,
          dbRowsBefore: null, rowsWritten: null, lastGoodRows: st.lastGoodRows,
        };
      }

      // ── Short-read guard (applies to open months AND the final freeze-
      //    transition replace — a truncated read must never become an anchor).
      const lastGood = st?.lastGoodRows ?? null;

      // ── STRICT freeze-transition guard ───────────────────────────────────
      // A freeze is the one write that can never be corrected afterwards, so
      // it gets the strictest check: if this final read returns even ONE row
      // fewer than the last successful read of the month, the freeze ABORTS
      // and is retried on the next tick — it must never lock a partial state.
      // (The 98% tolerance below is for routine daily replaces, where a
      // transient short read costs nothing because tomorrow corrects it.)
      const guardOutcome = classifyMonthlyReadGuard({ force, frozen, lastGood, sheetRows });
      if (guardOutcome === "rejected-shrink") {
        logger.error(
          { fy, month, sheetRows, lastGood },
          "monthly replace: freeze-transition read BELOW last good read — freeze ABORTED, will retry next tick",
        );
        await ledger("rejected-shrink", null, beforeAudit, `freeze rejected: read ${sheetRows} < last good ${lastGood}`);
        return {
          month, action: "rejected-shrink" as const, sheetRows, sheetAmount,
          dbRowsBefore: null, rowsWritten: null, lastGoodRows: lastGood,
          detail: `freeze aborted: read ${sheetRows} < last good ${lastGood} — a freeze never locks fewer rows than previously confirmed`,
        };
      }
      // Fires when a month with a POSITIVE baseline reads materially fewer
      // rows. The explicit `sheetRows === 0` branch closes a rounding gap:
      // for tiny baselines (e.g. 1 row) floor(1 × 0.98) = 0 and an empty read
      // would otherwise slip past the `<` comparison and delete real data.
      // A 0 baseline never trips the guard — empty months stay normal no-ops.
      if (guardOutcome === "aborted-short-read") {
        const catastrophicFloor = Math.floor((lastGood ?? 0) * SHORT_READ_TOLERANCE);
        logger.error(
          { fy, month, sheetRows, lastGood, frozen },
          "monthly replace: read materially below last good read — ABORTED, month left untouched",
        );
        await ledger("aborted-short-read", null, beforeAudit, `read ${sheetRows} < ${catastrophicFloor}`);
        return {
          month, action: "aborted-short-read" as const, sheetRows, sheetAmount,
          dbRowsBefore: null, rowsWritten: null, lastGoodRows: lastGood,
          detail: `read ${sheetRows} < ${catastrophicFloor} (98% of last good ${lastGood})`,
        };
      }

      // ── Replace: delete + insert the month, verified, in THIS transaction.
      const dbRowsBefore = beforeAudit.rows;

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
        // A replace of an UNFROZEN month invalidates any stale anchor (e.g. a
        // month unfrozen by a freeze-window correction): clearing it here keeps
        // assertMonthAnchors honest until the real freeze re-records it.
        ...(frozen
          ? { frozenAt: freezeAt, frozenRows: written, frozenAmount: String(sheetAmount) }
          : { frozenAt: null, frozenRows: null, frozenAmount: null }),
      };
      await tx
        .insert(registerMonthState)
        .values({ fy, monthLabel: month, ...patch })
        .onConflictDoUpdate({
          target: [registerMonthState.fy, registerMonthState.monthLabel],
          set: patch,
        });
      if (frozen) {
        // The Product-Wise raw SKU source shares this state row. Stamp existing
        // rows with the same irreversible freeze instant, so the row itself
        // always explains when its source values became permanent.
        await tx
          .update(secondarySkuLines)
          .set({ frozenAt: freezeAt })
          .where(and(
            eq(secondarySkuLines.fy, fy),
            eq(secondarySkuLines.monthLabel, month),
          ));
      }
      const afterAudit = snapshot(monthLines);
      await ledger(frozen ? "frozen-anchored" : "replaced", written, afterAudit);

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
    // The replacement transaction is already rolled back. Preserve failure
    // evidence separately and label it so readers never mistake it for atomic
    // replacement evidence.
    if (!opts.dryRun) {
      const failureBefore = failureContext.before;
      await db.insert(registerMonthlyIngestLedger).values({
        runId, actor, source, fy, monthLabel: month, attemptedAt, completedAt: new Date(),
        operator, outcome: "failed", writeAtomicity: "post-rollback", rowsWritten: null, projectedRowsWritten: null,
        beforeRows: failureBefore?.rows ?? null, beforeAmount: failureBefore?.amount ?? null, beforeFingerprint: failureBefore?.fingerprint ?? null,
        sourceRows: sourceAudit.rows, sourceAmount: sourceAudit.amount, sourceFingerprint: sourceAudit.fingerprint,
        afterRows: failureBefore?.rows ?? null, afterAmount: failureBefore?.amount ?? null, afterFingerprint: failureBefore?.fingerprint ?? null,
        sourceRowDelta: failureBefore ? sourceAudit.rows - failureBefore.rows : null,
        sourceAmountDelta: failureBefore ? decimalSubtract(sourceAudit.amount, failureBefore.amount) : null,
        sourceShrink: failureBefore ? sourceAudit.rows < failureBefore.rows || decimalSubtract(sourceAudit.amount, failureBefore.amount).startsWith("-") : null,
        actualRowDelta: failureBefore ? 0 : null, actualAmountDelta: failureBefore ? "0" : null, actualShrink: failureBefore ? false : null,
        addedRows: null, removedRows: null, changedRows: null, confidence: null, unpairedResidualRows: null,
        spreadsheetId: spreadsheet.id ?? null, sourceEvidence: { month, sources: spreadsheet.monthSources?.[month] ?? spreadsheet.fallbackSources ?? [] }, detail: err instanceof Error ? err.message : String(err),
      }).catch((ledgerErr) => logger.error({ fy, month, ledgerErr }, "monthly replace: post-rollback failure ledger insert failed"));
    }
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
