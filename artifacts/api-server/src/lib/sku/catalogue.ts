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
