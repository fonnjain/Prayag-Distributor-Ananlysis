import { Router } from "express";
import { pool } from "@workspace/db";
import {
  buildCanonicalCoverageReport,
  buildCanonicalCoverageWorkbook,
} from "../lib/canonicalCoverageReport.js";

const router = Router();

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
router.get("/master/coverage-drift", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT event_id, checked_at::text, trigger_fy, trigger_source,
              report_fy, status, detail
       FROM canonical_coverage_drift_event
       ORDER BY checked_at DESC, event_id DESC
       LIMIT 100`,
    );
    res.json({ events: rows });
  } catch (err) {
    req.log.error({ err }, "canonical coverage drift history failed");
    res.status(500).json({ error: "Could not load canonical coverage drift history." });
  }
});

export default router;