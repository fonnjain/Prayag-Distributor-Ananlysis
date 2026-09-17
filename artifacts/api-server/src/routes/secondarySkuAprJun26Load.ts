import { Router, raw, type Request, type Response } from "express";
import crypto from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as unzipper from "unzipper";
import { isAdminToken } from "../lib/adminAuth.js";
import { logger } from "../lib/logger.js";
import {
  assertApprovedAprJunArchive,
  assertAprJunControls,
  commitAprJunPsCode3Load,
  latestAprJunProvenance,
  prepareAprJunPsCode3Load,
  preflightAprJun,
  type AprJunControls,
} from "../lib/secondary/pscode3AprJun26.js";

const router = Router();
const TTL = 30 * 60_000;
const ROOT = "PSCODE 3 NEW REPORT";
const MAX_ARCHIVE = 10 * 1024 * 1024;
const MAX_ENTRY = 2 * 1024 * 1024;
const MAX_EXTRACTED = 50 * 1024 * 1024;
type DryRun = {
  sha256: string;
  controls: AprJunControls;
  expiresAt: number;
  sourceNote: string;
  uploadedBy: string;
  uploadedAt: string;
  preflight: unknown;
};
type Job = {
  status: "idle" | "running" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
};
let dry: DryRun | null = null;
let job: Job = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};
const digest = (b: Buffer) =>
  crypto.createHash("sha256").update(b).digest("hex");
function admin(req: Request, res: Response) {
  if (!isAdminToken(String(req.headers["x-admin-secret"] ?? "").trim())) {
    res.status(401).json({ error: "Admin authorisation required." });
    return false;
  }
  return true;
}
function text(req: Request, q: string, h: string) {
  const v = req.query[q] ?? req.headers[h];
  return typeof v === "string"
    ? v.trim()
    : Array.isArray(v)
      ? String(v[0]).trim()
      : "";
}
function assertUploadMetadata(sourceNote: string, uploadedBy: string) {
  if (!sourceNote || sourceNote.length > 2_000)
    throw new Error(
      "source_note is required and must be 2,000 characters or fewer",
    );
  if (!uploadedBy || uploadedBy.length > 200)
    throw new Error(
      "uploaded_by is required and must be 200 characters or fewer",
    );
}
function metadata(files: unzipper.File[]) {
  if (files.length !== 182)
    throw new Error(
      "Archive must contain exactly 182 entries (root directory, 179 workbooks, and two approved unrelated files).",
    );
  let total = 0;
  for (const e of files) {
    const normal = e.path.replaceAll("\\", "/"),
      type = (e.externalFileAttributes >>> 16) & 0o170000;
    if (e.type === "Directory") {
      if (normal !== `${ROOT}/`)
        throw new Error("Archive contains an unexpected directory.");
      continue;
    }
    if (
      (type !== 0 && type !== 0o100000) ||
      !Number.isFinite(e.uncompressedSize) ||
      e.uncompressedSize > MAX_ENTRY ||
      normal.startsWith("/") ||
      normal.includes("\0") ||
      normal.split("/").includes("..") ||
      !normal.startsWith(`${ROOT}/`)
    ) {
      throw new Error(
        "Archive contains an unsupported path, file type, or oversized entry.",
      );
    }
    if (e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > 100)
      throw new Error("Archive contains an excessively compressed entry.");
    total += e.uncompressedSize;
  }
  if (total > MAX_EXTRACTED)
    throw new Error("Archive expands beyond the approved source size limit.");
  const x = files.filter(
    (e) =>
      e.type === "File" &&
      e.path.startsWith(`${ROOT}/PSCode_3_New_Report `) &&
      e.path.endsWith(".xlsx"),
  );
  if (x.length !== 179)
    throw new Error(
      "Archive must contain exactly 179 PSCode_3 workbook entries.",
    );
  const unrelated = files
    .filter((e) => e.type === "File" && !x.includes(e))
    .map((e) => e.path)
    .sort();
  if (
    unrelated.join("|") !==
    `${ROOT}/PSCode_5_new_Report 1april to 30 june.xlsx|${ROOT}/other_checkin_report 1apr to 30 june.xlsx`
  )
    throw new Error("Archive contains unexpected unrelated files.");
}
async function extracted(source: Buffer, fn: (dir: string) => Promise<any>) {
  if (source.length > MAX_ARCHIVE)
    throw new Error("Archive exceeds the approved 10 MB size limit.");
  const dir = await mkdtemp(path.join(tmpdir(), "pscode3-aprjun26-"));
  try {
    const z = await unzipper.Open.buffer(source);
    metadata(z.files);
    await z.extract({ path: dir });
    const rd = await realpath(dir),
      root = path.join(dir, ROOT),
      rr = await realpath(root);
    if (!rr.startsWith(`${rd}${path.sep}`))
      throw new Error("Archive extraction escaped its temporary workspace.");
    return await fn(root);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
router.post(
  "/admin/secondary-sku/apr-jun-26",
  raw({ type: () => true, limit: "80mb" }),
  async (req: Request, res: Response) => {
    if (!admin(req, res)) return;
    const source = req.body as Buffer;
    if (!Buffer.isBuffer(source) || !source.length) {
      res.status(400).json({
        error: "Send the April-June PSCode_3 ZIP as the raw request body.",
      });
      return;
    }
    const sourceNote = text(req, "source_note", "x-source-note"),
      uploadedBy = text(req, "uploaded_by", "x-uploaded-by");
    try {
      assertUploadMetadata(sourceNote, uploadedBy);
    } catch (e) {
      res
        .status(400)
        .json({ error: String(e instanceof Error ? e.message : e) });
      return;
    }
    const sha = digest(source);
    try {
      assertApprovedAprJunArchive(sha);
    } catch (e) {
      res
        .status(422)
        .json({ error: String(e instanceof Error ? e.message : e) });
      return;
    }
    if (req.query.commit !== "true") {
      try {
        const p = await extracted(source, prepareAprJunPsCode3Load);
        assertAprJunControls(p);
        const preflight = await preflightAprJun(p);
        const uploadedAt = new Date().toISOString();
        dry = {
          sha256: sha,
          controls: p.controls,
          expiresAt: Date.now() + TTL,
          sourceNote,
          uploadedBy,
          uploadedAt,
          preflight,
        };
        res.json({
          dryRun: true,
          archiveSha256: sha,
          commitExpiresAt: new Date(dry.expiresAt).toISOString(),
          provenance: { sourceNote, uploadedBy, uploadedAt },
          controls: p.controls,
          preparedAnchors: p.byMonth,
          current: preflight,
          operationPlan:
            "verify-and-skip SKU; replace only pscode3_brand_rollup per month; insert one provenance row per month",
          next:
            "Re-submit identical archive with ?commit=true&confirm=Apr-Jun-26&dryRunSha256=" +
            sha,
        });
      } catch (e) {
        res
          .status(422)
          .json({ error: String(e instanceof Error ? e.message : e) });
      }
      return;
    }
    if (req.query.confirm !== "Apr-Jun-26") {
      res.status(400).json({ error: "Commit requires confirm=Apr-Jun-26." });
      return;
    }
    if (
      !dry ||
      dry.sha256 !== sha ||
      String(req.query.dryRunSha256) !== sha ||
      dry.expiresAt < Date.now()
    ) {
      res.status(409).json({
        error:
          "Run a successful dry-run for this exact archive within 30 minutes before committing.",
      });
      return;
    }
    if (dry.sourceNote !== sourceNote || dry.uploadedBy !== uploadedBy) {
      res.status(409).json({
        error: "source_note and uploaded_by must match the successful dry-run.",
      });
      return;
    }
    if (job.status === "running") {
      res
        .status(409)
        .json({ error: "April-June protected load already running." });
      return;
    }
    job = {
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    };
    void (async () => {
      try {
        const p = await extracted(source, prepareAprJunPsCode3Load);
        assertAprJunControls(p);
        const states = await commitAprJunPsCode3Load(p, {
          sourceNote,
          uploadedBy,
          uploadedAt: dry!.uploadedAt,
          archiveSha256: sha,
        });
        job = {
          ...job,
          status: "done",
          finishedAt: new Date().toISOString(),
          result: {
            controls: p.controls,
            operation: "verify-and-skip",
            months: states,
          },
        };
        logger.info(
          { sha, rows: p.controls.rows },
          "[secondarySkuAprJun26] load completed",
        );
      } catch (e) {
        job = {
          ...job,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: String(e instanceof Error ? e.message : e),
        };
        logger.error({ err: e, sha }, "[secondarySkuAprJun26] load failed");
      } finally {
        dry = null;
      }
    })();
    res.status(202).json({
      ok: true,
      status: "running",
      poll: "/api/admin/secondary-sku/apr-jun-26/status",
    });
  },
);
router.get("/admin/secondary-sku/apr-jun-26/status", async (req, res) => {
  if (!admin(req, res)) return;
  try {
    res.json({ ...job, latestProvenance: await latestAprJunProvenance() });
  } catch (e) {
    res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
  }
});
export default router;
