/**
 * SKU facts service — Phase K1.
 *
 * Serves item-code level ordering facts for three channels:
 *   distributor   — sale_line_current (type_raw null or not 'direct')
 *   direct_dealer — sale_line_current (type_raw ilike '%direct%')
 *   retailer      — secondary_sku_line (closed years only; NOT_AVAILABLE for
 *                   FY2026-27 until register is loaded)
 *
 * Segment comes from COALESCE(sl.group_canon, sl.group_raw) on sale_line, or
 * from segment_canon on secondary_sku_line. It NEVER comes from type_raw.
 *
 * NET = amount (sale_line) or net_amount (secondary_sku_line) = Sub Total.
 * Order Total is never used.
 *
 * Breadth figures carry their denominator: codesEverSold per segment = distinct
 * codes transacted across ALL loaded FYs in that segment.  This is always ≥
 * codesBought for any period sub-query, so breadthPct is always in [0, 100].
 * item_master is carried as a secondary reference (codesInCatalogue) only.
 * Bare counts are never returned.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getCatalogueCounts, getEverSoldPerSegment, canonGroupFromMap } from "./catalogue.js";
import { logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SkuLevel = "distributor" | "direct_dealer" | "retailer";
export type SkuScope = "company" | "head" | "customer";

export type SkuCapabilityEntry = {
  available: boolean;
  reason?: string;
  /** Indicative row count for the FY (present when available=true). */
  rowCount?: number;
};

export type SkuCapability = {
  distributor: SkuCapabilityEntry;
  direct_dealer: SkuCapabilityEntry;
  retailer: SkuCapabilityEntry;
};

export type SkuCodeFact = {
  code: string;
  segment: string;
  itemName: string | null;
  qty: number;
  net: number;
  /** Share of total net for the requested scope (0–1). */
  netShare: number;
  /** month_label → net */
  monthDistribution: Record<string, number>;
};

export type SkuSegmentFact = {
  segment: string;
  qty: number;
  net: number;
  /** Share of total net for the requested scope (0–1). */
  netShare: number;
  codesBought: number;
  /**
   * Distinct codes ever transacted in this segment across ALL loaded fiscal years.
   * This is the breadth denominator.  Always >= codesBought, so breadthPct is
   * always in [0, 100] — no segment can divide by zero.
   */
  codesEverSold: number;
  /**
   * codesBought / codesEverSold × 100.  Always in [0, 100].
   */
  breadthPct: number;
  /**
   * Codes in item_master (mrp > 0) for this segment — secondary reference only.
   * May be less than codesEverSold (item_master is an incomplete catalogue
   * snapshot for most segments).  0 for segments not in item_group_map.json.
   */
  codesInCatalogue: number;
};

export type SkuFactsResult = {
  capability: SkuCapability;
  /** null when level is not available for the selected FY. */
  facts: {
    bySegment: SkuSegmentFact[];
    /** Top codes by net (up to 500; see truncated flag). */
    byCode: SkuCodeFact[];
    /** Whether byCode was capped at 500. */
    truncated: boolean;
    unmapped: {
      codeCount: number;
      value: number;
      valueShare: number;
    };
    summary: {
      totalCodes: number;
      totalQty: number;
      totalNet: number;
      segmentsBought: number;
    };
  } | null;
};

// ── Capability detection ──────────────────────────────────────────────────────

export async function getSkuCapability(fy: string): Promise<SkuCapability> {
  // Primary channel (distributor + direct_dealer): sale_line_current
  const primaryRows = await db.execute<{ cnt: string }>(sql`
    SELECT COUNT(*)::text AS cnt
    FROM sale_line_current
    WHERE fy = ${fy} AND version_status = 'current'
  `).catch(() => null);

  const totalPrimary = primaryRows ? parseInt(primaryRows.rows[0]?.cnt ?? "0", 10) : 0;

  // Distributor-specific count
  const distRows = await db.execute<{ cnt: string }>(sql`
    SELECT COUNT(*)::text AS cnt
    FROM sale_line_current
    WHERE fy = ${fy} AND version_status = 'current'
      AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')
  `).catch(() => null);
  const distCount = distRows ? parseInt(distRows.rows[0]?.cnt ?? "0", 10) : 0;

  // Direct dealer count
  const ddRows = await db.execute<{ cnt: string }>(sql`
    SELECT COUNT(*)::text AS cnt
    FROM sale_line_current
    WHERE fy = ${fy} AND version_status = 'current'
      AND type_raw ILIKE '%direct%'
  `).catch(() => null);
  const ddCount = ddRows ? parseInt(ddRows.rows[0]?.cnt ?? "0", 10) : 0;

  // Retailer (secondary_sku_line)
  const secRows = await db.execute<{ cnt: string }>(sql`
    SELECT COUNT(*)::text AS cnt
    FROM secondary_sku_line
    WHERE fy = ${fy}
  `).catch(() => null);
  const secCount = secRows ? parseInt(secRows.rows[0]?.cnt ?? "0", 10) : 0;

  return {
    distributor: distCount > 0
      ? { available: true, rowCount: distCount }
      : { available: false, reason: `no distributor data in sale_line for FY${fy}` },
    direct_dealer: ddCount > 0
      ? { available: true, rowCount: ddCount }
      : { available: false, reason: `no direct-dealer data in sale_line for FY${fy}` },
    retailer: secCount > 0
      ? { available: true, rowCount: secCount }
      : {
          available: false,
          reason: `no FY${fy} secondary register is loaded`,
        },
  };
}

// ── Primary facts (distributor / direct_dealer from sale_line) ────────────────

type PrimaryFactParams = {
  fy: string;
  monthLabels: string[];
  level: "distributor" | "direct_dealer";
  scope: SkuScope;
  scopeId?: string;
  segment?: string; // optional segment filter
};

export async function getPrimarySkuFacts(
  params: PrimaryFactParams,
): Promise<SkuFactsResult["facts"]> {
  const { fy, monthLabels, level, scope, scopeId, segment } = params;

  const levelFilter = level === "direct_dealer"
    ? sql`AND sl.type_raw ILIKE '%direct%'`
    : sql`AND (sl.type_raw IS NULL OR sl.type_raw NOT ILIKE '%direct%')`;

  const scopeFilter =
    scope === "customer" && scopeId
      ? sql`AND sl.customer = ${scopeId}`
      : scope === "head" && scopeId
        ? sql`AND sl.head_canon = ${scopeId}`
        : sql``;

  const segmentFilter = segment
    ? sql`AND COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') = ${segment}`
    : sql``;

  const rows = await db.execute<{
    code: string;
    segment_canon: string;
    item_name: string | null;
    month_label: string;
    qty: string;
    net: string;
  }>(sql`
    SELECT
      sl.code,
      COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment_canon,
      im.item_name,
      sl.month_label,
      SUM(sl.qty::numeric)::text    AS qty,
      SUM(sl.amount::numeric)::text AS net
    FROM sale_line_current sl
    LEFT JOIN item_master im ON im.code = sl.code
    WHERE sl.fy = ${fy}
      AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
      AND sl.version_status = 'current'
      ${levelFilter}
      ${scopeFilter}
      ${segmentFilter}
    GROUP BY sl.code, COALESCE(sl.group_canon, sl.group_raw, 'Unmapped'), im.item_name, sl.month_label
    ORDER BY COALESCE(sl.group_canon, sl.group_raw, 'Unmapped'), sl.code, sl.month_label
  `);

  return buildFactsFromRows(rows.rows, fy);
}

// ── Secondary facts (retailer from secondary_sku_line) ────────────────────────

type SecondaryFactParams = {
  fy: string;
  monthLabels: string[];
  scope: SkuScope;
  scopeId?: string;
  segment?: string;
};

export async function getSecondarySkuFacts(
  params: SecondaryFactParams,
): Promise<SkuFactsResult["facts"]> {
  const { fy, monthLabels, scope, scopeId, segment } = params;

  const scopeFilter =
    scope === "customer" && scopeId
      ? sql`AND sku.retailer = ${scopeId}`
      : scope === "head" && scopeId
        ? sql`AND sku.head_canon = ${scopeId}`
        : sql``;

  const segmentFilter = segment
    ? sql`AND sku.segment_canon = ${segment}`
    : sql``;

  const rows = await db.execute<{
    code: string;
    segment_canon: string;
    item_name: string | null;
    month_label: string;
    qty: string;
    net: string;
  }>(sql`
    SELECT
      sku.item_code                                    AS code,
      COALESCE(sku.segment_canon, 'Unmapped')          AS segment_canon,
      im.item_name,
      sku.month_label,
      SUM(sku.qty::numeric)::text                      AS qty,
      SUM(sku.net_amount::numeric)::text               AS net
    FROM secondary_sku_line sku
    LEFT JOIN item_master im ON im.code = sku.item_code
    WHERE sku.fy = ${fy}
      AND sku.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
      ${scopeFilter}
      ${segmentFilter}
    GROUP BY sku.item_code, COALESCE(sku.segment_canon, 'Unmapped'), im.item_name, sku.month_label
    ORDER BY COALESCE(sku.segment_canon, 'Unmapped'), sku.item_code, sku.month_label
  `);

  return buildFactsFromRows(rows.rows, fy);
}

// ── Shared aggregation ────────────────────────────────────────────────────────

type RawRow = {
  code: string;
  segment_canon: string;
  item_name: string | null;
  month_label: string;
  qty: string;
  net: string;
};

async function buildFactsFromRows(
  rows: RawRow[],
  _fy: string,
): Promise<SkuFactsResult["facts"]> {
  if (rows.length === 0) return null;

  // Fetch both denominators in parallel:
  //   everSold   — primary breadth denominator (cross-FY distinct codes in sale_line)
  //   catalogue  — secondary reference (item_master codes with mrp > 0)
  const [everSold, catalogue] = await Promise.all([
    getEverSoldPerSegment(),
    getCatalogueCounts(),
  ]);

  // Aggregate per-code (across months)
  type CodeAcc = {
    segment: string;
    itemName: string | null;
    qty: number;
    net: number;
    months: Record<string, number>;
  };
  const codeMap = new Map<string, CodeAcc>();

  for (const row of rows) {
    const qty = parseFloat(row.qty) || 0;
    const net = parseFloat(row.net) || 0;
    const existing = codeMap.get(row.code);
    if (existing) {
      existing.qty += qty;
      existing.net += net;
      existing.months[row.month_label] = (existing.months[row.month_label] ?? 0) + net;
    } else {
      codeMap.set(row.code, {
        segment: row.segment_canon,
        itemName: row.item_name,
        qty,
        net,
        months: { [row.month_label]: net },
      });
    }
  }

  const totalNet = Array.from(codeMap.values()).reduce((s, c) => s + c.net, 0);

  // Segment aggregation
  type SegAcc = { qty: number; net: number; codes: Set<string> };
  const segMap = new Map<string, SegAcc>();
  for (const [code, acc] of codeMap) {
    const existing = segMap.get(acc.segment);
    if (existing) {
      existing.qty += acc.qty;
      existing.net += acc.net;
      existing.codes.add(code);
    } else {
      segMap.set(acc.segment, { qty: acc.qty, net: acc.net, codes: new Set([code]) });
    }
  }

  // bySegment — sorted by net descending
  const bySegment: SkuSegmentFact[] = Array.from(segMap.entries())
    .sort(([, a], [, b]) => b.net - a.net)
    .map(([segment, acc]) => {
      // codesEverSold is the denominator: always >= codesBought for the requested
      // period (since codesEverSold spans all FYs/months), so breadthPct ∈ [0,100].
      const codesEverSoldForSeg = everSold.get(segment) ?? acc.codes.size;
      const codesBought = acc.codes.size;
      return {
        segment,
        qty: acc.qty,
        net: acc.net,
        netShare: totalNet > 0 ? acc.net / totalNet : 0,
        codesBought,
        codesEverSold: codesEverSoldForSeg,
        breadthPct: codesEverSoldForSeg > 0 ? (codesBought / codesEverSoldForSeg) * 100 : 0,
        codesInCatalogue: catalogue.bySegment[segment] ?? 0,
      };
    });

  // byCode — top 500 by net descending
  const allCodes: SkuCodeFact[] = Array.from(codeMap.entries())
    .sort(([, a], [, b]) => b.net - a.net)
    .map(([code, acc]) => ({
      code,
      segment: acc.segment,
      itemName: acc.itemName,
      qty: acc.qty,
      net: acc.net,
      netShare: totalNet > 0 ? acc.net / totalNet : 0,
      monthDistribution: acc.months,
    }));

  const MAX_CODES = 500;
  const byCode = allCodes.slice(0, MAX_CODES);
  const truncated = allCodes.length > MAX_CODES;

  // Unmapped bucket
  const unmappedSeg = segMap.get("Unmapped");
  const unmappedValue = unmappedSeg?.net ?? 0;
  const unmappedCodes = unmappedSeg?.codes.size ?? 0;

  return {
    bySegment,
    byCode,
    truncated,
    unmapped: {
      codeCount: unmappedCodes,
      value: unmappedValue,
      valueShare: totalNet > 0 ? unmappedValue / totalNet : 0,
    },
    summary: {
      totalCodes: codeMap.size,
      totalQty: Array.from(codeMap.values()).reduce((s, c) => s + c.qty, 0),
      totalNet,
      segmentsBought: segMap.size,
    },
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export type SkuFactsParams = {
  fy: string;
  level: SkuLevel;
  scope: SkuScope;
  scopeId?: string;
  monthLabels: string[];
  segment?: string;
};

export async function loadSkuFacts(
  params: SkuFactsParams,
): Promise<SkuFactsResult> {
  const { fy, level, scope, scopeId, monthLabels, segment } = params;

  const capability = await getSkuCapability(fy);

  const cap = capability[level];
  if (!cap.available) {
    logger.info({ fy, level, reason: cap.reason }, "sku: level not available");
    return { capability, facts: null };
  }

  let facts: SkuFactsResult["facts"];
  if (level === "retailer") {
    facts = await getSecondarySkuFacts({ fy, monthLabels, scope, scopeId, segment });
  } else {
    facts = await getPrimarySkuFacts({ fy, monthLabels, level, scope, scopeId, segment });
  }

  // Log unmapped summary
  if (facts?.unmapped.codeCount) {
    logger.info(
      { fy, level, unmappedCodes: facts.unmapped.codeCount, unmappedValue: facts.unmapped.value },
      "sku: unmapped codes present",
    );
  }

  return { capability, facts };
}
