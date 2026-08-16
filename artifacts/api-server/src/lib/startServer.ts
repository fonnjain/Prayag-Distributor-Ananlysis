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
 *   5. loadPersonRegistry  (plus all dependent startup tasks chained by the caller)
 *
 * setServerReady() is called only after BOTH 4 and 5 complete (or 4 times out).
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
   * setServerReady() is called once both this and the roster restore have settled.
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
   * (or the roster restore times out).
   */
  setServerReady: () => void;

  /**
   * How long to wait for the roster GCS restore before giving up and marking
   * the server ready anyway (using the packaged fallback CSV).
   * Defaults to 30 s.  Pass a smaller value in tests to keep suites fast.
   */
  rosterRestoreTimeoutMs?: number;

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

        const registryDone = deps.loadPersonRegistry().then(
          () => {},
          (err: unknown) => {
            deps.log.warn(
              { err },
              "[personRegistry] startup load failed; head alias maps will be empty",
            );
          },
        );

        // Mark the server ready only after BOTH background tasks settle.
        // See module JSDoc for why this ordering matters for roster consistency.
        void Promise.all([rosterDone, registryDone]).then(() =>
          deps.setServerReady(),
        );

        resolve();
      });
    } catch (err) {
      reject(err as Error);
    }
  });
}
