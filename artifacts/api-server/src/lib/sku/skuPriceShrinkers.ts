/**
 * SKU Price Shrinkers — Phase K5b.
 *
 * Identifies codes where piece volume grew but real value declined because
 * the MRP rise outpaced the value growth.  Uses the Laspeyres MRP index
 * identical to Red Alert B1 (mrpIndex.ts), applied per code.
 *
 * Qualifying condition:  qtyGrowth% > 0  AND  realGrowth% < 0
 *   where realGrowth% = valueGrowth% − mrpIncrease%
 *
 * Both MRP figures come from mrp_history (effective-dated).
 * Ambiguous codes (same code, two segments at different prices) are resolved
 * on (item_code, segment) — never code alone.
 *
 * Codes with no MRP record whatsoever are EXCLUDED and counted separately.
 *
 * Channel: territory only.  Level (distributor / direct_dealer) applies.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PROJECT_HEAD_CANON } from "./catalogue.js";
import { entityCondsAliased, type EntityFilter } from "../saleLineFilter.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert "Apr-25" → "2025-04-30" (last day of that calendar month). */
function monthLabelToEndDate(label: string): string {
  const [mon, yr] = label.split("-") as [string, string];
  const monthMap: Record<string, number> = {
    Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9,
    Oct: 10, Nov: 11, Dec: 12, Jan: 1, Feb: 2, Mar: 3,
  };
  const m = monthMap[mon] ?? 1;
  const y = 2000 + parseInt(yr, 10);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PriceShrinkersRow = {
  code: string;
  segment: string;
  itemName: string | null;
  qtyNow: number;
  qtyPrior: number;
  /** Positive — qualifying condition. */
  qtyGrowthPct: number;
  netNow: number;
  netPrior: number;
  valueGrowthPct: number;
  mrpThen: number;
  mrpNow: number;
  mrpIncreasePct: number;
  /** Negative — qualifying condition.  Headline column. */
  realGrowthPct: number;
  /** net_now / qty_now  — avg realised price per piece this period. */
  realisedPriceNow: number;
  /** net_prior / qty_prior — avg realised price per piece prior period. */
  realisedPricePrior: number;
  /** (realisedPriceNow / realisedPricePrior − 1) × 100 */
  realisedPriceChangePct: number;
};

export type PriceShrinkersResult = {
  fy: string;
  priorFy: string;
  currMonths: string[];
  priorMonths: string[];
  floor: number;
  /** Rows that pass the qualifying condition, sorted by realGrowthPct ascending (worst first). */
  rows: PriceShrinkersRow[];
  excludedNoMrp: {
    count: number;
    /** Top codes by prior-period net (for the expandable disclosure list). */
    topByNet: Array<{ code: string; segment: string; itemName: string | null; netPrior: number }>;
  };
};

// ── Params ────────────────────────────────────────────────────────────────────

export type PriceShrinkersParams = {
  fy: string;
  priorFy: string;
  currMonths: string[];
  priorMonths: string[];
  level: "distributor" | "direct_dealer";
  scope: "company" | "head";
  scopeId?: string;
  entityFilter?: EntityFilter;
  floor: number;
};

// ── Main ──────────────────────────────────────────────────────────────────────

export async function getPriceShrinkers(params: PriceShrinkersParams): Promise<PriceShrinkersResult> {
  const { fy, priorFy, currMonths, priorMonths, level, scope, scopeId, entityFilter, floor } = params;

  if (priorMonths.length === 0) {
    return { fy, priorFy, currMonths, priorMonths, floor, rows: [], excludedNoMrp: { count: 0, topByNet: [] } };
  }

  // MRP-then date: end of last prior month
  const priorAsOf = monthLabelToEndDate(priorMonths[priorMonths.length - 1]!);

  // Level / territory filter
  const projectExclude = sql`AND (sl.head_canon IS NULL OR sl.head_canon != ${PROJECT_HEAD_CANON})`;
  const levelFilter =
    level === "direct_dealer"
      ? sql`AND sl.type_raw ILIKE '%direct%' ${projectExclude}`
      : sql`AND (sl.type_raw IS NULL OR sl.type_raw NOT ILIKE '%direct%') ${projectExclude}`;

  const scopeFilter =
    scope === "head" && scopeId ? sql`AND sl.head_canon = ${scopeId}` : sql``;

  const entityFilterSql = entityCondsAliased(entityFilter, "sl");

  const currArr  = sql.join(currMonths.map( (m) => sql`${m}`), sql`, `);
  const priorArr = sql.join(priorMonths.map((m) => sql`${m}`), sql`, `);

  // ── Main query: codes present in BOTH periods + MRP data ─────────────────

  const rows = await db.execute<{
    segment:   string;
    code:      string;
    item_name: string | null;
    qty_now:   string;
    qty_prior: string;
    net_now:   string;
    net_prior: string;
    mrp_then:  string | null;
    mrp_now:   string | null;
  }>(sql`
    WITH
    curr AS (
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        sl.code,
        SUM(sl.qty::numeric)    AS qty,
        SUM(sl.amount::numeric) AS net
      FROM sale_line_current sl
      WHERE sl.fy             = ${fy}
        AND sl.month_label    = ANY(ARRAY[${currArr}])
        AND sl.version_status = 'current'
        ${levelFilter}
        ${scopeFilter}
        ${entityFilterSql}
      GROUP BY 1, sl.code
    ),
    prior AS (
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        sl.code,
        SUM(sl.qty::numeric)    AS qty,
        SUM(sl.amount::numeric) AS net
      FROM sale_line_current sl
      WHERE sl.fy             = ${priorFy}
        AND sl.month_label    = ANY(ARRAY[${priorArr}])
        AND sl.version_status = 'current'
        ${levelFilter}
        ${scopeFilter}
        ${entityFilterSql}
      GROUP BY 1, sl.code
    ),
    -- Bridge sale_line.group_canon → mrp_master.segment taxonomy.
    -- sale_line uses "PTMT / Faucets", mrp_master uses "PTMT".
    -- For ambiguous codes (same item_code, two mrp segments), pick the
    -- mrp_master segment that best matches group_canon via prefix/substring.
    code_mrp_seg AS (
      SELECT DISTINCT ON (t.code, t.grp)
        t.code,
        t.grp,
        t.mm_seg
      FROM (
        SELECT
          p.code,
          p.segment                    AS grp,
          mm.segment                   AS mm_seg,
          CASE
            WHEN p.segment = mm.segment                   THEN 0  -- exact
            WHEN p.segment ILIKE mm.segment || ' %'       THEN 1  -- "PTMT / Faucets" starts with "PTMT "
            WHEN p.segment ILIKE mm.segment || ' (%'      THEN 1  -- "CP (Chrome-Plated)" starts with "CP ("
            WHEN p.segment ILIKE '%' || mm.segment || '%' THEN 2  -- substring
            ELSE 99
          END AS rank
        FROM (SELECT DISTINCT code, segment FROM prior) p
        JOIN mrp_master mm ON mm.item_code = p.code
      ) t
      WHERE t.rank < 99
      ORDER BY t.code, t.grp, t.rank ASC, t.mm_seg ASC
    ),
    -- MRP as of end of prior period: for each (item_code, mrp_segment) prefer
    -- rows within the effective window, then fall back to latest before asOf.
    mrp_then AS (
      SELECT DISTINCT ON (item_code, segment)
        item_code, segment, mrp
      FROM mrp_history
      WHERE effective_from <= ${priorAsOf}
      ORDER BY item_code, segment,
        CASE WHEN effective_to IS NULL OR effective_to >= ${priorAsOf} THEN 0 ELSE 1 END ASC,
        effective_from DESC
    ),
    -- Current MRP (is_current = true).
    mrp_now AS (
      SELECT DISTINCT ON (item_code, segment)
        item_code, segment, mrp
      FROM mrp_history
      WHERE is_current = true
      ORDER BY item_code, segment, effective_from DESC
    )
    SELECT
      p.segment,
      p.code,
      im.item_name,
      c.qty::text        AS qty_now,
      p.qty::text        AS qty_prior,
      c.net::text        AS net_now,
      p.net::text        AS net_prior,
      mt.mrp::text       AS mrp_then,
      mn.mrp::text       AS mrp_now
    FROM prior p
    JOIN curr c     ON  c.code    = p.code    AND  c.segment = p.segment
    LEFT JOIN item_master im ON im.code = p.code
    LEFT JOIN code_mrp_seg cms ON cms.code = p.code AND cms.grp = p.segment
    LEFT JOIN mrp_then mt ON mt.item_code = p.code AND mt.segment = cms.mm_seg
    LEFT JOIN mrp_now  mn ON mn.item_code = p.code AND mn.segment = cms.mm_seg
    WHERE p.net::numeric >= ${floor}
      AND p.qty::numeric  > 0
      AND c.qty::numeric  > 0
  `);

  // ── Compute metrics and apply qualifying filter in TypeScript ─────────────

  const qualifiedRows: PriceShrinkersRow[] = [];

  for (const r of rows.rows) {
    const qtyNow   = parseFloat(r.qty_now)   || 0;
    const qtyPrior = parseFloat(r.qty_prior) || 0;
    const netNow   = parseFloat(r.net_now)   || 0;
    const netPrior = parseFloat(r.net_prior) || 0;

    if (qtyNow <= 0 || qtyPrior <= 0 || netPrior <= 0) continue;

    // MRP data required for this tab
    if (r.mrp_then == null || r.mrp_now == null) continue;
    const mrpThen = parseFloat(r.mrp_then);
    const mrpNow  = parseFloat(r.mrp_now);
    if (mrpThen <= 0 || mrpNow <= 0) continue;

    const qtyGrowthPct   = (qtyNow  / qtyPrior - 1) * 100;
    const valueGrowthPct = (netNow  / netPrior  - 1) * 100;
    const mrpIncreasePct = (mrpNow  / mrpThen   - 1) * 100;
    const realGrowthPct  = valueGrowthPct - mrpIncreasePct;

    // Qualifying condition
    if (qtyGrowthPct <= 0 || realGrowthPct >= 0) continue;

    const realisedPriceNow   = netNow   / qtyNow;
    const realisedPricePrior = netPrior / qtyPrior;
    const realisedPriceChangePct = (realisedPriceNow / realisedPricePrior - 1) * 100;

    qualifiedRows.push({
      code:     r.code,
      segment:  r.segment,
      itemName: r.item_name,
      qtyNow,
      qtyPrior,
      qtyGrowthPct,
      netNow,
      netPrior,
      valueGrowthPct,
      mrpThen,
      mrpNow,
      mrpIncreasePct,
      realGrowthPct,
      realisedPriceNow,
      realisedPricePrior,
      realisedPriceChangePct,
    });
  }

  // Sort worst first (most negative realGrowthPct)
  qualifiedRows.sort((a, b) => a.realGrowthPct - b.realGrowthPct);

  // ── Excluded codes: prior sales but NO MRP record for their (code, segment) ─

  // Excluded = codes in prior period that have NO mrp_history entry at all
  // (regardless of segment). These are whole code families (PTA-, CPCS-, etc.)
  // that were never loaded into the MRP master.
  const excludedRows = await db.execute<{
    segment:   string;
    code:      string;
    item_name: string | null;
    net_prior: string;
  }>(sql`
    WITH
    prior AS (
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        sl.code,
        SUM(sl.amount::numeric) AS net
      FROM sale_line_current sl
      WHERE sl.fy             = ${priorFy}
        AND sl.month_label    = ANY(ARRAY[${priorArr}])
        AND sl.version_status = 'current'
        ${levelFilter}
        ${scopeFilter}
        ${entityFilterSql}
      GROUP BY 1, sl.code
    ),
    has_mrp AS (
      SELECT DISTINCT item_code FROM mrp_history
    )
    SELECT
      p.segment,
      p.code,
      im.item_name,
      p.net::text AS net_prior
    FROM prior p
    LEFT JOIN has_mrp h  ON h.item_code = p.code
    LEFT JOIN item_master im ON im.code = p.code
    WHERE p.net::numeric >= ${floor}
      AND h.item_code IS NULL
    ORDER BY p.net::numeric DESC
    LIMIT 20
  `);

  // Total count
  const countRow = await db.execute<{ cnt: string }>(sql`
    WITH
    prior AS (
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        sl.code,
        SUM(sl.amount::numeric) AS net
      FROM sale_line_current sl
      WHERE sl.fy             = ${priorFy}
        AND sl.month_label    = ANY(ARRAY[${priorArr}])
        AND sl.version_status = 'current'
        ${levelFilter}
        ${scopeFilter}
        ${entityFilterSql}
      GROUP BY 1, sl.code
    ),
    has_mrp AS (SELECT DISTINCT item_code FROM mrp_history)
    SELECT COUNT(*)::text AS cnt
    FROM prior p
    LEFT JOIN has_mrp h ON h.item_code = p.code
    WHERE p.net::numeric >= ${floor} AND h.item_code IS NULL
  `);

  const excludedCount = parseInt(countRow.rows[0]?.cnt ?? "0", 10);

  return {
    fy,
    priorFy,
    currMonths,
    priorMonths,
    floor,
    rows: qualifiedRows,
    excludedNoMrp: {
      count: excludedCount,
      topByNet: excludedRows.rows.map((r) => ({
        code:     r.code,
        segment:  r.segment,
        itemName: r.item_name,
        netPrior: parseFloat(r.net_prior) || 0,
      })),
    },
  };
}
