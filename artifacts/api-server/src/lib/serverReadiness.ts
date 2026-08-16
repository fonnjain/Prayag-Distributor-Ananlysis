/**
 * Lightweight server-readiness flag.
 *
 * The API server opens its port as soon as DB migrations + anchor restore
 * finish (both startup-fatal).  A second, non-fatal background phase then
 * loads the person registry and restores the roster CSV from object storage.
 * Until that background phase completes, data-heavy routes return 503 so that
 * callers retry rather than seeing stale/empty data.
 *
 * The health check endpoint (/api/healthz) is intentionally excluded from this
 * gate and always returns 200 — it is only used to confirm the port is open.
 */

import type { Request, Response, NextFunction } from "express";

let _ready = false;

/** Called once, inside the app.listen() callback, after background init is done. */
export function setServerReady(): void {
  _ready = true;
}

export function isServerReady(): boolean {
  return _ready;
}

/**
 * Express middleware that blocks data-heavy routes until the server has
 * completed its post-listen background initialisation.
 *
 * Mount this *after* the health router so /api/healthz is never gated.
 */
export function requireServerReady(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (_ready) return next();
  res.setHeader("Retry-After", "30");
  res.status(503).json({
    status: "warming_up",
    message:
      "Server is initialising — please retry in a few seconds.",
  });
}
