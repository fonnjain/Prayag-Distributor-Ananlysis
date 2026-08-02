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
import {
  getCatalogueCounts,
  getEverSoldPerSegment,
  getEverSoldPerSegmentTerritory,
  getEverSoldPerSegmentProject,
  PROJECT_HEAD_CANON,
  canonGroupFromMap,
} from "./catalogue.js";
import { logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SkuLevel = "distributor" | "direct_dealer" | "retailer" | "project";
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
  project: SkuCapabilityEntry;
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
  /**
   * Bottom-up historical net of codes NOT bought in the query period.
   * Computed as: SUM(amount) from sale_line_current where code is not in the
   * bought-codes set for this query, applying the same level/scope filters,
   * across all loaded fiscal years.
   *
   * This is a factual figure (realised value), not a projection.  The
   * assumption is labelled on the API response and the UI column.
   */
  unboughtValue: number;
};

export type SkuFactsResult = {
  capability: SkuCapability;
  /**
   * Present only for level='retailer' + scope='head': how the state head was
   * expanded to register member names, incl. PS-code vocabulary mismatches.
   */
  headResolution?: SecondaryHeadResolution | null;
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

  // Project / Govt channel
  const projRows = await db.execute<{ cnt: string }>(sql`
    SELECT COUNT(*)::text AS cnt
    FROM sale_line_current
    WHERE fy = ${fy} AND version_status = 'current'
      AND head_canon = ${PROJECT_HEAD_CANON}
  `).catch(() => null);
  const projCount = projRows ? parseInt(projRows.rows[0]?.cnt ?? "0", 10) : 0;

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
    project: projCount > 0
      ? { available: true, rowCount: projCount }
      : { available: false, reason: `no project/govt data in sale_line for FY${fy}` },
  };
}

// ── Primary facts (distributor / direct_dealer from sale_line) ────────────────

type PrimaryFactParams = {
  fy: string;
  monthLabels: string[];
  level: "distributor" | "direct_dealer" | "project";
  scope: SkuScope;
  scopeId?: string;
  segment?: string; // optional segment filter
};

export async function getPrimarySkuFacts(
  params: PrimaryFactParams,
): Promise<SkuFactsResult["facts"]> {
  const { fy, monthLabels, level, scope, scopeId, segment } = params;

  // Level filter — three cases:
  //   project      → only Non-territory / Project / Govt head_canon
  //   direct_dealer → type_raw ILIKE '%direct%', excluding project head
  //   distributor   → type_raw null-or-not-direct, excluding project head
  //
  // Project entities (HDPE PIPE type, project head_canon) are completely
  // excluded from territory channels so their historical volumes don't
  // inflate territory gap figures.
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

  // Fetch the level-appropriate ever-sold denominator so territory breadth
  // figures are not inflated by project-only codes, and vice versa.
  const everSoldMap =
    level === "project"
      ? await getEverSoldPerSegmentProject()
      : await getEverSoldPerSegmentTerritory();

  const facts = await buildFactsFromRows(rows.rows, fy, everSoldMap);
  if (!facts) return facts;

  // Enrich each segment with the bottom-up historical net of codes that were
  // NOT ordered in the query period, restricted to the SAME fiscal months
  // across all loaded FYs (e.g. Apr/May/Jun for a Q1 query).
  // This keeps the time-window comparable: Q1 gap codes vs Q1 prior-year sales.
  // No extrapolation — purely factual realised figures.
  const boughtCodes = [...new Set(rows.rows.map((r) => r.code))];
  if (boughtCodes.length === 0) return facts;

  // Extract fiscal-month prefixes ("Apr", "May", "Jun") from the label list.
  const fiscalMonths = [...new Set(monthLabels.map((m) => m.split("-")[0]))];
  const fiscalMonthFilter = sql`AND split_part(sl.month_label, '-', 1) = ANY(ARRAY[${sql.join(fiscalMonths.map((m) => sql`${m}`), sql`, `)}])`;

  const unboughtRows = await db.execute<{
    segment: string;
    unbought_value: string;
  }>(sql`
    SELECT
      COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
      SUM(sl.amount::numeric)::text AS unbought_value
    FROM sale_line_current sl
    WHERE sl.version_status = 'current'
      ${levelFilter}
      ${scopeFilter}
      ${segmentFilter}
      ${fiscalMonthFilter}
      AND sl.code != ALL(ARRAY[${sql.join(boughtCodes.map((c) => sql`${c}`), sql`, `)}])
    GROUP BY 1
  `);

  const unboughtBySegment = new Map<string, number>(
    unboughtRows.rows.map((r) => [r.segment, parseFloat(r.unbought_value) || 0]),
  );

  return {
    ...facts,
    bySegment: facts.bySegment.map((seg) => ({
      ...seg,
      unboughtValue: unboughtBySegment.get(seg.segment) ?? 0,
    })),
  };
}

// ── Secondary facts (retailer from secondary_sku_line) ────────────────────────

type SecondaryFactParams = {
  fy: string;
  monthLabels: string[];
  scope: SkuScope;
  scopeId?: string;
  segment?: string;
  /**
   * Pre-resolved member head_canon keys for scope='head'.  The secondary
   * register's head_canon column holds MEMBER (salesperson) names, not state
   * heads, so a state-head scope must be expanded to the member list first
   * (see resolveHeadForSecondary).
   */
  headKeys?: string[];
};

// ── State-head → member resolution for the secondary register ────────────────
//
// secondary_sku_line.head_canon stores the register's salesperson name,
// lowercased with collapsed whitespace (see skuLoader normKey).  A state head
// like "Syed Aqil Rizvi" never appears there directly.  We resolve the head to
// their roster members (State Head Dashboard Data tab) and match member names
// against the distinct head_canon vocabulary for the FY.  The register uses a
// separate PS-code name vocabulary, so not every member is expected to match —
// the counts are surfaced so the mismatch is visible, never silent.

import memberNameAliasRaw from "../../../config/member_name_alias.json" with { type: "json" };
const MEMBER_NAME_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(memberNameAliasRaw as Record<string, string>).filter(
    ([k]) => !k.startsWith("_"),
  ),
);

export type SecondaryHeadResolution = {
  head: string;
  /** Members on the head's roster for the FY. */
  membersTotal: number;
  /** Members whose name matched a head_canon present in the register. */
  membersMatched: number;
  /** Matched register head_canon keys (used as the filter). */
  matchedKeys: string[];
  /** Roster members with no register match (PS-code vocabulary mismatch). */
  unmatchedMembers: string[];
};

/** Register-side normalisation: lowercase + collapse whitespace. */
function secRegKey(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Strip parenthetical suffixes: "Ravi (Rudrapur)" → "ravi". */
function secRegKeyBare(raw: string): string {
  return secRegKey(raw.replace(/\(.*?\)/g, " "));
}

export async function resolveHeadForSecondary(
  fy: string,
  head: string,
): Promise<SecondaryHeadResolution | null> {
  // Lazy import: deepDiveData lives in lib/mgmt and pulls the Sheets stack;
  // only load it when a head-scoped retailer query actually needs the roster.
  const { loadDeepDiveData } = await import("../mgmt/deepDiveData.js");
  const dd = await loadDeepDiveData(fy, head, undefined, { skipExtras: true });
  const members = (dd.members ?? []).filter((m) => m.stateHead === head);
  if (members.length === 0) return null;

  const vocabRows = await db.execute<{ hc: string }>(sql`
    SELECT DISTINCT head_canon AS hc
    FROM secondary_sku_line
    WHERE fy = ${fy} AND head_canon IS NOT NULL
  `);
  const vocab = new Map<string, string>(); // exact key → head_canon
  const vocabBare = new Map<string, string>(); // parenthetical-stripped key → head_canon
  for (const r of vocabRows.rows) {
    vocab.set(secRegKey(r.hc), r.hc);
    const bare = secRegKeyBare(r.hc);
    if (!vocabBare.has(bare)) vocabBare.set(bare, r.hc);
  }

  const matchedKeys = new Set<string>();
  const unmatchedMembers: string[] = [];
  for (const m of members) {
    const exact = vocab.get(secRegKey(m.name));
    const bare = exact ?? vocabBare.get(secRegKeyBare(m.name));
    // Known register misspellings (e.g. "Sonawane" written "Sanwane") come
    // from config — same person, different spelling, never two entries.
    const aliased =
      bare ??
      (() => {
        const alias = MEMBER_NAME_ALIAS[secRegKey(m.name)];
        return alias ? vocab.get(secRegKey(alias)) : undefined;
      })();
    if (aliased) matchedKeys.add(aliased);
    else unmatchedMembers.push(m.name);
  }

  return {
    head,
    membersTotal: members.length,
    membersMatched: members.length - unmatchedMembers.length,
    matchedKeys: [...matchedKeys],
    unmatchedMembers,
  };
}

export async function getSecondarySkuFacts(
  params: SecondaryFactParams,
): Promise<SkuFactsResult["facts"]> {
  const { fy, monthLabels, scope, scopeId, segment, headKeys } = params;

  const scopeFilter =
    scope === "customer" && scopeId
      ? sql`AND sku.retailer = ${scopeId}`
      : scope === "head" && headKeys && headKeys.length > 0
        ? sql`AND sku.head_canon = ANY(ARRAY[${sql.join(headKeys.map((k) => sql`${k}`), sql`, `)}])`
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

  const facts = await buildFactsFromRows(rows.rows, fy);
  if (!facts) return facts;

  // Same bottom-up unbought enrichment as primary: same fiscal months only,
  // across all loaded FYs, so the period window is like-for-like.
  const boughtCodes = [...new Set(rows.rows.map((r) => r.code))];
  if (boughtCodes.length === 0) return facts;

  const fiscalMonths = [...new Set(monthLabels.map((m) => m.split("-")[0]))];
  const fiscalMonthFilter = sql`AND split_part(sku.month_label, '-', 1) = ANY(ARRAY[${sql.join(fiscalMonths.map((m) => sql`${m}`), sql`, `)}])`;

  const unboughtRows = await db.execute<{
    segment: string;
    unbought_value: string;
  }>(sql`
    SELECT
      COALESCE(sku.segment_canon, 'Unmapped') AS segment,
      SUM(sku.net_amount::numeric)::text AS unbought_value
    FROM secondary_sku_line sku
    WHERE 1=1
      ${scopeFilter}
      ${segmentFilter}
      ${fiscalMonthFilter}
      AND sku.item_code != ALL(ARRAY[${sql.join(boughtCodes.map((c) => sql`${c}`), sql`, `)}])
    GROUP BY 1
  `);

  const unboughtBySegment = new Map<string, number>(
    unboughtRows.rows.map((r) => [r.segment, parseFloat(r.unbought_value) || 0]),
  );

  return {
    ...facts,
    bySegment: facts.bySegment.map((seg) => ({
      ...seg,
      unboughtValue: unboughtBySegment.get(seg.segment) ?? 0,
    })),
  };
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
  everSoldOverride?: Map<string, number>,
): Promise<SkuFactsResult["facts"]> {
  if (rows.length === 0) return null;

  // Fetch both denominators in parallel:
  //   everSold   — primary breadth denominator; caller may override to a
  //                level-filtered map (territory-only or project-only) so
  //                codes exclusive to one channel don't distort another.
  //   catalogue  — secondary reference (item_master codes with mrp > 0)
  const [everSoldDefault, catalogue] = await Promise.all([
    everSoldOverride ? Promise.resolve(null) : getEverSoldPerSegment(),
    getCatalogueCounts(),
  ]);
  const everSold = everSoldOverride ?? everSoldDefault!;

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
        // Populated by the caller (getPrimarySkuFacts / getSecondarySkuFacts) via
        // a second query.  Initialised to 0 here so the shape is always complete.
        unboughtValue: 0,
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

// ── SKU Trend (K4) ────────────────────────────────────────────────────────────
//
// Aggregate breadth metrics across all loaded FYs at two granularities:
//   monthly  — one row per (fy, month_label, segment): codesBought + net
//   fyTotals — one row per (fy, segment): distinct codes bought in full FY + net
//
// The denominator for breadthPct is always everSold[segment] (cross-FY global),
// so it is stable and independent of the requested FY range.

const FM_IDX: Record<string, number> = {
  Apr: 1, May: 2, Jun: 3, Jul: 4, Aug: 5, Sep: 6,
  Oct: 7, Nov: 8, Dec: 9, Jan: 10, Feb: 11, Mar: 12,
};

function monthLabelToFiscalIdx(ml: string): number {
  return FM_IDX[ml.slice(0, 3)] ?? 0;
}

export type SkuTrendMonthRow = {
  fy: string;
  fyMonth: string;
  monthIdx: number;
  segment: string;
  codesBought: number;
  net: number;
};

export type SkuTrendFyRow = {
  fy: string;
  segment: string;
  codesBought: number;
  net: number;
};

export type SkuTrendResult = {
  level: string;
  fys: string[];
  fyMonths: string[];
  everSold: Record<string, number>;
  monthly: SkuTrendMonthRow[];
  fyTotals: SkuTrendFyRow[];
  fyNetTotals: Record<string, number>;
};

export type SkuTrendParams = {
  level: SkuLevel;
  scope: SkuScope;
  scopeId?: string;
  segment?: string;
};

export async function getSkuTrend(params: SkuTrendParams): Promise<SkuTrendResult> {
  const { level, scope, scopeId, segment } = params;

  type RawTrendRow = {
    fy: string; month_label: string; segment: string;
    codes_bought: string; net: string;
  };
  type RawFyRow = {
    fy: string; segment: string; codes_bought: string; net: string;
  };

  let monthly: SkuTrendMonthRow[];
  let fyTotalsRaw: RawFyRow[];

  if (level === "retailer") {
    const scopeFilter =
      scope === "customer" && scopeId ? sql`AND sku.retailer = ${scopeId}`
      : scope === "head" && scopeId    ? sql`AND sku.head_canon = ${scopeId}`
      : sql``;
    const segFilter = segment
      ? sql`AND COALESCE(sku.segment_canon, 'Unmapped') = ${segment}`
      : sql``;

    const [mRes, fyRes] = await Promise.all([
      db.execute<RawTrendRow>(sql`
        SELECT
          sku.fy,
          sku.month_label,
          COALESCE(sku.segment_canon, 'Unmapped') AS segment,
          COUNT(DISTINCT sku.item_code)::text      AS codes_bought,
          SUM(sku.net_amount::numeric)::text       AS net
        FROM secondary_sku_line sku
        WHERE sku.item_code IS NOT NULL AND sku.item_code <> ''
          ${scopeFilter} ${segFilter}
        GROUP BY sku.fy, sku.month_label, COALESCE(sku.segment_canon, 'Unmapped')
        ORDER BY sku.fy, sku.month_label
      `),
      db.execute<RawFyRow>(sql`
        SELECT
          sku.fy,
          COALESCE(sku.segment_canon, 'Unmapped') AS segment,
          COUNT(DISTINCT sku.item_code)::text      AS codes_bought,
          SUM(sku.net_amount::numeric)::text       AS net
        FROM secondary_sku_line sku
        WHERE sku.item_code IS NOT NULL AND sku.item_code <> ''
          ${scopeFilter} ${segFilter}
        GROUP BY sku.fy, COALESCE(sku.segment_canon, 'Unmapped')
        ORDER BY sku.fy
      `),
    ]);

    monthly = mRes.rows.map((r) => ({
      fy: r.fy, fyMonth: r.month_label, monthIdx: monthLabelToFiscalIdx(r.month_label),
      segment: r.segment, codesBought: parseInt(r.codes_bought, 10) || 0,
      net: parseFloat(r.net) || 0,
    }));
    fyTotalsRaw = fyRes.rows;
  } else {
    const trendProjectHead = sql`AND (sl.head_canon IS NULL OR sl.head_canon != ${PROJECT_HEAD_CANON})`;
    const levelFilter =
      level === "project"
        ? sql`AND sl.head_canon = ${PROJECT_HEAD_CANON}`
        : level === "direct_dealer"
          ? sql`AND sl.type_raw ILIKE '%direct%' ${trendProjectHead}`
          : sql`AND (sl.type_raw IS NULL OR sl.type_raw NOT ILIKE '%direct%') ${trendProjectHead}`;
    const scopeFilter =
      scope === "customer" && scopeId ? sql`AND sl.customer = ${scopeId}`
      : scope === "head" && scopeId    ? sql`AND sl.head_canon = ${scopeId}`
      : sql``;
    const segFilter = segment
      ? sql`AND COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') = ${segment}`
      : sql``;

    const [mRes, fyRes] = await Promise.all([
      db.execute<RawTrendRow>(sql`
        SELECT
          sl.fy,
          sl.month_label,
          COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
          COUNT(DISTINCT sl.code)::text                       AS codes_bought,
          SUM(sl.amount::numeric)::text                       AS net
        FROM sale_line_current sl
        WHERE sl.version_status = 'current'
          AND sl.code IS NOT NULL AND sl.code <> ''
          ${levelFilter} ${scopeFilter} ${segFilter}
        GROUP BY sl.fy, sl.month_label,
                 COALESCE(sl.group_canon, sl.group_raw, 'Unmapped')
        ORDER BY sl.fy, sl.month_label
      `),
      db.execute<RawFyRow>(sql`
        SELECT
          sl.fy,
          COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
          COUNT(DISTINCT sl.code)::text                       AS codes_bought,
          SUM(sl.amount::numeric)::text                       AS net
        FROM sale_line_current sl
        WHERE sl.version_status = 'current'
          AND sl.code IS NOT NULL AND sl.code <> ''
          ${levelFilter} ${scopeFilter} ${segFilter}
        GROUP BY sl.fy, COALESCE(sl.group_canon, sl.group_raw, 'Unmapped')
        ORDER BY sl.fy
      `),
    ]);

    monthly = mRes.rows.map((r) => ({
      fy: r.fy, fyMonth: r.month_label, monthIdx: monthLabelToFiscalIdx(r.month_label),
      segment: r.segment, codesBought: parseInt(r.codes_bought, 10) || 0,
      net: parseFloat(r.net) || 0,
    }));
    fyTotalsRaw = fyRes.rows;
  }

  // Sort monthly chronologically: by FY start year, then fiscal month index.
  monthly.sort((a, b) => {
    const fyA = parseInt(a.fy.split("-")[0], 10);
    const fyB = parseInt(b.fy.split("-")[0], 10);
    if (fyA !== fyB) return fyA - fyB;
    return a.monthIdx - b.monthIdx;
  });

  // Ordered unique FY list
  const fySet = new Set<string>();
  for (const r of monthly) fySet.add(r.fy);
  const fys = [...fySet].sort((a, b) =>
    parseInt(a.split("-")[0], 10) - parseInt(b.split("-")[0], 10),
  );

  // Ordered unique fyMonths (already in chronological order after sort above)
  const seenFyMonths = new Set<string>();
  const fyMonths: string[] = [];
  for (const r of monthly) {
    if (!seenFyMonths.has(r.fyMonth)) {
      seenFyMonths.add(r.fyMonth);
      fyMonths.push(r.fyMonth);
    }
  }

  // fyTotals
  const fyTotals: SkuTrendFyRow[] = fyTotalsRaw.map((r) => ({
    fy: r.fy, segment: r.segment,
    codesBought: parseInt(r.codes_bought, 10) || 0,
    net: parseFloat(r.net) || 0,
  }));

  // fyNetTotals: total net per FY across all segments
  const fyNetTotals: Record<string, number> = {};
  for (const r of fyTotals) {
    fyNetTotals[r.fy] = (fyNetTotals[r.fy] ?? 0) + r.net;
  }

  // everSold denominator
  const everSoldMap = await getEverSoldPerSegment();
  const everSold: Record<string, number> = {};
  for (const [seg, cnt] of everSoldMap) everSold[seg] = cnt;

  return { level, fys, fyMonths, everSold, monthly, fyTotals, fyNetTotals };
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
  let headResolution: SecondaryHeadResolution | null = null;
  if (level === "retailer") {
    let headKeys: string[] | undefined;
    if (scope === "head" && scopeId) {
      headResolution = await resolveHeadForSecondary(fy, scopeId).catch((err) => {
        logger.warn({ err, fy, scopeId }, "sku: head→member resolution failed");
        return null;
      });
      if (headResolution) headKeys = headResolution.matchedKeys;
    }
    facts = await getSecondarySkuFacts({ fy, monthLabels, scope, scopeId, segment, headKeys });
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

  return { capability, facts, headResolution };
}
