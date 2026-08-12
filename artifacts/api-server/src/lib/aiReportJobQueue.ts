// Async job queue for long-running AI report routes (growth + statehead).
//
// WHY THIS EXISTS
//   POST /ai/full-report/growth and /ai/full-report/statehead can take
//   120+ seconds cold.  Dev/prod proxies kill connections after ~120 s.
//   Instead of holding the HTTP connection, these routes now:
//     1. Create a job row and return 202 { jobId, status: "queued" } immediately.
//     2. Run the computation in the background (fire-and-forget promise).
//     3. When done, store the payload in route_payload_snapshot.
//   GET /ai/full-report/status/:jobId polls progress and returns the payload
//   once the job is complete.
//
// DEDUPLICATION
//   Concurrent POST requests with the same cacheKey (fy|scope|stateHead|…) are
//   coalesced: the second caller receives the same jobId as the first, with no
//   duplicate computation launched.
//
// EXPIRY
//   Jobs are valid for 24 h.  An unknown / expired jobId yields null from
//   loadJobResult() which callers map to HTTP 404.
//
// PERSISTENCE
//   - Job metadata: ai_report_job table (migration 018).
//   - Result payload: route_payload_snapshot with key "ai-job|{jobId}".
//     That table already exists and is the right shape.

import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";

/**
 * Call once at server startup.
 * Any job left in "queued" or "running" state from a previous process is
 * orphaned — the background computation died with that process.
 * Mark them "failed" so clients get a definitive answer instead of polling
 * "running" forever.
 */
export async function cleanupOrphanedJobs(): Promise<void> {
  try {
    const result = await pool.query<{ job_id: string }>(
      `UPDATE ai_report_job
       SET status = 'failed',
           completed_at = now(),
           error = 'Server restarted — computation was lost'
       WHERE status IN ('queued', 'running')
       RETURNING job_id`,
    );
    if (result.rowCount && result.rowCount > 0) {
      console.info(
        `[aiReportJobQueue] Cleaned up ${result.rowCount} orphaned job(s) left from previous process.`,
      );
    }
  } catch (err) {
    // Non-fatal: log and continue.  Clients will time out or retry.
    console.error("[aiReportJobQueue] Failed to clean up orphaned jobs:", err);
  }
}

export type JobStatus = "queued" | "running" | "complete" | "failed";

interface JobState {
  jobId: string;
  cacheKey: string;
  status: JobStatus;
  createdAt: number; // Date.now()
  error?: string;
}

// In-memory map for fast status checks within a server lifetime.
// The DB is the authoritative source; the in-memory map is a performance cache.
const jobs = new Map<string, JobState>();

// cacheKey → jobId for in-flight (not yet complete/failed) jobs.
const liveJobByCacheKey = new Map<string, string>();

const JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

function isExpired(job: JobState): boolean {
  return Date.now() - job.createdAt > JOB_TTL_MS;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return the jobId of an existing in-flight job for this cache key, or undefined.
 * "in-flight" means queued or running (not complete/failed/expired).
 */
export function findLiveJobForCacheKey(cacheKey: string): string | undefined {
  const jobId = liveJobByCacheKey.get(cacheKey);
  if (!jobId) return undefined;
  const job = jobs.get(jobId);
  if (!job || isExpired(job) || job.status === "complete" || job.status === "failed") {
    liveJobByCacheKey.delete(cacheKey);
    return undefined;
  }
  return jobId;
}

/**
 * Create a new job row and register it for deduplication.
 * Returns the new jobId.
 */
export async function createJob(cacheKey: string): Promise<string> {
  const jobId = randomUUID();
  const createdAt = Date.now();
  const job: JobState = { jobId, cacheKey, status: "queued", createdAt };
  jobs.set(jobId, job);
  liveJobByCacheKey.set(cacheKey, jobId);

  await pool.query(
    `INSERT INTO ai_report_job (job_id, cache_key, status, created_at)
     VALUES ($1, $2, 'queued', to_timestamp($3 / 1000.0))`,
    [jobId, cacheKey, createdAt],
  );

  return jobId;
}

/** Transition job to "running". */
export async function markJobRunning(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (job) job.status = "running";
  await pool.query(
    `UPDATE ai_report_job SET status = 'running' WHERE job_id = $1`,
    [jobId],
  );
}

/**
 * Transition job to "complete" and store the result payload.
 * The payload is written to route_payload_snapshot (key "ai-job|{jobId}").
 */
export async function markJobComplete(
  jobId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "complete";
    liveJobByCacheKey.delete(job.cacheKey);
  }

  // Persist payload in the existing route_payload_snapshot table.
  await pool.query(
    `INSERT INTO route_payload_snapshot (key, payload, saved_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET payload = $2, saved_at = now()`,
    [`ai-job|${jobId}`, JSON.stringify(payload)],
  );

  await pool.query(
    `UPDATE ai_report_job SET status = 'complete', completed_at = now()
     WHERE job_id = $1`,
    [jobId],
  );
}

/** Transition job to "failed" and record the error message. */
export async function markJobFailed(jobId: string, error: string): Promise<void> {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "failed";
    job.error = error;
    liveJobByCacheKey.delete(job.cacheKey);
  }

  await pool.query(
    `UPDATE ai_report_job SET status = 'failed', completed_at = now(), error = $2
     WHERE job_id = $1`,
    [jobId, error.slice(0, 1000)],
  );
}

/**
 * Load the current status and (when complete) the result payload for a job.
 * Returns null when the jobId is unknown or has expired (callers → HTTP 404).
 */
export async function loadJobResult(jobId: string): Promise<{
  status: JobStatus;
  report?: Record<string, unknown>;
  error?: string;
} | null> {
  // Fast path: in-memory state
  const inMemory = jobs.get(jobId);
  if (inMemory) {
    if (isExpired(inMemory)) {
      jobs.delete(jobId);
      return null;
    }
    if (inMemory.status === "complete") {
      const res = await pool.query<{ payload: unknown }>(
        `SELECT payload FROM route_payload_snapshot WHERE key = $1`,
        [`ai-job|${jobId}`],
      );
      return {
        status: "complete",
        report: (res.rows[0]?.payload as Record<string, unknown>) ?? undefined,
      };
    }
    return { status: inMemory.status, error: inMemory.error };
  }

  // Slow path: DB lookup (handles server restarts)
  const res = await pool.query<{
    status: string;
    created_at: Date;
    error: string | null;
  }>(
    `SELECT status, created_at, error FROM ai_report_job WHERE job_id = $1`,
    [jobId],
  );
  const row = res.rows[0];
  if (!row) return null;

  if (Date.now() - row.created_at.getTime() > JOB_TTL_MS) return null;

  if (row.status === "complete") {
    const payRes = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM route_payload_snapshot WHERE key = $1`,
      [`ai-job|${jobId}`],
    );
    return {
      status: "complete",
      report: (payRes.rows[0]?.payload as Record<string, unknown>) ?? undefined,
    };
  }

  return { status: row.status as JobStatus, error: row.error ?? undefined };
}
