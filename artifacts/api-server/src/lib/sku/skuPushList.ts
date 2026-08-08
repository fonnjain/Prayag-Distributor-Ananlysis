/**
 * SKU Push List — Phase K3b (per-distributor peer-cohort recommendations).
 *
 * For a selected distributor, surfaces gap codes that ≥ MIN_PEERS_PER_CODE
 * peer distributors are CURRENTLY buying but the target is not.
 *
 * Cohort rules (per user spec):
 *  - Cohort size / quintile defined on COHORT_FY (last complete FY, auto-derived).
 *    Using the open FY for cohort membership would be circular.
 *  - Quintile computed within target's state (head_canon).
 *    If state has < MIN_STATE_DISTRIBUTORS, widen to national quintile.
 *  - Project entities (Non-territory / Project / Govt) excluded from cohort.
 *  - Peers = same quintile ± 1 (within state or national), excluding target.
 *
 * Recommendation rules:
 *  - Minimum peers per code: 3 (among segment-active peers).
 *  - Segment filter: per-segment recommendation uses only peers active in
 *    that segment; "active" = ≥ 1 purchase in segment in the query period.
 *  - Suppress segment card if < MIN_PEERS_PER_CODE segment-active peers.
 *  - Suppress entire result if target not in COHORT_FY or cohort size < 3.
 *
 * Card label: "X of Y peers in [state] buy this code and you do not."
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PROJECT_HEAD_CANON } from "./catalogue.js";
import type { SkuLevel } from "./skuFacts.js";

// ── Constants ──────────────────────────────────────────────────────────────────

import { normaliseStateCanon, stateVariants, STATE_CANON_NORMALISE } from "../stateCanon.js";
import { deriveSaleLineCohortFy } from "../fyAnchors.js";

// COHORT_FY (the last complete FY) is derived at runtime from sale_line_current
// ingest stats via deriveSaleLineCohortFy() — newest fully-ingested closed FY,
// with a grace window after FY close and a loud failure if the newly closed FY
// is not ingested in time. Never hardcode it here.
const MIN_STATE_DISTRIBUTORS = 8;
const MIN_PEERS_PER_CODE = 3;
const TOP_CODES_PER_SEGMENT = 10;

/**
 * Explicit normalisation map for sale_line state_canon variants that represent
 * the same geographic state but differ due to sales-management territory splits.
 *
 * Rules:
 *  - Values are the canonical display name used in the UI.
 *  - Keys are the raw state_canon values exactly as they appear in the DB.
 *  - If a raw value is not listed here it normalises to itself (identity).
 *  - "Non-territory / Project / Govt" and pseudo-states (GEM, JJM, HITESH) are
 *    intentionally omitted — they are not geographic states.
 *
 * Dashboard column B (SOBR) uses different names (e.g. "Delhi") from sale_line
 * (e.g. "DELHI A"). Neither is wrong; this map concerns only sale_line values.
 *
 * Confirmed splits as of FY2026-27:
 *   Delhi   — DELHI A (7) + DELHI NCR (3) → 10 combined (crosses tier-1 threshold)
 *   UP      — UTTAR PRADESH (58) + UP ( A ) (9) + UP (AS) (7) + UP (S) (0)
 *   HP      — HIMACHAL PRADESH (12) + HP (0 this FY, legacy FY23-24 only)
 *   Karnataka — KARNATAKA + KARNATAKA (B) (split appeared in FY26-27; 4 combined)
 *
 * Maharashtra 2 does NOT exist in this dataset (single undivided state, 28 dists).
 */
// ── Tier classification ────────────────────────────────────────────────────────

/**
 * Classify a gap code into one of four recommendation tiers (lower = higher priority).
 *
 *  1 Range  — code's ERP item_group is already in the distributor's current-period
 *             purchase set (fill the range within a sub-family).
 *             Only fires when item_master covers both the gap code and ≥1 bought code.
 *  2 Lapsed — distributor bought this exact code in COHORT_FY but not this period.
 *  3 Active — distributor has any purchase in this segment this period.
 *  4 New    — distributor has no purchase in this segment this period.
 */
function rankCode(
  itemGroup: string | null,
  segment: string,
  code: string,
  targetItemGroups: Set<string>,
  targetLostCodes: Set<string>,
  targetActiveSegments: Set<string>,
): { tier: 1 | 2 | 3 | 4; tierLabel: "Range" | "Lapsed" | "Active" | "New" } {
  if (itemGroup && targetItemGroups.has(itemGroup)) return { tier: 1, tierLabel: "Range" };
  if (targetLostCodes.has(code))                    return { tier: 2, tierLabel: "Lapsed" };
  if (targetActiveSegments.has(segment))             return { tier: 3, tierLabel: "Active" };
  return { tier: 4, tierLabel: "New" };
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type DistributorListItem = {
  customer: string;
  headCanon: string | null;
  /** FY2025-26 net (0 if not in cohort FY — new distributor). */
  cohortFyNet: number;
  /** Quintile 1–5 within state (or national if state is small). null if new. */
  quintile: number | null;
  cohortBasis: "state" | "national" | null;
};

export type PushCode = {
  code: string;
  itemName: string | null;
  /** Count of segment-active peers buying this code in the query period. */
  peerCount: number;
  /** Total net of those peers for this code in the query period. */
  peerNet: number;
  lastFy: string;
  /**
   * Four-tier recommendation priority:
   *   1 Range   — code's item_group matches an item_group the distributor already buys
   *   2 Lapsed  — distributor bought this code in COHORT_FY but not this period
   *   3 Active  — distributor is active in this segment this period
   *   4 New     — distributor has no purchases in this segment this period
   */
  tier: 1 | 2 | 3 | 4;
  tierLabel: "Range" | "Lapsed" | "Active" | "New";
};

export type SegmentPushCard = {
  rank: number;
  segment: string;
  /** Total qualifying gap codes (peer_count ≥ threshold). */
  totalGapCodes: number;
  /** Peers active in this segment (denominator for card label). */
  segmentPeerCount: number;
  cohortBasis: "state" | "national";
  topCodes: PushCode[];
};

export type PushListResult = {
  distributorKey: string;
  stateName: string | null;
  quintile: number | null;
  cohortSize: number;
  cohortBasis: "state" | "national";
  suppressed: boolean;
  suppressReason?: string;
  /**
   * True when the target has no COHORT_FY purchase history and the result
   * was computed using state-typical (tiered pool, no quintile) logic.
   * Evidence is weaker than a peer-cohort result.
   */
  isFallback: boolean;
  /**
   * When isFallback=true: which tier resolved the pool.
   *   "state"     — same geographic state (state_canon), ≥ MIN_STATE_DISTRIBUTORS
   *   "territory" — same State Head territory (head_canon), ≥ MIN_PEERS_PER_CODE
   *   "national"  — national pool filtered to active-FY size quintile ±1
   */
  fallbackTier?: "state" | "territory" | "national";
  /** When isFallback=true: human-readable pool scope for display. */
  fallbackScopeName?: string;
  /**
   * Names of the peer distributors backing this list (the cohort/pool the
   * gap evidence comes from). Sorted alphabetically for display.
   */
  peerNames: string[];
  segments: SegmentPushCard[];
  fiscalMonths: string[];
};

// ── Internal cohort types ──────────────────────────────────────────────────────

type DistRow = {
  customer: string;
  headCanon: string | null;
  cohortNet: number;
};

// ── Quintile helper ────────────────────────────────────────────────────────────

/**
 * Assigns quintile 1–5 to `value` within a sorted list of all values in the
 * same group. Quintile 1 = smallest 20%, 5 = largest 20%.
 */
function quintileOf(value: number, allValues: number[]): number {
  const sorted = [...allValues].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 1;
  // Count values strictly less than value (0-indexed position)
  const pos = sorted.filter((v) => v < value).length;
  return Math.min(5, Math.floor((pos / n) * 5) + 1);
}

// ── Level filter builder ───────────────────────────────────────────────────────

function buildLevelFilter(level: SkuLevel) {
  const projectExclusion = sql`AND (sl.head_canon IS NULL OR sl.head_canon != ${PROJECT_HEAD_CANON})`;
  if (level === "project") return sql`AND sl.head_canon = ${PROJECT_HEAD_CANON}`;
  if (level === "direct_dealer")
    return sql`AND sl.type_raw ILIKE '%direct%' ${projectExclusion}`;
  // distributor / retailer: exclude direct + project
  return sql`AND (sl.type_raw IS NULL OR sl.type_raw NOT ILIKE '%direct%') ${projectExclusion}`;
}

// ── Distributor list (for the selector) ───────────────────────────────────────

/**
 * Returns distinct distributors **active in `activeFy`** (≥1 purchase in the
 * selected year), enriched with their COHORT_FY quintile for peer grouping.
 *
 * Inclusion criterion = active in activeFy only.  COHORT_FY is used purely for
 * quintile enrichment; a distributor absent from cohort FY (newly onboarded)
 * gets quintile=null and will be suppressed by the push-list engine.
 *
 * This intentionally excludes dormant distributors (bought in FY25-26 but zero
 * in the selected FY): their push list would have an empty target-bought set and
 * would return every peer code as a "gap", producing a meaningless result.
 */
export async function getDistributorList(
  activeFy: string,
  level: SkuLevel,
): Promise<DistributorListItem[]> {
  const COHORT_FY = await deriveSaleLineCohortFy();
  const levelFilter = buildLevelFilter(level);

  // ── 1. Active distributors: bought ≥1 order in the selected FY ──────────────
  const activeRows = await db.execute<{
    customer: string;
    head_canon: string | null;
  }>(sql`
    SELECT DISTINCT sl.customer, sl.head_canon
    FROM sale_line_current sl
    WHERE sl.fy = ${activeFy}
      AND sl.customer IS NOT NULL AND sl.customer <> ''
      AND sl.code IS NOT NULL
      ${levelFilter}
  `);

  if (activeRows.rows.length === 0) return [];

  const activeCustomers = activeRows.rows.map((r) => r.customer);

  // Build a quick lookup for headCanon from the active query
  const activeHeadCanon = new Map<string, string | null>();
  for (const r of activeRows.rows) {
    activeHeadCanon.set(r.customer, r.head_canon);
  }

  // ── 2. Cohort FY nets — only for active distributors (enrichment only) ───────
  const cohortRows = await db.execute<{
    customer: string;
    fy_net: string;
  }>(sql`
    SELECT
      sl.customer,
      SUM(sl.amount::numeric)::text AS fy_net
    FROM sale_line_current sl
    WHERE sl.fy = ${COHORT_FY}
      AND sl.customer = ANY(ARRAY[${sql.join(activeCustomers.map((c) => sql`${c}`), sql`, `)}])
      AND sl.code IS NOT NULL
      ${levelFilter}
    GROUP BY sl.customer
  `);

  const cohortNetMap = new Map<string, number>();
  for (const r of cohortRows.rows) {
    cohortNetMap.set(r.customer, parseFloat(r.fy_net) || 0);
  }

  // ── 3. Compute quintiles over the cohort-FY nets of active distributors ──────
  // Group by state using headCanon from the active query
  const byState = new Map<string, { customer: string; net: number }[]>();
  for (const customer of activeCustomers) {
    const hc = activeHeadCanon.get(customer) ?? null;
    const key = hc ?? "__unknown__";
    const net = cohortNetMap.get(customer) ?? 0;
    const arr = byState.get(key) ?? [];
    arr.push({ customer, net });
    byState.set(key, arr);
  }

  // National pool = all active distributors that also appear in cohort FY
  const allCohortNets = activeCustomers
    .filter((c) => cohortNetMap.has(c))
    .map((c) => cohortNetMap.get(c)!);

  type QuintileInfo = { quintile: number; cohortBasis: "state" | "national" };
  const quintileMap = new Map<string, QuintileInfo>();

  for (const [, members] of byState) {
    const cohortMembers = members.filter((m) => cohortNetMap.has(m.customer));
    const useNational = cohortMembers.length < MIN_STATE_DISTRIBUTORS;
    const pool = useNational ? allCohortNets : cohortMembers.map((m) => m.net);
    for (const m of cohortMembers) {
      quintileMap.set(m.customer, {
        quintile: quintileOf(m.net, pool),
        cohortBasis: useNational ? "national" : "state",
      });
    }
  }

  // ── 4. Assemble result ───────────────────────────────────────────────────────
  const result: DistributorListItem[] = activeCustomers.map((customer) => {
    const hc = activeHeadCanon.get(customer) ?? null;
    const q = quintileMap.get(customer) ?? null;
    return {
      customer,
      headCanon: hc,
      cohortFyNet: cohortNetMap.get(customer) ?? 0,
      quintile: q?.quintile ?? null,
      cohortBasis: q?.cohortBasis ?? null,
    };
  });

  // Sort by state, then cohortNet descending
  result.sort((a, b) => {
    const sa = a.headCanon ?? "zzz";
    const sb = b.headCanon ?? "zzz";
    if (sa !== sb) return sa.localeCompare(sb);
    return b.cohortFyNet - a.cohortFyNet;
  });

  return result;
}

// ── Main push list function ────────────────────────────────────────────────────

export type PushListParams = {
  fy: string;
  monthLabels: string[];
  level: SkuLevel;
  distributorKey: string;
};

export async function getSkuPushList(
  params: PushListParams,
): Promise<PushListResult> {
  const { fy, monthLabels, level, distributorKey } = params;
  const COHORT_FY = await deriveSaleLineCohortFy();
  const levelFilter = buildLevelFilter(level);

  // ── 1. Build cohort from COHORT_FY ─────────────────────────────────────────

  const cohortRows = await db.execute<{
    customer: string;
    head_canon: string | null;
    fy_net: string;
  }>(sql`
    SELECT
      sl.customer,
      sl.head_canon,
      SUM(sl.amount::numeric)::text AS fy_net
    FROM sale_line_current sl
    WHERE sl.fy = ${COHORT_FY}
      AND sl.customer IS NOT NULL AND sl.customer <> ''
      AND sl.code IS NOT NULL
      ${levelFilter}
    GROUP BY sl.customer, sl.head_canon
  `);

  const allDist: DistRow[] = cohortRows.rows.map((r) => ({
    customer: r.customer,
    headCanon: r.head_canon,
    cohortNet: parseFloat(r.fy_net) || 0,
  }));

  // Find target
  const target = allDist.find((d) => d.customer === distributorKey);
  if (!target) {
    // ── Three-tier state-typical fallback (no COHORT_FY data) ──────────────────
    // Tier 1: Same geographic state (state_canon)     — if ≥ MIN_STATE_DISTRIBUTORS
    // Tier 2: Same State Head territory (head_canon)  — if ≥ MIN_PEERS_PER_CODE
    // Tier 3: National within active-FY size quintile — if ≥ MIN_PEERS_PER_CODE
    // Evidence is weaker than peer-cohort; isFallback=true flags this throughout.

    // ── Discover target's geographic info from the active FY ───────────────────
    // Take the dominant row by net (handles rare cross-state sales cleanly).
    const targetInfoRows = await db.execute<{
      state_canon: string | null;
      head_canon: string | null;
      active_net: string;
    }>(sql`
      SELECT sl.state_canon, sl.head_canon, SUM(sl.amount::numeric)::text AS active_net
      FROM sale_line_current sl
      WHERE sl.fy = ${fy}
        AND sl.customer = ${distributorKey}
        AND sl.code IS NOT NULL
        ${levelFilter}
      GROUP BY sl.state_canon, sl.head_canon
      ORDER BY SUM(sl.amount::numeric) DESC
      LIMIT 1
    `);
    const fbStateCanon = targetInfoRows.rows[0]?.state_canon ?? null;
    const fbHeadCanon  = targetInfoRows.rows[0]?.head_canon  ?? null;
    const fbActiveNet  = parseFloat(targetInfoRows.rows[0]?.active_net ?? "0") || 0;

    // Normalise: collapse split territory variants (DELHI A + DELHI NCR → DELHI, etc.)
    const fbStateNorm    = normaliseStateCanon(fbStateCanon);   // canonical display name
    const fbStateVars    = stateVariants(fbStateCanon);         // all DB variants for SQL

    let poolCustomers: string[] = [];
    let fallbackTier: "state" | "territory" | "national" = "state";
    let fallbackScopeName = fbStateNorm ?? "this state";

    // ── Tier 1: same geographic state (all split variants collapsed) ───────────
    if (fbStateCanon != null) {
      const tier1Rows = await db.execute<{ customer: string }>(sql`
        SELECT DISTINCT sl.customer
        FROM sale_line_current sl
        WHERE sl.fy = ${fy}
          AND sl.customer IS NOT NULL AND sl.customer <> ''
          AND sl.customer <> ${distributorKey}
          AND sl.state_canon = ANY(ARRAY[${sql.join(fbStateVars.map((v) => sql`${v}`), sql`, `)}])
          AND sl.code IS NOT NULL
          ${levelFilter}
      `);
      poolCustomers = tier1Rows.rows.map((r) => r.customer);
    }

    // ── Tier 2: same State Head territory ──────────────────────────────────────
    if (poolCustomers.length < MIN_STATE_DISTRIBUTORS) {
      fallbackTier = "territory";
      fallbackScopeName = fbHeadCanon
        ? `${fbHeadCanon}'s territory`
        : "this territory";

      if (fbHeadCanon != null) {
        const tier2Rows = await db.execute<{ customer: string }>(sql`
          SELECT DISTINCT sl.customer
          FROM sale_line_current sl
          WHERE sl.fy = ${fy}
            AND sl.customer IS NOT NULL AND sl.customer <> ''
            AND sl.customer <> ${distributorKey}
            AND sl.head_canon = ${fbHeadCanon}
            AND sl.code IS NOT NULL
            ${levelFilter}
        `);
        poolCustomers = tier2Rows.rows.map((r) => r.customer);
      }
    }

    // ── Tier 3: national within active-FY size band ────────────────────────────
    if (poolCustomers.length < MIN_PEERS_PER_CODE) {
      fallbackTier = "national";

      const nationalRows = await db.execute<{ customer: string; net: string }>(sql`
        SELECT sl.customer, SUM(sl.amount::numeric)::text AS net
        FROM sale_line_current sl
        WHERE sl.fy = ${fy}
          AND sl.customer IS NOT NULL AND sl.customer <> ''
          AND sl.customer <> ${distributorKey}
          AND sl.code IS NOT NULL
          ${levelFilter}
        GROUP BY sl.customer
      `);

      const nationalWithNets = nationalRows.rows.map((r) => ({
        customer: r.customer,
        net: parseFloat(r.net) || 0,
      }));
      const allNationalNets = nationalWithNets.map((r) => r.net);
      const targetQn = quintileOf(fbActiveNet, allNationalNets);
      const qLowN = Math.max(1, targetQn - 1);
      const qHighN = Math.min(5, targetQn + 1);

      poolCustomers = nationalWithNets
        .filter((r) => {
          const q = quintileOf(r.net, allNationalNets);
          return q >= qLowN && q <= qHighN;
        })
        .map((r) => r.customer);

      fallbackScopeName = `national · size band Q${targetQn}`;
    }

    // ── Suppress if pool still too thin after all three tiers ──────────────────
    if (poolCustomers.length < MIN_PEERS_PER_CODE) {
      return {
        distributorKey,
        stateName: fbHeadCanon,
        quintile: null,
        cohortSize: poolCustomers.length,
        cohortBasis: "national",
        suppressed: true,
        suppressReason: `Pool is too thin even after widening to national size band (${poolCustomers.length} distributor${poolCustomers.length === 1 ? "" : "s"}). No recommendations can be made.`,
        isFallback: true,
        fallbackTier,
        fallbackScopeName,
        peerNames: [...poolCustomers].sort(),
        segments: [],
        fiscalMonths: [],
      };
    }

    // ── Segment queries (identical SQL to the main path, different pool) ────────

    const fbTargetBoughtRows = await db.execute<{ code: string; segment: string }>(sql`
      SELECT DISTINCT
        sl.code,
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment
      FROM sale_line_current sl
      WHERE sl.fy = ${fy}
        AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
        AND sl.customer = ${distributorKey}
        AND sl.code IS NOT NULL AND sl.code <> ''
        ${levelFilter}
    `);
    const fbTargetBought         = new Set(fbTargetBoughtRows.rows.map((r) => r.code));
    const fbTargetActiveSegments = new Set(fbTargetBoughtRows.rows.map((r) => r.segment));
    const fbFiscalMonths = [...new Set(monthLabels.map((m) => m.split("-")[0]))];
    const fbNotBoughtArr = fbTargetBought.size > 0 ? [...fbTargetBought] : ["__none__"];

    // Tier-classification data for fallback distributor
    const [fbItemGroupRows, fbPriorCodeRows] = await Promise.all([
      db.execute<{ item_group: string }>(sql`
        SELECT DISTINCT im.item_group
        FROM sale_line_current sl
        JOIN item_master im ON im.code = sl.code
        WHERE sl.fy = ${fy}
          AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
          AND sl.customer = ${distributorKey}
          AND sl.code IS NOT NULL AND im.item_group IS NOT NULL
          ${levelFilter}
      `),
      db.execute<{ code: string }>(sql`
        SELECT DISTINCT sl.code
        FROM sale_line_current sl
        WHERE sl.fy = ${COHORT_FY}
          AND sl.customer = ${distributorKey}
          AND sl.code IS NOT NULL AND sl.code <> ''
          ${levelFilter}
      `),
    ]);
    const fbTargetItemGroups = new Set(fbItemGroupRows.rows.map((r) => r.item_group));
    const fbPriorCodes       = new Set(fbPriorCodeRows.rows.map((r) => r.code));
    const fbTargetLostCodes  = new Set([...fbPriorCodes].filter((c) => !fbTargetBought.has(c)));

    const fbSegPeerRows = await db.execute<{
      segment: string;
      seg_peer_count: string;
    }>(sql`
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        COUNT(DISTINCT sl.customer)::text AS seg_peer_count
      FROM sale_line_current sl
      WHERE sl.fy = ${fy}
        AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
        AND sl.customer = ANY(ARRAY[${sql.join(poolCustomers.map((c) => sql`${c}`), sql`, `)}])
        AND sl.code IS NOT NULL AND sl.code <> ''
        ${levelFilter}
      GROUP BY COALESCE(sl.group_canon, sl.group_raw, 'Unmapped')
    `);
    const fbSegPeerCount = new Map<string, number>();
    for (const r of fbSegPeerRows.rows) {
      fbSegPeerCount.set(r.segment, parseInt(r.seg_peer_count, 10) || 0);
    }

    const fbCodeRows = await db.execute<{
      segment: string;
      code: string;
      item_name: string | null;
      item_group: string | null;
      peer_count: string;
      peer_net: string;
      last_fy: string;
    }>(sql`
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        sl.code,
        MAX(im.item_name)                                   AS item_name,
        MAX(im.item_group)                                  AS item_group,
        COUNT(DISTINCT sl.customer)::text                   AS peer_count,
        SUM(sl.amount::numeric)::text                       AS peer_net,
        MAX(sl.fy)                                          AS last_fy
      FROM sale_line_current sl
      LEFT JOIN item_master im ON im.code = sl.code
      WHERE sl.fy = ${fy}
        AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
        AND sl.customer = ANY(ARRAY[${sql.join(poolCustomers.map((c) => sql`${c}`), sql`, `)}])
        AND sl.code IS NOT NULL AND sl.code <> ''
        AND sl.code != ALL(ARRAY[${sql.join(fbNotBoughtArr.map((c) => sql`${c}`), sql`, `)}])
        ${levelFilter}
      GROUP BY COALESCE(sl.group_canon, sl.group_raw, 'Unmapped'), sl.code
      HAVING COUNT(DISTINCT sl.customer) >= ${MIN_PEERS_PER_CODE}
      ORDER BY COALESCE(sl.group_canon, sl.group_raw, 'Unmapped'),
               COUNT(DISTINCT sl.customer) DESC,
               SUM(sl.amount::numeric) DESC
    `);

    type SegAccFb = { totalGapCodes: number; codes: PushCode[] };
    const fbSegMap = new Map<string, SegAccFb>();
    for (const r of fbCodeRows.rows) {
      const seg = r.segment;
      if ((fbSegPeerCount.get(seg) ?? 0) < MIN_PEERS_PER_CODE) continue;
      const { tier, tierLabel } = rankCode(
        r.item_group ?? null, seg, r.code,
        fbTargetItemGroups, fbTargetLostCodes, fbTargetActiveSegments,
      );
      const code: PushCode = {
        code: r.code,
        itemName: r.item_name,
        peerCount: parseInt(r.peer_count, 10) || 0,
        peerNet: parseFloat(r.peer_net) || 0,
        lastFy: r.last_fy,
        tier,
        tierLabel,
      };
      const existing = fbSegMap.get(seg);
      if (existing) {
        existing.totalGapCodes++;
        existing.codes.push(code);
      } else {
        fbSegMap.set(seg, { totalGapCodes: 1, codes: [code] });
      }
    }

    const fbSegments: SegmentPushCard[] = [];
    for (const [segment, acc] of fbSegMap) {
      acc.codes.sort((a, b) => a.tier - b.tier || b.peerCount - a.peerCount);
      fbSegments.push({
        rank: 0,
        segment,
        totalGapCodes: acc.totalGapCodes,
        segmentPeerCount: fbSegPeerCount.get(segment) ?? 0,
        cohortBasis: fallbackTier === "national" ? "national" : "state",
        topCodes: acc.codes.slice(0, TOP_CODES_PER_SEGMENT),
      });
    }
    fbSegments.sort(
      (a, b) => b.segmentPeerCount * b.totalGapCodes - a.segmentPeerCount * a.totalGapCodes,
    );
    fbSegments.forEach((s, i) => { s.rank = i + 1; });

    return {
      distributorKey,
      stateName: fbHeadCanon,
      quintile: null,
      cohortSize: poolCustomers.length,
      cohortBasis: fallbackTier === "national" ? "national" : "state",
      suppressed: false,
      isFallback: true,
      fallbackTier,
      fallbackScopeName,
      peerNames: [...poolCustomers].sort(),
      segments: fbSegments,
      fiscalMonths: fbFiscalMonths,
    };
  }

  const stateName = target.headCanon;

  // Group by state
  const stateMembers = allDist.filter((d) => d.headCanon === stateName);
  const useNational = stateMembers.length < MIN_STATE_DISTRIBUTORS;
  const poolMembers = useNational ? allDist : stateMembers;
  const poolNets = poolMembers.map((d) => d.cohortNet);

  const targetQuintile = quintileOf(target.cohortNet, poolNets);
  const qLow = Math.max(1, targetQuintile - 1);
  const qHigh = Math.min(5, targetQuintile + 1);

  // Peers: same pool, quintile ∈ [qLow, qHigh], exclude target
  const peers = poolMembers.filter((d) => {
    if (d.customer === distributorKey) return false;
    const q = quintileOf(d.cohortNet, poolNets);
    return q >= qLow && q <= qHigh;
  });

  const cohortBasis: "state" | "national" = useNational ? "national" : "state";

  if (peers.length < MIN_PEERS_PER_CODE) {
    return {
      distributorKey,
      stateName,
      quintile: targetQuintile,
      cohortSize: peers.length,
      cohortBasis,
      suppressed: true,
      suppressReason: `Only ${peers.length} peer${peers.length === 1 ? "" : "s"} found in the ${cohortBasis} cohort (need at least ${MIN_PEERS_PER_CODE}). No recommendations can be made on thin evidence.`,
      isFallback: false,
      peerNames: peers.map((p) => p.customer).sort(),
      segments: [],
      fiscalMonths: [],
    };
  }

  // ── 2. Target's bought codes + active segments in query period ────────────

  const targetBoughtRows = await db.execute<{ code: string; segment: string }>(sql`
    SELECT DISTINCT
      sl.code,
      COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment
    FROM sale_line_current sl
    WHERE sl.fy = ${fy}
      AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
      AND sl.customer = ${distributorKey}
      AND sl.code IS NOT NULL AND sl.code <> ''
      ${levelFilter}
  `);
  const targetBought         = new Set(targetBoughtRows.rows.map((r) => r.code));
  const targetActiveSegments = new Set(targetBoughtRows.rows.map((r) => r.segment));

  // ── 2b. Tier-classification data (run in parallel) ─────────────────────────
  //   • item_groups the target already buys → Tier 1 (Range) signal
  //   • codes bought in COHORT_FY → Tier 2 (Lapsed) signal

  const [targetItemGroupRows, targetPriorCodeRows] = await Promise.all([
    db.execute<{ item_group: string }>(sql`
      SELECT DISTINCT im.item_group
      FROM sale_line_current sl
      JOIN item_master im ON im.code = sl.code
      WHERE sl.fy = ${fy}
        AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
        AND sl.customer = ${distributorKey}
        AND sl.code IS NOT NULL AND im.item_group IS NOT NULL
        ${levelFilter}
    `),
    db.execute<{ code: string }>(sql`
      SELECT DISTINCT sl.code
      FROM sale_line_current sl
      WHERE sl.fy = ${COHORT_FY}
        AND sl.customer = ${distributorKey}
        AND sl.code IS NOT NULL AND sl.code <> ''
        ${levelFilter}
    `),
  ]);
  const targetItemGroups = new Set(targetItemGroupRows.rows.map((r) => r.item_group));
  const targetPriorCodes = new Set(targetPriorCodeRows.rows.map((r) => r.code));
  // Lapsed = bought in COHORT_FY but NOT in current query period
  const targetLostCodes  = new Set([...targetPriorCodes].filter((c) => !targetBought.has(c)));

  // ── 3. Fiscal-month prefix for same-period signal ─────────────────────────

  const fiscalMonths = [...new Set(monthLabels.map((m) => m.split("-")[0]))];

  // ── 4. Peers' segment activity and code purchases in query period ──────────

  const peerCustomers = peers.map((p) => p.customer);

  // 4a. Segment-active peer counts: how many peers buy ≥1 code per segment
  const segPeerRows = await db.execute<{
    segment: string;
    seg_peer_count: string;
  }>(sql`
    SELECT
      COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
      COUNT(DISTINCT sl.customer)::text AS seg_peer_count
    FROM sale_line_current sl
    WHERE sl.fy = ${fy}
      AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
      AND sl.customer = ANY(ARRAY[${sql.join(peerCustomers.map((c) => sql`${c}`), sql`, `)}])
      AND sl.code IS NOT NULL AND sl.code <> ''
      ${levelFilter}
    GROUP BY COALESCE(sl.group_canon, sl.group_raw, 'Unmapped')
  `);
  const segPeerCount = new Map<string, number>();
  for (const r of segPeerRows.rows) {
    segPeerCount.set(r.segment, parseInt(r.seg_peer_count, 10) || 0);
  }

  // 4b. Per-(segment, code): count distinct peers buying it, sum peer net
  //     Only include codes the TARGET did not buy.
  //     Use same fiscal-month prefix for peer net (signal = same season).
  const notBoughtArr = targetBought.size > 0 ? [...targetBought] : ["__none__"];

  const peerCodeRows = await db.execute<{
    segment: string;
    code: string;
    item_name: string | null;
    item_group: string | null;
    peer_count: string;
    peer_net: string;
    last_fy: string;
  }>(sql`
    SELECT
      COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
      sl.code,
      MAX(im.item_name)                                   AS item_name,
      MAX(im.item_group)                                  AS item_group,
      COUNT(DISTINCT sl.customer)::text                   AS peer_count,
      SUM(sl.amount::numeric)::text                       AS peer_net,
      MAX(sl.fy)                                          AS last_fy
    FROM sale_line_current sl
    LEFT JOIN item_master im ON im.code = sl.code
    WHERE sl.fy = ${fy}
      AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
      AND sl.customer = ANY(ARRAY[${sql.join(peerCustomers.map((c) => sql`${c}`), sql`, `)}])
      AND sl.code IS NOT NULL AND sl.code <> ''
      AND sl.code != ALL(ARRAY[${sql.join(notBoughtArr.map((c) => sql`${c}`), sql`, `)}])
      ${levelFilter}
    GROUP BY COALESCE(sl.group_canon, sl.group_raw, 'Unmapped'), sl.code
    HAVING COUNT(DISTINCT sl.customer) >= ${MIN_PEERS_PER_CODE}
    ORDER BY COALESCE(sl.group_canon, sl.group_raw, 'Unmapped'), COUNT(DISTINCT sl.customer) DESC, SUM(sl.amount::numeric) DESC
  `);

  // ── 5. Assemble segment cards with four-tier ranking ─────────────────────
  // Collect ALL qualifying codes per segment first, then sort + cap.

  type SegAcc = { totalGapCodes: number; codes: PushCode[] };
  const segMap = new Map<string, SegAcc>();

  for (const r of peerCodeRows.rows) {
    const seg = r.segment;
    if ((segPeerCount.get(seg) ?? 0) < MIN_PEERS_PER_CODE) continue;

    const { tier, tierLabel } = rankCode(
      r.item_group ?? null, seg, r.code,
      targetItemGroups, targetLostCodes, targetActiveSegments,
    );
    const code: PushCode = {
      code: r.code,
      itemName: r.item_name,
      peerCount: parseInt(r.peer_count, 10) || 0,
      peerNet: parseFloat(r.peer_net) || 0,
      lastFy: r.last_fy,
      tier,
      tierLabel,
    };
    const existing = segMap.get(seg);
    if (existing) {
      existing.totalGapCodes++;
      existing.codes.push(code);
    } else {
      segMap.set(seg, { totalGapCodes: 1, codes: [code] });
    }
  }

  // Sort each segment: tier ASC (1 beats 4), then peerCount DESC; cap to TOP_CODES_PER_SEGMENT.
  const segments: SegmentPushCard[] = [];
  for (const [segment, acc] of segMap) {
    const spCount = segPeerCount.get(segment) ?? 0;
    acc.codes.sort((a, b) => a.tier - b.tier || b.peerCount - a.peerCount);
    segments.push({
      rank: 0,
      segment,
      totalGapCodes: acc.totalGapCodes,
      segmentPeerCount: spCount,
      cohortBasis,
      topCodes: acc.codes.slice(0, TOP_CODES_PER_SEGMENT),
    });
  }

  // Sort by (segmentPeerCount * totalGapCodes) descending — prioritises segments
  // where most peers are active AND there are many gap codes.
  segments.sort(
    (a, b) =>
      b.segmentPeerCount * b.totalGapCodes - a.segmentPeerCount * a.totalGapCodes,
  );
  segments.forEach((s, i) => {
    s.rank = i + 1;
  });

  return {
    distributorKey,
    stateName,
    quintile: targetQuintile,
    cohortSize: peers.length,
    cohortBasis,
    suppressed: false,
    isFallback: false,
    peerNames: peers.map((p) => p.customer).sort(),
    segments,
    fiscalMonths,
  };
}
