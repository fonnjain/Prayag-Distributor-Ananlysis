/**
 * Escalation runner.
 *
 * Finds open alerts with level-1 deliveries that have not been acknowledged
 * within the escalation window, then fires level-2 notifications.
 *
 * Level 1 still holds the alert — their existing delivery row is unchanged.
 * The function records a new alert_delivery row with escalation_level=2.
 */
import { pool } from "@workspace/db";
import { getSeverityForCode } from "./severity.js";
import { notifyAlert } from "./notify.js";
import { logger } from "../logger.js";

export type EscalationResult = {
  alertId: number;
  code: string;
  entity: string;
  daysSinceRaised: number;
  escalationWindowDays: number;
  alreadyEscalated: boolean;
  deliveriesWritten: number;
};

/**
 * Check all open alerts for overdue level-1 acknowledgements and fire
 * level-2 notifications where appropriate.
 *
 * @param opts.dryRun  When true, delivery rows are written but no messages
 *                     are transmitted (identical to notifyAlert dry-run).
 */
export async function runEscalation(
  opts: { dryRun?: boolean } = {},
): Promise<EscalationResult[]> {
  const { dryRun = true } = opts;

  // Find open alerts that have a level-1 delivery that is:
  //   • status = 'sent'          (was actually delivered, not pending/failed)
  //   • acknowledged_at IS NULL  (level 1 has not yet acknowledged it)
  // We join with the alert table to get the code (for severity lookup).
  const { rows } = await pool.query<{
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

  for (const row of rows) {
    const severity = await getSeverityForCode(row.code);
    const windowMs = severity.escalationWindowDays * 86_400_000;

    // Measure from when level-1 first received the alert (earliest delivery).
    const deliveryAge =
      now.getTime() - new Date(row.earliest_delivery).getTime();

    if (deliveryAge < windowMs) continue; // window not yet expired

    const daysSinceRaised = Math.floor(
      (now.getTime() - new Date(row.first_seen_at).getTime()) / 86_400_000,
    );

    // Check if level-2 escalation already fired.
    const { rows: existingEscalation } = await pool.query(
      `SELECT id FROM alert_delivery
       WHERE alert_id = $1 AND escalation_level = 2 AND trigger_type = 'escalation'`,
      [row.alert_id],
    );
    const alreadyEscalated = existingEscalation.length > 0 && !dryRun;

    let deliveriesWritten = 0;
    if (!alreadyEscalated) {
      const deliveries = await notifyAlert(row.alert_id, {
        dryRun,
        triggerType: "escalation",
        daysSinceRaised,
      });
      deliveriesWritten = deliveries.length;
      logger.info(
        {
          alertId: row.alert_id,
          code: row.code,
          entity: row.entity,
          daysSinceRaised,
          deliveriesWritten,
          dryRun,
        },
        "[alertRouting] escalation fired",
      );
    } else {
      logger.info(
        { alertId: row.alert_id, code: row.code },
        "[alertRouting] escalation already fired — skipping",
      );
    }

    results.push({
      alertId: row.alert_id,
      code: row.code,
      entity: row.entity,
      daysSinceRaised,
      escalationWindowDays: severity.escalationWindowDays,
      alreadyEscalated,
      deliveriesWritten,
    });
  }

  return results;
}
