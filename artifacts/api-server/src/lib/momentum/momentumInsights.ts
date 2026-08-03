// ── M1 — Momentum insights ────────────────────────────────────────────────────
// Momentum is about RATE and DIRECTION, not level. Every rate here is either
// shown in real terms / against a seasonal curve, or explicitly labelled raw.
//
// NO NEW COMPUTATION where a service already exists — this module composes:
//   • the Laspeyres index        (lib/customers/laspeyres.ts)
//   • the seasonal curve         (lib/seasonal.ts — company monthly shares)
//   • segment seasonality        (lib/sku/skuK4.ts getSeasonality)
//   • first-order / lost codes   (lib/sku/skuK4.ts)
//   • at-risk scoring            (lib/customers/analytics.ts getAtRisk)
//   • member KPIs (Data tab)     (lib/mgmt/deepDiveData.ts)
//   • the register (period-exact secondary OB per member)
//
// Guards follow the comparison contract: like months only, real terms on every
// cross-year figure, territory channel by default with the label stated, a
// partial month excluded from any rate, LEFT members excluded, zero-target /
// no-business reported as such, never as zero.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PROJECT_HEAD_CANON } from "../sku/catalogue.js";
import { computeCompanyMultiplier } from "../customers/laspeyres.js";
import {
  getSeasonality,
  getFirstOrderCodes,
  getLostCodes,
  getProjectCustomerSet,
  territoryFilterSql,
} from "../sku/skuK4.js";
import { getAtRisk } from "../customers/analytics.js";
import { monthlyShare, getSeasonalCalibration } from "../seasonal.js";
import { fiscalMonthsToLabels } from "../mgmt/primaryPeriod.js";
import { loadDeepDiveData } from "../mgmt/deepDiveData.js";
import { priorFy } from "../mgmt/targetEngine.js";
import { logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MomentumFlag = {
  id: string;
  rank: number;
  severity: "red" | "orange" | "yellow";
  title: string;
  /** How big — a flag without a size is not actionable. */
  size: string;
  sizeValue: number; // rupees (or pp scaled) used for ranking
  entities: string[];
  since: string | null;
  evidence: string;
  corrective: { label: string; href: string; ease: 1 | 2 | 3; easeLabel: string };
};

export type LeadingIndicator = {
  id: string;
  label: string;
  current: number | null;
  currentValue?: number | null; // rupees where applicable
  prior: number | null;
  note: string;
  direction: "up" | "down" | "flat" | null;
  href?: string;
};

export type MomentumInsights = {
  meta: {
    fy: string;
    likeMonths: string[];
    priorLikeMonths: string[];
    channel: "territory";
    channelLabel: string;
    latestMonthNote: string | null;
    generatedAt: string;
    guards: string[];
  };
  headline: {
    nominal: { current: number; prior: number; growthPct: number | null };
    real: { index: number | null; indexName: string | null; currentReal: number | null; growthPct: number | null };
    series: { fy: string; nominalPct: number | null; realPct: number | null; index: number | null }[];
    consecutiveRealDeclines: number;
  };
  acceleration: {
    months: { month: string; yoyPct: number | null; seasonalNote: string }[];
    latestRate: number | null;
    previousRate: number | null;
    direction: "accelerating" | "decelerating" | "flat" | null;
  };
  runRate: {
    ytd: number;
    curveShareOfYear: number;
    curveName: string;
    projection: number | null;
    flatProjection: number;
    priorFyTotal: number | null;
    note: string;
  };
  pipeline: {
    months: { month: string; booking: number; dispatch: number; pending: number; pendingShare: number | null }[];
    totals: { booking: number; dispatch: number; pending: number; pendingShare: number | null };
    direction: "rising" | "falling" | "flat" | null;
    directionNote: string;
  };
  leading: LeadingIndicator[];
  redFlags: MomentumFlag[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthIn(labels: string[]) {
  return sql`month_label IN (${sql.join(labels.map((l) => sql`${l}`), sql`, `)})`;
}

async function one(q: ReturnType<typeof sql>): Promise<Record<string, any>> {
  const r = await db.execute(q);
  return (r.rows?.[0] ?? {}) as Record<string, any>;
}
async function all(q: ReturnType<typeof sql>): Promise<Record<string, any>[]> {
  const r = await db.execute(q);
  return (r.rows ?? []) as Record<string, any>[];
}

function pct(cur: number, base: number): number | null {
  return base > 0 ? Math.round(((cur - base) / base) * 1000) / 10 : null;
}
function r2(n: number): number { return Math.round(n * 100) / 100; }
function cr(n: number): number { return r2(n / 1e7); }

/** Closed fiscal months of the FY: calendar month fully ended before today. */
function closedMonthCount(fy: string, today: Date): number {
  const startYear = parseInt(fy.slice(0, 4), 10);
  const fyStart = new Date(Date.UTC(startYear, 3, 1)); // Apr 1
  let n = (today.getUTCFullYear() - fyStart.getUTCFullYear()) * 12 + (today.getUTCMonth() - 3);
  // The month we are IN is partial — exclude it from any rate.
  return Math.max(0, Math.min(12, n));
}

// ── Main build ────────────────────────────────────────────────────────────────

let _cache: { key: string; at: number; data: MomentumInsights } | null = null;
const TTL_MS = 30 * 60_000;

export async function buildMomentumInsights(
  fy: string,
  requestedLabels: string[] | null,
  today: Date = new Date(),
): Promise<MomentumInsights> {
  const cacheKey = `${fy}|${(requestedLabels ?? []).join(",")}|${today.toISOString().slice(0, 10)}`;
  if (_cache && _cache.key === cacheKey && Date.now() - _cache.at < TTL_MS) return _cache.data;

  const nClosed = closedMonthCount(fy, today);
  if (nClosed === 0) throw new Error(`FY${fy} has no closed month yet — momentum needs at least one complete month`);
  const closedLabels = fiscalMonthsToLabels(fy, 1, nClosed);

  // Global month filter: intersect with closed months (a partial month is
  // excluded from any rate — guard). Never silently substitute a different
  // period: an all-incomplete selection is an explicit error, not YTD.
  let likeMonths = closedLabels;
  let filteredNote: string | null = null;
  if (requestedLabels && requestedLabels.length > 0) {
    const closedSet = new Set(closedLabels);
    likeMonths = requestedLabels.filter((l) => closedSet.has(l));
    const dropped = requestedLabels.filter((l) => !closedSet.has(l));
    if (likeMonths.length === 0) {
      throw new Error(
        `No complete month in the selected period — ${dropped.join(", ")} ${dropped.length === 1 ? "is" : "are"} not finished yet, and a partial month is excluded from every rate`,
      );
    }
    if (dropped.length > 0) filteredNote = `excluded from rates (not complete months): ${dropped.join(", ")}`;
  }
  const monthIdx = likeMonths.map((l) => closedLabels.indexOf(l) + 1); // fiscal 1-based

  // Territory basis: historical FYs carry no head attribution on many rows, so
  // NULL-head rows must go through the project-customer bridge (same rule as
  // the SKU services), not be blanket-included.
  const terr = territoryFilterSql(await getProjectCustomerSet());

  const fys = [fy, priorFy(fy), priorFy(priorFy(fy)), priorFy(priorFy(priorFy(fy)))]; // e.g. 26-27, 25-26, 24-25, 23-24
  const labelsFor = (f: string) => monthIdx.map((i) => fiscalMonthsToLabels(f, i, i)[0]);

  // ── Parallel loads ──
  const [sums, multipliers, seasonality, deepDive, atRiskRows, firstOrders, lostCodes] = await Promise.all([
    // like-months territory sale per FY
    Promise.all(fys.map((f) =>
      one(sql`SELECT coalesce(sum(amount::float8),0) AS v, count(DISTINCT upper(trim(customer)))::int AS custs
              FROM sale_line_current WHERE fy = ${f} AND ${monthIn(labelsFor(f))} AND ${terr}`),
    )),
    Promise.all([0, 1, 2].map((i) => computeCompanyMultiplier(fys[i + 1], fys[i]).catch(() => null))),
    getSeasonality("territory").catch(() => null),
    loadDeepDiveData(fy).catch(() => null),
    getAtRisk({}).catch(() => null), // null = unavailable, never an empty (zero) list
    getFirstOrderCodes(fy, likeMonths, null).catch(() => null),
    getLostCodes(fy, priorFy(fy)).catch(() => null),
  ]);

  // ── 1. Headline ──
  const cur = Number(sums[0].v), prior = Number(sums[1].v);
  const series = [2, 1, 0].map((i) => {
    // pair fys[i+1] -> fys[i]
    const c = Number(sums[i].v), b = Number(sums[i + 1].v);
    const m = multipliers[i]?.multiplier ?? null;
    return {
      fy: fys[i],
      nominalPct: pct(c, b),
      realPct: m != null && b > 0 ? pct(c / m, b) : null,
      index: m != null ? Math.round(m * 1000) / 1000 : null,
    };
  });
  const consecutiveRealDeclines = (() => {
    let n = 0;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].realPct != null && (series[i].realPct as number) < 0) n++;
      else break;
    }
    return n;
  })();
  const idx0 = multipliers[0]?.multiplier ?? null;
  const headline: MomentumInsights["headline"] = {
    nominal: { current: cr(cur), prior: cr(prior), growthPct: pct(cur, prior) },
    real: {
      index: idx0 != null ? Math.round(idx0 * 1000) / 1000 : null,
      indexName: idx0 != null ? `Laspeyres company (${fys[1]}→${fy}), realised prices on shared codes` : null,
      currentReal: idx0 != null ? cr(cur / idx0) : null,
      growthPct: idx0 != null && prior > 0 ? pct(cur / idx0, prior) : null,
    },
    series,
    consecutiveRealDeclines,
  };

  // ── 2. Acceleration — the change in the RATE, not the level ──
  // Scoped to the same selected complete months as every other panel.
  const priorAll = labelsFor(fys[1]);
  const monthlyCur = await all(sql`
    SELECT month_label, sum(amount::float8) AS v FROM sale_line_current
    WHERE fy = ${fy} AND ${monthIn(likeMonths)} AND ${terr} GROUP BY 1`);
  const monthlyPrior = await all(sql`
    SELECT month_label, sum(amount::float8) AS v FROM sale_line_current
    WHERE fy = ${fys[1]} AND ${monthIn(priorAll)} AND ${terr} GROUP BY 1`);
  const curMap = new Map(monthlyCur.map((r) => [r.month_label as string, Number(r.v)]));
  const priMap = new Map(monthlyPrior.map((r) => [r.month_label as string, Number(r.v)]));
  const accelMonths = likeMonths.map((l, i) => {
    const pl = priorAll[i];
    const c = curMap.get(l) ?? 0, b = priMap.get(pl) ?? 0;
    return {
      month: l,
      yoyPct: pct(c, b),
      seasonalNote: "like month vs like month — the seasonal shape cancels out by construction",
    };
  });
  const latestRate = accelMonths[accelMonths.length - 1]?.yoyPct ?? null;
  const previousRate = accelMonths[accelMonths.length - 2]?.yoyPct ?? null;
  const acceleration: MomentumInsights["acceleration"] = {
    months: accelMonths,
    latestRate,
    previousRate,
    direction:
      latestRate == null || previousRate == null ? null
      : latestRate > previousRate + 0.5 ? "accelerating"
      : latestRate < previousRate - 0.5 ? "decelerating" : "flat",
  };

  // ── 3. Run rate — on the seasonal curve, never flat ──
  const cal = getSeasonalCalibration();
  // Fraction of the year the SELECTED complete months normally carry
  // (monthlyShare is 0-based; monthIdx is 1-based fiscal).
  const shareOfYear = monthIdx.reduce((s, i) => s + monthlyShare(i - 1), 0) * 100;
  const ytd = cur; // same selected months, same territory basis as the headline
  const priorTotal = await one(sql`
    SELECT coalesce(sum(amount::float8),0) AS v FROM sale_line_current WHERE fy = ${fys[1]} AND ${terr}`);
  const runRate: MomentumInsights["runRate"] = {
    ytd: cr(ytd),
    curveShareOfYear: r2(shareOfYear),
    curveName: `company monthly shares calibrated on FY${cal.fy} actuals (lib/seasonal)`,
    projection: shareOfYear > 0 ? cr(ytd / (shareOfYear / 100)) : null,
    flatProjection: cr((ytd / nClosed) * 12),
    priorFyTotal: cr(Number(priorTotal.v)),
    note: `the closed months normally carry ${r2(shareOfYear)}% of the year on this curve — a flat extrapolation would ${shareOfYear < (nClosed / 12) * 100 ? "UNDERSTATE" : "OVERSTATE"} the year`,
  };

  // ── 4. Pipeline — booking, dispatch, pending share; the direction is the signal ──
  const bookingRows = await all(sql`
    SELECT month_label, sum(taxable_value::float8) AS v FROM primary_order_line
    WHERE fy = ${fy} AND ${monthIn(likeMonths)} AND is_territory GROUP BY 1`);
  const bookMap = new Map(bookingRows.map((r) => [r.month_label as string, Number(r.v)]));
  const pipeMonths = likeMonths.map((l) => {
    const booking = bookMap.get(l) ?? 0;
    const dispatch = curMap.get(l) ?? 0;
    const pending = booking - dispatch;
    return {
      month: l,
      booking: cr(booking),
      dispatch: cr(dispatch),
      pending: cr(pending),
      pendingShare: booking > 0 ? r2((pending / booking) * 100) : null,
    };
  });
  const totB = pipeMonths.reduce((s, m) => s + m.booking, 0);
  const totD = pipeMonths.reduce((s, m) => s + m.dispatch, 0);
  const shares = pipeMonths.map((m) => m.pendingShare).filter((s): s is number => s != null);
  const lastShare = shares[shares.length - 1] ?? null;
  const prevShare = shares[shares.length - 2] ?? null;
  const pipeDir =
    lastShare == null || prevShare == null ? null
    : lastShare > prevShare + 0.5 ? "rising" as const
    : lastShare < prevShare - 0.5 ? "falling" as const : "flat" as const;
  const pipeline: MomentumInsights["pipeline"] = {
    months: pipeMonths,
    totals: { booking: r2(totB), dispatch: r2(totD), pending: r2(totB - totD), pendingShare: totB > 0 ? r2(((totB - totD) / totB) * 100) : null },
    direction: pipeDir,
    directionNote:
      pipeDir === "rising" ? "rising — orders are being taken faster than they can be served"
      : pipeDir === "falling" ? "falling — demand softening ahead of the revenue line"
      : pipeDir === "flat" ? "flat month on month" : "not enough closed months to read a direction",
  };

  // ── 5. Leading indicators ──
  const likeMonthsPrior = labelsFor(fys[1]);
  const [newCust, newSku, breadth, discount] = await Promise.all([
    one(sql`
      WITH base AS (SELECT DISTINCT upper(trim(customer)) AS c FROM sale_line_current WHERE fy = ${fys[1]} AND ${terr}),
      cur AS (SELECT upper(trim(customer)) AS c, sum(amount::float8) AS v FROM sale_line_current
              WHERE fy = ${fy} AND ${monthIn(likeMonths)} AND ${terr} GROUP BY 1)
      SELECT count(*)::int AS n, coalesce(sum(cur.v),0) AS v FROM cur
      WHERE cur.c IS NOT NULL AND NOT EXISTS (SELECT 1 FROM base WHERE base.c = cur.c)`),
    one(sql`
      WITH base AS (SELECT DISTINCT upper(trim(customer)) AS c, code FROM sale_line_current WHERE fy = ${fys[1]} AND ${terr}),
      base_cust AS (SELECT DISTINCT c FROM base),
      cur AS (SELECT upper(trim(customer)) AS c, code, sum(amount::float8) AS v FROM sale_line_current
              WHERE fy = ${fy} AND ${monthIn(likeMonths)} AND ${terr} GROUP BY 1, 2)
      SELECT count(*)::int AS n, coalesce(sum(cur.v),0) AS v
      FROM cur JOIN base_cust USING (c)
      LEFT JOIN base ON base.c = cur.c AND base.code = cur.code
      WHERE base.code IS NULL`),
    all(sql`
      WITH cur AS (SELECT upper(trim(customer)) AS c, count(DISTINCT code)::int AS n FROM sale_line_current
                   WHERE fy = ${fy} AND ${monthIn(likeMonths)} AND ${terr} GROUP BY 1),
      pri AS (SELECT upper(trim(customer)) AS c, count(DISTINCT code)::int AS n, sum(amount::float8) AS v FROM sale_line_current
              WHERE fy = ${fys[1]} AND ${monthIn(likeMonthsPrior)} AND ${terr} GROUP BY 1)
      SELECT pri.c AS customer, pri.n AS prior_codes, coalesce(cur.n,0) AS cur_codes, pri.v AS prior_value
      FROM pri LEFT JOIN cur USING (c)
      WHERE coalesce(cur.n,0) < pri.n AND pri.n >= 3
      ORDER BY pri.v DESC`),
    one(sql`
      SELECT
        (SELECT sum(discount_pct::float8 * net_amount::float8) / nullif(sum(net_amount::float8),0)
         FROM secondary_sku_line WHERE fy = ${fy} AND ${monthIn(likeMonths)} AND discount_pct IS NOT NULL) AS cur_d,
        (SELECT sum(discount_pct::float8 * net_amount::float8) / nullif(sum(net_amount::float8),0)
         FROM secondary_sku_line WHERE fy = ${fys[1]} AND ${monthIn(likeMonthsPrior)} AND discount_pct IS NOT NULL) AS pri_d,
        (SELECT coalesce(sum(net_amount::float8),0) FROM secondary_sku_line WHERE fy = ${fy} AND ${monthIn(likeMonths)}) AS cur_v,
        (SELECT coalesce(sum(net_amount::float8),0) FROM secondary_sku_line WHERE fy = ${fys[1]} AND ${monthIn(likeMonthsPrior)}) AS pri_v`),
  ]);

  const atRiskAvailable = atRiskRows != null;
  const atRiskHigh = (atRiskRows ?? []).filter((r) => r.riskLevel === "high");
  // Prior-FY value of at-risk customers (for size + concentration).
  const atRiskNames = (atRiskRows ?? []).map((r) => r.customer.toUpperCase().trim());
  const atRiskValues = atRiskNames.length > 0
    ? await all(sql`
        SELECT upper(trim(customer)) AS c, sum(amount::float8) AS v FROM sale_line_current
        WHERE fy = ${fys[1]} AND ${terr} AND upper(trim(customer)) IN (${sql.join(atRiskNames.slice(0, 800).map((n) => sql`${n}`), sql`, `)})
        GROUP BY 1 ORDER BY 2 DESC`)
    : [];
  const atRiskTotalValue = atRiskValues.reduce((s, r) => s + Number(r.v), 0);

  const firstOrderCount = firstOrders ? firstOrders.customers.reduce((s, c) => s + c.codes.length, 0) : null;
  const firstOrderValue = firstOrders ? firstOrders.customers.reduce((s, c) => s + c.totalNet, 0) : null;
  const curD = discount.cur_d != null ? Number(discount.cur_d) : null;
  const priD = discount.pri_d != null ? Number(discount.pri_d) : null;
  const secVolGrowth = pct(Number(discount.cur_v), Number(discount.pri_v));

  const leading: LeadingIndicator[] = [
    { id: "newCustomers", label: "New customers (vs none in all of FY" + fys[1] + ")",
      current: Number(newCust.n), currentValue: cr(Number(newCust.v)), prior: null,
      note: "primary register; baseline = the whole prior FY so seasonality cannot fake newness",
      direction: Number(newCust.n) > 0 ? "up" : "flat", href: "/customers" },
    { id: "newSkusExisting", label: "New SKUs placed with existing customers",
      current: Number(newSku.n), currentValue: cr(Number(newSku.v)), prior: null,
      note: "(customer, code) pairs new against the whole prior FY — primary register",
      direction: Number(newSku.n) > 0 ? "up" : "flat", href: "/sku" },
    { id: "firstOrderCodes", label: "First-order codes (fastest proof a push worked)",
      current: firstOrderCount, currentValue: firstOrderValue != null ? cr(firstOrderValue) : null, prior: null,
      note: firstOrders ? "codes bought for the first time ever in the period — SKU service" : "SKU service unavailable",
      direction: null, href: "/sku" },
    { id: "breadthNarrowing", label: "Customers whose code count is narrowing",
      current: breadth.length, currentValue: cr(breadth.reduce((s, r) => s + Number(r.prior_value ?? 0), 0)), prior: null,
      note: `like months vs like months, customers with ≥3 prior codes; value shown = their prior-period business at stake`,
      direction: breadth.length > 0 ? "down" : "flat", href: "/sku" },
    { id: "atRisk", label: "At-risk customers (bought before, overdue on their own cycle)",
      current: atRiskAvailable ? atRiskRows!.length : null,
      currentValue: atRiskAvailable ? cr(atRiskTotalValue) : null, prior: null,
      note: atRiskAvailable
        ? `${atRiskHigh.length} high (>2× their median gap); value = their FY${fys[1]} business — median-gap scoring`
        : "not available right now — the at-risk service failed to load; this is NOT a zero",
      direction: atRiskAvailable ? (atRiskRows!.length > 0 ? "down" : "flat") : null, href: "/customers" },
    { id: "effectiveDiscount", label: "Effective discount trend (secondary register)",
      current: curD != null ? r2(curD) : null, prior: priD != null ? r2(priD) : null,
      note: curD == null || priD == null
        ? "not recorded — secondary SKU register discount missing for one of the periods"
        : `net-weighted %, like months YoY; secondary volume ${secVolGrowth != null ? (secVolGrowth >= 0 ? "+" : "") + secVolGrowth + "%" : "n/a"}`,
      direction: curD != null && priD != null ? (curD > priD + 0.25 ? "up" : curD < priD - 0.25 ? "down" : "flat") : null,
      href: "/sku" },
  ];

  // ── 6. Red flags — computed, ranked by severity, each with size + entities + since ──
  const flags: MomentumFlag[] = [];
  const corr = {
    push:     { label: "SKU push list (tiered, named peers)", href: "/sku", ease: 1 as const, easeLabel: "easiest — shelf space and relationship already exist" },
    winback:  { label: "Win-back list, ranked by prior-year value", href: "/customers", ease: 2 as const, easeLabel: "known customer, proven demand" },
    assign:   { label: "Assignment gap — an administrative fix", href: "/warnings", ease: 1 as const, easeLabel: "fastest available — no selling required" },
    lost:     { label: "Lost codes — proven demand, known customer", href: "/sku", ease: 1 as const, easeLabel: "warmest list in the app" },
    discount: { label: "Discount variance report, per code", href: "/sku", ease: 2 as const, easeLabel: "pricing discipline, not new selling" },
    compare:  { label: "Comparison matrix — that entity's trajectory", href: "/comparison", ease: 2 as const, easeLabel: "diagnose before acting" },
  };

  // REAL DECLINE
  if (headline.real.growthPct != null && headline.real.growthPct < 0) {
    const realGap = idx0 != null ? prior - cur / idx0 : 0;
    flags.push({
      id: "realDecline", rank: 0, severity: "red",
      title: "Real decline — growth below the price index",
      size: `₹${cr(realGap)} Cr of real volume vs like months last year (${headline.real.growthPct}% real)`,
      sizeValue: realGap,
      entities: ["company"],
      since: consecutiveRealDeclines > 1 ? `${consecutiveRealDeclines} consecutive FYs` : fy,
      evidence: `nominal ${headline.nominal.growthPct}%, real ${headline.real.growthPct}% on index ${headline.real.index} (${headline.real.indexName}); three-year real series: ${series.map((s) => s.realPct == null ? "n/a" : s.realPct + "%").join(", ")}`,
      corrective: corr.compare,
    });
  }

  // FALLING FROM HIGH — above every alarm threshold, but declining.
  if (deepDive?.members?.length) {
    const activeMembers = deepDive.members.filter((m) => !m.isLeft); // LEFT members excluded — guard
    const highNames = activeMembers
      .filter((m) => (m.achievementTotal ?? 0) >= 0.5)
      .map((m) => m.name);
    if (highNames.length > 0) {
      const nameIn = sql.join(highNames.map((n) => sql`lower(trim(${n}))`), sql`, `);
      const [obCur, obPri] = await Promise.all([
        all(sql`SELECT lower(trim(head_canon)) AS h, sum(net_amount::float8) AS v FROM secondary_register_line
                WHERE fy = ${fy} AND ${monthIn(likeMonths)} AND lower(trim(head_canon)) IN (${nameIn}) GROUP BY 1`),
        all(sql`SELECT lower(trim(head_canon)) AS h, sum(net_amount::float8) AS v FROM secondary_register_line
                WHERE fy = ${fys[1]} AND ${monthIn(likeMonthsPrior)} AND lower(trim(head_canon)) IN (${nameIn}) GROUP BY 1`),
      ]);
      const priByH = new Map(obPri.map((r) => [r.h as string, Number(r.v)]));
      const curByH = new Map(obCur.map((r) => [r.h as string, Number(r.v)]));
      const falling = highNames
        .map((n) => {
          const key = n.toLowerCase().trim();
          const p = priByH.get(key) ?? 0, c = curByH.get(key) ?? 0;
          return { name: n, prior: p, cur: c, dropPct: pct(c, p) };
        })
        // cur === 0 with achievement ≥ 50% is a register-name mismatch, not a
        // collapse — the Data tab shows business the register can't see.
        .filter((m) => m.prior > 100000 && m.cur > 0 && m.dropPct != null && m.dropPct <= -20)
        .sort((a, b) => (a.cur - a.prior) - (b.cur - b.prior));
      if (falling.length > 0) {
        const totalDrop = falling.reduce((s, m) => s + (m.prior - m.cur), 0);
        flags.push({
          id: "fallingFromHigh", rank: 0, severity: "red",
          title: "Falling from high — above every alarm threshold, but declining",
          size: `₹${cr(totalDrop)} Cr of register OB lost vs like months last year across ${falling.length} members`,
          sizeValue: totalDrop,
          entities: falling.slice(0, 8).map((m) => `${m.name} (${m.dropPct}%)`),
          since: likeMonths[0] ?? null,
          evidence: `members with achievement ≥ 50% (no Warning System alert fires) whose like-months register OB is down ≥ 20% YoY — the decline is early and reversible, and nothing else in the app can see it`,
          corrective: corr.compare,
        });
      }
    }
  }

  // PENDING BUILD-UP
  if (pipeDir === "rising" && lastShare != null && prevShare != null) {
    let sinceIdx = shares.length - 1;
    while (sinceIdx > 0 && shares[sinceIdx] > shares[sinceIdx - 1]) sinceIdx--;
    flags.push({
      id: "pendingBuildup", rank: 0, severity: "orange",
      title: "Pending build-up — pending share of booking rising",
      size: `${r2(lastShare - shares[sinceIdx])} pp rise (${r2(shares[sinceIdx])}% → ${r2(lastShare)}%); ₹${pipeline.totals.pending} Cr pending`,
      sizeValue: pipeline.totals.pending * 1e7,
      entities: ["company"],
      since: pipeMonths[sinceIdx]?.month ?? null,
      evidence: `monthly pending share: ${pipeMonths.map((m) => `${m.month} ${m.pendingShare ?? "n/a"}%`).join(", ")}`,
      corrective: corr.compare,
    });
  }

  // BREADTH NARROWING — ranked by value, not count
  if (breadth.length > 0) {
    const atStake = breadth.reduce((s, r) => s + Number(r.prior_value ?? 0), 0);
    flags.push({
      id: "breadthNarrowing", rank: 0, severity: "orange",
      title: "Breadth narrowing — code counts falling, ranked by value",
      size: `₹${cr(atStake)} Cr of prior like-months business across ${breadth.length} customers buying fewer codes`,
      sizeValue: atStake,
      entities: breadth.slice(0, 8).map((r) => `${r.customer} (${r.prior_codes}→${r.cur_codes} codes)`),
      since: likeMonths[0] ?? null,
      evidence: "customers with ≥3 codes in like months last year now buying fewer — primary register, like months only",
      corrective: corr.push,
    });
  }

  // AT-RISK CONCENTRATION
  if (atRiskValues.length >= 5 && atRiskTotalValue > 0) {
    const top5 = atRiskValues.slice(0, 5);
    const top5V = top5.reduce((s, r) => s + Number(r.v), 0);
    const share = r2((top5V / atRiskTotalValue) * 100);
    if (share >= 40) {
      flags.push({
        id: "atRiskConcentration", rank: 0, severity: "orange",
        title: "At-risk value concentrated in few customers",
        size: `top 5 hold ₹${cr(top5V)} Cr = ${share}% of ₹${cr(atRiskTotalValue)} Cr at-risk value`,
        sizeValue: top5V,
        entities: top5.map((r) => `${r.c} (₹${cr(Number(r.v))} Cr)`),
        since: null,
        evidence: `${(atRiskRows ?? []).length} customers overdue on their own median order cycle; value = their FY${fys[1]} business`,
        corrective: corr.winback,
      });
    }
  }

  // DISCOUNT CREEP — discount rising against flat/falling volume
  if (curD != null && priD != null && curD > priD + 1 && secVolGrowth != null && secVolGrowth <= 2) {
    flags.push({
      id: "discountCreep", rank: 0, severity: "orange",
      title: "Discount creep — margin leaking while volume is flat",
      size: `effective discount ${r2(priD)}% → ${r2(curD)}% (+${r2(curD - priD)} pp) with secondary volume at ${secVolGrowth >= 0 ? "+" : ""}${secVolGrowth}%`,
      sizeValue: (curD - priD) * Number(discount.cur_v) / 100,
      entities: ["company (secondary register)"],
      since: likeMonths[0] ?? null,
      evidence: "net-weighted register discount, like months YoY — a DIFFERENT measure from the primary MRP discount",
      corrective: corr.discount,
    });
  }

  // SEGMENT DIVERGENCE — a segment declining materially faster than the company, on its own curve
  const segRows = await all(sql`
    WITH cur AS (SELECT coalesce(group_canon, group_raw, 'Unmapped') AS seg, sum(amount::float8) AS v
                 FROM sale_line_current WHERE fy = ${fy} AND ${monthIn(likeMonths)} AND ${terr} GROUP BY 1),
    pri AS (SELECT coalesce(group_canon, group_raw, 'Unmapped') AS seg, sum(amount::float8) AS v
            FROM sale_line_current WHERE fy = ${fys[1]} AND ${monthIn(likeMonthsPrior)} AND ${terr} GROUP BY 1)
    SELECT pri.seg, pri.v AS pv, coalesce(cur.v,0) AS cv FROM pri LEFT JOIN cur USING (seg)
    WHERE pri.v > 5000000 ORDER BY pri.v DESC`);
  const companyYoY = headline.nominal.growthPct ?? 0;
  const seasonalByName = new Map(
    (seasonality?.segments ?? []).map((s: any) => [String(s.segment ?? s.name ?? "").toLowerCase(), s]),
  );
  const diverging = segRows
    .map((r) => ({ seg: r.seg as string, pv: Number(r.pv), cv: Number(r.cv), yoy: pct(Number(r.cv), Number(r.pv)) }))
    .filter((r) => r.yoy != null && r.yoy < companyYoY - 15);
  if (diverging.length > 0) {
    const divDrop = diverging.reduce((s, r) => s + (r.pv - r.cv), 0);
    flags.push({
      id: "segmentDivergence", rank: 0, severity: "yellow",
      title: "Segment divergence — declining materially faster than the company",
      size: `₹${cr(divDrop)} Cr vs like months last year across ${diverging.length} segments`,
      sizeValue: divDrop,
      entities: diverging.slice(0, 6).map((r) => {
        const s = seasonalByName.get(r.seg.toLowerCase()) as any;
        const q4 = s?.quarterShare?.[3] != null ? `, Q4 share ${r2(Number(s.quarterShare[3]) * (Number(s.quarterShare[3]) > 1 ? 1 : 100))}%` : "";
        return `${r.seg} (${r.yoy}% vs company ${companyYoY}%${q4})`;
      }),
      since: likeMonths[0] ?? null,
      evidence: "like months YoY per segment vs company; each segment judged against its own seasonal curve — a weak Q2 alone does not flag (like-month comparison cancels the shape)",
      corrective: corr.push,
    });
  }

  // CUSTOMER COUNT FLAT
  const custCur = Number(sums[0].custs), custPri = Number(sums[1].custs);
  const custGrowth = pct(custCur, custPri);
  if (custGrowth != null && custGrowth < 2) {
    flags.push({
      id: "customerCountFlat", rank: 0, severity: "yellow",
      title: "Customer base not growing",
      size: `${custPri} → ${custCur} buying customers between comparable periods (${custGrowth! >= 0 ? "+" : ""}${custGrowth}%)`,
      sizeValue: Math.max(0, (custPri - custCur)) * (custPri > 0 ? cur / custPri : 0),
      entities: ["company"],
      since: likeMonths[0] ?? null,
      evidence: "distinct buying customers, like months vs like months, territory channel",
      corrective: corr.winback,
    });
  }

  // Rank: severity first, then size.
  const sevOrder = { red: 0, orange: 1, yellow: 2 };
  flags.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || b.sizeValue - a.sizeValue);
  flags.forEach((f, i) => (f.rank = i + 1));

  const lockDay = 7;
  const latestMonthNote =
    today.getUTCDate() <= lockDay
      ? `${closedLabels[closedLabels.length - 1]} closed on the calendar but the register can still sync until the ${lockDay}th — figures for it may firm up`
      : null;

  const data: MomentumInsights = {
    meta: {
      fy,
      likeMonths,
      priorLikeMonths: likeMonthsPrior,
      channel: "territory",
      channelLabel: `territory channel (project/govt head "${PROJECT_HEAD_CANON}" excluded)`,
      latestMonthNote: [latestMonthNote, filteredNote].filter(Boolean).join("; ") || null,
      generatedAt: new Date().toISOString(),
      guards: [
        "like months only — every YoY rate compares identical fiscal months",
        "real terms on every cross-year headline figure (Laspeyres, shared codes)",
        "territory channel by default; the channelLabel is stated on the page",
        "a partial (in-progress) month is excluded from every rate",
        "LEFT members are excluded from member-level flags",
        "no-data figures are reported as not recorded — never as zero",
      ],
    },
    headline,
    acceleration,
    runRate,
    pipeline,
    leading,
    redFlags: flags,
  };

  logger.info({ fy, likeMonths: likeMonths.length, flags: flags.length }, "momentumInsights: built");
  _cache = { key: cacheKey, at: Date.now(), data };
  return data;
}
