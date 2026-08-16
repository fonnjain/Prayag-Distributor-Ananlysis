/**
 * Escalation runner — 3-level chain.
 *
 * Level 1 receives on raise (or in the weekly digest).
 * Level 1 → Level 2: if L1 delivery is unacknowledged past the window.
 *   If no L2 recipients are configured: write a skip row at L2 and
 *   immediately go to Level 3 (never stall silently at an empty level).
 * Level 2 → Level 3: if L2 delivery is unacknowledged past the window.
 *
 * Every level continues to hold the alert — no delivery is removed.
 *
 * Windows are read from alert_escalation_config (configurable).
 * Severity (severe vs digest) determines which window column is used for L1.
 */

import { pool } from "@workspace/db";
import { getSeverityForCode } from "./severity.js";
import { notifyAlert, insertDelivery } from "./notify.js";
import { logger } from "../logger.js";

export type EscalationResult = {
  alertId: number;
  code: string;
  entity: string;
  fromLevel: number;
  toLevel: number;
  daysSinceRaised: number;
  escalationWindowDays: number;
  skippedEmptyLevel: boolean;
  alreadyEscalated: boolean;
  deliveriesWritten: number;
  skipReason?: string;
};

// ── Config ────────────────────────────────────────────────────

async function getEscalationConfig(
  level: 1 | 2,
): Promise<{ windowDaysSevere: number; windowDaysDigest: number }> {
  const { rows } = await pool.query<{
    window_days_severe: number;
    window_days_digest: number;
  }>(
    `SELECT window_days_severe, window_days_digest
     FROM alert_escalation_config WHERE level = $1`,
    [level],
  );
  if (!rows[0]) return { windowDaysSevere: level === 1 ? 7 : 7, windowDaysDigest: level === 1 ? 14 : 7 };
  return {
    windowDaysSevere: rows[0].window_days_severe,
    windowDaysDigest: rows[0].window_days_digest,
  };
}

// ── Helpers ───────────────────────────────────────────────────

/** Count active recipients at a given escalation level. */
async function countRecipientsAtLevel(level: number): Promise<number> {
  const { rows } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM alert_recipient WHERE escalation_level = $1 AND is_active = TRUE`,
    [level],
  );
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Check if an escalation from `fromLevel` to `toLevel` already fired
 * (i.e. a delivery row at toLevel with trigger_type='escalation' exists).
 */
async function alreadyFired(alertId: number, toLevel: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id FROM alert_delivery
     WHERE alert_id = $1 AND escalation_level = $2 AND trigger_type = 'escalation'
     LIMIT 1`,
    [alertId, toLevel],
  );
  return rows.length > 0;
}

// ── Main runner ───────────────────────────────────────────────

/**
 * Check all open alerts for overdue acknowledgements and advance them
 * up the escalation ladder.
 */
export async function runEscalation(
  opts: { dryRun?: boolean } = {},
): Promise<EscalationResult[]> {
  const { dryRun = true } = opts;

  // ── Step 1: L1 → L2 (or L3 if L2 is empty) ─────────────────

  const { rows: l1Rows } = await pool.query<{
    alert_id: number;
    code: string;
    entity: string;
    first_seen_at: string;
    earliest_delivery: string;
  }>(
    `SELECT
       a.id          AS alert_id,
       a.code,
       a.entity,
       a.first_seen_at,
       MIN(ad.created_at) AS earliest_delivery
     FROM alert a
     JOIN alert_delivery ad ON ad.alert_id = a.id
     WHERE a.status IN ('open', 'acknowledged')
       AND ad.escalation_level = 1
       AND ad.status = 'sent'
       AND ad.acknowledged_at IS NULL
     GROUP BY a.id, a.code, a.entity, a.first_seen_at
     ORDER BY a.id`,
  );

  const results: EscalationResult[] = [];
  const now = new Date();

  for (const row of l1Rows) {
    const severity = await getSeverityForCode(row.code);
    const cfg = await getEscalationConfig(1);
    const windowDays = severity.isSevere ? cfg.windowDaysSevere : cfg.windowDaysDigest;
    const windowMs = windowDays * 86_400_000;

    const deliveryAge = now.getTime() - new Date(row.earliest_delivery).getTime();
    if (deliveryAge < windowMs) continue;

    const daysSinceRaised = Math.floor(
      (now.getTime() - new Date(row.first_seen_at).getTime()) / 86_400_000,
    );

    // Determine target level — skip empty levels
    const l2Count = await countRecipientsAtLevel(2);
    const targetLevel = l2Count > 0 ? 2 : 3;
    const skippedEmptyLevel = l2Count === 0;

    // Check if already escalated to the target level
    const fired = await alreadyFired(row.alert_id, targetLevel);
    if (fired && !dryRun) {
      results.push({
        alertId: row.alert_id,
        code: row.code,
        entity: row.entity,
        fromLevel: 1,
        toLevel: targetLevel,
        daysSinceRaised,
        escalationWindowDays: windowDays,
        skippedEmptyLevel,
        alreadyEscalated: true,
        deliveriesWritten: 0,
      });
      continue;
    }

    let deliveriesWritten = 0;

    // If L2 is empty, write a skip row documenting the bypass
    if (skippedEmptyLevel) {
      const skipBody = `ESCALATION NOTE — Level 2 bypassed\nAlert: ${row.code} — ${row.entity}\nReason: no level-2 recipient configured\nPassing directly to Level 3 after ${daysSinceRaised} days open.`;
      await insertDelivery({
        alertId: row.alert_id,
        recipientId: null,
        channel: "in_app",
        escalationLevel: 2,
        triggerType: "escalation",
        status: "skipped",
        skipReason: "no level-2 recipient configured — escalating to level 3",
        messageBody: skipBody,
        sentAt: null,
      });
      logger.info(
        { alertId: row.alert_id, code: row.code, daysSinceRaised },
        "[alertRouting] L2 empty — skip row written, escalating to L3",
      );
    }

    // Notify target level
    const deliveries = await notifyAlert(row.alert_id, {
      dryRun,
      triggerType: "escalation",
      targetLevel,
      daysSinceRaised,
    });
    deliveriesWritten = deliveries.length;

    logger.info(
      {
        alertId: row.alert_id,
        code: row.code,
        entity: row.entity,
        fromLevel: 1,
        toLevel: targetLevel,
        skippedEmptyLevel,
        daysSinceRaised,
        deliveriesWritten,
        dryRun,
      },
      "[alertRouting] escalation fired",
    );

    results.push({
      alertId: row.alert_id,
      code: row.code,
      entity: row.entity,
      fromLevel: 1,
      toLevel: targetLevel,
      daysSinceRaised,
      escalationWindowDays: windowDays,
      skippedEmptyLevel,
      alreadyEscalated: false,
      deliveriesWritten,
      skipReason: skippedEmptyLevel
        ? "no level-2 recipient configured — escalating to level 3"
        : undefined,
    });
  }

  // ── Step 2: L2 → L3 ─────────────────────────────────────────
  // Only relevant when L2 actually has recipients and deliveries.

  const { rows: l2Rows } = await pool.query<{
    alert_id: number;
    code: string;
    entity: string;
    first_seen_at: string;
    earliest_delivery: string;
  }>(
    `SELECT
       a.id          AS alert_id,
       a.code,
       a.entity,
       a.first_seen_at,
       MIN(ad.created_at) AS earliest_delivery
     FROM alert a
     JOIN alert_delivery ad ON ad.alert_id = a.id
     WHERE a.status IN ('open', 'acknowledged')
       AND ad.escalation_level = 2
       AND ad.status = 'sent'
       AND ad.acknowledged_at IS NULL
       AND ad.trigger_type = 'escalation'
     GROUP BY a.id, a.code, a.entity, a.first_seen_at
     ORDER BY a.id`,
  );

  for (const row of l2Rows) {
    const severity = await getSeverityForCode(row.code);
    const cfg = await getEscalationConfig(2);
    const windowDays = severity.isSevere ? cfg.windowDaysSevere : cfg.windowDaysDigest;
    const windowMs = windowDays * 86_400_000;

    const deliveryAge = now.getTime() - new Date(row.earliest_delivery).getTime();
    if (deliveryAge < windowMs) continue;

    const daysSinceRaised = Math.floor(
      (now.getTime() - new Date(row.first_seen_at).getTime()) / 86_400_000,
    );

    const fired = await alreadyFired(row.alert_id, 3);
    if (fired && !dryRun) {
      results.push({
        alertId: row.alert_id,
        code: row.code,
        entity: row.entity,
        fromLevel: 2,
        toLevel: 3,
        daysSinceRaised,
        escalationWindowDays: windowDays,
        skippedEmptyLevel: false,
        alreadyEscalated: true,
        deliveriesWritten: 0,
      });
      continue;
    }

    const deliveries = await notifyAlert(row.alert_id, {
      dryRun,
      triggerType: "escalation",
      targetLevel: 3,
      daysSinceRaised,
    });

    results.push({
      alertId: row.alert_id,
      code: row.code,
      entity: row.entity,
      fromLevel: 2,
      toLevel: 3,
      daysSinceRaised,
      escalationWindowDays: windowDays,
      skippedEmptyLevel: false,
      alreadyEscalated: false,
      deliveriesWritten: deliveries.length,
    });
  }

  return results;
}
