import type { NextFunction, Request, Response } from "express";
import { db, pool } from "@workspace/db";
import { apiKeys } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { isExternalReadEndpoint } from "./apiKeyAuth.js";
import { logger } from "./logger.js";

export const EXTERNAL_READ_RATE_LIMIT = 60;
const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Log the final response for an authenticated external-read request without
 * ever recording the raw credential.
 */
export function logExternalReadResponse(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.apiKey?.scope !== "external_read" || !isExternalReadEndpoint(req)) {
    next();
    return;
  }

  const startedAt = Date.now();
  res.once("finish", () => {
    const method = req.method.toUpperCase();
    const path = req.originalUrl?.split("?")[0] ?? req.path;
    const statusCode = res.statusCode;
    logger.info({
      apiKeyId: req.apiKey!.id,
      method,
      path,
      statusCode,
      durationMs: Date.now() - startedAt,
    }, "external read request completed");
    void db.update(apiKeys)
      .set({
        lastUsedAt: new Date(),
        lastUsedMethod: method,
        lastUsedPath: path,
        lastUsedStatus: statusCode,
      })
      .where(eq(apiKeys.id, req.apiKey!.id))
      .catch((err) => {
        logger.error({ err, apiKeyId: req.apiKey!.id }, "external read usage update failed");
      });
  });
  next();
}

export interface ExternalReadQuota {
  allowed: boolean;
  requestCount: number;
  retryAfterSeconds: number;
}

/**
 * Consume one request from the per-key fixed-minute window.
 *
 * This is deliberately one PostgreSQL upsert rather than an in-memory
 * counter.  The row lock taken by ON CONFLICT serializes concurrent requests
 * from the same key even when the API is running on several instances.
 */
export async function consumeExternalReadQuota(apiKeyId: number): Promise<ExternalReadQuota> {
  const { rows } = await pool.query<{
    request_count: number;
    retry_after_seconds: number;
  }>(
    `INSERT INTO api_key_rate_limit (api_key_id, window_started, request_count)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (api_key_id) DO UPDATE
       SET request_count = CASE
             WHEN api_key_rate_limit.window_started = date_trunc('minute', now())
               THEN LEAST(api_key_rate_limit.request_count + 1, $2 + 1)
             ELSE 1
           END,
           window_started = CASE
             WHEN api_key_rate_limit.window_started = date_trunc('minute', now())
               THEN api_key_rate_limit.window_started
             ELSE date_trunc('minute', now())
           END
     RETURNING request_count,
       GREATEST(
         1,
         CEIL(EXTRACT(EPOCH FROM (
           date_trunc('minute', window_started) + interval '1 minute' - now()
         )))::integer
       ) AS retry_after_seconds`,
    [apiKeyId, EXTERNAL_READ_RATE_LIMIT],
  );

  const row = rows[0];
  if (!row) {
    throw new Error("External read rate limiter did not return a counter row");
  }
  const requestCount = Number(row.request_count);
  const retryAfterSeconds = Math.max(1, Number(row.retry_after_seconds));
  return {
    allowed: requestCount <= EXTERNAL_READ_RATE_LIMIT,
    requestCount,
    retryAfterSeconds,
  };
}

/**
 * Install after API-key resolution and before external route handlers.
 * Non-external requests do not touch the rate-limit table.
 */
export async function rateLimitExternalRead(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.apiKey?.scope !== "external_read" || !isExternalReadEndpoint(req)) {
    next();
    return;
  }

  try {
    const quota = await consumeExternalReadQuota(req.apiKey.id);
    const remaining = Math.max(0, EXTERNAL_READ_RATE_LIMIT - quota.requestCount);
    res.setHeader("X-RateLimit-Limit", String(EXTERNAL_READ_RATE_LIMIT));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    if (!quota.allowed) {
      res.setHeader("Retry-After", String(quota.retryAfterSeconds));
      res.status(429).json({ error: "Rate limit exceeded", retryAfter: quota.retryAfterSeconds });
      return;
    }
    next();
  } catch (err) {
    // Failing closed avoids turning a database outage into an unbounded
    // external data read.  Retry-After is intentionally short because the
    // limiter may recover on the next request.
    logger.error({ err, apiKeyId: req.apiKey.id }, "external read rate limiter failed");
    res.setHeader("Retry-After", "1");
    res.status(503).json({ error: "External read rate limiter unavailable" });
  }
}
