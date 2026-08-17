// GET  /api/market-survey/meta                    — segments, known brands, picker states
// GET  /api/market-survey/customers               — customer_master autocomplete (?q=)
// GET  /api/market-survey/products                — mrp_master autocomplete (?segment=&q=)
// GET  /api/market-survey/purchase-lookup         — secondary register check (?customerId=&prayagItemCode=)
// GET  /api/market-survey                        — list surveys (?segment=&brand=&recorder=&limit=&offset=)
// POST /api/market-survey                        — submit multi-line; recorded_by = recorderName (self-declared)
// GET  /api/market-survey/summary                — per-item MRP vs median competitor net price
// GET  /api/market-survey/by-brand               — competitor brand aggregates
// GET  /api/market-survey/coverage               — segments × states with <5 surveys
// GET  /api/market-survey/credit-comparison      — credit days by state/segment
// GET  /api/market-survey/scheme-comparison      — competitor scheme values by type
// GET  /api/market-survey/delivery-comparison    — delivery days by state
// GET  /api/market-survey/sized-opportunity      — estimated monthly value going to competitors
// PATCH /api/market-survey/:id                   — edit within 24 h (same recorder)

import ExcelJS from "exceljs";
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

// ── Enum allowlists ───────────────────────────────────────────────────────
const CREDIT_GIVEN_BY   = ["distributor", "competitor_company", "unknown"] as const;
const SCHEME_TYPES      = ["percentage", "free_goods", "slab", "none", "unknown"] as const;
const SHELF_SHARES      = ["mostly_prayag", "even_split", "mostly_competitor", "only_competitor"] as const;
const VISIT_FREQS       = ["weekly", "fortnightly", "monthly", "rarely", "never"] as const;
const WOULD_SWITCH_VALS = ["yes", "no", "maybe", "unknown"] as const;

function enumVal(v: unknown, valid: readonly string[]): string | null {
  const s = str(v);
  return s !== null && valid.includes(s) ? s : null;
}
function intVal(v: unknown): number | null {
  const n = num(v);
  return n !== null ? Math.round(n) : null;
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
// Check secondary_sku_line (item-code-resolved rows only) for:
//   - customer-level: did this retailer appear at all in the last 12 months?
//   - item-level:     was this specific prayagItemCode purchased?
// Both figures come from the same table so the warning text is internally consistent.
// Note: secondary_sku_line only contains rows where a brand resolved to an item_code;
// secondary_register_line has broader coverage but no item_code column.
router.get("/market-survey/purchase-lookup", async (req, res) => {
  try {
    const customerId     = str(req.query.customerId);
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
    const namePat = `%${customerName.replace(/[%_]/g, "\\$&")}%`;

    // Compute last 12 month labels ("Sep-25" … "Aug-26")
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const now  = new Date();
    const last12: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      last12.push(`${MON[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`);
    }

    // Both queries target secondary_sku_line so the numbers are from the same source.
    const [custResult, itemResult] = await Promise.all([
      // Customer-level: all item_codes for this retailer in last 12 months
      pool.query<{ line_count: string; total_qty: string; months: string[] | null }>(
        `SELECT
           COUNT(*)::text                                                           AS line_count,
           COALESCE(SUM(qty), 0)::text                                             AS total_qty,
           ARRAY_AGG(DISTINCT month_label ORDER BY month_label)
             FILTER (WHERE month_label IS NOT NULL)                                AS months
         FROM secondary_sku_line
         WHERE retailer ILIKE $1
           AND month_label = ANY($2)`,
        [namePat, last12],
      ),
      // Item-level: this specific item_code only (only meaningful if prayagItemCode supplied)
      prayagItemCode
        ? pool.query<{ line_count: string; total_qty: string }>(
            `SELECT
               COUNT(*)::text                      AS line_count,
               COALESCE(SUM(qty), 0)::text         AS total_qty
             FROM secondary_sku_line
             WHERE retailer ILIKE $1
               AND item_code = $2
               AND month_label = ANY($3)`,
            [namePat, prayagItemCode, last12],
          )
        : Promise.resolve({ rows: [{ line_count: "0", total_qty: "0" }] }),
    ]);

    const custRow      = custResult.rows[0];
    const skuLineCount = parseInt(custRow?.line_count ?? "0", 10);
    const skuTotalQty  = parseFloat(custRow?.total_qty  ?? "0");
    const months       = custRow?.months ?? [];
    const monthCount   = months.length;

    const itemRow      = itemResult.rows[0];
    const itemLineCount = parseInt(itemRow?.line_count ?? "0", 10);
    const itemQty       = parseFloat(itemRow?.total_qty  ?? "0");

    res.json({
      found:         skuLineCount > 0,
      skuLineCount,
      skuTotalQty,
      monthCount,
      itemFound:     itemLineCount > 0,
      itemLineCount,
      itemQty,
      customerName,
      prayagItemCode,
      months,
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
      // richer-capture fields (all nullable)
      creditDaysCompetitor: number | null; creditGivenBy: string | null; creditDaysPrayag: number | null;
      competitorSchemeType: string | null; competitorSchemeValue: string | null;
      deliveryDaysCompetitor: number | null; deliveryDaysPrayag: number | null; shelfShare: string | null;
      paymentTermsNote: string | null; competitorVisitFrequency: string | null;
      competitorMoq: string | null; buyingSince: string | null;
      wouldSwitch: string | null; switchCondition: string | null;
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
        // richer-capture fields
        creditDaysCompetitor:     intVal(l.creditDaysCompetitor),
        creditGivenBy:            enumVal(l.creditGivenBy, CREDIT_GIVEN_BY),
        creditDaysPrayag:         intVal(l.creditDaysPrayag),
        competitorSchemeType:     enumVal(l.competitorSchemeType, SCHEME_TYPES),
        competitorSchemeValue:    str(l.competitorSchemeValue),
        deliveryDaysCompetitor:   intVal(l.deliveryDaysCompetitor),
        deliveryDaysPrayag:       intVal(l.deliveryDaysPrayag),
        shelfShare:               enumVal(l.shelfShare, SHELF_SHARES),
        paymentTermsNote:         str(l.paymentTermsNote),
        competitorVisitFrequency: enumVal(l.competitorVisitFrequency, VISIT_FREQS),
        competitorMoq:            str(l.competitorMoq),
        buyingSince:              str(l.buyingSince),
        wouldSwitch:              enumVal(l.wouldSwitch, WOULD_SWITCH_VALS),
        switchCondition:          str(l.switchCondition),
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
            pending_prospect_id, survey_id, survey_type,
            credit_days_competitor, credit_given_by, credit_days_prayag,
            competitor_scheme_type, competitor_scheme_value,
            delivery_days_competitor, delivery_days_prayag, shelf_share,
            payment_terms_note, competitor_visit_frequency,
            competitor_moq, buying_since, would_switch, switch_condition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                 COALESCE($20::timestamptz, now()), $21, $22, $23,
                 $24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
         RETURNING id`,
        [
          recorderName, isExistingBuyer, customerId,
          prospectName ?? (pendingProspectId != null ? null : str(b.prospectName)),
          resolvedState, resolvedDistrict, pl.segment, pl.prayagItemCode,
          pl.competitorBrand, pl.competitorProduct,
          pl.netPrice, pl.mrp, pl.discountPct, pl.entryMode,
          pl.unit, pl.packSize, pl.reasons, pl.monthlyVolume, pl.note,
          surveyedAt, pendingProspectId, surveyId, surveyType,
          pl.creditDaysCompetitor, pl.creditGivenBy, pl.creditDaysPrayag,
          pl.competitorSchemeType, pl.competitorSchemeValue,
          pl.deliveryDaysCompetitor, pl.deliveryDaysPrayag, pl.shelfShare,
          pl.paymentTermsNote, pl.competitorVisitFrequency,
          pl.competitorMoq, pl.buyingSince, pl.wouldSwitch, pl.switchCondition,
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
      brand: string; n: string; segments: string[]; states: string[];
      min_net: string; max_net: string; median_net: string;
    }>(
      `SELECT
         competitor_brand                     AS brand,
         COUNT(*)::text                       AS n,
         array_agg(DISTINCT segment ORDER BY segment) AS segments,
         array_agg(DISTINCT state ORDER BY state) FILTER (WHERE state IS NOT NULL) AS states,
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
        states:    r.states ?? [],
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
    if ("creditDaysCompetitor"     in b) { sets.push(`credit_days_competitor = $${p++}`);     params.push(intVal(b.creditDaysCompetitor)); }
    if ("creditGivenBy"            in b) { sets.push(`credit_given_by = $${p++}`);             params.push(enumVal(b.creditGivenBy, CREDIT_GIVEN_BY)); }
    if ("creditDaysPrayag"         in b) { sets.push(`credit_days_prayag = $${p++}`);          params.push(intVal(b.creditDaysPrayag)); }
    if ("competitorSchemeType"     in b) { sets.push(`competitor_scheme_type = $${p++}`);      params.push(enumVal(b.competitorSchemeType, SCHEME_TYPES)); }
    if ("competitorSchemeValue"    in b) { sets.push(`competitor_scheme_value = $${p++}`);     params.push(str(b.competitorSchemeValue)); }
    if ("deliveryDaysCompetitor"   in b) { sets.push(`delivery_days_competitor = $${p++}`);   params.push(intVal(b.deliveryDaysCompetitor)); }
    if ("deliveryDaysPrayag"       in b) { sets.push(`delivery_days_prayag = $${p++}`);       params.push(intVal(b.deliveryDaysPrayag)); }
    if ("shelfShare"               in b) { sets.push(`shelf_share = $${p++}`);                 params.push(enumVal(b.shelfShare, SHELF_SHARES)); }
    if ("paymentTermsNote"         in b) { sets.push(`payment_terms_note = $${p++}`);         params.push(str(b.paymentTermsNote)); }
    if ("competitorVisitFrequency" in b) { sets.push(`competitor_visit_frequency = $${p++}`); params.push(enumVal(b.competitorVisitFrequency, VISIT_FREQS)); }
    if ("competitorMoq"            in b) { sets.push(`competitor_moq = $${p++}`);             params.push(str(b.competitorMoq)); }
    if ("buyingSince"              in b) { sets.push(`buying_since = $${p++}`);               params.push(str(b.buyingSince)); }
    if ("wouldSwitch"              in b) { sets.push(`would_switch = $${p++}`);               params.push(enumVal(b.wouldSwitch, WOULD_SWITCH_VALS)); }
    if ("switchCondition"          in b) { sets.push(`switch_condition = $${p++}`);           params.push(str(b.switchCondition)); }

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

// ── /submissions ────────────────────────────────────────────────────────────
// Returns all survey rows grouped by survey_type then by survey_id.
router.get("/market-survey/submissions", async (req, res) => {
  try {
    const stateHead = str(req.query.stateHead);
    const state     = str(req.query.state);
    const segment   = str(req.query.segment);
    const brand     = str(req.query.brand);
    const recorder  = str(req.query.recorder);
    const dateFrom  = str(req.query.dateFrom);
    const dateTo    = str(req.query.dateTo);

    const conds: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (stateHead) {
      const { resolvePickerToStoredHead } = await import("../lib/customerStateHead.js");
      const stored = await resolvePickerToStoredHead(pool, stateHead);
      conds.push(`s.state IN (SELECT DISTINCT state FROM customer_master WHERE state_head = $${p++} AND state IS NOT NULL)`);
      params.push(stored);
    }
    if (state)    { conds.push(`s.state = $${p++}`);                                      params.push(state); }
    if (segment)  { conds.push(`s.segment = $${p++}`);                                    params.push(segment); }
    if (brand)    { conds.push(`s.competitor_brand ILIKE $${p++}`);                       params.push(`%${brand}%`); }
    if (recorder) { conds.push(`s.recorded_by = $${p++}`);                                params.push(recorder); }
    if (dateFrom) { conds.push(`s.created_at >= $${p++}`);                                params.push(dateFrom); }
    if (dateTo)   { conds.push(`s.created_at < $${p++}::date + interval '1 day'`);       params.push(dateTo); }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const result = await pool.query<{
      id: number; survey_id: string; survey_type: string;
      created_at: string; recorded_by: string;
      customer_id: string | null; customer_company: string | null;
      prospect_name: string | null; pending_prospect_id: number | null;
      state: string | null; district: string | null;
      segment: string; prayag_item_code: string | null;
      item_name: string | null; current_mrp: string | null;
      competitor_brand: string; competitor_product: string | null;
      net_price: string; entry_mrp: string | null; discount_pct: string | null;
      entry_mode: string; unit: string; pack_size: string | null;
      reasons: string[]; monthly_volume: string | null; note: string | null;
      credit_days_competitor: number | null; credit_given_by: string | null;
      credit_days_prayag: number | null; competitor_scheme_type: string | null;
      competitor_scheme_value: string | null; delivery_days_competitor: number | null;
      delivery_days_prayag: number | null; shelf_share: string | null;
      payment_terms_note: string | null; competitor_visit_frequency: string | null;
      competitor_moq: string | null; buying_since: string | null;
      would_switch: string | null; switch_condition: string | null;
    }>(
      `SELECT s.id, s.survey_id, s.survey_type,
              s.created_at, s.recorded_by,
              s.customer_id, cm.company AS customer_company,
              s.prospect_name, s.pending_prospect_id,
              s.state, s.district,
              s.segment, s.prayag_item_code,
              mi.item_name,
              h.mrp::text AS current_mrp,
              s.competitor_brand, s.competitor_product,
              s.net_price::text, s.mrp::text AS entry_mrp, s.discount_pct::text,
              s.entry_mode, s.unit, s.pack_size,
              s.reasons, s.monthly_volume::text, s.note,
              s.credit_days_competitor, s.credit_given_by, s.credit_days_prayag,
              s.competitor_scheme_type, s.competitor_scheme_value,
              s.delivery_days_competitor, s.delivery_days_prayag, s.shelf_share,
              s.payment_terms_note, s.competitor_visit_frequency,
              s.competitor_moq, s.buying_since, s.would_switch, s.switch_condition
       FROM market_survey s
       LEFT JOIN customer_master cm ON cm.id = s.customer_id
       LEFT JOIN mrp_master mi ON mi.item_code = s.prayag_item_code AND mi.segment = s.segment
       LEFT JOIN mrp_history h  ON h.item_code = s.prayag_item_code AND h.segment = s.segment AND h.is_current = TRUE
       ${where}
       ORDER BY
         CASE s.survey_type WHEN 'existing_sku' THEN 1 WHEN 'new_sku' THEN 2 WHEN 'new_customer' THEN 3 ELSE 4 END,
         s.survey_id, s.id
       LIMIT 2000`,
      params,
    );

    const TYPE_LABELS: Record<string, string> = {
      existing_sku: "Existing customer, existing SKU",
      new_sku:      "Existing customer, new SKU",
      new_customer: "New customer",
      unclassified: "Unclassified (pre-rebuild rows)",
    };
    const TYPE_ORDER = ["existing_sku", "new_sku", "new_customer", "unclassified"];

    const now = Date.now();
    type SurveyLine = {
      id: number; segment: string; prayagItemCode: string | null; itemName: string | null;
      currentMrp: number | null; competitorBrand: string; competitorProduct: string | null;
      netPrice: number; mrp: number | null; discountPct: number | null;
      entryMode: string; unit: string; packSize: string | null;
      reasons: string[]; monthlyVolume: number | null; note: string | null;
      createdAt: string; editable: boolean;
      creditDaysCompetitor: number | null; creditGivenBy: string | null;
      creditDaysPrayag: number | null; competitorSchemeType: string | null;
      competitorSchemeValue: string | null; deliveryDaysCompetitor: number | null;
      deliveryDaysPrayag: number | null; shelfShare: string | null;
      paymentTermsNote: string | null; competitorVisitFrequency: string | null;
      competitorMoq: string | null; buyingSince: string | null;
      wouldSwitch: string | null; switchCondition: string | null;
    };
    type Survey = {
      surveyId: string; submittedAt: string; recordedBy: string;
      retailer: string; customerId: string | null;
      isPendingProspect: boolean; state: string | null; district: string | null;
      editableUntil: string; lines: SurveyLine[];
    };
    type Group = {
      surveyType: string; label: string;
      rowCount: number; combinedValue: number | null; surveys: Survey[];
    };

    const groupMap = new Map<string, Map<string, Survey>>();
    const typeCounts: Record<string, number> = {};

    for (const r of result.rows) {
      const stype = TYPE_ORDER.includes(r.survey_type) ? r.survey_type : "unclassified";
      typeCounts[stype] = (typeCounts[stype] ?? 0) + 1;
      if (!groupMap.has(stype)) groupMap.set(stype, new Map());
      const surveyMap = groupMap.get(stype)!;

      if (!surveyMap.has(r.survey_id)) {
        const editableUntil = new Date(new Date(r.created_at).getTime() + 24 * 3600 * 1000).toISOString();
        surveyMap.set(r.survey_id, {
          surveyId: r.survey_id,
          submittedAt: r.created_at,
          recordedBy: r.recorded_by,
          retailer: r.customer_company ?? r.prospect_name ?? "(unknown)",
          customerId: r.customer_id,
          isPendingProspect: r.pending_prospect_id != null && !r.customer_id,
          state: r.state,
          district: r.district,
          editableUntil,
          lines: [],
        });
      }

      surveyMap.get(r.survey_id)!.lines.push({
        id: r.id,
        segment: r.segment,
        prayagItemCode: r.prayag_item_code,
        itemName: r.item_name,
        currentMrp: r.current_mrp ? parseFloat(r.current_mrp) : null,
        competitorBrand: r.competitor_brand,
        competitorProduct: r.competitor_product,
        netPrice: parseFloat(r.net_price),
        mrp: r.entry_mrp ? parseFloat(r.entry_mrp) : null,
        discountPct: r.discount_pct ? parseFloat(r.discount_pct) : null,
        entryMode: r.entry_mode,
        unit: r.unit,
        packSize: r.pack_size,
        reasons: r.reasons,
        monthlyVolume: r.monthly_volume ? parseFloat(r.monthly_volume) : null,
        note: r.note,
        createdAt: r.created_at,
        editable: new Date(r.created_at).getTime() + 24 * 3600 * 1000 > now,
        creditDaysCompetitor:     r.credit_days_competitor   ?? null,
        creditGivenBy:            r.credit_given_by          ?? null,
        creditDaysPrayag:         r.credit_days_prayag       ?? null,
        competitorSchemeType:     r.competitor_scheme_type   ?? null,
        competitorSchemeValue:    r.competitor_scheme_value  ?? null,
        deliveryDaysCompetitor:   r.delivery_days_competitor ?? null,
        deliveryDaysPrayag:       r.delivery_days_prayag     ?? null,
        shelfShare:               r.shelf_share              ?? null,
        paymentTermsNote:         r.payment_terms_note       ?? null,
        competitorVisitFrequency: r.competitor_visit_frequency ?? null,
        competitorMoq:            r.competitor_moq           ?? null,
        buyingSince:              r.buying_since             ?? null,
        wouldSwitch:              r.would_switch             ?? null,
        switchCondition:          r.switch_condition         ?? null,
      });
    }

    const groups: Group[] = TYPE_ORDER
      .filter((t) => groupMap.has(t))
      .map((t) => {
        const surveys = Array.from(groupMap.get(t)!.values());
        surveys.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
        const allLines = surveys.flatMap((s) => s.lines);
        let combinedValue: number | null = null;
        for (const l of allLines) {
          if (l.monthlyVolume != null) combinedValue = (combinedValue ?? 0) + l.netPrice * l.monthlyVolume;
        }
        return { surveyType: t, label: TYPE_LABELS[t] ?? t, rowCount: allLines.length, combinedValue, surveys };
      });

    res.json({ total: result.rows.length, typeCounts, groups });
  } catch (err) {
    req.log?.error({ err }, "market-survey submissions error");
    res.status(500).json({ error: "Failed to load submissions" });
  }
});

// ── /reasons ────────────────────────────────────────────────────────────────
router.get("/market-survey/reasons", async (req, res) => {
  try {
    const [overall, bySeg] = await Promise.all([
      pool.query<{ reason: string; count: string }>(
        `SELECT reason, COUNT(*)::text AS count
         FROM market_survey, unnest(reasons) AS reason
         WHERE cardinality(reasons) > 0
         GROUP BY reason ORDER BY COUNT(*) DESC`,
      ),
      pool.query<{ segment: string; reason: string; count: string }>(
        `SELECT segment, reason, COUNT(*)::text AS count
         FROM market_survey, unnest(reasons) AS reason
         WHERE cardinality(reasons) > 0
         GROUP BY segment, reason ORDER BY segment, COUNT(*) DESC`,
      ),
    ]);
    const segMap: Record<string, Record<string, number>> = {};
    for (const r of bySeg.rows) { segMap[r.segment] ??= {}; segMap[r.segment][r.reason] = parseInt(r.count, 10); }
    res.json({
      overall:   overall.rows.map((r) => ({ reason: r.reason, count: parseInt(r.count, 10) })),
      bySegment: Object.entries(segMap).map(([segment, counts]) => ({ segment, counts })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load reasons" });
  }
});

// ── /new-sku-opportunity ─────────────────────────────────────────────────────
router.get("/market-survey/new-sku-opportunity", async (req, res) => {
  try {
    const result = await pool.query<{
      prayag_item_code: string; segment: string; item_name: string | null;
      current_mrp: string | null; n: string; retailers: string[]; brands: string[];
    }>(
      `SELECT s.prayag_item_code, s.segment, mi.item_name, h.mrp::text AS current_mrp,
              COUNT(*)::text AS n,
              array_agg(DISTINCT COALESCE(cm.company, s.prospect_name) ORDER BY COALESCE(cm.company, s.prospect_name))
                FILTER (WHERE COALESCE(cm.company, s.prospect_name) IS NOT NULL) AS retailers,
              array_agg(DISTINCT s.competitor_brand ORDER BY s.competitor_brand) AS brands
       FROM market_survey s
       LEFT JOIN customer_master cm ON cm.id = s.customer_id
       LEFT JOIN mrp_master mi ON mi.item_code = s.prayag_item_code AND mi.segment = s.segment
       LEFT JOIN mrp_history h  ON h.item_code = s.prayag_item_code AND h.segment = s.segment AND h.is_current = TRUE
       WHERE s.survey_type = 'new_sku' AND s.prayag_item_code IS NOT NULL
       GROUP BY s.prayag_item_code, s.segment, mi.item_name, h.mrp
       ORDER BY COUNT(*) DESC`,
    );
    res.json({ rows: result.rows.map((r) => ({
      prayagItemCode: r.prayag_item_code, segment: r.segment,
      itemName: r.item_name,
      currentMrp: r.current_mrp ? parseFloat(r.current_mrp) : null,
      n: parseInt(r.n, 10), retailers: r.retailers ?? [], brands: r.brands ?? [],
    })) });
  } catch (err) {
    res.status(500).json({ error: "Failed to load new SKU opportunity" });
  }
});

// ── /vs-competition ──────────────────────────────────────────────────────────
// Rows where a survey prayag_item_code also exists in competitor_price.
router.get("/market-survey/vs-competition", async (req, res) => {
  try {
    const result = await pool.query<{
      prayag_item_code: string; segment: string; item_name: string | null;
      current_mrp: string | null; survey_n: string; survey_median: string;
      comp_brand: string; comp_code: string; comp_name: string | null;
      comp_mrp: string | null; comp_net_derived: string | null; comp_discount: string | null;
    }>(
      `SELECT s.prayag_item_code, s.segment, mi.item_name, h.mrp::text AS current_mrp,
              COUNT(DISTINCT s.id)::text AS survey_n,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.net_price)::text AS survey_median,
              cp.competitor_brand AS comp_brand, cp.competitor_code AS comp_code,
              cp.competitor_name AS comp_name, cp.mrp::text AS comp_mrp,
              cp.net_price_derived::text AS comp_net_derived,
              cp.discount_pct_assumed::text AS comp_discount
       FROM market_survey s
       JOIN competitor_price cp ON cp.prayag_item_code = s.prayag_item_code
       LEFT JOIN mrp_master mi ON mi.item_code = s.prayag_item_code AND mi.segment = s.segment
       LEFT JOIN mrp_history h  ON h.item_code = s.prayag_item_code AND h.segment = s.segment AND h.is_current = TRUE
       WHERE s.prayag_item_code IS NOT NULL
       GROUP BY s.prayag_item_code, s.segment, mi.item_name, h.mrp,
                cp.competitor_brand, cp.competitor_code, cp.competitor_name, cp.mrp, cp.net_price_derived, cp.discount_pct_assumed
       ORDER BY s.prayag_item_code, cp.competitor_brand`,
    );

    type OutRow = {
      prayagItemCode: string; segment: string; itemName: string | null; currentMrp: number | null;
      surveyN: number; surveyMedian: number;
      competitorRows: { brand: string; code: string; name: string | null; mrp: number | null; netDerived: number | null; discountAssumed: number | null; label: "DERIVED" }[];
    };
    const map = new Map<string, OutRow>();
    for (const r of result.rows) {
      const key = `${r.prayag_item_code}|${r.segment}`;
      if (!map.has(key)) map.set(key, {
        prayagItemCode: r.prayag_item_code, segment: r.segment,
        itemName: r.item_name,
        currentMrp: r.current_mrp ? parseFloat(r.current_mrp) : null,
        surveyN: parseInt(r.survey_n, 10), surveyMedian: parseFloat(r.survey_median),
        competitorRows: [],
      });
      map.get(key)!.competitorRows.push({
        brand: r.comp_brand, code: r.comp_code, name: r.comp_name,
        mrp: r.comp_mrp ? parseFloat(r.comp_mrp) : null,
        netDerived: r.comp_net_derived ? parseFloat(r.comp_net_derived) : null,
        discountAssumed: r.comp_discount ? parseFloat(r.comp_discount) : null,
        label: "DERIVED",
      });
    }
    res.json({ rows: Array.from(map.values()) });
  } catch (err) {
    res.status(500).json({ error: "Failed to load competition comparison" });
  }
});

// ── /export ──────────────────────────────────────────────────────────────────
// XLSX download of submissions with same filters as /submissions.
router.get("/market-survey/export", async (req, res) => {
  try {
    const stateHead = str(req.query.stateHead);
    const state     = str(req.query.state);
    const segment   = str(req.query.segment);
    const brand     = str(req.query.brand);
    const recorder  = str(req.query.recorder);
    const dateFrom  = str(req.query.dateFrom);
    const dateTo    = str(req.query.dateTo);

    const conds: string[] = [];
    const params: unknown[] = [];
    let p = 1;

    if (stateHead) {
      const { resolvePickerToStoredHead } = await import("../lib/customerStateHead.js");
      const stored = await resolvePickerToStoredHead(pool, stateHead);
      conds.push(`s.state IN (SELECT DISTINCT state FROM customer_master WHERE state_head = $${p++} AND state IS NOT NULL)`);
      params.push(stored);
    }
    if (state)    { conds.push(`s.state = $${p++}`);                                params.push(state); }
    if (segment)  { conds.push(`s.segment = $${p++}`);                              params.push(segment); }
    if (brand)    { conds.push(`s.competitor_brand ILIKE $${p++}`);                 params.push(`%${brand}%`); }
    if (recorder) { conds.push(`s.recorded_by = $${p++}`);                          params.push(recorder); }
    if (dateFrom) { conds.push(`s.created_at >= $${p++}`);                          params.push(dateFrom); }
    if (dateTo)   { conds.push(`s.created_at < $${p++}::date + interval '1 day'`); params.push(dateTo); }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT s.created_at, s.recorded_by, s.survey_type,
              COALESCE(cm.company, s.prospect_name) AS retailer,
              CASE WHEN s.pending_prospect_id IS NOT NULL AND cm.id IS NULL THEN 'yes' ELSE 'no' END AS is_pending,
              s.state, s.district, s.segment, s.prayag_item_code,
              h.mrp::float AS our_mrp,
              s.competitor_brand, s.competitor_product,
              s.net_price::float, s.entry_mode, s.unit, s.pack_size,
              array_to_string(s.reasons, ', ') AS reasons,
              s.monthly_volume::float, s.note,
              s.credit_days_competitor, s.credit_given_by, s.credit_days_prayag,
              s.competitor_scheme_type, s.competitor_scheme_value,
              s.delivery_days_competitor, s.delivery_days_prayag, s.shelf_share
       FROM market_survey s
       LEFT JOIN customer_master cm ON cm.id = s.customer_id
       LEFT JOIN mrp_history h ON h.item_code = s.prayag_item_code AND h.segment = s.segment AND h.is_current = TRUE
       ${where}
       ORDER BY
         CASE s.survey_type WHEN 'existing_sku' THEN 1 WHEN 'new_sku' THEN 2 WHEN 'new_customer' THEN 3 ELSE 4 END,
         s.survey_id, s.id`,
      params,
    );

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Market Survey");
    ws.columns = [
      { header: "Submitted",                   key: "created_at",               width: 20 },
      { header: "Recorder (self-declared)",    key: "recorded_by",              width: 22 },
      { header: "Survey Type",                 key: "survey_type",              width: 18 },
      { header: "Retailer",                    key: "retailer",                 width: 30 },
      { header: "Pending Prospect",            key: "is_pending",               width: 14 },
      { header: "State",                       key: "state",                    width: 16 },
      { header: "District",                    key: "district",                 width: 16 },
      { header: "Segment",                     key: "segment",                  width: 14 },
      { header: "Prayag Code",                 key: "prayag_item_code",         width: 14 },
      { header: "Our MRP (₹)",                 key: "our_mrp",                  width: 12 },
      { header: "Competitor Brand",            key: "competitor_brand",         width: 20 },
      { header: "Competitor Product",          key: "competitor_product",       width: 22 },
      { header: "Net Price (₹)",               key: "net_price",                width: 12 },
      { header: "Entry Mode",                  key: "entry_mode",               width: 14 },
      { header: "Unit",                        key: "unit",                     width: 10 },
      { header: "Pack Size",                   key: "pack_size",                width: 14 },
      { header: "Reasons",                     key: "reasons",                  width: 30 },
      { header: "Monthly Volume",              key: "monthly_volume",           width: 16 },
      { header: "Note",                        key: "note",                     width: 30 },
      { header: "Competitor Credit Days",      key: "credit_days_competitor",   width: 18 },
      { header: "Credit Given By",             key: "credit_given_by",          width: 20 },
      { header: "Prayag Credit Days",          key: "credit_days_prayag",       width: 16 },
      { header: "Competitor Scheme Type",      key: "competitor_scheme_type",   width: 20 },
      { header: "Competitor Scheme Value",     key: "competitor_scheme_value",  width: 24 },
      { header: "Competitor Delivery Days",   key: "delivery_days_competitor",  width: 20 },
      { header: "Prayag Delivery Days",        key: "delivery_days_prayag",     width: 18 },
      { header: "Shelf Share",                 key: "shelf_share",              width: 20 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of result.rows) {
      ws.addRow({ ...r, created_at: new Date(r.created_at).toLocaleString("en-IN") });
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="market-survey-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    req.log?.error({ err }, "market-survey export error");
    res.status(500).json({ error: "Failed to export" });
  }
});

// ── GET /api/market-survey/credit-comparison ─────────────────────────────
// Median credit days: competitor vs Prayag, by state and segment, with n.
// Also breaks down credit_given_by (distributor vs competitor_company vs unknown).
router.get("/market-survey/credit-comparison", async (_req, res) => {
  try {
    const result = await pool.query<{
      state: string; segment: string; n: string;
      median_comp: string | null; median_prayag: string | null;
      by_distributor: string; by_company: string; by_unknown: string;
    }>(
      `SELECT
         COALESCE(state, '(no state)')                                                    AS state,
         segment,
         COUNT(*) FILTER (WHERE credit_days_competitor IS NOT NULL
                              OR credit_days_prayag IS NOT NULL
                              OR credit_given_by IS NOT NULL)::text                        AS n,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY credit_days_competitor)::text         AS median_comp,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY credit_days_prayag)::text             AS median_prayag,
         COUNT(*) FILTER (WHERE credit_given_by = 'distributor')::text                    AS by_distributor,
         COUNT(*) FILTER (WHERE credit_given_by = 'competitor_company')::text             AS by_company,
         COUNT(*) FILTER (WHERE credit_given_by = 'unknown')::text                        AS by_unknown
       FROM market_survey
       WHERE credit_days_competitor IS NOT NULL
          OR credit_days_prayag     IS NOT NULL
          OR credit_given_by        IS NOT NULL
       GROUP BY state, segment
       ORDER BY state, segment`,
    );
    res.json({
      rows: result.rows.map((r) => ({
        state:                   r.state,
        segment:                 r.segment,
        n:                       parseInt(r.n, 10),
        medianCompetitorDays:    r.median_comp   ? parseFloat(r.median_comp)   : null,
        medianPrayagDays:        r.median_prayag ? parseFloat(r.median_prayag) : null,
        givenByDistributor:      parseInt(r.by_distributor, 10),
        givenByCompetitorCompany: parseInt(r.by_company,    10),
        givenByUnknown:          parseInt(r.by_unknown,     10),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load credit comparison" });
  }
});

// ── GET /api/market-survey/scheme-comparison ──────────────────────────────
// Competitor scheme values recorded, grouped by type, with n.
router.get("/market-survey/scheme-comparison", async (_req, res) => {
  try {
    const result = await pool.query<{
      scheme_type: string; n: string; values_seen: string[] | null;
    }>(
      `SELECT
         competitor_scheme_type                                                              AS scheme_type,
         COUNT(*)::text                                                                      AS n,
         array_agg(DISTINCT competitor_scheme_value ORDER BY competitor_scheme_value)
           FILTER (WHERE competitor_scheme_value IS NOT NULL AND competitor_scheme_value != '') AS values_seen
       FROM market_survey
       WHERE competitor_scheme_type IS NOT NULL
       GROUP BY competitor_scheme_type
       ORDER BY COUNT(*) DESC`,
    );
    res.json({
      rows: result.rows.map((r) => ({
        schemeType: r.scheme_type,
        n:          parseInt(r.n, 10),
        valuesSeen: r.values_seen ?? [],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load scheme comparison" });
  }
});

// ── GET /api/market-survey/delivery-comparison ────────────────────────────
// Delivery days distribution (competitor vs Prayag) by state, with n and range.
router.get("/market-survey/delivery-comparison", async (_req, res) => {
  try {
    const result = await pool.query<{
      state: string; n: string;
      median_comp: string | null; min_comp: string | null; max_comp: string | null;
      median_prayag: string | null; min_prayag: string | null; max_prayag: string | null;
    }>(
      `SELECT
         COALESCE(state, '(no state)')                                                         AS state,
         COUNT(*) FILTER (WHERE delivery_days_competitor IS NOT NULL
                              OR delivery_days_prayag   IS NOT NULL)::text                     AS n,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY delivery_days_competitor)::text           AS median_comp,
         MIN(delivery_days_competitor)::text                                                    AS min_comp,
         MAX(delivery_days_competitor)::text                                                    AS max_comp,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY delivery_days_prayag)::text               AS median_prayag,
         MIN(delivery_days_prayag)::text                                                        AS min_prayag,
         MAX(delivery_days_prayag)::text                                                        AS max_prayag
       FROM market_survey
       WHERE delivery_days_competitor IS NOT NULL OR delivery_days_prayag IS NOT NULL
       GROUP BY state
       ORDER BY state`,
    );
    res.json({
      rows: result.rows
        .filter((r) => parseInt(r.n, 10) > 0)
        .map((r) => ({
          state:               r.state,
          n:                   parseInt(r.n, 10),
          medianCompetitorDays: r.median_comp   ? parseFloat(r.median_comp)   : null,
          minCompetitor:        r.min_comp      ? parseFloat(r.min_comp)      : null,
          maxCompetitor:        r.max_comp      ? parseFloat(r.max_comp)      : null,
          medianPrayagDays:     r.median_prayag ? parseFloat(r.median_prayag) : null,
          minPrayag:            r.min_prayag    ? parseFloat(r.min_prayag)    : null,
          maxPrayag:            r.max_prayag    ? parseFloat(r.max_prayag)    : null,
        })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load delivery comparison" });
  }
});

// ── GET /api/market-survey/sized-opportunity ──────────────────────────────
// Estimated monthly value going to competitors from shelf_share × net_price × monthly_volume.
// Assumption bands: mostly_prayag=20%, even_split=50%, mostly_competitor=80%, only_competitor=100%.
router.get("/market-survey/sized-opportunity", async (_req, res) => {
  try {
    const CASE_EXPR = `CASE shelf_share
      WHEN 'mostly_prayag'     THEN 0.20 * net_price::float * monthly_volume::float
      WHEN 'even_split'        THEN 0.50 * net_price::float * monthly_volume::float
      WHEN 'mostly_competitor' THEN 0.80 * net_price::float * monthly_volume::float
      WHEN 'only_competitor'   THEN 1.00 * net_price::float * monthly_volume::float
      ELSE 0
    END`;
    const result = await pool.query<{
      segment: string; state: string; n: string; est_monthly: string | null;
    }>(
      `SELECT
         segment,
         COALESCE(state, '(no state)')                                                      AS state,
         COUNT(*) FILTER (WHERE shelf_share IS NOT NULL AND monthly_volume IS NOT NULL)::text AS n,
         SUM(${CASE_EXPR}) FILTER (WHERE shelf_share IS NOT NULL AND monthly_volume IS NOT NULL)::text AS est_monthly
       FROM market_survey
       GROUP BY segment, state
       HAVING COUNT(*) FILTER (WHERE shelf_share IS NOT NULL AND monthly_volume IS NOT NULL) > 0
       ORDER BY SUM(${CASE_EXPR}) FILTER (WHERE shelf_share IS NOT NULL AND monthly_volume IS NOT NULL) DESC NULLS LAST`,
    );
    res.json({
      assumption: "mostly_prayag=20%, even_split=50%, mostly_competitor=80%, only_competitor=100% of (net price × monthly volume) estimated as going to competitors. Both shelf_share and monthly_volume must be recorded for a row to contribute.",
      rows: result.rows.map((r) => ({
        segment:                      r.segment,
        state:                        r.state,
        n:                            parseInt(r.n, 10),
        estimatedMonthlyToCompetitor: r.est_monthly ? parseFloat(r.est_monthly) : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load sized opportunity" });
  }
});

export default router;
