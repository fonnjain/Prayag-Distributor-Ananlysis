import { pool } from "@workspace/db";
import { Router } from "express";
import {
  auditCanonicalCoverageDrift,
  buildCanonicalCoverageDriftCheck,
  buildCanonicalCoverageReport,
  buildCanonicalCoverageWorkbook,
} from "../lib/canonicalCoverageReport.js";
import { isAdminToken } from "../lib/adminAuth.js";
import { requireAuthenticated } from "../lib/auth.js";

const router = Router();
// This router is mounted behind the application-wide auth gate, but keeps its
// own gate so customer-level evidence stays protected if mounting changes.
router.use(requireAuthenticated);

/**
 * A machine-readable and printable audit trail for the canonical organisation
 * coverage migration.  It is intentionally read-only; any failed invariant is
 * exposed as `passed: false` so monitoring and operators can stop before a
 * malformed import becomes the live source of coverage.
 */
router.get("/master/coverage-verification", async (req, res) => {
  try {
    const report = await buildCanonicalCoverageReport();
    res.status(report.passed ? 200 : 409).json(report);
  } catch (err) {
    req.log.error({ err }, "canonical coverage verification failed");
    res.status(500).json({ error: "Could not build canonical coverage verification report." });
  }
});

router.get("/master/coverage-verification/export", async (req, res) => {
  try {
    const report = await buildCanonicalCoverageReport();
    const workbook = await buildCanonicalCoverageWorkbook(report);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="CanonicalCoverageVerification_${report.fy}.xlsx"`,
    );
    res.status(report.passed ? 200 : 409).send(workbook);
  } catch (err) {
    req.log.error({ err }, "canonical coverage workbook failed");
    res.status(500).json({ error: "Could not build canonical coverage workbook." });
  }
});

// Recent post-register evidence checks. These are audit records only: a drift
// never rewrites canonical coverage automatically.
router.get("/master/coverage-drift/current", async (req, res): Promise<void> => {
  try {
    const fiscalYear = typeof req.query.fy === "string" ? req.query.fy : undefined;
    const check = await buildCanonicalCoverageDriftCheck(fiscalYear);
    res.status(check.passed ? 200 : 409).json({
      ...check,
      warning: check.passed
        ? null
        : "Coverage was not changed automatically. Review the exceptions before changing team geography.",
    });
  } catch (err) {
    req.log.error({ err }, "canonical coverage current drift check failed");
    res.status(500).json({ error: "Could not build the current canonical coverage drift review." });
  }
});

router.get("/master/coverage-drift", async (req, res) => {
  try {
    const fiscalYear = typeof req.query.fy === "string" ? req.query.fy : null;
    const { rows } = await pool.query<{
      event_id: string;
      checked_at: string;
      trigger_fy: string;
      trigger_source: "register_sync" | "manual";
      report_fy: string | null;
      status: "ok" | "drift" | "error";
      detail: unknown;
    }>(
      `SELECT event_id, checked_at::text, trigger_fy, trigger_source,
              report_fy, status, detail
       FROM canonical_coverage_drift_event
       WHERE ($1::text IS NULL OR trigger_fy = $1 OR report_fy = $1)
       ORDER BY checked_at DESC, event_id DESC
       LIMIT 100`,
      [fiscalYear],
    );
    const latestDrift = rows.find((row) => row.status === "drift");
    res.status(latestDrift ? 409 : 200).json({
      events: rows,
      warning: latestDrift
        ? "Register evidence no longer supports current organisation coverage. Review the drift event; coverage was not changed automatically."
        : null,
    });
  } catch (err) {
    req.log.error({ err }, "canonical coverage drift history failed");
    res.status(500).json({ error: "Could not load canonical coverage drift history." });
  }
});

router.post("/master/coverage-drift/check", async (req, res) => {
  const operatorSecret = String(req.headers["x-admin-secret"] ?? "");
  if (req.authUser?.role !== "admin" && !isAdminToken(operatorSecret)) {
    res.status(403).json({ error: "Administrator access required to run a canonical coverage drift check." });
    return;
  }
  try {
    const fiscalYear = typeof req.query.fy === "string" ? req.query.fy : undefined;
    const check = await auditCanonicalCoverageDrift("manual", fiscalYear);
    res.status(check.passed ? 200 : 409).json({
      ...check,
      warning: check.passed
        ? null
        : "Coverage was not changed automatically. Review the exceptions before changing team geography.",
    });
  } catch (err) {
    req.log.error({ err }, "canonical coverage drift check failed");
    res.status(500).json({ error: "Could not run canonical coverage drift check." });
  }
});

export default router;