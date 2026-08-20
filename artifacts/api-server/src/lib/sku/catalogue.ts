/**
 * Catalogue denominator service.
 *
 * Returns the count of distinct current authoritative product codes per
 * canonical segment group. The active prayag-price cache owns code existence;
 * item_master.item_group is optional local taxonomy enrichment only.
 *
 * This is the denominator for every breadth figure:
 *   breadth % = codes_bought / codes_available × 100
 *
 * Codes whose item_group maps to no group are counted in an 'Unmapped' bucket.
 * They are NEVER dropped — the total must always account for the full catalogue.
 *
 * Spec counts (verified 29 July 2026):
 *   CP (Chrome-Plated) 903 | PTMT / Faucets 829 | CPVC 217 | Sanitaryware 206
 *   AGRI 169 | Connection / Waste 95 | Garden Pipe 63 | WATER TANK 33 | CISTERN 21
 *   Total mapped 2,536
 */

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
// Two separate mappings — kept distinct to avoid confusion:
//
//   item_group_map.json  — ERP taxonomy (item_master.item_group) → canonical segment.
//                          Used for the catalogue denominator.
//
//   group_map.json       — Secondary register Segment column values → canonical segment.
//                          Used by the secondary SKU loader (skuLoader.ts).
//
// They happen to share canonical group names but draw from completely different
// source vocabularies — never merge or confuse the two.

import itemGroupMapRaw from "../../../config/item_group_map.json" with { type: "json" };
import secGroupMapRaw  from "../../../config/group_map.json" with { type: "json" };
import { UNMAPPED_TAXONOMY } from "./catalogueAuthority.js";

type GroupMapJson = { [key: string]: string[] | string };
const ITEM_GROUP_MAP = itemGroupMapRaw as GroupMapJson;
const SEC_GROUP_MAP  = secGroupMapRaw  as Record<string, string[]>;

// ── item_master group lookup (catalogue denominator) ─────────────────────────

// Pre-build: UPPERCASE ERP item_group → canonical segment.
const ITEM_GROUP_ALIAS_TO_CANON = new Map<string, string>();
for (const [canon, aliasesOrComment] of Object.entries(ITEM_GROUP_MAP)) {
  if (canon.startsWith("_")) continue; // skip _comment etc.
  const aliases = aliasesOrComment as string[];
  for (const alias of aliases) {
    if (typeof alias === "string") {
      ITEM_GROUP_ALIAS_TO_CANON.set(alias.trim().toUpperCase(), canon);
    }
  }
}

/**
 * Canonicalise an item_master.item_group value via item_group_map.json.
 * Returns canonical group name, or null if unmapped.
 */
export function canonItemGroup(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return ITEM_GROUP_ALIAS_TO_CANON.get(raw.trim().toUpperCase()) ?? null;
}

export type TaxonomyGroupOption = {
  itemGroup: string;
  canonicalSegment: string;
};

const TAXONOMY_GROUP_OPTIONS: TaxonomyGroupOption[] = Array.from(
  ITEM_GROUP_ALIAS_TO_CANON.entries(),
  ([itemGroup, canonicalSegment]) => ({ itemGroup, canonicalSegment }),
).sort(
  (a, b) =>
    a.canonicalSegment.localeCompare(b.canonicalSegment) ||
    a.itemGroup.localeCompare(b.itemGroup),
);

/** Local overrides take precedence over upload-derived taxonomy only. */
export function resolveLocalTaxonomy(
  overrideItemGroup: string | null | undefined,
  uploadedItemGroup: string | null | undefined,
): string | null {
  return overrideItemGroup?.trim() || uploadedItemGroup?.trim() || null;
}

export function getTaxonomyGroupOptions(): TaxonomyGroupOption[] {
  return TAXONOMY_GROUP_OPTIONS;
}

// ── Secondary register segment lookup (for skuLoader) ────────────────────────

// Pre-build: UPPERCASE secondary-register Segment value → canonical segment.
const SEC_ALIAS_TO_CANON = new Map<string, string>();
for (const [canon, aliases] of Object.entries(SEC_GROUP_MAP)) {
  for (const alias of aliases) {
    SEC_ALIAS_TO_CANON.set(alias.trim().toUpperCase(), canon);
  }
}

/**
 * Canonicalise a secondary-register Segment value via group_map.json.
 * Used by the secondary SKU loader — NOT for item_master.
 * Returns canonical group name, or null if unmapped.
 */
export function canonGroupFromMap(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return SEC_ALIAS_TO_CANON.get(raw.trim().toUpperCase()) ?? null;
}

// ── Catalogue denominator ─────────────────────────────────────────────────────

export type CatalogueCounts = {
  /** Canonical segment → authoritative current codes with local taxonomy. */
  bySegment: Record<string, number>;
  /** Authoritative codes whose optional local taxonomy maps to no segment. */
  unmappedCount: number;
  /** Grand total of all current authoritative source codes. */
  totalCodes: number;
  /** Authoritative codes whose optional local taxonomy maps to a known group. */
  mappedCodes: number;
  /** Authoritative product codes that currently have no positive source MRP. */
  unpricedCount: number;
};

export type CatalogueCompletenessRow = {
  segment: string;
  /** Authoritative current codes with optional local taxonomy in this segment. */
  codesAvailable: number;
  /** Distinct codes ever transacted in sale_line_all across all loaded FYs. */
  codesEverSold: number;
  /** codesEverSold - codesAvailable. Negative = authority coverage is incomplete. */
  shortfall: number;
  /** True when codesAvailable >= codesEverSold. */
  passes: boolean;
  /** 'ok' | 'authority_incomplete' | 'not_in_local_taxonomy' | 'no_authority_codes' */
  failReason: string | null;
};

export type CatalogueCompleteness = {
  rows: CatalogueCompletenessRow[];
  /** Segments that appear in sale_line_all but have no entry in item_group_map.json. */
  unmappedSegments: string[];
  passing: number;
  failing: number;
  /** Summary: total shortfall codes across all failing segments. */
  totalShortfall: number;
};

/** Canonical segments declared in item_group_map.json (keys excluding _comment). */
const DECLARED_SEGMENTS = new Set(
  Object.keys(ITEM_GROUP_MAP).filter((k) => !k.startsWith("_")),
);

let _cache: CatalogueCounts | null = null;
let _cacheBuiltAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getCatalogueCounts(): Promise<CatalogueCounts> {
  if (_cache && Date.now() - _cacheBuiltAt < CACHE_TTL_MS) return _cache;

  // The source cache defines present-day code existence. Keep the local group
  // join non-filtering so an authority-only code remains visible as Unmapped.
  const rows = await db.execute<{
    item_group: string | null;
    cnt: string;
    unpriced_cnt: string;
  }>(sql`
    SELECT COALESCE(sto.item_group, im.item_group) AS item_group,
           COUNT(DISTINCT s.item_code)::text AS cnt,
           COUNT(DISTINCT s.item_code) FILTER (
             WHERE s.mrp IS NULL OR s.mrp <= 0
           )::text AS unpriced_cnt
    FROM mrp_synced s
    JOIN mrp_sync_generation g
      ON g.generation_id = s.generation_id
     AND g.is_active = TRUE
    LEFT JOIN item_master im ON im.code = s.item_code
    LEFT JOIN sku_taxonomy_override sto ON sto.code = s.item_code
    GROUP BY COALESCE(sto.item_group, im.item_group)
  `);

  const bySegment: Record<string, number> = {};
  let unmappedCount = 0;
  let totalCodes = 0;
  let mappedCodes = 0;
  let unpricedCount = 0;

  for (const row of rows.rows) {
    const count = parseInt(row.cnt, 10);
    totalCodes += count;
    unpricedCount += parseInt(row.unpriced_cnt, 10);
    const canon = canonItemGroup(row.item_group);
    if (canon) {
      bySegment[canon] = (bySegment[canon] ?? 0) + count;
      mappedCodes += count;
    } else {
      unmappedCount += count;
    }
  }

  _cache = { bySegment, unmappedCount, totalCodes, mappedCodes, unpricedCount };
  _cacheBuiltAt = Date.now();
  return _cache;
}

/** Clear the catalogue cache (call after source sync or local taxonomy updates). */
export function clearCatalogueCache(): void {
  _cache = null;
  _cacheBuiltAt = 0;
}

// ── Ever-sold denominator ─────────────────────────────────────────────────────
//
// This is the breadth denominator for SKU facts.
// codesEverSold[segment] = COUNT(DISTINCT code) in sale_line_all across ALL loaded
// fiscal years.  It is always >= codesBought for any period sub-query, so
// breadthPct is always in [0, 100].  Never derived from item_master.

// ── Canonical value for the project/govt head_canon ──────────────────────────

export const PROJECT_HEAD_CANON = "Non-territory / Project / Govt";

// ── Three ever-sold maps (global / territory-only / project-only) ─────────────
//
// "Global"    — all channels combined; used by the retailer (secondary) path
//               and by catalogue completeness checks.
// "Territory" — excludes PROJECT_HEAD_CANON rows; used when level is
//               distributor or direct_dealer so project-only codes don't
//               inflate the territory breadth denominator.
// "Project"   — only PROJECT_HEAD_CANON rows; used when level = "project".

let _everSoldCache: Map<string, number> | null = null;
let _everSoldCacheBuiltAt = 0;

let _everSoldTerritoryCache: Map<string, number> | null = null;
let _everSoldTerritoryCacheBuiltAt = 0;

let _everSoldProjectCache: Map<string, number> | null = null;
let _everSoldProjectCacheBuiltAt = 0;

export async function getEverSoldPerSegment(): Promise<Map<string, number>> {
  if (_everSoldCache && Date.now() - _everSoldCacheBuiltAt < CACHE_TTL_MS) {
    return _everSoldCache;
  }

  const rows = await db.execute<{ segment: string; cnt: string }>(sql`
    SELECT
      COALESCE(group_canon, group_raw, 'Unmapped') AS segment,
      COUNT(DISTINCT code)::text                   AS cnt
    FROM sale_line_all
    WHERE version_status = 'current'
      AND code IS NOT NULL AND code <> ''
    GROUP BY 1
  `);

  const map = new Map<string, number>();
  for (const r of rows.rows) {
    map.set(r.segment, parseInt(r.cnt, 10));
  }

  _everSoldCache = map;
  _everSoldCacheBuiltAt = Date.now();
  return map;
}

/**
 * Ever-sold denominator for territory channels (distributor / direct_dealer).
 * Excludes codes that were ONLY ever sold to Project / Govt entities, so
 * project-only SKUs don't appear as territory breadth gaps.
 */
export async function getEverSoldPerSegmentTerritory(): Promise<Map<string, number>> {
  if (_everSoldTerritoryCache && Date.now() - _everSoldTerritoryCacheBuiltAt < CACHE_TTL_MS) {
    return _everSoldTerritoryCache;
  }

  const rows = await db.execute<{ segment: string; cnt: string }>(sql`
    SELECT
      COALESCE(group_canon, group_raw, 'Unmapped') AS segment,
      COUNT(DISTINCT code)::text                   AS cnt
    FROM sale_line_all
    WHERE version_status = 'current'
      AND code IS NOT NULL AND code <> ''
      AND (head_canon IS NULL OR head_canon != ${PROJECT_HEAD_CANON})
    GROUP BY 1
  `);

  const map = new Map<string, number>();
  for (const r of rows.rows) {
    map.set(r.segment, parseInt(r.cnt, 10));
  }

  _everSoldTerritoryCache = map;
  _everSoldTerritoryCacheBuiltAt = Date.now();
  return map;
}

/**
 * Ever-sold denominator for the project channel.
 * Counts only codes transacted by Project / Govt entities.
 */
export async function getEverSoldPerSegmentProject(): Promise<Map<string, number>> {
  if (_everSoldProjectCache && Date.now() - _everSoldProjectCacheBuiltAt < CACHE_TTL_MS) {
    return _everSoldProjectCache;
  }

  const rows = await db.execute<{ segment: string; cnt: string }>(sql`
    SELECT
      COALESCE(group_canon, group_raw, 'Unmapped') AS segment,
      COUNT(DISTINCT code)::text                   AS cnt
    FROM sale_line_all
    WHERE version_status = 'current'
      AND code IS NOT NULL AND code <> ''
      AND head_canon = ${PROJECT_HEAD_CANON}
    GROUP BY 1
  `);

  const map = new Map<string, number>();
  for (const r of rows.rows) {
    map.set(r.segment, parseInt(r.cnt, 10));
  }

  _everSoldProjectCache = map;
  _everSoldProjectCacheBuiltAt = Date.now();
  return map;
}

/** Invalidate all ever-sold and catalogue caches (call after source sync, sale load, or taxonomy updates). */
export function clearSkuCaches(): void {
  _cache = null;
  _cacheBuiltAt = 0;
  _everSoldCache = null;
  _everSoldCacheBuiltAt = 0;
  _everSoldTerritoryCache = null;
  _everSoldTerritoryCacheBuiltAt = 0;
  _everSoldProjectCache = null;
  _everSoldProjectCacheBuiltAt = 0;
}

// ── item_master gap disclosure ────────────────────────────────────────────────
//
// Codes that transacted in a given FY but have no matching authoritative
// current product. Local `item_master` coverage is intentionally not part of
// this decision; it is metadata only.
//
// Segment is taken from sale_line_all (group_canon / group_raw) — NOT from
// item_master, because item_master is precisely what is incomplete here.

export type ItemMasterGapSegment = {
  segment: string;
  /** Codes in sale_line_all for this segment whose authoritative source MRP is unavailable. */
  unpricedCodes: number;
  /** Codes in sale_line_all for this segment absent from the authority cache. */
  notInMasterCodes: number;
  totalCodes: number;
  totalLines: number;
  /** Sum of sale_line_all.amount for gap codes in this segment (Rs). */
  totalValueRs: number;
};

export type ItemMasterGap = {
  fy: string;
  /**
   * Codes present in the authority cache but whose source MRP is null or zero.
   */
  unpriced: { distinctCodes: number; lines: number; valueRs: number };
  /** Codes absent from the active authority cache. */
  notInMaster: { distinctCodes: number; lines: number; valueRs: number };
  /** Combined total (unpriced + notInMaster). */
  total: { distinctCodes: number; lines: number; valueRs: number };
  /** Breakdown by segment from sale_line_all (group_canon / group_raw), sorted by value desc. */
  bySegment: ItemMasterGapSegment[];
};

export async function getItemMasterGapForFy(fy?: string): Promise<ItemMasterGap> {
  // Resolve FY: use provided value or derive the latest FY present in sale_line_all.
  let resolvedFy: string;
  if (fy) {
    resolvedFy = fy;
  } else {
    const fyRow = await db.execute<{ max_fy: string | null }>(sql`
      SELECT MAX(fy) AS max_fy FROM sale_line_all WHERE version_status = 'current'
    `);
    resolvedFy = fyRow.rows[0]?.max_fy ?? "2026-27";
  }

  // Two queries in parallel:
  //   (1) True distinct-code totals by authority gap kind.
  //   (2) Per-segment breakdown — for attribution.
  //       Note: a code that appears under two group_canon values in different
  //       invoices will be counted in both segments, so per-segment code counts
  //       do not sum to the top-level distinct total.  The top-level total from
  //       query (1) is the authoritative figure.

  const [totalsRes, segRes] = await Promise.all([
    db.execute<{
      gap_kind: string;
      distinct_codes: string;
      line_rows: string;
      total_value: string;
    }>(sql`
      SELECT
        CASE WHEN s.item_code IS NULL THEN 'not_in_authority' ELSE 'unpriced' END AS gap_kind,
        COUNT(DISTINCT sl.code)::text                                       AS distinct_codes,
        COUNT(*)::text                                                      AS line_rows,
        COALESCE(SUM(sl.amount), 0)::text                                  AS total_value
      FROM sale_line_all sl
       LEFT JOIN mrp_synced s
         ON s.item_code = sl.code
        AND s.generation_id = (
          SELECT generation_id FROM mrp_sync_generation WHERE is_active = TRUE LIMIT 1
        )
      WHERE sl.version_status = 'current'
        AND sl.fy = ${resolvedFy}
         AND (s.item_code IS NULL OR s.mrp IS NULL OR s.mrp <= 0)
      GROUP BY 1
    `),
    db.execute<{
      segment: string;
      gap_kind: string;
      distinct_codes: string;
      line_rows: string;
      total_value: string;
    }>(sql`
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        CASE WHEN s.item_code IS NULL THEN 'not_in_authority' ELSE 'unpriced' END AS gap_kind,
        COUNT(DISTINCT sl.code)::text                                       AS distinct_codes,
        COUNT(*)::text                                                      AS line_rows,
        COALESCE(SUM(sl.amount), 0)::text                                  AS total_value
      FROM sale_line_all sl
       LEFT JOIN mrp_synced s
         ON s.item_code = sl.code
        AND s.generation_id = (
          SELECT generation_id FROM mrp_sync_generation WHERE is_active = TRUE LIMIT 1
        )
      WHERE sl.version_status = 'current'
        AND sl.fy = ${resolvedFy}
         AND (s.item_code IS NULL OR s.mrp IS NULL OR s.mrp <= 0)
      GROUP BY 1, 2
      ORDER BY SUM(sl.amount) DESC, 1, 2
    `),
  ]);

  // Build headline totals
  let unpricedCodes = 0, unpricedLines = 0, unpricedValue = 0;
  let notInMasterCodes = 0, notInMasterLines = 0, notInMasterValue = 0;
  for (const r of totalsRes.rows) {
    const codes = parseInt(r.distinct_codes, 10);
    const lines = parseInt(r.line_rows, 10);
    const value = parseFloat(r.total_value);
    if (r.gap_kind === "not_in_authority") {
      notInMasterCodes = codes;
      notInMasterLines = lines;
      notInMasterValue = value;
    } else {
      unpricedCodes = codes;
      unpricedLines = lines;
      unpricedValue = value;
    }
  }

  // Build per-segment map (merge both gap_kinds per segment)
  type SegAcc = {
    unpricedCodes: number;
    notInMasterCodes: number;
    totalLines: number;
    totalValueRs: number;
  };
  const segMap = new Map<string, SegAcc>();
  for (const r of segRes.rows) {
    const codes = parseInt(r.distinct_codes, 10);
    const lines = parseInt(r.line_rows, 10);
    const value = parseFloat(r.total_value);
    const acc = segMap.get(r.segment) ?? {
      unpricedCodes: 0,
      notInMasterCodes: 0,
      totalLines: 0,
      totalValueRs: 0,
    };
    acc.totalLines += lines;
    acc.totalValueRs += value;
    if (r.gap_kind === "not_in_authority") {
      acc.notInMasterCodes += codes;
    } else {
      acc.unpricedCodes += codes;
    }
    segMap.set(r.segment, acc);
  }

  const bySegment: ItemMasterGapSegment[] = Array.from(segMap.entries())
    .map(([segment, acc]) => ({
      segment,
      unpricedCodes: acc.unpricedCodes,
      notInMasterCodes: acc.notInMasterCodes,
      totalCodes: acc.unpricedCodes + acc.notInMasterCodes,
      totalLines: acc.totalLines,
      totalValueRs: acc.totalValueRs,
    }))
    .sort((a, b) => b.totalValueRs - a.totalValueRs);

  return {
    fy: resolvedFy,
    unpriced: {
      distinctCodes: unpricedCodes,
      lines: unpricedLines,
      valueRs: unpricedValue,
    },
    notInMaster: {
      distinctCodes: notInMasterCodes,
      lines: notInMasterLines,
      valueRs: notInMasterValue,
    },
    total: {
      distinctCodes: unpricedCodes + notInMasterCodes,
      lines: unpricedLines + notInMasterLines,
      valueRs: unpricedValue + notInMasterValue,
    },
    bySegment,
  };
}

// ── Never-sold catalogue reference ───────────────────────────────────────────
//
// Current authoritative codes that have never appeared in sale_line_all.
// Local item groups are presentation metadata only and must not filter a code
// out of this list.

export type NeverSoldSegmentSummary = {
  segment: string;
  /** Optional local item_group values in this segment that have never-sold codes. */
  itemGroups: string[];
  /** Total never-sold codes in this segment. */
  count: number;
};

export async function getNeverSoldCatalogueItems(): Promise<{
  bySegment: NeverSoldSegmentSummary[];
  unmapped: { itemGroup: string; count: number }[];
  total: number;
}> {
  const rows = await db.execute<{ item_group: string | null; cnt: string }>(sql`
    SELECT COALESCE(sto.item_group, im.item_group) AS item_group,
           COUNT(DISTINCT s.item_code)::text AS cnt
    FROM mrp_synced s
    JOIN mrp_sync_generation g
      ON g.generation_id = s.generation_id
     AND g.is_active = TRUE
    LEFT JOIN item_master im ON im.code = s.item_code
    LEFT JOIN sku_taxonomy_override sto ON sto.code = s.item_code
    LEFT JOIN (
      SELECT DISTINCT code FROM sale_line_all WHERE version_status = 'current'
    ) sold ON sold.code = s.item_code
    WHERE sold.code IS NULL
    GROUP BY 1
    ORDER BY 2::int DESC
  `);

  type SegAcc = { itemGroups: string[]; count: number };
  const segMap = new Map<string, SegAcc>();
  const unmapped: { itemGroup: string; count: number }[] = [];
  let total = 0;

  for (const r of rows.rows) {
    const count = parseInt(r.cnt, 10);
    total += count;
    const canon = canonItemGroup(r.item_group);
    const rawGroup = r.item_group ?? UNMAPPED_TAXONOMY;
    if (canon) {
      const acc = segMap.get(canon);
      if (acc) {
        acc.itemGroups.push(rawGroup);
        acc.count += count;
      } else {
        segMap.set(canon, { itemGroups: [rawGroup], count });
      }
    } else {
      unmapped.push({ itemGroup: rawGroup, count });
    }
  }

  const bySegment: NeverSoldSegmentSummary[] = Array.from(segMap.entries())
    .map(([segment, acc]) => ({ segment, itemGroups: acc.itemGroups, count: acc.count }))
    .sort((a, b) => b.count - a.count);

  return { bySegment, unmapped, total };
}

// ── Catalogue-owner taxonomy review queue ────────────────────────────────────

export type TaxonomyReviewQueueItem = {
  code: string;
  productName: string | null;
  currentMrp: number | null;
  uploadedItemGroup: string | null;
  sourceDivisions: string[];
  saleSegments: string[];
  usage: {
    saleLineCount: number;
    customerCount: number;
    fiscalYearCount: number;
    totalNet: number;
    latestSaleDate: string | null;
  };
};

export type TaxonomyMappingAudit = {
  id: number;
  code: string;
  previousItemGroup: string | null;
  previousSegment: string | null;
  itemGroup: string;
  canonicalSegment: string;
  mappedByUserId: number | null;
  mappedBy: string;
  note: string | null;
  mappedAt: string;
};

/**
 * Lists every active authoritative code still without a recognised local
 * taxonomy group. It intentionally includes zero-usage products: current
 * source catalogue coverage is the review population, while usage is evidence
 * to help owners prioritise decisions.
 */
export async function getTaxonomyReviewQueue(): Promise<TaxonomyReviewQueueItem[]> {
  const rows = await db.execute<{
    code: string;
    product_name: string | null;
    current_mrp: string | null;
    uploaded_item_group: string | null;
    effective_item_group: string | null;
    source_divisions: string[] | null;
    sale_segments: string[] | null;
    sale_line_count: string;
    customer_count: string;
    fiscal_year_count: string;
    total_net: string;
    latest_sale_date: string | null;
  }>(sql`
    WITH active_catalogue AS (
      SELECT
        s.item_code AS code,
        MAX(s.product_name) AS product_name,
        MAX(s.mrp)::text AS current_mrp,
        MAX(im.item_group) AS uploaded_item_group,
        MAX(sto.item_group) AS override_item_group,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT d.source_division), NULL) AS source_divisions
      FROM mrp_synced s
      JOIN mrp_sync_generation g
        ON g.generation_id = s.generation_id
       AND g.is_active = TRUE
      LEFT JOIN mrp_synced_division d
        ON d.generation_id = s.generation_id
       AND d.item_code = s.item_code
      LEFT JOIN item_master im ON im.code = s.item_code
      LEFT JOIN sku_taxonomy_override sto ON sto.code = s.item_code
      GROUP BY s.item_code
    ),
    usage AS (
      SELECT
        sl.code,
        ARRAY_REMOVE(
          ARRAY_AGG(DISTINCT COALESCE(sl.group_canon, sl.group_raw, 'Unmapped')),
          NULL
        ) AS sale_segments,
        COUNT(*)::text AS sale_line_count,
        COUNT(DISTINCT NULLIF(sl.customer, ''))::text AS customer_count,
        COUNT(DISTINCT sl.fy)::text AS fiscal_year_count,
        COALESCE(SUM(sl.amount::numeric), 0)::text AS total_net,
        MAX(sl.invoice_date)::text AS latest_sale_date
      FROM sale_line_current sl
      WHERE sl.code IS NOT NULL AND sl.code <> ''
      GROUP BY sl.code
    )
    SELECT
      c.code,
      c.product_name,
      c.current_mrp,
      c.uploaded_item_group,
      COALESCE(c.override_item_group, c.uploaded_item_group) AS effective_item_group,
      c.source_divisions,
      u.sale_segments,
      COALESCE(u.sale_line_count, '0') AS sale_line_count,
      COALESCE(u.customer_count, '0') AS customer_count,
      COALESCE(u.fiscal_year_count, '0') AS fiscal_year_count,
      COALESCE(u.total_net, '0') AS total_net,
      u.latest_sale_date
    FROM active_catalogue c
    LEFT JOIN usage u ON u.code = c.code
    ORDER BY c.code
  `);

  return rows.rows
    .filter((row) => !canonItemGroup(row.effective_item_group))
    .map((row) => ({
      code: row.code,
      productName: row.product_name,
      currentMrp: row.current_mrp == null ? null : Number(row.current_mrp),
      uploadedItemGroup: row.uploaded_item_group,
      sourceDivisions: row.source_divisions ?? [],
      saleSegments: row.sale_segments ?? [],
      usage: {
        saleLineCount: Number(row.sale_line_count),
        customerCount: Number(row.customer_count),
        fiscalYearCount: Number(row.fiscal_year_count),
        totalNet: Number(row.total_net),
        latestSaleDate: row.latest_sale_date,
      },
    }));
}

export async function getRecentTaxonomyMappings(limit = 100): Promise<TaxonomyMappingAudit[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = await db.execute<{
    id: string;
    code: string;
    previous_item_group: string | null;
    previous_segment: string | null;
    item_group: string;
    canonical_segment: string;
    mapped_by_user_id: string | null;
    mapped_by: string;
    note: string | null;
    mapped_at: string;
  }>(sql`
    SELECT id::text, code, previous_item_group, previous_segment,
           item_group, canonical_segment, mapped_by_user_id::text, mapped_by,
           note, mapped_at::text
    FROM sku_taxonomy_override_audit
    ORDER BY mapped_at DESC, id DESC
    LIMIT ${safeLimit}
  `);
  return rows.rows.map((row) => ({
    id: Number(row.id),
    code: row.code,
    previousItemGroup: row.previous_item_group,
    previousSegment: row.previous_segment,
    itemGroup: row.item_group,
    canonicalSegment: row.canonical_segment,
    mappedByUserId: row.mapped_by_user_id == null ? null : Number(row.mapped_by_user_id),
    mappedBy: row.mapped_by,
    note: row.note,
    mappedAt: row.mapped_at,
  }));
}

export async function recordTaxonomyMapping(input: {
  code: string;
  itemGroup: string;
  mappedByUserId: number;
  mappedBy: string;
  note?: string | null;
}): Promise<TaxonomyMappingAudit> {
  const code = input.code.trim();
  const itemGroup = input.itemGroup.trim();
  const mappedByUserId = input.mappedByUserId;
  const mappedBy = input.mappedBy.trim();
  const note = input.note?.trim() || null;
  const canonicalSegment = canonItemGroup(itemGroup);

  if (!code) throw new Error("SKU code is required.");
  if (!canonicalSegment) throw new Error("Choose a recognised local item group.");
  if (!Number.isSafeInteger(mappedByUserId) || mappedByUserId < 1) {
    throw new Error("Authenticated administrator identity is required.");
  }
  if (!mappedBy) throw new Error("Reviewer name is required.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize all remaps for one code, including the first insert where a
    // row-level lock does not exist yet. The audit's previous_* values then
    // always describe the mapping this transaction actually replaced.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [code]);
    // Lock the active generation while validating this code. A source cutover
    // cannot switch the active generation between validation and this commit.
    const generation = await client.query<{ generation_id: string }>(
      `SELECT generation_id
       FROM mrp_sync_generation
       WHERE is_active = TRUE
       FOR UPDATE`,
    );
    const generationId = generation.rows[0]?.generation_id;
    if (!generationId) {
      throw new Error("There is no active authoritative catalogue.");
    }
    const active = await client.query(
      `SELECT 1 FROM mrp_synced
       WHERE generation_id = $1
         AND item_code = $2
       LIMIT 1`,
      [generationId, code],
    );
    if (!active.rowCount) {
      await client.query("ROLLBACK");
      throw new Error("This code is not in the active authoritative catalogue.");
    }

    const prior = await client.query(
      `SELECT item_group, canonical_segment
       FROM sku_taxonomy_override
       WHERE code = $1
       FOR UPDATE`,
      [code],
    );
    const previousItemGroup = prior.rows[0]?.item_group ?? null;
    const previousSegment = prior.rows[0]?.canonical_segment ?? null;

    await client.query(
      `INSERT INTO sku_taxonomy_override
         (code, item_group, canonical_segment, mapped_by_user_id, mapped_by, note, mapped_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (code) DO UPDATE
       SET item_group = EXCLUDED.item_group,
           canonical_segment = EXCLUDED.canonical_segment,
           mapped_by_user_id = EXCLUDED.mapped_by_user_id,
           mapped_by = EXCLUDED.mapped_by,
           note = EXCLUDED.note,
           mapped_at = EXCLUDED.mapped_at`,
      [code, itemGroup, canonicalSegment, mappedByUserId, mappedBy, note],
    );
    const audit = await client.query(
      `INSERT INTO sku_taxonomy_override_audit
         (code, previous_item_group, previous_segment, item_group,
          canonical_segment, mapped_by_user_id, mapped_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id::text, code, previous_item_group, previous_segment,
                 item_group, canonical_segment, mapped_by_user_id::text,
                 mapped_by, note, mapped_at::text`,
      [code, previousItemGroup, previousSegment, itemGroup, canonicalSegment, mappedByUserId, mappedBy, note],
    );
    await client.query("COMMIT");
    clearCatalogueCache();

    const row = audit.rows[0]!;
    return {
      id: Number(row.id),
      code: row.code,
      previousItemGroup: row.previous_item_group,
      previousSegment: row.previous_segment,
      itemGroup: row.item_group,
      canonicalSegment: row.canonical_segment,
      mappedByUserId: row.mapped_by_user_id == null ? null : Number(row.mapped_by_user_id),
      mappedBy: row.mapped_by,
      note: row.note,
      mappedAt: row.mapped_at,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ── Catalogue completeness assertion ─────────────────────────────────────────

/**
 * Asserts per segment that codesAvailable >= distinct codes ever sold in that
 * segment across all loaded fiscal years.
 *
 * Failure taxonomy:
 *   not_in_local_taxonomy — a sale segment has no local taxonomy declaration.
 *   no_authority_codes    — no active authoritative source code has local
 *                           taxonomy for the segment.
 *   authority_incomplete  — authoritative source coverage is below the
 *                           historical register's distinct-code footprint.
 */
export async function getCatalogueCompleteness(): Promise<CatalogueCompleteness> {
  const [cat, soldRows] = await Promise.all([
    getCatalogueCounts(),
    db.execute<{ segment: string; distinct_codes: string }>(sql`
      SELECT
        COALESCE(group_canon, group_raw, 'Unmapped') AS segment,
        COUNT(DISTINCT code)::text                    AS distinct_codes
      FROM sale_line_all
      WHERE version_status = 'current'
        AND code IS NOT NULL AND code <> ''
      GROUP BY 1
    `),
  ]);

  // Build ever-sold map from query
  const everSold = new Map<string, number>();
  for (const row of soldRows.rows) {
    everSold.set(row.segment, parseInt(row.distinct_codes, 10));
  }

  // Union of all segment names seen in either catalogue or sale_line_all
  const allSegments = new Set([
    ...Object.keys(cat.bySegment),
    ...everSold.keys(),
  ]);
  // Drop the synthetic 'Unmapped' bucket — it's not a product segment
  allSegments.delete("Unmapped");

  const rows: CatalogueCompletenessRow[] = [];
  const unmappedSegments: string[] = [];

  for (const seg of [...allSegments].sort()) {
    const codesAvailable = cat.bySegment[seg] ?? 0;
    const codesEverSold  = everSold.get(seg) ?? 0;
    const shortfall      = codesEverSold - codesAvailable;
    const passes         = codesAvailable >= codesEverSold;

    let failReason: string | null = null;
    if (!passes) {
      if (!DECLARED_SEGMENTS.has(seg)) {
        failReason = "not_in_local_taxonomy";
        unmappedSegments.push(seg);
      } else if (codesAvailable === 0) {
        failReason = "no_authority_codes";
      } else {
        failReason = "authority_incomplete";
      }
    }

    rows.push({ segment: seg, codesAvailable, codesEverSold, shortfall, passes, failReason });
  }

  // Sort: failing first (largest shortfall first), then passing
  rows.sort((a, b) => {
    if (a.passes !== b.passes) return a.passes ? 1 : -1;
    return a.shortfall - b.shortfall; // more negative = worse = first
  });

  const passing      = rows.filter((r) => r.passes).length;
  const failing      = rows.filter((r) => !r.passes).length;
  const totalShortfall = rows
    .filter((r) => !r.passes)
    .reduce((acc, r) => acc + r.shortfall, 0);

  return { rows, unmappedSegments, passing, failing, totalShortfall };
}

// ── Per-FY segment distribution ───────────────────────────────────────────────

export type FySegmentDistributionRow = {
  segment: string;
  mappingStatus: "mapped_via_canon" | "raw_only_no_canon" | "both_null";
  distinctCodes: number;
  lineCount: number;
  totalNet: number;
};

/**
 * Returns the segment distribution for a single FY, explicitly separating
 * mapped rows from those that fell through to group_raw or to Unmapped.
 * Unmapped bucket is always included (even when zero) so callers can assert.
 */
export async function getFySegmentDistribution(
  fy: string,
): Promise<FySegmentDistributionRow[]> {
  const rows = await db.execute<{
    segment: string;
    mapping_status: string;
    distinct_codes: string;
    line_count: string;
    total_net: string;
  }>(sql`
    SELECT
      COALESCE(group_canon, group_raw, 'Unmapped')       AS segment,
      CASE
        WHEN group_canon IS NOT NULL THEN 'mapped_via_canon'
        WHEN group_raw   IS NOT NULL THEN 'raw_only_no_canon'
        ELSE                              'both_null'
      END                                                AS mapping_status,
      COUNT(DISTINCT code)::text                         AS distinct_codes,
      COUNT(*)::text                                     AS line_count,
      COALESCE(SUM(amount), 0)::text                     AS total_net
    FROM sale_line_all
    WHERE version_status = 'current'
      AND fy = ${fy}
    GROUP BY 1, 2
    ORDER BY SUM(amount) DESC NULLS LAST
  `);

  const result: FySegmentDistributionRow[] = rows.rows.map((r) => ({
    segment: r.segment,
    mappingStatus: r.mapping_status as FySegmentDistributionRow["mappingStatus"],
    distinctCodes: parseInt(r.distinct_codes, 10),
    lineCount: parseInt(r.line_count, 10),
    totalNet: parseFloat(r.total_net),
  }));

  // Always ensure an explicit Unmapped row exists (even at zero)
  const hasUnmapped = result.some((r) => r.segment === "Unmapped");
  if (!hasUnmapped) {
    result.push({
      segment: "Unmapped",
      mappingStatus: "both_null",
      distinctCodes: 0,
      lineCount: 0,
      totalNet: 0,
    });
  }

  return result;
}
