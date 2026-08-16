/**
 * Weekly alert digest scheduler.
 *
 * Algorithm:
 *   – Polls every 15 minutes.
 *   – Fires when: UTC day = Monday AND UTC hour 02:00–04:00 (= IST 07:30–09:30)
 *     AND the last successful digest was > 24 hours ago (dedup guard).
 *   – Persists last_digest_at in the alert_scheduler singleton row so the
 *     guard survives server restarts.
 *
 * Exports:
 *   startWeeklyDigestScheduler(fy)  — call once at server startup
 *   runWeeklyDigestNow(opts)         — exposed for the admin manual-trigger route
 *   getSchedulerStatus()             — last run + next expected window
 */

import { pool } from "@workspace/db";
import { runDigestAll } from "./digest.js";
import { logger } from "../logger.js";
import type { DigestResult } from "./digest.js";

// ── State ─────────────────────────────────────────────────────────────────

let schedulerFy = "2026-27";
let digestInFlight = false;
let lastRunAt: Date | null = null; // in-memory mirror; source of truth is DB

// ── DB helpers ────────────────────────────────────────────────────────────

async function readLastDigestAt(): Promise<Date | null> {
  try {
    const { rows } = await pool.query<{ last_digest_at: string | null }>(
      "SELECT last_digest_at FROM alert_scheduler WHERE id=1 LIMIT 1",
    );
    return rows[0]?.last_digest_at ? new Date(rows[0].last_digest_at) : null;
  } catch {
    return null;
  }
}

async function writeLastDigestAt(): Promise<void> {
  await pool.query(
    `UPDATE alert_scheduler SET last_digest_at=now(), updated_at=now() WHERE id=1`,
  );
  lastRunAt = new Date();
}

// ── Next expected window (for status endpoint) ────────────────────────────

function nextMondayWindow(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun … 6=Sat
  const daysAhead = day === 0 ? 1 : day === 1 ? 7 : 8 - day;
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysAhead);
  next.setUTCHours(2, 30, 0, 0); // 02:30 UTC = 08:00 IST
  return next.toISOString();
}

// ── Core run function ─────────────────────────────────────────────────────

export async function runWeeklyDigestNow(opts: {
  dryRun?: boolean;
  fy?: string;
  force?: boolean; // bypass dedup guard — for manual admin triggers
}): Promise<{
  results: DigestResult[];
  totalSent: number;
  totalSkipped: number;
  fy: string;
  dryRun: boolean;
}> {
  const { dryRun = false, force = false } = opts;
  const fy = opts.fy ?? schedulerFy;

  if (digestInFlight) {
    throw new Error("Digest already in progress — wait for it to complete or poll again");
  }
  digestInFlight = true;

  try {
    logger.info({ fy, dryRun, force }, "[alertScheduler] weekly digest: starting");

    const results = await runDigestAll({ dryRun, fy });

    const totalSent = results.filter((r) => !r.skipped).length;
    const totalSkipped = results.filter((r) => r.skipped).length;

    if (!dryRun) {
      await writeLastDigestAt();
    }

    logger.info(
      { totalSent, totalSkipped, fy, dryRun },
      "[alertScheduler] weekly digest: complete",
    );

    return { results, totalSent, totalSkipped, fy, dryRun };
  } catch (err) {
    logger.error({ err }, "[alertScheduler] weekly digest: failed");
    throw err;
  } finally {
    digestInFlight = false;
  }
}

// ── Status ────────────────────────────────────────────────────────────────

export async function getSchedulerStatus(): Promise<{
  inFlight: boolean;
  lastDigestAt: string | null;
  nextWindowUTC: string;
  schedulerFy: string;
}> {
  const dbLast = await readLastDigestAt();
  const last = dbLast ?? lastRunAt;
  return {
    inFlight: digestInFlight,
    lastDigestAt: last?.toISOString() ?? null,
    nextWindowUTC: nextMondayWindow(),
    schedulerFy,
  };
}

// ── Scheduler ─────────────────────────────────────────────────────────────

export function startWeeklyDigestScheduler(fy: string): void {
  schedulerFy = fy;

  // Restore last run from DB into module memory on startup
  void readLastDigestAt().then((d) => {
    lastRunAt = d;
  });

  const POLL_MS = 15 * 60_000; // every 15 minutes

  setInterval(async () => {
    const now = new Date();

    // Only fire on Monday (UTC day 1), between 02:00 and 04:00 UTC
    // (= 07:30 – 09:30 IST).
    if (now.getUTCDay() !== 1) return;
    const h = now.getUTCHours();
    if (h < 2 || h >= 4) return;

    // Dedup: skip if we already ran within the last 24 hours.
    const lastDb = await readLastDigestAt();
    const last = lastDb ?? lastRunAt;
    const hoursAgo = last
      ? (now.getTime() - last.getTime()) / 3_600_000
      : Infinity;
    if (hoursAgo < 24) return;

    logger.info(
      { fy, lastDigestAt: last?.toISOString() ?? null },
      "[alertScheduler] weekly digest window detected — running",
    );

    try {
      await runWeeklyDigestNow({ dryRun: false, fy, force: true });
    } catch (err) {
      logger.error({ err }, "[alertScheduler] scheduled digest failed — will retry next poll");
    }
  }, POLL_MS).unref();

  logger.info(
    { fy, pollIntervalMin: 15 },
    "[alertScheduler] weekly digest scheduler started — fires Monday 07:30–09:30 IST",
  );
}
