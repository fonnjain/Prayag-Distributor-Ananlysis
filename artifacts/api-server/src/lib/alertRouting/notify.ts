import { pool } from "@workspace/db";
import { matchesPattern } from "./patterns.js";
import { matchesScope } from "./scope.js";
import { dispatch } from "./channels.js";
import { renderOnRaiseBody, renderEscalationBody } from "./render.js";
import { logger } from "../logger.js";
import type { AlertRow, Recipient, DeliveryRow } from "./types.js";

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────

export async function getAlertById(alertId: number): Promise<AlertRow | null> {
  const { rows } = await pool.query<{
    id: number;
    code: string;
    entity: string;
    entity_key: string;
    entity_type: string;
    period_label: string;
    status: string;
    periods_open: number;
    rupees_at_stake: string;
    first_seen_at: string;
    last_seen_at: string;
    fy: string;
    detail: Record<string, unknown>;
  }>(
    `SELECT id, code, entity, entity_key, entity_type, period_label, status,
            periods_open, rupees_at_stake, first_seen_at, last_seen_at, fy, detail
     FROM alert WHERE id = $1`,
    [alertId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    code: r.code,
    entity: r.entity,
    entityKey: r.entity_key,
    entityType: r.entity_type,
    periodLabel: r.period_label,
    status: r.status as AlertRow["status"],
    periodsOpen: Number(r.periods_open),
    rupeesAtStake: Number(r.rupees_at_stake),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    fy: r.fy,
    detail: r.detail ?? {},
  };
}

export async function getActiveRecipients(): Promise<Recipient[]> {
  const { rows } = await pool.query<{
    id: number;
    alert_code_pattern: string;
    scope_type: string;
    scope_value: string | null;
    escalation_level: number;
    name: string;
    channel: string;
    contact: string | null;
    cadence: string;
    is_active: boolean;
  }>(
    `SELECT id, alert_code_pattern, scope_type, scope_value, escalation_level,
            name, channel, contact, cadence, is_active
     FROM alert_recipient WHERE is_active = TRUE ORDER BY escalation_level, id`,
  );
  return rows.map((r) => ({
    id: r.id,
    alertCodePattern: r.alert_code_pattern,
    scopeType: r.scope_type as Recipient["scopeType"],
    scopeValue: r.scope_value,
    escalationLevel: r.escalation_level as 1 | 2,
    name: r.name,
    channel: r.channel as Recipient["channel"],
    contact: r.contact,
    cadence: r.cadence as Recipient["cadence"],
    isActive: r.is_active,
  }));
}

async function insertDelivery(params: {
  alertId: number;
  recipientId: number;
  channel: string;
  escalationLevel: number;
  triggerType: string;
  status: string;
  skipReason: string | null;
  messageBody: string;
  sentAt: string | null;
}): Promise<{ id: number; created_at: string }> {
  const { rows } = await pool.query<{ id: number; created_at: string }>(
    `INSERT INTO alert_delivery
       (alert_id, recipient_id, channel, escalation_level, trigger_type,
        sent_at, status, skip_reason, message_body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, created_at`,
    [
      params.alertId,
      params.recipientId,
      params.channel,
      params.escalationLevel,
      params.triggerType,
      params.sentAt,
      params.status,
      params.skipReason,
      params.messageBody,
    ],
  );
  return rows[0];
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Fire notifications for a given alert.
 *
 * trigger_type='on_raise'   → level-1 recipients with cadence='on_raise' only.
 * trigger_type='escalation' → level-2 recipients only, for unacknowledged alerts.
 *
 * In dry_run mode delivery rows are written but no messages are transmitted.
 * Idempotent in production (skips if a delivery row already exists for this
 * alert + recipient + trigger combination).
 */
export async function notifyAlert(
  alertId: number,
  opts: {
    dryRun?: boolean;
    triggerType?: "on_raise" | "escalation";
    /** If provided, only this recipient receives it (used internally by escalation). */
    recipientId?: number;
    /** Days since raised, injected for escalation message body. */
    daysSinceRaised?: number;
  } = {},
): Promise<DeliveryRow[]> {
  const {
    dryRun = true,
    triggerType = "on_raise",
    recipientId,
    daysSinceRaised,
  } = opts;

  const alert = await getAlertById(alertId);
  if (!alert) throw new Error(`Alert ${alertId} not found`);

  const allRecipients = await getActiveRecipients();
  const candidates = recipientId
    ? allRecipients.filter((r) => r.id === recipientId)
    : allRecipients;

  const results: DeliveryRow[] = [];
  const now = new Date().toISOString();

  for (const recipient of candidates) {
    // Level filter: on_raise → level 1 only; escalation → level 2 only.
    if (triggerType === "on_raise" && recipient.escalationLevel !== 1) continue;
    if (triggerType === "escalation" && recipient.escalationLevel !== 2) continue;

    // Cadence filter: on_raise trigger only reaches recipients with cadence='on_raise'.
    if (triggerType === "on_raise" && recipient.cadence !== "on_raise") continue;

    // Pattern match.
    if (!matchesPattern(alert.code, recipient.alertCodePattern)) continue;

    // Scope match.
    const inScope = await matchesScope(alert, recipient);
    if (!inScope) continue;

    // Idempotency guard (skip in dry-run so verifications can repeat).
    if (!dryRun) {
      const { rows: existing } = await pool.query(
        `SELECT id FROM alert_delivery
         WHERE alert_id=$1 AND recipient_id=$2 AND trigger_type=$3`,
        [alertId, recipient.id, triggerType],
      );
      if (existing.length > 0) continue;
    }

    // Build message body.
    const body =
      triggerType === "escalation" && daysSinceRaised != null
        ? renderEscalationBody(alert, recipient.name, daysSinceRaised)
        : renderOnRaiseBody(alert, recipient.name);

    const channelResult = await dispatch(
      recipient.channel,
      recipient.contact,
      body,
      dryRun,
    );

    const row = await insertDelivery({
      alertId,
      recipientId: recipient.id,
      channel: recipient.channel,
      escalationLevel: recipient.escalationLevel,
      triggerType,
      status: channelResult.status,
      skipReason: channelResult.skipReason,
      messageBody: body,
      sentAt: channelResult.status === "sent" ? now : null,
    });

    const delivery: DeliveryRow = {
      id: row.id,
      alertId,
      recipientId: recipient.id,
      recipientName: recipient.name,
      channel: recipient.channel,
      escalationLevel: recipient.escalationLevel,
      triggerType,
      status: channelResult.status as DeliveryRow["status"],
      skipReason: channelResult.skipReason,
      messageBody: body,
      sentAt: channelResult.status === "sent" ? now : null,
      createdAt: row.created_at,
    };

    results.push(delivery);

    logger.info(
      {
        alertId,
        recipientId: recipient.id,
        recipientName: recipient.name,
        channel: recipient.channel,
        escalationLevel: recipient.escalationLevel,
        triggerType,
        status: channelResult.status,
        dryRun,
      },
      "[alertRouting] delivery recorded",
    );
  }

  return results;
}
