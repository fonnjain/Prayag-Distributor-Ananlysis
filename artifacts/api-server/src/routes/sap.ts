import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";
import { streamSapWorkbook, type SapRow } from "../lib/sap/sapStream.js";
import { getRateListMaps } from "../lib/sap/rateList.js";
import { deriveMonthSummary } from "../lib/sap/derive.js";
import { upsertUpload, getUploadsForFy, deleteUpload } from "../lib/sap/store.js";
import { buildSapVerifyReport, clearVerifiedCache } from "../lib/sap/verify.js";
import { fyMonthLabels } from "../lib/sap/util.js";

const router: IRouter = Router();

const FY_PATTERN = /^\d{4}-\d{2}$/;

function isValidMonth(fy: string, month: string): boolean {
  return fyMonthLabels(fy).includes(month);
}

// Hands the browser a short-lived signed PUT URL so the SAP xlsx uploads
// directly to object storage (never buffered through the API).
router.post(
  "/sap/upload-url",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const service = new ObjectStorageService();
      const uploadUrl = await service.getObjectEntityUploadURL();
      res.json({ uploadUrl });
    } catch (err) {
      req.log.error({ err }, "sap upload-url failed");
      res.status(500).json({ error: "Could not create an upload URL." });
    }
  },
);

// Streams a just-uploaded SAP file, enriches every line via the rate list,
// derives the per-month summary, and stores it (re-upload overwrites the
// month). Returns the fresh month summary plus the FY-level verify report.
router.post(
  "/sap/register",
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as {
      fy?: unknown;
      month?: unknown;
      uploadUrl?: unknown;
      originalName?: unknown;
    };
    const fy = typeof body.fy === "string" ? body.fy.trim() : "";
    const month = typeof body.month === "string" ? body.month.trim() : "";
    const uploadUrl = typeof body.uploadUrl === "string" ? body.uploadUrl.trim() : "";
    const originalName =
      typeof body.originalName === "string" ? body.originalName.trim() : null;

    if (!FY_PATTERN.test(fy) || !isValidMonth(fy, month) || uploadUrl === "") {
      res.status(400).json({ error: "fy, month, and uploadUrl are required." });
      return;
    }

    try {
      const service = new ObjectStorageService();
      const objectPath = service.normalizeObjectEntityPath(uploadUrl);
      const file = await service.getObjectEntityFile(objectPath);

      const maps = await getRateListMaps();
      const rows: SapRow[] = [];
      const nodeStream = file.createReadStream();
      await streamSapWorkbook(nodeStream as unknown as Readable, (row) => {
        rows.push(row);
      });

      if (rows.length === 0) {
        res.status(422).json({ error: "No data rows found in the uploaded file." });
        return;
      }

      const summary = deriveMonthSummary(rows, maps, fy, month);
      await upsertUpload({ fy, monthLabel: month, objectPath, originalName, summary });
      clearVerifiedCache();
      const report = await buildSapVerifyReport(fy);
      res.json({ summary, report });
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Uploaded file not found." });
        return;
      }
      req.log.error({ err, fy, month }, "sap register failed");
      res.status(500).json({ error: "Could not process the uploaded file." });
    }
  },
);

router.get(
  "/sap/verify",
  async (req: Request, res: Response): Promise<void> => {
    const fyRaw = req.query["fy"];
    const fy = typeof fyRaw === "string" && fyRaw.trim() !== "" ? fyRaw.trim() : "";
    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "fy must look like 2026-27" });
      return;
    }
    try {
      const report = await buildSapVerifyReport(fy);
      res.json(report);
    } catch (err) {
      req.log.error({ err, fy }, "sap verify failed");
      res.status(500).json({ error: "Could not build the verification report." });
    }
  },
);

router.get(
  "/sap/status",
  async (req: Request, res: Response): Promise<void> => {
    const fyRaw = req.query["fy"];
    const fy = typeof fyRaw === "string" && fyRaw.trim() !== "" ? fyRaw.trim() : "";
    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "fy must look like 2026-27" });
      return;
    }
    try {
      const rows = await getUploadsForFy(fy);
      const report = await buildSapVerifyReport(fy);
      const months = rows
        .map((r) => ({
          monthLabel: r.monthLabel,
          rowsRead: r.rowsRead ?? 0,
          amount: r.amount == null ? 0 : Number(r.amount),
          originalName: r.originalName,
          uploadedAt: r.uploadedAt ? r.uploadedAt.toISOString() : null,
        }))
        .sort(
          (a, b) =>
            fyMonthLabels(fy).indexOf(a.monthLabel) -
            fyMonthLabels(fy).indexOf(b.monthLabel),
        );
      res.json({ fy, allMonths: fyMonthLabels(fy), months, verified: report.verified });
    } catch (err) {
      req.log.error({ err, fy }, "sap status failed");
      res.status(500).json({ error: "Could not load import status." });
    }
  },
);

router.delete(
  "/sap/upload",
  async (req: Request, res: Response): Promise<void> => {
    const fyRaw = req.query["fy"];
    const monthRaw = req.query["month"];
    const fy = typeof fyRaw === "string" ? fyRaw.trim() : "";
    const month = typeof monthRaw === "string" ? monthRaw.trim() : "";
    if (!FY_PATTERN.test(fy) || !isValidMonth(fy, month)) {
      res.status(400).json({ error: "fy and month are required." });
      return;
    }
    try {
      const { objectPath } = await deleteUpload(fy, month);
      clearVerifiedCache();
      if (objectPath) {
        try {
          const service = new ObjectStorageService();
          const file = await service.getObjectEntityFile(objectPath);
          await file.delete({ ignoreNotFound: true });
        } catch (delErr) {
          if (!(delErr instanceof ObjectNotFoundError)) {
            req.log.warn({ delErr, fy, month }, "sap object delete failed");
          }
        }
      }
      const report = await buildSapVerifyReport(fy);
      res.json({ deleted: objectPath != null, report });
    } catch (err) {
      req.log.error({ err, fy, month }, "sap delete failed");
      res.status(500).json({ error: "Could not delete the upload." });
    }
  },
);

export default router;
