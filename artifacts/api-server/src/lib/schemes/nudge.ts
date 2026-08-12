// Scheme Nudge Engine — core computation.
//
// THE MECHANIC (from the spec):
//   A slab pays a % on the distributor's ENTIRE billing for the period —
//   not just the amount above the threshold. So crossing a slab is worth far
//   more than the top-up that gets you there.
//
//   they_earn = (next_threshold × next_rate) − (billed_so_far × current_rate)
//   gap       = next_threshold − billed_so_far
//   roi       = they_earn / gap
//
// ROI FILTER: suppress nudges where roi < roi_threshold (default 5%).
//
// TERRITORY ROUTING:
//   Each CP/PTMT scheme covers a specific territory (Lalan, KL/KA, Wahid, etc.)
//   The sale_line.state_canon is resolved to territory state abbreviations via
//   STATE_CANON_TO_ABBREVS (territoryResolver.ts). These abbreviations are
//   matched against territory_group.states[] loaded from DB. The correct scheme
//   for an item_group+territory pair is resolved explicitly — never "first
//   alphabetically".
//
// CONDITIONS (all applied before any nudge is shown):
//   1. Slab base = SALE (dispatched), not order booking.
//   2. Exclude is_territory = false (non-territory, Govt, Project etc).
//   3. Exclude customers matching GOVT/GEM/JJM/PROJECT patterns in name.
//   4. BLOCKED = distributor with overdue bills (from dues fetcher).
//   5. Deadline = 25th of the last month of the quarter.
import { pool } from "@workspace/db";
import {
  STATE_CANON_TO_ABBREVS,
  stateCanonsForAbbrevs,
} from "./territoryResolver.js";
import { buildAudienceFilterSQL } from "./audienceFilter.js";

// ── Constants (formerly from scheme_master.json) ──────────────────────────────

const EXCLUDE_PATTERNS_RAW = ["GOVT", "GOVERNMENT", "GEM", "JJM", "PROJECT"];
const EXCLUDE_PATTERNS = EXCLUDE_PATTERNS_RAW.map((p) => p.toUpperCase());

export const DEFAULT_ROI_THRESHOLD = 0.05;

const SEASONALITY: Record<string, number> = {
  Apr: 4.2,  May: 8.2,  Jun: 8.3,
  Jul: 7.3,  Aug: 7.0,  Sep: 7.4,
  Oct: 7.1,  Nov: 8.5,  Dec: 10.1,
  Jan: 10.1, Feb: 9.6,  Mar: 12.3,
};

// Re-export the mapping so callers don't need to import from two places
export { STATE_CANON_TO_ABBREVS, stateCanonsForAbbrevs };

// ── Types ─────────────────────────────────────────────────────────────────────

export type SchemeSlab = {
  threshold: number;
  rate: number | null;
  reward?: string | null;
  rewardType: "pct" | "trip" | "pct_or_trip";
};

export type SchemeConfig = {
  id: string;
  name: string;
  /** 'cumulative_quarter' | 'cumulative_year' */
  basis: string;
  slabs: SchemeSlab[];
  territoryGroup: string | null;
  /** Flat set of state abbreviations this scheme covers */
  territoryStates: Set<string>;
  /** Audience types eligible for this scheme (e.g. ['sub_dealer'], ['direct_dealer','sub_dealer']) */
  audience: string[];
  /** Settlement channel: 'company' | 'pass_through' | 'primary' | null */
  settlement: string | null;
};

// ── Scheme family classification ───────────────────────────────────────────────

export type SchemeFamily = "cp" | "ptmt" | "annual" | "other";

export function schemeFamily(schemeId: string): SchemeFamily {
  const id = schemeId.toUpperCase();
  if (id.startsWith("Q_CP") || id.startsWith("SB_CP")) return "cp";
  if (id.startsWith("Q_PTMT") || id.startsWith("SB_PTMT")) return "ptmt";
  if (id.startsWith("A_") || id.includes("ANNUAL")) return "annual";
  return "other";
}

// ── Quarter helpers ───────────────────────────────────────────────────────────

export function getQuarterMonths(fy: string, q: "Q1" | "Q2" | "Q3" | "Q4"): string[] {
  const [startYr] = fy.split("-").map(Number);
  const s = String(startYr).slice(-2);
  const e = String(startYr + 1).slice(-2);
  const map: Record<string, string[]> = {
    Q1: [`Apr-${s}`, `May-${s}`, `Jun-${s}`],
    Q2: [`Jul-${s}`, `Aug-${s}`, `Sep-${s}`],
    Q3: [`Oct-${s}`, `Nov-${s}`, `Dec-${s}`],
    Q4: [`Jan-${e}`, `Feb-${e}`, `Mar-${e}`],
  };
  return map[q] ?? map.Q1;
}

export function getQuarterDeadline(fy: string, q: "Q1" | "Q2" | "Q3" | "Q4"): Date {
  const [startYr] = fy.split("-").map(Number);
  const deadlineMap: Record<string, [number, number]> = {
    Q1: [startYr, 6],
    Q2: [startYr, 9],
    Q3: [startYr, 12],
    Q4: [startYr + 1, 3],
  };
  const [yr, mo] = deadlineMap[q] ?? deadlineMap.Q2;
  return new Date(yr, mo - 1, 25);
}

function getCurrentSlab(slabs: SchemeSlab[], amount: number): SchemeSlab | null {
  let current: SchemeSlab | null = null;
  for (const s of slabs) {
    if (amount >= s.threshold) current = s;
    else break;
  }
  return current;
}

function getNextSlab(slabs: SchemeSlab[], amount: number): SchemeSlab | null {
  for (const s of slabs) {
    if (s.threshold > amount) return s;
  }
  return null;
}

function isExcluded(customer: string): boolean {
  const upper = customer.toUpperCase();
  return EXCLUDE_PATTERNS.some((p) => upper.includes(p));
}

// ── DB loader: schemes + territory groups ─────────────────────────────────────

interface DbSchemeRow {
  scheme_id: string;
  name: string;
  qualification_basis: string;
  territory_group: string | null;
  period_from: string;
  period_to: string | null;
  audience: string[];
  settlement: string | null;
  slab_order: number;
  threshold_from: string;
  rate: string | null;
  alt_reward: string | null;
  reward_status: string;
}

interface DbItemGroupRow {
  item_group: string;
  scheme_id: string;
}

interface DbTerritoryGroupRow {
  group_raw: string;
  states: string[];
}

/**
 * Load all usable cumulative-value schemes from DB, reconstruct SCHEMES map,
 * BASKET_MAP, and an abbrev → [group_raw] index for territory routing.
 * Schemes with reward_status='needs_clarification' are excluded from all slabs.
 */
async function loadSchemesFromDb(): Promise<{
  schemeMap: Map<string, SchemeConfig>;
  basketMap: Map<string, string[]>;
  /** state abbreviation (from territory_group.states[]) → [group_raw] */
  abbrevToGroups: Map<string, string[]>;
}> {
  const [schemeRes, groupRes, territoryRes] = await Promise.all([
    pool.query<DbSchemeRow>(`
      SELECT
        s.scheme_id,
        s.name,
        s.qualification_basis,
        s.territory_group,
        s.period_from::text,
        s.period_to::text,
        s.audience,
        s.settlement,
        ss.slab_order,
        ss.threshold_from::text,
        ss.rate::text,
        ss.alt_reward,
        ss.reward_status
      FROM scheme s
      JOIN scheme_reward_slab ss ON ss.scheme_id = s.scheme_id
      WHERE s.qualification_basis = 'cumulative_value'
        AND ss.reward_status != 'needs_clarification'
      ORDER BY s.scheme_id, ss.slab_order
    `),
    pool.query<DbItemGroupRow>(
      `SELECT item_group, scheme_id FROM scheme_item_group`,
    ),
    pool.query<DbTerritoryGroupRow>(
      `SELECT group_raw, states FROM territory_group`,
    ),
  ]);

  // ── Build abbrev → [group_raw] index ─────────────────────────────────────
  const abbrevToGroups = new Map<string, string[]>();
  for (const tg of territoryRes.rows) {
    for (const abbrev of tg.states) {
      const arr = abbrevToGroups.get(abbrev) ?? [];
      arr.push(tg.group_raw);
      abbrevToGroups.set(abbrev, arr);
    }
  }

  // ── Build territory_group → Set<abbrev> for each scheme ──────────────────
  const groupToAbbrevs = new Map<string, Set<string>>();
  for (const tg of territoryRes.rows) {
    groupToAbbrevs.set(tg.group_raw, new Set(tg.states));
  }

  // ── Build schemeMap ───────────────────────────────────────────────────────
  const schemeMap = new Map<string, SchemeConfig>();
  for (const row of schemeRes.rows) {
    let config = schemeMap.get(row.scheme_id);
    if (!config) {
      let basis = "cumulative_quarter";
      if (row.period_from && row.period_to) {
        const daysDiff =
          (new Date(row.period_to).getTime() - new Date(row.period_from).getTime()) /
          (1000 * 60 * 60 * 24);
        if (daysDiff > 180) basis = "cumulative_year";
      } else if (!row.period_to) {
        basis = "cumulative_year";
      }

      const tgRaw = row.territory_group;
      const territoryStates: Set<string> =
        tgRaw && groupToAbbrevs.has(tgRaw)
          ? new Set(groupToAbbrevs.get(tgRaw)!)
          : new Set(["ALL"]); // "All States" scheme covers everything

      config = {
        id: row.scheme_id,
        name: row.name,
        basis,
        slabs: [],
        territoryGroup: tgRaw,
        territoryStates,
        audience: row.audience ?? [],
        settlement: row.settlement ?? null,
      };
      schemeMap.set(row.scheme_id, config);
    }

    const rate = row.rate != null ? parseFloat(row.rate) : null;
    const rewardType: SchemeSlab["rewardType"] =
      row.alt_reward != null && rate != null
        ? "pct_or_trip"
        : row.alt_reward != null
        ? "trip"
        : "pct";
    config.slabs.push({
      threshold: parseFloat(row.threshold_from),
      rate,
      reward: row.alt_reward ?? undefined,
      rewardType,
    });
  }

  // ── Build basketMap ───────────────────────────────────────────────────────
  const basketMap = new Map<string, string[]>();
  for (const row of groupRes.rows) {
    if (!schemeMap.has(row.scheme_id)) continue; // only cumulative_value
    const arr = basketMap.get(row.item_group) ?? [];
    if (!arr.includes(row.scheme_id)) arr.push(row.scheme_id);
    basketMap.set(row.item_group, arr);
  }

  return { schemeMap, basketMap, abbrevToGroups };
}

// ── Territory resolver ────────────────────────────────────────────────────────
// Given a sale_line.state_canon and a set of candidate scheme_ids (from the
// basket map for a given item_group), return the ONE scheme whose territory
// covers this state. Returns null when no scheme covers the state (e.g. TN).
//
// For ambiguous states (UTTAR PRADESH → [WUP, EUP]; MAHARASHTRA → [MAH-Lalan,
// MAH-Wahid]), the abbreviation list in STATE_CANON_TO_ABBREVS is ordered by
// priority: the first abbrev whose territory group has a matching scheme wins.

function resolveSchemeForState(
  stateCanon: string | null,
  candidateIds: string[],
  schemeMap: Map<string, SchemeConfig>,
): string | null {
  if (!stateCanon) return null;

  const abbrevs = STATE_CANON_TO_ABBREVS[stateCanon.trim()];

  // Unknown state — cannot route
  if (abbrevs === undefined) return null;

  // State not covered by any scheme territory (e.g. Tamil Nadu, GEM)
  if (abbrevs.length === 0) return null;

  // "All States" sentinel: every scheme covers this; use first candidate
  if (abbrevs.includes("ALL")) {
    return candidateIds[0] ?? null;
  }

  // Try each abbreviation in priority order
  for (const abbrev of abbrevs) {
    for (const schemeId of candidateIds) {
      const scheme = schemeMap.get(schemeId);
      if (!scheme) continue;

      // "All States" scheme (territory_group = null or states = ["ALL"])
      if (scheme.territoryGroup === null || scheme.territoryStates.has("ALL")) {
        return schemeId;
      }

      if (scheme.territoryStates.has(abbrev)) {
        return schemeId;
      }
    }
  }

  // No territory match — check for an "All States" fallback among candidates
  for (const schemeId of candidateIds) {
    const scheme = schemeMap.get(schemeId);
    if (scheme && (scheme.territoryGroup === null || scheme.territoryStates.has("ALL"))) {
      return schemeId;
    }
  }

  return null;
}

// ── NudgeRow / NudgeResult types ──────────────────────────────────────────────

export type NudgeRow = {
  customer: string;
  stateHead: string | null;
  schemeId: string;
  basketName: string;
  billedSoFar: number;
  currentSlab: number | null;
  currentRate: number;
  currentEarnings: number;
  nextSlab: number;
  nextRate: number | null;
  nextEarnings: number | null;
  gap: number;
  extraEarn: number | null;
  extraRoi: number | null;
  rewardType: "pct" | "trip" | "pct_or_trip";
  tripLabel: string | null;
  status: "NUDGE" | "BLOCKED" | "AT_MAX" | "TRIP_ZONE";
  blockedReason: string | null;
};

export type NudgeResult = {
  fy: string;
  quarter: string;
  months: string[];
  deadline: string;
  daysToDeadline: number;
  totalOpportunity: number;
  totalSchemeCost: number;
  nudgeCount: number;
  nudges: NudgeRow[];
  blocked: string[];
  duesDataAvailable: boolean;
};

// ── computeNudgeList ──────────────────────────────────────────────────────────

export async function computeNudgeList(
  fy: string,
  q: "Q1" | "Q2" | "Q3" | "Q4",
  blockedCustomers: Set<string>,
  duesDataAvailable: boolean,
  roiThreshold: number = DEFAULT_ROI_THRESHOLD,
  head: string = "",
): Promise<NudgeResult> {
  const months = getQuarterMonths(fy, q);
  const deadline = getQuarterDeadline(fy, q);
  const daysToDeadline = Math.ceil(
    (deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );

  // ── Load schemes + territory data from DB ─────────────────────────────────
  const { schemeMap, basketMap, abbrevToGroups: _abbrevToGroups } =
    await loadSchemesFromDb();

  const quarterlySchemeIds = [...schemeMap.values()]
    .filter((s) => s.basis === "cumulative_quarter")
    .map((s) => s.id);

  // Collect item_groups that map to at least one quarterly scheme
  const quarterlyGroups: string[] = [];
  for (const [group, schemeIds] of basketMap.entries()) {
    if (schemeIds.some((sid) => quarterlySchemeIds.includes(sid))) {
      quarterlyGroups.push(group);
    }
  }

  if (!quarterlyGroups.length || !months.length) {
    return {
      fy, quarter: q, months, deadline: deadline.toISOString().slice(0, 10),
      daysToDeadline, totalOpportunity: 0, totalSchemeCost: 0,
      nudgeCount: 0, nudges: [], blocked: [], duesDataAvailable,
    };
  }

  // ── Audience filter for quarterly schemes ────────────────────────────────
  // Collect all distinct audiences across the quarterly scheme set. If every
  // quarterly scheme restricts to sub_dealer (the typical Q2 setup), exclude
  // known distributors from the sale_line_current aggregation. A scheme with
  // a broader audience (e.g. both sub_dealer + direct_dealer) opts the entire
  // nudge list out of the distributor exclusion to avoid false negatives.
  const quarterlyAudiences: string[][] = [];
  for (const sid of quarterlySchemeIds) {
    const scheme = schemeMap.get(sid);
    if (scheme) quarterlyAudiences.push(scheme.audience);
  }
  // Union of all audiences
  const allAudiences = [...new Set(quarterlyAudiences.flat())];
  const audienceFilter = buildAudienceFilterSQL(allAudiences, "sl");

  const monthPlaceholders = months.map((_, i) => `$${i + 2}`).join(", ");
  const groupPlaceholders = quarterlyGroups
    .map((_, i) => `$${months.length + 2 + i}`)
    .join(", ");
  const headParamIdx = months.length + quarterlyGroups.length + 2;

  // Include state_canon in the SELECT+GROUP BY so territory routing works
  const sql = `
    SELECT
      sl.customer,
      sl.group_raw,
      sl.state_canon,
      sl.head_canon AS state_head,
      SUM(sl.amount::numeric) AS total_amount
    FROM sale_line_current sl
    WHERE sl.fy = $1
      AND sl.month_label IN (${monthPlaceholders})
      AND sl.group_raw IN (${groupPlaceholders})
      AND (sl.is_territory IS NULL OR sl.is_territory = true)
      AND ($${headParamIdx}::text = '' OR sl.head_canon = $${headParamIdx}::text)
      ${audienceFilter}
    GROUP BY sl.customer, sl.group_raw, sl.state_canon, sl.head_canon
    ORDER BY SUM(sl.amount::numeric) DESC
  `;

  const params = [fy, ...months, ...quarterlyGroups, head];
  const { rows } = await pool.query<{
    customer: string;
    group_raw: string;
    state_canon: string | null;
    state_head: string | null;
    total_amount: string;
  }>(sql, params);

  // Route each (customer, group_raw, state_canon) to the correct scheme.
  // A customer may appear multiple times with the same group if their state_canon
  // differs across invoices (rare); accumulate into a single (customer, scheme) bucket.
  const buckets = new Map<
    string,
    { customer: string; schemeId: string; stateHead: string | null; total: number }
  >();

  for (const row of rows) {
    const customer = row.customer ?? "";
    if (!customer || isExcluded(customer)) continue;

    const candidateIds = (basketMap.get(row.group_raw) ?? []).filter((sid) =>
      quarterlySchemeIds.includes(sid),
    );
    if (!candidateIds.length) continue;

    // Explicit territory resolution
    const schemeId = resolveSchemeForState(row.state_canon, candidateIds, schemeMap);
    if (!schemeId) continue; // state not covered by any scheme (e.g. Tamil Nadu)

    const key = `${customer}|${schemeId}`;
    const existing = buckets.get(key);
    const amount = parseFloat(row.total_amount ?? "0");
    if (existing) {
      existing.total += amount;
    } else {
      buckets.set(key, {
        customer,
        schemeId,
        stateHead: row.state_head,
        total: amount,
      });
    }
  }

  // ── Compute nudge rows ────────────────────────────────────────────────────
  const nudges: NudgeRow[] = [];
  const blocked: string[] = [];
  let totalOpportunity = 0;
  let totalSchemeCost = 0;

  for (const { customer, schemeId, stateHead, total: billedSoFar } of buckets.values()) {
    const scheme = schemeMap.get(schemeId);
    if (!scheme) continue;

    const isBlocked = blockedCustomers.has(customer.toUpperCase().trim());
    const currentSlab = getCurrentSlab(scheme.slabs, billedSoFar);
    const nextSlab = getNextSlab(scheme.slabs, billedSoFar);
    const currentRate = currentSlab?.rate ?? 0;
    const currentEarnings = currentRate * billedSoFar;
    totalSchemeCost += currentEarnings;

    if (isBlocked) {
      if (!blocked.includes(customer)) blocked.push(customer);
      nudges.push({
        customer, stateHead, schemeId, basketName: scheme.name,
        billedSoFar,
        currentSlab: currentSlab?.threshold ?? null,
        currentRate, currentEarnings,
        nextSlab: nextSlab?.threshold ?? 0,
        nextRate: nextSlab?.rate ?? null,
        nextEarnings:
          nextSlab && nextSlab.rate != null
            ? nextSlab.threshold * nextSlab.rate
            : null,
        gap: nextSlab ? nextSlab.threshold - billedSoFar : 0,
        extraEarn: null, extraRoi: null,
        rewardType: nextSlab?.rewardType ?? "pct",
        tripLabel: nextSlab?.reward ?? null,
        status: "BLOCKED", blockedReason: "OVERDUE_BILLS",
      });
      continue;
    }

    if (!nextSlab) {
      nudges.push({
        customer, stateHead, schemeId, basketName: scheme.name,
        billedSoFar,
        currentSlab: currentSlab?.threshold ?? null,
        currentRate, currentEarnings,
        nextSlab: 0, nextRate: null, nextEarnings: null, gap: 0,
        extraEarn: null, extraRoi: null,
        rewardType: "pct", tripLabel: null,
        status: "AT_MAX", blockedReason: null,
      });
      continue;
    }

    const gap = nextSlab.threshold - billedSoFar;

    if (nextSlab.rewardType === "trip") {
      nudges.push({
        customer, stateHead, schemeId, basketName: scheme.name,
        billedSoFar,
        currentSlab: currentSlab?.threshold ?? null,
        currentRate, currentEarnings,
        nextSlab: nextSlab.threshold, nextRate: null, nextEarnings: null, gap,
        extraEarn: null, extraRoi: null,
        rewardType: "trip", tripLabel: nextSlab.reward ?? null,
        status: "TRIP_ZONE", blockedReason: null,
      });
      totalOpportunity += gap;
      continue;
    }

    const nextRate = nextSlab.rate ?? 0;
    const nextEarnings = nextSlab.threshold * nextRate;
    const extraEarn = nextEarnings - billedSoFar * currentRate;
    const extraRoi = gap > 0 ? extraEarn / gap : 0;

    if (extraRoi < roiThreshold) continue;

    totalOpportunity += gap;
    nudges.push({
      customer, stateHead, schemeId, basketName: scheme.name,
      billedSoFar,
      currentSlab: currentSlab?.threshold ?? null,
      currentRate, currentEarnings,
      nextSlab: nextSlab.threshold, nextRate, nextEarnings, gap,
      extraEarn, extraRoi,
      rewardType: "pct", tripLabel: null,
      status: "NUDGE", blockedReason: null,
    });
  }

  nudges.sort((a, b) => {
    if (a.status === "BLOCKED" && b.status !== "BLOCKED") return 1;
    if (b.status === "BLOCKED" && a.status !== "BLOCKED") return -1;
    return (b.extraEarn ?? 0) - (a.extraEarn ?? 0);
  });

  return {
    fy, quarter: q, months,
    deadline: deadline.toISOString().slice(0, 10),
    daysToDeadline, totalOpportunity, totalSchemeCost,
    nudgeCount: nudges.filter((n) => n.status === "NUDGE").length,
    nudges, blocked, duesDataAvailable,
  };
}

// ── Cockpit ────────────────────────────────────────────────────────────────────

export type CockpitRow = {
  schemeId: string;
  schemeName: string;
  participantCount: number;
  totalBilled: number;
  totalEarned: number;
  nudgeCount: number;
  opportunityAmount: number;
};

export type CockpitResult = {
  fy: string;
  quarter: string;
  deadline: string;
  daysToDeadline: number;
  totalLiveOpportunity: number;
  totalSchemeCost: number;
  totalNudges: number;
  byScheme: CockpitRow[];
};

export function buildCockpit(nudgeResult: NudgeResult): CockpitResult {
  const byScheme = new Map<string, CockpitRow>();
  for (const n of nudgeResult.nudges) {
    if (!byScheme.has(n.schemeId)) {
      byScheme.set(n.schemeId, {
        schemeId: n.schemeId,
        schemeName: n.basketName,
        participantCount: 0,
        totalBilled: 0,
        totalEarned: 0,
        nudgeCount: 0,
        opportunityAmount: 0,
      });
    }
    const row = byScheme.get(n.schemeId)!;
    row.participantCount++;
    row.totalBilled += n.billedSoFar;
    row.totalEarned += n.currentEarnings;
    if (n.status === "NUDGE") {
      row.nudgeCount++;
      row.opportunityAmount += n.gap;
    }
  }
  return {
    fy: nudgeResult.fy,
    quarter: nudgeResult.quarter,
    deadline: nudgeResult.deadline,
    daysToDeadline: nudgeResult.daysToDeadline,
    totalLiveOpportunity: nudgeResult.totalOpportunity,
    totalSchemeCost: nudgeResult.totalSchemeCost,
    totalNudges: nudgeResult.nudgeCount,
    byScheme: [...byScheme.values()].sort(
      (a, b) => b.opportunityAmount - a.opportunityAmount,
    ),
  };
}

// ── Annual Tracker ─────────────────────────────────────────────────────────────

export type AnnualRow = {
  customer: string;
  stateHead: string | null;
  fyTotal: number;
  lyTotal: number;
  seasonalityPctElapsed: number;
  projectedTotal: number;
  projectedVsLyPct: number | null;
  atRisk: boolean;
  currentSlabIdx: number;
  currentRate: number | null;
  schemeId: string;
};

export async function computeAnnualTracker(
  fy: string,
  completeMonths: string[],
): Promise<AnnualRow[]> {
  if (!completeMonths.length) return [];
  const [startYr] = fy.split("-").map(Number);
  const priorFy = `${startYr - 1}-${String(startYr).slice(-2)}`;

  const elapsedPct = completeMonths.reduce((sum, ml) => {
    const mon = ml.slice(0, 3);
    return sum + (SEASONALITY[mon] ?? 0);
  }, 0);

  // ── Load the annual scheme from DB ──────────────────────────────────────
  // (cumulative_value, period spans full FY i.e. > 180 days)
  const [annualRes, schemeMetaRes] = await Promise.all([
    pool.query<{
      scheme_id: string;
      threshold_from: string;
      rate: string | null;
      slab_order: number;
    }>(`
      SELECT s.scheme_id, ss.threshold_from::text, ss.rate::text, ss.slab_order
      FROM scheme s
      JOIN scheme_reward_slab ss ON ss.scheme_id = s.scheme_id
      WHERE s.qualification_basis = 'cumulative_value'
        AND s.period_to IS NOT NULL
        AND (s.period_to::date - s.period_from::date) > 180
        AND ss.reward_status != 'needs_clarification'
      ORDER BY s.scheme_id, ss.slab_order
    `),
    pool.query<{
      scheme_id: string;
      audience: string[];
      territory_group: string | null;
    }>(`
      SELECT scheme_id, audience, territory_group
      FROM scheme
      WHERE qualification_basis = 'cumulative_value'
        AND period_to IS NOT NULL
        AND (period_to::date - period_from::date) > 180
      ORDER BY scheme_id
      LIMIT 1
    `),
  ]);

  const annualSchemeId = annualRes.rows[0]?.scheme_id ?? "ANNUAL_WB";
  const annualSlabs: SchemeSlab[] = annualRes.rows
    .filter((r) => r.scheme_id === annualSchemeId)
    .map((r) => ({
      threshold: parseFloat(r.threshold_from),
      rate: r.rate != null ? parseFloat(r.rate) : null,
      rewardType: "pct" as const,
    }));

  if (!annualSlabs.length) return [];

  const schemeMeta = schemeMetaRes.rows[0];
  const audience: string[] = schemeMeta?.audience ?? ["direct_dealer", "sub_dealer"];
  const territoryGroupRaw = schemeMeta?.territory_group ?? null;

  // ── Territory filter ─────────────────────────────────────────────────────
  // Load the territory group's abbreviations and invert them to state_canon values.
  // ANNUAL_WB covers WB/ORISSA/NE/BIHAR/JHARKHAND.
  let territoryStateCanons: string[] = [];
  if (territoryGroupRaw) {
    const tgRes = await pool.query<{ states: string[] }>(
      `SELECT states FROM territory_group WHERE group_raw = $1`,
      [territoryGroupRaw],
    );
    const abbrevs = tgRes.rows[0]?.states ?? [];
    territoryStateCanons = stateCanonsForAbbrevs(abbrevs);
  }

  // ── Item-group filter (product scope) ────────────────────────────────────
  // The annual scheme says "ON ALL PRODUCTS EXCEPT - WATER TANK / GARDEN PIPE
  // / QUAA & FERN". The scheme_item_group table lists the INCLUDED item_groups.
  const igRes = await pool.query<{ item_group: string }>(
    `SELECT item_group FROM scheme_item_group WHERE scheme_id = $1`,
    [annualSchemeId],
  );
  const annualItemGroups = igRes.rows.map((r) => r.item_group);

  // ── Audience SQL fragment ─────────────────────────────────────────────────
  // Uses distributor_identity to exclude known distributors for sub_dealer audience.
  // See audienceFilter.ts for the full audience → customer-type mapping.
  const audienceFilter = buildAudienceFilterSQL(audience, "sl");

  // ── Build parameterised query ─────────────────────────────────────────────
  const monthPlaceholders = completeMonths.map((_, i) => `$${i + 2}`).join(", ");
  const priorMonths = completeMonths.map((ml) => {
    const [mon] = ml.split("-");
    return `${mon}-${String(startYr - 1).slice(-2)}`;
  });

  // Base param index: $1=fy, $2..$(1+M)=months, $(2+M)=priorFy, $(3+M...) = priorMonths
  const priorFyIdx = completeMonths.length + 2;
  const priorPlaceholders = priorMonths.map((_, i) =>
    `$${priorFyIdx + 1 + i}`,
  ).join(", ");

  // Territory and item-group params start after prior months
  let paramIdx = priorFyIdx + priorMonths.length + 1;
  let territoryClause = "";
  let territoryParam: string[] = [];
  if (territoryStateCanons.length > 0) {
    territoryClause = `AND sl.state_canon = ANY($${paramIdx}::text[])`;
    territoryParam = territoryStateCanons;
    paramIdx++;
  }

  let itemGroupClause = "";
  let itemGroupParam: string[] = [];
  if (annualItemGroups.length > 0) {
    itemGroupClause = `AND sl.group_raw = ANY($${paramIdx}::text[])`;
    itemGroupParam = annualItemGroups;
    // paramIdx++ not needed since this is the last param
  }

  const sql = `
    WITH cy AS (
      SELECT sl.customer, sl.head_canon AS state_head, SUM(sl.amount::numeric) AS total
      FROM sale_line_all sl
      WHERE sl.fy = $1
        AND sl.version_status = 'current'
        AND sl.month_label IN (${monthPlaceholders})
        AND (sl.is_territory IS NULL OR sl.is_territory = true)
        ${audienceFilter}
        ${territoryClause}
        ${itemGroupClause}
      GROUP BY sl.customer, sl.head_canon
    ),
    ly AS (
      SELECT sl.customer, SUM(sl.amount::numeric) AS total
      FROM sale_line_all sl
      WHERE sl.fy = $${priorFyIdx}
        AND sl.version_status = 'current'
        AND sl.month_label IN (${priorPlaceholders})
        AND (sl.is_territory IS NULL OR sl.is_territory = true)
        ${audienceFilter}
        ${territoryClause}
        ${itemGroupClause}
      GROUP BY sl.customer
    )
    SELECT
      cy.customer,
      cy.state_head,
      cy.total  AS cy_total,
      COALESCE(ly.total, 0) AS ly_total
    FROM cy
    LEFT JOIN ly USING (customer)
    WHERE cy.total >= 100000
    ORDER BY cy.total DESC
    LIMIT 500
  `;

  const params: (string | string[])[] = [
    fy,
    ...completeMonths,
    priorFy,
    ...priorMonths,
    ...( territoryParam.length > 0 ? [territoryParam] : [] ),
    ...( itemGroupParam.length > 0 ? [itemGroupParam] : [] ),
  ];

  const { rows } = await pool.query<{
    customer: string;
    state_head: string | null;
    cy_total: string;
    ly_total: string;
  }>(sql, params);

  return rows.map((row) => {
    const cyTotal = parseFloat(row.cy_total ?? "0");
    const lyTotal = parseFloat(row.ly_total ?? "0");
    const projectedTotal =
      elapsedPct > 0 ? (cyTotal / elapsedPct) * 100 : cyTotal;
    const projectedVsLyPct =
      lyTotal > 0 ? (projectedTotal - lyTotal) / lyTotal : null;
    const atRisk = lyTotal > 0 && projectedTotal < lyTotal;
    const currentSlab = getCurrentSlab(annualSlabs, cyTotal);
    const slabIdx = currentSlab ? annualSlabs.indexOf(currentSlab) : -1;

    return {
      customer: row.customer,
      stateHead: row.state_head,
      fyTotal: cyTotal,
      lyTotal,
      seasonalityPctElapsed: elapsedPct,
      projectedTotal,
      projectedVsLyPct,
      atRisk,
      currentSlabIdx: slabIdx,
      currentRate: currentSlab?.rate ?? null,
      schemeId: annualSchemeId,
    };
  });
}

// ── Success List ───────────────────────────────────────────────────────────────
//
// Distributors who have already crossed at least one slab this quarter.
//
// KEY DESIGN: Unlike computeNudgeList, which unions all quarterly scheme
// audiences into a single SQL filter (causing schemes with a narrower audience
// to apply their exclusion across all schemes), computeSuccessList groups
// schemes by their audience signature and runs one DB query per group. This
// ensures each scheme's eligibility rules apply only to that scheme's rows.
//
// Example: if Q_CP has audience=['sub_dealer'] and Q_DIST has
// audience=['distributor'], they are executed as two separate queries so
// registered distributors are correctly included for Q_DIST and excluded for
// Q_CP, rather than being excluded from both because sub_dealer is in the
// union.

export type SuccessRow = {
  customer: string;
  stateHead: string | null;
  schemeId: string;
  basketName: string;
  family: SchemeFamily;
  settlement: string | null;
  billedSoFar: number;
  currentSlab: number;        // threshold of the slab they're at
  currentRate: number;        // rate at that slab (fraction, e.g. 0.02 = 2%)
  earnedRs: number;           // billedSoFar × currentRate
  isAtMax: boolean;           // no next slab exists
};

export type SuccessResult = {
  fy: string;
  quarter: string;
  months: string[];
  rows: SuccessRow[];
  totalEarnedRs: number;
  totalCompanyCost: number;     // sum where settlement = 'company'
  totalPassThrough: number;     // sum where settlement = 'pass_through'
  totalPrimary: number;         // sum where settlement = 'primary'
  byFamily: Array<{
    family: SchemeFamily;
    count: number;
    totalEarnedRs: number;
    settlement: string | null;
  }>;
};

function emptySuccessResult(fy: string, q: string, months: string[]): SuccessResult {
  return { fy, quarter: q, months, rows: [], totalEarnedRs: 0,
    totalCompanyCost: 0, totalPassThrough: 0, totalPrimary: 0, byFamily: [] };
}

export async function computeSuccessList(
  fy: string,
  q: "Q1" | "Q2" | "Q3" | "Q4",
  head: string = "",
): Promise<SuccessResult> {
  const months = getQuarterMonths(fy, q);
  if (!months.length) return emptySuccessResult(fy, q, months);

  const { schemeMap, basketMap } = await loadSchemesFromDb();

  // Quarterly schemes only
  const quarterlySchemes = [...schemeMap.values()].filter(
    (s) => s.basis === "cumulative_quarter",
  );
  if (!quarterlySchemes.length) return emptySuccessResult(fy, q, months);

  // Group quarterly schemes by audience signature so each group gets its own
  // SQL query with the correct audience filter (not a union across all schemes).
  const audienceGroups = new Map<string, SchemeConfig[]>();
  for (const scheme of quarterlySchemes) {
    const sig = [...scheme.audience].sort().join("|");
    const group = audienceGroups.get(sig) ?? [];
    group.push(scheme);
    audienceGroups.set(sig, group);
  }

  // Accumulate (customer, scheme_id) billing buckets across all audience groups.
  const buckets = new Map<
    string,
    { customer: string; schemeId: string; stateHead: string | null; total: number }
  >();

  for (const schemes of audienceGroups.values()) {
    const schemeIds = new Set(schemes.map((s) => s.id));

    // Collect item_groups whose basketMap entry includes at least one scheme
    // from this audience group.
    const groupsForAudience: string[] = [];
    for (const [ig, ids] of basketMap.entries()) {
      if (ids.some((id) => schemeIds.has(id))) groupsForAudience.push(ig);
    }
    if (!groupsForAudience.length) continue;

    // Build the audience filter using this group's shared audience signature.
    const audienceFilter = buildAudienceFilterSQL(schemes[0].audience, "sl");

    const monthPh = months.map((_, i) => `$${i + 2}`).join(", ");
    const groupPh = groupsForAudience.map((_, i) => `$${months.length + 2 + i}`).join(", ");
    const headIdx = months.length + groupsForAudience.length + 2;

    const sql = `
      SELECT
        sl.customer,
        sl.group_raw,
        sl.state_canon,
        sl.head_canon AS state_head,
        SUM(sl.amount::numeric) AS total_amount
      FROM sale_line_current sl
      WHERE sl.fy = $1
        AND sl.month_label IN (${monthPh})
        AND sl.group_raw IN (${groupPh})
        AND (sl.is_territory IS NULL OR sl.is_territory = true)
        AND ($${headIdx}::text = '' OR sl.head_canon = $${headIdx}::text)
        ${audienceFilter}
      GROUP BY sl.customer, sl.group_raw, sl.state_canon, sl.head_canon
      ORDER BY SUM(sl.amount::numeric) DESC
    `;

    const params: (string | string[])[] = [fy, ...months, ...groupsForAudience, head];
    const { rows: dbRows } = await pool.query<{
      customer: string;
      group_raw: string;
      state_canon: string | null;
      state_head: string | null;
      total_amount: string;
    }>(sql, params);

    for (const row of dbRows) {
      const customer = row.customer ?? "";
      if (!customer || isExcluded(customer)) continue;

      // Only consider scheme IDs in this audience group (not all quarterly)
      const candidateIds = (basketMap.get(row.group_raw) ?? []).filter((id) =>
        schemeIds.has(id),
      );
      if (!candidateIds.length) continue;

      const resolvedId = resolveSchemeForState(row.state_canon, candidateIds, schemeMap);
      if (!resolvedId) continue;

      const key = `${customer}|${resolvedId}`;
      const amount = parseFloat(row.total_amount ?? "0");
      const existing = buckets.get(key);
      if (existing) {
        existing.total += amount;
      } else {
        buckets.set(key, {
          customer,
          schemeId: resolvedId,
          stateHead: row.state_head,
          total: amount,
        });
      }
    }
  }

  // Compute success rows: only those who've crossed at least one ₹ slab
  // (rate != null). Trip-only slabs (rate = null) are excluded — they earn a
  // trip, not a ₹ payout, so they don't belong in the settlement breakdown.
  const rows: SuccessRow[] = [];
  for (const { customer, schemeId, stateHead, total: billedSoFar } of buckets.values()) {
    const scheme = schemeMap.get(schemeId);
    if (!scheme) continue;

    const currentSlab = getCurrentSlab(scheme.slabs, billedSoFar);
    if (!currentSlab || currentSlab.rate == null || currentSlab.rate === 0) continue;

    const nextSlab = getNextSlab(scheme.slabs, billedSoFar);
    rows.push({
      customer,
      stateHead,
      schemeId,
      basketName: scheme.name,
      family: schemeFamily(schemeId),
      settlement: scheme.settlement,
      billedSoFar,
      currentSlab: currentSlab.threshold,
      currentRate: currentSlab.rate,
      earnedRs: billedSoFar * currentSlab.rate,
      isAtMax: !nextSlab,
    });
  }

  rows.sort((a, b) => b.earnedRs - a.earnedRs);

  // Settlement and family rollups
  let totalCompanyCost = 0, totalPassThrough = 0, totalPrimary = 0;
  const familyMap = new Map<SchemeFamily, { count: number; totalEarnedRs: number; settlement: string | null }>();
  for (const r of rows) {
    if (r.settlement === "company") totalCompanyCost += r.earnedRs;
    else if (r.settlement === "pass_through") totalPassThrough += r.earnedRs;
    else if (r.settlement === "primary") totalPrimary += r.earnedRs;

    const cur = familyMap.get(r.family) ?? { count: 0, totalEarnedRs: 0, settlement: r.settlement };
    cur.count++;
    cur.totalEarnedRs += r.earnedRs;
    familyMap.set(r.family, cur);
  }

  return {
    fy,
    quarter: q,
    months,
    rows,
    totalEarnedRs: rows.reduce((s, r) => s + r.earnedRs, 0),
    totalCompanyCost,
    totalPassThrough,
    totalPrimary,
    byFamily: [...familyMap.entries()]
      .map(([family, v]) => ({ family, ...v }))
      .sort((a, b) => b.totalEarnedRs - a.totalEarnedRs),
  };
}
