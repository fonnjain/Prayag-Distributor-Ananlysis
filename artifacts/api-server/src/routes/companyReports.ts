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

const router = Router();

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
    const payload = await buildCompanyReports(rawFy, rawAsOf);
    res.json(payload);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "company-reports error");
    res.status(500).json({ error: "Failed to compute company reports" });
  }
});

export default router;
