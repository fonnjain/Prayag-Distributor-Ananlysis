// Audit routes. GET /api/audit?fy=<fy> returns comprehensive check groups.
// GET /api/audit/download?fy=<fy> streams an Excel workbook.
//
// This wraps runFullVerify (Groups A-E, primary, source-health) with three
// additional groups: 1.1 truncation, 6 report-logic spot-checks, 7 cross-foots.
import { Router, type IRouter, type Request, type Response } from "express";
import {
  runFullVerify,
  type FullVerifyReport,
  type CheckGroup,
} from "../lib/mgmt/verifyFull.js";
import { runExtraGroups } from "../lib/audit/extraGroups.js";
import { buildAuditWorkbook } from "../lib/audit/workbook.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";
import { currentOpenFy, deriveSaleLineCohortFy, deriveSaleLineClosedFys } from "../lib/fyAnchors.js";

const router: IRouter = Router();

// The Data Health page blocks on GET /api/audit, which re-runs every check
// group (Sheets + DB) on a cold start. Snapshot-first keeps the page instant;
// never frozen — an audit must keep re-checking live sources in the
// background, otherwise it would hide new drift.
const AUDIT_SNAPSHOT_TTL_MS = 15 * 60 * 1000;

const FY_PATTERN = /^\d{4}-\d{2}$/;

// Valid FYs derive from what is actually ingested (fully-ingested closed FYs
// in sale_line_current) plus the calendar-open FY — never a fixed list, so a
// new year is accepted the moment it exists and the default rolls forward
// automatically. Default = newest fully-ingested closed FY.
async function validFys(): Promise<string[]> {
  const closed = await deriveSaleLineClosedFys();
  const open = currentOpenFy();
  return closed.includes(open) ? closed : [...closed, open];
}

async function resolveFy(raw: unknown): Promise<{ fy: string | null; valid: string[] }> {
  const valid = await validFys();
  const fy =
    typeof raw === "string" && raw.trim() !== "" ? raw.trim() : await deriveSaleLineCohortFy();
  return { fy: FY_PATTERN.test(fy) && valid.includes(fy) ? fy : null, valid };
}

// Shared runner — used by both JSON and download endpoints.
async function runAudit(fy: string): Promise<FullVerifyReport> {
  const [base, extra] = await Promise.all([runFullVerify(fy), runExtraGroups(fy)]);

  const groups: CheckGroup[] = [...base.groups, ...extra];
  const allChecks = groups.flatMap((g) => g.checks);

  const overall: "pass" | "warn" | "fail" = allChecks.some((c) => c.status === "fail")
    ? "fail"
    : allChecks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";

  return { ...base, groups, overall };
}

// GET /api/audit?fy=<fy>
// Returns FullVerifyReport (same shape as /mgmt/verify) but with more groups
// and the runFullVerify checks (not just the old runVerify secondary checks).
router.get("/audit", async (req: Request, res: Response): Promise<void> => {
  const { fy, valid } = await resolveFy(req.query["fy"]);
  if (!fy) {
    res.status(400).json({ error: `Unknown FY. Valid values: ${valid.join(", ")}` });
    return;
  }
  try {
    const report = await serveWithSnapshot({
      key: `audit|${fy}`,
      ttlMs: AUDIT_SNAPSHOT_TTL_MS,
      build: () => runAudit(fy) as unknown as Promise<Record<string, unknown>>,
      log: req.log,
    });
    res.json(report);
  } catch (err) {
    req.log.error({ err, fy }, "audit: runAudit threw");
    res.status(500).json({ error: "Could not run audit checks. Google Sheets may be temporarily unavailable; try again in a minute." });
  }
});

// GET /api/audit/download?fy=<fy>
// Returns a .xlsx workbook with 8 tabs: Summary, Checks, Failures, Source Health,
// Unmatched Names, Head Reconciliation, Cross-foots, Anchors.
router.get("/audit/download", async (req: Request, res: Response): Promise<void> => {
  const { fy, valid } = await resolveFy(req.query["fy"]);
  if (!fy) {
    res.status(400).json({ error: `Unknown FY. Valid values: ${valid.join(", ")}` });
    return;
  }
  try {
    const report = await runAudit(fy);
    const buf = await buildAuditWorkbook(report, fy);

    const now = new Date();
    const ts =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0") +
      "-" +
      String(now.getHours()).padStart(2, "0") +
      String(now.getMinutes()).padStart(2, "0");
    const filename = `Audit_${fy.replace("-", "")}_${ts}.xlsx`;

    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buf.length,
    });
    res.send(buf);
  } catch (err) {
    req.log.error({ err, fy }, "audit: download threw");
    res.status(500).json({ error: "Could not generate audit workbook." });
  }
});

export default router;
