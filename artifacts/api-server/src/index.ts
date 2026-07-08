import app from "./app";
import { logger } from "./lib/logger";
import {
  ensureSeeded,
  syncDashboard,
  startScheduledSync,
} from "./lib/dashboard/sync";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Ensure baseline data exists, then kick off a live sync in the background so
  // the first load is instant and subsequent loads reflect the latest sheets.
  void (async () => {
    try {
      await ensureSeeded();
      await syncDashboard();
    } catch (syncErr) {
      logger.error({ err: syncErr }, "initial dashboard sync failed");
    }
  })();

  // Keep the served snapshot fresh with a periodic background sync
  // (interval configurable via DASHBOARD_SYNC_INTERVAL_MINUTES, 0 disables).
  startScheduledSync();
});
