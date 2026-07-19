// Seven calculation rules for secondary data.
// These are pure functions — no DB access, no I/O.
// Apply these after normalization and before (or instead of) persistence.

import type { InsertSecRegLine } from "@workspace/db";
import type { SecHeadMonthRow, AnomalySummary } from "./types.js";

// ── Rule 1: achievement_recomputed ────────────────────────────────────────────
//
// Achievement = Sales Received / Plan.
// NEVER: Orders Booked / Plan (which is what the State Head Dashboard's own
// TOTAL row uses — it is wrong).
// Returns null when plan = 0 or either value is null.
export function computeAchievement(
  receivedAmount: number | null,
  planAmount: number | null,
): number | null {
  if (receivedAmount == null || planAmount == null || planAmount === 0) return null;
  return receivedAmount / planAmount;
}

// ── Rule 2: ytd_closed_months_only ────────────────────────────────────────────
//
// YTD aggregates must include ONLY months whose last calendar day has passed.
// Open months (today < last day of that month) are excluded even if the sheet
// shows a partial figure, to avoid premature 0% achievement.
// monthIdx: 0=Apr .. 11=Mar
export function fyMonthLastDayMs(monthIdx: number, fy: string): number {
  const startYear = Number(fy.slice(0, 4));
  // Apr(0)..Dec(8) → calendar month 3..11 of startYear
  // Jan(9)..Mar(11) → calendar month 0..2 of startYear+1
  const calMonth = (monthIdx + 3) % 12;
  const calYear = monthIdx <= 8 ? startYear : startYear + 1;
  return Date.UTC(calYear, calMonth + 1, 0); // last day of that calendar month (UTC)
}

export function isMonthClosed(monthIdx: number, fy: string, nowMs = Date.now()): boolean {
  return nowMs > fyMonthLastDayMs(monthIdx, fy);
}

export function ytdSum(
  months: Array<{ monthIdx: number; receivedAmount: number | null; isAnomaly: boolean; notYetRecorded: boolean }>,
  fy: string,
  nowMs = Date.now(),
): number {
  return months
    .filter(
      (m) =>
        isMonthClosed(m.monthIdx, fy, nowMs) &&
        !m.isAnomaly &&
        !m.notYetRecorded,
    )
    .reduce((sum, m) => sum + (m.receivedAmount ?? 0), 0);
}

export function ytdPlan(
  months: Array<{ monthIdx: number; planAmount: number | null; notYetRecorded: boolean }>,
  fy: string,
  nowMs = Date.now(),
): number {
  return months
    .filter(
      (m) => isMonthClosed(m.monthIdx, fy, nowMs) && !m.notYetRecorded,
    )
    .reduce((sum, m) => sum + (m.planAmount ?? 0), 0);
}

// ── Rule 3: anomaly_flag ──────────────────────────────────────────────────────
//
// A month is anomalous when salesAmount > orderedAmount × 1.5 AND
// orderedAmount > 0. This is physically impossible (you cannot receive more
// than 1.5× what was booked) and must be a data-entry error.
// Anomalous months: show raw value, exclude from rankings and YTD achievement.
export function isAnomalous(
  salesAmount: number | null,
  orderedAmount: number | null,
): boolean {
  if (salesAmount == null || orderedAmount == null || orderedAmount <= 0) return false;
  return salesAmount > orderedAmount * 1.5;
}

export function collectAnomalies(rows: SecHeadMonthRow[]): AnomalySummary[] {
  return rows
    .filter((r) => r.isAnomaly)
    .map((r) => ({
      head: r.headCanon,
      monthLabel: r.monthLabel,
      salesAmount: r.receivedAmount ?? 0,
      orderedAmount: r.orderedAmount ?? 0,
      ratio:
        (r.orderedAmount ?? 0) > 0
          ? (r.receivedAmount ?? 0) / (r.orderedAmount ?? 1)
          : 0,
    }));
}

// ── Rule 4: territory_split ───────────────────────────────────────────────────
//
// Partition register lines into territory vs non-territory (institutional).
// Uses the is_territory flag set during normalization.
export type TerritorySplit = {
  territory: InsertSecRegLine[];
  nonTerritory: InsertSecRegLine[];
};

export function splitByTerritory(lines: InsertSecRegLine[]): TerritorySplit {
  const territory: InsertSecRegLine[] = [];
  const nonTerritory: InsertSecRegLine[] = [];
  for (const line of lines) {
    if (line.isTerritory) territory.push(line);
    else nonTerritory.push(line);
  }
  return { territory, nonTerritory };
}

// ── Rule 5: grand_total_cross_foot ────────────────────────────────────────────
//
// sum(amount) by head must equal the grand total within ±1 rupee.
// Gaps indicate rows dropped during normalization (unmapped head with no canon).
export type CrossFootResult = {
  passed: boolean;
  grandTotal: number;
  byHeadSum: number;
  deltaRupees: number;
  headCount: number;
};

export function crossFootByHead(lines: InsertSecRegLine[]): CrossFootResult {
  let grand = 0;
  const byHead = new Map<string, number>();
  for (const line of lines) {
    const amt = Number(line.amount);
    grand += amt;
    const key = line.headCanon ?? "(blank)";
    byHead.set(key, (byHead.get(key) ?? 0) + amt);
  }
  const byHeadSum = [...byHead.values()].reduce((a, b) => a + b, 0);
  const delta = Math.abs(byHeadSum - grand);
  return {
    passed: delta <= 1,
    grandTotal: Math.round(grand),
    byHeadSum: Math.round(byHeadSum),
    deltaRupees: Math.round(delta),
    headCount: byHead.size,
  };
}

// ── Rule 6: complete_months_yoy ───────────────────────────────────────────────
//
// YoY comparisons must only use months that are fully elapsed in BOTH fiscal
// years. A month is complete when its last calendar day has passed.
// Returns the indices (0=Apr..11=Mar) of months usable for YoY.
export function completeMonthsForYoY(
  fyA: string,
  fyB: string,
  nowMs = Date.now(),
): number[] {
  const complete: number[] = [];
  for (let idx = 0; idx < 12; idx++) {
    if (
      isMonthClosed(idx, fyA, nowMs) &&
      isMonthClosed(idx, fyB, nowMs)
    ) {
      complete.push(idx);
    }
  }
  return complete;
}

export function yoySum(
  monthRows: Array<{ monthIdx: number; amount: number }>,
  completeIdxSet: Set<number>,
): number {
  return monthRows
    .filter((r) => completeIdxSet.has(r.monthIdx))
    .reduce((sum, r) => sum + r.amount, 0);
}

// ── Rule 7: no_double_count_guard ─────────────────────────────────────────────
//
// Secondary and primary are separate supply-chain layers.
// Secondary ⊂ Primary: the same goods appear in both registers.
// They must NEVER be summed into a combined total.
// This rule is a labelling guard, not an arithmetic check — it attaches a
// source tag to every line so callers can verify they are not mixing layers.
// Returns an error string when lines from different layers are mixed.
export type LayerTag = "primary" | "secondary";

export function assertSingleLayer(tags: LayerTag[]): string | null {
  const set = new Set(tags);
  if (set.size > 1) {
    return `Layer mixing detected: ${[...set].join(", ")} lines present in the same dataset. Primary and secondary must never be summed together.`;
  }
  return null;
}

// Convenience: tag all secondary lines as "secondary".
export function tagSecondary(lines: InsertSecRegLine[]): LayerTag[] {
  return lines.map(() => "secondary");
}
