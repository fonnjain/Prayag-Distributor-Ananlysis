/**
 * Catalogue denominator service.
 *
 * Returns the count of distinct item codes per canonical segment group,
 * derived from item_master.item_group via group_map.json.
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

import { db } from "@workspace/db";
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
  /** Canonical segment → number of distinct item codes in item_master. */
  bySegment: Record<string, number>;
  /** Codes whose item_group maps to no canonical group. */
  unmappedCount: number;
  /** Grand total of all codes in item_master (mapped + unmapped). */
  totalCodes: number;
  /** Grand total of codes whose item_group is in a known group. */
  mappedCodes: number;
};

export type CatalogueCompletenessRow = {
  segment: string;
  /** Distinct codes in item_master for this segment (the breadth denominator). */
  codesAvailable: number;
  /** Distinct codes ever transacted in sale_line across all loaded FYs. */
  codesEverSold: number;
  /** codesEverSold - codesAvailable. Negative = item_master is incomplete. */
  shortfall: number;
  /** True when codesAvailable >= codesEverSold. */
  passes: boolean;
  /** 'ok' | 'item_master_incomplete' | 'not_in_item_group_map' | 'not_in_item_master' */
  failReason: string | null;
};

export type CatalogueCompleteness = {
  rows: CatalogueCompletenessRow[];
  /** Segments that appear in sale_line but have no entry in item_group_map.json. */
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

  // Filter to items with mrp > 0 — these are "active catalogue" items
  // available for sale, giving a practical breadth denominator.
  // Items with null/zero MRP are typically discontinued or internal.
  const rows = await db.execute<{ item_group: string | null; cnt: string }>(sql`
    SELECT item_group, COUNT(*)::text AS cnt
    FROM item_master
    WHERE mrp IS NOT NULL AND mrp > 0
    GROUP BY item_group
  `);

  const bySegment: Record<string, number> = {};
  let unmappedCount = 0;
  let totalCodes = 0;
  let mappedCodes = 0;

  for (const row of rows.rows) {
    const count = parseInt(row.cnt, 10);
    totalCodes += count;
    const canon = canonItemGroup(row.item_group);
    if (canon) {
      bySegment[canon] = (bySegment[canon] ?? 0) + count;
      mappedCodes += count;
    } else {
      unmappedCount += count;
    }
  }

  _cache = { bySegment, unmappedCount, totalCodes, mappedCodes };
  _cacheBuiltAt = Date.now();
  return _cache;
}

/** Clear the catalogue cache (call after item_master updates). */
export function clearCatalogueCache(): void {
  _cache = null;
  _cacheBuiltAt = 0;
}

// ── Ever-sold denominator ─────────────────────────────────────────────────────
//
// This is the breadth denominator for SKU facts.
// codesEverSold[segment] = COUNT(DISTINCT code) in sale_line across ALL loaded
// fiscal years.  It is always >= codesBought for any period sub-query, so
// breadthPct is always in [0, 100].  Never derived from item_master.

let _everSoldCache: Map<string, number> | null = null;
let _everSoldCacheBuiltAt = 0;

export async function getEverSoldPerSegment(): Promise<Map<string, number>> {
  if (_everSoldCache && Date.now() - _everSoldCacheBuiltAt < CACHE_TTL_MS) {
    return _everSoldCache;
  }

  const rows = await db.execute<{ segment: string; cnt: string }>(sql`
    SELECT
      COALESCE(group_canon, group_raw, 'Unmapped') AS segment,
      COUNT(DISTINCT code)::text                   AS cnt
    FROM sale_line
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

/** Invalidate both caches together (call after item_master or sale_line bulk updates). */
export function clearSkuCaches(): void {
  _cache = null;
  _cacheBuiltAt = 0;
  _everSoldCache = null;
  _everSoldCacheBuiltAt = 0;
}

// ── Never-sold catalogue reference ───────────────────────────────────────────
//
// Codes that exist in item_master (mrp > 0) but have never appeared in any
// sale_line row.  These are genuine catalogue items with no transaction history.
// Returned as a secondary reference — NOT used as a breadth denominator.

export type NeverSoldSegmentSummary = {
  segment: string;
  /** item_group values in this segment that have never-sold codes. */
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
    SELECT im.item_group, COUNT(DISTINCT im.code)::text AS cnt
    FROM item_master im
    LEFT JOIN (
      SELECT DISTINCT code FROM sale_line WHERE version_status = 'current'
    ) sold ON sold.code = im.code
    WHERE im.mrp IS NOT NULL AND im.mrp > 0
      AND sold.code IS NULL
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
    const rawGroup = r.item_group ?? "(null)";
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

// ── Catalogue completeness assertion ─────────────────────────────────────────

/**
 * Asserts per segment that codesAvailable >= distinct codes ever sold in that
 * segment across all loaded fiscal years.
 *
 * Failure taxonomy:
 *   not_in_item_group_map — segment appears in sale_line but has no entry in
 *                           item_group_map.json, so codesAvailable = 0 always.
 *   not_in_item_master    — segment is declared in item_group_map.json but its
 *                           constituent item_groups produce 0 rows in item_master
 *                           (e.g. WATER TANK).
 *   item_master_incomplete — segment is partially present in item_master but
 *                            item_master has fewer codes than were transacted.
 */
export async function getCatalogueCompleteness(): Promise<CatalogueCompleteness> {
  const [cat, soldRows] = await Promise.all([
    getCatalogueCounts(),
    db.execute<{ segment: string; distinct_codes: string }>(sql`
      SELECT
        COALESCE(group_canon, group_raw, 'Unmapped') AS segment,
        COUNT(DISTINCT code)::text                    AS distinct_codes
      FROM sale_line
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

  // Union of all segment names seen in either catalogue or sale_line
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
        failReason = "not_in_item_group_map";
        unmappedSegments.push(seg);
      } else if (codesAvailable === 0) {
        failReason = "not_in_item_master";
      } else {
        failReason = "item_master_incomplete";
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
    FROM sale_line
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
