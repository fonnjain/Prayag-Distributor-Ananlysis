import { Router, raw, type Request, type Response } from "express";
import crypto from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isAdminToken } from "../lib/adminAuth.js";
import {
  assertApprovedJul26PsCode3Archive,
  assertJul26PsCode3Controls,
  commitJul26PsCode3Load,
  prepareJul26PsCode3Load,
  type Jul26LoadControls,
} from "../lib/secondary/pscode3Jul26.js";
import { logger } from "../lib/logger.js";

const router = Router();
const execFile = promisify(execFileCallback);
const DRY_RUN_TTL_MS = 30 * 60_000;
const SOURCE_DIR_NAME = "PSCode 3 NEW REPORTS JULY2026";
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

type DryRun = { sha256: string; controls: Jul26LoadControls; expiresAt: number };
type LoadJob = {
  status: "idle" | "running" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
};

let mostRecentDryRun: DryRun | null = null;
let job: LoadJob = { status: "idle", startedAt: null, finishedAt: null, result: null, error: null };

function requireAdmin(req: Request, res: Response): boolean {
  if (!isAdminToken(String(req.headers["x-admin-secret"] ?? "").trim())) {
    res.status(401).json({ error: "Admin authorisation required." });
    return false;
  }
  return true;
}

function archiveDigest(source: Buffer): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function safeZipEntry(entry: string): boolean {
  const normal = entry.replaceAll("\\", "/");
  return !normal.startsWith("/") && !normal.includes("\0") && !normal.split("/").includes("..");
}

function assertSafeJulyArchiveMetadata(listOutput: string, metadataOutput: string): void {
  const entryNames = listOutput.split(/\r?\n/).filter(Boolean);
  const metadata = metadataOutput
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0]?.startsWith("-"))
    .map((parts) => ({
      mode: parts[0]!,
      uncompressedBytes: Number(parts[3]),
      compressedBytes: Number(parts[5]),
      name: parts.slice(9).join(" "),
    }));
  const expectedPrefix = `${SOURCE_DIR_NAME}/PSCode_3_New_Report `;

  if (entryNames.length !== 163 || metadata.length !== 163 || entryNames.length !== metadata.length) {
    throw new Error("Archive must contain exactly the 163 approved July workbook entries.");
  }
  let totalUncompressed = 0;
  for (const entry of metadata) {
    if (
      !entry.mode.startsWith("-") ||
      !Number.isFinite(entry.uncompressedBytes) ||
      !Number.isFinite(entry.compressedBytes) ||
      entry.uncompressedBytes < 0 ||
      entry.compressedBytes < 0 ||
      entry.uncompressedBytes > MAX_ENTRY_BYTES ||
      !safeZipEntry(entry.name) ||
      !entry.name.startsWith(expectedPrefix) ||
      !entry.name.endsWith(".xlsx")
    ) {
      throw new Error("Archive contains an unsupported file type, path, link, or oversized workbook.");
    }
    if (entry.compressedBytes > 0 && entry.uncompressedBytes / entry.compressedBytes > 100) {
      throw new Error("Archive contains an excessively compressed workbook.");
    }
    totalUncompressed += entry.uncompressedBytes;
  }
  if (totalUncompressed > MAX_EXTRACTED_BYTES) {
    throw new Error("Archive expands beyond the approved July source size limit.");
  }
}

async function withExtractedArchive<T>(source: Buffer, run: (directory: string) => Promise<T>): Promise<T> {
  if (source.length > MAX_ARCHIVE_BYTES) {
    throw new Error("Archive exceeds the 10 MB July source limit.");
  }
  const workDir = await mkdtemp(path.join(tmpdir(), "pscode3-jul26-"));
  const archivePath = path.join(workDir, "source.zip");
  try {
    await writeFile(archivePath, source, { mode: 0o600 });
    const [{ stdout: listOutput }, { stdout: metadataOutput }] = await Promise.all([
      execFile("unzip", ["-Z", "-1", archivePath], {
        timeout: 20_000,
        maxBuffer: 2_000_000,
      }),
      execFile("unzip", ["-Z", "-l", archivePath], {
        timeout: 20_000,
        maxBuffer: 2_000_000,
      }),
    ]);
    assertSafeJulyArchiveMetadata(String(listOutput), String(metadataOutput));
    await execFile("unzip", ["-qq", archivePath, "-d", workDir], {
      timeout: 20_000,
      maxBuffer: 2_000_000,
    });
    const directory = path.join(workDir, SOURCE_DIR_NAME);
    if (!existsSync(directory)) {
      throw new Error(`Archive must contain the '${SOURCE_DIR_NAME}' directory.`);
    }
    const [resolvedWorkDir, resolvedDirectory] = await Promise.all([realpath(workDir), realpath(directory)]);
    if (!resolvedDirectory.startsWith(`${resolvedWorkDir}${path.sep}`)) {
      throw new Error("Archive extraction escaped its temporary workspace.");
    }
    return await run(directory);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function parseAndValidate(source: Buffer) {
  return withExtractedArchive(source, async (directory) => {
    const prepared = await prepareJul26PsCode3Load(directory);
    assertJul26PsCode3Controls(prepared);
    return prepared;
  });
}

function controlsResponse(sha256: string, controls: Jul26LoadControls) {
  return {
    dryRun: true,
    archiveSha256: sha256,
    commitExpiresAt: new Date(Date.now() + DRY_RUN_TTL_MS).toISOString(),
    controls,
    next: "Re-submit the identical archive with ?commit=true&confirm=Jul-26&dryRunSha256=<archiveSha256> to start the guarded background load.",
  };
}

router.post(
  "/admin/secondary-sku/jul-26",
  raw({ type: () => true, limit: "80mb" }),
  async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const source = req.body as Buffer;
    if (!Buffer.isBuffer(source) || source.length === 0) {
      res.status(400).json({ error: "Send the July PSCode_3 ZIP archive as the raw request body." });
      return;
    }
    const sha256 = archiveDigest(source);
    try {
      assertApprovedJul26PsCode3Archive(sha256);
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "Archive is not approved." });
      return;
    }
    const commit = req.query["commit"] === "true";

    if (!commit) {
      try {
        const prepared = await parseAndValidate(source);
        mostRecentDryRun = { sha256, controls: prepared.controls, expiresAt: Date.now() + DRY_RUN_TTL_MS };
        res.json(controlsResponse(sha256, prepared.controls));
      } catch (error) {
        res.status(422).json({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.query["confirm"] !== "Jul-26") {
      res.status(400).json({ error: "Commit requires confirm=Jul-26." });
      return;
    }
    if (req.query["dryRunSha256"] !== sha256 || !mostRecentDryRun || mostRecentDryRun.sha256 !== sha256 || mostRecentDryRun.expiresAt < Date.now()) {
      res.status(409).json({ error: "Run a successful dry-run for this exact archive within the last 30 minutes before committing." });
      return;
    }
    if (job.status === "running") {
      res.status(409).json({ error: `Jul-26 SKU load already running since ${job.startedAt}.` });
      return;
    }

    job = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
    void (async () => {
      try {
        const prepared = await parseAndValidate(source);
        const result = await commitJul26PsCode3Load(prepared);
        job = { ...job, status: "done", finishedAt: new Date().toISOString(), result: { controls: prepared.controls, ...result } };
        logger.info({ sha256, rows: prepared.controls.rows, net: prepared.controls.net }, "[secondarySkuJul26] load completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job = { ...job, status: "failed", finishedAt: new Date().toISOString(), error: message };
        logger.error({ err: error, sha256 }, "[secondarySkuJul26] load failed");
      } finally {
        mostRecentDryRun = null;
      }
    })();

    res.status(202).json({
      ok: true,
      status: "running",
      poll: "/api/admin/secondary-sku/jul-26/status",
      note: "The archive is stored only in a temporary local workspace for this background load and is removed when processing finishes.",
    });
  },
);

router.get("/admin/secondary-sku/jul-26/status", (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  res.json(job);
});

export default router;