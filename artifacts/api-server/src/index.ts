import app from "./app";
import { logger } from "./lib/logger";
import {
  ensureSeeded,
  syncDashboard,
  startScheduledSync,
} from "./lib/dashboard/sync";
import { assembleRows } from "./lib/mgmt/report.js";
import { loadStateHeadSale } from "./lib/mgmt/stateHeadSale.js";
import {
  ensureRegisterSynced,
  startScheduledRegisterSync,
  REGISTER_SHEET_IDS,
} from "./lib/customers/registerSync.js";
import { ensureAndSeedStateTargets } from "./lib/mgmt/stateTargetSeed.js";

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

  // Create primary_state_targets table if needed, then seed Apr-Jul targets.
  void ensureAndSeedStateTargets().catch((err) =>
    logger.warn({ err }, "state-target seed failed"),
  );

  // Pre-warm mgmt data caches so the first Sales page load is fast.
  // Fills the orders + stateHeadSale sub-caches in the background.
  void Promise.all([
    assembleRows({ fy: "2026-27", states: [], regions: [], monthFrom: 1, monthTo: 12, lowPerfPct: 50 }),
    loadStateHeadSale("2026-27"),
  ]).catch((err) => logger.warn({ err }, "mgmt warm-up failed"));

  // Keep the served snapshot fresh with a periodic background sync
  // (interval configurable via DASHBOARD_SYNC_INTERVAL_MINUTES, 0 disables).
  startScheduledSync();

  // Auto-populate sale_line for all configured FYs on startup, then keep the
  // current open FY fresh on a 6-hour schedule. No manual trigger needed.
  // Completed FYs are no-ops after the first successful sync.
  for (const fy of Object.keys(REGISTER_SHEET_IDS)) {
    ensureRegisterSynced(fy);
  }
  startScheduledRegisterSync();
});
