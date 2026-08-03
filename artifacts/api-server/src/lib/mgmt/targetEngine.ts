// ── T1 — Engine-Generated Targets ────────────────────────────────────────────
//
// Builds target proposals from what each customer actually bought in the
// baseline year (the FY before the target FY), rather than a percentage on a
// total. This module is a GENERATOR: every figure it produces is a proposal.
// User edits live in the engine_targets table and are never overwritten by
// regeneration (the engine always recomputes; overlays are applied on read).
//
// Baseline year is DERIVED from the target FY (or from "today"), never from a
// config list — when FY2026-27 closes, it becomes the baseline automatically.

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PROJECT_HEAD_CANON } from "../sku/catalogue.js";
import { computeCategoryMultipliers, computeCompanyMultiplier } from "../customers/laspeyres.js";
import { getSeasonality, type SegmentSeasonality } from "../sku/skuK4.js";
import { loadTargetsForFy } from "./targets.js";
import { loadMemberTargetSnapshots } from "./deepDiveData.js";
import { loadDistributorTmMap } from "./distributorTmMap.js";
import { loadPrimaryAttribution } from "./primaryAttribution.js";
import { normParty, normName } from "./names.js";
import { logger } from "../logger.js";

// ── FY helpers ───────────────────────────────────────────────────────────────

export function fyForDate(d: Date): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

export function priorFy(fy: string): string {
  const y = parseInt(fy.split("-")[0], 10);
  return `${y - 1}-${String(y % 100).padStart(2, "0")}`;
}

// ── Parameters ───────────────────────────────────────────────────────────────

export type EngineWeights = { oldSku: number; newSku: number; newCustomers: number };

export type EngineParams = {
  /** Nominal target increase, percent (default 25). */
  increasePct: number;
  /** Inflation floor, percent (default 7). Used as a FLAG, never stacked. */
  inflationPct: number;
  /** Growth split between the three routes; must sum to 100. */
  weights: EngineWeights;
  /** Per-segment price multipliers; keys are segment names. */
  segMultipliers: Record<string, number>;
};

export const DEFAULT_WEIGHTS: EngineWeights = { oldSku: 25, newSku: 45, newCustomers: 30 };
/** The initially proposed split, shown side-by-side so the choice is visible. */
export const ALT_WEIGHTS: EngineWeights = { oldSku: 15, newSku: 35, newCustomers: 50 };

// ── Result types ─────────────────────────────────────────────────────────────

type SegmentRow = {
  segment: string;
  baseline: number;
  multiplier: number;
  multiplierSource: "laspeyres" | "company" | "user";
  target: number;
  /** Nominal growth net of this segment's own price increase, percent. */
  realVolumeGrowthPct: number | null;
  belowInflationFloor: boolean;
  monthShare: number[] | null;
  monthlyTarget: number[] | null;
  seasonalBasis: "segment-curve" | "flat";
};

type RollupRow = {
  key: string;
  name: string;
  stateHead?: string;
  baseline: number;
  proposed: number;
  /** Overlaid user edit, if any. */
  value: number;
  source: "generated" | "user";
  hadTarget: boolean;
};

export type EngineResult = {
  fy: string;
  baselineFy: string;
  baseline: {
    totalValue: number;
    totalRows: number;
    territoryValue: number;
    projectValue: number;
    pairCount: number;
    customerCount: number;
  };
  populations: {
    existingOldSku: { pairs: number; customers: number; baselineValue: number };
    /** Pairs = customer×code combinations where the customer bought in the
     *  baseline year but NOT this code (catalogue − bought). Zero baseline
     *  value by construction. */
    existingNewSku: { pairs: number; customers: number; distinctCodes: number; baselineValue: 0 };
    /** No baseline-year business at all → zero members in baseline data. */
    newCustomers: { pairs: 0; baselineValue: 0 };
    reconciles: boolean;
  };
  params: EngineParams & { source: "default" | "user" };
  companyMultiplier: number | null;
  realTerms: {
    nominalPct: number;
    realPct: number | null;
    context: { fy: string; valueCr: number; nominalPct: number | null; realPct: number | null }[];
  };
  combined: {
    base: number;
    growth: number;
    weights: EngineWeights;
    altWeights: EngineWeights;
    routes: {
      key: "oldSku" | "newSku" | "newCustomers";
      label: string;
      baselineValue: number;
      growthAllocated: number;
      target: number;
    }[];
    projectCarriedAtBaseline: number;
    grandTarget: number;
  };
  segments: SegmentRow[];
  oldSkuList: { customer: string; code: string; segment: string; baseline: number }[];
  headRollup: RollupRow[];
  memberRollup: RollupRow[];
  memberAttribution: {
    attributedValue: number;
    unattributedValue: number;
    mapAvailable: boolean;
    basis: "distributor-map" | "head-pro-rata" | "unavailable";
  };
  zeroTargetReport: {
    zeroTargetActiveCount: number;
    membersMoved: number;
    headsMoved: string[];
    names: string[];
    stillWithoutBaseline: string[];
  };
};

// ── Persistence (engine_targets) ─────────────────────────────────────────────

export type EngineOverride = {
  rowKey: string;
  value: unknown;
  engineValue: unknown;
  source: string;
  updatedAt: string;
};

export async function loadOverrides(fy: string): Promise<Map<string, EngineOverride>> {
  const res = await pool.query(
    `SELECT row_key, value, engine_value, source, updated_at FROM engine_targets WHERE fy = $1`,
    [fy],
  );
  const map = new Map<string, EngineOverride>();
  for (const r of res.rows) {
    map.set(r.row_key, {
      rowKey: r.row_key,
      value: r.value,
      engineValue: r.engine_value,
      source: r.source,
      updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at),
    });
  }
  return map;
}

export async function saveOverride(
  fy: string,
  rowKey: string,
  value: unknown,
  engineValue: unknown,
  updatedBy: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO engine_targets (fy, row_key, value, engine_value, source, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, 'user', $5, now())
     ON CONFLICT (fy, row_key)
     DO UPDATE SET value = $3, engine_value = $4, updated_by = $5, updated_at = now()`,
    [fy, rowKey, JSON.stringify(value), JSON.stringify(engineValue), updatedBy],
  );
}

export async function deleteOverride(fy: string, rowKey: string): Promise<void> {
  await pool.query(`DELETE FROM engine_targets WHERE fy = $1 AND row_key = $2`, [fy, rowKey]);
}

// ── Core computation ─────────────────────────────────────────────────────────

const TERRITORY = sql`(head_canon IS NULL OR head_canon != ${PROJECT_HEAD_CANON})`;

export async function computeEngineTargets(opts: {
  fy?: string;
  today?: Date;
}): Promise<EngineResult> {
  const now = opts.today ?? new Date();
  const fy = opts.fy ?? fyForDate(now);
  const baselineFy = priorFy(fy);

  const overrides = await loadOverrides(fy);

  // Parameters: defaults overlaid by a saved user params row.
  // Price pair = baseline FY → target-FY-to-date prices (what the customer
  // performance page shows): the expected price increase embedded in growth.
  const [catMap, companyRes, seasonality] = await Promise.all([
    computeCategoryMultipliers(baselineFy, fy).catch((err) => {
      logger.warn({ err }, "targetEngine: Laspeyres multipliers unavailable");
      return new Map<string, { multiplier: number }>();
    }),
    computeCompanyMultiplier(baselineFy, fy).catch(() => null),
    getSeasonality("territory").catch((err) => {
      logger.warn({ err }, "targetEngine: seasonality unavailable");
      return null;
    }),
  ]);

  // Baseline aggregates — one round trip each, all from the frozen register.
  const [totalsRes, segRes, headRes, custRes, pairsRes] = await Promise.all([
    db.execute(sql`
      SELECT count(*)::int AS rows, coalesce(sum(amount::float8), 0) AS value,
             coalesce(sum(amount::float8) FILTER (WHERE ${TERRITORY}), 0) AS territory,
             coalesce(sum(amount::float8) FILTER (WHERE head_canon = ${PROJECT_HEAD_CANON}), 0) AS project
      FROM sale_line_current WHERE fy = ${baselineFy}`),
    db.execute(sql`
      SELECT coalesce(group_canon, group_raw, 'Uncategorized') AS segment,
             sum(amount::float8) AS value
      FROM sale_line_current WHERE fy = ${baselineFy} AND ${TERRITORY}
      GROUP BY 1 ORDER BY 2 DESC`),
    db.execute(sql`
      SELECT coalesce(head_canon, 'Unmapped') AS head, sum(amount::float8) AS value
      FROM sale_line_current WHERE fy = ${baselineFy} AND ${TERRITORY}
      GROUP BY 1 ORDER BY 2 DESC`),
    db.execute(sql`
      SELECT customer, sum(amount::float8) AS value
      FROM sale_line_current WHERE fy = ${baselineFy} AND ${TERRITORY}
      GROUP BY 1`),
    db.execute(sql`
      SELECT customer, code, coalesce(group_canon, group_raw, 'Uncategorized') AS segment,
             sum(amount::float8) AS value
      FROM sale_line_current WHERE fy = ${baselineFy} AND ${TERRITORY}
      GROUP BY 1, 2, 3 ORDER BY 4 DESC`),
  ]);

  const totals = (totalsRes as any).rows?.[0] ?? (totalsRes as any)[0];
  const totalValue = Number(totals.value);
  const territoryValue = Number(totals.territory);
  const projectValue = Number(totals.project);
  const segRows = ((segRes as any).rows ?? segRes) as { segment: string; value: string }[];
  const headRows = ((headRes as any).rows ?? headRes) as { head: string; value: string }[];
  const custRows = ((custRes as any).rows ?? custRes) as { customer: string; value: string }[];
  const pairRows = ((pairsRes as any).rows ?? pairsRes) as {
    customer: string; code: string; segment: string; value: string;
  }[];

  // Params (defaults + Laspeyres per segment, overlaid by user edits).
  const companyMultiplier =
    companyRes && Number.isFinite(companyRes.multiplier) ? companyRes.multiplier : null;
  const defaultSegMults: Record<string, number> = {};
  for (const s of segRows) {
    const hit = catMap.get?.(s.segment) as { multiplier: number } | undefined;
    defaultSegMults[s.segment] =
      hit && Number.isFinite(hit.multiplier) && hit.multiplier > 0
        ? round3(hit.multiplier)
        : companyMultiplier != null
          ? round3(companyMultiplier)
          : 1;
  }

  const savedParams = overrides.get("params")?.value as Partial<EngineParams> | undefined;
  const params: EngineParams & { source: "default" | "user" } = {
    increasePct: savedParams?.increasePct ?? 25,
    inflationPct: savedParams?.inflationPct ?? 7,
    weights: normaliseWeights(savedParams?.weights) ?? { ...DEFAULT_WEIGHTS },
    segMultipliers: { ...defaultSegMults, ...(savedParams?.segMultipliers ?? {}) },
    source: savedParams ? "user" : "default",
  };

  const inc = params.increasePct / 100;
  const base = totalValue; // headline base: full baseline actuals
  const growth = base * inc;

  // Real-terms line + context (nominal from the register, real via Laspeyres).
  const realPct =
    companyMultiplier != null ? ((1 + inc) / companyMultiplier - 1) * 100 : null;
  const context = await realTermsContext(baselineFy);

  // Combined tab: weights split the GROWTH, never the total.
  const w = params.weights;
  const routes = [
    {
      key: "oldSku" as const,
      label: "Existing Sales Old SKU",
      baselineValue: territoryValue,
      growthAllocated: (growth * w.oldSku) / 100,
      target: territoryValue + (growth * w.oldSku) / 100,
    },
    {
      key: "newSku" as const,
      label: "Existing Sales New SKU",
      baselineValue: 0,
      growthAllocated: (growth * w.newSku) / 100,
      target: (growth * w.newSku) / 100,
    },
    {
      key: "newCustomers" as const,
      label: "New Customers",
      baselineValue: 0,
      growthAllocated: (growth * w.newCustomers) / 100,
      target: (growth * w.newCustomers) / 100,
    },
  ];

  // Per-segment targets with seasonal monthly split.
  const curveBySeg = new Map<string, SegmentSeasonality>(
    (seasonality?.segments ?? []).map((s) => [s.segment, s]),
  );
  const segments: SegmentRow[] = segRows.map((s) => {
    const baseline = Number(s.value);
    const mult = params.segMultipliers[s.segment] ?? 1;
    const target = baseline * (1 + inc);
    const realVol = mult > 0 ? ((1 + inc) / mult - 1) * 100 : null;
    const curve = curveBySeg.get(s.segment) ?? null;
    const monthShare = curve?.monthShare ?? null;
    return {
      segment: s.segment,
      baseline,
      multiplier: mult,
      multiplierSource:
        savedParams?.segMultipliers?.[s.segment] != null
          ? "user"
          : defaultSegMults[s.segment] !== (companyMultiplier != null ? round3(companyMultiplier) : 1)
            ? "laspeyres"
            : "company",
      target,
      realVolumeGrowthPct: realVol != null ? round1(realVol) : null,
      belowInflationFloor: realVol != null && realVol < params.inflationPct,
      monthShare,
      monthlyTarget: monthShare ? monthShare.map((sh) => target * sh) : null,
      seasonalBasis: monthShare ? "segment-curve" : "flat",
    };
  });

  // Rollups. Head level straight from the register; member level via the
  // distributor-TM map (customer → member), with the unmapped share reported.
  // Target coverage comes from the State HD Dashboard Data tab (the same
  // source the Deep Dive zero-target report uses), supplemented by any
  // explicit user saves in member_targets / Target Master.
  const [snapshots, targetsSaved] = await Promise.all([
    loadMemberTargetSnapshots(fy).catch(() => null),
    loadTargetsForFy(fy).catch(() => new Map<string, any>()),
  ]);
  const targetedKeys = new Set<string>();
  const targetedHeads = new Set<string>();
  const zeroTargetActive: { name: string; normKey: string; stateHead: string }[] = [];
  const headHasAnyTarget = new Map<string, boolean>();
  for (const s of snapshots ?? []) {
    const hasTarget =
      (s.totalTargetToDate != null && s.totalTargetToDate > 0) ||
      (s.monthlyTarget != null && s.monthlyTarget > 0);
    const headKey = normName(s.stateHead);
    if (!headHasAnyTarget.has(headKey)) headHasAnyTarget.set(headKey, false);
    if (hasTarget) {
      targetedKeys.add(s.normKey);
      targetedKeys.add(normName(s.name));
      targetedHeads.add(headKey);
      headHasAnyTarget.set(headKey, true);
    } else if (!s.isLeft) {
      zeroTargetActive.push({ name: s.name, normKey: s.normKey, stateHead: s.stateHead });
    }
  }
  for (const [key, row] of targetsSaved) {
    const annual = row?.annual ?? {};
    const anyTarget = Object.values(annual).some(
      (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
    );
    if (anyTarget) {
      targetedKeys.add(key);
      if (row?.stateHead) targetedHeads.add(normName(row.stateHead));
      if (row?.level === "STATE_HEAD") targetedHeads.add(key);
    }
  }

  const headRollup: RollupRow[] = headRows.map((h) => {
    const proposed = Number(h.value) * (1 + inc);
    const rowKey = `head|${normName(h.head)}`;
    const ov = overrides.get(rowKey);
    return {
      key: rowKey,
      name: h.head,
      baseline: Number(h.value),
      proposed,
      value: ov && typeof ov.value === "number" ? (ov.value as number) : proposed,
      source: ov ? "user" : "generated",
      hadTarget: targetedHeads.has(normName(h.head)) || targetedKeys.has(normName(h.head)),
    };
  });

  let attributedValue = 0;
  let unattributedValue = 0;
  const memberBase = new Map<string, { name: string; baseline: number }>();
  let mapAvailable = false;
  try {
    const distMap = await loadDistributorTmMap();
    mapAvailable = !distMap.error && distMap.byPartyKey.size > 0;
    if (mapAvailable) {
      for (const c of custRows) {
        const entry = distMap.byPartyKey.get(normParty(c.customer));
        const v = Number(c.value);
        if (entry) {
          attributedValue += v;
          const cur = memberBase.get(entry.memberNormKey);
          if (cur) cur.baseline += v;
          else memberBase.set(entry.memberNormKey, { name: entry.memberName, baseline: v });
        } else {
          unattributedValue += v;
        }
      }
    } else {
      unattributedValue = territoryValue;
    }
  } catch (err) {
    logger.warn({ err }, "targetEngine: distributor-TM map unavailable; member rollup skipped");
    unattributedValue = territoryValue;
  }

  // Fallback: when the distributor-TM map is unavailable, allocate each
  // head's proposal to their members pro-rata on dashboard OB (falls back to
  // sale). Members with neither stay at 0 and are surfaced separately.
  let memberBasis: "distributor-map" | "head-pro-rata" | "unavailable" = mapAvailable
    ? "distributor-map"
    : "unavailable";
  if (!mapAvailable && snapshots && snapshots.length > 0) {
    memberBasis = "head-pro-rata";
    const headBaseByKey = new Map(headRows.map((h) => [normName(h.head), Number(h.value)]));
    const byHead = new Map<string, typeof snapshots>();
    for (const s of snapshots) {
      if (s.isLeft) continue;
      const k = normName(s.stateHead);
      if (!byHead.has(k)) byHead.set(k, []);
      byHead.get(k)!.push(s);
    }
    for (const [headKey, members] of byHead) {
      const headBase = headBaseByKey.get(headKey) ?? 0;
      if (headBase <= 0) continue;
      const weights = members.map((m) => (m.obTotal > 0 ? m.obTotal : m.sale));
      const wSum = weights.reduce((a, b) => a + b, 0);
      if (wSum <= 0) continue;
      members.forEach((m, i) => {
        const share = weights[i] / wSum;
        if (share <= 0) return;
        const cur = memberBase.get(m.normKey);
        const v = headBase * share;
        if (cur) cur.baseline += v;
        else memberBase.set(m.normKey, { name: m.name, baseline: v });
        attributedValue += v;
      });
    }
    unattributedValue = Math.max(0, territoryValue - attributedValue);
  }

  const memberRollup: RollupRow[] = [...memberBase.entries()]
    .map(([normKey, m]) => {
      const proposed = m.baseline * (1 + inc);
      const rowKey = `member|${normKey}`;
      const ov = overrides.get(rowKey);
      return {
        key: rowKey,
        name: m.name,
        baseline: m.baseline,
        proposed,
        value: ov && typeof ov.value === "number" ? (ov.value as number) : proposed,
        source: (ov ? "user" : "generated") as "user" | "generated",
        hadTarget: targetedKeys.has(normKey) || targetedKeys.has(normName(m.name)),
      };
    })
    .sort((a, b) => b.baseline - a.baseline);

  // Zero-target fix: dashboard members with no target who now receive an
  // engine proposal (via attributed baseline). Members with no attributable
  // baseline are listed separately — they need a baseline source, not silence.
  const memberRollupKeys = new Set(memberRollup.map((m) => m.key));
  const zeroWithProposal = zeroTargetActive.filter(
    (z) => memberRollupKeys.has(`member|${z.normKey}`) || memberRollupKeys.has(`member|${normName(z.name)}`),
  );
  const headsMoved = headRollup
    .filter(
      (h) =>
        h.baseline > 0 &&
        h.name !== "Unmapped" &&
        headHasAnyTarget.get(normName(h.name)) === false,
    )
    .map((h) => h.name);

  const pairCount = pairRows.length;
  const customerCount = custRows.length;
  const distinctCodeCount = new Set(pairRows.map((r) => r.code)).size;
  const pairValueSum = pairRows.reduce((a, r) => a + Number(r.value), 0);
  // All baseline value sits in the old-SKU population by construction; the
  // reconciliation is territory pairs + the excluded project slice = total.
  const reconciles = Math.abs(pairValueSum + projectValue - totalValue) < 1;

  return {
    fy,
    baselineFy,
    baseline: {
      totalValue,
      totalRows: Number(totals.rows),
      territoryValue,
      projectValue,
      pairCount,
      customerCount,
    },
    populations: {
      existingOldSku: { pairs: pairCount, customers: customerCount, baselineValue: pairValueSum },
      existingNewSku: {
        // Every customer × every catalogue code they did NOT buy. Each pair
        // falls in exactly one population: bought → old SKU, not bought but
        // customer active → new SKU, customer absent → new customers.
        pairs: customerCount * distinctCodeCount - pairCount,
        customers: customerCount,
        distinctCodes: distinctCodeCount,
        baselineValue: 0,
      },
      newCustomers: { pairs: 0, baselineValue: 0 },
      reconciles,
    },
    params,
    companyMultiplier: companyMultiplier != null ? round3(companyMultiplier) : null,
    realTerms: { nominalPct: params.increasePct, realPct: realPct != null ? round1(realPct) : null, context },
    combined: {
      base,
      growth,
      weights: w,
      altWeights: { ...ALT_WEIGHTS },
      routes,
      projectCarriedAtBaseline: projectValue,
      grandTarget: base + growth,
    },
    segments,
    oldSkuList: pairRows.slice(0, 500).map((r) => ({
      customer: r.customer,
      code: r.code,
      segment: r.segment,
      baseline: Number(r.value),
    })),
    headRollup,
    memberRollup,
    memberAttribution: { attributedValue, unattributedValue, mapAvailable, basis: memberBasis },
    zeroTargetReport: {
      zeroTargetActiveCount: zeroTargetActive.length,
      membersMoved: zeroWithProposal.length,
      headsMoved,
      names: zeroTargetActive.map((m) => m.name),
      stillWithoutBaseline: zeroTargetActive
        .filter((z) => !zeroWithProposal.includes(z))
        .map((m) => m.name),
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normaliseWeights(w: Partial<EngineWeights> | undefined): EngineWeights | null {
  if (!w) return null;
  const o = Number(w.oldSku), n = Number(w.newSku), c = Number(w.newCustomers);
  if (![o, n, c].every((x) => Number.isFinite(x) && x >= 0)) return null;
  if (Math.abs(o + n + c - 100) > 0.01) return null;
  return { oldSku: o, newSku: n, newCustomers: c };
}

/** Nominal + real growth context for the loaded closed years and current YTD. */
async function realTermsContext(
  baselineFy: string,
): Promise<{ fy: string; valueCr: number; nominalPct: number | null; realPct: number | null }[]> {
  try {
    const res = await db.execute(sql`
      SELECT fy, sum(amount::float8) AS value FROM sale_line_current GROUP BY fy ORDER BY fy`);
    const rows = ((res as any).rows ?? res) as { fy: string; value: string }[];
    const byFy = new Map(rows.map((r) => [r.fy, Number(r.value)]));
    const fys = [...byFy.keys()].sort();
    const openFy = fys[fys.length - 1];
    // For the open FY, nominal must compare LIKE months (Apr–Jul vs Apr–Jul),
    // not YTD against the prior full year.
    let openFyLikePrev: number | null = null;
    if (openFy && openFy > baselineFy) {
      const monthsRes = await db.execute(sql`
        SELECT DISTINCT substring(month_label, 1, 3) AS m
        FROM sale_line_current WHERE fy = ${openFy} AND month_label IS NOT NULL`);
      const months = (((monthsRes as any).rows ?? monthsRes) as { m: string }[]).map((r) => r.m);
      if (months.length > 0) {
        const prevRes = await db.execute(sql`
          SELECT sum(amount::float8) AS value FROM sale_line_current
          WHERE fy = ${priorFy(openFy)}
            AND substring(month_label, 1, 3) IN (${sql.join(months.map((m) => sql`${m}`), sql`, `)})`);
        const v = Number((((prevRes as any).rows ?? prevRes) as any[])[0]?.value);
        if (Number.isFinite(v) && v > 0) openFyLikePrev = v;
      }
    }
    const out: { fy: string; valueCr: number; nominalPct: number | null; realPct: number | null }[] = [];
    for (const f of fys) {
      const prev = f === openFy && openFyLikePrev != null ? openFyLikePrev : byFy.get(priorFy(f));
      const nominal = prev && prev > 0 ? (byFy.get(f)! / prev - 1) * 100 : null;
      let real: number | null = null;
      if (nominal != null) {
        try {
          const cm = await computeCompanyMultiplier(priorFy(f), f);
          const mult = cm?.multiplier;
          if (mult && mult > 0) real = ((1 + nominal / 100) / mult - 1) * 100;
        } catch {
          real = null;
        }
      }
      out.push({
        fy: f,
        valueCr: round2(byFy.get(f)! / 1e7),
        nominalPct: nominal != null ? round1(nominal) : null,
        realPct: real != null ? round1(real) : null,
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "targetEngine: real-terms context unavailable");
    return [];
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

// Referenced for future member-level attribution refinement (D1-grade); the
// dist-TM map path above is the cheap, always-available bridge.
void loadPrimaryAttribution;
