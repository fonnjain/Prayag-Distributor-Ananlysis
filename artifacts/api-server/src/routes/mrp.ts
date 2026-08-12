// GET  /api/mrp              — paginated list with segment/series/search filters
// GET  /api/mrp/meta         — available segments, series, counts and ambiguous-code count
// GET  /api/mrp/stats        — match-rate against sale_line FY2026-27
// GET  /api/mrp/:code/history — full revision history for one (item_code, segment) pair
//                               ?segment=PTMT required when the code is ambiguous
// POST /api/admin/mrp/load   — admin: parse all 6 xlsx workbooks and (re)populate tables
//
// Schema: mrp_master PK is (item_code, segment).
// is_ambiguous_code = TRUE when the same item_code exists in 2+ segments.
// Register lookups for an ambiguous code MUST supply a segment; a wrong MRP
// is worse than a missing one, so no fallback is attempted.
import { Router } from "express";
import { pool } from "@workspace/db";
import { loadMrpFiles } from "../lib/mrp/loader.js";
import { isAdminToken } from "../lib/adminAuth.js";
import { resolveProductCode, buildResolverIndex } from "../lib/sku/productCodeResolver.js";

const router = Router();

// ── GET /api/mrp ──────────────────────────────────────────────────────────
router.get("/mrp", async (req, res) => {
  try {
    const segment = typeof req.query.segment === "string" ? req.query.segment : null;
    const series = typeof req.query.series === "string" ? req.query.series : null;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : null;
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let p = 1;

    if (segment) {
      conditions.push(`m.segment = $${p++}`);
      params.push(segment);
    }
    if (series) {
      conditions.push(`m.series = $${p++}`);
      params.push(series);
    }
    if (q) {
      conditions.push(`(m.item_code ILIKE $${p} OR m.item_name ILIKE $${p})`);
      params.push(`%${q}%`);
      p++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [rowsResult, totalResult] = await Promise.all([
      pool.query<{
        item_code: string;
        item_name: string | null;
        segment: string;
        series: string | null;
        packing: string | null;
        is_ambiguous_code: boolean;
        current_mrp: string | null;
        effective_from: string | null;
        history_count: string;
      }>(
        `SELECT
           m.item_code,
           m.item_name,
           m.segment,
           m.series,
           m.packing,
           m.is_ambiguous_code,
           h.mrp::text            AS current_mrp,
           h.effective_from::text AS effective_from,
           (SELECT COUNT(*)::text
            FROM mrp_history h2
            WHERE h2.item_code = m.item_code
              AND h2.segment    = m.segment) AS history_count
         FROM mrp_master m
         LEFT JOIN mrp_history h
           ON h.item_code = m.item_code
          AND h.segment   = m.segment
          AND h.is_current = TRUE
         ${where}
         ORDER BY m.is_ambiguous_code DESC, m.segment, m.series NULLS LAST, m.item_code
         LIMIT $${p} OFFSET $${p + 1}`,
        [...params, limit, offset],
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM mrp_master m ${where}`,
        params,
      ),
    ]);

    res.json({
      total: parseInt(totalResult.rows[0]?.total ?? "0", 10),
      limit,
      offset,
      rows: rowsResult.rows.map((r) => ({
        itemCode: r.item_code,
        itemName: r.item_name,
        segment: r.segment,
        series: r.series,
        packing: r.packing,
        isAmbiguousCode: r.is_ambiguous_code,
        currentMrp: r.current_mrp ? parseFloat(r.current_mrp) : null,
        effectiveFrom: r.effective_from,
        historyCount: parseInt(r.history_count, 10),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "mrp list error");
    res.status(500).json({ error: "Failed to load MRP data" });
  }
});

// ── GET /api/mrp/meta ─────────────────────────────────────────────────────
router.get("/mrp/meta", async (_req, res) => {
  try {
    const [segResult, serResult, countResult] = await Promise.all([
      pool.query<{ segment: string }>(
        "SELECT DISTINCT segment FROM mrp_master ORDER BY segment",
      ),
      pool.query<{ segment: string; series: string }>(
        "SELECT DISTINCT segment, series FROM mrp_master WHERE series IS NOT NULL ORDER BY segment, series",
      ),
      pool.query<{ total: string; with_history: string; ambiguous: string }>(
        `SELECT
           COUNT(*)::text AS total,
           (SELECT COUNT(*)::text
            FROM mrp_history
            WHERE is_current = FALSE) AS with_history,
           (SELECT COUNT(DISTINCT item_code)::text
            FROM mrp_master
            WHERE is_ambiguous_code = TRUE) AS ambiguous
         FROM mrp_master`,
      ),
    ]);

    const seriesBySegment: Record<string, string[]> = {};
    for (const row of serResult.rows) {
      (seriesBySegment[row.segment] ??= []).push(row.series);
    }

    res.json({
      segments: segResult.rows.map((r) => r.segment),
      seriesBySegment,
      totalCodes: parseInt(countResult.rows[0]?.total ?? "0", 10),
      codesWithRevision: parseInt(countResult.rows[0]?.with_history ?? "0", 10),
      ambiguousCodes: parseInt(countResult.rows[0]?.ambiguous ?? "0", 10),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load MRP meta" });
  }
});

// ── GET /api/mrp/stats ────────────────────────────────────────────────────
router.get("/mrp/stats", async (req, res) => {
  try {
    // Distinct MRP codes and sale_line FY2026-27 codes.
    // For the resolver, use DISTINCT item_code (one entry per code, not per segment)
    // since the register code has no segment information.
    const [mrpCodesResult, slCodesResult] = await Promise.all([
      pool.query<{ item_code: string }>("SELECT DISTINCT item_code FROM mrp_master"),
      pool.query<{ code: string }>(
        "SELECT DISTINCT code FROM sale_line_current WHERE fy = '2026-27' AND code IS NOT NULL AND code <> ''",
      ),
    ]);

    const masterCodes = mrpCodesResult.rows.map((r) => r.item_code);
    const { has, codes: masterArr } = buildResolverIndex(masterCodes);

    const methods: Record<string, number> = {
      exact: 0,
      p_strip: 0,
      colour_suffix: 0,
      whitespace: 0,
      unresolved: 0,
    };
    const unresolvedCodes: Record<string, number> = {};

    for (const { code } of slCodesResult.rows) {
      const result = resolveProductCode(code, has, masterArr);
      methods[result.method] = (methods[result.method] ?? 0) + 1;
      if (result.method === "unresolved") {
        const prefix = code.slice(0, 4);
        unresolvedCodes[prefix] = (unresolvedCodes[prefix] ?? 0) + 1;
      }
    }

    // Top 10 unresolved prefixes
    const top10Unresolved = Object.entries(unresolvedCodes)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([prefix, count]) => ({ prefix, count }));

    // Codes in MRP with no match in sale_line
    const slCodeSet = new Set(slCodesResult.rows.map((r) => r.code));
    const slCodesArr = slCodesResult.rows.map((r) => r.code);
    const mrpWithNoRegister = masterCodes.filter((c) => {
      const { masterCode } = resolveProductCode(c, (code) => slCodeSet.has(code), slCodesArr);
      return masterCode == null;
    }).length;

    // FY2026-27 amount for codes that NOW have MRP (previously had none in item_master)
    const netForNewlyMrpResult = await pool.query<{ net: string }>(
      `SELECT COALESCE(SUM(sl.amount),0)::text AS net
       FROM sale_line_current sl
       WHERE sl.fy = '2026-27'
         AND sl.code IN (SELECT DISTINCT item_code FROM mrp_master)
         AND sl.code NOT IN (SELECT code FROM item_master WHERE mrp IS NOT NULL)`,
    );

    res.json({
      mrpMasterCount: masterCodes.length,
      saleLineDistinctCodes: slCodesResult.rows.length,
      matchMethods: methods,
      top10UnresolvedPrefixes: top10Unresolved,
      mrpCodesWithNoRegisterMatch: mrpWithNoRegister,
      netForNewlyMrpCodes: parseFloat(netForNewlyMrpResult.rows[0]?.net ?? "0"),
    });
  } catch (err) {
    req.log?.error({ err }, "mrp stats error");
    res.status(500).json({ error: "Failed to compute MRP stats" });
  }
});

// ── GET /api/mrp/:code/history ────────────────────────────────────────────
// ?segment=PTMT  — required when the code is ambiguous (appears in 2+ segments).
// Without ?segment on an ambiguous code the route returns 409 with the list of
// available segments so the caller can retry with the right one.
router.get("/mrp/:code/history", async (req, res) => {
  try {
    const code = req.params.code;
    const segmentParam =
      typeof req.query.segment === "string" ? req.query.segment : null;

    // Check whether this code is ambiguous
    const ambigResult = await pool.query<{ segment: string; item_name: string | null; series: string | null; packing: string | null; is_ambiguous: boolean }>(
      `SELECT segment, item_name, series, packing,
              (SELECT COUNT(DISTINCT segment) > 1
               FROM mrp_master m2
               WHERE m2.item_code = m.item_code) AS is_ambiguous
       FROM mrp_master m
       WHERE m.item_code = $1
       ORDER BY m.segment`,
      [code],
    );

    if (ambigResult.rowCount === 0) {
      res.status(404).json({ error: "Item code not found in MRP master" });
      return;
    }

    const isAmbiguous = ambigResult.rows[0].is_ambiguous;
    const availableSegments = ambigResult.rows.map((r) => r.segment);

    // Ambiguous code with no segment supplied → refuse to guess
    if (isAmbiguous && !segmentParam) {
      res.status(409).json({
        error: "ambiguous code, segment required",
        reason: `Code ${code} exists in ${availableSegments.length} segments. Supply ?segment= to disambiguate.`,
        availableSegments,
      });
      return;
    }

    // Determine which segment to use
    const targetSegment = segmentParam ?? availableSegments[0];
    const masterRow = ambigResult.rows.find((r) => r.segment === targetSegment);
    if (!masterRow) {
      res.status(404).json({
        error: `Code ${code} not found in segment ${targetSegment}`,
        availableSegments,
      });
      return;
    }

    const history = await pool.query<{
      id: number; mrp: string; effective_from: string;
      effective_to: string | null; source_file: string; is_current: boolean;
    }>(
      `SELECT id, mrp::text, effective_from::text, effective_to::text, source_file, is_current
       FROM mrp_history
       WHERE item_code = $1 AND segment = $2
       ORDER BY effective_from`,
      [code, targetSegment],
    );

    res.json({
      itemCode: code,
      itemName: masterRow.item_name,
      segment: targetSegment,
      series: masterRow.series,
      packing: masterRow.packing,
      isAmbiguousCode: isAmbiguous,
      availableSegments: isAmbiguous ? availableSegments : undefined,
      history: history.rows.map((h) => ({
        id: h.id,
        mrp: parseFloat(h.mrp),
        effectiveFrom: h.effective_from,
        effectiveTo: h.effective_to,
        sourceFile: h.source_file,
        isCurrent: h.is_current,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "mrp history error");
    res.status(500).json({ error: "Failed to load MRP history" });
  }
});

// ── POST /api/admin/mrp/load ──────────────────────────────────────────────
router.post("/admin/mrp/load", async (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin authorisation required. Pass the SESSION_SECRET as: X-Admin-Secret: <SESSION_SECRET>" });
    return;
  }

  try {
    req.log.info("mrp/load: starting xlsx parse");
    const stats = await loadMrpFiles();
    req.log.info({ stats: { ...stats, collisions: `${stats.collisions.length} entries` } }, "mrp/load: complete");

    // Verify sample: one ambiguous code shows one is_current per segment
    const sampleResult = await pool.query<{
      item_code: string; segment: string; mrp: string;
      effective_from: string; effective_to: string | null; is_current: boolean;
    }>(
      `SELECT h.item_code, h.segment, h.mrp::text, h.effective_from::text,
              h.effective_to::text, h.is_current
       FROM mrp_history h
       WHERE h.item_code = 'CNS-15'
       ORDER BY h.segment, h.effective_from`,
    );

    res.json({
      ok: true,
      stats: {
        ...stats,
        collisionCount: stats.collisions.length,
      },
      collisions: stats.collisions,   // full list for price-list owner review
      cns15Verification: sampleResult.rows,  // one is_current per segment expected
    });
  } catch (err) {
    req.log.error({ err }, "mrp/load error");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
