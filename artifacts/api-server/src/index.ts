import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "@workspace/db";
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
  assertFrozenAnchors,
  REGISTER_SHEET_IDS,
} from "./lib/customers/registerSync.js";
import { assertMonthAnchors } from "./lib/registers/monthlyReplace.js";
import { ensureAndSeedStateTargets } from "./lib/mgmt/stateTargetSeed.js";
import { loadStateDashboard } from "./lib/mgmt/stateDashboard.js";
import {
  readOrderTabInventory,
  readBookingAggregated,
  BOOKING_SHEETS,
  ingestOrderBookingFy,
} from "./lib/mgmt/primarySheets.js";
import { isFyOpen } from "./lib/customers/registerSync.js";
import { restoreAnchorsFromStorage } from "./lib/config/verifyAnchors.js";
import { restoreRosterCsvFromGcs } from "./lib/mgmt/roster.js";
import { prewarmWarningsSnapshots } from "./routes/warnings.js";
import { prewarmMgmtDataSnapshots } from "./routes/mgmt.js";

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

// Apply DB schema migrations, restore locked anchors from Object Storage, then
// start accepting requests.  Both steps are sequential and must complete before
// app.listen() — the server must not accept requests until:
//   1. The schema is current, and
//   2. Any locked audit anchors in GCS have been restored to disk.
//
// A single terminal .catch() makes both steps startup-fatal: a transient GCS
// outage during restore would otherwise silently serve the committed pre-lock
// config, potentially reverting a locked audit baseline.
runMigrations()
  .then(async () => {
    await restoreAnchorsFromStorage({
      info: (msg) => logger.info(msg),
      warn: (msg) => logger.warn(msg),
    });
    // Restore the uploaded hr_roster.csv from object storage if GCS has a copy,
    // overwriting the packaged baseline so the most recently uploaded roster is
    // always served regardless of redeployments.  Non-fatal — a GCS outage here
    // falls back to the packaged CSV; the business can re-upload when GCS recovers.
    await restoreRosterCsvFromGcs().catch((err) =>
      logger.warn({ err }, "hr_roster.csv: startup GCS restore failed; using packaged baseline"),
    );
  })
  .then(() => {
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

  // Pre-warm mgmt data caches so the first Sales/Data Sources page load is fast.
  // Fills the orders, stateHeadSale, and stateDashboard sub-caches in the background.
  // As soon as the state dashboard is warm, chain the /api/warnings pre-warm so
  // every state head has a persisted snapshot ASAP after a cold start (sequential,
  // skip-if-exists — see prewarmWarningsSnapshots). Chaining (rather than a fixed
  // delay) starts it at the earliest moment its prerequisite data is available
  // while still yielding to the user-facing warm-ups above.
  void Promise.all([
    assembleRows({ fy: "2026-27", states: [], regions: [], monthFrom: 1, monthTo: 12, lowPerfPct: 50 }),
    loadStateHeadSale("2026-27"),
    loadStateDashboard("2026-27"),
  ])
    .catch((err) => logger.warn({ err }, "mgmt warm-up failed"))
    .then(() =>
      prewarmWarningsSnapshots("2026-27").catch((err) =>
        logger.warn({ err }, "warnings prewarm failed"),
      ),
    )
    // Then build any missing mgmt-data snapshots (every FY × full year + four
    // quarters) so no user's first visit to any year or quarter ever blocks on
    // a multi-minute live build. Sequential and skip-if-exists — cheap when
    // everything is already covered.
    .then(() =>
      prewarmMgmtDataSnapshots().catch((err) =>
        logger.warn({ err }, "mgmt-data prewarm failed"),
      ),
    );

  // Pre-warm order-booking sheet caches (readOrderTabInventory + readBookingAggregated)
  // for all four FYs so the booking-vs-sale route responds instantly after startup.
  // These reads are slow on a cold server (~2 min total); warming them in the background
  // prevents HTTP timeouts on the first user request.
  void (async () => {
    for (const [fy, sheetId] of Object.entries(BOOKING_SHEETS)) {
      try {
        await Promise.all([readOrderTabInventory(sheetId), readBookingAggregated(sheetId)]);
        logger.info({ fy }, "booking sheet warm-up done");
      } catch (err) {
        logger.warn({ err, fy }, "booking sheet warm-up failed");
      }
    }
  })();

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

  // Keep the primary_order_line OB mirror aligned with the live Order Sheet.
  // Runs alongside the register sync cadence (every 6h) for the OPEN FY only,
  // in replace mode so rows removed from the sheet also leave the DB mirror.
  // Closed FYs are never touched. Overlap-guarded via obSyncInFlight.
  {
    let obSyncInFlight = false;
    const runObMirrorSync = async (): Promise<void> => {
      if (obSyncInFlight) return;
      obSyncInFlight = true;
      try {
        for (const fy of Object.keys(BOOKING_SHEETS)) {
          if (!isFyOpen(fy)) continue;
          const r = await ingestOrderBookingFy(fy, { replace: true });
          logger.info(
            { fy, rowsEmitted: r.rowsEmitted, inserted: r.inserted, errors: r.errors },
            "scheduled OB mirror sync: done",
          );
        }
      } catch (err) {
        logger.error({ err }, "scheduled OB mirror sync: failed");
      } finally {
        obSyncInFlight = false;
      }
    };
    // First run shortly after startup (let sheet warm-up begin first), then every 6h.
    setTimeout(() => void runObMirrorSync(), 60_000).unref();
    setInterval(() => void runObMirrorSync(), 6 * 3_600_000).unref();
  }

  // Distributor deep-dive snapshot warmer. In production the page is only as
  // good as its last complete snapshot (degraded Sheets loads serve the
  // snapshot), so build every head's deep dive SEQUENTIALLY — one head at a
  // time, pausing between heads — shortly after startup and then every 6h.
  // Sequential + bounded per-head concurrency keeps the Sheets read rate under
  // the per-minute quota that a cold parallel burst used to trip.
  {
    let ddWarmInFlight = false;
    const warmDistributorSnapshots = async (): Promise<void> => {
      if (ddWarmInFlight) return;
      ddWarmInFlight = true;
      try {
        const { loadDistributorDeepDiveResilient } = await import(
          "./lib/mgmt/distributorDeepDive.js"
        );
        const { loadRoster } = await import("./lib/mgmt/roster.js");
        const fy = "2026-27";
        const roster = await loadRoster();
        const heads = [...new Set(roster.members.map((m) => m.stateHead).filter(Boolean))];
        for (const head of heads) {
          try {
            const r = await loadDistributorDeepDiveResilient(fy, head);
            logger.info(
              { head, fy, loaded: r.membersLoaded, failed: r.membersFailed, stale: r.stale ?? false },
              "distributor snapshot warmer: head done",
            );
          } catch (err) {
            logger.warn({ err, head }, "distributor snapshot warmer: head failed");
          }
          // Pause between heads so consecutive cold teams never stack reads.
          await new Promise((r) => setTimeout(r, 30_000));
        }
      } catch (err) {
        logger.error({ err }, "distributor snapshot warmer: failed");
      } finally {
        ddWarmInFlight = false;
      }
    };
    // First run 3 min after startup (after register warm-up), then every 6h.
    setTimeout(() => void warmDistributorSnapshots(), 3 * 60_000).unref();
    setInterval(() => void warmDistributorSnapshots(), 6 * 3_600_000).unref();
  }

  // Assert frozen-FY anchors in the background. Any mismatch means something
  // wrote to an immutable year — logged at ERROR and exposed via /registers/freeze-status.
  void assertFrozenAnchors().catch((err) =>
    logger.error({ err }, "assertFrozenAnchors: unexpected failure"),
  );

  // Assert frozen-MONTH anchors (7th-of-following-month freeze rule) for every
  // configured FY. A mismatch means something wrote to a frozen month.
  for (const fy of Object.keys(REGISTER_SHEET_IDS)) {
    void assertMonthAnchors(fy).catch((err) =>
      logger.error({ err, fy }, "assertMonthAnchors: unexpected failure"),
    );
  }
    });
  })
  .catch((err) => {
    // Terminal handler: migrations failure or GCS anchor restore failure.
    // Both are startup-fatal — a restore failure means the server would serve
    // the committed pre-lock config instead of the locked audit baseline.
    logger.error({ err }, "Startup failed — refusing to start");
    process.exit(1);
  });
