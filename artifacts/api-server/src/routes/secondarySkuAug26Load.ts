import { Router, raw, type Request, type Response } from "express";
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isAdminToken } from "../lib/adminAuth.js";
import {
  assertApprovedAug26ProductWiseArchive,
  assertProductWiseAug26Controls,
  assertProductWiseAug26UploadMetadata,
  commitProductWiseAug26Load,
  getLatestProductWiseAug26LoadProvenance,
  prepareProductWiseAug26Load,
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

function requestText(req: Request, queryName: string, headerName: string): string {
  const queryValue = req.query[queryName];
  const headerValue = req.headers[headerName];
  const value = typeof queryValue === "string"
    ? queryValue
    : Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof value === "string" ? value.trim() : "";
}

function provenance(req: Request): Pick<ProductWiseAug26LoadProvenance, "sourceNote" | "uploadedBy"> {
  return {
    sourceNote: requestText(req, "source_note", "x-source-note"),
    uploadedBy: requestText(req, "uploaded_by", "x-uploaded-by"),
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
    const { sourceNote, uploadedBy } = provenance(req);
    try {
      assertProductWiseAug26UploadMetadata({ sourceNote, uploadedBy });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Valid upload provenance is required." });
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
          uploadedAt,
        };
        res.json({
          dryRun: true,
          workbookSha256: sha256,
          commitExpiresAt: new Date(mostRecentDryRun.expiresAt).toISOString(),
          provenance: { sourceNote, uploadedBy, uploadedAt },
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
    if (mostRecentDryRun.sourceNote !== sourceNote || mostRecentDryRun.uploadedBy !== uploadedBy) {
      res.status(409).json({ error: "source_note and uploaded_by must match the successful dry-run for this workbook." });
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

router.get("/admin/secondary-sku/aug-26/status", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const latestProvenance = await getLatestProductWiseAug26LoadProvenance();
    res.json({ ...job, latestProvenance });
  } catch (error) {
    req.log.error({ err: error }, "[secondarySkuAug26] status provenance lookup failed");
    res.status(500).json({ error: "Could not read August Product-Wise SKU load provenance." });
  }
});

export default router;