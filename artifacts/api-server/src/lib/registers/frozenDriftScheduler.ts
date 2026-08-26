import { currentOpenFy } from "../fyAnchors.js";
import { logger } from "../logger.js";
import { detectFrozenDrift } from "./frozenDrift.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export async function runWeeklyFrozenDriftDetector(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const checks = await detectFrozenDrift(currentOpenFy());
    logger.info(
      { fy: currentOpenFy(), checked: checks.length, drift: checks.filter((c) => c.status === "drift").length },
      "weekly frozen drift detector completed",
    );
  } catch (err) {
    logger.error({ err }, "weekly frozen drift detector failed");
  } finally {
    inFlight = false;
  }
}

/** Production caller owns the environment gate; this function is idempotent. */
export function startWeeklyFrozenDriftScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void runWeeklyFrozenDriftDetector(), WEEK_MS);
  timer.unref();
  // Run once after startup rather than leaving an unbounded seven-day blind spot.
  setTimeout(() => void runWeeklyFrozenDriftDetector(), 15 * 60_000).unref();
  logger.info({ intervalDays: 7 }, "weekly frozen drift scheduler enabled");
}