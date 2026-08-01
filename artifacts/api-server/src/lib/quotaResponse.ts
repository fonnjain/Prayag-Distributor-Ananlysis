import type { Response } from "express";
import { isSheetsQuotaError } from "./registers/sheetsApi.js";

/**
 * When `err` is a SheetsQuotaError (Google's per-minute Sheets read quota is
 * exhausted, negative-cached for ≤60s), respond with a distinguishable
 * 503 + Retry-After instead of a generic 500 so the frontend can show a
 * friendly "data is refreshing" state and auto-retry.
 *
 * Returns true when the response was sent (caller should return), false when
 * the error is something else and the caller's normal handling should run.
 */
export function respondIfQuotaError(err: unknown, res: Response): boolean {
  if (!isSheetsQuotaError(err)) return false;
  const retryAfter = err.retryAfterSeconds ?? 60;
  res.setHeader("Retry-After", String(retryAfter));
  res.status(503).json({
    error:
      "Google Sheets is briefly rate-limiting data reads. The data is refreshing — it will be back within a minute.",
    quota: true,
    retryAfter,
  });
  return true;
}
