/**
 * Core server startup sequence with injectable dependencies.
 *
 * Separating this logic from index.ts makes the timing contract unit-testable:
 * a test can supply forever-hanging mocks for restoreRosterCsvFromGcs and
 * loadPersonRegistry and assert that appListen is still called within 5 seconds.
 *
 * ── Startup phases ───────────────────────────────────────────────────────────
 *
 * PRE-LISTEN (sequential, startup-fatal if either rejects):
 *   1. runMigrations       – schema must be current before serving any request
 *   2. restoreAnchors      – locked audit baseline must be on disk before requests
 *
 * PORT OPEN:
 *   3. appListen()         – the deployment health-check endpoint becomes reachable
 *
 * POST-LISTEN BACKGROUND (non-blocking; MUST NOT be awaited before appListen):
 *   4. restoreRosterCsvFromGcs (bounded by rosterRestoreTimeoutMs)
 *   5. loadPersonRegistry  (bounded by registryLoadTimeoutMs)
 *
 * setServerReady() is called only after BOTH 4 and 5 complete (or time out).
 * Because both tasks are now deadline-bounded, setServerReady() is guaranteed
 * to fire within max(rosterRestoreTimeoutMs, registryLoadTimeoutMs) of port-open.
 * A belt-and-suspenders watchdog logs an error if it does not.
 *
 * WHY wait for the roster restore before marking ready
 * ────────────────────────────────────────────────────
 * restoreRosterCsvFromGcs() sets _rosterGcsRestoreAttempted = true at the very
 * START of the function, before the GCS download completes.  If setServerReady()
 * fires while the download is still in progress, the first loadRoster() call after
 * readiness will see _rosterGcsRestoreAttempted=true, skip the lazy-restore path,
 * and cache the packaged CSV for 15 minutes — silently missing the authoritative
 * GCS copy.  Waiting (with a bounded timeout) for the restore to finish before
 * marking the server ready eliminates this window entirely.
 *
 * The returned promise resolves once appListen() fires its callback (i.e. the port
 * is open). Post-listen tasks continue independently in the background.
 */

/** Default timeout for the roster GCS restore.  If GCS does not respond within
 *  this window the server is still marked ready (using the packaged fallback). */
const DEFAULT_ROSTER_RESTORE_TIMEOUT_MS = 30_000;

/**
 * Default timeout for the person-registry DB load.  If the DB is unreachable
 * the server is still marked ready (with empty alias maps) after this deadline.
 */
const DEFAULT_REGISTRY_LOAD_TIMEOUT_MS = 60_000;

/**
 * Extra buffer added on top of both task timeouts before the watchdog fires.
 * Gives the Node.js event loop a comfortable margin to flush micro-task queues
 * before the watchdog concludes the gate is stuck.
 */
const READINESS_WATCHDOG_BUFFER_MS = 5_000;

export interface StartServerLog {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface StartServerDeps {
  /** TCP port number to listen on. */
  port: number;

  /** Run DB schema migrations. Startup-fatal — the port is not opened if this rejects. */
  runMigrations: () => Promise<void>;

  /**
   * Restore verify_anchors.json from object storage.
   * Startup-fatal — a GCS outage here would otherwise silently revert a locked
   * audit baseline to the committed pre-lock config.
   */
  restoreAnchors: () => Promise<void>;

  /**
   * Restore hr_roster.csv from GCS.
   * NON-BLOCKING — fired after the port opens; MUST NOT delay appListen().
   * The startup-timing test verifies this by supplying a forever-hanging mock.
   *
   * setServerReady() is NOT called until this promise settles (or the
   * rosterRestoreTimeoutMs deadline passes), so that a loadRoster() call after
   * readiness always sees the authoritative GCS copy rather than a mid-restore
   * packaged fallback.  See module JSDoc for the full race description.
   *
   * Return type is `unknown` so callers may pass functions returning richer
   * values (e.g. `Promise<string | null>`) without a wrapper.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  restoreRosterCsvFromGcs: () => Promise<any>;

  /**
   * Load the person registry from the DB (plus any dependent startup tasks
   * chained by the caller).
   * NON-BLOCKING — fired after the port opens; MUST NOT delay appListen().
   * setServerReady() is called once both this and the roster restore have settled
   * (or timed out).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadPersonRegistry: () => Promise<any>;

  /**
   * Express app.listen shim.
   * Must invoke cb() once the TCP port is successfully bound.
   */
  appListen: (port: number, cb: () => void) => void;

  /**
   * Marks the server ready to serve data-heavy routes (unblocks the 503 gate).
   * Called after BOTH restoreRosterCsvFromGcs and loadPersonRegistry settle
   * (or time out).
   */
  setServerReady: () => void;

  /**
   * How long to wait for the roster GCS restore before giving up and marking
   * the server ready anyway (using the packaged fallback CSV).
   * Defaults to 30 s.  Pass a smaller value in tests to keep suites fast.
   */
  rosterRestoreTimeoutMs?: number;

  /**
   * How long to wait for the person-registry DB load before giving up and
   * marking the server ready anyway (with empty alias maps).
   * Defaults to 60 s.  Pass a smaller value in tests to keep suites fast.
   *
   * This timeout ensures setServerReady() is always called even when the DB is
   * completely unreachable, preventing a permanent 503-forever state.
   */
  registryLoadTimeoutMs?: number;

  /**
   * If setServerReady() has not been called within this many milliseconds of
   * port-open, the watchdog logs an ERROR.  The gate still resolves via the
   * individual task timeouts; this is a belt-and-suspenders alert for situations
   * where both timeouts fire but setServerReady() is still somehow not called
   * (e.g. a future bug in the Promise chain).
   *
   * Defaults to max(rosterRestoreTimeoutMs, registryLoadTimeoutMs) +
   * READINESS_WATCHDOG_BUFFER_MS.  Pass a smaller value in tests.
   */
  readinessWatchdogMs?: number;

  log: StartServerLog;
}

/**
 * Race a promise against a wall-clock timeout.
 * The returned promise always resolves (never rejects): either the original
 * promise resolves/rejects before the deadline, or the deadline fires first.
 * `onTimeout` is called when the deadline fires to allow side-effects (logging).
 */
function withTimeout(
  p: Promise<unknown>,
  ms: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, ms);
    // Don't keep the Node.js event loop alive for this timer alone.
    timer.unref?.();
  });

  const racePromise = Promise.race([
    p.then(() => {}, () => {}), // normalise to void, swallow errors
    timeoutPromise,
  ]);

  // Clear the timer if the original promise settles first.
  void p.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );

  return racePromise;
}

/**
 * Start the server according to the contract above.
 * Returns a promise that resolves once the port is open.
 */
export async function startServer(deps: StartServerDeps): Promise<void> {
  const rosterTimeoutMs =
    deps.rosterRestoreTimeoutMs ?? DEFAULT_ROSTER_RESTORE_TIMEOUT_MS;
  const registryTimeoutMs =
    deps.registryLoadTimeoutMs ?? DEFAULT_REGISTRY_LOAD_TIMEOUT_MS;
  const watchdogMs =
    deps.readinessWatchdogMs ??
    Math.max(rosterTimeoutMs, registryTimeoutMs) + READINESS_WATCHDOG_BUFFER_MS;

  // ── PRE-LISTEN (startup-fatal) ────────────────────────────────────────────
  await deps.runMigrations();
  await deps.restoreAnchors();

  // ── PORT OPEN ─────────────────────────────────────────────────────────────
  return new Promise<void>((resolve, reject) => {
    try {
      deps.appListen(deps.port, () => {
        deps.log.info({ port: deps.port }, "Server listening");

        // ── POST-LISTEN BACKGROUND ───────────────────────────────────────────
        // INVARIANT: neither call below may be awaited before appListen() fires.
        // The startup-timing test (startup-timing.test.ts) enforces this by
        // supplying forever-hanging mocks and asserting appListen fires < 5 s.

        // Roster restore with a deadline.  If GCS is unreachable the timeout
        // fires after rosterTimeoutMs and the server is still marked ready,
        // using the packaged CSV fallback.
        const rosterDone = withTimeout(
          deps.restoreRosterCsvFromGcs().catch((err: unknown) => {
            deps.log.warn(
              { err },
              "hr_roster.csv: startup GCS restore failed; using packaged baseline",
            );
          }),
          rosterTimeoutMs,
          () =>
            deps.log.warn(
              { timeoutMs: rosterTimeoutMs },
              "hr_roster.csv: GCS restore timed out; using packaged baseline",
            ),
        );

        // Registry load with a deadline.  If the DB is unreachable the timeout
        // fires after registryTimeoutMs and the server is still marked ready,
        // with empty alias maps.  Without this deadline, a hung DB load would
        // keep the server in 'warming_up' state forever.
        const registryDone = withTimeout(
          deps.loadPersonRegistry().then(
            () => {},
            (err: unknown) => {
              deps.log.warn(
                { err },
                "[personRegistry] startup load failed; head alias maps will be empty",
              );
            },
          ),
          registryTimeoutMs,
          () =>
            deps.log.warn(
              { timeoutMs: registryTimeoutMs },
              "[personRegistry] startup load timed out; head alias maps will be empty",
            ),
        );

        // Belt-and-suspenders watchdog: if setServerReady() has not been called
        // within the expected window (both timeouts + buffer), something in the
        // Promise chain is broken and the server will serve 503 forever.
        let readinessAchieved = false;
        const watchdog = setTimeout(() => {
          if (!readinessAchieved) {
            deps.log.error(
              { watchdogMs, rosterTimeoutMs, registryTimeoutMs },
              "WARMUP STUCK: setServerReady() was not called within the expected " +
                "window — server is permanently in 'warming_up' state and will " +
                "serve 503 on every data route until restarted",
            );
          }
        }, watchdogMs);
        // Don't keep the Node.js event loop alive for the watchdog alone.
        watchdog.unref?.();

        // Mark the server ready only after BOTH background tasks settle.
        // See module JSDoc for why this ordering matters for roster consistency.
        void Promise.all([rosterDone, registryDone]).then(() => {
          readinessAchieved = true;
          clearTimeout(watchdog);
          deps.setServerReady();
        });

        resolve();
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}
