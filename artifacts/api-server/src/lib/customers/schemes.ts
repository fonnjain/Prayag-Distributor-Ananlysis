// Configurable Scheme Engine — CRUD + tracking helpers for /customers/schemes.
//
// The old generic scheme_def / scheme_reward_slab tables (integer PKs) have been
// replaced by the new five-table scheme model (migration 017). Schemes now
// have stable text PKs (e.g. "CP_LALAN"). The CRUD routes use these helpers.
//
// Create / update / delete are intentionally retired — scheme data is now
// loaded from the Q2 workbook via POST /api/admin/schemes/load. Calling these
// helpers returns null / false so the route layer can issue a 405 response.
//
// computeSchemeTracking / getPushList are retained and now operate only on
// cumulative_value schemes with cumulative rupee slabs. Quantity/free-goods
// slabs (single_bill_quantity) are not covered by this engine.
//
// TERRITORY: tracking applies the scheme's territory via stateCanonsForAbbrevs,
// which inverts the territory_group.states[] abbreviations to the canonical
// sale_line.state_canon values used in the WHERE clause.
import { pool } from "@workspace/db";
import { stateCanonsForAbbrevs } from "../schemes/territoryResolver.js";
import { buildAudienceFilterSQL } from "../schemes/audienceFilter.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SchemeDef = {
  id: number;           // synthetic positional number for route compat
  schemeId: string;     // actual stable text PK (e.g. "CP_LALAN")
  name: string;
  audience: string[];
  settlement: string;
  qualificationBasis: string;
  territoryGroup: string | null;
  productScope: string | null;
  periodFrom: string;
  periodTo: string | null;
  periodNote: string | null;
};

export type SchemeSlab = {
  id: number;
  schemeId: string;
  slabOrder: number;
  thresholdFrom: string;
  thresholdTo: string | null;
  unit: string;
  rate: string | null;
  altReward: string | null;
  freeGoods: string | null;
  rewardStatus: string;
  rawText: string | null;
};

// ── CRUD (read-only) ──────────────────────────────────────────────────────────

export async function listSchemes(): Promise<Array<SchemeDef & { slabs: SchemeSlab[] }>> {
  const [schemesRes, slabsRes] = await Promise.all([
    pool.query<{
      scheme_id: string; name: string; audience: string[]; settlement: string;
      qualification_basis: string; territory_group: string | null;
      product_scope: string | null; period_from: string; period_to: string | null;
      period_note: string | null;
    }>(`SELECT * FROM scheme ORDER BY scheme_id`),
    pool.query<{
      id: number; scheme_id: string; slab_order: number; threshold_from: string;
      threshold_to: string | null; unit: string; rate: string | null; alt_reward: string | null;
      free_goods: string | null; reward_status: string; raw_text: string | null;
    }>(`SELECT * FROM scheme_reward_slab ORDER BY scheme_id, slab_order`),
  ]);

  const slabsByScheme = new Map<string, SchemeSlab[]>();
  for (const row of slabsRes.rows) {
    const arr = slabsByScheme.get(row.scheme_id) ?? [];
    arr.push({
      id: row.id,
      schemeId: row.scheme_id,
      slabOrder: row.slab_order,
      thresholdFrom: row.threshold_from,
      thresholdTo: row.threshold_to,
      unit: row.unit,
      rate: row.rate,
      altReward: row.alt_reward,
      freeGoods: row.free_goods,
      rewardStatus: row.reward_status,
      rawText: row.raw_text,
    });
    slabsByScheme.set(row.scheme_id, arr);
  }

  return schemesRes.rows.map((row, idx) => ({
    id: idx + 1,
    schemeId: row.scheme_id,
    name: row.name,
    audience: row.audience,
    settlement: row.settlement,
    qualificationBasis: row.qualification_basis,
    territoryGroup: row.territory_group,
    productScope: row.product_scope,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    periodNote: row.period_note,
    slabs: slabsByScheme.get(row.scheme_id) ?? [],
  }));
}

/** Return the scheme at synthetic position id (1-based, sorted by scheme_id). */
export async function getScheme(
  id: number,
): Promise<(SchemeDef & { slabs: SchemeSlab[] }) | null> {
  const schemes = await listSchemes();
  return schemes[id - 1] ?? null;
}

/** Retired — scheme data is managed via POST /api/admin/schemes/load. */
export async function createScheme(): Promise<null> {
  return null; // route layer should return 405
}

/** Retired — scheme data is managed via POST /api/admin/schemes/load. */
export async function updateScheme(): Promise<null> {
  return null; // route layer should return 405
}

/** Retired — scheme data is managed via POST /api/admin/schemes/load. */
export async function deleteScheme(): Promise<false> {
  return false; // route layer should return 405
}

// ── Period helpers ─────────────────────────────────────────────────────────────

function daysRemaining(end: Date): number {
  const now = new Date();
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

function daysElapsed(start: Date): number {
  const now = new Date();
  return Math.max(1, Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
}

// ── Achievement query ──────────────────────────────────────────────────────────
// Only cumulative rupee (cumulative_value) schemes are supported here.
// single_bill_quantity / single_bill_value / free-goods slabs are not tracked.

async function fetchEntityAchievements(
  scheme: SchemeDef,
  period: { start: Date; end: Date },
): Promise<Map<string, { customer: string; achievement: number }>> {
  if (scheme.qualificationBasis !== "cumulative_value") return new Map();

  // ── Audience filter ───────────────────────────────────────────────────────
  // Uses distributor_identity to exclude known distributors for sub_dealer audience.
  // See audienceFilter.ts for the full audience → customer-type mapping.
  const audienceFilter = buildAudienceFilterSQL(scheme.audience, "sl");

  // ── Territory filter ──────────────────────────────────────────────────────
  // territory_group.states[] stores abbreviations (e.g. "WB", "WUP") while
  // sale_line.state_canon stores full canonical names ("WEST BENGAL", "UP (A)").
  // We invert via stateCanonsForAbbrevs so the WHERE clause uses state_canon.
  const params: (Date | string | string[])[] = [period.start, period.end];
  let territoryClause = "";
  if (scheme.territoryGroup) {
    const tgRes = await pool.query<{ states: string[] }>(
      `SELECT states FROM territory_group WHERE group_raw = $1`,
      [scheme.territoryGroup],
    );
    const abbrevs = tgRes.rows[0]?.states ?? [];
    const validStateCanons = stateCanonsForAbbrevs(abbrevs);
    if (validStateCanons.length > 0) {
      params.push(validStateCanons);
      territoryClause = `AND sl.state_canon = ANY($${params.length}::text[])`;
    }
  }

  // ── Product scope filter via scheme_item_group ────────────────────────────
  // Restrict to only the group_raw values mapped to this scheme. This enforces
  // the Q2 workbook's product scope (e.g. CP scheme counts only CP sales).
  // If the basket is empty, return no results — never silently treat as "all
  // products" since that would inflate achievement and advance uneligible slabs.
  const igRes = await pool.query<{ item_group: string }>(
    `SELECT item_group FROM scheme_item_group WHERE scheme_id = $1`,
    [scheme.schemeId],
  );
  const itemGroups = igRes.rows.map((r) => r.item_group);
  if (!itemGroups.length) {
    // No basket mapping — product scope unknown; return empty to be safe.
    return new Map();
  }
  params.push(itemGroups);
  const itemGroupClause = `AND sl.group_raw = ANY($${params.length}::text[])`;

  const res = await pool.query<{
    customer: string;
    achievement: string;
  }>(
    `
    SELECT
      sl.customer,
      SUM(sl.amount::numeric) AS achievement
    FROM sale_line_current sl
    WHERE sl.customer IS NOT NULL
      AND sl.invoice_date IS NOT NULL
      AND sl.invoice_date::date >= $1::date
      AND sl.invoice_date::date <= $2::date
      AND (sl.is_territory IS NULL OR sl.is_territory = true)
      ${audienceFilter}
      ${territoryClause}
      ${itemGroupClause}
    GROUP BY sl.customer
    `,
    params,
  );

  const map = new Map<string, { customer: string; achievement: number }>();
  for (const r of res.rows) {
    map.set(r.customer, {
      customer: r.customer,
      achievement: parseFloat(r.achievement ?? "0"),
    });
  }
  return map;
}

// ── Per-entity tracking ────────────────────────────────────────────────────────

export type EntityTracking = {
  customer: string;
  achievement: number;
  currentSlabIdx: number;
  nextSlabIdx: number;
  distanceToNextSlab: number | null;
  daysRemaining: number;
  projectedTotal: number;
  willReachNextSlab: boolean | null;
  currentBenefitValue: number | null;
  nextBenefitValue: number | null;
};

export async function computeSchemeTracking(
  schemeIdNum: number,
): Promise<EntityTracking[]> {
  const scheme = await getScheme(schemeIdNum);
  // Only track cumulative_value schemes — quantity/free-goods slabs are not
  // supported by this value-based achievement calculator.
  if (!scheme || scheme.qualificationBasis !== "cumulative_value") return [];
  if (!scheme.slabs.length) return [];

  // Derive period from scheme's periodFrom/periodTo
  if (!scheme.periodFrom) return [];
  const start = new Date(scheme.periodFrom);
  const end = scheme.periodTo ? new Date(scheme.periodTo) : new Date();

  const slabs = [...scheme.slabs].sort((a, b) => a.slabOrder - b.slabOrder);
  const achievements = await fetchEntityAchievements(scheme, { start, end });
  const remaining = daysRemaining(end);
  const elapsed = daysElapsed(start);

  const results: EntityTracking[] = [];

  for (const { customer, achievement } of achievements.values()) {
    const thresholds = slabs.map((s) => parseFloat(s.thresholdFrom));

    let currentSlabIdx = -1;
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (achievement >= thresholds[i]) {
        currentSlabIdx = i;
        break;
      }
    }

    const nextSlabIdx =
      currentSlabIdx < slabs.length - 1 ? currentSlabIdx + 1 : -1;
    const nextThreshold = nextSlabIdx >= 0 ? thresholds[nextSlabIdx] : null;
    const distanceToNextSlab =
      nextThreshold != null ? nextThreshold - achievement : null;

    const runRate = elapsed > 0 ? achievement / elapsed : 0;
    const projectedTotal = achievement + runRate * remaining;
    const willReachNextSlab =
      nextThreshold != null ? projectedTotal >= nextThreshold : null;

    const benefitForSlab = (idx: number): number | null => {
      if (idx < 0 || idx >= slabs.length) return null;
      const slab = slabs[idx];
      if (slab.rewardStatus === "needs_clarification") return null;
      const rate = slab.rate != null ? parseFloat(slab.rate) : null;
      if (rate == null) return null;
      return achievement * rate;
    };

    results.push({
      customer,
      achievement,
      currentSlabIdx,
      nextSlabIdx,
      distanceToNextSlab,
      daysRemaining: remaining,
      projectedTotal,
      willReachNextSlab,
      currentBenefitValue: benefitForSlab(currentSlabIdx),
      nextBenefitValue: benefitForSlab(nextSlabIdx),
    });
  }

  results.sort((a, b) => b.achievement - a.achievement);
  return results;
}

// ── Push list ──────────────────────────────────────────────────────────────────

export type PushListEntry = {
  customer: string;
  achievement: number;
  nextSlabThreshold: number;
  distanceToNextSlab: number;
  daysRemaining: number;
  projectedTotal: number;
  projectedShortfall: number;
  willReachNextSlab: boolean;
  nextBenefitValue: number | null;
  effortToRewardScore: number;
};

const PUSH_THRESHOLD_PCT = 0.20;

export async function getPushList(schemeId: number): Promise<PushListEntry[]> {
  const tracking = await computeSchemeTracking(schemeId);
  const scheme = await getScheme(schemeId);
  if (!scheme) return [];

  const slabs = [...scheme.slabs].sort((a, b) => a.slabOrder - b.slabOrder);
  const entries: PushListEntry[] = [];

  for (const t of tracking) {
    if (t.nextSlabIdx < 0) continue;
    const nextThreshold = parseFloat(slabs[t.nextSlabIdx].thresholdFrom);
    const distance = t.distanceToNextSlab ?? (nextThreshold - t.achievement);
    const pct = distance / nextThreshold;
    if (pct > PUSH_THRESHOLD_PCT && !t.willReachNextSlab) continue;

    const benefitValue = t.nextBenefitValue;
    const effortToRewardScore =
      benefitValue != null && benefitValue > 0 ? distance / benefitValue : distance;

    entries.push({
      customer: t.customer,
      achievement: t.achievement,
      nextSlabThreshold: nextThreshold,
      distanceToNextSlab: distance,
      daysRemaining: t.daysRemaining,
      projectedTotal: t.projectedTotal,
      projectedShortfall: Math.max(0, nextThreshold - t.projectedTotal),
      willReachNextSlab: t.willReachNextSlab ?? false,
      nextBenefitValue: benefitValue,
      effortToRewardScore,
    });
  }

  entries.sort((a, b) => a.effortToRewardScore - b.effortToRewardScore);
  return entries;
}
