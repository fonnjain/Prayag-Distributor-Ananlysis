import { Router, type IRouter, type Request, type Response } from "express";
import {
  REGISTER_SHEET_IDS,
  buildVerifyReport,
  backfillMissingFromSheets,
} from "../lib/verify/verify.js";

const router: IRouter = Router();

const DEFAULT_FY = "2026-27";

function resolveFy(raw: unknown): string | null {
  const fy = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : DEFAULT_FY;
  return fy in REGISTER_SHEET_IDS ? fy : null;
}

router.get("/verify", async (req: Request, res: Response): Promise<void> => {
  const fy = resolveFy(req.query["fy"]);
  if (!fy) {
    res.status(400).json({
      error: `Unknown fiscal year. Known: ${Object.keys(REGISTER_SHEET_IDS).join(", ")}`,
    });
    return;
  }
  try {
    const report = await buildVerifyReport(fy);
    res.json(report);
  } catch (err) {
    req.log.error({ err, fy }, "verification report failed");
    res.status(502).json({ error: "Could not build the verification report." });
  }
});

router.post(
  "/verify/backfill",
  async (req: Request, res: Response): Promise<void> => {
    const fy = resolveFy((req.body as Record<string, unknown> | undefined)?.["fy"]);
    if (!fy) {
      res.status(400).json({
        error: `Unknown fiscal year. Known: ${Object.keys(REGISTER_SHEET_IDS).join(", ")}`,
      });
      return;
    }
    try {
      const result = await backfillMissingFromSheets(fy);
      req.log.info({ fy, ...result }, "verify backfill completed");
      res.json({ fy, ...result });
    } catch (err) {
      req.log.error({ err, fy }, "verify backfill failed");
      res.status(502).json({ error: "Backfill from Sheets failed." });
    }
  },
);

export default router;
