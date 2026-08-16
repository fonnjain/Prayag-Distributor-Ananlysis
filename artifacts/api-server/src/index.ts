import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations, pool } from "@workspace/db";
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
import { restoreMarginLoadJob } from "./routes/gpMargin.js";
import { startWeeklyDigestScheduler } from "./lib/alertRouting/scheduler.js";
import { scheduleCompetitorRefresh } from "./routes/competitorPrice.js";
import { cleanupOrphanedJobs } from "./lib/aiReportJobQueue.js";
import {
  loadPersonRegistry,
  assertHeadCoverage,
  assertPersonTableCoverage,
} from "./lib/personRegistry.js";
import { logCoverage as logCustomerStateHeadCoverage } from "./lib/customerStateHead.js";
import { loadAndPersistStateDashboard } from "./lib/secondary/stateHeadLoader.js";
import { currentOpenFy } from "./lib/fyAnchors.js";
import { setServerReady } from "./lib/serverReadiness.js";
import { startServer } from "./lib/startServer.js";

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
// open the port.  Both steps are sequential and must complete before app.listen()
// — the server must not accept requests until:
//   1. The schema is current, and
//   2. Any locked audit anchors in GCS have been restored to disk.
//
// restoreRosterCsvFromGcs() and loadPersonRegistry() were previously awaited
// here too but are now fired as post-listen background tasks so the port opens
// quickly for deployment health checks.  The requireServerReady middleware
// returns 503 with Retry-After until setServerReady() is called after the
// background phase completes.
startServer({
  port,
  runMigrations,
  restoreAnchors: () =>
    restoreAnchorsFromStorage({
      info: (msg) => logger.info(msg),
      warn: (msg) => logger.warn(msg),
    }),
  // ── POST-LISTEN BACKGROUND (non-blocking) ──────────────────────────────────
  // restoreRosterCsvFromGcs and loadPersonRegistry are wired into startServer's
  // post-listen path so they are never awaited before app.listen().  Passing
  // forever-hanging mocks to startServer in the startup-timing test verifies
  // that this contract cannot be accidentally broken by a future code change.
  restoreRosterCsvFromGcs,
  // loadPersonRegistry is wrapped here with all tasks that depend on the
  // registry being loaded — SKU coverage check, secondary pipeline staleness
  // check, register sync.  startServer calls setServerReady() after this
  // async function resolves.
  loadPersonRegistry: async () => {
    await loadPersonRegistry().catch((err) =>
      logger.warn(
        { err },
        "[personRegistry] startup load failed; head alias maps will be empty",
      ),
    );
    // Non-fatal coverage check — logs WARN for any FY2026-27 register head not
    // resolved by the registry.  Run in background after register data is ready.
    void assertHeadCoverage();
    // Non-fatal person-table coverage check — warns when a person_registry
    // member (is_person=true, is_state_head=false) has no matching row in the
    // person table.  Without a person row, migration 034 cannot backfill
    // state_head on the registry row, leaving secondary_sku_line rows for
    // that member with state_canon=NULL and invisible in territory roll-ups.
    void assertPersonTableCoverage().catch((err) =>
      logger.warn(
        { err },
        "[personRegistry] person-table coverage check failed (non-fatal)",
      ),
    );
    // One-line startup log: how many customer_master rows have a state_head.
    void logCustomerStateHeadCoverage().catch(() => {/* non-fatal */});

    // ── secondary_sku_line state_canon residual check ─────────────────────────
    // If state_canon is NULL on more than ~50k rows (well above the 17k
    // irreducible structural residual), the migration 032 backfill has not run.
    void (async () => {
      try {
        const {
          getSkuStateCanonResidual,
          SKU_STATE_CANON_MATERIALITY_THRESHOLD,
        } = await import("./lib/secondary/skuLoader.js");
        const { nullCount, total } = await getSkuStateCanonResidual();
        if (total === 0) return; // table not yet loaded — skip
        if (nullCount > SKU_STATE_CANON_MATERIALITY_THRESHOLD) {
          logger.info(
            { nullCount, total, threshold: SKU_STATE_CANON_MATERIALITY_THRESHOLD },
            `[skuStateCanon] ${nullCount.toLocaleString()} of ${total.toLocaleString()} secondary_sku_line rows have state_canon=NULL — running automatic backfill`,
          );
          const { backfillSkuStateCanon } = await import(
            "./lib/secondary/skuLoader.js"
          );
          const updated = await backfillSkuStateCanon();
          logger.info(
            { updated },
            `[skuStateCanon] backfillSkuStateCanon: complete — ${updated.toLocaleString()} rows updated`,
          );
        } else {
          logger.info(
            { nullCount, total },
            `[skuStateCanon] state_canon coverage OK: ${nullCount.toLocaleString()} NULL rows of ${total.toLocaleString()} total (within materiality threshold)`,
          );
        }
      } catch (err) {
        logger.warn(
          { err },
          "[skuStateCanon] startup residual check failed (non-fatal)",
        );
      }
    })();

    // ── Secondary sheet pipeline staleness check ──────────────────────────────
    // If MAX(ingested_at) across ALL members in secondary_head_month is > 2 days
    // old, the 6-hour secondary dashboard scheduler has not run — or has failed
    // every tick since startup.  Emit a loud WARNING so the gap is visible in
    // server logs on every restart.
    //
    // Threshold: 2 days ≈ 8 missed scheduler ticks.  A brief restart never
    // causes a gap this large because the scheduler fires within 5 min of boot.
    void (async () => {
      const SECONDARY_PIPELINE_STALE_DAYS = 2;
      try {
        const openFy = currentOpenFy();
        const { rows } = await pool.query<{ latest_at: Date | null }>(
          `SELECT MAX(ingested_at) AS latest_at FROM secondary_head_month WHERE fy = $1`,
          [openFy],
        );
        const latestAt = rows[0]?.latest_at ?? null;
        if (latestAt == null) {
          logger.warn(
            { fy: openFy },
            "[secondaryPipeline] startup check: no ingested_at recorded for any FY member — first scheduled sync has not run yet, or secondary_head_month is empty",
          );
        } else {
          const daysSince = (Date.now() - latestAt.getTime()) / 86_400_000;
          if (daysSince > SECONDARY_PIPELINE_STALE_DAYS) {
            logger.warn(
              {
                fy: openFy,
                lastIngestAt: latestAt.toISOString(),
                daysSince: Math.round(daysSince * 10) / 10,
              },
              `[secondaryPipeline] STALL DETECTED: FY${openFy} secondary sheet data last ingested ${Math.round(daysSince * 10) / 10} days ago (threshold: ${SECONDARY_PIPELINE_STALE_DAYS} days). The 6-hour secondary dashboard scheduler may have been failing. Check server logs and Sheets API quota.`,
            );
          } else {
            logger.info(
              {
                fy: openFy,
                lastIngestAt: latestAt.toISOString(),
                daysSince: Math.round(daysSince * 10) / 10,
              },
              "[secondaryPipeline] startup check: pipeline is current",
            );
          }
        }
      } catch (err) {
        logger.warn(
          { err },
          "[secondaryPipeline] startup staleness check failed (non-fatal)",
        );
      }
    })();

    // Auto-populate sale_line for all configured FYs on startup, then keep
    // the current open FY fresh on a 6-hour schedule.  Runs after person
    // registry load so head alias maps are available during ingest.
    for (const fy of Object.keys(REGISTER_SHEET_IDS)) {
      ensureRegisterSynced(fy);
    }
    startScheduledRegisterSync();
    // setServerReady() is called by startServer after this function resolves.
  },
  appListen: (p, cb) => { app.listen(p, cb); },
  setServerReady,
  log: {
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => logger.error(obj, msg),
  },
})
  .then(() => {
    // ── Remaining post-listen tasks (do not depend on person registry) ────────
    // All tasks below fire as soon as the port opens.  They were always
    // non-blocking and continue to be wired as void here.

    // Mark any orphaned "queued"/"running" AI report jobs as failed.
    // They belong to the previous server process and their background
    // computations died with it; clients should retry rather than poll forever.
    void cleanupOrphanedJobs();

    // Restore GP Margin load state from DB: if the previous process was killed
    // mid-load, marks the job as error so the status endpoint surfaces it.
    void restoreMarginLoadJob().catch((err) =>
      logger.warn({ err }, "margin job restore failed"),
    );

    // Ensure baseline data exists, then kick off a live sync in the background
    // so the first load is instant and subsequent loads reflect the latest sheets.
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

    // Pre-warm mgmt data caches so the first Sales/Data Sources page load is
    // fast.  Fills the orders, stateHeadSale, and stateDashboard sub-caches in
    // the background.  As soon as the state dashboard is warm, chain the
    // /api/warnings pre-warm so every state head has a persisted snapshot ASAP
    // after a cold start (sequential, skip-if-exists).  Chaining (rather than
    // a fixed delay) starts it at the earliest moment its prerequisite data is
    // available while still yielding to the user-facing warm-ups above.
    void Promise.all([
      assembleRows({
        fy: "2026-27",
        states: [],
        regions: [],
        monthFrom: 1,
        monthTo: 12,
        lowPerfPct: 50,
      }),
      loadStateHeadSale("2026-27"),
      loadStateDashboard("2026-27"),
    ])
      .catch((err) => logger.warn({ err }, "mgmt warm-up failed"))
      .then(() =>
        prewarmWarningsSnapshots("2026-27").catch((err) =>
          logger.warn({ err }, "warnings prewarm failed"),
        ),
      )
      // Then build any missing mgmt-data snapshots (every FY × full year +
      // four quarters) so no user's first visit to any year or quarter ever
      // blocks on a multi-minute live build.  Sequential and skip-if-exists
      // — cheap when everything is already covered.
      .then(() =>
        prewarmMgmtDataSnapshots().catch((err) =>
          logger.warn({ err }, "mgmt-data prewarm failed"),
        ),
      );

    // Pre-warm order-booking sheet caches (readOrderTabInventory +
    // readBookingAggregated) for all four FYs so the booking-vs-sale route
    // responds instantly after startup.  These reads are slow on a cold server
    // (~2 min total); warming them in the background prevents HTTP timeouts on
    // the first user request.
    void (async () => {
      for (const [fy, sheetId] of Object.entries(BOOKING_SHEETS)) {
        try {
          await Promise.all([
            readOrderTabInventory(sheetId),
            readBookingAggregated(sheetId),
          ]);
          logger.info({ fy }, "booking sheet warm-up done");
        } catch (err) {
          logger.warn({ err, fy }, "booking sheet warm-up failed");
        }
      }
    })();

    // Keep the served snapshot fresh with a periodic background sync
    // (interval configurable via DASHBOARD_SYNC_INTERVAL_MINUTES, 0 disables).
    startScheduledSync();

    // Fetch competitor price snapshot from the Prayag Competition Analysis app.
    // First run 5 min after startup, then every 24 h.
    scheduleCompetitorRefresh();

    // Keep the primary_order_line OB mirror aligned with the live Order Sheet.
    // Runs alongside the register sync cadence (every 6h) for the OPEN FY only,
    // in replace mode so rows removed from the sheet also leave the DB mirror.
    // Closed FYs are never touched.  Overlap-guarded via obSyncInFlight.
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
              {
                fy,
                rowsEmitted: r.rowsEmitted,
                inserted: r.inserted,
                errors: r.errors,
              },
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

    // Distributor deep-dive snapshot warmer.  In production the page is only
    // as good as its last complete snapshot (degraded Sheets loads serve the
    // snapshot), so build every head's deep dive SEQUENTIALLY — one head at a
    // time, pausing between heads — shortly after startup and then every 6h.
    // Sequential + bounded per-head concurrency keeps the Sheets read rate
    // under the per-minute quota that a cold parallel burst used to trip.
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
          const heads = [
            ...new Set(
              roster.members.map((m) => m.stateHead).filter(Boolean),
            ),
          ];
          for (const head of heads) {
            try {
              // bypassSnapshot: the warmer must build live — snapshot-first
              // serving would hand it back its own snapshot and never refresh.
              const r = await loadDistributorDeepDiveResilient(fy, head, {
                bypassSnapshot: true,
              });
              logger.info(
                {
                  head,
                  fy,
                  loaded: r.membersLoaded,
                  failed: r.membersFailed,
                  stale: r.stale ?? false,
                },
                "distributor snapshot warmer: head done",
              );
            } catch (err) {
              logger.warn(
                { err, head },
                "distributor snapshot warmer: head failed",
              );
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
      setInterval(
        () => void warmDistributorSnapshots(),
        6 * 3_600_000,
      ).unref();
    }

    // ── Secondary dashboard scheduler ──────────────────────────────────────
    // Keeps secondary_head_month current for the open FY by re-reading the
    // State Head Dashboard (Google Sheet) on a 6-hour cadence.  Failures
    // leave the prior ingested_at unchanged so the staleness check always
    // reflects the LAST SUCCESSFUL sync, not the last attempted one.
    //
    // Only runs for the open FY — closed FYs are frozen and never re-ingested
    // from the dashboard (their data comes from xlsx uploads).
    {
      let secDashSyncInFlight = false;
      const runSecDashSync = async (): Promise<void> => {
        if (secDashSyncInFlight) return;
        secDashSyncInFlight = true;
        const openFy = currentOpenFy();
        try {
          const summary = await loadAndPersistStateDashboard(openFy);
          const anyFailed = summary.assertions.some((a) => !a.passed);
          if (anyFailed) {
            logger.warn(
              {
                fy: openFy,
                assertions: summary.assertions.filter((a) => !a.passed),
              },
              "scheduled secondary dashboard sync: validation failed — ingested_at NOT updated",
            );
          } else {
            logger.info(
              { fy: openFy, rowsRead: summary.rowsRead, dataRows: summary.dataRows },
              "scheduled secondary dashboard sync: done",
            );
          }
        } catch (err) {
          logger.error(
            { err, fy: openFy },
            "scheduled secondary dashboard sync: failed",
          );
        } finally {
          secDashSyncInFlight = false;
        }
      };
      // First run 5 min after startup (after the register and booking warm-ups
      // have had time to settle), then every 6 hours.
      setTimeout(() => void runSecDashSync(), 5 * 60_000).unref();
      setInterval(() => void runSecDashSync(), 6 * 3_600_000).unref();
    }

    // ── Red Alert detection scheduler ──────────────────────────────────────
    // Runs the fingerprint-based persistence runner every 6 hours.  Non-fatal
    // on failure — alerts remain stale but the server keeps serving other
    // routes.
    {
      let alertDetectInFlight = false;
      const runAlertDetect = async (): Promise<void> => {
        if (alertDetectInFlight) return;
        alertDetectInFlight = true;
        try {
          const { runAlertDetection } = await import(
            "./lib/redAlert/alertPersistence.js"
          );
          const stats = await runAlertDetection();
          logger.info(
            {
              new: stats.new,
              updated: stats.updated,
              cleared: stats.cleared,
              totalOpen: stats.totalOpen,
            },
            "scheduled alert detection: done",
          );
        } catch (err) {
          logger.error({ err }, "scheduled alert detection: failed");
        } finally {
          alertDetectInFlight = false;
        }
      };
      // First run 10 min after startup (after register and secondary warm-ups),
      // then every 6 hours.
      setTimeout(() => void runAlertDetect(), 10 * 60_000).unref();
      setInterval(() => void runAlertDetect(), 6 * 3_600_000).unref();
    }

    // ── Weekly alert digest scheduler ───────────────────────────────────────
    // Polls every 15 min; fires Monday 07:30–09:30 IST when ≥24h since last run.
    // Last run is persisted in alert_scheduler (migration 041) so a server
    // restart never sends a duplicate digest.
    startWeeklyDigestScheduler(currentOpenFy());

    // Assert frozen-FY anchors in the background.  Any mismatch means
    // something wrote to an immutable year — logged at ERROR and exposed via
    // /registers/freeze-status.
    void assertFrozenAnchors().catch((err) =>
      logger.error({ err }, "assertFrozenAnchors: unexpected failure"),
    );

    // Assert frozen-MONTH anchors (freeze at 00:00 on the 8th of the
    // following month) for every configured FY.  A mismatch means something
    // wrote to a frozen month.
    for (const fy of Object.keys(REGISTER_SHEET_IDS)) {
      void assertMonthAnchors(fy).catch((err) =>
        logger.error({ err, fy }, "assertMonthAnchors: unexpected failure"),
      );
    }
  })
  .catch((err) => {
    // Terminal handler: migrations failure or GCS anchor restore failure.
    // Both are startup-fatal — a restore failure means the server would serve
    // the committed pre-lock config instead of the locked audit baseline.
    logger.error({ err }, "Startup failed — refusing to start");
    process.exit(1);
  });
