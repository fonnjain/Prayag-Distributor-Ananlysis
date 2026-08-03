/**
 * SKU Recommendations — Phase K3.
 *
 * Produces a ranked push list: for each segment with gap codes, return the
 * top-N codes that were NOT ordered in the selected period but had the
 * highest realised net in the same fiscal months across all prior loaded FYs.
 *
 * This is purely rule-based (sort + filter) — no AI, no forecast.
 *
 * The ranking is:  segments ordered by unboughtValue descending.
 * Within a segment: gap codes ordered by prior same-period net descending.
 *
 * Project entities (Non-territory / Project / Govt) are excluded from
 * territory-channel recommendations by the same level filter applied in
 * skuFacts.ts.  Selecting level="project" gives a project-specific focus list.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  PROJECT_HEAD_CANON,
  getEverSoldPerSegmentTerritory,
  getEverSoldPerSegmentProject,
  getEverSoldPerSegment,
} from "./catalogue.js";
import type { SkuLevel, SkuScope } from "./skuFacts.js";
import {
  entityCondsAliased,
  resolvePriorEntityFilter,
  type EntityFilter,
} from "../saleLineFilter.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type GapCode = {
  code: string;
  itemName: string | null;
  /** SUM(amount) in same fiscal months across all loaded FYs. */
  priorNet: number;
  /** Most recent FY in which this code appeared (any period). */
  lastFy: string;
};

export type SegmentRecommendation = {
  rank: number;
  segment: string;
  /** Bottom-up historical net of gap codes, same fiscal months, all FYs. */
  gapNet: number;
  /** Count of distinct gap codes. */
  gapCodeCount: number;
  codesBought: number;
  codesEverSold: number;
  breadthPct: number;
  /** Top gap codes by priorNet, up to TOP_GAP_CODES each. */
  topGapCodes: GapCode[];
};

export type SkuRecommendationsResult = {
  /** Segments with actionable gaps, ranked by gapNet descending. */
  recommendations: SegmentRecommendation[];
  /** Fiscal-month prefixes used in same-period comparison (e.g. ["Apr","May","Jun"]). */
  fiscalMonths: string[];
  /** Total gap net across all segments. */
  totalGapNet: number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const TOP_GAP_CODES = 8; // max gap codes returned per segment

// ── Main function ─────────────────────────────────────────────────────────────

export type RecommendationParams = {
  fy: string;
  monthLabels: string[];
  level: SkuLevel;
  scope: SkuScope;
  scopeId?: string;
  /** Shared State Head / State / Distributor filter (primary channels only). */
  entityFilter?: EntityFilter;
};

export async function getSkuRecommendations(
  params: RecommendationParams,
): Promise<SkuRecommendationsResult> {
  const { fy, monthLabels, level, scope, scopeId, entityFilter } = params;
  const entityFilterSql = entityCondsAliased(entityFilter, "sl");

  // ── Level filter (same logic as skuFacts.ts) ──────────────────────────────

  const projectHeadFilter = sql`AND (sl.head_canon IS NULL OR sl.head_canon != ${PROJECT_HEAD_CANON})`;
  const levelFilter =
    level === "project"
      ? sql`AND sl.head_canon = ${PROJECT_HEAD_CANON}`
      : level === "direct_dealer"
        ? sql`AND sl.type_raw ILIKE '%direct%' ${projectHeadFilter}`
        : sql`AND (sl.type_raw IS NULL OR sl.type_raw NOT ILIKE '%direct%') ${projectHeadFilter}`;

  const scopeFilter =
    scope === "customer" && scopeId
      ? sql`AND sl.customer = ${scopeId}`
      : scope === "head" && scopeId
        ? sql`AND sl.head_canon = ${scopeId}`
        : sql``;

  // ── Step 1: codes bought in the query period ──────────────────────────────

  const boughtRows = await db.execute<{ code: string; segment: string; net: string }>(sql`
    SELECT
      sl.code,
      COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
      SUM(sl.amount::numeric)::text AS net
    FROM sale_line_current sl
    WHERE sl.fy = ${fy}
      AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
      AND sl.version_status = 'current'
      AND sl.code IS NOT NULL AND sl.code <> ''
      ${levelFilter}
      ${scopeFilter}
      ${entityFilterSql}
    GROUP BY sl.code, COALESCE(sl.group_canon, sl.group_raw, 'Unmapped')
  `);

  const boughtCodeSet = new Set(boughtRows.rows.map((r) => r.code));

  // Segment-level stats from bought codes
  type SegAcc = { bought: Set<string>; net: number };
  const segStats = new Map<string, SegAcc>();
  for (const r of boughtRows.rows) {
    const acc = segStats.get(r.segment);
    if (acc) {
      acc.bought.add(r.code);
      acc.net += parseFloat(r.net) || 0;
    } else {
      segStats.set(r.segment, { bought: new Set([r.code]), net: parseFloat(r.net) || 0 });
    }
  }

  if (boughtCodeSet.size === 0) {
    return { recommendations: [], fiscalMonths: [], totalGapNet: 0 };
  }

  // ── Step 2: fiscal month prefixes for same-period comparison ─────────────

  const fiscalMonths = [...new Set(monthLabels.map((m) => m.split("-")[0]))];
  const fiscalMonthFilter = sql`AND split_part(sl.month_label, '-', 1) = ANY(ARRAY[${sql.join(fiscalMonths.map((m) => sql`${m}`), sql`, `)}])`;

  // ── Step 3: top gap codes per segment (CTE + ROW_NUMBER) ─────────────────
  // Also fetches per-segment gap code count and total gap net in the same query.

  const boughtArr = [...boughtCodeSet];
  const notBoughtFilter = sql`AND sl.code != ALL(ARRAY[${sql.join(boughtArr.map((c) => sql`${c}`), sql`, `)}])`;

  // Cross-FY scope: resolve head/state filter values (which describe the
  // selected FY) to that FY's customer set for the all-FY gap query — old rows
  // for reassigned distributors carry different head/state values.
  const historicalFilter =
    entityFilter && (entityFilter.heads?.length || entityFilter.states?.length)
      ? await resolvePriorEntityFilter(fy, entityFilter)
      : entityFilter;
  const historicalFilterSql = entityCondsAliased(historicalFilter, "sl");

  const gapResult = await db.execute<{
    segment: string;
    code: string;
    item_name: string | null;
    prior_net: string;
    last_fy: string;
    rnk: string;
    seg_gap_net: string;
    seg_gap_count: string;
  }>(sql`
    WITH aggregated AS (
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        sl.code,
        MAX(im.item_name)            AS item_name,
        SUM(sl.amount::numeric)      AS prior_net,
        MAX(sl.fy)                   AS last_fy
      FROM sale_line_current sl
      LEFT JOIN item_master im ON im.code = sl.code
      WHERE sl.version_status = 'current'
        AND sl.code IS NOT NULL AND sl.code <> ''
        ${levelFilter}
        ${scopeFilter}
        ${historicalFilterSql}
        ${fiscalMonthFilter}
        ${notBoughtFilter}
      GROUP BY COALESCE(sl.group_canon, sl.group_raw, 'Unmapped'), sl.code
    ),
    seg_totals AS (
      SELECT
        segment,
        SUM(prior_net)      AS seg_gap_net,
        COUNT(DISTINCT code) AS seg_gap_count
      FROM aggregated
      GROUP BY segment
    ),
    ranked AS (
      SELECT
        a.*,
        t.seg_gap_net,
        t.seg_gap_count,
        ROW_NUMBER() OVER (PARTITION BY a.segment ORDER BY a.prior_net DESC) AS rnk
      FROM aggregated a
      JOIN seg_totals t ON t.segment = a.segment
    )
    SELECT
      segment,
      code,
      item_name,
      prior_net::text,
      last_fy,
      rnk::text,
      seg_gap_net::text,
      seg_gap_count::text
    FROM ranked
    WHERE rnk <= ${TOP_GAP_CODES}
    ORDER BY seg_gap_net DESC, segment, rnk
  `);

  // ── Step 4: get ever-sold denominator for breadth ─────────────────────────

  const everSoldMap =
    level === "project"
      ? await getEverSoldPerSegmentProject()
      : level === "retailer"
        ? await getEverSoldPerSegment()
        : await getEverSoldPerSegmentTerritory();

  // ── Step 5: assemble output ───────────────────────────────────────────────

  // Group gap result by segment
  type SegGapAcc = {
    gapNet: number;
    gapCodeCount: number;
    topGapCodes: GapCode[];
  };
  const segGap = new Map<string, SegGapAcc>();

  for (const r of gapResult.rows) {
    const existing = segGap.get(r.segment);
    const code: GapCode = {
      code: r.code,
      itemName: r.item_name,
      priorNet: parseFloat(r.prior_net) || 0,
      lastFy: r.last_fy,
    };
    if (existing) {
      existing.topGapCodes.push(code);
    } else {
      segGap.set(r.segment, {
        gapNet: parseFloat(r.seg_gap_net) || 0,
        gapCodeCount: parseInt(r.seg_gap_count, 10) || 0,
        topGapCodes: [code],
      });
    }
  }

  // Build sorted recommendation list
  const recommendations: SegmentRecommendation[] = [];

  for (const [segment, gap] of segGap) {
    if (gap.gapNet <= 0) continue;
    const boughtInfo = segStats.get(segment);
    const codesBought = boughtInfo?.bought.size ?? 0;
    const codesEverSold = everSoldMap.get(segment) ?? Math.max(codesBought, gap.gapCodeCount + codesBought);
    const breadthPct = codesEverSold > 0 ? (codesBought / codesEverSold) * 100 : 0;

    recommendations.push({
      rank: 0, // filled after sort
      segment,
      gapNet: gap.gapNet,
      gapCodeCount: gap.gapCodeCount,
      codesBought,
      codesEverSold,
      breadthPct,
      topGapCodes: gap.topGapCodes,
    });
  }

  // Sort by gapNet descending, assign ranks
  recommendations.sort((a, b) => b.gapNet - a.gapNet);
  recommendations.forEach((r, i) => { r.rank = i + 1; });

  const totalGapNet = recommendations.reduce((s, r) => s + r.gapNet, 0);

  return { recommendations, fiscalMonths, totalGapNet };
}
