// Red Alert — persistence layer.
//
// Builds fingerprints for each detected alert, upserts them into the `alert`
// table, clears open alerts whose condition no longer fires, and wires
// suppressed_by / linked_alert_id cross-references.
//
// The detection engine (detectAlerts) is pure and stateless. This module is
// the only place that reads or writes the alert / alert_action tables.
//
// CONCURRENCY SAFETY:
//   The entire read + upsert + clear pass runs inside a single PostgreSQL
//   transaction, preceded by pg_advisory_xact_lock(hashtext('alert-detect-{fy}'))
//   which serializes concurrent detection runs for the same FY. This means:
//
//   1. An operator acknowledging an alert during detection cannot be cleared:
//      the clear UPDATE includes "AND status = 'open'" so even if we saw
//      'open' in our snapshot and someone acknowledges between the BEGIN and
//      the UPDATE, the UPDATE affects 0 rows (the row stays acknowledged).
//
//   2. Two concurrent POST /api/alerts/detect calls (e.g. manual trigger +
//      6-hour scheduler) do not race: the second waits for the first to
//      commit, then runs with a fresh snapshot that already has the first
//      run's writes visible.
//
// PERIOD COUNTING:
//   periods_open counts consecutive detection runs in which the alert has
//   been observed — spec: "how many consecutive detection runs it has appeared
//   in". It increments on every detection run, regardless of whether the
//   analytical window (period_label) has changed. This lets the page show
//   "open 3 periods" within hours of the alert first appearing, which is the
//   intended signal that the situation has not resolved.

import { pool } from "@workspace/db";
import { buildDetectionContext } from "./context.js";
import { detectAlerts } from "./detectAlerts.js";
import type { RawAlert, CalibrationResult, SecHeadMonthRow } from "./types.js";
import { currentOpenFy } from "../fyAnchors.js";
import { logger } from "../logger.js";

// ── Fingerprint ────────────────────────────────────────────────────────────

/**
 * Build a stable fingerprint for an alert. The fingerprint encodes:
 *   fy | code | entityKey
 *
 * Months are intentionally excluded so the same alert row persists across
 * window changes (when a new month is frozen and the analysis window grows).
 * `periods_open` increments on every detection run that observes this alert,
 * regardless of whether the analytical window (period_label) has changed.
 *
 * One row per (fy, code, entityKey). A different FY creates a new row.
 */
export function buildFingerprint(fy: string, alert: RawAlert): string {
  return `${fy}|${alert.code}|${alert.entityKey}`;
}

// Canonical list of guard names stored on every emitted alert.
const GUARDS_PASSED_CANONICAL = [
  "G1:channel_reclassification",
  "G2:like_months",
  "G3:complete_months",
  "G4:identity_resolution",
  "G5:distributor_reassignment",
  "G6:territory_only",
  "G7:no_target",
  "G8:partial_tenure",
  "G9:sheet_read_failure",
  "G10:cost_data_gate",
];

// ── Types ──────────────────────────────────────────────────────────────────

export type DetectionStats = {
  fy: string;
  new: number;
  updated: number;
  reopened: number;  // cleared → open recurrences
  cleared: number;
  totalOpen: number;
  totalAcknowledged: number;
  linkedPairs: number;
  detectedAt: string;
  /** IDs of alerts inserted in this run (status=open, periods_open=1). */
  newAlertIds: number[];
};

type AlertDbRow = {
  id: number;
  fingerprint: string;
  status: "open" | "acknowledged" | "cleared";
  entity_key: string;
  code: string;
  /** The period window label stored on the row (e.g. "Apr-26..Jul-26"). */
  period_label: string;
};

type C5DbRow = {
  id: number;
  entity_key: string;
  detail: { extraForReport?: { stateHead?: string } } | null;
};

// ── Main persistence function ──────────────────────────────────────────────

/**
 * Persist the results of one detection run into the alert table.
 *
 * Lifecycle:
 *  - New fingerprint            → INSERT (status=open, periods_open=1)
 *  - Existing open fingerprint (any window)   → UPDATE last_seen_at + periods_open++
 *  - Existing ack'd fingerprint → UPDATE last_seen_at + periods_open++;
 *                                  status stays acknowledged
 *  - Existing cleared fingerprint that recurs  → REOPEN: status=open, periods_open++
 *                                  if window advanced; clear_reason/suppressed_by reset
 *  - Existing open fingerprint absent from run → CLEAR (condition_no_longer_holds);
 *                                  WHERE status='open' ensures ack'd rows are never cleared
 *  - Existing ack'd fingerprint absent from run → LEFT as-is (user saw it; it resolved)
 *
 * The entire read + upsert + clear pass runs in one transaction behind a
 * per-FY advisory lock — see module header for concurrency guarantees.
 *
 * Exported for unit/integration testing.
 */
export async function persistAlerts(
  fy: string,
  result: CalibrationResult,
  secHeadMonths: SecHeadMonthRow[],
): Promise<DetectionStats> {
  const now = new Date();
  const alerts = result.alerts;

  // Build headCanon → stateHead lookup (from secHeadMonths context data)
  const headToStateHead = new Map<string, string>();
  for (const r of secHeadMonths) {
    if (r.stateHead) headToStateHead.set(r.headCanon, r.stateHead);
  }

  // Build fingerprint → alert map for the current run
  const currentFps = new Map<string, RawAlert>();
  for (const a of alerts) {
    const fp = buildFingerprint(fy, a);
    currentFps.set(fp, a);
  }

  // Build fingerprint map for suppressed alerts (to wire suppressed_by on clear)
  const suppressedFps = new Map<
    string,
    { suppressingCode: string; suppressedEntityKey: string }
  >();
  for (const s of result.suppressed) {
    if (s.guard !== 0) continue; // only cross-suppression (guard=0)
    const fp = buildFingerprint(fy, s.alert);
    suppressedFps.set(fp, {
      suppressingCode: s.suppressingCode ?? "",
      suppressedEntityKey: s.alert.entityKey,
    });
  }

  // Track ids of upserted rows for cross-linking (populated inside the txn)
  type UpsertedAlert = { id: number; code: string; entityKey: string };
  const upsertedAlerts: UpsertedAlert[] = [];

  let newCount = 0;
  let updatedCount = 0;
  let reopenedCount = 0;
  let clearedCount = 0;
  const newAlertIds: number[] = [];

  // ── Single transaction for the entire snapshot + upsert + clear pass ───────
  // The advisory lock serializes concurrent detection runs for this FY.
  // pg_advisory_xact_lock is released automatically when the transaction ends.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serialize concurrent detection runs for this FY.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `alert-detect-${fy}`,
    ]);

    // Read ALL alert rows for this FY — including cleared — inside the
    // transaction so our snapshot is consistent with our writes.
    const { rows: existingRows } = await client.query<AlertDbRow>(
      `SELECT id, fingerprint, status, entity_key, code, period_label
         FROM alert WHERE fy = $1`,
      [fy],
    );

    const existingByFp = new Map<string, AlertDbRow>();
    for (const row of existingRows) {
      existingByFp.set(row.fingerprint, row);
    }

    // ── Upsert pass ───────────────────────────────────────────────────────────
    for (const [fp, alert] of currentFps) {
      const existing = existingByFp.get(fp);
      const detail = {
        numbers: alert.numbers,
        extraForReport: alert.extraForReport ?? null,
        currentMonths: alert.currentMonths,
        priorMonths: alert.priorMonths,
        entity: alert.entity,
      };
      const periodLabel =
        alert.currentMonths.length > 0
          ? `${alert.currentMonths[0]}..${alert.currentMonths[alert.currentMonths.length - 1]!}`
          : "point-in-time";

      if (existing) {
        // periods_open increments on every detection run (see module header).
        if (existing.status === "cleared") {
          // ── Recurrence: reopen a previously cleared alert ────────────────
          // Reset lifecycle fields; first_seen_at is preserved (original observation).
          await client.query(
            `UPDATE alert
                SET status          = 'open',
                    periods_open    = periods_open + 1,
                    last_seen_at    = $1,
                    rupees_at_stake = $2,
                    detail          = $3::jsonb,
                    entity          = $4,
                    period_label    = $5,
                    clear_reason    = NULL,
                    suppressed_by   = NULL,
                    linked_alert_id = NULL
              WHERE id = $6`,
            [now, alert.rupeesAtStake, JSON.stringify(detail), alert.entity, periodLabel, existing.id],
          );
          upsertedAlerts.push({ id: existing.id, code: alert.code, entityKey: alert.entityKey });
          reopenedCount++;
        } else {
          // ── Continuing open or acknowledged ──────────────────────────────
          // Never reset status: acknowledged stays acknowledged.
          // Increment periods_open on every detection run — spec: "how many
          // consecutive detection runs it has appeared in".
          await client.query(
            `UPDATE alert
                SET last_seen_at    = $1,
                    periods_open    = periods_open + 1,
                    rupees_at_stake = $2,
                    detail          = $3::jsonb,
                    entity          = $4,
                    period_label    = $5
              WHERE id = $6`,
            [now, alert.rupeesAtStake, JSON.stringify(detail), alert.entity, periodLabel, existing.id],
          );
          upsertedAlerts.push({ id: existing.id, code: alert.code, entityKey: alert.entityKey });
          updatedCount++;
        }
      } else {
        // ── New alert ───────────────────────────────────────────────────────
        const { rows: inserted } = await client.query<{ id: number }>(
          `INSERT INTO alert
             (fingerprint, fy, code, entity, entity_key, entity_type,
              period_label, status, periods_open, rupees_at_stake,
              detail, guards_passed, first_seen_at, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'open',1,$8,$9::jsonb,$10::jsonb,$11,$11)
           RETURNING id`,
          [
            fp,
            fy,
            alert.code,
            alert.entity,
            alert.entityKey,
            alert.entityType,
            periodLabel,
            alert.rupeesAtStake,
            JSON.stringify(detail),
            JSON.stringify(GUARDS_PASSED_CANONICAL),
            now,
          ],
        );
        const newId = inserted[0]!.id;
        upsertedAlerts.push({ id: newId, code: alert.code, entityKey: alert.entityKey });
        newAlertIds.push(newId);
        newCount++;
      }
    }

    // ── Build suppressor lookup maps (after upsert, within same txn) ──────────
    const b3ByEntityKey = new Map<string, number>();
    const a2ByEntityKey = new Map<string, number>();
    for (const ua of upsertedAlerts) {
      if (ua.code === "B3") b3ByEntityKey.set(ua.entityKey, ua.id);
      if (ua.code === "A2") a2ByEntityKey.set(ua.entityKey, ua.id);
    }

    // C5 alerts: entityKey = headCanon; stateHead is in stored detail.extraForReport
    const { rows: c5Rows } = await client.query<C5DbRow>(
      `SELECT id, entity_key, detail FROM alert
        WHERE fy = $1 AND code = 'C5' AND status IN ('open','acknowledged')`,
      [fy],
    );
    const stateHeadToC5Id = new Map<string, number>();
    for (const r of c5Rows) {
      const sh = r.detail?.extraForReport?.stateHead;
      if (sh && sh !== "—") stateHeadToC5Id.set(sh, r.id);
    }

    // Fingerprint → suppressor-db-id for cross-suppressed alerts
    const fpToSuppressorId = new Map<string, number>();
    for (const [fp, info] of suppressedFps) {
      let suppressorId: number | undefined;

      if (info.suppressingCode === "B3") {
        suppressorId = b3ByEntityKey.get(info.suppressedEntityKey);
      } else if (info.suppressingCode === "A2") {
        suppressorId = a2ByEntityKey.get(info.suppressedEntityKey);
      } else if (info.suppressingCode === "C5") {
        const stateHead =
          headToStateHead.get(info.suppressedEntityKey) ??
          info.suppressedEntityKey;
        suppressorId = stateHeadToC5Id.get(stateHead);
      }

      if (suppressorId !== undefined) {
        fpToSuppressorId.set(fp, suppressorId);
      }
    }

    // ── Clear pass (within same transaction) ──────────────────────────────────
    // "WHERE status = 'open'" is the critical safety guard: even if our
    // snapshot saw 'open' before an operator acknowledged the alert, this
    // condition ensures the UPDATE is a no-op for acknowledged rows. The
    // advisory lock means no concurrent detection run can interfere, but
    // the status guard protects against concurrent acknowledgements.
    for (const [fp, row] of existingByFp) {
      if (row.status !== "open") continue;  // snapshot filter (acknowledged/cleared skip)
      if (currentFps.has(fp)) continue;     // still firing — do not clear

      let clearReason = "condition_no_longer_holds";
      let suppressedBy: number | null = null;

      const suppInfo = suppressedFps.get(fp);
      if (suppInfo) {
        const suppressorId = fpToSuppressorId.get(fp);
        if (suppressorId !== undefined) {
          suppressedBy = suppressorId;
          clearReason =
            suppInfo.suppressingCode === "B3" ? "cross_suppressed_by_B3"
            : suppInfo.suppressingCode === "A2" ? "cross_suppressed_by_A2"
            : suppInfo.suppressingCode === "C5" ? "cross_suppressed_by_C5"
            : "condition_no_longer_holds";
        }
      }

      // "AND status = 'open'" — if an operator acknowledged this row between
      // BEGIN and this UPDATE, the UPDATE affects 0 rows (row stays acknowledged).
      await client.query(
        `UPDATE alert
            SET status        = 'cleared',
                clear_reason  = $1,
                suppressed_by = $2,
                last_seen_at  = $3
          WHERE id = $4 AND status = 'open'`,
        [clearReason, suppressedBy, now, row.id],
      );
      clearedCount++;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {/* ignore rollback error */});
    throw err;
  } finally {
    client.release();
  }

  // ── Wire linked_alert_id (B3 + S1 same distributor) ───────────────────────
  // Best-effort: outside the main transaction. A link failure is non-fatal
  // and will be corrected on the next detection run.
  let linkedPairs = 0;
  try {
    const b3s = upsertedAlerts.filter((a) => a.code === "B3");
    const s1s = upsertedAlerts.filter((a) => a.code === "S1");
    for (const b3 of b3s) {
      const s1 = s1s.find((a) => a.entityKey === b3.entityKey);
      if (s1) {
        await pool.query(`UPDATE alert SET linked_alert_id = $1 WHERE id = $2`, [s1.id, b3.id]);
        await pool.query(`UPDATE alert SET linked_alert_id = $1 WHERE id = $2`, [b3.id, s1.id]);
        linkedPairs++;
      }
    }

    // Clear stale B3/S1 links when counterpart is now cleared.
    await pool.query(
      `UPDATE alert AS a
          SET linked_alert_id = NULL
        WHERE a.fy = $1
          AND a.linked_alert_id IS NOT NULL
          AND a.status IN ('open','acknowledged')
          AND EXISTS (
                SELECT 1 FROM alert linked
                WHERE linked.id = a.linked_alert_id
                  AND linked.status = 'cleared'
              )`,
      [fy],
    );
  } catch (linkErr) {
    logger.warn({ err: linkErr }, "[alertPersistence] cross-link wiring failed (non-fatal)");
  }

  // ── Summary counts ─────────────────────────────────────────────────────────
  const { rows: counts } = await pool.query<{ status: string; cnt: string }>(
    `SELECT status, COUNT(*)::text AS cnt FROM alert WHERE fy = $1 GROUP BY status`,
    [fy],
  );
  const countMap: Record<string, number> = {};
  for (const r of counts) countMap[r.status] = Number(r.cnt);

  return {
    fy,
    new: newCount,
    updated: updatedCount,
    reopened: reopenedCount,
    cleared: clearedCount,
    totalOpen: countMap["open"] ?? 0,
    totalAcknowledged: countMap["acknowledged"] ?? 0,
    linkedPairs,
    detectedAt: now.toISOString(),
    newAlertIds,
  };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Run full alert detection for the current open FY and persist results.
 * Returns a summary of what was created, updated, and cleared.
 */
export async function runAlertDetection(): Promise<DetectionStats> {
  const fy = currentOpenFy();
  logger.info({ fy }, "[alertDetection] building detection context");

  const ctx = await buildDetectionContext(pool, [fy]);

  logger.info({ fy }, "[alertDetection] running detection");
  const result = detectAlerts(ctx, { fy });

  const alertCount = result.alerts.length;
  const suppressedCount = result.suppressed.length;
  logger.info(
    { fy, alerts: alertCount, suppressed: suppressedCount },
    "[alertDetection] detection complete — persisting",
  );

  const stats = await persistAlerts(fy, result, ctx.secHeadMonths);

  logger.info(
    {
      fy,
      new: stats.new,
      updated: stats.updated,
      reopened: stats.reopened,
      cleared: stats.cleared,
      totalOpen: stats.totalOpen,
      linkedPairs: stats.linkedPairs,
    },
    "[alertDetection] persistence complete",
  );

  return stats;
}
