import { pool } from "@workspace/db";
import { openMonthLabels } from "./registers/monthlyReplace.js";

/** The calendar-controlled primary-register refresh window before persisted freezes. */
export function calendarOpenPrimaryRegisterMonths(fy: string, now = new Date()): string[] {
  return openMonthLabels(fy, now);
}

/**
 * Canonical list of primary-register months which may still be replaced.
 * The calendar window is current month plus three prior; a persisted frozen_at
 * anchor always wins over that calendar rule.
 */
export async function getEffectivelyOpenPrimaryRegisterMonths(
  fy: string,
  now = new Date(),
): Promise<string[]> {
  const calendarMonths = calendarOpenPrimaryRegisterMonths(fy, now);
  if (calendarMonths.length === 0) return [];
  const frozen = await pool.query<{ month_label: string }>(
    `SELECT month_label FROM register_month_state
      WHERE fy = $1 AND month_label = ANY($2::text[]) AND frozen_at IS NOT NULL`,
    [fy, calendarMonths],
  );
  const frozenMonths = new Set(frozen.rows.map((row) => row.month_label));
  return calendarMonths.filter((month) => !frozenMonths.has(month));
}