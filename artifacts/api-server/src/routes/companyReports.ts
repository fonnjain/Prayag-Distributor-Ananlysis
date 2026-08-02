// GET /api/company-reports?fy=2026-27&asOf=2026-07-13
//
// Returns all data for Reports 1-7 (company-wide, primary sales only).
// Rules enforced in companyReports.ts:
//   1. Like months only (never full-prior-year vs part-year current).
//   2. Qty never summed across groups (litre/piece unit mismatch).
//   3. Live data from sale_line (populated from live register chain).
import { Router } from "express";
import { buildCompanyReports } from "../lib/companyReports.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";
import { isFrozen } from "../lib/customers/registerSync.js";

const router = Router();

// In-process warm-cache TTL. sale_line only changes on register syncs (every
// few hours), so 10 minutes keeps repeat loads instant without staleness risk.
const COMPANY_REPORTS_TTL_MS = 10 * 60 * 1000;

const FY_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/company-reports", async (req, res) => {
  const rawFy = typeof req.query.fy === "string" ? req.query.fy : "2026-27";
  const rawAsOf = typeof req.query.asOf === "string" ? req.query.asOf : undefined;

  if (!FY_RE.test(rawFy)) {
    res.status(400).json({ error: "Invalid fy — expected YYYY-YY" });
    return;
  }
  if (rawAsOf !== undefined && !DATE_RE.test(rawAsOf)) {
    res.status(400).json({ error: "Invalid asOf — expected YYYY-MM-DD" });
    return;
  }

  try {
    if (rawAsOf !== undefined) {
      // Explicit as-of date is a diagnostic path — always build live, never
      // cache or snapshot (the key space would be unbounded).
      const payload = await buildCompanyReports(rawFy, rawAsOf);
      res.json(payload);
      return;
    }
    // Cold-start fast path: serve the last persisted payload instantly with
    // meta.snapshotSavedAt + meta.refreshing, rebuilding in the background.
    const payload = await serveWithSnapshot({
      // v2: month-completeness rule fixed (Oct-24-style months no longer
      // dropped) — versioned key forces frozen-FY snapshots to rebuild once.
      key: `company-reports|v2|${rawFy}`,
      ttlMs: COMPANY_REPORTS_TTL_MS,
      build: () => buildCompanyReports(rawFy, undefined),
      log: req.log,
      frozen: isFrozen(rawFy),
    });
    res.json(payload);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "company-reports error");
    res.status(500).json({ error: "Failed to compute company reports" });
  }
});

export default router;
