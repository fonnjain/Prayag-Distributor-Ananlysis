import { Router, type IRouter, type Request, type Response } from "express";
import type { DashboardSnapshot } from "@workspace/db";
import { ensureSeeded, getLatestSnapshot, syncDashboard } from "../lib/dashboard/sync.js";

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
