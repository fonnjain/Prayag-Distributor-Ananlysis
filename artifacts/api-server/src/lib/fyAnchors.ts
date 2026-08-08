/**
 * Shared fiscal-year anchor derivation — keeps guards and features from
 * silently anchoring on an outdated year.
 *
 * Pattern (originally built for the distributor-activation guard):
 *   The anchor FY is the newest calendar-closed FY whose ingest looks complete
 *   (≥ minRows rows across all 12 fiscal months). When a new FY closes, callers
 *   keep anchoring on the prior FY during a grace window
 *   (GRACE_DAYS_AFTER_FY_CLOSE) while the new FY's data finishes ingesting;
 *   once the grace window passes, derivation FAILS LOUDLY until the
 *   newly-closed FY is fully ingested — so an anchor can never silently stay
 *   pinned to old data.
 *
 * Async helpers here derive anchors from live sale_line_current ingest stats
 * (cached ~1 h). Pure helpers are exported for unit tests and for callers that
 * bring their own stats (e.g. the activation guard reads secondary_sku_line).
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// After an FY closes (March 31), nightly ingests may take a while to finish
// loading its final months. Within this window callers may tolerate anchoring
// on the prior FY; after it, a missing/partial newest-closed FY is a failure.
export const GRACE_DAYS_AFTER_FY_CLOSE = 90;

// Full-ingest row floor for sale_line_current: every closed FY has ≥137 000
// rows; ≥10 000 across 12 months gives a large buffer against partial ingests
// while still catching a wipe.
export const SALE_LINE_MIN_FULL_INGEST_ROWS = 10_000;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** "2025-26" for a start year of 2025. */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** Fiscal-year start year for a date (fiscal year runs April–March). */
export function fyStartYear(now: Date): number {
  return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

/** The currently open FY label, purely calendar-derived. */
export function currentOpenFy(now: Date = new Date(Date.now())): string {
  return fyLabel(fyStartYear(now));
}

/** The newest FY that is calendar-closed (its March 31 end has passed). */
export function newestClosedFy(now: Date): string {
  return fyLabel(fyStartYear(now) - 1);
}

/** Prior FY label: "2025-26" → "2024-25". */
export function priorFy(fy: string): string {
  return fyLabel(parseInt(fy.slice(0, 4), 10) - 1);
}

/** End instant of an FY's grace window: March 31 of end year + grace days. */
export function fyGraceDeadline(fy: string): Date {
  const startYear = parseInt(fy.slice(0, 4), 10);
  const end = Date.UTC(startYear + 1, 2, 31); // March 31
  return new Date(end + GRACE_DAYS_AFTER_FY_CLOSE * 24 * 3600 * 1000);
}

/** Month labels "Apr-25" … "Mar-26" for fy "2025-26". */
export function fyMonthLabels(fy: string): string[] {
  const startYear = parseInt(fy.slice(0, 4), 10);
  const names = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
  return names.map((name, i) => {
    const year = i < 9 ? startYear : startYear + 1;
    return `${name}-${String(year % 100).padStart(2, "0")}`;
  });
}

export type FyIngestStats = { fy: string; rows: number; months: number };

export type DeriveGuardFyOpts = {
  /** Row floor for a "complete" FY ingest. */
  minRows: number;
  /** Name of the source table, used in failure messages. */
  sourceLabel: string;
};

/**
 * Pick the anchor FY from per-FY ingest stats.
 * Walks back from the newest calendar-closed FY to the first FY whose ingest
 * looks complete. Throws (fails the caller loudly) if the newest closed FY is
 * still not fully ingested after its grace window — that is exactly the
 * "anchor silently pinned to old data" condition this module must catch.
 */
export function deriveGuardFy(
  stats: FyIngestStats[],
  now: Date,
  opts: DeriveGuardFyOpts,
): string {
  const byFy = new Map(stats.map((s) => [s.fy, s]));
  const isComplete = (fy: string) => {
    const s = byFy.get(fy);
    return s != null && s.rows >= opts.minRows && s.months >= 12;
  };
  let fy = newestClosedFy(now);
  for (let hops = 0; hops < 10; hops++, fy = priorFy(fy)) {
    if (isComplete(fy)) return fy;
    if (now.getTime() > fyGraceDeadline(fy).getTime() && hops === 0) {
      const s = byFy.get(fy);
      throw new Error(
        `FY anchor stale: FY ${fy} closed more than ${GRACE_DAYS_AFTER_FY_CLOSE} days ago but its ` +
        `${opts.sourceLabel} ingest is incomplete (rows=${s?.rows ?? 0}, months=${s?.months ?? 0}; ` +
        `need ≥${opts.minRows} rows across 12 months). Finish ingesting FY ${fy} — ` +
        `refusing to keep anchoring on an older FY.`,
      );
    }
  }
  throw new Error(`FY anchor: no fully-ingested closed FY found in ${opts.sourceLabel}`);
}

/**
 * All fully-ingested calendar-closed FYs, ascending (e.g. ["2023-24","2024-25","2025-26"]).
 * Applies the same grace-window loud failure for the newest closed FY via
 * deriveGuardFy, so the list can never silently omit a long-closed year.
 */
export function deriveClosedFys(
  stats: FyIngestStats[],
  now: Date,
  opts: DeriveGuardFyOpts,
): string[] {
  const newest = deriveGuardFy(stats, now, opts); // throws when stale
  const byFy = new Map(stats.map((s) => [s.fy, s]));
  const out: string[] = [];
  let fy = newest;
  for (let hops = 0; hops < 10; hops++, fy = priorFy(fy)) {
    const s = byFy.get(fy);
    if (s != null && s.rows >= opts.minRows && s.months >= 12) out.unshift(fy);
  }
  return out;
}

// ── Live derivation from sale_line_current (cached) ───────────────────────────

const STATS_TTL_MS = 60 * 60 * 1000;
let _statsCache: { ts: number; stats: FyIngestStats[] } | null = null;

/** Per-FY ingest stats from sale_line_current (1 h cache). */
export async function getSaleLineFyStats(): Promise<FyIngestStats[]> {
  if (_statsCache && Date.now() - _statsCache.ts < STATS_TTL_MS) return _statsCache.stats;
  const res = await db.execute<{ fy: string; rows: string; months: string }>(sql`
    SELECT fy,
           COUNT(*)::text                    AS rows,
           COUNT(DISTINCT month_label)::text AS months
    FROM sale_line_current
    GROUP BY fy
  `);
  const stats: FyIngestStats[] = res.rows.map((r) => ({
    fy: String(r.fy),
    rows: parseInt(String(r.rows), 10) || 0,
    months: parseInt(String(r.months), 10) || 0,
  }));
  _statsCache = { ts: Date.now(), stats };
  return stats;
}

const SALE_LINE_OPTS: DeriveGuardFyOpts = {
  minRows: SALE_LINE_MIN_FULL_INGEST_ROWS,
  sourceLabel: "sale_line_current",
};

/**
 * Newest fully-ingested closed FY in sale_line_current — the "last complete FY"
 * anchor (peer cohorts, baselines). Fails loudly per the grace-window rule.
 */
export async function deriveSaleLineCohortFy(): Promise<string> {
  return deriveGuardFy(await getSaleLineFyStats(), new Date(Date.now()), SALE_LINE_OPTS);
}

/**
 * All fully-ingested closed FYs in sale_line_current, ascending.
 * Fails loudly per the grace-window rule.
 */
export async function deriveSaleLineClosedFys(): Promise<string[]> {
  return deriveClosedFys(await getSaleLineFyStats(), new Date(Date.now()), SALE_LINE_OPTS);
}
