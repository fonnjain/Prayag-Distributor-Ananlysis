import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "node:stream";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";
import { streamSapWorkbook } from "../lib/sap/sapStream.js";
import { getRateListMaps } from "../lib/sap/rateList.js";
import { createMonthAccumulator } from "../lib/sap/derive.js";
import { upsertUpload, getUploadsForFy, deleteUpload } from "../lib/sap/store.js";
import { buildSapVerifyReport, clearVerifiedCache } from "../lib/sap/verify.js";
import { fyMonthLabels } from "../lib/sap/util.js";
import {
  reconcileSapVsSaleSheet,
  formatReconcileAsCsv,
  reconcileDbVsSaleSheet,
  formatDbGapAsCsv,
} from "../lib/sap/reconcileSheets.js";
import { exportDbGapAsXlsx } from "../lib/sap/exportDbGapXlsx.js";

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
      const acc = createMonthAccumulator(maps, fy, month);
      const nodeStream = file.createReadStream();
      await streamSapWorkbook(nodeStream as unknown as Readable, (row) => {
        acc.addRow(row);
      });

      const stats = acc.audit();
      if (stats.scannedRows === 0) {
        res.status(422).json({ error: "No data rows found in the uploaded file." });
        return;
      }
      // Month is derived from each invoice date, not the selected month. Reject
      // a file whose rows are dated in a different month so a mislabeled or
      // mixed-month upload cannot silently distort monthly analytics.
      if (stats.offMonthRows > 0) {
        const detected = stats.monthsDetected
          .filter((m) => m.month !== month)
          .map((m) => `${m.month} (${m.rows})`)
          .join(", ");
        res.status(422).json({
          error:
            `This file has ${stats.offMonthRows} row(s) dated outside ${month}` +
            (detected ? ` — detected ${detected}. ` : ". ") +
            `Select the matching month or upload only ${month} data.`,
          offMonthRows: stats.offMonthRows,
          monthsDetected: stats.monthsDetected,
        });
        return;
      }
      if (stats.inMonthRows === 0) {
        res.status(422).json({ error: "No data rows found in the uploaded file." });
        return;
      }

      const summary = acc.finish();
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

// ── Read-only reconciliation: SAP source sheet vs derived sale sheet ──────────
// GET /api/sap/reconcile?fy=2026-27&month=Jul-26
//   Returns a JSON report: matched/sapOnly/saleOnly row counts, amounts,
//   by-customer breakdown, and full detail rows for the gap.
// GET /api/sap/reconcile?fy=2026-27&month=Jul-26&format=csv
//   Returns the same report as a downloadable CSV file (detail rows included).
router.get(
  "/sap/reconcile",
  async (req: Request, res: Response): Promise<void> => {
    const fyRaw = req.query["fy"];
    const monthRaw = req.query["month"];
    const formatRaw = req.query["format"];

    const fy =
      typeof fyRaw === "string" && fyRaw.trim() !== "" ? fyRaw.trim() : "2026-27";
    const month =
      typeof monthRaw === "string" && monthRaw.trim() !== ""
        ? monthRaw.trim()
        : "Jul-26";
    const asCsv = typeof formatRaw === "string" && formatRaw.trim() === "csv";

    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "fy must look like 2026-27" });
      return;
    }
    if (!/^[A-Za-z]{3}-\d{2}$/.test(month)) {
      res.status(400).json({ error: "month must look like Jul-26" });
      return;
    }

    try {
      req.log.info({ fy, month, asCsv }, "sap reconcile: starting");
      const result = await reconcileSapVsSaleSheet(fy, month);
      req.log.info(
        {
          fy,
          month,
          sapRows: result.sapSource.totalRows,
          saleRows: result.saleSheet.totalRows,
          sapOnly: result.sapOnly.rows,
          saleOnly: result.saleOnly.rows,
          errors: result.errors.length,
        },
        "sap reconcile: complete",
      );

      if (asCsv) {
        const csv = formatReconcileAsCsv(result);
        const filename = `sap-reconcile-${fy}-${month}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.send(csv);
        return;
      }

      res.json(result);
    } catch (err) {
      req.log.error({ err, fy, month }, "sap reconcile failed");
      res.status(500).json({ error: "Reconciliation failed — check server logs." });
    }
  },
);

// ── DB gap: rows in the database absent from the live sale sheet ──────────────
// GET /api/sap/db-gap?fy=2026-27&month=Jul-26
//   Returns a JSON report: db/saleSheet row counts, amounts, matched count,
//   db-only (deleted) rows with by-customer breakdown and full detail.
// GET /api/sap/db-gap?fy=2026-27&month=Jul-26&format=csv
//   Returns the same report as a downloadable CSV (lineUid on every row for
//   unambiguous recovery).
router.get(
  "/sap/db-gap",
  async (req: Request, res: Response): Promise<void> => {
    const fyRaw = req.query["fy"];
    const monthRaw = req.query["month"];
    const formatRaw = req.query["format"];

    const fy =
      typeof fyRaw === "string" && fyRaw.trim() !== "" ? fyRaw.trim() : "2026-27";
    const month =
      typeof monthRaw === "string" && monthRaw.trim() !== ""
        ? monthRaw.trim()
        : "Jul-26";
    const asCsv = typeof formatRaw === "string" && formatRaw.trim() === "csv";

    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "fy must look like 2026-27" });
      return;
    }
    if (!/^[A-Za-z]{3}-\d{2}$/.test(month)) {
      res.status(400).json({ error: "month must look like Jul-26" });
      return;
    }

    try {
      req.log.info({ fy, month, asCsv }, "sap db-gap: starting");
      const result = await reconcileDbVsSaleSheet(fy, month);
      req.log.info(
        {
          fy,
          month,
          dbRows: result.db.totalRows,
          saleRows: result.saleSheet.totalRows,
          dbOnly: result.dbOnly.rows,
          errors: result.errors.length,
        },
        "sap db-gap: complete",
      );

      if (asCsv) {
        const csv = formatDbGapAsCsv(result);
        const filename = `sap-db-gap-${fy}-${month}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.send(csv);
        return;
      }

      res.json(result);
    } catch (err) {
      req.log.error({ err, fy, month }, "sap db-gap failed");
      res.status(500).json({ error: "DB gap analysis failed — check server logs." });
    }
  },
);

// GET /api/sap/db-gap-xlsx?fy=2026-27&month=Jul-26
//   Downloads a two-sheet xlsx workbook containing:
//   - Sheet 1 "Disputed Rows": every DB row absent from the live SALE SHEET,
//     with columns matching the sheet's own column order (paste-ready) plus
//     review metadata (lineUid, ingestedAt, ingestRunId, branch, inSapSource).
//   - Sheet 2 "Summary": by-customer, by-invoice, by-branch, by-state-head
//     aggregations, and a prominent partial-invoice section.
//   This route reads the live SALE SHEET and the SAP Combined tab — expect
//   10-90 seconds on a cold server depending on sheet size.
router.get(
  "/sap/db-gap-xlsx",
  async (req: Request, res: Response): Promise<void> => {
    const fyRaw = req.query["fy"];
    const monthRaw = req.query["month"];

    const fy =
      typeof fyRaw === "string" && fyRaw.trim() !== "" ? fyRaw.trim() : "2026-27";
    const month =
      typeof monthRaw === "string" && monthRaw.trim() !== ""
        ? monthRaw.trim()
        : "Jul-26";

    if (!FY_PATTERN.test(fy)) {
      res.status(400).json({ error: "fy must look like 2026-27" });
      return;
    }
    if (!/^[A-Za-z]{3}-\d{2}$/.test(month)) {
      res.status(400).json({ error: "month must look like Jul-26" });
      return;
    }

    try {
      req.log.info({ fy, month }, "sap db-gap-xlsx: starting");
      const buf = await exportDbGapAsXlsx(fy, month);
      const filename = `disputed-${fy}-${month}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", buf.length);
      res.send(buf);
      req.log.info({ fy, month, bytes: buf.length }, "sap db-gap-xlsx: sent");
    } catch (err) {
      req.log.error({ err, fy, month }, "sap db-gap-xlsx failed");
      res.status(500).json({ error: "xlsx export failed — check server logs." });
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
