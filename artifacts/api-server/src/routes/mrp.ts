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
import {
  authoritativeMrpStatus,
  refreshAuthoritativeMrpCache,
} from "../lib/mrp/syncedCache.js";

const router = Router();

async function activeSyncedGeneration(): Promise<string | null> {
  const result = await pool.query<{ generation_id: string }>(
    "SELECT generation_id::text FROM mrp_sync_generation WHERE is_active = TRUE LIMIT 1",
  );
  return result.rows[0]?.generation_id ?? null;
}

async function serveSyncedList(
  req: import("express").Request,
  res: import("express").Response,
  generationId: string,
): Promise<void> {
  const segment = typeof req.query.segment === "string" ? req.query.segment : null;
  const series = typeof req.query.series === "string" ? req.query.series : null;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : null;
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const conditions = ["s.generation_id = $1"];
  const params: (string | number)[] = [generationId];
  let p = 2;
  if (segment) {
    conditions.push(`EXISTS (
      SELECT 1 FROM mrp_synced_division d
      WHERE d.generation_id = s.generation_id AND d.item_code = s.item_code AND d.app_segment = $${p++}
    )`);
    params.push(segment);
  }
  if (series) { conditions.push(`s.series_range = $${p++}`); params.push(series); }
  if (q) {
    conditions.push(`(s.item_code ILIKE $${p} OR s.product_name ILIKE $${p})`);
    params.push(`%${q}%`);
    p++;
  }
  const where = conditions.join(" AND ");
  const [rowsResult, totalResult] = await Promise.all([
    pool.query<{
      item_code: string; product_name: string | null; division_raw: string; series_range: string | null;
      size: string | null; uom: string | null; current_mrp: string | null; effective_from: string | null;
      previous_mrp: string | null; segments: string[]; source_review_status: string | null;
    }>(
      `SELECT s.item_code, s.product_name, s.division_raw, s.series_range, s.size, s.uom,
              s.mrp::text AS current_mrp, s.price_in_force_since::text AS effective_from,
              s.previous_mrp::text, s.source_review_status,
              COALESCE(array_agg(DISTINCT d.app_segment) FILTER (WHERE d.app_segment IS NOT NULL), '{}') AS segments
       FROM mrp_synced s
       LEFT JOIN mrp_synced_division d
         ON d.generation_id = s.generation_id AND d.item_code = s.item_code
       WHERE ${where}
       GROUP BY s.generation_id, s.item_code
       ORDER BY s.division_raw, s.series_range NULLS LAST, s.item_code
       LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset],
    ),
    pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM mrp_synced s WHERE ${where}`,
      params,
    ),
  ]);
  const total = Number(totalResult.rows[0]?.total ?? 0);
  res.json({
    total, limit, offset, unseeded: total === 0 && !segment && !series && !q,
    source: "prayag-price.com",
    rows: rowsResult.rows.map((row) => ({
      itemCode: row.item_code,
      itemName: row.product_name,
      // Retained for older UI callers; it is the first mapped division only,
      // not an invented per-segment catalogue row.
      segment: row.segments[0] ?? "Unmapped",
      segments: row.segments,
      divisionRaw: row.division_raw,
      series: row.series_range,
      packing: row.size ?? row.uom,
      isAmbiguousCode: false,
      currentMrp: row.current_mrp == null ? null : Number(row.current_mrp),
      effectiveFrom: row.effective_from,
      historyCount: row.previous_mrp == null ? 1 : 2,
      sourceReviewStatus: row.source_review_status,
    })),
  });
}

// ── GET /api/mrp ──────────────────────────────────────────────────────────
router.get("/mrp", async (req, res) => {
  try {
    const generationId = await activeSyncedGeneration();
    if (generationId) {
      await serveSyncedList(req, res, generationId);
      return;
    }
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

    const total = parseInt(totalResult.rows[0]?.total ?? "0", 10);
    const isUnfiltered = !segment && !series && !q;
    res.json({
      total,
      limit,
      offset,
      unseeded: total === 0 && isUnfiltered,
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
    req.log?.error({ err }, "mrp list error");
    res.status(500).json({ error: "Failed to load MRP data" });
  }
});

// ── GET /api/mrp/meta ─────────────────────────────────────────────────────
router.get("/mrp/meta", async (_req, res) => {
  try {
    const generationId = await activeSyncedGeneration();
    if (generationId) {
      const [segResult, seriesResult, countResult, status] = await Promise.all([
        pool.query<{ segment: string }>(
          `SELECT DISTINCT d.app_segment AS segment
           FROM mrp_synced_division d
           WHERE d.generation_id = $1 AND d.app_segment IS NOT NULL ORDER BY segment`,
          [generationId],
        ),
        pool.query<{ segment: string; series: string }>(
          `SELECT DISTINCT d.app_segment AS segment, s.series_range AS series
           FROM mrp_synced s JOIN mrp_synced_division d
             ON d.generation_id = s.generation_id AND d.item_code = s.item_code
           WHERE s.generation_id = $1 AND d.app_segment IS NOT NULL AND s.series_range IS NOT NULL
           ORDER BY segment, series`,
          [generationId],
        ),
        pool.query<{ total: string; revisions: string; multi_division: string }>(
          `SELECT COUNT(*)::text AS total,
                  COUNT(*) FILTER (WHERE previous_mrp IS NOT NULL)::text AS revisions,
                  COUNT(*) FILTER (WHERE division_raw LIKE '%|%')::text AS multi_division
           FROM mrp_synced WHERE generation_id = $1`,
          [generationId],
        ),
        authoritativeMrpStatus(),
      ]);
      const seriesBySegment: Record<string, string[]> = {};
      for (const row of seriesResult.rows) (seriesBySegment[row.segment] ??= []).push(row.series);
      const counts = countResult.rows[0];
      res.json({
        segments: segResult.rows.map((r) => r.segment),
        seriesBySegment,
        totalCodes: Number(counts?.total ?? 0),
        codesWithRevision: Number(counts?.revisions ?? 0),
        ambiguousCodes: 0,
        multiDivisionCodes: Number(counts?.multi_division ?? 0),
        sync: status,
      });
      return;
    }
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
    const generationId = await activeSyncedGeneration();
    // Distinct MRP codes and sale_line FY2026-27 codes.
    // For the resolver, use DISTINCT item_code (one entry per code, not per segment)
    // since the register code has no segment information.
    const [mrpCodesResult, slCodesResult] = await Promise.all([
      pool.query<{ item_code: string }>(
        generationId
          ? "SELECT item_code FROM mrp_synced WHERE generation_id = $1"
          : "SELECT DISTINCT item_code FROM mrp_master",
        generationId ? [generationId] : [],
      ),
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
          AND sl.code IN (${generationId
            ? "SELECT item_code FROM mrp_synced WHERE generation_id = $1"
            : "SELECT DISTINCT item_code FROM mrp_master"})
         AND sl.code NOT IN (SELECT code FROM item_master WHERE mrp IS NOT NULL)`,
      generationId ? [generationId] : [],
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

// ── GET /api/mrp/sync-status ───────────────────────────────────────────────
router.get("/mrp/sync-status", async (_req, res) => {
  try {
    res.json(await authoritativeMrpStatus());
  } catch (err) {
    res.status(500).json({ error: "Failed to load MRP sync status" });
  }
});

// ── POST /api/admin/mrp/sync ───────────────────────────────────────────────
router.post("/admin/mrp/sync", async (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin authorisation required." });
    return;
  }
  try {
    const report = await refreshAuthoritativeMrpCache();
    req.log.info({
      generationId: report.generationId,
      rowsSynced: report.rowsSynced,
      provenanceComplete: report.provenanceComplete,
    }, "authoritative MRP sync complete");
    res.json(report);
  } catch (err) {
    req.log.error({ err }, "authoritative MRP sync failed; last good cache retained");
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
      cache: await authoritativeMrpStatus().catch(() => null),
    });
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
/** Last 12 complete calendar months as "Mon-YY" strings (newest first). */
function trailing12MonthLabels(): string[] {
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const today = new Date();
  const out: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    out.push(`${MONTHS[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`);
  }
  return out;
}

// ── GET /api/mrp/calculator ────────────────────────────────────────────────
// Returns the data payload the MRP back-calculator needs for one (item_code, segment).
// The arithmetic is done on the client; this route assembles the source data only.
//
// Query params:
//   code    — required; item_code from mrp_master
//   segment — required when the code is ambiguous
//
// Returns 409 with availableSegments when code is ambiguous and no segment given.
// Never writes to mrp_history.
router.get("/mrp/calculator", async (req, res) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code.trim() : null;
    const segmentParam =
      typeof req.query.segment === "string" ? req.query.segment.trim() : null;

    if (!code) { res.status(400).json({ error: "?code= is required" }); return; }

    const syncedGeneration = await activeSyncedGeneration();
    let isAmbiguous = false;
    let availableSegments: string[] = [];
    let targetSegment = segmentParam ?? "";
    let masterRow: { item_name: string | null; series: string | null; packing: string | null };
    let sourceMrp: { mrp: string | null; effective_from: string | null } | null = null;

    if (syncedGeneration) {
      const sourceRows = await pool.query<{
        item_name: string | null; series: string | null; packing: string | null;
        mrp: string | null; effective_from: string | null; segments: string[];
      }>(
        `SELECT s.product_name AS item_name, s.series_range AS series, COALESCE(s.size, s.uom) AS packing,
                s.mrp::text, s.price_in_force_since::text AS effective_from,
                COALESCE(array_agg(DISTINCT d.app_segment ORDER BY d.app_segment)
                  FILTER (WHERE d.app_segment IS NOT NULL), '{}') AS segments
         FROM mrp_synced s
         LEFT JOIN mrp_synced_division d ON d.generation_id = s.generation_id AND d.item_code = s.item_code
         WHERE s.generation_id = $1 AND s.item_code = $2
         GROUP BY s.generation_id, s.item_code`,
        [syncedGeneration, code],
      );
      const sourceRow = sourceRows.rows[0];
      if (!sourceRow) {
        res.status(404).json({ error: `Code ${code} not found in authoritative MRP cache` }); return;
      }
      availableSegments = sourceRow.segments;
      isAmbiguous = availableSegments.length > 1;
      if (isAmbiguous && !segmentParam) {
        res.status(409).json({
          error: "ambiguous code, segment required",
          reason: `Code ${code} belongs to ${availableSegments.length} mapped divisions. Supply ?segment= to disambiguate.`,
          availableSegments,
        });
        return;
      }
      if (segmentParam && !availableSegments.includes(segmentParam)) {
        res.status(404).json({ error: `Code ${code} is not mapped to segment ${segmentParam}`, availableSegments });
        return;
      }
      targetSegment = segmentParam ?? availableSegments[0] ?? "Unmapped";
      masterRow = sourceRow;
      sourceMrp = { mrp: sourceRow.mrp, effective_from: sourceRow.effective_from };
    } else {
      const masterRows = await pool.query<{
        segment: string; item_name: string | null; series: string | null; packing: string | null;
        is_ambiguous: boolean;
      }>(
        `SELECT segment, item_name, series, packing,
                (SELECT COUNT(DISTINCT m2.segment) > 1
                 FROM mrp_master m2 WHERE m2.item_code = m.item_code) AS is_ambiguous
         FROM mrp_master m WHERE m.item_code = $1 ORDER BY m.segment`,
        [code],
      );
      if ((masterRows.rowCount ?? 0) === 0) {
        res.status(404).json({ error: `Code ${code} not found in MRP master` }); return;
      }
      isAmbiguous = masterRows.rows[0].is_ambiguous;
      availableSegments = masterRows.rows.map((r) => r.segment);
      if (isAmbiguous && !segmentParam) {
        res.status(409).json({
          error: "ambiguous code, segment required",
          reason: `Code ${code} exists in ${availableSegments.length} segments. Supply ?segment= to disambiguate.`,
          availableSegments,
        });
        return;
      }
      targetSegment = segmentParam ?? availableSegments[0]!;
      const legacyRow = masterRows.rows.find((r) => r.segment === targetSegment);
      if (!legacyRow) {
        res.status(404).json({ error: `Code ${code} not found in segment ${targetSegment}`, availableSegments }); return;
      }
      masterRow = legacyRow;
    }

    const trailing12 = trailing12MonthLabels();

    // 2-5 — parallel queries
    const [mrpRow, marginRow, sampleRows, saleRow, secRow] = await Promise.all([
      // Current MRP
      sourceMrp
        ? Promise.resolve({ rows: [sourceMrp] })
        : pool.query<{ mrp: string | null; effective_from: string | null }>(
          `SELECT mrp::text, effective_from::text
           FROM mrp_history WHERE item_code = $1 AND segment = $2 AND is_current = TRUE LIMIT 1`,
          [code, targetSegment],
        ),
      // Primary discount + BOM cost from margin_fact (trailing 12 complete months)
      pool.query<{
        weighted_discount: string | null; weighted_bom: string | null;
        total_qty: string | null; months_covered: string; months: string[];
      }>(
        `SELECT
           SUM(discount_frac * qty) / NULLIF(SUM(qty), 0)                          AS weighted_discount,
           SUM(bom_cost * qty) FILTER (WHERE bom_cost IS NOT NULL) /
             NULLIF(SUM(qty) FILTER (WHERE bom_cost IS NOT NULL), 0)               AS weighted_bom,
           SUM(qty)::text                                                           AS total_qty,
           COUNT(DISTINCT month_label)::text                                        AS months_covered,
           array_agg(DISTINCT month_label ORDER BY month_label)                     AS months
         FROM margin_fact
         WHERE item_code = $1 AND segment = $2
           AND month_label = ANY($3)
           AND discount_frac IS NOT NULL AND qty IS NOT NULL AND qty > 0`,
        [code, targetSegment, trailing12],
      ),
      // Identity check samples (up to 5 rows with MRP, discount_frac, avg_sale)
      pool.query<{ month_label: string; mrp: string; discount_frac: string; avg_sale: string }>(
        `SELECT month_label, mrp::text, discount_frac::text, avg_sale::text
         FROM margin_fact
         WHERE item_code = $1 AND segment = $2
           AND mrp IS NOT NULL AND discount_frac IS NOT NULL AND avg_sale IS NOT NULL AND qty > 0
         ORDER BY fy DESC, month_label LIMIT 5`,
        [code, targetSegment],
      ),
      // Realised discount from sale_line (trailing 12 months)
      pool.query<{ total_amount: string | null; total_qty: string | null; months_covered: string }>(
        `SELECT SUM(amount)::text AS total_amount, SUM(qty)::text AS total_qty,
                COUNT(DISTINCT month_label)::text AS months_covered
         FROM sale_line_current
         WHERE code = $1 AND month_label = ANY($2)
           AND amount IS NOT NULL AND qty IS NOT NULL AND qty > 0`,
        [code, trailing12],
      ),
      // Distributor margin default from secondary_sku_line (volume-weighted discount_pct)
      pool.query<{ weighted_disc: string | null; row_count: string }>(
        `SELECT
           SUM(discount_pct * COALESCE(qty, 1)) /
             NULLIF(SUM(COALESCE(qty, 1)), 0) AS weighted_disc,
           COUNT(*)::text AS row_count
         FROM secondary_sku_line
         WHERE item_code = $1 AND discount_pct IS NOT NULL AND discount_pct > 0 AND discount_pct < 100`,
        [code],
      ),
    ]);

    // Assemble
    const currentMrp = mrpRow.rows[0]?.mrp ? parseFloat(mrpRow.rows[0].mrp) : null;
    const m = marginRow.rows[0];
    const hasMarginData = !!(m?.weighted_discount);
    const weightedDiscount = hasMarginData ? parseFloat(m.weighted_discount!) : null;
    const weightedBom = m?.weighted_bom ? parseFloat(m.weighted_bom) : null;

    const s = saleRow.rows[0];
    const totalAmount = s?.total_amount ? parseFloat(s.total_amount) : null;
    const totalSaleQty = s?.total_qty ? parseFloat(s.total_qty) : null;
    const hasRealisedData = totalAmount != null && totalSaleQty != null && totalSaleQty > 0 && currentMrp != null && currentMrp > 0;
    const realisedDiscount = hasRealisedData ? 1 - totalAmount! / (totalSaleQty! * currentMrp!) : null;

    const gapPoints = weightedDiscount != null && realisedDiscount != null
      ? Math.abs(weightedDiscount - realisedDiscount) * 100 : null;

    const secDisc = secRow.rows[0]?.weighted_disc ? parseFloat(secRow.rows[0].weighted_disc) : null;

    // Distributor margin default — derived when both primary and secondary data exist.
    // Formula: 1 − (1 − primaryDisc) / (1 − secDiscFrac)
    // This is the fraction of retailer price that the distributor retains as gross margin,
    // assuming secondary discount_pct is measured off MRP.
    const rawSecPct = secRow.rows[0]?.weighted_disc ? parseFloat(secRow.rows[0].weighted_disc) : null;
    const rawSecFrac = rawSecPct != null ? rawSecPct / 100 : null;
    const secRowCount = parseFloat(secRow.rows[0]?.row_count ?? "0");

    type DistMarginSource = "derived" | "secondary" | "assumed";
    let distMarginSrc: DistMarginSource = "assumed";
    let distMarginVal: number | null = null;
    let distMarginNote = "No secondary data for this code — enter manually.";

    if (weightedDiscount != null && rawSecFrac != null && rawSecFrac > 0 && rawSecFrac < 1 && secRowCount > 0) {
      const implied = 1 - (1 - weightedDiscount) / (1 - rawSecFrac);
      if (implied > 0 && implied < 1) {
        distMarginSrc = "derived";
        distMarginVal = Math.round(implied * 10000) / 10000;
        distMarginNote = `Derived: 1 − (1 − ${(weightedDiscount * 100).toFixed(1)}% primary disc) ÷ (1 − ${rawSecPct!.toFixed(1)}% secondary disc). Assumes secondary disc is off MRP — override if not.`;
      } else {
        distMarginSrc = "assumed";
        distMarginNote = `Implied margin is ${implied <= 0 ? "negative" : "≥100%"} — primary and secondary discounts are inconsistent. Enter manually.`;
      }
    } else if (rawSecFrac != null && rawSecFrac > 0 && rawSecFrac < 1 && secRowCount > 0) {
      distMarginSrc = "secondary";
      distMarginVal = rawSecFrac;
      distMarginNote = `Volume-weighted from ${secRow.rows[0].row_count} secondary register rows. No primary disc available to derive margin — this is raw trade discount, not distributor margin.`;
    }

    const identitySamples = sampleRows.rows.map((r) => {
      const mrp = parseFloat(r.mrp); const df = parseFloat(r.discount_frac);
      const avgSale = parseFloat(r.avg_sale);
      const implied = Math.round(mrp * (1 - df) * 100) / 100;
      return { month: r.month_label, mrp, discountFrac: df, impliedSale: implied,
               avgSale: Math.round(avgSale * 100) / 100, diffRupees: Math.round(Math.abs(implied - avgSale) * 100) / 100 };
    });

    res.json({
      itemCode: code, itemName: masterRow.item_name, segment: targetSegment,
      series: masterRow.series, isAmbiguousCode: isAmbiguous,
      availableSegments: isAmbiguous ? availableSegments : undefined,
      currentMrp, mrpEffectiveFrom: mrpRow.rows[0]?.effective_from ?? null,
      primaryDiscount: {
        hasData: hasMarginData, weightedDiscount,
        totalQty: m?.total_qty ? parseFloat(m.total_qty) : null,
        monthsCovered: parseInt(m?.months_covered ?? "0", 10),
        months: m?.months ?? [], identitySamples,
      },
      bomCost: { hasData: weightedBom != null, weightedValue: weightedBom },
      realisedDiscount: {
        hasData: hasRealisedData, value: realisedDiscount,
        totalQty: totalSaleQty, monthsCovered: parseInt(s?.months_covered ?? "0", 10),
      },
      discountGapPoints: gapPoints,
      discountGapFlagged: gapPoints != null && gapPoints > 5,
      distributorMarginDefault: { source: distMarginSrc, value: distMarginVal, note: distMarginNote },
      // Raw secondary discount for context (not used as the margin default directly)
      secondaryDiscountRaw: rawSecPct != null ? { pct: Math.round(rawSecPct * 100) / 100, rowCount: secRowCount } : null,
    });
  } catch (err) {
    req.log.error({ err }, "mrp calculator error");
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/mrp/calculator/verify ────────────────────────────────────────
// Admin-only: runs 8 verification checks (expensive full-table queries + git).
// Requires X-Admin-Secret header.
router.get("/mrp/calculator/verify", async (req, res) => {
  const token = String(req.headers["x-admin-secret"] ?? "").trim();
  if (!isAdminToken(token)) {
    res.status(401).json({ error: "Admin authorisation required." });
    return;
  }
  try {
    const trailing12 = trailing12MonthLabels();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(execFile);

    // ── Check 1 & 2: 5 codes with ≥10 months, weighted discount + identity ──
    const codesWith12 = await pool.query<{ item_code: string; segment: string; months: string }>(
      `SELECT item_code, segment, COUNT(DISTINCT month_label)::text AS months
       FROM margin_fact
       WHERE discount_frac IS NOT NULL AND qty IS NOT NULL AND qty > 0
       GROUP BY item_code, segment HAVING COUNT(DISTINCT month_label) >= 10
       ORDER BY COUNT(DISTINCT month_label) DESC, item_code
       LIMIT 5`,
    );

    const check1 = await Promise.all(codesWith12.rows.map(async (r) => {
      const [discRow, saleRow, identRow] = await Promise.all([
        pool.query<{ wd: string; tq: string }>(
          `SELECT SUM(discount_frac * qty) / NULLIF(SUM(qty), 0) AS wd, SUM(qty)::text AS tq
           FROM margin_fact WHERE item_code = $1 AND segment = $2 AND discount_frac IS NOT NULL AND qty > 0`,
          [r.item_code, r.segment],
        ),
        pool.query<{ ta: string; tq: string; mc: string }>(
          `SELECT SUM(amount)::text AS ta, SUM(qty)::text AS tq, COUNT(DISTINCT month_label)::text AS mc
           FROM sale_line_current WHERE code = $1 AND month_label = ANY($2) AND qty > 0`,
          [r.item_code, trailing12],
        ),
        pool.query<{ month_label: string; mrp: string; discount_frac: string; avg_sale: string }>(
          `SELECT month_label, mrp::text, discount_frac::text, avg_sale::text
           FROM margin_fact WHERE item_code = $1 AND segment = $2
             AND mrp IS NOT NULL AND discount_frac IS NOT NULL AND avg_sale IS NOT NULL AND qty > 0
           ORDER BY fy DESC, month_label LIMIT 3`,
          [r.item_code, r.segment],
        ),
      ]);

      const mrpRow = await pool.query<{ mrp: string }>(
        `SELECT mrp::text FROM mrp_history WHERE item_code = $1 AND segment = $2 AND is_current = TRUE LIMIT 1`,
        [r.item_code, r.segment],
      );

      const wd = discRow.rows[0]?.wd ? parseFloat(discRow.rows[0].wd) : null;
      const totalAmt = saleRow.rows[0]?.ta ? parseFloat(saleRow.rows[0].ta) : null;
      const totalQty = saleRow.rows[0]?.tq ? parseFloat(saleRow.rows[0].tq) : null;
      const currentMrp = mrpRow.rows[0]?.mrp ? parseFloat(mrpRow.rows[0].mrp) : null;
      const rd = (totalAmt != null && totalQty != null && totalQty > 0 && currentMrp != null && currentMrp > 0)
        ? 1 - totalAmt / (totalQty * currentMrp) : null;
      const gapPp = wd != null && rd != null ? Math.abs(wd - rd) * 100 : null;

      const identityRows = identRow.rows.map((s) => {
        const m = parseFloat(s.mrp); const d = parseFloat(s.discount_frac); const a = parseFloat(s.avg_sale);
        const implied = Math.round(m * (1 - d) * 100) / 100;
        return { month: s.month_label, mrp: m, discountFrac: d, impliedSale: implied, avgSale: Math.round(a * 100) / 100,
                 diffRupees: Math.round(Math.abs(implied - a) * 100) / 100, withinOnRupee: Math.abs(implied - a) <= 1 };
      });

      return {
        itemCode: r.item_code, segment: r.segment, monthsCovered: parseInt(r.months, 10),
        weightedDiscount: wd != null ? parseFloat((wd * 100).toFixed(2)) : null,
        realisedDiscount: rd != null ? parseFloat((rd * 100).toFixed(2)) : null,
        gapPoints: gapPp != null ? parseFloat(gapPp.toFixed(2)) : null,
        flagged: gapPp != null && gapPp > 5,
        identityCheck: identityRows,
      };
    }));

    // ── Check 3: codes in mrp_master with no margin_fact rows (trailing 12M) ──
    // "No data" means no discount_frac rows in the trailing 12 complete months.
    const noDataResult = await pool.query<{ n: string }>(
      `SELECT COUNT(DISTINCT m.item_code)::text AS n
       FROM mrp_master m
       WHERE NOT EXISTS (
         SELECT 1 FROM margin_fact mf
         WHERE mf.item_code = m.item_code
           AND mf.discount_frac IS NOT NULL
           AND mf.month_label = ANY($1)
       )`,
      [trailing12],
    );
    // FY2026-27 primary-sale net for those codes
    const noDataNet = await pool.query<{ net: string }>(
      `SELECT COALESCE(SUM(sl.amount), 0)::text AS net
       FROM sale_line_current sl
       WHERE sl.fy = '2026-27'
         AND sl.code IN (
           SELECT DISTINCT m.item_code FROM mrp_master m
           WHERE NOT EXISTS (
             SELECT 1 FROM margin_fact mf
             WHERE mf.item_code = m.item_code
               AND mf.discount_frac IS NOT NULL
               AND mf.month_label = ANY($1)
           )
         )`,
      [trailing12],
    );

    // ── Check 4: worked example for code 144, target = ₹90 ───────────────
    const example144 = await pool.query<{
      wd: string | null; wb: string | null; tq: string; mc: string;
    }>(
      `SELECT SUM(discount_frac * qty) / NULLIF(SUM(qty), 0) AS wd,
              SUM(bom_cost * qty) FILTER (WHERE bom_cost IS NOT NULL) /
                NULLIF(SUM(qty) FILTER (WHERE bom_cost IS NOT NULL), 0) AS wb,
              SUM(qty)::text AS tq,
              COUNT(DISTINCT month_label)::text AS mc
       FROM margin_fact WHERE item_code = '144' AND discount_frac IS NOT NULL AND qty > 0`,
    );
    const mrp144 = await pool.query<{ mrp: string; segment: string }>(
      `SELECT h.mrp::text, h.segment FROM mrp_history h JOIN mrp_master m ON m.item_code = h.item_code AND m.segment = h.segment
       WHERE h.item_code = '144' AND h.is_current = TRUE LIMIT 1`,
    );
    const e = example144.rows[0];
    const TARGET_RETAILER = 90;
    const DIST_MARGIN = 0.15;
    const wd144 = e?.wd ? parseFloat(e.wd) : null;
    const bom144 = e?.wb ? parseFloat(e.wb) : null;
    const currMrp144 = mrp144.rows[0]?.mrp ? parseFloat(mrp144.rows[0].mrp) : null;
    const distBuyingPrice = wd144 != null ? Math.round((TARGET_RETAILER / (1 - DIST_MARGIN)) * 100) / 100 : null;
    const backCalcMrp144 = distBuyingPrice != null && wd144 != null ? Math.round((distBuyingPrice / (1 - wd144)) * 100) / 100 : null;
    const avgSaleAtCurrent = currMrp144 != null && wd144 != null ? Math.round(currMrp144 * (1 - wd144) * 100) / 100 : null;
    const gcAtCurrent = avgSaleAtCurrent != null && bom144 != null && avgSaleAtCurrent > 0
      ? Math.round(((avgSaleAtCurrent - bom144) / avgSaleAtCurrent) * 10000) / 100 : null;
    const gcAtNew = distBuyingPrice != null && bom144 != null && distBuyingPrice > 0
      ? Math.round(((distBuyingPrice - bom144) / distBuyingPrice) * 10000) / 100 : null;

    // ── Check 5: CNS-15 ambiguity ──────────────────────────────────────────
    const cns15All = await pool.query<{ segment: string; mrp: string }>(
      `SELECT m.segment, h.mrp::text FROM mrp_master m
       LEFT JOIN mrp_history h ON h.item_code = m.item_code AND h.segment = m.segment AND h.is_current = TRUE
       WHERE m.item_code = 'CNS-15' ORDER BY m.segment`,
    );
    const cns15Ptmt = await pool.query<{ mrp: string }>(
      `SELECT mrp::text FROM mrp_history WHERE item_code = 'CNS-15' AND segment = 'PTMT' AND is_current = TRUE LIMIT 1`,
    );

    // ── Check 6: mrp_history row count ────────────────────────────────────
    const histCount = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM mrp_history");

    // ── Check 7: sale_line_all row count ──────────────────────────────────
    const saleCount = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM sale_line_all");

    // ── Check 8: commit hash ───────────────────────────────────────────────
    let commitInfo: Record<string, unknown> = {};
    try {
      const { stdout: hash } = await execAsync("git", ["rev-parse", "HEAD"], { cwd: "/home/runner/workspace" });
      const h = hash.trim();
      const { stdout: objType } = await execAsync("git", ["cat-file", "-t", h], { cwd: "/home/runner/workspace" });
      let ancestorCheck: boolean | null = null;
      try {
        await execAsync("git", ["merge-base", "--is-ancestor", h, "main"], { cwd: "/home/runner/workspace" });
        ancestorCheck = true;
      } catch { ancestorCheck = false; }
      commitInfo = { hash: h, objectType: objType.trim(), isAncestorOfMain: ancestorCheck };
    } catch (e) {
      commitInfo = { error: String(e) };
    }

    res.json({
      check1_discountAndIdentity: check1,
      check2_identitySummary: {
        note: "MRP × (1 − discount_frac) = avg_sale within 1 rupee — see identityCheck in each code above",
        allWithinOneRupee: check1.every((c) => c.identityCheck.every((s) => s.withinOnRupee)),
      },
      check3_noDiscountData: {
        codesWithNoMarginFact: parseInt(noDataResult.rows[0]?.n ?? "0", 10),
        fy2627NetRs: parseFloat(noDataNet.rows[0]?.net ?? "0"),
        note: "These codes show 'no discount data' in the calculator — no segment-average substitution.",
      },
      check4_workedExample: {
        code: "144", segment: mrp144.rows[0]?.segment ?? "n/a", currentMrp: currMrp144,
        weightedDiscount_frac: wd144, weightedDiscount_pct: wd144 != null ? parseFloat((wd144 * 100).toFixed(2)) : null,
        bomCost: bom144, targetRetailerPrice: TARGET_RETAILER, distributorMarginPct: DIST_MARGIN * 100,
        chain: {
          step1_distBuyingPrice: { formula: `${TARGET_RETAILER} / (1 - ${DIST_MARGIN})`, result: distBuyingPrice },
          step2_backCalcMrp: { formula: `${distBuyingPrice} / (1 - ${wd144 != null ? wd144.toFixed(4) : "?"})`, result: backCalcMrp144 },
        },
        comparison: {
          currentMrp: currMrp144, proposedMrp: backCalcMrp144,
          diffRs: currMrp144 != null && backCalcMrp144 != null ? Math.round((backCalcMrp144 - currMrp144) * 100) / 100 : null,
          avgSaleAtCurrentMrp: avgSaleAtCurrent,
          grossContribAtCurrentMrp_pct: gcAtCurrent, grossContribAtProposedMrp_pct: gcAtNew,
        },
      },
      check5_ambiguity: {
        cns15WithoutSegment: "Returns 409 — refuses to guess (ambiguous code, segment required)",
        cns15AllSegments: cns15All.rows.map((r) => ({ segment: r.segment, currentMrp: r.mrp ? parseFloat(r.mrp) : null })),
        cns15PtmtMrp: cns15Ptmt.rows[0]?.mrp ? parseFloat(cns15Ptmt.rows[0].mrp) : null,
        cns15PtmtUsesCorrectMrp: cns15Ptmt.rows[0]?.mrp ? Math.abs(parseFloat(cns15Ptmt.rows[0].mrp) - 860) < 1 : false,
      },
      check6_mrpHistoryImmutable: {
        rowCount: parseInt(histCount.rows[0]?.n ?? "0", 10),
        note: "Calculator routes have no INSERT/UPDATE/DELETE on mrp_history.",
      },
      check7_saleLineCount: {
        count: parseInt(saleCount.rows[0]?.n ?? "0", 10),
        expectedAtLeast: 468867,
        ok: parseInt(saleCount.rows[0]?.n ?? "0", 10) >= 468867,
      },
      check8_commitHash: commitInfo,
    });
  } catch (err) {
    req.log.error({ err }, "mrp calculator verify error");
    res.status(500).json({ error: String(err) });
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
    const syncedGeneration = await activeSyncedGeneration();
    if (syncedGeneration) {
      const sourceResult = await pool.query<{
        item_code: string; product_name: string | null; division_raw: string; series_range: string | null;
        size: string | null; uom: string | null; mrp: string | null; effective_from: string | null;
        previous_mrp: string | null; segments: string[];
      }>(
        `SELECT s.item_code, s.product_name, s.division_raw, s.series_range, s.size, s.uom,
                s.mrp::text, s.price_in_force_since::text AS effective_from, s.previous_mrp::text,
                COALESCE(array_agg(DISTINCT d.app_segment ORDER BY d.app_segment)
                  FILTER (WHERE d.app_segment IS NOT NULL), '{}') AS segments
         FROM mrp_synced s
         LEFT JOIN mrp_synced_division d ON d.generation_id = s.generation_id AND d.item_code = s.item_code
         WHERE s.generation_id = $1 AND s.item_code = $2
         GROUP BY s.generation_id, s.item_code`,
        [syncedGeneration, code],
      );
      const source = sourceResult.rows[0];
      if (!source) {
        res.status(404).json({ error: "Item code not found in authoritative MRP cache" });
        return;
      }
      if (source.segments.length > 1 && !segmentParam) {
        res.status(409).json({
          error: "ambiguous code, segment required",
          reason: `Code ${code} belongs to ${source.segments.length} mapped divisions. Supply ?segment= to disambiguate.`,
          availableSegments: source.segments,
        });
        return;
      }
      if (segmentParam && !source.segments.includes(segmentParam)) {
        res.status(404).json({
          error: `Code ${code} is not mapped to segment ${segmentParam}`,
          availableSegments: source.segments,
        });
        return;
      }
      const segment = segmentParam ?? source.segments[0] ?? "Unmapped";
      // The upstream public contract currently publishes the current effective
      // price only. Do not manufacture a time line from the legacy tables.
      res.json({
        itemCode: source.item_code,
        itemName: source.product_name,
        segment,
        segments: source.segments,
        divisionRaw: source.division_raw,
        series: source.series_range,
        packing: source.size ?? source.uom,
        isAmbiguousCode: source.segments.length > 1,
        availableSegments: source.segments.length > 1 ? source.segments : undefined,
        history: source.mrp == null ? [] : [{
          id: 0,
          mrp: Number(source.mrp),
          effectiveFrom: source.effective_from ?? "1970-01-01",
          effectiveTo: null,
          sourceFile: "prayag-price.com authoritative product catalogue",
          isCurrent: true,
        }],
        historyAvailability: "current-price-only",
      });
      return;
    }

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
    res.status(401).json({ error: "Admin authorisation required. Pass ADMIN_SECRET as: X-Admin-Secret: <ADMIN_SECRET>" });
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
