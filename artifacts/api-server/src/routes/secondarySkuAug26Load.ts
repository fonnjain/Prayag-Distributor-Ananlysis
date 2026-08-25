import { Router, raw, type Request, type Response } from "express";
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isAdminToken } from "../lib/adminAuth.js";
import {
  assertApprovedAug26ProductWiseArchive,
  assertProductWiseAug26Controls,
  assertProductWiseAug26MonthWritable,
  assertProductWiseAug26UploadMetadata,
  AUG26_PRODUCTWISE_SOURCE_FILE,
  commitProductWiseAug26Load,
  commitProductWiseRangeLoad,
  getProductWiseAug26MonthState,
  getProductWiseAug26Freshness,
  getProductWiseMonthFreezeStatus,
  getLatestProductWiseAug26LoadProvenance,
  prepareProductWiseAug26Load,
  prepareProductWiseRangeLoad,
  assertProductWiseRangeControls,
  type ProductWiseAug26Controls,
  type ProductWiseAug26LoadProvenance,
} from "../lib/secondary/productWiseAug26.js";
import { logger } from "../lib/logger.js";

const router = Router();
const DRY_RUN_TTL_MS = 30 * 60_000;
const MAX_WORKBOOK_BYTES = 50 * 1024 * 1024;

type DryRun = {
  sha256: string;
  controls: ProductWiseAug26Controls;
  expiresAt: number;
  sourceNote: string;
  uploadedBy: string;
  sourceFile: string;
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
let mostRecentRangeDryRun: DryRun | null = null;
let rangeJob: LoadJob = { status: "idle", startedAt: null, finishedAt: null, result: null, error: null };

function requireAdmin(req: Request, res: Response): boolean {
  if (!isAdminToken(String(req.headers["x-admin-secret"] ?? "").trim())) {
    res.status(401).json({ error: "Admin authorisation required." });
    return false;
  }
  return true;
}

function requestText(req: Request, queryName: string, headerName: string): string {
  const queryValue = req.query[queryName];
  const headerValue = req.headers[headerName];
  const value = typeof queryValue === "string"
    ? queryValue
    : Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof value === "string" ? value.trim() : "";
}

function provenance(req: Request): Pick<ProductWiseAug26LoadProvenance, "sourceNote" | "uploadedBy" | "sourceFile"> {
  return {
    sourceNote: requestText(req, "source_note", "x-source-note"),
    uploadedBy: requestText(req, "uploaded_by", "x-uploaded-by"),
    sourceFile: requestText(req, "source_file", "x-source-file") || AUG26_PRODUCTWISE_SOURCE_FILE,
  };
}

function digest(workbook: Buffer): string {
  return crypto.createHash("sha256").update(workbook).digest("hex");
}

async function parseAndValidate(workbook: Buffer) {
  if (workbook.length > MAX_WORKBOOK_BYTES) throw new Error("Workbook exceeds the 50 MB source limit.");
  const workDir = await mkdtemp(path.join(tmpdir(), "productwise-aug26-"));
  const filePath = path.join(workDir, "Product-Wise-Secondary-Order-Report.xlsx");
  try {
    await writeFile(filePath, workbook);
    const prepared = await prepareProductWiseAug26Load(filePath);
    assertProductWiseAug26Controls(prepared);
    return prepared;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function parseRangeAndValidate(workbook: Buffer) {
  if (workbook.length > MAX_WORKBOOK_BYTES) throw new Error("Workbook exceeds the 50 MB source limit.");
  const workDir = await mkdtemp(path.join(tmpdir(), "productwise-range-"));
  const filePath = path.join(workDir, "Product-Wise-Secondary-Order-Report.xlsx");
  try {
    await writeFile(filePath, workbook);
    const prepared = await prepareProductWiseRangeLoad(filePath);
    assertProductWiseRangeControls(prepared);
    return prepared;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

router.post(
  "/admin/secondary-sku/aug-26",
  raw({ type: () => true, limit: "50mb" }),
  async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const workbook = req.body as Buffer;
    if (!Buffer.isBuffer(workbook) || workbook.length === 0) {
      res.status(400).json({ error: "Send the Aug-26 Product-Wise XLSX workbook as the raw request body." });
      return;
    }
    const { sourceNote, uploadedBy, sourceFile } = provenance(req);
    try {
      assertProductWiseAug26UploadMetadata({ sourceNote, uploadedBy, sourceFile });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Valid upload provenance is required." });
      return;
    }
    try {
      if ((await getProductWiseAug26Freshness()).status === "frozen_verified") {
        res.status(409).json({ error: "Product-Wise Aug-26 is permanently frozen and cannot be replaced." });
        return;
      }
    } catch (error) {
      res.status(503).json({ error: `Could not determine Product-Wise month state: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const sha256 = digest(workbook);
    try {
      assertApprovedAug26ProductWiseArchive(sha256);
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "Workbook is not approved." });
      return;
    }

    if (req.query["commit"] !== "true") {
      try {
        const prepared = await parseAndValidate(workbook);
        const uploadedAt = new Date().toISOString();
        mostRecentDryRun = {
          sha256,
          controls: prepared.controls,
          expiresAt: Date.now() + DRY_RUN_TTL_MS,
          sourceNote,
          uploadedBy,
          sourceFile,
          uploadedAt,
        };
        res.json({
          dryRun: true,
          workbookSha256: sha256,
          commitExpiresAt: new Date(mostRecentDryRun.expiresAt).toISOString(),
          provenance: { sourceNote, uploadedBy, sourceFile, uploadedAt },
          valueBasis: "Basic Order Value (ex-GST); Dealer Order Value is excluded",
          controls: prepared.controls,
          next: "Re-submit the identical workbook with ?commit=true&confirm=Aug-26&dryRunSha256=<workbookSha256> to start the guarded background load.",
        });
      } catch (error) {
        res.status(422).json({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.query["confirm"] !== "Aug-26") {
      res.status(400).json({ error: "Commit requires confirm=Aug-26." });
      return;
    }
    if (
      req.query["dryRunSha256"] !== sha256 ||
      !mostRecentDryRun ||
      mostRecentDryRun.sha256 !== sha256 ||
      mostRecentDryRun.expiresAt < Date.now()
    ) {
      res.status(409).json({ error: "Run a successful dry-run for this exact workbook within the last 30 minutes before committing." });
      return;
    }
    try {
      assertProductWiseAug26MonthWritable(await getProductWiseAug26MonthState());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(409).json({ error: message });
      return;
    }
    if (
      mostRecentDryRun.sourceNote !== sourceNote ||
      mostRecentDryRun.uploadedBy !== uploadedBy ||
      mostRecentDryRun.sourceFile !== sourceFile
    ) {
      res.status(409).json({ error: "source_note, uploaded_by, and source_file must match the successful dry-run for this workbook." });
      return;
    }
    if (job.status === "running") {
      res.status(409).json({ error: `Aug-26 Product-Wise SKU load already running since ${job.startedAt}.` });
      return;
    }

    job = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
    void (async () => {
      try {
        const prepared = await parseAndValidate(workbook);
        const result = await commitProductWiseAug26Load(prepared, {
          sourceNote,
          uploadedBy,
          uploadedAt: mostRecentDryRun!.uploadedAt,
          archiveSha256: sha256,
          sourceFile,
        });
        job = { ...job, status: "done", finishedAt: new Date().toISOString(), result: { controls: prepared.controls, ...result } };
        logger.info({ sha256, rows: prepared.controls.rows, net: prepared.controls.net }, "[secondarySkuAug26] load completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job = { ...job, status: "failed", finishedAt: new Date().toISOString(), error: message };
        logger.error({ err: error, sha256 }, "[secondarySkuAug26] load failed");
      } finally {
        mostRecentDryRun = null;
      }
    })();

    res.status(202).json({
      ok: true,
      status: "running",
      poll: "/api/admin/secondary-sku/aug-26/status",
      note: "The workbook is held only in a temporary workspace during the guarded load and is then removed.",
    });
  },
);

router.post(
  "/admin/secondary-sku/productwise",
  raw({ type: () => true, limit: "50mb" }),
  async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    const workbook = req.body as Buffer;
    if (!Buffer.isBuffer(workbook) || workbook.length === 0) {
      res.status(400).json({ error: "Send the Product-Wise XLSX workbook as the raw request body." });
      return;
    }
    const sourceNote = requestText(req, "source_note", "x-source-note");
    const uploadedBy = requestText(req, "uploaded_by", "x-uploaded-by");
    const sourceFile = requestText(req, "source_file", "x-source-file");
    try {
      assertProductWiseAug26UploadMetadata({ sourceNote, uploadedBy, sourceFile });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Valid upload provenance is required." });
      return;
    }
    const sha256 = digest(workbook);
    if (req.query["commit"] !== "true") {
      try {
        const prepared = await parseRangeAndValidate(workbook);
        const uploadedAt = new Date().toISOString();
        mostRecentRangeDryRun = {
          sha256, controls: prepared.controls, expiresAt: Date.now() + DRY_RUN_TTL_MS,
          sourceNote, uploadedBy, sourceFile, uploadedAt,
        };
        res.json({
          dryRun: true,
          workbookSha256: sha256,
          commitExpiresAt: new Date(mostRecentRangeDryRun.expiresAt).toISOString(),
          provenance: { sourceNote, uploadedBy, sourceFile, uploadedAt },
          controls: prepared.controls,
          next: "Re-submit the identical workbook with ?commit=true&confirm=productwise-range&dryRunSha256=<workbookSha256>.",
        });
      } catch (error) {
        res.status(422).json({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (req.query["confirm"] !== "productwise-range") {
      res.status(400).json({ error: "Commit requires confirm=productwise-range." });
      return;
    }
    if (
      req.query["dryRunSha256"] !== sha256 ||
      !mostRecentRangeDryRun ||
      mostRecentRangeDryRun.sha256 !== sha256 ||
      mostRecentRangeDryRun.expiresAt < Date.now() ||
      mostRecentRangeDryRun.sourceNote !== sourceNote ||
      mostRecentRangeDryRun.uploadedBy !== uploadedBy ||
      mostRecentRangeDryRun.sourceFile !== sourceFile
    ) {
      res.status(409).json({ error: "Run a matching successful dry-run for this exact workbook within the last 30 minutes." });
      return;
    }
    if (rangeJob.status === "running") {
      res.status(409).json({ error: `Product-Wise range load already running since ${rangeJob.startedAt}.` });
      return;
    }
    const uploadedAt = mostRecentRangeDryRun.uploadedAt;
    rangeJob = { status: "running", startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
    void (async () => {
      try {
        const prepared = await parseRangeAndValidate(workbook);
        const result = await commitProductWiseRangeLoad(prepared, {
          sourceNote, uploadedBy, sourceFile, uploadedAt, archiveSha256: sha256,
        });
        rangeJob = { ...rangeJob, status: "done", finishedAt: new Date().toISOString(), result: { controls: prepared.controls, ...result } };
        logger.info({ sha256, months: result.months }, "[productwise] range load completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rangeJob = { ...rangeJob, status: "failed", finishedAt: new Date().toISOString(), error: message };
        logger.error({ err: error, sha256 }, "[productwise] range load failed");
      } finally {
        mostRecentRangeDryRun = null;
      }
    })();
    res.status(202).json({
      ok: true,
      status: "running",
      poll: "/api/admin/secondary-sku/productwise/status",
      note: "Frozen months are logged and skipped; open months are replaced transactionally.",
    });
  },
);

router.get("/admin/secondary-sku/aug-26/status", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const [latestProvenance, freezeStatus, freshness] = await Promise.all([
      getLatestProductWiseAug26LoadProvenance(),
      getProductWiseMonthFreezeStatus(),
      getProductWiseAug26Freshness(),
    ]);
    res.json({ ...job, latestProvenance, freezeStatus, freshness });
  } catch (error) {
    req.log.error({ err: error }, "[secondarySkuAug26] status provenance lookup failed");
    res.status(500).json({ error: "Could not read August Product-Wise SKU load provenance." });
  }
});

router.get("/admin/secondary-sku/productwise/status", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const freezeStatus = await getProductWiseMonthFreezeStatus();
    res.json({ ...rangeJob, freezeStatus });
  } catch (error) {
    req.log.error({ err: error }, "[productwise] status lookup failed");
    res.status(500).json({ error: "Could not read Product-Wise freeze status." });
  }
});

export default router;