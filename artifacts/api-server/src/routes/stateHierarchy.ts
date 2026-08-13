/**
 * GET /api/state-hierarchy
 *
 * Returns all rows from the state_hierarchy table, enriched with row counts
 * and net (₹ Cr) from sale_line for the requested FY.
 *
 * The frontend uses this to build the two-level hierarchical state picker.
 * picker_visible=false rows (GEM, JJM, Non-territory, HITESH) are included so
 * verification arithmetic stays exact, but the UI must not show them.
 *
 * Query params:
 *   fy  — fiscal year for count display (default: "2026-27")
 */
import { Router } from "express";
import { pool } from "@workspace/db";

const router = Router();

router.get("/state-hierarchy", async (req, res) => {
  try {
    const fy = typeof req.query.fy === "string" ? req.query.fy : "2026-27";

    const { rows } = await pool.query<{
      state_canon: string;
      state_parent: string;
      is_split: boolean;
      picker_visible: boolean;
      display_order: number;
      row_count: number;
      net_cr: number;
    }>(
      `
      SELECT
        sh.state_canon,
        sh.state_parent,
        sh.is_split,
        sh.picker_visible,
        sh.display_order,
        COALESCE(s.row_count, 0)::integer                   AS row_count,
        COALESCE(ROUND(s.net_amount / 1e7, 2), 0)::numeric  AS net_cr
      FROM state_hierarchy sh
      LEFT JOIN (
        SELECT state_canon,
               COUNT(*)    AS row_count,
               SUM(amount) AS net_amount
        FROM   sale_line
        WHERE  fy = $1
        GROUP  BY state_canon
      ) s ON s.state_canon = sh.state_canon
      ORDER  BY sh.display_order, sh.state_canon
      `,
      [fy],
    );

    res.json({ fy, rows });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
