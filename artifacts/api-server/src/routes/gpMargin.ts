// GP Margin routes.
//
// POST /api/admin/margin/load  — admin-gated; parse all GP MARGIN workbooks
//                                from Google Drive and (re)populate margin_fact.
// GET  /api/margin/stats       — summary counts for the Margin page.
// GET  /api/margin/list        — paginated rows with optional segment/fy/q filters.

import { Router } from "express";
import { isAdminToken } from "../lib/adminAuth.js";
import { loadGpMarginFiles } from "../lib/gpMargin/loader.js";
import { pool } from "@workspace/db";

const router = Router();

// ── GET /api/margin/stats ──────────────────────────────────────────────────
router.get("/margin/stats", async (_req, res) => {
  try {
    const [totals, byFySeg, codes, negCnt] = await Promise.all([
      pool.query<{ total: string; fys: string }>(
        "SELECT COUNT(*) AS total, COUNT(DISTINCT fy) AS fys FROM margin_fact",
      ),
      pool.query<{ fy: string; segment: string; cnt: string; months: string }>(
        `SELECT fy, segment,
                COUNT(*) AS cnt,
                COUNT(DISTINCT month_label) AS months
           FROM margin_fact GROUP BY fy, segment ORDER BY fy, segment`,
      ),
      pool.query<{ n: string }>("SELECT COUNT(DISTINCT item_code) AS n FROM margin_fact"),
      pool.query<{ n: string }>(
        "SELECT COUNT(DISTINCT item_code) AS n FROM margin_fact WHERE bom_cost IS NOT NULL AND avg_sale IS NOT NULL AND bom_cost > avg_sale",
      ),
    ]);

    const rowsByFySegment: Record<string, { rows: number; months: number }> = {};
    for (const r of byFySeg.rows) {
      rowsByFySegment[`${r.fy}|${r.segment}`] = {
        rows: parseInt(r.cnt, 10),
        months: parseInt(r.months, 10),
      };
    }

    res.json({
      totalRows: parseInt(totals.rows[0]?.total ?? "0", 10),
      distinctFys: parseInt(totals.rows[0]?.fys ?? "0", 10),
      distinctCodes: parseInt(codes.rows[0]?.n ?? "0", 10),
      negativeContributionCodes: parseInt(negCnt.rows[0]?.n ?? "0", 10),
      rowsByFySegment,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/margin/list ───────────────────────────────────────────────────
router.get("/margin/list", async (req, res) => {
  try {
    const fy      = typeof req.query.fy      === "string" ? req.query.fy      : null;
    const segment = typeof req.query.segment === "string" ? req.query.segment : null;
    const q       = typeof req.query.q       === "string" ? req.query.q       : null;
    const limit   = Math.min(parseInt(String(req.query.limit  ?? "100"), 10), 500);
    const offset  = parseInt(String(req.query.offset ?? "0"), 10);

    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (fy)      { conditions.push(`fy = $${params.length + 1}`);          params.push(fy); }
    if (segment) { conditions.push(`segment = $${params.length + 1}`);     params.push(segment); }
    if (q) {
      conditions.push(`(item_code ILIKE $${params.length + 1})`);
      params.push(`%${q}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rows, cnt] = await Promise.all([
      pool.query(
        `SELECT fy, month_label, segment, item_code, tab_name,
                qty, weight, mrp, discount_frac, avg_sale, bom_cost,
                sale_value, bom_value, source_file
           FROM margin_fact ${where}
          ORDER BY fy DESC, month_label, segment, item_code
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*) AS n FROM margin_fact ${where}`,
        params,
      ),
    ]);

    res.json({
      total: parseInt(cnt.rows[0]?.n ?? "0", 10),
      limit,
      offset,
      rows: rows.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/admin/margin/load ────────────────────────────────────────────
router.post("/admin/margin/load", async (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({
      error: "Admin authorisation required. Pass the SESSION_SECRET as: X-Admin-Secret: <SESSION_SECRET>",
    });
    return;
  }

  try {
    const report = await loadGpMarginFiles();
    res.json({
      ok: true,
      filesScanned:  report.filesScanned,
      filesLoaded:   report.filesLoaded,
      filesCumulative: report.filesCumulative,
      filesSummary:    report.filesSummary,
      filesUnknown:    report.filesUnknown,
      rowsInserted:    report.rowsInserted,
      rowsByFySegment: report.rowsByFySegment,
      distinctCodes:   report.distinctCodes,
      cumulativeValidation: report.cumulativeValidation,
      cumulativeFlags:      report.cumulativeValidation.filter((c) => c.flag).length,
      negativeContributionCount: report.negativeContributionCount,
      negativeContributionTop10: report.negativeContributionTop10,
    });
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

export default router;
