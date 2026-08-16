/**
 * Startup-timing contract test.
 *
 * Verifies that appListen() is called within 5 seconds even when object storage
 * (GCS) is completely unreachable — i.e. restoreRosterCsvFromGcs() and
 * loadPersonRegistry() hang indefinitely.
 *
 * If a future change accidentally re-introduces an `await` before appListen()
 * for either of those calls, this test will time out and fail visibly.
 *
 * The 5-second budget is generous: in practice, when the two blocking calls
 * (runMigrations + restoreAnchors) are mocked to resolve instantly, the listen
 * call fires in < 1 ms.  Any regression that adds a blocking GCS/DB await
 * before listen will push the elapsed time well past 5 s.
 *
 * Also verifies the roster-consistency contract: setServerReady() must not be
 * called until the roster restore has settled (or timed out), so that the first
 * loadRoster() call after readiness always sees the authoritative GCS copy
 * instead of a mid-restore packaged-CSV snapshot cached for 15 minutes.
 */

import { describe, expect, it } from "vitest";
import { startServer } from "../lib/startServer.js";

const STARTUP_BUDGET_MS = 5_000;

/** A promise that never resolves — simulates an unreachable GCS bucket or DB. */
function neverResolves(): Promise<void> {
  return new Promise<void>(() => {
    /* intentionally never resolves */
  });
}

/** Resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("startServer startup-timing", () => {
  it("calls appListen within 5 s when roster GCS hangs indefinitely", async () => {
    const listenTimes: number[] = [];
    const start = performance.now();

    await startServer({
      port: 0,
      runMigrations: () => Promise.resolve(),
      restoreAnchors: () => Promise.resolve(),
      // GCS for roster CSV hangs — simulates unreachable object storage
      restoreRosterCsvFromGcs: neverResolves,
      // Person registry DB load also hangs — simulates unreachable DB
      loadPersonRegistry: neverResolves,
      rosterRestoreTimeoutMs: 100, // short timeout so the test isn't slow
      appListen: (_port, cb) => {
        listenTimes.push(performance.now());
        cb();
      },
      setServerReady: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(listenTimes, "appListen must be called exactly once").toHaveLength(1);

    const elapsed = listenTimes[0]! - start;
    expect(
      elapsed,
      `appListen was called after ${elapsed.toFixed(1)} ms — exceeds the ` +
        `${STARTUP_BUDGET_MS} ms budget. A blocking await was probably ` +
        `re-introduced before app.listen() (check for new pre-listen awaits ` +
        `on GCS or DB calls in startServer or index.ts).`,
    ).toBeLessThan(STARTUP_BUDGET_MS);
  });

  it("calls appListen within 5 s when both GCS calls hang simultaneously", async () => {
    const listenTimes: number[] = [];
    const start = performance.now();

    await startServer({
      port: 3000,
      runMigrations: () => Promise.resolve(),
      restoreAnchors: () => Promise.resolve(),
      restoreRosterCsvFromGcs: neverResolves,
      loadPersonRegistry: neverResolves,
      rosterRestoreTimeoutMs: 100,
      appListen: (_port, cb) => {
        listenTimes.push(performance.now());
        cb();
      },
      setServerReady: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const elapsed = listenTimes[0]! - start;
    expect(
      elapsed,
      `Port opened in ${elapsed.toFixed(1)} ms (budget: ${STARTUP_BUDGET_MS} ms).`,
    ).toBeLessThan(STARTUP_BUDGET_MS);
  });

  it("does NOT call appListen when migrations fail (startup-fatal)", async () => {
    const listenTimes: number[] = [];

    await expect(
      startServer({
        port: 0,
        runMigrations: () => Promise.reject(new Error("DB connection refused")),
        restoreAnchors: () => Promise.resolve(),
        restoreRosterCsvFromGcs: () => Promise.resolve(),
        loadPersonRegistry: () => Promise.resolve(),
        appListen: (_port, cb) => {
          listenTimes.push(1);
          cb();
        },
        setServerReady: () => {},
        log: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow("DB connection refused");

    expect(
      listenTimes,
      "appListen must NOT be called when runMigrations rejects",
    ).toHaveLength(0);
  });

  it("does NOT call appListen when anchor restore fails (startup-fatal)", async () => {
    const listenTimes: number[] = [];

    await expect(
      startServer({
        port: 0,
        runMigrations: () => Promise.resolve(),
        restoreAnchors: () =>
          Promise.reject(new Error("GCS network error during anchor restore")),
        restoreRosterCsvFromGcs: () => Promise.resolve(),
        loadPersonRegistry: () => Promise.resolve(),
        appListen: (_port, cb) => {
          listenTimes.push(1);
          cb();
        },
        setServerReady: () => {},
        log: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    ).rejects.toThrow("GCS network error during anchor restore");

    expect(
      listenTimes,
      "appListen must NOT be called when restoreAnchors rejects",
    ).toHaveLength(0);
  });

  it("calls setServerReady only after BOTH roster restore AND registry settle", async () => {
    // This test guards the roster-consistency contract:
    // _rosterGcsRestoreAttempted is set at the START of restoreRosterCsvFromGcs(),
    // so any loadRoster() call during a pending restore sees the flag as true,
    // skips the lazy path, and caches the packaged CSV for 15 min.
    // setServerReady() must not fire until the restore has settled, so the first
    // request after readiness always sees the authoritative GCS copy.

    const events: string[] = [];

    let resolveRoster!: () => void;
    const rosterPromise = new Promise<void>((res) => { resolveRoster = res; });

    let resolveRegistry!: () => void;
    const registryPromise = new Promise<void>((res) => { resolveRegistry = res; });

    const serverPromise = startServer({
      port: 0,
      runMigrations: () => Promise.resolve(),
      restoreAnchors: () => Promise.resolve(),
      restoreRosterCsvFromGcs: () => rosterPromise.then(() => { events.push("roster:done"); }),
      loadPersonRegistry: () => registryPromise.then(() => { events.push("registry:done"); }),
      appListen: (_port, cb) => { events.push("listen:open"); cb(); },
      setServerReady: () => { events.push("ready"); },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // Port opens immediately; background tasks are still pending
    await serverPromise;
    expect(events).toEqual(["listen:open"]);

    // Let registry complete first
    resolveRegistry();
    await delay(20);
    expect(
      events,
      "setServerReady must NOT fire before roster restore settles",
    ).not.toContain("ready");

    // Now let roster complete
    resolveRoster();
    await delay(20);
    expect(events).toContain("ready");
    expect(
      events.indexOf("roster:done"),
      "ready must come after roster:done",
    ).toBeLessThan(events.indexOf("ready"));
    expect(
      events.indexOf("registry:done"),
      "ready must come after registry:done",
    ).toBeLessThan(events.indexOf("ready"));
  });

  it("calls setServerReady after roster timeout even when GCS hangs forever", async () => {
    // Regression: if GCS never responds, the server must still become ready
    // (using the packaged fallback) once the timeout fires.
    const events: string[] = [];

    let resolveRegistry!: () => void;
    const registryPromise = new Promise<void>((res) => { resolveRegistry = res; });

    const serverPromise = startServer({
      port: 0,
      runMigrations: () => Promise.resolve(),
      restoreAnchors: () => Promise.resolve(),
      restoreRosterCsvFromGcs: neverResolves, // GCS unreachable
      loadPersonRegistry: () => registryPromise.then(() => { events.push("registry:done"); }),
      rosterRestoreTimeoutMs: 30, // short timeout for the test
      appListen: (_port, cb) => { events.push("listen:open"); cb(); },
      setServerReady: () => { events.push("ready"); },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await serverPromise;
    expect(events).toEqual(["listen:open"]);

    // Let registry complete
    resolveRegistry();
    await delay(50); // wait for the 30 ms timeout + registry + microtasks

    expect(
      events,
      "Server must eventually become ready even when GCS never responds",
    ).toContain("ready");
    expect(
      events.indexOf("registry:done"),
      "ready must come after registry:done",
    ).toBeLessThan(events.indexOf("ready"));
  });
});
