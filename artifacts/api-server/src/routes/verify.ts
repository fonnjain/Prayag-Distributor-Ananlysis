import { Router, type IRouter, type Request, type Response } from "express";
import { currentOpenFy } from "../lib/fyAnchors.js";
import {
  REGISTER_SHEET_IDS,
  buildVerifyReport,
  backfillMissingFromSheets,
  pruneGhostRows,
} from "../lib/verify/verify.js";

const router: IRouter = Router();

// Default FY derives from the calendar so the page never opens on a stale year.

function resolveFy(raw: unknown): string | null {
  const fy = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : currentOpenFy();
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
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No header row detected")) {
      req.log.warn({ fy }, "verify: register tabs have non-standard headers — SAP FY?");
      res.json({
        fy,
        notApplicable: true,
        message:
          `FY ${fy} uses the SAP primary-sales pipeline. ` +
          "Register reconciliation is not available for this fiscal year.",
      });
      return;
    }
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

/**
 * POST /verify/prune-ghost-rows
 *
 * Two-step confirmation protocol — deletion requires both steps:
 *
 * Step 1 — dry run (default): POST { "fy": currentOpenFy() }
 *   Returns { dryRun: true, toPrune: N, pruned: 0 } without touching any data.
 *
 * Step 2 — confirm: POST { "fy": currentOpenFy(), "confirm": true, "expectedCount": N }
 *   expectedCount must equal the toPrune value from step 1.
 *   Deletes only when the count still matches (prevents stale confirmations).
 *   Returns { dryRun: false, toPrune: N, pruned: N }.
 *
 * The underlying DB trigger (sale_line_delete_guard) enforces that the
 * deletion goes through allowDelete() — it cannot be bypassed even with a
 * direct SQL DELETE.
 */
router.post(
  "/verify/prune-ghost-rows",
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const fy = resolveFy(body["fy"]);
    if (!fy) {
      res.status(400).json({
        error: `Unknown fiscal year. Known: ${Object.keys(REGISTER_SHEET_IDS).join(", ")}`,
      });
      return;
    }

    const confirm = body["confirm"] === true;
    const expectedCount =
      typeof body["expectedCount"] === "number" ? body["expectedCount"] : undefined;

    try {
      const result = await pruneGhostRows(fy, {
        dryRun: !confirm,
        expectedCount,
      });

      if (result.guarded && !result.dryRun) {
        req.log.warn({ fy, ...result }, "prune-ghost-rows: guarded — not deleted");
        res.status(409).json({ fy, ...result });
        return;
      }

      req.log.info({ fy, ...result }, "prune-ghost-rows completed");
      res.json({ fy, ...result });
    } catch (err) {
      req.log.error({ err, fy }, "prune-ghost-rows failed");
      res.status(502).json({ error: "Ghost row pruning failed." });
    }
  },
);

export default router;
