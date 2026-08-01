import { Router, type IRouter, type Request, type Response } from "express";
import type { DashboardSnapshot } from "@workspace/db";
import {
  checkSnapshotStaleness,
  ensureSeeded,
  getLatestSnapshot,
  syncDashboard,
} from "../lib/dashboard/sync.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";
import { isSheetsQuotaError } from "../lib/registers/sheetsApi.js";

const router: IRouter = Router();

function toResponse(
  snapshot: DashboardSnapshot,
  refreshError?: string,
  quotaRetryAfter?: number,
) {
  return {
    data: snapshot.data,
    manifest: snapshot.manifest,
    syncedAt: snapshot.syncedAt.toISOString(),
    sourceStatus: snapshot.sourceStatus,
    ...(refreshError ? { refreshError } : {}),
    // When the fresh read hit Google's Sheets quota window but we can still
    // serve a last-good snapshot, mark the response so the frontend can show
    // its "data is loading" notice and auto-retry after retryAfter seconds.
    ...(quotaRetryAfter !== undefined
      ? { quota: true, retryAfter: quotaRetryAfter }
      : {}),
  };
}

function quotaRetryAfterOf(err: unknown): number | undefined {
  return isSheetsQuotaError(err) ? (err.retryAfterSeconds ?? 60) : undefined;
}

router.get("/dashboard", async (req: Request, res: Response): Promise<void> => {
  try {
    const snapshot = await ensureSeeded();
    const stale = await checkSnapshotStaleness(snapshot);
    if (stale) {
      // The stored snapshot was built from the DB but the register has since
      // dropped below its row-count anchor — rebuild now rather than serve a
      // figure we know is wrong.  If the rebuild itself fails, fall back to
      // the existing snapshot so the dashboard never goes blank.
      try {
        const fresh = await syncDashboard();
        res.json(toResponse(fresh));
      } catch (rebuildErr) {
        req.log.error({ err: rebuildErr }, "stale-snapshot rebuild failed; serving existing snapshot");
        res.json(toResponse(snapshot, undefined, quotaRetryAfterOf(rebuildErr)));
      }
      return;
    }
    res.json(toResponse(snapshot));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "failed to load dashboard snapshot");
    res.status(500).json({ error: "Failed to load dashboard data." });
  }
});

router.post(
  "/dashboard/refresh",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const snapshot = await syncDashboard();
      res.json(toResponse(snapshot));
    } catch (err) {
      // Graceful fallback: serve the last good snapshot with an error note.
      req.log.error({ err }, "dashboard refresh failed");
      const fallback = await getLatestSnapshot().catch(() => null);
      if (fallback) {
        res.json(
          toResponse(
            fallback,
            isSheetsQuotaError(err)
              ? "Google Sheets is briefly rate-limiting data reads. Showing the last synced data — try again in a minute."
              : "Could not refresh from Google Sheets. Showing the last synced data.",
            quotaRetryAfterOf(err),
          ),
        );
        return;
      }
      if (respondIfQuotaError(err, res)) return;
      res
        .status(502)
        .json({ error: "Could not refresh from Google Sheets, and no previous data is available." });
    }
  },
);

export default router;
