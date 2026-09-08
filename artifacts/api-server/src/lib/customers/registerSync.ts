// Auto-populates sale_line_all from the live sale/dispatch register Sheets.
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
  computeLineUid,
} from "../registers/normalize.js";
import {
  recordIngestRun,
  assertUnmappedEmpty,
} from "../registers/ingest.js";
import { replaceOpenMonths, assertMonthAnchors } from "../registers/monthlyReplace.js";
import { hasSuccessfulOpenMonthReplacement } from "./registerSyncCoverageCache.js";
import { backfillSaleChannel } from "../sap/backfillChannel.js";
import { recordCanonicalCoverageDriftCheck } from "../canonicalCoverageDrift.js";
import {
  resolveWaterTankRow,
  buildSapLookupMap,
  assertTankQtyLtr,
  type SapLookupMap,
} from "../registers/tankResolution.js";
import {
  auditCanonicalCoverageDrift,
  invalidateCanonicalCoverageDriftCache,
} from "../canonicalCoverageReport.js";
import {
  getFrozenAnchors,
  isFrozen,
  type FrozenEntry,
} from "./freezeState.js";
export { getFrozenAnchor, isFrozen } from "./freezeState.js";

export const REGISTER_SHEET_IDS: Record<string, string> =
  registerSheets.registers;

// ── Freeze system ──────────────────────────────────────────────────────────────
// A frozen FY is permanently closed: the scheduler does not read it, startup
// sync treats it as done, and force-resync is rejected unless the caller
// explicitly passes ?unfreeze=true&reason=<text>.
//
// Anchors (rows + amountRupees) are asserted on every startup. A mismatch
// means something wrote to an immutable year — the violation is logged at
// ERROR and exposed via getFreezeViolations().
//
// amountRupees=0 means the Sheets-sourced total has not yet been confirmed;
// the amount assertion is skipped until it is set.

export type FreezeViolation = {
  fy: string;
  expected: FrozenEntry;
  actual: { rows: number; amountRupees: number };
  reason: string;
};

const freezeViolations: FreezeViolation[] = [];
let freezeCheckedAt: string | null = null;

export function getFreezeViolations(): { violations: FreezeViolation[]; checkedAt: string | null } {
  return { violations: [...freezeViolations], checkedAt: freezeCheckedAt };
}

/**
 * Asserts that every frozen FY in the DB still matches its anchor.
 * Called once per startup; runs in background (non-blocking).
 * Logs ERROR for each violation; never exits the process.
 */
export async function assertFrozenAnchors(): Promise<void> {
  for (const [fy, anchor] of getFrozenAnchors()) {
    try {
      const { rows } = await pool.query<{ rows: string; amount: string }>(
        `SELECT COUNT(*)::text AS rows, COALESCE(ROUND(SUM(amount::numeric)), 0)::text AS amount
         FROM sale_line_all WHERE fy = $1 AND version_status = 'current'`,
        [fy],
      );
      const actual = {
        rows: parseInt(rows[0]?.rows ?? "0", 10),
        amountRupees: parseInt(rows[0]?.amount ?? "0", 10),
      };

      // If DB has 0 rows the FY hasn't been loaded yet — skip assertion.
      if (actual.rows === 0) continue;

      let violated = false;
      const reasons: string[] = [];

      if (anchor.rows > 0 && actual.rows !== anchor.rows) {
        reasons.push(`rows expected=${anchor.rows} actual=${actual.rows}`);
        violated = true;
      }
      // Skip amount assertion when anchor.amountRupees=0 (not yet confirmed).
      if (anchor.amountRupees > 0 && Math.abs(actual.amountRupees - anchor.amountRupees) > 10) {
        reasons.push(
          `amountRupees expected=${anchor.amountRupees} actual=${actual.amountRupees} delta=${actual.amountRupees - anchor.amountRupees}`,
        );
        violated = true;
      }

      if (violated) {
        const violation: FreezeViolation = { fy, expected: anchor, actual, reason: reasons.join("; ") };
        freezeViolations.push(violation);
        logger.error(violation, `freeze violation: FY${fy} has been written — immutability broken`);
      } else {
        logger.info({ fy, rows: actual.rows, amountRupees: actual.amountRupees }, "freeze assertion: ok");
      }
    } catch (err) {
      logger.warn({ err, fy }, "freeze assertion: DB query failed — skipping");
    }
  }
  freezeCheckedAt = new Date().toISOString();
}

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

// In-memory timestamp is UI-only. Scheduler due state is persisted below.
const lastSyncedAtMs = new Map<string, number>();

// NOTE (Aug 2026): the per-month short-read baseline now lives in the DATABASE
// (register_month_state.last_good_rows, maintained by replaceOpenMonths) so it
// survives process restarts. The old in-memory lastGoodRowCountByMonth map and
// its ingest_run-based boot loader are gone with the versioned-sync pipeline.

const HOURLY_REGISTER_SYNC_MS = 60 * 60 * 1000;
const SCHEDULE_INTERVAL_MS = HOURLY_REGISTER_SYNC_MS;
const REGISTER_SYNC_JOB_LOCK = "register-sync-job";

type SyncMetrics = { driveRequests: number; rowsScanned: number; monthsTouched: number };
type RegisterSyncLockClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
};
type DoSyncOptions = { runId?: string; lockClient?: RegisterSyncLockClient; metrics?: SyncMetrics };

function hourlyRunKey(now = new Date()): string {
  return now.toISOString().slice(0, 13);
}

async function acquireRegisterSyncLock(): Promise<RegisterSyncLockClient | null> {
  const client = await pool.connect() as unknown as RegisterSyncLockClient;
  const result = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    [REGISTER_SYNC_JOB_LOCK],
  );
  if (!result.rows[0]?.locked) {
    client.release();
    return null;
  }
  return client;
}

async function releaseRegisterSyncLock(client: RegisterSyncLockClient): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [REGISTER_SYNC_JOB_LOCK]);
  } finally {
    client.release();
  }
}

/**
 * Returns true when the given FY is listed in the REGISTER_SYNC_PAUSE
 * environment variable (comma-separated, e.g. "2026-27").
 *
 * Set this during manual DB surgery to prevent the startup sync and the
 * scheduled ticker from touching the FY while it is being repaired.
 * Clear (or remove) the variable when surgery is complete.
 */
function isSyncPaused(fy: string): boolean {
  const raw = process.env.REGISTER_SYNC_PAUSE ?? "";
  if (!raw.trim()) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .includes(fy);
}

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

/**
 * Canonical pre-monthlyReplace transform.  Frozen drift review imports this
 * rather than reimplementing the tank/SAP and synthetic-serial rules, so an
 * exceptional refresh has the same rows monthly replacement would write.
 */
export async function transformRegisterLinesForMonthlyReplace(
  fy: string,
  lines: InsertSaleLine[],
): Promise<InsertSaleLine[]> {
  const regCfg = registerSheets as unknown as { sap_source?: Record<string, string> };
  const sapId = regCfg.sap_source?.[fy] ?? null;
  let sapLookup: SapLookupMap | null = null;
  if (sapId) {
    try { sapLookup = await buildSapLookupMap(sapId); }
    catch (err) { logger.error({ fy, sapId, err }, "register transform: SAP load failed — falling back to Route 2"); }
  }
  const resolvedLines = lines.map((line) => {
    const resolved = resolveWaterTankRow({
      code: line.code, groupCanon: line.groupCanon ?? null,
      sheetQty: line.qty != null ? Number(line.qty) : null,
      invoiceNo: line.invoiceNo ?? null, amount: Number(line.amount),
      sapLookup, hasSapSource: sapId != null,
    });
    if (resolved.flag === "non-tank-group" || resolved.flag === "unmapped-suffix" ||
        resolved.flag === "sap-ghost" || resolved.flag === "non-clean-division") return line;
    if (assertTankQtyLtr(resolved) != null) return line;
    return {
      ...line,
      qty: resolved.qty != null ? String(resolved.qty) : null,
      qtyLtr: resolved.qtyLtr != null ? String(resolved.qtyLtr) : null,
    };
  });
  const tankUidOcc = new OccurrenceCounter();
  const resolvedUids = resolvedLines.map((line) => {
    if (line.groupCanon !== "WATER TANK" || line.serialNo == null) return line;
    const key = [line.fy ?? "", line.code, line.qty ?? "", line.amount, line.monthLabel ?? "", String(line.serialNo)].join("|");
    return { ...line, lineUid: computeLineUid(key, tankUidOcc.next(key)) };
  });
  const synthetic = new OccurrenceCounter();
  return resolvedUids.map((line) => {
    if (line.serialNo != null) return line;
    const identity = [line.invoiceNo ?? "", line.code, line.color ?? "", line.qty ?? "", line.monthLabel ?? ""].join("|");
    const serialNo = synthetic.next(identity);
    const uidKey = [
      line.fy ?? "", line.invoiceNo ?? "", line.code, line.color ?? "", line.qty ?? "",
      line.amount, line.monthLabel ?? "", serialNo,
    ].join("|");
    return { ...line, serialNo, lineUid: computeLineUid(uidKey, 0) };
  });
}

async function hasRows(fy: string): Promise<boolean> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sale_line_all WHERE fy = $1 LIMIT 1`,
    [fy],
  );
  return parseInt(res.rows[0]?.n ?? "0", 10) > 0;
}

export async function doSync(fy: string, spreadsheetId: string, options: DoSyncOptions = {}): Promise<void> {
  const s = stateFor(fy);
  const ownedLock = options.lockClient == null;
  const lockClient = options.lockClient ?? await acquireRegisterSyncLock();
  if (!lockClient) {
    logger.warn({ fy }, "register sync: shared job lock busy — skipping overlap");
    throw new Error("register sync already running");
  }
  s.phase = "syncing";
  const startedAt = new Date();
  logger.info({ fy, spreadsheetId }, "register sync: starting");
  try {
    const occurrence = new OccurrenceCounter();
    const unmapped = emptyUnmapped();
    const lines: InsertSaleLine[] = [];

    const requestCounter = { count: 0 };
    const { rowsScanned, tabsRead, tabsNotRead, monthSources, fallbackSources } = await readRegisterFromSheets(
      spreadsheetId,
      fy,
      (values, columns, tabMonthLabel) => {
        const result = parseRegisterRow(values, columns, fy, tabMonthLabel);
        if (result.kind !== "row") return;
        lines.push(toSaleLine(result.row, occurrence, unmapped, "sheets"));
      },
      { onRequest: () => { requestCounter.count++; } },
    );
    if (options.metrics) {
      options.metrics.driveRequests = requestCounter.count;
      options.metrics.rowsScanned = rowsScanned;
    }

    // New-tab detection: every workbook tab NOT read as sales data is logged,
    // shape-tested and recorded as proposed/ignored. Never blocks the sync.
    if (tabsNotRead && tabsNotRead.length > 0) {
      const { auditRegisterTabs } = await import("../registers/tabAudit.js");
      await auditRegisterTabs({ sheetId: spreadsheetId, fy, register: "sale", tabs: tabsNotRead }).catch((err) =>
        logger.warn({ err, fy, tabs: tabsNotRead.map((t) => t.title) }, "register sync: tab audit failed — unrecognised tabs NOT recorded this run"),
      );
    }

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
      throw new Error(s.error);
    }

    // ── Tank resolution ────────────────────────────────────────────────────────
    // WATER TANK rows: sheet qty is total litres, not pieces. Translate to
    // qty = pieces, qty_ltr = litres before writing. See tankResolution.ts.
    const regCfg = registerSheets as unknown as { sap_source?: Record<string, string> };
    const sapId = regCfg.sap_source?.[fy] ?? null;
    const hasSapSource = sapId != null;

    let sapLookup: SapLookupMap | null = null;
    if (sapId) {
      try {
        sapLookup = await buildSapLookupMap(sapId);
        logger.info({ fy, sapId, entries: sapLookup.size }, "register sync: SAP lookup loaded");
      } catch (err) {
        logger.error({ fy, sapId, err }, "register sync: SAP load failed — falling back to Route 2");
      }
    }

    const tankFlags = { route1: 0, route2: 0, sapGhost: 0, nonClean: 0, unmapped: 0, assertFail: 0 };
    const resolvedLines: typeof lines = lines.map((line) => {
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

      if (resolved.flag === "non-tank-group") return line;
      if (resolved.flag === "unmapped-suffix") { tankFlags.unmapped++; return line; }

      if (resolved.flag === "route1-sap")           tankFlags.route1++;
      else if (resolved.flag === "route2-division")  tankFlags.route2++;
      else if (resolved.flag === "sap-ghost")        tankFlags.sapGhost++;
      else if (resolved.flag === "non-clean-division") tankFlags.nonClean++;

      if (resolved.flag === "sap-ghost" || resolved.flag === "non-clean-division") {
        logger.warn(
          { fy, code: line.code, invoiceNo: line.invoiceNo, amount: line.amount, flag: resolved.flag },
          "register sync: tank resolution flag",
        );
      }

      const assertion = assertTankQtyLtr(resolved);
      if (assertion != null) {
        tankFlags.assertFail++;
        logger.error(
          { fy, code: line.code, invoiceNo: line.invoiceNo, assertion },
          "register sync: tank qty assertion FAILED — row kept with original sheet values",
        );
        return line; // fail loudly, never commit bad data silently
      }

      return {
        ...line,
        qty: resolved.qty != null ? String(resolved.qty) : null,
        qtyLtr: resolved.qtyLtr != null ? String(resolved.qtyLtr) : null,
      };
    });

    if (Object.values(tankFlags).some((v) => v > 0)) {
      logger.info({ fy, ...tankFlags }, "register sync: tank resolution complete");
    }

    // ── Step 2b: recompute lineUid for resolved tank rows (Schema A only) ────
    // toSaleLine hashed lineUid with the ORIGINAL sheet qty (litres).
    // After tank resolution qty = pieces, so the hash must be recomputed so
    // the new lineUid differs from the superseded litres-based row and the
    // insert does not hit ON CONFLICT DO NOTHING on the old superseded row.
    // Only applies to rows with a real (non-null) serialNo — null-serial rows
    // (Schema B FYs: 2024-25, 2025-26) have their lineUid recomputed in
    // step 2c after synthetic serials are assigned post-resolution.
    const tankUidOcc = new OccurrenceCounter();
    const linesWithResolvedUids = resolvedLines.map((line) => {
      if (line.groupCanon !== "WATER TANK" || line.serialNo == null) return line;
      const newKey = [
        line.fy ?? "",
        line.code,
        line.qty ?? "",
        line.amount,
        line.monthLabel ?? "",
        String(line.serialNo),
      ].join("|");
      return { ...line, lineUid: computeLineUid(newKey, tankUidOcc.next(newKey)) };
    });

    // ── Step 2c: assign synthetic serials (post-resolution) ─────────────────
    // Synthetic serials must be based on the POST-resolution identity key.
    // Assigning them pre-resolution (based on sheet ltr-qty) causes collisions
    // in dedupeBySerialNo when two rows with different ltr quantities both
    // floor-divide to the same pieces count: each gets serialNo=0 from its own
    // counter key, then shares the same 6-field dedup key after resolution.
    //
    // By assigning here — after qty has been resolved to pieces — the counter
    // key is stable through tank resolution, and every physically distinct row
    // gets a unique serial in the post-resolution identity space.
    //
    // Only applies to rows with serialNo == null (Schema B FYs with no SERIALNO
    // column). Schema A rows (FY2026-27) have real sheet serials and are
    // untouched by this step.
    const postResOccCounter = new OccurrenceCounter();
    const legacyLinesForSync = linesWithResolvedUids.map((line) => {
      if (line.serialNo != null) return line; // real or Schema-A serial — leave untouched
      // Post-resolution identity key: uses resolved qty (pieces for tank rows).
      const postIdKey = [
        line.invoiceNo ?? "",
        line.code,
        line.color ?? "",
        line.qty ?? "",
        line.monthLabel ?? "",
      ].join("|");
      const syntheticSerial = postResOccCounter.next(postIdKey);
      // Recompute lineUid to match the lineUidKey formula (fy|invoiceNo|code|color|qty|amount|month|serial)
      // so it is consistent with the identity key used by versionedSyncLines.
      const postUidKey = [
        line.fy ?? "",
        line.invoiceNo ?? "",
        line.code,
        line.color ?? "",
        line.qty ?? "",
        line.amount,
        line.monthLabel ?? "",
        syntheticSerial,
      ].join("|");
      return { ...line, serialNo: syntheticSerial, lineUid: computeLineUid(postUidKey, 0) };
    });
    // Keep frozen-drift refresh and normal monthly replacement on the same
    // exported transform. The legacy calculation above remains temporarily for
    // its detailed operational flags/logging, but is not the write source.
    const linesForSync = await transformRegisterLinesForMonthlyReplace(fy, lines);

    // ── Step 3: monthly full replace ─────────────────────────────────────────
    // No identity key, no dedup, no tombstone, no supersede, no revive.
    // Persisted frozen months are skipped forever. Otherwise the primary
    // register keeps the current month plus three prior months open and freezes
    // each month at IST midnight on the 1st of the fourth following month.
    // Each open month
    // is deleted and re-inserted from the read in ONE transaction, guarded by
    // the DB-persisted short-read baseline in register_month_state.
    const replaceSummary = await replaceOpenMonths({
      fy, lines: linesForSync, runId: options.runId ?? `scheduled-${startedAt.toISOString()}`,
      actor: "scheduler", operator: null, source: "register_sheets_sync",
      spreadsheet: { id: spreadsheetId, monthSources, fallbackSources },
    });

    const inserted = replaceSummary.months.reduce((n, m) => n + (m.rowsWritten ?? 0), 0);
    if (options.metrics) options.metrics.monthsTouched = replaceSummary.months.length;
    const aborted = replaceSummary.months.filter((m) =>
      m.action === "aborted-short-read" || m.action === "rejected-shrink" || m.action === "failed",
    );

    // ── Step 3b: channel backfill ─────────────────────────────────────────────
    // The Sheets ingest always writes channel = NULL (the register carries no
    // rate-list data). Backfill runs here, immediately after every replace that
    // wrote at least one row, so the NULL-channel window is bounded to the
    // duration of one sync run rather than requiring a manual admin call.
    //
    // Assertion: any residual NULL-channel customers (genuinely absent from
    // Sheet2) are named in the WARN log so the rate-list team can add them.
    if (inserted > 0) {
      await backfillSaleChannel([fy]).catch((err: unknown) =>
        logger.warn({ fy, err }, "register sync: channel backfill failed (non-fatal — channel stays NULL until next run)"),
      );
    }
    const incomingCountByFyMonth = new Map<string, number>();
    for (const m of replaceSummary.months) {
      incomingCountByFyMonth.set(`${fy}|${m.month}`, m.sheetRows);
    }

    // Which months were actually replaced this run. The calendar scope is the
    // current month plus three prior; persisted frozen_at still overrides it.
    const replacedMonths = replaceSummary.months
      .filter((m) => m.action === "replaced" || m.action === "frozen-anchored")
      .map((m) => `${m.month}(${m.rowsWritten} rows, ₹${((m.sheetAmount ?? 0) / 1e7).toFixed(2)} Cr)`);

    lastSyncedAtMs.set(fy, Date.now());
    if (hasSuccessfulOpenMonthReplacement(replaceSummary.months)) {
      invalidateCanonicalCoverageDriftCache(fy);
    }
    s.rows = linesForSync.length;
    s.phase = "done";
    logger.info(
      {
        fy,
        spreadsheetId,
        tabsRead,
        rowsScanned,
        linesBuilt: linesForSync.length,
        replacedMonths,
        replacedCount: replacedMonths.length,
        months: replaceSummary.months.map((m) => `${m.month}:${m.action}(${m.rowsWritten ?? "-"})`),
        rowsWritten: inserted,
        driveRequests: requestCounter.count,
        elapsedMs: Date.now() - startedAt.getTime(),
        abortedMonths: aborted.map((m) => m.month),
        unmappedGroups: Object.keys(unmapped.unmapped_groups).length,
        unmappedHeads: Object.keys(unmapped.unmapped_heads).length,
      },
      "register sync: complete",
    );

    // ── Persist ingest run (unmapped detail + assertions) ───────────────────
    // This is the early-warning record for unmapped heads/groups/states.
    // assertUnmappedEmpty will mark unmapped_heads_empty as failed and include
    // the full raw→count map in `detail`, so any new unmapped head is visible
    // in the ingest_run table without needing to grep logs.
    const unmappedStatus =
      Object.keys(unmapped.unmapped_heads).length > 0 ||
      Object.keys(unmapped.unmapped_groups).length > 0 ||
      Object.keys(unmapped.unmapped_states).length > 0
        ? "warn"
        : "ok";
    // Convert "fy|month" keys to just month keys for storage (the run is already
    // tagged with fy). This record is loaded on boot to seed lastGoodRowCountByMonth
    // so guards survive process restarts.
    const rowsPerMonth: Record<string, number> = {};
    for (const [k, count] of incomingCountByFyMonth) {
      const month = k.slice(k.indexOf("|") + 1);
      if (month) rowsPerMonth[month] = count;
    }

    await recordIngestRun({
      startedAt,
      source: "register_sheets_sync",
      fy,
      rowsRead: rowsScanned,
      rowsInserted: inserted,
      rowsSkipped: rowsScanned - linesWithResolvedUids.length,
      unmapped,
      assertions: assertUnmappedEmpty(unmapped),
      status: unmappedStatus,
      rowsPerMonth,
    }).catch((err: unknown) =>
      logger.warn({ fy, err }, "register sync: failed to record ingest run (non-fatal)"),
    );

    // ── Step 4b: canonical-coverage evidence drift ─────────────────────────
    // Re-run the exact source→coverage reconciliation after the new register
    // rows are committed. This is an audit only: a warning means an operator
    // must review it; this sync never changes organisation coverage.
    await auditCanonicalCoverageDrift("register_sync", fy)
      .then((check) => {
        if (!check.passed) {
          logger.warn(
            {
              fy,
              issueCount: check.issueCount,
              issues: check.issues,
            },
            "canonical coverage drift detected — operator review required; coverage was not changed",
          );
        } else {
          logger.info({ fy }, "canonical coverage drift check: evidence still reconciles");
        }
      })
      .catch((err: unknown) =>
        logger.warn(
          { fy, err },
          "canonical coverage drift check failed (non-fatal — coverage was not changed)",
        ),
      );

    // ── Step 5: anchor check — DB current vs sheet, per month ───────────────
    // Runs AFTER the tombstone pass. A healthy month has rowDelta=0 and
    // totalDelta≤1. A halted blast-radius month shows rowDelta>0 with
    // divergencePct>10 and is flagged suspected-read-failure.
    const sheetByMonth = new Map<string, { rows: number; total: number }>();
    for (const line of linesWithResolvedUids) {
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
         FROM sale_line_all
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

    // A register load may make customer-to-head evidence mixed or stale after
    // canonical coverage was established. Capture that exception for operators,
    // but never update coverage or turn a successful sales sync into a failure.
    if (inserted > 0) {
      void recordCanonicalCoverageDriftCheck(fy);
    }
  } catch (err) {
    s.phase = "error";
    s.error = err instanceof Error ? err.message : String(err);
    logger.error({ fy, spreadsheetId, err }, "register sync: failed");
    throw err;
  } finally {
    s.inFlight = null;
    if (ownedLock) await releaseRegisterSyncLock(lockClient);
  }
}

async function runPersistedHourlySync(fy: string, spreadsheetId: string): Promise<void> {
  const lockClient = await acquireRegisterSyncLock();
  if (!lockClient) {
    logger.info({ fy }, "hourly register sync: shared lock busy — another job owns this run");
    return;
  }
  const jobName = `primary-register|${fy}`;
  const runKey = hourlyRunKey();
  const startedAt = new Date();
  const metrics: SyncMetrics = { driveRequests: 0, rowsScanned: 0, monthsTouched: 0 };
  try {
    const state = await lockClient.query<{ last_successful_run_key: string | null }>(
      "SELECT last_successful_run_key FROM register_sync_scheduler_state WHERE job_name=$1",
      [jobName],
    );
    if (state.rows[0]?.last_successful_run_key === runKey) return;
    await lockClient.query(
      `INSERT INTO register_sync_scheduler_state
         (job_name,last_attempted_run_key,status,started_at,completed_at,detail,updated_at)
       VALUES ($1,$2,'running',$3,NULL,NULL,now())
       ON CONFLICT (job_name) DO UPDATE SET
         last_attempted_run_key=EXCLUDED.last_attempted_run_key,status='running',
         started_at=EXCLUDED.started_at,completed_at=NULL,detail=NULL,updated_at=now()`,
      [jobName, runKey, startedAt],
    );
    let ok = false;
    let detail: string | null = null;
    try {
      await doSync(fy, spreadsheetId, {
        runId: `hourly-${fy}-${runKey}`,
        lockClient,
        metrics,
      });
      ok = true;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    const elapsedMs = Date.now() - startedAt.getTime();
    await lockClient.query(
      `UPDATE register_sync_scheduler_state SET
         last_successful_run_key=CASE WHEN $2 THEN $3 ELSE last_successful_run_key END,
         status=CASE WHEN $2 THEN 'succeeded' ELSE 'failed' END,
         completed_at=now(),drive_requests=$4,elapsed_ms=$5,rows_scanned=$6,
         months_touched=$7,detail=$8,updated_at=now()
       WHERE job_name=$1`,
      [jobName, ok, runKey, metrics.driveRequests, elapsedMs, metrics.rowsScanned,
       metrics.monthsTouched, detail],
    );
    logger.info({ fy, runKey, ok, ...metrics, elapsedMs }, "hourly register sync: persisted run complete");
  } finally {
    await releaseRegisterSyncLock(lockClient);
  }
}

// Ensures sale_line_all is being populated for this FY.
//   - Completed FYs: syncs once on first call; subsequent calls are no-ops.
//   - Open (current) FY: the persisted UTC-hour key decides whether work is due.
export function ensureRegisterSynced(fy: string): void {
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) return;

  if (isFrozen(fy)) {
    // Frozen FYs are permanently closed — treat as already done on every startup.
    const s = stateFor(fy);
    s.phase = "done";
    return;
  }

  if (isSyncPaused(fy)) {
    logger.warn({ fy }, "register sync: REGISTER_SYNC_PAUSE set — skipping startup sync for this FY");
    const s = stateFor(fy);
    s.phase = "done"; // prevent UI from showing "syncing" indefinitely
    return;
  }

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
        await runPersistedHourlySync(fy, spreadsheetId);
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
    if (isFrozen(fy)) {
      // Frozen FYs never participate in any scheduled sync.
      continue;
    }
    if (!isFyOpen(fy)) {
      logger.info({ fy }, "scheduled register sync: closed FY — skipping");
      continue;
    }
    if (isSyncPaused(fy)) {
      logger.warn({ fy }, "scheduled register sync: REGISTER_SYNC_PAUSE set — skipping this FY");
      continue;
    }
    const s = stateFor(fy);
    if (s.inFlight) continue; // already running
    s.inFlight = runPersistedHourlySync(fy, spreadsheetId).catch((err: unknown) => {
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
