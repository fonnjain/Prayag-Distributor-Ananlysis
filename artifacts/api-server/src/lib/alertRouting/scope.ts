import { pool } from "@workspace/db";
import type { AlertRow, Recipient } from "./types.js";

/**
 * Determine whether an alert falls within a recipient's scope.
 *
 * scope_type='all_india'  — always matches (Deepak J, CEO).
 * scope_type='state_head' — for person-type alerts, matches when the entity's
 *                           state head (from person_registry) equals scope_value.
 *                           For non-person entities, checks alert detail for a
 *                           stateHead field; falls back to no-match (safe default
 *                           — avoids notifying irrelevant state heads).
 */
export async function matchesScope(
  alert: AlertRow,
  recipient: Recipient,
): Promise<boolean> {
  if (recipient.scopeType === "all_india") return true;
  if (recipient.scopeValue == null) return false;

  if (alert.entityType === "person" || alert.entityType === "member") {
    const { rows } = await pool.query<{ state_head: string | null }>(
      `SELECT state_head FROM person_registry WHERE norm_key = $1 LIMIT 1`,
      [alert.entityKey],
    );
    return (rows[0]?.state_head ?? null) === recipient.scopeValue;
  }

  // Non-person entity: check if alert detail carries a stateHead reference.
  const detail = alert.detail as Record<string, unknown>;
  const extra = (detail.extraForReport ?? {}) as Record<string, unknown>;
  const detailHead =
    ((extra.stateHead ?? detail.stateHead) as string | undefined) ?? null;
  if (detailHead) return detailHead === recipient.scopeValue;

  // No state head info available — do not match (avoids noise).
  return false;
}
