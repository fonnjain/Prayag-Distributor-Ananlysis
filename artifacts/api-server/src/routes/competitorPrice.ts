// competitorPrice.ts — routes for the local competitor price snapshot.
//
// Snapshot lifecycle:
//   refreshSnapshot()   — fetch from competition app → upsert competitor_price table
//   scheduleRefresh()   — call once at startup; fires 5 min after boot then every 24 h
//
// Routes (all read-only except refresh + map):
//   GET  /api/competitor-price              — all rows (with filters)
//   GET  /api/competitor-price/snapshot-info — { fetchedAt, rowCount, mappedCount }
//   GET  /api/competitor-price/for-code/:code — rows mapped to one Prayag code
//   POST /api/competitor-price/refresh       — admin: re-fetch from competition app
//   PATCH /api/competitor-price/:id/map      — link/unlink a row to a Prayag code
//
// COMPETITION_API_KEY lives only here; never leaks to the client bundle.

import { Router } from "express";
import { pool } from "@workspace/db";
import { fetchCompetitionData, ASSUMED_DISCOUNT_PCT } from "../lib/competitionClient.js";
import type { Request, Response } from "express";

export const router = Router();
export default router;

// ── Snapshot loader ────────────────────────────────────────────────────────

interface RefreshReport {
  rowsImported: number;
  brands: string[];
  categories: string[];
  withPrice: number;
  withoutPrice: number;
  fetchedAt: Date;
}

let refreshInFlight = false;
let lastRefreshError: string | null = null;
let lastRefreshAt: Date | null = null;

export async function refreshSnapshot(): Promise<RefreshReport> {
  if (refreshInFlight) throw new Error("Refresh already in progress");
  refreshInFlight = true;
  try {
    const { rows, fetchedAt } = await fetchCompetitionData();

    const withPrice = rows.filter((r) => r.competitorPrice != null).length;
    const brands = [...new Set(rows.map((r) => r.competitor))];
    const categories = [...new Set(rows.map((r) => r.category))];

    // Upsert — preserve prayag_item_code / mapped_by / mapped_at on conflict
    for (const row of rows) {
      const mrp = row.competitorPrice ?? null;
      const netDerived =
        mrp != null
          ? Math.round(mrp * (1 - ASSUMED_DISCOUNT_PCT / 100) * 100) / 100
          : null;
      await pool.query(
        `INSERT INTO competitor_price
           (competitor_brand, competitor_code, competitor_name, category,
            mrp, net_price_derived, discount_pct_assumed, source_fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (competitor_brand, competitor_code) DO UPDATE SET
           competitor_name      = EXCLUDED.competitor_name,
           category             = EXCLUDED.category,
           mrp                  = EXCLUDED.mrp,
           net_price_derived    = EXCLUDED.net_price_derived,
           discount_pct_assumed = EXCLUDED.discount_pct_assumed,
           source_fetched_at    = EXCLUDED.source_fetched_at
           -- prayag_item_code, mapped_by, mapped_at deliberately NOT updated`,
        [
          row.competitor,
          String(row.id),
          row.description + (row.size ? ` ${row.size}` : ""),
          row.category,
          mrp,
          netDerived,
          ASSUMED_DISCOUNT_PCT,
          fetchedAt,
        ],
      );
    }

    lastRefreshAt = fetchedAt;
    lastRefreshError = null;
    return { rowsImported: rows.length, brands, categories, withPrice, withoutPrice: rows.length - withPrice, fetchedAt };
  } catch (err) {
    lastRefreshError = String(err);
    throw err;
  } finally {
    refreshInFlight = false;
  }
}

export function scheduleCompetitorRefresh(): void {
  const run = (): void => {
    void refreshSnapshot().catch(() => { /* logged by caller */ });
  };
  // First run 5 min after startup (let other boot jobs settle), then every 24 h.
  setTimeout(run, 5 * 60_000).unref();
  setInterval(run, 24 * 3_600_000).unref();
}

// ── GET /api/competitor-price/snapshot-info ────────────────────────────────
router.get("/competitor-price/snapshot-info", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<{
      total: string; mapped: string; fetched_at: string | null;
    }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(prayag_item_code)::text AS mapped,
              MAX(source_fetched_at)::text  AS fetched_at
       FROM competitor_price`,
    );
    const r = rows[0];
    res.json({
      rowCount:      parseInt(r?.total ?? "0", 10),
      mappedCount:   parseInt(r?.mapped ?? "0", 10),
      fetchedAt:     r?.fetched_at ?? null,
      refreshInFlight,
      lastError:     lastRefreshError,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/competitor-price ──────────────────────────────────────────────
// Query params: ?category= ?mappedOnly=true ?unmappedOnly=true ?q= (description search)
router.get("/competitor-price", async (req: Request, res: Response) => {
  try {
    const category    = typeof req.query.category === "string" ? req.query.category.trim() : null;
    const q           = typeof req.query.q === "string" ? req.query.q.trim() : null;
    const mappedOnly  = req.query.mappedOnly === "true";
    const unmappedOnly = req.query.unmappedOnly === "true";

    const conds: string[] = [];
    const params: (string | boolean)[] = [];
    let p = 1;

    if (category) { conds.push(`category = $${p++}`); params.push(category); }
    if (q)        { conds.push(`competitor_name ILIKE $${p++}`); params.push(`%${q}%`); }
    if (mappedOnly)   conds.push("prayag_item_code IS NOT NULL");
    if (unmappedOnly) conds.push("prayag_item_code IS NULL");

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const { rows } = await pool.query<{
      id: number;
      competitor_brand: string;
      competitor_code: string;
      competitor_name: string | null;
      category: string;
      mrp: string | null;
      net_price_derived: string | null;
      discount_pct_assumed: string | null;
      source_fetched_at: string;
      prayag_item_code: string | null;
      mapped_by: string | null;
      mapped_at: string | null;
    }>(
      `SELECT id, competitor_brand, competitor_code, competitor_name, category,
              mrp::text, net_price_derived::text, discount_pct_assumed::text,
              source_fetched_at::text,
              prayag_item_code, mapped_by, mapped_at::text
       FROM competitor_price
       ${where}
       ORDER BY category, competitor_name`,
      params,
    );

    // Snapshot age for "stale data" banner
    const snapshotFetchedAt = rows[0]?.source_fetched_at ?? null;

    res.json({
      rows: rows.map((r) => ({
        id:                r.id,
        competitorBrand:   r.competitor_brand,
        competitorCode:    r.competitor_code,
        competitorName:    r.competitor_name,
        category:          r.category,
        mrp:               r.mrp != null ? parseFloat(r.mrp) : null,
        netPriceDerived:   r.net_price_derived != null ? parseFloat(r.net_price_derived) : null,
        discountPctAssumed: r.discount_pct_assumed != null ? parseFloat(r.discount_pct_assumed) : null,
        fetchedAt:         r.source_fetched_at,
        prayagItemCode:    r.prayag_item_code,
        mappedBy:          r.mapped_by,
        mappedAt:          r.mapped_at,
      })),
      snapshotFetchedAt,
      lastError: lastRefreshError,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/competitor-price/for-code/:code ───────────────────────────────
// Returns competitor rows mapped to a specific Prayag item code.
// Also returns snapshot age so the UI can show staleness.
router.get("/competitor-price/for-code/:code", async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code).trim();

    const [mappedRows, snapshotInfo] = await Promise.all([
      pool.query<{
        id: number;
        competitor_brand: string;
        competitor_name: string | null;
        category: string;
        mrp: string | null;
        net_price_derived: string | null;
        discount_pct_assumed: string | null;
        source_fetched_at: string;
        mapped_by: string | null;
        mapped_at: string | null;
      }>(
        `SELECT id, competitor_brand, competitor_name, category,
                mrp::text, net_price_derived::text, discount_pct_assumed::text,
                source_fetched_at::text, mapped_by, mapped_at::text
         FROM competitor_price
         WHERE prayag_item_code = $1
         ORDER BY competitor_brand, category`,
        [code],
      ),
      pool.query<{ fetched_at: string | null }>(
        `SELECT MAX(source_fetched_at)::text AS fetched_at FROM competitor_price`,
      ),
    ]);

    const snapshotFetchedAt = snapshotInfo.rows[0]?.fetched_at ?? null;

    res.json({
      code,
      rows: mappedRows.rows.map((r) => ({
        id:                r.id,
        competitorBrand:   r.competitor_brand,
        competitorName:    r.competitor_name,
        category:          r.category,
        mrp:               r.mrp != null ? parseFloat(r.mrp) : null,
        netPriceDerived:   r.net_price_derived != null ? parseFloat(r.net_price_derived) : null,
        discountPctAssumed: r.discount_pct_assumed != null ? parseFloat(r.discount_pct_assumed) : null,
        fetchedAt:         r.source_fetched_at,
        mappedBy:          r.mapped_by,
        mappedAt:          r.mapped_at,
      })),
      snapshotFetchedAt,
      lastError: lastRefreshError,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/competitor-price/refresh ────────────────────────────────────
// Requires X-Admin-Secret header. Triggers a fresh fetch from the competition app.
router.post("/competitor-price/refresh", async (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET ?? "";
  const supplied    = req.headers["x-admin-secret"] as string | undefined;
  if (!supplied || supplied !== adminSecret) {
    res.status(403).json({ error: "X-Admin-Secret required" });
    return;
  }
  if (refreshInFlight) {
    res.status(409).json({ error: "Refresh already in progress" });
    return;
  }
  try {
    const report = await refreshSnapshot();
    res.json(report);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ── PATCH /api/competitor-price/:id/map ───────────────────────────────────
// Map or unmap a competitor row to a Prayag item code.
// Body: { prayagItemCode: string | null, mappedBy?: string }
// No credential required — mappedBy is self-declared (same pattern as market survey recorder).
router.patch("/competitor-price/:id/map", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { prayagItemCode, mappedBy } = req.body as {
    prayagItemCode: string | null | undefined;
    mappedBy?: string;
  };
  const code       = prayagItemCode?.trim() || null;
  const mapperName = mappedBy?.trim() || "(anonymous)";  // self-declared, unverified

  // If an authoritative MRP cache exists, it is the code authority.  Before
  // the first cache generation, preserve the legacy validation fallback.
  if (code) {
    const check = await pool.query(
      `SELECT 1
       FROM (
         SELECT s.item_code
         FROM mrp_synced s JOIN mrp_sync_generation g ON g.generation_id = s.generation_id
         WHERE g.is_active = TRUE
         UNION ALL
         SELECT m.item_code
         FROM mrp_master m
         WHERE NOT EXISTS (SELECT 1 FROM mrp_sync_generation WHERE is_active = TRUE)
       ) codes
       WHERE item_code = $1 LIMIT 1`,
      [code],
    );
    if ((check.rowCount ?? 0) === 0) {
      res.status(404).json({ error: `Code ${code} not found in MRP master` });
      return;
    }
  }

  const { rows } = await pool.query<{
    id: number;
    competitor_name: string | null;
    prayag_item_code: string | null;
    mapped_by: string | null;
    mapped_at: string | null;
  }>(
    `UPDATE competitor_price
     SET prayag_item_code = $1,
         mapped_by        = $2,
         mapped_at        = $3
     WHERE id = $4
     RETURNING id, competitor_name, prayag_item_code, mapped_by, mapped_at::text`,
    [code, code ? mapperName : null, code ? new Date() : null, id],
  );

  if (!rows.length) {
    res.status(404).json({ error: "Row not found" });
    return;
  }
  res.json({
    id:              rows[0].id,
    competitorName:  rows[0].competitor_name,
    prayagItemCode:  rows[0].prayag_item_code,
    mappedBy:        rows[0].mapped_by,
    mappedAt:        rows[0].mapped_at,
  });
});
