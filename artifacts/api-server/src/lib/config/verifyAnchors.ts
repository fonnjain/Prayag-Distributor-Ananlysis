/**
 * Runtime loader and deploy-safe persistence for verify_anchors.json.
 *
 * DEPLOY-SAFE ARCHITECTURE
 * ========================
 * The committed `config/verify_anchors.json` is the baseline config (Apr–Jun
 * anchors etc.). When an admin locks a new month via POST /lock-month-anchor
 * the update is written to two places:
 *
 *   1. Disk   – `<cwd>/config/verify_anchors.json` (serves the current process
 *               immediately via per-invocation readVerifyAnchors() calls)
 *   2. Object Storage (GCS) – key `config/verify_anchors.json` (survives
 *               deploys; restored to disk on every server startup)
 *
 * On startup, restoreAnchorsFromStorage() runs once before any requests are
 * handled. If GCS holds a newer anchors file the committed baseline is
 * overwritten on disk, so audit consumers always see the locked values even
 * after a fresh deploy.
 *
 * sync callers (readVerifyAnchors) remain synchronous — they always read from
 * the local disk copy which is guaranteed up-to-date at call time because:
 *   a) startup restore runs before the server accepts requests, and
 *   b) lock-month-anchor writes to disk before returning 200.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { objectStorageClient } from "../objectStorage.js";

const GCS_ANCHOR_KEY = "config/verify_anchors.json";

/**
 * Resolve the on-disk path of verify_anchors.json regardless of the process
 * working directory. In development the server runs with cwd =
 * artifacts/api-server (file at <cwd>/config/...); in the deployed monorepo
 * the process starts from the REPO ROOT (`node artifacts/api-server/dist/...`),
 * where the file lives at <cwd>/artifacts/api-server/config/... . Resolving
 * only against cwd caused ENOENT + /api/dashboard 500s in production.
 */
export function anchorsFilePath(): string {
  const direct = path.join(process.cwd(), "config", "verify_anchors.json");
  if (existsSync(direct)) return direct;
  const monorepo = path.join(process.cwd(), "artifacts", "api-server", "config", "verify_anchors.json");
  if (existsSync(monorepo)) return monorepo;
  // Neither exists yet (e.g. first GCS restore writing the file): prefer the
  // location whose parent config/ directory exists.
  if (existsSync(path.dirname(monorepo))) return monorepo;
  return direct;
}

function getBucket() {
  const bucketId = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"];
  if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID is not set");
  return objectStorageClient.bucket(bucketId);
}

/**
 * Called once at server startup — must be awaited before app.listen().
 *
 * If Object Storage has a copy of verify_anchors.json (written by a previous
 * lock-month-anchor call in any deployment) it is restored to disk so the
 * committed baseline is not silently used instead.
 *
 * FAILURE POLICY
 * ──────────────
 * • `exists === false` → safe to use the committed baseline (no lock has ever
 *   been written to GCS). Returns normally.
 * • Any other error (network, auth, download, disk-write failure) → throws.
 *   The caller in index.ts must treat this as startup-fatal: a transient GCS
 *   outage during startup would otherwise silently revert a locked audit
 *   baseline to the committed pre-lock config — a data-integrity failure.
 *
 * Injecting `_bucketFactory` replaces the real GCS bucket, enabling unit tests
 * without live credentials. Pass `undefined` (or omit) in production.
 */
export async function restoreAnchorsFromStorage(
  log?: { info: (msg: string) => void; warn: (msg: string) => void },
  _bucketFactory?: () => { file: (key: string) => { exists: () => Promise<[boolean]>; download: () => Promise<[Buffer]> } },
): Promise<void> {
  const bucket = _bucketFactory ? _bucketFactory() : getBucket();
  const file = bucket.file(GCS_ANCHOR_KEY);

  // A confirmed "not present" is the only non-error condition that allows the
  // committed baseline. All other outcomes (network errors, download failure,
  // disk write failure) are re-thrown so the startup chain exits the process.
  const [exists] = await file.exists(); // throws on network/auth error → fatal
  if (!exists) {
    log?.info("verify_anchors: no GCS copy found, using committed baseline");
    return;
  }

  const [content] = await file.download(); // throws on failure → fatal
  const anchorsPath = anchorsFilePath();
  const tmpPath = anchorsPath + ".restore.tmp";
  mkdirSync(path.dirname(anchorsPath), { recursive: true }); // first restore may pre-date the config dir
  writeFileSync(tmpPath, content); // throws on disk failure → fatal
  const { rename: renameSync } = await import("node:fs/promises");
  await renameSync(tmpPath, anchorsPath); // throws on rename failure → fatal
  log?.info("verify_anchors: restored from GCS (locked anchors active)");
}

/**
 * Called by lock-month-anchor after writing to disk.
 * Pushes the current on-disk content to Object Storage so it survives the
 * next deployment.
 *
 * Throws on failure — the caller should surface this as a 500 so the operator
 * knows the lock was NOT made durable and must retry.
 */
export async function pushAnchorsToStorage(): Promise<void> {
  const anchorsPath = anchorsFilePath();
  const content = readFileSync(anchorsPath, "utf8");
  const file = getBucket().file(GCS_ANCHOR_KEY);
  await file.save(content, { contentType: "application/json" });
}

/**
 * Atomically writes `newContent` to `filePath` (via temp + rename), then calls
 * `push()` to make the change durable (e.g. Object Storage).
 *
 * If `push()` throws the disk write is rolled back atomically to `originalContent`
 * so the caller's next retry is not blocked by a stale on-disk state.  The
 * original push error is re-thrown so the caller can surface it as 500.
 *
 * Pure function with injected I/O — designed for unit testing without a real
 * filesystem or storage client.  The `fs.*` operations default to the real
 * `node:fs/promises` implementations; tests can inject lightweight stubs.
 */
export async function atomicWriteWithRollback(opts: {
  filePath: string;
  newContent: string;
  originalContent: string;
  push: () => Promise<void>;
  /** Injected for testing; defaults to `node:fs/promises.writeFile` */
  writeFileFn?: (path: string, data: string, enc: "utf8") => Promise<void>;
  /** Injected for testing; defaults to `node:fs/promises.rename` */
  renameFn?: (src: string, dst: string) => Promise<void>;
}): Promise<void> {
  const { filePath, newContent, originalContent, push,
    writeFileFn = writeFile, renameFn = rename } = opts;

  const tmpPath = filePath + `.tmp.${process.pid}`;

  // Step 1: atomic disk write.
  await writeFileFn(tmpPath, newContent, "utf8");
  await renameFn(tmpPath, filePath);

  // Step 2: durable push. On failure → atomic rollback so retry is safe.
  try {
    await push();
  } catch (pushErr) {
    const rollbackTmp = filePath + `.rollback.${process.pid}`;
    try {
      await writeFileFn(rollbackTmp, originalContent, "utf8");
      await renameFn(rollbackTmp, filePath);
    } catch (_rbErr) {
      // Rollback itself failed — disk may be inconsistent. Caller should log.
    }
    throw pushErr;
  }
}

/**
 * Read verify_anchors.json from disk (synchronous).
 *
 * @param overridePath - Optional absolute path to a JSON file. Used in tests
 *   to point at a temporary fixture instead of the live config. When omitted,
 *   defaults to `<cwd>/config/verify_anchors.json`.
 */
export function readVerifyAnchors<T = Record<string, unknown>>(overridePath?: string): T {
  const filePath = overridePath ?? anchorsFilePath();
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

