/**
 * SKU Push List — Phase K3b (per-distributor peer-cohort recommendations).
 *
 * For a selected distributor, surfaces gap codes that ≥ MIN_PEERS_PER_CODE
 * peer distributors are CURRENTLY buying but the target is not.
 *
 * Cohort rules (per user spec):
 *  - Cohort size / quintile defined on COHORT_FY (last complete FY = 2025-26).
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

const COHORT_FY = "2025-26";
const MIN_STATE_DISTRIBUTORS = 8;
const MIN_PEERS_PER_CODE = 3;
const TOP_CODES_PER_SEGMENT = 8;

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
    return {
      distributorKey,
      stateName: null,
      quintile: null,
      cohortSize: 0,
      cohortBasis: "state",
      suppressed: true,
      suppressReason: `${distributorKey} does not appear in FY ${COHORT_FY} and cannot be placed in a peer cohort. A full year of data is required to define size.`,
      segments: [],
      fiscalMonths: [],
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
      segments: [],
      fiscalMonths: [],
    };
  }

  // ── 2. Target's bought codes in query period ───────────────────────────────

  const targetBoughtRows = await db.execute<{ code: string }>(sql`
    SELECT DISTINCT sl.code
    FROM sale_line_current sl
    WHERE sl.fy = ${fy}
      AND sl.month_label = ANY(ARRAY[${sql.join(monthLabels.map((m) => sql`${m}`), sql`, `)}])
      AND sl.customer = ${distributorKey}
      AND sl.code IS NOT NULL AND sl.code <> ''
      ${levelFilter}
  `);
  const targetBought = new Set(targetBoughtRows.rows.map((r) => r.code));

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
    peer_count: string;
    peer_net: string;
    last_fy: string;
  }>(sql`
    SELECT
      COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
      sl.code,
      MAX(im.item_name)                                   AS item_name,
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

  // ── 5. Assemble segment cards ─────────────────────────────────────────────

  type SegAcc = {
    totalGapCodes: number;
    topCodes: PushCode[];
  };
  const segMap = new Map<string, SegAcc>();

  for (const r of peerCodeRows.rows) {
    const seg = r.segment;
    const spCount = segPeerCount.get(seg) ?? 0;
    // Segment-active peer count must also meet the threshold
    if (spCount < MIN_PEERS_PER_CODE) continue;

    const existing = segMap.get(seg);
    const code: PushCode = {
      code: r.code,
      itemName: r.item_name,
      peerCount: parseInt(r.peer_count, 10) || 0,
      peerNet: parseFloat(r.peer_net) || 0,
      lastFy: r.last_fy,
    };
    if (existing) {
      existing.totalGapCodes++;
      if (existing.topCodes.length < TOP_CODES_PER_SEGMENT) {
        existing.topCodes.push(code);
      }
    } else {
      segMap.set(seg, { totalGapCodes: 1, topCodes: [code] });
    }
  }

  // Build sorted segment cards (sort by totalGapCodes * segmentPeerCount desc)
  const segments: SegmentPushCard[] = [];
  for (const [segment, acc] of segMap) {
    const spCount = segPeerCount.get(segment) ?? 0;
    segments.push({
      rank: 0,
      segment,
      totalGapCodes: acc.totalGapCodes,
      segmentPeerCount: spCount,
      cohortBasis,
      topCodes: acc.topCodes,
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
    segments,
    fiscalMonths,
  };
}
