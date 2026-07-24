import { Router, type IRouter, type Request, type Response } from "express";
import type { DashboardSnapshot } from "@workspace/db";
import {
  checkSnapshotStaleness,
  ensureSeeded,
  getLatestSnapshot,
  syncDashboard,
} from "../lib/dashboard/sync.js";

const router: IRouter = Router();

function toResponse(snapshot: DashboardSnapshot, refreshError?: string) {
  return {
    data: snapshot.data,
    manifest: snapshot.manifest,
    syncedAt: snapshot.syncedAt.toISOString(),
    sourceStatus: snapshot.sourceStatus,
    ...(refreshError ? { refreshError } : {}),
  };
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
        res.json(toResponse(snapshot));
      }
      return;
    }
    res.json(toResponse(snapshot));
  } catch (err) {
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
            "Could not refresh from Google Sheets. Showing the last synced data.",
          ),
        );
        return;
      }
      res
        .status(502)
        .json({ error: "Could not refresh from Google Sheets, and no previous data is available." });
    }
  },
);

export default router;
