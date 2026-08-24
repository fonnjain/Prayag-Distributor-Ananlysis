import { Router, raw, type Request, type Response } from "express";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as unzipper from "unzipper";
import { isAdminToken } from "../lib/adminAuth.js";
import {
  assertApprovedJul26PsCode3Archive,
  assertJul26PsCode3Controls,
  assertJul26UploadMetadata,
  commitJul26PsCode3Load,
  getLatestJul26LoadProvenance,
  prepareJul26PsCode3Load,
  type Jul26LoadControls,
  type Jul26LoadProvenance,
} from "../lib/secondary/pscode3Jul26.js";
import { logger } from "../lib/logger.js";

const router = Router();
const DRY_RUN_TTL_MS = 30 * 60_000;
const SOURCE_DIR_NAME = "PSCode 3 NEW REPORTS JULY2026";
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

type DryRun = {
  sha256: string;
  controls: Jul26LoadControls;
  expiresAt: number;
  sourceNote: string;
  uploadedBy: string;
  uploadedAt: string;
};
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

function requestText(req: Request, queryName: string, headerName: string): string {
  const queryValue = req.query[queryName];
  const headerValue = req.headers[headerName];
  const value =
    typeof queryValue === "string"
      ? queryValue
      : Array.isArray(headerValue)
        ? headerValue[0]
        : headerValue;
  return typeof value === "string" ? value.trim() : "";
}

function readUploadProvenance(req: Request): Pick<Jul26LoadProvenance, "sourceNote" | "uploadedBy"> {
  return {
    // Raw uploads use query parameters so the binary request body stays an
    // archive. The matching headers make curl/automation less error-prone.
    sourceNote: requestText(req, "source_note", "x-source-note"),
    uploadedBy: requestText(req, "uploaded_by", "x-uploaded-by"),
  };
}

function safeZipEntry(entry: string): boolean {
  const normal = entry.replaceAll("\\", "/");
  return !normal.startsWith("/") && !normal.includes("\0") && !normal.split("/").includes("..");
}

function assertSafeJulyArchiveMetadata(metadata: unzipper.File[]): void {
  const expectedPrefix = `${SOURCE_DIR_NAME}/PSCode_3_New_Report `;

  if (metadata.length !== 163) {
    throw new Error("Archive must contain exactly the 163 approved July workbook entries.");
  }
  let totalUncompressed = 0;
  for (const entry of metadata) {
    const unixFileType = entry.externalFileAttributes >>> 16 & 0o170000;
    if (
      entry.type !== "File" ||
      (unixFileType !== 0 && unixFileType !== 0o100000) ||
      !Number.isFinite(entry.uncompressedSize) ||
      !Number.isFinite(entry.compressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.compressedSize < 0 ||
      entry.uncompressedSize > MAX_ENTRY_BYTES ||
      !safeZipEntry(entry.path) ||
      !entry.path.startsWith(expectedPrefix) ||
      !entry.path.endsWith(".xlsx")
    ) {
      throw new Error("Archive contains an unsupported file type, path, link, or oversized workbook.");
    }
    if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 100) {
      throw new Error("Archive contains an excessively compressed workbook.");
    }
    totalUncompressed += entry.uncompressedSize;
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
  try {
    const archive = await unzipper.Open.buffer(source);
    assertSafeJulyArchiveMetadata(archive.files);
    await archive.extract({ path: workDir });
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

function controlsResponse(
  sha256: string,
  controls: Jul26LoadControls,
  provenance: Pick<Jul26LoadProvenance, "sourceNote" | "uploadedBy" | "uploadedAt">,
) {
  return {
    dryRun: true,
    archiveSha256: sha256,
    commitExpiresAt: new Date(Date.now() + DRY_RUN_TTL_MS).toISOString(),
    provenance,
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
    const { sourceNote, uploadedBy } = readUploadProvenance(req);
    try {
      assertJul26UploadMetadata({ sourceNote, uploadedBy });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Valid upload provenance is required.",
      });
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
        const uploadedAt = new Date().toISOString();
        mostRecentDryRun = {
          sha256,
          controls: prepared.controls,
          expiresAt: Date.now() + DRY_RUN_TTL_MS,
          sourceNote,
          uploadedBy,
          uploadedAt,
        };
        res.json(controlsResponse(sha256, prepared.controls, { sourceNote, uploadedBy, uploadedAt }));
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
    if (
      mostRecentDryRun.sourceNote !== sourceNote ||
      mostRecentDryRun.uploadedBy !== uploadedBy
    ) {
      res.status(409).json({
        error: "source_note and uploaded_by must match the successful dry-run for this archive.",
      });
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
        const result = await commitJul26PsCode3Load(prepared, {
          sourceNote,
          uploadedBy,
          uploadedAt: mostRecentDryRun!.uploadedAt,
          archiveSha256: sha256,
        });
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

router.get("/admin/secondary-sku/jul-26/status", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const latestProvenance = await getLatestJul26LoadProvenance();
    res.json({ ...job, latestProvenance });
  } catch (error) {
    req.log.error({ err: error }, "[secondarySkuJul26] status provenance lookup failed");
    res.status(500).json({ error: "Could not read July raw-SKU load provenance." });
  }
});

export default router;