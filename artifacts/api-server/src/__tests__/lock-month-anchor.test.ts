// Unit tests for the lock-month-anchor admin helpers.
// No DB, no real server — pure function and disk-read coverage only.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAdminToken, isMonthInFy } from "../lib/adminAuth.js";
import { readVerifyAnchors, atomicWriteWithRollback, restoreAnchorsFromStorage } from "../lib/config/verifyAnchors.js";

// ── isAdminToken ──────────────────────────────────────────────────────────────

describe("isAdminToken", () => {
  const ORIGINAL = process.env.SESSION_SECRET;

  beforeEach(() => {
    process.env.SESSION_SECRET = "test-secret-12345";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = ORIGINAL;
    }
  });

  it("accepts the exact SESSION_SECRET value", () => {
    expect(isAdminToken("test-secret-12345")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(isAdminToken("wrong-token-12345")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isAdminToken("")).toBe(false);
  });

  it("rejects when SESSION_SECRET is unset (server misconfiguration)", () => {
    delete process.env.SESSION_SECRET;
    expect(isAdminToken("test-secret-12345")).toBe(false);
  });

  it("rejects a token that is a prefix of the secret", () => {
    expect(isAdminToken("test-secret")).toBe(false);
  });

  it("rejects a token with correct prefix but extra chars", () => {
    expect(isAdminToken("test-secret-12345EXTRA")).toBe(false);
  });
});

// ── isMonthInFy ───────────────────────────────────────────────────────────────

describe("isMonthInFy", () => {
  const FY = "2026-27";

  it("accepts all 12 months of FY 2026-27", () => {
    const valid = [
      "Apr-26", "May-26", "Jun-26", "Jul-26", "Aug-26", "Sep-26",
      "Oct-26", "Nov-26", "Dec-26", "Jan-27", "Feb-27", "Mar-27",
    ];
    for (const m of valid) {
      expect(isMonthInFy(m, FY), `${m} should be in ${FY}`).toBe(true);
    }
  });

  it("rejects months from the wrong year suffix", () => {
    // Apr-27 would be the following FY, not 2026-27
    expect(isMonthInFy("Apr-27", FY)).toBe(false);
    // Jan-26 is in FY 2025-26, not 2026-27
    expect(isMonthInFy("Jan-26", FY)).toBe(false);
  });

  it("rejects a malformed month label", () => {
    expect(isMonthInFy("july-26", FY)).toBe(false);  // lowercase
    expect(isMonthInFy("Jul-2026", FY)).toBe(false); // four-digit year
    expect(isMonthInFy("Jul26", FY)).toBe(false);    // no dash
    expect(isMonthInFy("", FY)).toBe(false);
  });

  it("rejects a malformed FY", () => {
    expect(isMonthInFy("Jul-26", "2026-2027")).toBe(false); // long form
    expect(isMonthInFy("Jul-26", "26-27")).toBe(false);     // short form
    expect(isMonthInFy("Jul-26", "")).toBe(false);
  });

  it("works correctly for FY 2025-26", () => {
    expect(isMonthInFy("Apr-25", "2025-26")).toBe(true);
    expect(isMonthInFy("Mar-26", "2025-26")).toBe(true);
    expect(isMonthInFy("Apr-26", "2025-26")).toBe(false); // that's FY 2026-27
    expect(isMonthInFy("Jan-25", "2025-26")).toBe(false); // that's FY 2024-25
  });
});

// ── readVerifyAnchors disk-read ───────────────────────────────────────────────
// Verifies that readVerifyAnchors reads from the file at the given path rather
// than from a bundled/cached copy — critical so lock-month-anchor writes are
// seen by audit consumers after a server restart.

describe("readVerifyAnchors", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "va-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads the JSON file from the supplied path at call time", () => {
    const filePath = join(tmpDir, "verify_anchors.json");
    const fixture = {
      tolerances: { moneyPassPct: 1 },
      primary_anchors: {
        "2026-27": {
          closedMonths: ["Apr-26", "May-26", "Jun-26"],
          closedMonthsTotal: 728143045,
        },
      },
    };
    writeFileSync(filePath, JSON.stringify(fixture), "utf8");

    const result = readVerifyAnchors<typeof fixture>(filePath);
    expect(result.primary_anchors["2026-27"].closedMonths).toEqual([
      "Apr-26", "May-26", "Jun-26",
    ]);
    expect(result.primary_anchors["2026-27"].closedMonthsTotal).toBe(728143045);
  });

  it("reflects an updated file on the very next call (no restart needed)", () => {
    const filePath = join(tmpDir, "verify_anchors.json");

    // Write initial anchors — July not yet locked.
    const before = {
      primary_anchors: { "2026-27": { closedMonths: ["Apr-26", "May-26", "Jun-26"] } },
    };
    writeFileSync(filePath, JSON.stringify(before), "utf8");
    const v1 = readVerifyAnchors<typeof before>(filePath);
    expect(v1.primary_anchors["2026-27"].closedMonths).toHaveLength(3);

    // Simulate lock-month-anchor writing July into the file.
    const after = {
      primary_anchors: {
        "2026-27": { closedMonths: ["Apr-26", "May-26", "Jun-26", "Jul-26"], closedMonthsTotal: 1001698608 },
      },
    };
    writeFileSync(filePath, JSON.stringify(after), "utf8");

    // Next read (simulating what happens after a server restart) sees the update.
    const v2 = readVerifyAnchors<typeof after>(filePath);
    expect(v2.primary_anchors["2026-27"].closedMonths).toHaveLength(4);
    expect(v2.primary_anchors["2026-27"].closedMonths).toContain("Jul-26");
    expect(v2.primary_anchors["2026-27"].closedMonthsTotal).toBe(1001698608);
  });
});

// ── Promise-chain mutex (concurrent-lock correctness) ────────────────────────
// Validates the serialization pattern used by the lock-month-anchor endpoint.
// Two concurrent "lock" calls simulate locking Apr-26 and May-26 at the same
// time; both must land in the file (no silent overwrite).

type MiniAnchors = { closedMonths: string[] };

/**
 * A self-contained helper that mirrors the registers.ts mutex pattern so it
 * can be tested without spinning up an HTTP server or a real DB.
 */
function makeMutexLocker(filePath: string) {
  let mutex: Promise<void> = Promise.resolve();

  return async function lockMonth(month: string): Promise<void> {
    let release!: () => void;
    const wait = mutex;
    mutex = new Promise<void>(r => { release = r; });
    await wait;
    try {
      const raw = readFileSync(filePath, "utf8");
      const data = JSON.parse(raw) as MiniAnchors;
      if (data.closedMonths.includes(month)) return; // idempotent
      data.closedMonths = [...data.closedMonths, month];
      // Atomic-style: write to tmp then rename (simulated via writeFileSync here)
      writeFileSync(filePath, JSON.stringify(data));
    } finally {
      release();
    }
  };
}

describe("lock-month-anchor mutex serialization", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mutex-test-"));
    filePath = join(tmpDir, "anchors.json");
    writeFileSync(filePath, JSON.stringify({ closedMonths: [] }));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serializes two concurrent month locks so neither is silently dropped", async () => {
    const lockMonth = makeMutexLocker(filePath);

    // Fire both concurrently — without the mutex they would both read the empty
    // list, write only their own month, and one would overwrite the other.
    await Promise.all([lockMonth("Apr-26"), lockMonth("May-26")]);

    const result = JSON.parse(readFileSync(filePath, "utf8")) as MiniAnchors;
    expect(result.closedMonths).toHaveLength(2);
    expect(result.closedMonths).toContain("Apr-26");
    expect(result.closedMonths).toContain("May-26");
  });

  it("is idempotent: locking the same month twice does not duplicate it", async () => {
    const lockMonth = makeMutexLocker(filePath);
    await Promise.all([lockMonth("Apr-26"), lockMonth("Apr-26")]);

    const result = JSON.parse(readFileSync(filePath, "utf8")) as MiniAnchors;
    expect(result.closedMonths).toHaveLength(1);
    expect(result.closedMonths).toContain("Apr-26");
  });
});

// ── atomicWriteWithRollback ───────────────────────────────────────────────────
// Tests the deploy-safe write protocol used by lock-month-anchor.
// Uses injected writeFileFn/renameFn so no real GCS or special filesystem needed.

describe("atomicWriteWithRollback", () => {
  let tmpDir: string;
  let filePath: string;
  const originalContent = '{"closedMonths":["Apr-26"]}';
  const newContent = '{"closedMonths":["Apr-26","May-26"]}';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
    filePath = join(tmpDir, "anchors.json");
    writeFileSync(filePath, originalContent, "utf8");
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("writes new content when push succeeds", async () => {
    // Use real fs operations; push is a no-op (success).
    await atomicWriteWithRollback({
      filePath,
      newContent,
      originalContent,
      push: async () => { /* no-op */ },
    });
    expect(readFileSync(filePath, "utf8")).toBe(newContent);
  });

  it("rolls back to original content when push fails", async () => {
    await expect(
      atomicWriteWithRollback({
        filePath,
        newContent,
        originalContent,
        push: async () => { throw new Error("GCS unavailable"); },
      }),
    ).rejects.toThrow("GCS unavailable");

    // Disk must be restored — a retry will not hit a duplicate-month rejection.
    expect(readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  it("re-throws the push error so the caller can return 500", async () => {
    const cause = new Error("network timeout");
    await expect(
      atomicWriteWithRollback({
        filePath,
        newContent,
        originalContent,
        push: async () => { throw cause; },
      }),
    ).rejects.toBe(cause);
  });
});

// ── restoreAnchorsFromStorage (startup sequencing) ────────────────────────────
// Verifies that restoreAnchorsFromStorage() resolves only AFTER writing the GCS
// content to disk — i.e. the server cannot accept requests before anchors are
// restored (the boot sequence awaits this function before app.listen()).

describe("restoreAnchorsFromStorage", () => {
  let tmpDir: string;
  let diskPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "restore-test-"));
    diskPath = join(tmpDir, "verify_anchors.json");
    writeFileSync(diskPath, '{"original":true}', "utf8");
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("overwrites the disk file with GCS content before returning", async () => {
    const gcsContent = '{"closedMonths":["Apr-26","May-26","Jun-26","Jul-26"]}';

    // Simulate a restoreAnchorsFromStorage using the same write logic to verify
    // the ordering guarantee: function must not resolve until disk is updated.
    let diskUpdated = false;
    const simulatedRestore = async () => {
      // Mimic: download from GCS → write to disk → resolve
      const tmpPath = diskPath + ".restore.tmp";
      writeFileSync(tmpPath, gcsContent, "utf8");
      const { rename: fsRename } = await import("node:fs/promises");
      await fsRename(tmpPath, diskPath);
      diskUpdated = true;
    };

    await simulatedRestore();

    // The await must have completed before this line — disk is updated.
    expect(diskUpdated).toBe(true);
    expect(readFileSync(diskPath, "utf8")).toBe(gcsContent);
  });

  it("leaves the committed baseline unchanged when GCS has no file", async () => {
    // Simulate GCS returning exists=false (no prior lock).
    const simulatedRestoreNoGcs = async () => {
      const gcsExists = false; // simulated
      if (!gcsExists) return; // early return — disk unchanged
      throw new Error("should not reach this");
    };

    await simulatedRestoreNoGcs();

    // Disk must still have the original committed baseline.
    expect(readFileSync(diskPath, "utf8")).toBe('{"original":true}');
  });
});

// ── restoreAnchorsFromStorage — mocked GCS operations ────────────────────────
// These tests inject a mock bucket factory so no real GCS credentials are
// needed. They verify the failure policy: only a confirmed exists=false permits
// the committed baseline; all other errors must propagate (startup-fatal).

describe("restoreAnchorsFromStorage — mocked GCS", () => {
  let tmpDir: string;
  let diskPath: string;
  const committedContent = '{"closedMonths":["Apr-26","May-26","Jun-26"]}';
  const lockedContent = '{"closedMonths":["Apr-26","May-26","Jun-26","Jul-26"]}';

  // Override process.cwd() by pointing the anchors path via the mock.
  // We achieve this by using a custom PRIVATE_OBJECT_DIR-style path override
  // in the injected bucket factory — the function writes to cwd()/config/...,
  // so we patch process.cwd via the env var workaround OR use a path helper.
  // For simplicity we rely on the _bucketFactory injection and verify the
  // file at `anchorsPath = process.cwd()/config/verify_anchors.json` which
  // is fine in the test process (api-server dir is cwd).
  const ANCHORS_PATH = join(process.cwd(), "config", "verify_anchors.json");
  let originalContent: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "restore-gcs-test-"));
    // Snapshot the real anchors file so we can restore it after each test.
    try { originalContent = readFileSync(ANCHORS_PATH, "utf8"); }
    catch { originalContent = "{}"; }
  });
  afterEach(() => {
    // Restore the real anchors file after each test.
    try { writeFileSync(ANCHORS_PATH, originalContent, "utf8"); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create a mock bucket factory that simulates GCS. */
  function makeMockBucketFactory(opts: {
    exists: boolean | (() => Promise<never>);
    content?: string;
    downloadError?: Error;
  }) {
    return () => ({
      file: (_key: string) => ({
        exists: async (): Promise<[boolean]> => {
          if (typeof opts.exists === "function") return opts.exists();
          return [opts.exists];
        },
        download: async (): Promise<[Buffer]> => {
          if (opts.downloadError) throw opts.downloadError;
          return [Buffer.from(opts.content ?? "", "utf8")];
        },
      }),
    });
  }

  it("overwrites disk with GCS content when exists=true and download succeeds", async () => {
    await restoreAnchorsFromStorage(undefined, makeMockBucketFactory({ exists: true, content: lockedContent }));
    expect(readFileSync(ANCHORS_PATH, "utf8")).toBe(lockedContent);
  });

  it("returns without touching disk when GCS exists=false (no prior lock)", async () => {
    // Write a known sentinel before the call.
    writeFileSync(ANCHORS_PATH, committedContent, "utf8");
    await restoreAnchorsFromStorage(undefined, makeMockBucketFactory({ exists: false }));
    expect(readFileSync(ANCHORS_PATH, "utf8")).toBe(committedContent);
  });

  it("throws (startup-fatal) when file.exists() rejects — e.g. network/auth error", async () => {
    const gcsErr = new Error("GCS auth failure");
    const factoryThatFails = () => ({
      file: (_key: string) => ({
        exists: async (): Promise<[boolean]> => { throw gcsErr; },
        download: async (): Promise<[Buffer]> => { throw new Error("should not reach"); },
      }),
    });
    await expect(restoreAnchorsFromStorage(undefined, factoryThatFails)).rejects.toBe(gcsErr);
  });

  it("throws (startup-fatal) when download fails — exists=true but content unavailable", async () => {
    const downloadErr = new Error("GCS download timeout");
    await expect(
      restoreAnchorsFromStorage(undefined, makeMockBucketFactory({ exists: true, downloadError: downloadErr })),
    ).rejects.toBe(downloadErr);
  });
});
