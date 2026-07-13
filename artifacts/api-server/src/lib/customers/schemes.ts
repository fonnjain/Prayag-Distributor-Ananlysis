// Configurable Scheme Engine.
//
// Schemes reward customers for hitting order thresholds (value or qty).
// The engine is data-driven — no scheme is hardcoded. The client supplies
// the actual slabs via the admin screen.
//
// Laspeyres deflation is optional (usePriceMultiplier flag on the scheme).
// When enabled:
//   scheme_target   = value_LY × multiplier × (1 + desired_real_growth_pct / 100)
//   deflated_actual = actual_value / multiplier
//   achievement %   = deflated_actual / value_LY
//
// Push list: entities within 20% of the next slab threshold (or within reach
// at run-rate), sorted by effort-to-reward (smallest gap × largest benefit first).
import { pool, db, schemeDefs, schemeSlabs } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import type { SchemeDef, SchemeSlab, InsertSchemeDef, InsertSchemeSlab } from "@workspace/db";
import { resolveCustomerMultiplier, computeCompanyMultiplier, computeCategoryMultipliers, type CategoryMultiplierMap } from "./laspeyres.js";

export type { SchemeDef, SchemeSlab };

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function listSchemes(): Promise<
  Array<SchemeDef & { slabs: SchemeSlab[] }>
> {
  const defs = await db.select().from(schemeDefs).orderBy(asc(schemeDefs.id));
  if (!defs.length) return [];
  const ids = defs.map((d) => d.id);
  const allSlabs = await db
    .select()
    .from(schemeSlabs)
    .orderBy(asc(schemeSlabs.schemeId), asc(schemeSlabs.slabOrder));
  const slabMap = new Map<number, SchemeSlab[]>();
  for (const s of allSlabs) {
    const arr = slabMap.get(s.schemeId) ?? [];
    arr.push(s);
    slabMap.set(s.schemeId, arr);
  }
  return defs.map((d) => ({ ...d, slabs: slabMap.get(d.id) ?? [] }));
}

export async function getScheme(
  id: number,
): Promise<(SchemeDef & { slabs: SchemeSlab[] }) | null> {
  const [def] = await db.select().from(schemeDefs).where(eq(schemeDefs.id, id));
  if (!def) return null;
  const slabs = await db
    .select()
    .from(schemeSlabs)
    .where(eq(schemeSlabs.schemeId, id))
    .orderBy(asc(schemeSlabs.slabOrder));
  return { ...def, slabs };
}

export async function createScheme(
  input: InsertSchemeDef,
  slabs: Omit<InsertSchemeSlab, "schemeId">[],
): Promise<SchemeDef & { slabs: SchemeSlab[] }> {
  const [def] = await db.insert(schemeDefs).values(input).returning();
  if (!slabs.length) return { ...def!, slabs: [] };
  const insertedSlabs = await db
    .insert(schemeSlabs)
    .values(slabs.map((s, i) => ({ ...s, schemeId: def!.id, slabOrder: i + 1 })))
    .returning();
  return { ...def!, slabs: insertedSlabs };
}

export async function updateScheme(
  id: number,
  input: Partial<InsertSchemeDef>,
  newSlabs?: Omit<InsertSchemeSlab, "schemeId">[],
): Promise<(SchemeDef & { slabs: SchemeSlab[] }) | null> {
  const [updated] = await db
    .update(schemeDefs)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(schemeDefs.id, id))
    .returning();
  if (!updated) return null;
  if (newSlabs !== undefined) {
    await db.delete(schemeSlabs).where(eq(schemeSlabs.schemeId, id));
    if (newSlabs.length > 0) {
      await db
        .insert(schemeSlabs)
        .values(newSlabs.map((s, i) => ({ ...s, schemeId: id, slabOrder: i + 1 })));
    }
  }
  const slabs = await db
    .select()
    .from(schemeSlabs)
    .where(eq(schemeSlabs.schemeId, id))
    .orderBy(asc(schemeSlabs.slabOrder));
  return { ...updated, slabs };
}

export async function deleteScheme(id: number): Promise<boolean> {
  const result = await db
    .delete(schemeDefs)
    .where(eq(schemeDefs.id, id))
    .returning();
  return result.length > 0;
}

// ── Period helpers ─────────────────────────────────────────────────────────────

function fyToDateRange(fy: string): { start: Date; end: Date } {
  const year = parseInt(fy.split("-")[0], 10);
  return { start: new Date(year, 3, 1), end: new Date(year + 1, 2, 31) };
}

function schemePeriod(scheme: SchemeDef): { start: Date; end: Date } | null {
  if (scheme.periodStart && scheme.periodEnd) {
    return { start: new Date(scheme.periodStart), end: new Date(scheme.periodEnd) };
  }
  if (scheme.fy) return fyToDateRange(scheme.fy);
  return null;
}

function daysRemaining(end: Date): number {
  const now = new Date();
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
}

function daysElapsed(start: Date): number {
  const now = new Date();
  return Math.max(1, Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
}

// ── Achievement query ──────────────────────────────────────────────────────────

async function fetchEntityAchievements(
  scheme: SchemeDef,
  period: { start: Date; end: Date },
): Promise<Map<string, { customer: string; achievement: number; valLy: number }>> {
  const scopeCond =
    scheme.scopeType === "category" && scheme.scopeValues?.length
      ? `AND COALESCE(group_canon, group_raw, '') = ANY($3::text[])`
      : scheme.scopeType === "product_list" && scheme.scopeValues?.length
      ? `AND code = ANY($3::text[])`
      : "";

  const entityCond = scheme.namedEntityList?.length
    ? `AND customer = ANY($4::text[])`
    : "";

  const typeFilter = scheme.appliesTo.includes("direct_dealer")
    ? scheme.appliesTo.includes("distributor")
      ? ""
      : `AND type_raw ILIKE '%direct%'`
    : scheme.appliesTo.includes("distributor")
    ? `AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')`
    : "";

  const metric = scheme.basis === "qty" ? `SUM(qty::numeric)` : `SUM(amount::numeric)`;

  const params: unknown[] = [period.start, period.end];
  if (scopeCond) params.push(scheme.scopeValues ?? []);
  if (entityCond) params.push(scheme.namedEntityList ?? []);

  const res = await pool.query<{
    customer: string;
    achievement: string;
    val_ly: string;
  }>(
    `
    SELECT
      customer,
      ${metric} AS achievement,
      0 AS val_ly
    FROM sale_line
    WHERE customer IS NOT NULL
      AND invoice_date IS NOT NULL
      AND invoice_date::date >= $1::date
      AND invoice_date::date <= $2::date
      ${scopeCond}
      ${entityCond}
      ${typeFilter}
    GROUP BY customer
    `,
    params,
  );

  const map = new Map<string, { customer: string; achievement: number; valLy: number }>();
  for (const r of res.rows) {
    map.set(r.customer, {
      customer: r.customer,
      achievement: parseFloat(r.achievement ?? "0"),
      valLy: 0,
    });
  }
  return map;
}

// ── Per-entity tracking ───────────────────────────────────────────────────────

export type EntityTracking = {
  customer: string;
  achievement: number;          // current basis achievement (₹ or pcs)
  deflatedAchievement: number | null; // achievement / multiplier (when scheme uses multiplier)
  currentSlabIdx: number;       // index into slabs, -1 = none reached
  nextSlabIdx: number;          // -1 = no next slab (already at top)
  distanceToNextSlab: number | null;
  daysRemaining: number;
  projectedTotal: number;
  willReachNextSlab: boolean | null; // null = no data to project
  currentBenefitValue: number | null;
  nextBenefitValue: number | null;
  multiplier: number | null;
  multiplierLevel: string | null;
};

export async function computeSchemeTracking(
  schemeId: number,
): Promise<EntityTracking[]> {
  const scheme = await getScheme(schemeId);
  if (!scheme || !scheme.slabs.length) return [];
  const period = schemePeriod(scheme);
  if (!period) return [];

  const slabs = scheme.slabs.sort((a, b) => a.slabOrder - b.slabOrder);
  const achievements = await fetchEntityAchievements(scheme, period);
  const remaining = daysRemaining(period.end);
  const elapsed = daysElapsed(period.start);

  // Pre-compute multipliers for deflated achievement if needed
  let companyM: Awaited<ReturnType<typeof computeCompanyMultiplier>> | null = null;
  let catMap: CategoryMultiplierMap | null = null;
  const fyLy = scheme.fy
    ? `${parseInt(scheme.fy.split("-")[0], 10) - 1}-${scheme.fy.split("-")[0].slice(-2)}`
    : null;
  const fyCy = scheme.fy ?? null;

  if (scheme.usePriceMultiplier && fyLy && fyCy) {
    [companyM, catMap] = await Promise.all([
      computeCompanyMultiplier(fyLy, fyCy),
      computeCategoryMultipliers(fyLy, fyCy),
    ]);
  }

  const results: EntityTracking[] = [];

  for (const { customer, achievement } of achievements.values()) {
    let deflated: number | null = null;
    let multiplier: number | null = null;
    let multiplierLevel: string | null = null;

    if (scheme.usePriceMultiplier && fyLy && fyCy) {
      const mResult = await resolveCustomerMultiplier({
        customer,
        fyLy,
        fyCy,
        companyMultiplier: companyM ?? undefined,
        categoryMultipliers: catMap ?? undefined,
      });
      multiplier = mResult.multiplier;
      multiplierLevel = mResult.level;
      deflated = scheme.basis === "value" ? achievement / multiplier : null;
    }

    const effectiveAchievement = deflated ?? achievement;
    const thresholds = slabs.map((s) => parseFloat(s.threshold));

    let currentSlabIdx = -1;
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (effectiveAchievement >= thresholds[i]) {
        currentSlabIdx = i;
        break;
      }
    }

    const nextSlabIdx =
      currentSlabIdx < slabs.length - 1 ? currentSlabIdx + 1 : -1;
    const nextThreshold = nextSlabIdx >= 0 ? thresholds[nextSlabIdx] : null;
    const distanceToNextSlab =
      nextThreshold != null ? nextThreshold - effectiveAchievement : null;

    const runRate = elapsed > 0 ? achievement / elapsed : 0;
    const projectedTotal = achievement + runRate * remaining;
    const projEffective = deflated != null ? projectedTotal / (multiplier ?? 1) : projectedTotal;
    const willReachNextSlab =
      nextThreshold != null ? projEffective >= nextThreshold : null;

    const benefitForSlab = (idx: number): number | null => {
      if (idx < 0 || idx >= slabs.length) return null;
      const slab = slabs[idx];
      const pct = parseFloat(slab.benefitType === "pct" ? slab.benefitValue : "0");
      if (slab.benefitType === "pct") {
        return scheme.basis === "value"
          ? (achievement * pct) / 100
          : null; // can't compute ₹ benefit for qty-based schemes without a value
      }
      return parseFloat(slab.benefitValue);
    };

    results.push({
      customer,
      achievement,
      deflatedAchievement: deflated,
      currentSlabIdx,
      nextSlabIdx,
      distanceToNextSlab,
      daysRemaining: remaining,
      projectedTotal,
      willReachNextSlab,
      currentBenefitValue: benefitForSlab(currentSlabIdx),
      nextBenefitValue: benefitForSlab(nextSlabIdx),
      multiplier,
      multiplierLevel,
    });
  }

  // Sort by achievement descending
  results.sort((a, b) => b.achievement - a.achievement);
  return results;
}

// ── Push list ─────────────────────────────────────────────────────────────────

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
  effortToRewardScore: number; // lower gap, higher benefit = higher score
};

const PUSH_THRESHOLD_PCT = 0.20; // within 20% of the next slab

export async function getPushList(schemeId: number): Promise<PushListEntry[]> {
  const tracking = await computeSchemeTracking(schemeId);
  const scheme = await getScheme(schemeId);
  if (!scheme) return [];

  const slabs = scheme.slabs.sort((a, b) => a.slabOrder - b.slabOrder);

  const entries: PushListEntry[] = [];

  for (const t of tracking) {
    if (t.nextSlabIdx < 0) continue; // already at top slab
    const nextThreshold = parseFloat(slabs[t.nextSlabIdx].threshold);
    const distance = t.distanceToNextSlab ?? (nextThreshold - t.achievement);
    const pct = distance / nextThreshold;
    if (pct > PUSH_THRESHOLD_PCT && !t.willReachNextSlab) continue; // too far

    const benefitValue = t.nextBenefitValue;
    const effortToRewardScore = benefitValue != null && benefitValue > 0
      ? distance / benefitValue
      : distance;

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

  // Sort: smallest gap × largest benefit first (lowest effortToRewardScore)
  entries.sort((a, b) => a.effortToRewardScore - b.effortToRewardScore);
  return entries;
}
