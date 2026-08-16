/**
 * Weekly digest builder.
 *
 * The digest is generated purely from stored alerts — never recomputed — so
 * counts are guaranteed to match the Alerts page exactly.
 */
import { pool } from "@workspace/db";
import { matchesPattern } from "./patterns.js";
import { matchesScope } from "./scope.js";
import { dispatch } from "./channels.js";
import { renderDigestBody } from "./render.js";
import { logger } from "../logger.js";
import type { AlertRow, Recipient, DeliveryRow } from "./types.js";
import { getActiveRecipients } from "./notify.js";

// ─── helpers ────────────────────────────────────────────────

async function getAlertsByFy(fy: string): Promise<AlertRow[]> {
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
     FROM alert WHERE fy = $1 ORDER BY rupees_at_stake DESC`,
    [fy],
  );
  return rows.map((r) => ({
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
  }));
}

async function getRecipient(recipientId: number): Promise<Recipient | null> {
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
     FROM alert_recipient WHERE id = $1 LIMIT 1`,
    [recipientId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
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
  };
}

async function getLastDigestAt(recipientId: number): Promise<Date | null> {
  const { rows } = await pool.query<{ sent_at: string | null }>(
    `SELECT MAX(sent_at) AS sent_at
     FROM alert_delivery
     WHERE recipient_id = $1 AND trigger_type = 'weekly_digest' AND status = 'sent'`,
    [recipientId],
  );
  return rows[0]?.sent_at ? new Date(rows[0].sent_at) : null;
}

// ─── exported types ──────────────────────────────────────────

export type DigestResult = {
  recipientId: number;
  recipientName: string;
  skipped: boolean;
  skipReason?: string;
  messageBody: string | null;
  deliveryRows: DeliveryRow[];
  counts: {
    newAlerts: number;
    stillOpen: number;
    cleared: number;
    escalating: number;
    total: number;
  };
};

// ─── public API ──────────────────────────────────────────────

/**
 * Build and dispatch the weekly digest for a single recipient.
 *
 * If the recipient has no relevant alerts in the FY, the digest is skipped
 * and no delivery row is written.
 *
 * For level-2 recipients, the "ESCALATING TO YOU" section includes any open
 * alert that has a level-1 delivery which has not been acknowledged within
 * the escalation window (default 7 days for severe, 14 days for others).
 */
export async function buildDigest(
  recipientId: number,
  opts: { dryRun?: boolean; fy?: string } = {},
): Promise<DigestResult> {
  const { dryRun = true, fy = "2026-27" } = opts;

  const recipient = await getRecipient(recipientId);
  if (!recipient) throw new Error(`Recipient ${recipientId} not found`);

  const allAlerts = await getAlertsByFy(fy);
  const lastDigestAt = await getLastDigestAt(recipientId);

  // Filter to alerts this recipient cares about (pattern + scope).
  const relevant: AlertRow[] = [];
  for (const alert of allAlerts) {
    if (!matchesPattern(alert.code, recipient.alertCodePattern)) continue;
    if (!(await matchesScope(alert, recipient))) continue;
    relevant.push(alert);
  }

  if (relevant.length === 0) {
    logger.info(
      { recipientId, recipientName: recipient.name },
      "[alertRouting] digest: no relevant alerts — skipping",
    );
    return {
      recipientId,
      recipientName: recipient.name,
      skipped: true,
      skipReason: "no relevant alerts for this recipient",
      messageBody: null,
      deliveryRows: [],
      counts: { newAlerts: 0, stillOpen: 0, cleared: 0, escalating: 0, total: 0 },
    };
  }

  const now = new Date();

  const open = relevant.filter(
    (a) => a.status === "open" || a.status === "acknowledged",
  );
  const newAlerts = open.filter(
    (a) =>
      lastDigestAt == null || new Date(a.firstSeenAt) > lastDigestAt,
  );
  const stillOpen = open.filter(
    (a) =>
      lastDigestAt != null && new Date(a.firstSeenAt) <= lastDigestAt,
  );
  const cleared = relevant.filter(
    (a) =>
      a.status === "cleared" &&
      (lastDigestAt == null || new Date(a.lastSeenAt) > lastDigestAt),
  );

  // Escalating section: level-2 recipients get alerts whose level-1 delivery
  // has not been acknowledged past the default escalation window (7 days).
  const escalating: Array<{ alert: AlertRow; daysSinceRaised: number }> = [];
  if (recipient.escalationLevel === 2) {
    const { rows: unacked } = await pool.query<{ alert_id: number }>(
      `SELECT DISTINCT ad.alert_id
       FROM alert_delivery ad
       WHERE ad.escalation_level = 1
         AND ad.status = 'sent'
         AND ad.acknowledged_at IS NULL
         AND ad.created_at < NOW() - INTERVAL '7 days'`,
    );
    const unackedIds = new Set(unacked.map((r) => r.alert_id));
    for (const alert of relevant) {
      if (!unackedIds.has(alert.id)) continue;
      const daysSinceRaised = Math.floor(
        (now.getTime() - new Date(alert.firstSeenAt).getTime()) / 86_400_000,
      );
      escalating.push({ alert, daysSinceRaised });
    }
  }

  const scope =
    recipient.scopeType === "state_head" && recipient.scopeValue
      ? `${recipient.scopeValue}'s territory`
      : "all territories";

  const body = renderDigestBody(recipient.name, scope, {
    newAlerts,
    stillOpen,
    cleared,
    escalating,
  });

  const channelResult = await dispatch(
    recipient.channel,
    recipient.contact,
    body,
    dryRun,
  );

  const deliveryRows: DeliveryRow[] = [];
  const sentAt =
    channelResult.status === "sent" ? now.toISOString() : null;

  for (const alert of relevant) {
    const { rows: inserted } = await pool.query<{
      id: number;
      created_at: string;
    }>(
      `INSERT INTO alert_delivery
         (alert_id, recipient_id, channel, escalation_level, trigger_type,
          sent_at, status, skip_reason, message_body)
       VALUES ($1,$2,$3,$4,'weekly_digest',$5,$6,$7,$8)
       RETURNING id, created_at`,
      [
        alert.id,
        recipientId,
        recipient.channel,
        recipient.escalationLevel,
        sentAt,
        channelResult.status,
        channelResult.skipReason,
        body,
      ],
    );
    deliveryRows.push({
      id: inserted[0].id,
      alertId: alert.id,
      recipientId,
      recipientName: recipient.name,
      channel: recipient.channel,
      escalationLevel: recipient.escalationLevel,
      triggerType: "weekly_digest",
      status: channelResult.status as DeliveryRow["status"],
      skipReason: channelResult.skipReason,
      messageBody: body,
      sentAt,
      createdAt: inserted[0].created_at,
    });
  }

  logger.info(
    {
      recipientId,
      recipientName: recipient.name,
      counts: {
        new: newAlerts.length,
        stillOpen: stillOpen.length,
        cleared: cleared.length,
        escalating: escalating.length,
      },
      dryRun,
    },
    "[alertRouting] digest built",
  );

  return {
    recipientId,
    recipientName: recipient.name,
    skipped: false,
    messageBody: body,
    deliveryRows,
    counts: {
      newAlerts: newAlerts.length,
      stillOpen: stillOpen.length,
      cleared: cleared.length,
      escalating: escalating.length,
      total: relevant.length,
    },
  };
}

/**
 * Run weekly digest for every active recipient with cadence='weekly'.
 */
export async function runDigestAll(opts: {
  dryRun?: boolean;
  fy?: string;
}): Promise<DigestResult[]> {
  const recipients = await getActiveRecipients();
  const weekly = recipients.filter((r) => r.cadence === "weekly");
  const results: DigestResult[] = [];
  for (const r of weekly) {
    const result = await buildDigest(r.id, opts);
    results.push(result);
  }
  return results;
}
