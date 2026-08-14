// GET  /api/market-survey/meta                    — segments, known brands, picker states
// GET  /api/market-survey/customers               — customer_master autocomplete (?q=)
// GET  /api/market-survey/products                — mrp_master autocomplete (?segment=&q=)
// GET  /api/market-survey/purchase-lookup         — secondary register check (?customerId=&prayagItemCode=)
// GET  /api/market-survey                        — list surveys (?segment=&brand=&recorder=&limit=&offset=)
// POST /api/market-survey                        — submit multi-line; recorded_by = recorderName (self-declared)
// GET  /api/market-survey/summary                — per-item MRP vs median competitor net price
// GET  /api/market-survey/by-brand               — competitor brand aggregates
// GET  /api/market-survey/coverage               — segments × states with <5 surveys
// PATCH /api/market-survey/:id                   — edit within 24 h (same recorder)

import { Router } from "express";
import { pool } from "@workspace/db";

const router = Router();

// ── helpers ───────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  return null;
}
function num(v: unknown): number | null {
  const n = parseFloat(String(v));
  return isFinite(n) ? n : null;
}
function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

// ── GET /api/market-survey/meta ───────────────────────────────────────────
router.get("/market-survey/meta", async (req, res) => {
  try {
    const [segsResult, brandsResult, statesResult] = await Promise.all([
      pool.query<{ segment: string }>(
        "SELECT DISTINCT segment FROM mrp_master ORDER BY segment",
      ),
      pool.query<{ brand: string; n: string }>(
        `SELECT competitor_brand AS brand, COUNT(*)::text AS n
         FROM market_survey
         GROUP BY competitor_brand
         ORDER BY COUNT(*) DESC, competitor_brand
         LIMIT 200`,
      ),
      pool.query<{ state_canon: string; state_parent: string }>(
        "SELECT state_canon, state_parent FROM state_hierarchy WHERE picker_visible = true ORDER BY display_order",
      ),
    ]);

    const recorder = (req as Express.Request & { apiKey?: { name: string } }).apiKey?.name ?? null;

    res.json({
      segments: segsResult.rows.map((r) => r.segment),
      knownBrands: brandsResult.rows.map((r) => ({
        brand: r.brand,
        surveyCount: parseInt(r.n, 10),
      })),
      states: statesResult.rows.map((r) => ({
        canon: r.state_canon,
        parent: r.state_parent,
      })),
      recorder,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load meta" });
  }
});

// ── GET /api/market-survey/customers?q= ──────────────────────────────────
router.get("/market-survey/customers", async (req, res) => {
  try {
    const q = str(req.query.q);
    if (!q || q.length < 2) {
      res.json({ rows: [] });
      return;
    }
    const result = await pool.query<{
      id: string; company: string; state: string | null; district: string | null; type: string | null;
    }>(
      `SELECT id, company, state, district, type
       FROM customer_master
       WHERE (company ILIKE $1 OR id ILIKE $1)
         AND status = 'Active'
       ORDER BY company
       LIMIT 20`,
      [`%${q}%`],
    );
    res.json({
      rows: result.rows.map((r) => ({
        id: r.id,
        company: r.company,
        state: r.state,
        district: r.district,
        type: r.type,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Customer search failed" });
  }
});

// ── GET /api/market-survey/products?segment=&q= ──────────────────────────
router.get("/market-survey/products", async (req, res) => {
  try {
    const segment = str(req.query.segment);
    const q = str(req.query.q);
    const params: (string | number)[] = [];
    const conds: string[] = [];
    let p = 1;
    if (segment) { conds.push(`m.segment = $${p++}`); params.push(segment); }
    if (q)       { conds.push(`(m.item_code ILIKE $${p} OR m.item_name ILIKE $${p})`); params.push(`%${q}%`); p++; }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const result = await pool.query<{ item_code: string; item_name: string | null; segment: string; mrp: string | null }>(
      `SELECT m.item_code, m.item_name, m.segment,
              h.mrp::text AS mrp
       FROM mrp_master m
       LEFT JOIN mrp_history h ON h.item_code = m.item_code AND h.segment = m.segment AND h.is_current = TRUE
       ${where}
       ORDER BY m.segment, m.item_code
       LIMIT 50`,
      params,
    );
    res.json({
      rows: result.rows.map((r) => ({
        itemCode: r.item_code,
        itemName: r.item_name,
        segment: r.segment,
        currentMrp: r.mrp ? parseFloat(r.mrp) : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Product search failed" });
  }
});

// ── GET /api/market-survey/purchase-lookup ────────────────────────────────
// Check whether a customer (retailer) appears in the secondary register for
// the last 12 months. Optionally echoes back prayagItemCode for context.
// Used by the survey form to warn when Tab 1/2 choice may be wrong.
router.get("/market-survey/purchase-lookup", async (req, res) => {
  try {
    const customerId    = str(req.query.customerId);
    const prayagItemCode = str(req.query.prayagItemCode);

    if (!customerId) { res.status(400).json({ error: "customerId required" }); return; }

    const cmResult = await pool.query<{ company: string }>(
      "SELECT company FROM customer_master WHERE id = $1 LIMIT 1",
      [customerId],
    );
    if (!cmResult.rows.length) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const customerName = cmResult.rows[0].company;

    // Compute last 12 month labels ("Apr-25", "Aug-26", …)
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const now  = new Date();
    const last12: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      last12.push(`${MON[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`);
    }

    const result = await pool.query<{
      total_qty: string; line_count: string; months: string[] | null;
    }>(
      `SELECT
         COALESCE(SUM(qty), 0)::text                                              AS total_qty,
         COUNT(*)::text                                                            AS line_count,
         ARRAY_AGG(DISTINCT month_label ORDER BY month_label)
           FILTER (WHERE month_label IS NOT NULL)                                 AS months
       FROM secondary_register_line
       WHERE customer ILIKE $1
         AND month_label = ANY($2)`,
      [`%${customerName.replace(/[%_]/g, "\\$&")}%`, last12],
    );

    const row       = result.rows[0];
    const lineCount = parseInt(row?.line_count ?? "0", 10);
    const totalQty  = parseFloat(row?.total_qty ?? "0");

    res.json({
      found:        lineCount > 0,
      totalQty,
      lineCount,
      customerName,
      prayagItemCode,
      months:       row?.months ?? [],
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/market-survey ───────────────────────────────────────────────
// Submit a multi-line survey (one retailer, N item observations).
// Body: { recorderName, surveyType, customerId?, prospectName?,
//         pendingProspectId?, state?, district?, surveyedAt?,
//         lines: [{ segment, competitorBrand, entryMode, netPrice|mrp+discountPct,
//                   prayagItemCode?, competitorProduct?, unit?, packSize?, note? }] }
// recorded_by is self-declared — unverified.
router.post("/market-survey", async (req, res) => {
  try {
    const b = req.body as Record<string, unknown>;

    // ── Recorder ──────────────────────────────────────────────────────────
    const recorderName = str(b.recorderName);
    if (!recorderName) { res.status(400).json({ error: "recorderName is required" }); return; }

    // ── Survey type ───────────────────────────────────────────────────────
    const surveyType = str(b.surveyType);
    const VALID_TYPES = ["existing_sku", "new_sku", "new_customer"];
    if (!surveyType || !VALID_TYPES.includes(surveyType)) {
      res.status(400).json({ error: "surveyType must be existing_sku | new_sku | new_customer" });
      return;
    }
    const isExistingBuyer = surveyType !== "new_customer";

    // ── Lines ─────────────────────────────────────────────────────────────
    const rawLines = Array.isArray(b.lines) ? (b.lines as Record<string, unknown>[]) : null;
    if (!rawLines || rawLines.length === 0) {
      res.status(400).json({ error: "lines must be a non-empty array" });
      return;
    }

    // ── Retailer fields (shared across all lines) ─────────────────────────
    const customerId       = isExistingBuyer ? str(b.customerId)   : null;
    const prospectName     = !isExistingBuyer ? str(b.prospectName) : null;
    let   resolvedState    = str(b.state)    ?? null;
    let   resolvedDistrict = str(b.district) ?? null;
    const pendingProspectId = num(b.pendingProspectId);
    const surveyedAt        = str(b.surveyedAt);

    if (isExistingBuyer && !customerId) {
      res.status(400).json({ error: "customerId required for existing_sku / new_sku surveys" });
      return;
    }
    if (!isExistingBuyer && !prospectName && pendingProspectId == null) {
      res.status(400).json({ error: "prospectName or pendingProspectId required for new_customer surveys" });
      return;
    }

    if (customerId) {
      const check = await pool.query("SELECT 1 FROM customer_master WHERE id = $1 LIMIT 1", [customerId]);
      if ((check.rowCount ?? 0) === 0) {
        res.status(400).json({ error: `Customer ${customerId} not found in customer_master` });
        return;
      }
      if (!resolvedState || !resolvedDistrict) {
        const cm = await pool.query<{ state: string | null; district: string | null }>(
          "SELECT state, district FROM customer_master WHERE id = $1 LIMIT 1", [customerId],
        );
        if (!resolvedState)    resolvedState    = cm.rows[0]?.state    ?? null;
        if (!resolvedDistrict) resolvedDistrict = cm.rows[0]?.district ?? null;
      }
    }

    // ── Validate + parse each line ────────────────────────────────────────
    interface ParsedLine {
      segment: string; prayagItemCode: string | null; competitorBrand: string;
      competitorProduct: string | null; netPrice: number; mrp: number | null;
      discountPct: number | null; entryMode: string; unit: string;
      packSize: string | null; reasons: string[]; monthlyVolume: number | null; note: string | null;
    }
    const parsedLines: ParsedLine[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const l = rawLines[i];
      const n = i + 1;

      const segment = str(l.segment);
      if (!segment) { res.status(400).json({ error: `Line ${n}: segment required` }); return; }

      const competitorBrand = str(l.competitorBrand);
      if (!competitorBrand) { res.status(400).json({ error: `Line ${n}: competitorBrand required` }); return; }

      const entryMode = str(l.entryMode);
      if (entryMode !== "net_direct" && entryMode !== "mrp_discount") {
        res.status(400).json({ error: `Line ${n}: entryMode must be net_direct or mrp_discount` }); return;
      }

      let lineNet: number;
      let lineMrp: number | null = null;
      let lineDisc: number | null = null;

      if (entryMode === "net_direct") {
        const np = num(l.netPrice);
        if (np === null || np <= 0) { res.status(400).json({ error: `Line ${n}: netPrice must be positive` }); return; }
        lineNet = np;
      } else {
        lineMrp  = num(l.mrp);
        lineDisc = num(l.discountPct);
        if (!lineMrp || lineMrp <= 0) { res.status(400).json({ error: `Line ${n}: mrp must be positive` }); return; }
        if (lineDisc === null || lineDisc < 0 || lineDisc >= 100) {
          res.status(400).json({ error: `Line ${n}: discountPct must be 0–99.99` }); return;
        }
        lineNet = Math.round(lineMrp * (1 - lineDisc / 100) * 100) / 100;
      }

      parsedLines.push({
        segment,
        prayagItemCode:    str(l.prayagItemCode),
        competitorBrand:   competitorBrand.trim(),
        competitorProduct: str(l.competitorProduct),
        netPrice:          lineNet,
        mrp:               lineMrp,
        discountPct:       lineDisc,
        entryMode,
        unit:              str(l.unit) ?? "piece",
        packSize:          str(l.packSize),
        reasons:           Array.isArray(l.reasons) ? (l.reasons as unknown[]).map(String).filter(Boolean) : [],
        monthlyVolume:     num(l.monthlyVolume),
        note:              str(l.note),
      });
    }

    // ── Generate survey_id (groups all lines from this submission) ─────────
    const surveyId = crypto.randomUUID();

    // ── Insert one row per line ───────────────────────────────────────────
    const insertedRows: Array<{ id: number; netPrice: number }> = [];
    for (const pl of parsedLines) {
      const ins = await pool.query<{ id: number }>(
        `INSERT INTO market_survey
           (recorded_by, is_existing_buyer, customer_id, prospect_name,
            state, district, segment, prayag_item_code,
            competitor_brand, competitor_product,
            net_price, mrp, discount_pct, entry_mode,
            unit, pack_size, reasons, monthly_volume, note, surveyed_at,
            pending_prospect_id, survey_id, survey_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                 COALESCE($20::timestamptz, now()), $21, $22, $23)
         RETURNING id`,
        [
          recorderName, isExistingBuyer, customerId,
          prospectName ?? (pendingProspectId != null ? null : str(b.prospectName)),
          resolvedState, resolvedDistrict, pl.segment, pl.prayagItemCode,
          pl.competitorBrand, pl.competitorProduct,
          pl.netPrice, pl.mrp, pl.discountPct, pl.entryMode,
          pl.unit, pl.packSize, pl.reasons, pl.monthlyVolume, pl.note,
          surveyedAt, pendingProspectId, surveyId, surveyType,
        ],
      );
      insertedRows.push({ id: ins.rows[0].id, netPrice: pl.netPrice });
    }

    res.status(201).json({
      ok:          true,
      surveyId,
      rows:        insertedRows,
      rowCount:    insertedRows.length,
      recordedBy:  recorderName,
    });
  } catch (err) {
    req.log?.error({ err }, "market-survey POST error");
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// ── GET /api/market-survey ────────────────────────────────────────────────
router.get("/market-survey", async (req, res) => {
  try {
    const segment  = str(req.query.segment);
    const brand    = str(req.query.brand);
    const recorder = str(req.query.recorder);
    const limit    = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
    const offset   = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);

    const conds: string[] = [];
    const params: (string | number)[] = [];
    let p = 1;

    if (segment)  { conds.push(`s.segment = $${p++}`);           params.push(segment); }
    if (brand)    { conds.push(`s.competitor_brand ILIKE $${p++}`); params.push(`%${brand}%`); }
    if (recorder) { conds.push(`s.recorded_by = $${p++}`);       params.push(recorder); }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const [rowsResult, totalResult] = await Promise.all([
      pool.query<{
        id: number; surveyed_at: string; recorded_by: string;
        is_existing_buyer: boolean; customer_id: string | null; customer_company: string | null;
        prospect_name: string | null; state: string | null; district: string | null;
        segment: string; prayag_item_code: string | null;
        competitor_brand: string; competitor_product: string | null;
        net_price: string; mrp: string | null; discount_pct: string | null;
        entry_mode: string; unit: string; pack_size: string | null;
        reasons: string[]; monthly_volume: string | null; note: string | null;
        created_at: string; survey_id: string | null; survey_type: string | null;
      }>(
        `SELECT s.id, s.surveyed_at, s.recorded_by,
                s.is_existing_buyer, s.customer_id,
                cm.company AS customer_company,
                s.prospect_name, s.state, s.district,
                s.segment, s.prayag_item_code,
                s.competitor_brand, s.competitor_product,
                s.net_price::text, s.mrp::text, s.discount_pct::text,
                s.entry_mode, s.unit, s.pack_size,
                s.reasons, s.monthly_volume::text, s.note,
                s.created_at, s.survey_id, s.survey_type
         FROM market_survey s
         LEFT JOIN customer_master cm ON cm.id = s.customer_id
         ${where}
         ORDER BY s.created_at DESC
         LIMIT $${p} OFFSET $${p + 1}`,
        [...params, limit, offset],
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM market_survey s ${where}`,
        params,
      ),
    ]);

    const now = Date.now();
    res.json({
      total: parseInt(totalResult.rows[0]?.total ?? "0", 10),
      limit,
      offset,
      rows: rowsResult.rows.map((r) => ({
        id: r.id,
        surveyedAt: r.surveyed_at,
        recordedBy: r.recorded_by,
        isExistingBuyer: r.is_existing_buyer,
        customerId: r.customer_id,
        customerCompany: r.customer_company,
        prospectName: r.prospect_name,
        state: r.state,
        district: r.district,
        segment: r.segment,
        prayagItemCode: r.prayag_item_code,
        competitorBrand: r.competitor_brand,
        competitorProduct: r.competitor_product,
        netPrice: parseFloat(r.net_price),
        mrp: r.mrp ? parseFloat(r.mrp) : null,
        discountPct: r.discount_pct ? parseFloat(r.discount_pct) : null,
        entryMode: r.entry_mode,
        unit: r.unit,
        packSize: r.pack_size,
        reasons: r.reasons,
        monthlyVolume: r.monthly_volume ? parseFloat(r.monthly_volume) : null,
        note: r.note,
        createdAt: r.created_at,
        surveyId: r.survey_id ?? null,
        surveyType: r.survey_type ?? null,
        editable: new Date(r.created_at).getTime() + 24 * 3600 * 1000 > now,
      })),
    });
  } catch (err) {
    req.log?.error({ err }, "market-survey list error");
    res.status(500).json({ error: "Failed to list surveys" });
  }
});

// ── GET /api/market-survey/summary ───────────────────────────────────────
// Per Prayag item code: our current MRP, median competitor net price, n, spread.
// ?segment= to filter; ?minSurveys= to floor (default 1).
router.get("/market-survey/summary", async (req, res) => {
  try {
    const segment    = str(req.query.segment);
    const minSurveys = Math.max(1, parseInt(String(req.query.minSurveys ?? "1"), 10) || 1);

    const params: (string | number)[] = [];
    const conds: string[] = ["s.prayag_item_code IS NOT NULL"];
    let p = 1;
    if (segment) { conds.push(`s.segment = $${p++}`); params.push(segment); }

    const result = await pool.query<{
      item_code: string; segment: string; item_name: string | null;
      current_mrp: string | null; n: string;
      median_net: string; min_net: string; max_net: string;
      p25_net: string; p75_net: string;
    }>(
      `SELECT
         s.prayag_item_code           AS item_code,
         s.segment,
         m.item_name,
         h.mrp::text                 AS current_mrp,
         COUNT(*)::text              AS n,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.net_price)::text  AS median_net,
         MIN(s.net_price)::text      AS min_net,
         MAX(s.net_price)::text      AS max_net,
         PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY s.net_price)::text AS p25_net,
         PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY s.net_price)::text AS p75_net
       FROM market_survey s
       LEFT JOIN mrp_master m ON m.item_code = s.prayag_item_code AND m.segment = s.segment
       LEFT JOIN mrp_history h ON h.item_code = s.prayag_item_code
                               AND h.segment  = s.segment
                               AND h.is_current = TRUE
       WHERE ${conds.join(" AND ")}
       GROUP BY s.prayag_item_code, s.segment, m.item_name, h.mrp
       HAVING COUNT(*) >= $${p}
       ORDER BY COUNT(*) DESC, s.prayag_item_code`,
      [...params, minSurveys],
    );

    res.json({
      rows: result.rows.map((r) => {
        const n          = parseInt(r.n, 10);
        const medianNet  = parseFloat(r.median_net);
        const currentMrp = r.current_mrp ? parseFloat(r.current_mrp) : null;
        return {
          itemCode:    r.item_code,
          segment:     r.segment,
          itemName:    r.item_name,
          currentMrp,
          n,
          indicativeOnly: n < 5,
          medianCompetitorNet: medianNet,
          minNet:   parseFloat(r.min_net),
          maxNet:   parseFloat(r.max_net),
          p25Net:   parseFloat(r.p25_net),
          p75Net:   parseFloat(r.p75_net),
          // Gap between our avg-sale (proxy: 60% of MRP) and competitor median
          // Not computed here — client can derive if needed from currentMrp.
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to compute summary" });
  }
});

// ── GET /api/market-survey/by-brand ──────────────────────────────────────
router.get("/market-survey/by-brand", async (req, res) => {
  try {
    const result = await pool.query<{
      brand: string; n: string; segments: string[];
      min_net: string; max_net: string; median_net: string;
    }>(
      `SELECT
         competitor_brand                     AS brand,
         COUNT(*)::text                       AS n,
         array_agg(DISTINCT segment ORDER BY segment) AS segments,
         MIN(net_price)::text                 AS min_net,
         MAX(net_price)::text                 AS max_net,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_price)::text AS median_net
       FROM market_survey
       GROUP BY competitor_brand
       ORDER BY COUNT(*) DESC`,
    );

    res.json({
      rows: result.rows.map((r) => ({
        brand:     r.brand,
        n:         parseInt(r.n, 10),
        segments:  r.segments,
        minNet:    parseFloat(r.min_net),
        maxNet:    parseFloat(r.max_net),
        medianNet: parseFloat(r.median_net),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to compute by-brand summary" });
  }
});

// ── GET /api/market-survey/coverage ──────────────────────────────────────
// Segments × states with fewer than 5 surveys.
router.get("/market-survey/coverage", async (req, res) => {
  try {
    const [covResult, segsResult] = await Promise.all([
      pool.query<{ segment: string; state: string | null; n: string }>(
        `SELECT segment, state, COUNT(*)::text AS n
         FROM market_survey
         WHERE state IS NOT NULL
         GROUP BY segment, state
         ORDER BY segment, state`,
      ),
      pool.query<{ segment: string }>(
        "SELECT DISTINCT segment FROM mrp_master ORDER BY segment",
      ),
    ]);

    // Segments with <5 surveys total
    const totalBySegment = covResult.rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.segment] = (acc[r.segment] ?? 0) + parseInt(r.n, 10);
      return acc;
    }, {});

    const allSegments = segsResult.rows.map((r) => r.segment);
    const gapSegments = allSegments
      .map((seg) => ({
        segment: seg,
        total: totalBySegment[seg] ?? 0,
        hasGap: (totalBySegment[seg] ?? 0) < 5,
      }))
      .filter((g) => g.hasGap);

    // States with <5 surveys per segment
    const cellMap: Record<string, Record<string, number>> = {};
    for (const r of covResult.rows) {
      if (!r.state) continue;
      cellMap[r.segment] ??= {};
      cellMap[r.segment][r.state] = parseInt(r.n, 10);
    }

    res.json({
      thresholdForAdequacy: 5,
      gapSegments,
      coveredSegmentState: covResult.rows.map((r) => ({
        segment: r.segment,
        state:   r.state,
        n:       parseInt(r.n, 10),
        adequate: parseInt(r.n, 10) >= 5,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to compute coverage" });
  }
});

// ── GET /api/market-survey/state-heads ───────────────────────────────────
// All state heads from person_registry for the cascade picker.
router.get("/market-survey/state-heads", async (_req, res) => {
  try {
    const result = await pool.query<{ norm_key: string; canonical_name: string }>(
      "SELECT norm_key, canonical_name FROM person_registry WHERE is_state_head = true ORDER BY canonical_name",
    );
    res.json({ rows: result.rows.map((r) => ({ key: r.norm_key, name: r.canonical_name })) });
  } catch {
    res.status(500).json({ error: "Failed to load state heads" });
  }
});

// ── GET /api/market-survey/cascade-states ─────────────────────────────────
// All picker-visible states from state_hierarchy for the cascade.
// When ?stateHead=<canonicalName> is supplied, restricts to states that head
// serves (derived from customer_master.state_head). Falls back to all 33
// states when no customer rows exist for the head (backfill not yet run).
router.get("/market-survey/cascade-states", async (req, res) => {
  try {
    const stateHeadRaw = typeof req.query.stateHead === "string" ? req.query.stateHead.trim() : null;

    // Full ordered list from state_hierarchy (always fetched for display ordering).
    const allStates = await pool.query<{
      state_canon: string; state_parent: string; is_split: boolean;
    }>(
      "SELECT state_canon, state_parent, is_split FROM state_hierarchy WHERE picker_visible = true ORDER BY display_order",
    );
    const allRows = allStates.rows.map((r) => ({
      canon:   r.state_canon,
      parent:  r.state_parent,
      isSplit: r.is_split,
    }));

    if (!stateHeadRaw) {
      res.json({ states: allRows });
      return;
    }

    // The picker sends person_registry.canonical_name (HR name), but
    // customer_master.state_head stores COALESCE(alias_secondary, canonical_name)
    // (the sale-line display canonical, e.g. "Pawan Sharma" ≠ "Pawan Kumar Sharma").
    // Resolve to the stored form before filtering so the WHERE clause matches.
    const { resolvePickerToStoredHead } = await import("../lib/customerStateHead.js");
    const storedHead = await resolvePickerToStoredHead(pool, stateHeadRaw);

    // Fetch distinct raw states from customer_master for this head.
    const headStates = await pool.query<{ state: string }>(
      `SELECT DISTINCT state FROM customer_master WHERE state_head = $1 AND state IS NOT NULL`,
      [storedHead],
    );

    if (!headStates.rows.length) {
      // Backfill not yet run for this head → graceful fallback: return all states.
      res.json({ states: allRows });
      return;
    }

    // Normalise and intersect with state_hierarchy (pure helper — also tested).
    const { buildCascadeStates } = await import("../lib/customerStateHead.js");
    const filtered = buildCascadeStates(
      headStates.rows.map((r) => r.state),
      allRows,
    );

    // null → vocab mismatch or empty rows → fall back to all states.
    res.json({ states: filtered ?? allRows });
  } catch {
    res.status(500).json({ error: "Failed to load states" });
  }
});

// ── GET /api/market-survey/distributors?state=X ───────────────────────────
// Distributors and Direct Dealers in the selected state(s).
// Automatically expands a parent state to all its splits.
router.get("/market-survey/distributors", async (req, res) => {
  try {
    const stateRaw = req.query.state;
    const states = Array.isArray(stateRaw)
      ? (stateRaw as string[])
      : stateRaw ? [String(stateRaw)] : [];
    if (!states.length) { res.json({ rows: [], total: 0 }); return; }

    const result = await pool.query<{ id: string; company: string; state: string | null; district: string | null }>(
      `SELECT id, company, state, district
       FROM customer_master
       WHERE type IN ('Distributor','Direct Dealer')
         AND state IN (
           SELECT state_canon FROM state_hierarchy
           WHERE state_parent = ANY($1) OR state_canon = ANY($1)
           UNION ALL
           SELECT unnest($1::text[]) -- include as-is in case not in hierarchy
         )
       ORDER BY company`,
      [states],
    );
    res.json({ rows: result.rows, total: result.rowCount ?? 0 });
  } catch (err) {
    res.status(500).json({ error: "Failed to load distributors" });
  }
});

// ── GET /api/market-survey/retailers?distributorId=X ─────────────────────
// Retailers linked to a specific distributor via retailer_distributor junction.
// Also supports ?state[]=X for state-only filtering when no distributor is selected.
router.get("/market-survey/retailers", async (req, res) => {
  try {
    const distributorId = str(req.query.distributorId);

    if (distributorId) {
      // Many-to-many: a retailer appears under every distributor they're linked to
      const result = await pool.query<{ id: string; company: string; state: string | null; district: string | null }>(
        `SELECT DISTINCT cm.id, cm.company, cm.state, cm.district
         FROM retailer_distributor rd
         JOIN customer_master cm ON cm.id = rd.retailer_id
         WHERE rd.resolved_dist_id = $1
         ORDER BY cm.company`,
        [distributorId],
      );
      res.json({ rows: result.rows, total: result.rowCount ?? 0 });
      return;
    }

    // Fallback: state-based filter
    const stateRaw = req.query.state;
    const states = Array.isArray(stateRaw)
      ? (stateRaw as string[])
      : stateRaw ? [String(stateRaw)] : [];
    if (!states.length) { res.json({ rows: [], total: 0 }); return; }

    const result = await pool.query<{ id: string; company: string; state: string | null; district: string | null }>(
      `SELECT id, company, state, district
       FROM customer_master
       WHERE type = 'Retailer' AND state = ANY($1)
       ORDER BY company LIMIT 300`,
      [states],
    );
    res.json({ rows: result.rows, total: result.rowCount ?? 0 });
  } catch {
    res.status(500).json({ error: "Failed to load retailers" });
  }
});

// ── GET /api/market-survey/items?segment=X ────────────────────────────────
// Full item list for a segment with current MRP. Client filters by search text.
router.get("/market-survey/items", async (req, res) => {
  try {
    const segment = str(req.query.segment);
    if (!segment) { res.json({ rows: [], total: 0 }); return; }

    const result = await pool.query<{
      item_code: string; item_name: string | null;
      current_mrp: string | null; effective_from: string | null;
    }>(
      `SELECT m.item_code, m.item_name,
              h.mrp::text        AS current_mrp,
              h.effective_from::text AS effective_from
       FROM mrp_master m
       LEFT JOIN mrp_history h
             ON h.item_code = m.item_code
            AND h.segment   = m.segment
            AND h.is_current = TRUE
       WHERE m.segment = $1
       ORDER BY m.item_code`,
      [segment],
    );
    res.json({
      rows: result.rows.map((r) => ({
        itemCode:      r.item_code,
        itemName:      r.item_name,
        currentMrp:    r.current_mrp ? parseFloat(r.current_mrp) : null,
        effectiveFrom: r.effective_from ?? null,
      })),
      total: result.rowCount ?? 0,
    });
  } catch {
    res.status(500).json({ error: "Failed to load items" });
  }
});

// ── POST /api/market-survey/prospect ─────────────────────────────────────
// Create a pending new distributor or retailer record from the Market Survey form.
// Does NOT write to customer_master — sits in review queue for manual approval.
router.post("/market-survey/prospect", async (req, res) => {
  try {
    const b = req.body as Record<string, unknown>;
    const name        = str(b.name);
    const contact     = str(b.contact);
    const district    = str(b.district);
    const state       = str(b.state);
    const type        = str(b.type);
    const submittedBy = str(b.submittedBy);

    if (!name || !contact || !district || !state || !type || !submittedBy) {
      res.status(400).json({ error: "name, contact, district, state, type and submittedBy are required" });
      return;
    }
    if (type !== "Distributor" && type !== "Retailer") {
      res.status(400).json({ error: "type must be 'Distributor' or 'Retailer'" });
      return;
    }

    const result = await pool.query<{ id: number }>(
      `INSERT INTO market_survey_prospect
         (name, contact, contact_person, address, district, state,
          area, pincode, gst, type, for_distributor_id, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        name, contact, str(b.contactPerson), str(b.address), district, state,
        str(b.area), str(b.pincode), str(b.gst), type,
        str(b.forDistributorId) || null, submittedBy,
      ],
    );
    res.status(201).json({ id: result.rows[0].id, status: "pending" });
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// ── GET /api/market-survey/prospects ─────────────────────────────────────
// List pending prospect records for the Customer Data Review Queue.
router.get("/market-survey/prospects", async (req, res) => {
  try {
    const status = str(req.query.status) ?? "pending";
    const result = await pool.query<{
      id: number; name: string; contact: string; contact_person: string | null;
      district: string; state: string; type: string; for_distributor_id: string | null;
      submitted_by: string; submitted_at: string; status: string;
      approved_customer_id: string | null; approved_at: string | null; note: string | null;
    }>(
      `SELECT id, name, contact, contact_person, district, state, type,
              for_distributor_id, submitted_by, submitted_at, status,
              approved_customer_id, approved_at, note
       FROM market_survey_prospect
       WHERE status = $1
       ORDER BY submitted_at DESC
       LIMIT 200`,
      [status],
    );
    res.json({
      rows: result.rows.map((r) => ({
        id:               r.id,
        name:             r.name,
        contact:          r.contact,
        contactPerson:    r.contact_person,
        district:         r.district,
        state:            r.state,
        type:             r.type,
        forDistributorId: r.for_distributor_id,
        submittedBy:      r.submitted_by,
        submittedAt:      r.submitted_at,
        status:           r.status,
        approvedCustomerId: r.approved_customer_id,
        approvedAt:       r.approved_at,
        note:             r.note,
      })),
    });
  } catch {
    res.status(500).json({ error: "Failed to load prospects" });
  }
});

// ── PATCH /api/market-survey/prospect/:id ─────────────────────────────────
// Approve or reject a pending prospect. Approve creates a customer_master row.
router.patch("/market-survey/prospect/:id", async (req, res) => {
  try {
    const id     = parseInt(String(req.params.id), 10);
    const action = str((req.body as Record<string, unknown>).action);
    if (!isFinite(id) || (action !== "approve" && action !== "reject")) {
      res.status(400).json({ error: "id and action ('approve'|'reject') required" });
      return;
    }

    const prospectRes = await pool.query(
      "SELECT * FROM market_survey_prospect WHERE id = $1 LIMIT 1", [id],
    );
    if ((prospectRes.rowCount ?? 0) === 0) {
      res.status(404).json({ error: "Prospect not found" });
      return;
    }
    const p = prospectRes.rows[0] as {
      name: string; contact: string; district: string; state: string;
      type: string; for_distributor_id: string | null; pincode: string | null;
      gst: string | null; area: string | null; address: string | null;
    };

    if (action === "reject") {
      await pool.query(
        "UPDATE market_survey_prospect SET status='rejected' WHERE id = $1", [id],
      );
      res.json({ ok: true, action: "reject" });
      return;
    }

    // Approve: mark as approved. Admin creates the customer_master record separately
    // (IDs are assigned during the bulk import workflow, not auto-generated here).
    await pool.query(
      "UPDATE market_survey_prospect SET status='approved', approved_at=now() WHERE id=$1",
      [id],
    );

    res.json({ ok: true, action: "approve" });
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// ── PATCH /api/market-survey/:id ─────────────────────────────────────────
router.patch("/market-survey/:id", async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const b = req.body as Record<string, unknown>;
  const recorderName = str(b.recorderName);

  try {
    // Fetch the existing row
    const existing = await pool.query<{
      recorded_by: string; created_at: string; entry_mode: string;
      net_price: string; mrp: string | null; discount_pct: string | null;
    }>(
      "SELECT recorded_by, created_at, entry_mode, net_price::text, mrp::text, discount_pct::text FROM market_survey WHERE id = $1",
      [id],
    );

    if ((existing.rowCount ?? 0) === 0) {
      res.status(404).json({ error: `Survey ${id} not found` });
      return;
    }
    const row = existing.rows[0];

    // If a recorderName is given, verify it matches the recorded_by
    if (recorderName && row.recorded_by !== recorderName) {
      res.status(403).json({ error: "You can only edit your own surveys" });
      return;
    }
    if (new Date(row.created_at).getTime() + 24 * 3600 * 1000 < Date.now()) {
      res.status(409).json({ error: "This survey can no longer be edited (24 h window has passed)" });
      return;
    }

    const b = req.body as Record<string, unknown>;

    // Only accept fields that are safe to patch
    const sets: string[] = [];
    const params: (string | number | boolean | string[] | null)[] = [];
    let p = 1;

    if ("competitorBrand" in b) {
      const v = str(b.competitorBrand);
      if (v) { sets.push(`competitor_brand = $${p++}`); params.push(v); }
    }
    if ("competitorProduct" in b) { sets.push(`competitor_product = $${p++}`); params.push(str(b.competitorProduct)); }
    if ("prayagItemCode"    in b) { sets.push(`prayag_item_code = $${p++}`);   params.push(str(b.prayagItemCode)); }
    if ("unit"              in b) { sets.push(`unit = $${p++}`);               params.push(str(b.unit) ?? "piece"); }
    if ("packSize"          in b) { sets.push(`pack_size = $${p++}`);          params.push(str(b.packSize)); }
    if ("note"              in b) { sets.push(`note = $${p++}`);               params.push(str(b.note)); }
    if ("monthlyVolume"     in b) { sets.push(`monthly_volume = $${p++}`);     params.push(num(b.monthlyVolume)); }
    if ("reasons"           in b && Array.isArray(b.reasons)) {
      sets.push(`reasons = $${p++}`);
      params.push((b.reasons as unknown[]).map(String).filter(Boolean));
    }

    // Price patch — must be self-consistent
    if ("entryMode" in b || "netPrice" in b || "mrp" in b || "discountPct" in b) {
      const entryMode = str(b.entryMode) ?? row.entry_mode;
      let netPrice: number;
      let mrp: number | null    = null;
      let discountPct: number | null = null;

      if (entryMode === "net_direct") {
        const v = num(b.netPrice);
        if (v === null || v <= 0) {
          res.status(400).json({ error: "netPrice must be positive for net_direct" });
          return;
        }
        netPrice = v;
      } else {
        mrp        = num(b.mrp)        ?? (row.mrp ? parseFloat(row.mrp) : null);
        discountPct = num(b.discountPct) ?? (row.discount_pct ? parseFloat(row.discount_pct) : null);
        if (!mrp || mrp <= 0 || discountPct === null) {
          res.status(400).json({ error: "mrp and discountPct required for mrp_discount" });
          return;
        }
        netPrice = Math.round(mrp * (1 - discountPct / 100) * 100) / 100;
      }
      sets.push(`entry_mode = $${p++}`,   `net_price = $${p++}`,
                `mrp = $${p++}`,          `discount_pct = $${p++}`);
      params.push(entryMode, netPrice, mrp, discountPct);
    }

    if (sets.length === 0) {
      res.status(400).json({ error: "No patchable fields in body" });
      return;
    }

    params.push(id);
    await pool.query(
      `UPDATE market_survey SET ${sets.join(", ")} WHERE id = $${p}`,
      params,
    );

    res.json({ ok: true, id, editableUntil: new Date(new Date(row.created_at).getTime() + 24 * 3600 * 1000).toISOString() });
  } catch (err) {
    req.log?.error({ err }, "market-survey PATCH error");
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

export default router;
