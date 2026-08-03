// W2 — Distributor warnings engine.
//
// The channel is two levels deep: Prayag → Distributor → Retailer, with
// Direct Dealers as a PARALLEL branch (no distributor above them).
// Distributors have NO targets — Prayag sets targets for salespeople only —
// so the A-family (target warnings) does not apply here. These warnings are
// about the health of the commercial relationship instead.
//
// Families:
//   R  recency & flow    R1 days since last order (vs OWN interval),
//                        R2 fill rate, R3 pending build-up
//   F  flow gap          F1 primary in-flow vs secondary out-flow (both readings)
//   B  range             B1 breadth narrowing (ranked by VALUE), B2 lost codes
//   D  discounts         D1 above territory norm (same codes), D2 creep
//   G  concentration     G2 Prayag's dependence, G3 the distributor's own
//   E  retailer base     E1 at-risk retailers, E2 unassigned in their
//                        districts, E3 active share
//   V  real terms        V1 real decline vs the distributor's OWN segment mix
//
// Guards: insufficient history → NOT_AVAILABLE (never a flag); concentration
// suppressed below sample size; project/institutional excluded from flows
// (channel != 'Govt'); real terms name the index used; partial months are
// excluded (closed months only).
//
// Suppression: R1 at RED (dormant) hides B1, D2, E3 — a dormant distributor
// trivially shows narrowing breadth and falling activity. Insufficient
// history hides everything derived from a trend (B1, D2, V1).

import { pool } from "@workspace/db";
import {
  loadDistributorDeepDiveResilient,
  closedMonthsForFy,
  prevFyLabel,
  toPriorYearMonths,
  normDistKey,
  type DistributorGroup,
  type DistributorDeepDiveResult,
} from "../distributorDeepDive.js";
import {
  computeCategoryMultipliers,
  computeCompanyMultiplier,
  type CategoryMultiplierMap,
  type MultiplierResult,
} from "../../customers/laspeyres.js";
import type { WarningCard, WarningSeverity } from "./types.js";
import { logger } from "../../logger.js";

// ── Result types ──────────────────────────────────────────────────────────────

export type DistributorWarnings = {
  normKey: string;
  name: string;
  retailerCount: number;
  activeCount: number;
  orderBooking: number;          // secondary OB from member sheets
  obSharePct: number | null;     // share of party OB in this territory
  hasFlows: boolean;             // primary flows matched sale_line customers
  insufficientHistory: boolean;  // < MIN_ORDERS distinct order dates over 2 FYs
  daysSinceLastOrder: number | null;
  rootWarnings: WarningCard[];
  suppressedWarnings: WarningCard[];
  suppressedCount: number;
};

export type DistributorWarningsResponse = {
  fy: string;
  stateHead: string;
  availableStateHeads: string[];
  period: string;                // like-months period covered, named
  channelNote: string;           // the two-level channel statement
  distributors: DistributorWarnings[];
  directDealer: {
    retailerCount: number;
    dashboardOb: number | null;
  } | null;
  summary: {
    distributorCount: number;
    withWarnings: number;
    largestShare: { name: string; sharePct: number } | null;  // G2 acceptance
    totalRetailers: number;       // renamed from "Total Dealer" — counts retail outlets
    assignmentGapRetailers: number;
    indexBasis: string;           // V1 index naming
  };
  membersFailed: number;
  stale?: boolean;
};

// ── Small helpers ─────────────────────────────────────────────────────────────

const MIN_ORDERS = 5; // distinct order dates over 2 FYs to establish an interval

function sevAbove(v: number, yellow: number, orange: number, red: number): WarningSeverity | null {
  if (v >= red) return "RED";
  if (v >= orange) return "ORANGE";
  if (v >= yellow) return "YELLOW";
  return null;
}
function sevBelow(v: number, yellow: number, orange: number, red: number): WarningSeverity | null {
  if (v < red) return "RED";
  if (v < orange) return "ORANGE";
  if (v < yellow) return "YELLOW";
  return null;
}

function fmtCr(v: number): string {
  return `₹${(v / 1e7).toFixed(2)} Cr`;
}
function fmtL(v: number): string {
  return v >= 1e7 ? fmtCr(v) : `₹${(v / 1e5).toFixed(2)} L`;
}

type CardSpec = {
  code: string;
  family: string;
  title: string;
  severity: WarningSeverity | null; // null = healthy, card omitted
  value: number | null;
  label: string;
  formatted: string;
  threshold: WarningCard["threshold"];
  source: string;
  suggestedAction: string;
  suppresses?: string[];
  notAvailableReason?: string;
};

function card(s: CardSpec): WarningCard | null {
  if (s.severity == null) return null;
  return {
    code: s.code,
    family: s.family,
    title: s.title,
    severity: s.severity,
    baseSeverity: s.severity,
    trend: null,
    metric: { value: s.value, label: s.label, formatted: s.formatted },
    threshold: s.threshold,
    source: s.source,
    suggestedAction: s.suggestedAction,
    suppresses: s.suppresses ?? [],
    ...(s.notAvailableReason ? { notAvailableReason: s.notAvailableReason } : {}),
  };
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ── DB aggregations (batched per state head, grouped per distributor in JS) ──

type PerDist = {
  orderDates: string[];                       // distinct invoice dates, 2 FYs
  curCodes: Map<string, number>;              // code → like-months value, cur FY
  priCodes: Map<string, number>;              // code → like-months value, prior FY
  mixPrior: Map<string, number>;              // group_canon → prior-FY value
  monthlyBook: Map<string, number>;           // month_label → booking (cur FY)
  monthlyDisp: Map<string, number>;           // month_label → dispatch (cur FY)
  discCur: { g: number; n: number } | null;   // secondary_sku_line, cur FY
  discPri: { g: number; n: number } | null;
  discByCode: Map<string, { g: number; n: number }>; // cur FY per item_code
};

function emptyPerDist(): PerDist {
  return {
    orderDates: [], curCodes: new Map(), priCodes: new Map(), mixPrior: new Map(),
    monthlyBook: new Map(), monthlyDisp: new Map(),
    discCur: null, discPri: null, discByCode: new Map(),
  };
}

async function loadPerDistData(
  fy: string,
  stateHead: string,
  groups: DistributorGroup[],
): Promise<{
  per: Map<string, PerDist>;
  terrNormAcc: Map<string, { g: number; n: number }>;
  companyNormAcc: Map<string, { g: number; n: number }>;
}> {
  const prior = prevFyLabel(fy);
  const curMonths = closedMonthsForFy(fy);
  const priMonths = toPriorYearMonths(curMonths);

  // customer → distributor normKey, from D2's matched sale_line customers.
  const custToDist = new Map<string, string>();
  const allCustomers: string[] = [];
  for (const g of groups) {
    for (const c of g.flows?.matchedCustomers ?? []) {
      custToDist.set(c, g.normKey);
      allCustomers.push(c);
    }
  }

  const per = new Map<string, PerDist>();
  const get = (k: string) => {
    let p = per.get(k);
    if (!p) { p = emptyPerDist(); per.set(k, p); }
    return p;
  };

  if (allCustomers.length) {
    const [dates, codes, mix, book, disp] = await Promise.all([
      // R1: distinct order dates over 2 FYs (prior FY scoped by customer, not
      // head_canon — historical rows may carry no head attribution).
      pool.query<{ customer: string; d: string }>(
        `SELECT customer, invoice_date::date::text AS d
           FROM sale_line_current
          WHERE fy IN ($1, $2) AND customer = ANY($3) AND invoice_date IS NOT NULL
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [fy, prior, allCustomers],
      ),
      // B1/B2: like-months code values, both FYs.
      pool.query<{ customer: string; code: string; fy: string; v: string }>(
        `SELECT customer, code, fy, sum(amount)::float8::text AS v
           FROM sale_line_current
          WHERE ((fy = $1 AND month_label = ANY($4)) OR (fy = $2 AND month_label = ANY($5)))
            AND customer = ANY($3) AND code IS NOT NULL
          GROUP BY 1, 2, 3`,
        [fy, prior, allCustomers, curMonths, priMonths],
      ),
      // V1: prior-FY category mix per customer.
      pool.query<{ customer: string; cat: string; v: string }>(
        `SELECT customer, coalesce(group_canon, 'Unmapped') AS cat, sum(amount)::float8::text AS v
           FROM sale_line_current
          WHERE fy = $1 AND customer = ANY($2)
          GROUP BY 1, 2`,
        [prior, allCustomers],
      ),
      // R3 direction: monthly booking, non-institutional.
      pool.query<{ customer: string; m: string; v: string }>(
        `SELECT customer, month_label AS m, sum(taxable_value)::float8::text AS v
           FROM primary_order_line
          WHERE fy = $1 AND head_canon = $2 AND customer = ANY($3)
            AND (channel IS NULL OR channel != 'Govt')
          GROUP BY 1, 2`,
        [fy, stateHead, allCustomers],
      ),
      // R3 direction: monthly dispatch.
      pool.query<{ customer: string; m: string; v: string }>(
        `SELECT customer, month_label AS m, sum(amount)::float8::text AS v
           FROM sale_line_current
          WHERE fy = $1 AND customer = ANY($2)
          GROUP BY 1, 2`,
        [fy, allCustomers],
      ),
    ]);

    for (const r of dates.rows) {
      const k = custToDist.get(r.customer);
      if (k) get(k).orderDates.push(r.d);
    }
    for (const r of codes.rows) {
      const k = custToDist.get(r.customer);
      if (!k) continue;
      const m = r.fy === fy ? get(k).curCodes : get(k).priCodes;
      m.set(r.code, (m.get(r.code) ?? 0) + Number(r.v));
    }
    for (const r of mix.rows) {
      const k = custToDist.get(r.customer);
      if (k) get(k).mixPrior.set(r.cat, (get(k).mixPrior.get(r.cat) ?? 0) + Number(r.v));
    }
    for (const r of book.rows) {
      const k = custToDist.get(r.customer);
      if (k) get(k).monthlyBook.set(r.m, (get(k).monthlyBook.get(r.m) ?? 0) + Number(r.v));
    }
    for (const r of disp.rows) {
      const k = custToDist.get(r.customer);
      if (k) get(k).monthlyDisp.set(r.m, (get(k).monthlyDisp.get(r.m) ?? 0) + Number(r.v));
    }
  }

  // D1/D2: secondary_sku_line has its own distributor column — join by
  // normDistKey. Like-months scoped on BOTH FYs: the current partial year must
  // never be compared against a complete prior year.
  const groupKeys = new Set(groups.map((g) => g.normKey));
  // Per-code norms accumulate at TWO levels: the territory cohort (this state
  // head's distributors) is the benchmark; company-wide is the named fallback
  // when the territory sample on a code is too thin.
  const terrNormAcc = new Map<string, { g: number; n: number }>();
  const companyNormAcc = new Map<string, { g: number; n: number }>();
  const disc = await pool.query<{ distributor: string; fy: string; item_code: string; g: string; n: string }>(
    `SELECT distributor, fy, item_code,
            sum(gross_amount)::float8::text AS g, sum(net_amount)::float8::text AS n
       FROM secondary_sku_line
      WHERE ((fy = $1 AND month_label = ANY($3)) OR (fy = $2 AND month_label = ANY($4)))
        AND distributor IS NOT NULL
        AND gross_amount IS NOT NULL AND net_amount IS NOT NULL
      GROUP BY 1, 2, 3`,
    [fy, prior, curMonths, priMonths],
  );
  for (const r of disc.rows) {
    const g = Number(r.g), n = Number(r.n);
    if (!(g > 0)) continue;
    const k = normDistKey(r.distributor);
    const inCohort = groupKeys.has(k);
    if (r.fy === fy) {
      const cAcc = companyNormAcc.get(r.item_code) ?? { g: 0, n: 0 };
      cAcc.g += g; cAcc.n += n;
      companyNormAcc.set(r.item_code, cAcc);
      if (inCohort) {
        const tAcc = terrNormAcc.get(r.item_code) ?? { g: 0, n: 0 };
        tAcc.g += g; tAcc.n += n;
        terrNormAcc.set(r.item_code, tAcc);
      }
    }
    if (!inCohort) continue;
    const p = get(k);
    if (r.fy === fy) {
      p.discCur = { g: (p.discCur?.g ?? 0) + g, n: (p.discCur?.n ?? 0) + n };
      const bc = p.discByCode.get(r.item_code) ?? { g: 0, n: 0 };
      bc.g += g; bc.n += n;
      p.discByCode.set(r.item_code, bc);
    } else {
      p.discPri = { g: (p.discPri?.g ?? 0) + g, n: (p.discPri?.n ?? 0) + n };
    }
  }

  return { per, terrNormAcc, companyNormAcc };
}

// ── Per-distributor warning computation ───────────────────────────────────────

function computeOne(
  g: DistributorGroup,
  p: PerDist,
  terrNormAcc: Map<string, { g: number; n: number }>,
  companyNormAcc: Map<string, { g: number; n: number }>,
  catMap: CategoryMultiplierMap,
  company: MultiplierResult | null,
  closedMonths: string[],
  fyPair: string,
  whitespaceUnassigned: number | null,
): DistributorWarnings {
  const cards: WarningCard[] = [];
  const f = g.flows;

  // ── R1: days since last order, banded against the distributor's OWN interval
  const gaps: number[] = [];
  for (let i = 1; i < p.orderDates.length; i++) {
    const a = new Date(p.orderDates[i - 1]!).getTime();
    const b = new Date(p.orderDates[i]!).getTime();
    const d = Math.round((b - a) / 86_400_000);
    if (d > 0) gaps.push(d);
  }
  const ownInterval = median(gaps);
  const insufficientHistory = p.orderDates.length < MIN_ORDERS || ownInterval == null;
  const daysSince = f?.daysSinceLastOrder ?? null;

  let r1Red = false;
  if (insufficientHistory) {
    cards.push(card({
      code: "R1", family: "R", title: "Days since last order",
      severity: "NOT_AVAILABLE", value: daysSince, label: "days since last order",
      formatted: daysSince != null ? `${daysSince} days` : "—",
      threshold: { direction: "above" },
      source: "sale_line invoice dates, this FY + prior FY",
      suggestedAction: "Too few orders to establish this distributor's own interval — not flagged.",
      notAvailableReason: `Insufficient history: ${p.orderDates.length} order dates on record (needs ${MIN_ORDERS}). Not comparable on a fixed day count.`,
    })!);
  } else if (daysSince != null) {
    const ratio = daysSince / ownInterval!;
    const sev = sevAbove(ratio, 1.5, 2, 3);
    r1Red = sev === "RED";
    if (sev) cards.push(card({
      code: "R1", family: "R", title: "Days since last order",
      severity: sev, value: ratio, label: "× own typical order interval",
      formatted: `${daysSince} days — ${ratio.toFixed(1)}× their own ~${Math.round(ownInterval!)}-day interval`,
      threshold: { yellow: 1.5, orange: 2, red: 3, direction: "above" },
      source: "sale_line invoice dates; interval = median gap between their own orders (2 FYs)",
      suggestedAction: "Call before the silence hardens — banded against their own cadence, not a fixed day count.",
      suppresses: ["B1", "D2", "E3"],
    })!);
  }

  // ── Closed-month booking/dispatch totals (a partial month is excluded from
  // any rate — the deep dive's flow fields are FY-to-date and include the open
  // month, so they are NOT used for R2/R3).
  let bookClosed = 0, dispClosed = 0;
  for (const m of closedMonths) {
    bookClosed += p.monthlyBook.get(m) ?? 0;
    dispClosed += p.monthlyDisp.get(m) ?? 0;
  }

  // ── R2: fill rate — a supply signal, not a distributor problem
  if (bookClosed > 0) {
    const fill = (dispClosed / bookClosed) * 100;
    const sev = sevBelow(fill, 95, 85, 70);
    if (sev) cards.push(card({
      code: "R2", family: "R", title: "Fill rate low",
      severity: sev, value: fill, label: "dispatch ÷ order booking, closed months",
      formatted: `${fill.toFixed(1)}% served (${fmtL(dispClosed)} of ${fmtL(bookClosed)})`,
      threshold: { yellow: 95, orange: 85, red: 70, direction: "below" },
      source: "primary_order_line vs sale_line, closed months only, non-institutional",
      suggestedAction: "Orders are being taken and not served — a SUPPLY signal to fix at Prayag's end, not a distributor problem.",
    })!);
  }

  // ── R3: pending build-up + direction
  if (bookClosed > 0) {
    const share = (Math.max(0, bookClosed - dispClosed) / bookClosed) * 100;
    const sev = sevAbove(share, 10, 20, 30);
    if (sev) {
      // Direction: last closed month's pending share vs mean of earlier months.
      let direction = "";
      if (closedMonths.length >= 2) {
        const shares = closedMonths.map((m) => {
          const b = p.monthlyBook.get(m) ?? 0;
          const d = p.monthlyDisp.get(m) ?? 0;
          return b > 0 ? Math.max(0, b - d) / b : null;
        });
        const last = shares[shares.length - 1];
        const earlier = shares.slice(0, -1).filter((x): x is number => x != null);
        if (last != null && earlier.length) {
          const mean = earlier.reduce((s, x) => s + x, 0) / earlier.length;
          direction = last > mean + 0.02 ? " — and rising" : last < mean - 0.02 ? " — but easing" : " — steady";
        }
      }
      cards.push(card({
        code: "R3", family: "R", title: "Pending build-up",
        severity: sev, value: share, label: "pending as % of booking",
        formatted: `${share.toFixed(1)}% of booking pending (${fmtL(Math.max(0, bookClosed - dispClosed))})${direction}`,
        threshold: { yellow: 10, orange: 20, red: 30, direction: "above" },
        source: "primary_order_line booking minus sale_line dispatch, closed months",
        suggestedAction: "Clear the backlog before it becomes cancelled demand.",
      })!);
    }
  }

  // ── F1: flow gap — state BOTH readings, never an accusation
  if (f?.flowGap != null && f.hasPrimaryData && f.primaryDispatch > 0 && f.secondaryOut > 0) {
    const gapPct = (f.flowGap / f.primaryDispatch) * 100;
    const sev = sevAbove(gapPct, 25, 50, 75);
    if (sev) cards.push(card({
      code: "F1", family: "F", title: "Flow gap — two possible readings",
      severity: sev, value: gapPct, label: "in-flow not yet visible as out-flow",
      formatted: `${fmtL(f.flowGap)} gap (${gapPct.toFixed(0)}% of in-flow)`,
      threshold: { yellow: 25, orange: 50, red: 75, direction: "above" },
      source: "primary dispatch (sale_line) minus secondary out-flow (member sheets), both FY-to-date — the member sheets carry no month split, so this is a level comparison over the same period, not a rate",
      suggestedAction: "Two readings, both stated every time: stock may be building at the distributor, OR business is moving outside the attributed channel. No distributor stock statements exist, so the two cannot be distinguished — verify in conversation, never accuse.",
    })!);
  }

  // ── B1: breadth narrowing — ranked by VALUE, not code count
  if (!insufficientHistory && p.priCodes.size >= 5) {
    const lost: { code: string; v: number }[] = [];
    let priTotal = 0;
    for (const [code, v] of p.priCodes) {
      priTotal += v;
      if (!p.curCodes.has(code)) lost.push({ code, v });
    }
    lost.sort((a, b) => b.v - a.v);
    const lostValue = lost.reduce((s, x) => s + x.v, 0);
    if (priTotal > 0) {
      const lostShare = (lostValue / priTotal) * 100;
      const sev = sevAbove(lostShare, 10, 20, 35);
      if (sev) cards.push(card({
        code: "B1", family: "B", title: "Breadth narrowing",
        severity: sev, value: lostShare, label: "% of prior-period value in codes no longer bought",
        formatted: `${p.priCodes.size - (p.priCodes.size - lost.length)} of ${p.priCodes.size} codes gone — ${fmtL(lostValue)} (${lostShare.toFixed(0)}% of prior value). Top: ${lost.slice(0, 3).map((x) => x.code).join(", ")}`,
        threshold: { yellow: 10, orange: 20, red: 35, direction: "above" },
        source: "sale_line codes, like months this FY vs same months prior FY — ranked by value",
        suggestedAction: "Losing 5 high-value codes matters more than 20 marginal ones — chase the top of this list first.",
      })!);

      // ── B2: lost codes — the warmest recovery list available
      if (lost.length > 0) {
        cards.push(card({
          code: "B2", family: "B", title: "Lost codes — recovery list",
          severity: "YELLOW", value: lost.length, label: "codes bought before, absent now",
          formatted: `${lost.length} codes worth ${fmtL(lostValue)} last year: ${lost.slice(0, 5).map((x) => `${x.code} (${fmtL(x.v)})`).join(", ")}`,
          threshold: { direction: "above" },
          source: "sale_line, like months — ranked by prior-period value",
          suggestedAction: "Proven demand, known customer — the warmest recovery list available.",
        })!);
      }
    }
  } else if (!insufficientHistory) {
    // fewer than 5 prior codes — too thin to call narrowing
  }

  // ── D1: discount above the TERRITORY norm on the SAME codes.
  // Norm per code = the rest of this territory's cohort (own rows excluded);
  // when the residual territory sample on a code is too thin, the company-wide
  // norm is the named fallback.
  if (p.discByCode.size >= 3) {
    let wSum = 0, w = 0, terrCodes = 0, companyCodes = 0;
    for (const [code, acc] of p.discByCode) {
      if (!(acc.g > 0)) continue;
      const own = (1 - acc.n / acc.g) * 100;
      const t = terrNormAcc.get(code);
      const restG = (t?.g ?? 0) - acc.g;
      const restN = (t?.n ?? 0) - acc.n;
      let norm: number | null = null;
      if (restG > 0) {
        norm = (1 - restN / restG) * 100;
        terrCodes++;
      } else {
        const c = companyNormAcc.get(code);
        const cG = (c?.g ?? 0) - acc.g;
        const cN = (c?.n ?? 0) - acc.n;
        if (cG > 0) {
          norm = (1 - cN / cG) * 100;
          companyCodes++;
        }
      }
      if (norm == null) continue;
      wSum += (own - norm) * acc.g;
      w += acc.g;
    }
    if (w > 0) {
      const variance = wSum / w; // pp above (+) or below (−) the norm
      const basis =
        companyCodes === 0
          ? `territory norm across ${terrCodes} shared codes`
          : `territory norm on ${terrCodes} codes, company-wide fallback on ${companyCodes} thin codes`;
      const sev = sevAbove(variance, 2, 4, 7);
      if (sev) cards.push(card({
        code: "D1", family: "D", title: "Discount above territory norm",
        severity: sev, value: variance, label: "pp above the norm on the same codes",
        formatted: `${variance.toFixed(1)} pp above the norm, value-weighted (${basis})`,
        threshold: { yellow: 2, orange: 4, red: 7, direction: "above" },
        source: "secondary register SKU lines, like months — this distributor vs the rest of the territory on the same item codes",
        suggestedAction: "The VARIANCE is the finding — one distributor materially deeper than others on the same item is a commercial conversation.",
      })!);
    }
  }

  // ── D2: discount creep — discount rising while volume flat or falling
  if (!insufficientHistory && p.discCur && p.discPri && p.discCur.g > 0 && p.discPri.g > 0) {
    const dCur = (1 - p.discCur.n / p.discCur.g) * 100;
    const dPri = (1 - p.discPri.n / p.discPri.g) * 100;
    const creep = dCur - dPri;
    const volumeFlatOrDown = p.discCur.n <= p.discPri.n * 1.05;
    if (volumeFlatOrDown) {
      const sev = sevAbove(creep, 1, 2, 4);
      if (sev) cards.push(card({
        code: "D2", family: "D", title: "Discount creep",
        severity: sev, value: creep, label: "pp rise in effective discount, volume flat/falling",
        formatted: `${dPri.toFixed(1)}% → ${dCur.toFixed(1)}% (+${creep.toFixed(1)} pp) while net volume is ${p.discCur.n < p.discPri.n ? "falling" : "flat"}`,
        threshold: { yellow: 1, orange: 2, red: 4, direction: "above" },
        source: "secondary register SKU lines, like months this FY vs same months prior FY",
        suggestedAction: "Paying more for the same or less — margin leaking without volume to show for it.",
      })!);
    }
  }

  // ── G2: Prayag's dependence — this distributor's share of party OB
  if (g.obSharePct != null) {
    const sev = sevAbove(g.obSharePct, 40, 60, 75);
    if (sev) cards.push(card({
      code: "G2", family: "G", title: "Prayag's dependence on this distributor",
      severity: sev, value: g.obSharePct, label: "share of party order booking in this territory",
      formatted: `${g.obSharePct.toFixed(1)}% of the territory's party OB flows through this one distributor`,
      threshold: { yellow: 40, orange: 60, red: 75, direction: "above" },
      source: "member working sheets, party OB share",
      suggestedAction: "A single distributor carrying most of a state is Prayag's risk — build a second route before it is needed.",
    })!);
  }

  // ── G3: the distributor's OWN concentration (top-3/top-5, effective retailers)
  const withOb = g.retailers.filter((r) => r.orderBooking > 0);
  if (withOb.length >= 5) {
    const tot = withOb.reduce((s, r) => s + r.orderBooking, 0);
    const sorted = [...withOb].sort((a, b) => b.orderBooking - a.orderBooking);
    const top3 = (sorted.slice(0, 3).reduce((s, r) => s + r.orderBooking, 0) / tot) * 100;
    const top5 = (sorted.slice(0, 5).reduce((s, r) => s + r.orderBooking, 0) / tot) * 100;
    const hhi = withOb.reduce((s, r) => s + Math.pow((r.orderBooking / tot) * 100, 2), 0);
    const effective = hhi > 0 ? 10_000 / hhi : null;
    const sev = sevAbove(top3, 60, 75, 90);
    if (sev) cards.push(card({
      code: "G3", family: "G", title: "The distributor's own concentration",
      severity: sev, value: top3, label: "top-3 retailer share of their OB",
      formatted: `top-3 = ${top3.toFixed(0)}%, top-5 = ${top5.toFixed(0)}%${effective != null ? `, effective retailers ≈ ${effective.toFixed(1)}` : ""} of ${withOb.length}`,
      threshold: { yellow: 60, orange: 75, red: 90, direction: "above" },
      source: "member working sheets, retailer OB beneath this distributor (10,000 ÷ HHI)",
      suggestedAction: "Their fragility becomes Prayag's one step later — help them widen their own base.",
    })!);
  }

  // ── E1: at-risk retailers beneath them — NOT churn on a partial year
  const atRisk = g.retailers.filter((r) => r.sale > 0 && r.orderBooking === 0);
  const priorBase = g.retailers.reduce((s, r) => s + r.sale, 0);
  if (atRisk.length > 0 && priorBase > 0) {
    const atRiskValue = atRisk.reduce((s, r) => s + r.sale, 0);
    const share = (atRiskValue / priorBase) * 100;
    const sev = sevAbove(share, 15, 30, 50);
    if (sev) cards.push(card({
      code: "E1", family: "E", title: "At-risk retailers beneath them",
      severity: sev, value: share, label: "% of prior-year value not yet ordering",
      formatted: `${atRisk.length} retailers, ${fmtL(atRiskValue)} of last year's business, nothing yet this year`,
      threshold: { yellow: 15, orange: 30, red: 50, direction: "above" },
      source: "member working sheets — bought last year, no OB this year. Sized by prior-year value, NOT churn on a partial year",
      suggestedAction: "Route the next visits through the biggest of these first.",
    })!);
  }

  // ── E2: unassigned retailers in their districts — the administrative fix
  if (whitespaceUnassigned != null && whitespaceUnassigned > 0) {
    const sev = sevAbove(whitespaceUnassigned, 1, 10, 25);
    if (sev) cards.push(card({
      code: "E2", family: "E", title: "Unassigned retailers in their districts",
      severity: sev, value: whitespaceUnassigned, label: "retailers assigned to nobody",
      formatted: `${whitespaceUnassigned} unassigned retailers in districts this distributor already serves`,
      threshold: { yellow: 1, orange: 10, red: 25, direction: "above" },
      source: "district whitespace — 96.0% of assigned retailers are active vs 5.0% of unassigned",
      suggestedAction: "An ADMINISTRATIVE fix, and the fastest available — assign them. See the assignment gap list on the Distributor Deep Dive.",
    })!);
  }

  // ── E3: active share (no history exists for a trend — level only, stated)
  if (g.retailerCount >= 5) {
    const activeShare = (g.activeCount / g.retailerCount) * 100;
    const sev = sevBelow(activeShare, 60, 40, 25);
    if (sev) cards.push(card({
      code: "E3", family: "E", title: "Active share of their retailer base",
      severity: sev, value: activeShare, label: "active retailers ÷ total",
      formatted: `${g.activeCount} of ${g.retailerCount} retailers active (${activeShare.toFixed(0)}%)`,
      threshold: { yellow: 60, orange: 40, red: 25, direction: "below" },
      source: "member working sheets — current level; no history exists yet to show the trend over time",
      suggestedAction: "Wake the dormant majority through the member's visit plan.",
    })!);
  }

  // ── V1: REAL decline — against this distributor's OWN segment-weighted index
  if (!insufficientHistory && f?.growthPct != null && f.priorPeriodDispatch != null && f.priorPeriodDispatch > 0) {
    let mult: number | null = null;
    let basis = "";
    let mixTotal = 0, mixSum = 0;
    for (const [cat, v] of p.mixPrior) {
      const m = catMap.get(cat)?.multiplier ?? company?.multiplier ?? null;
      if (m == null || !(v > 0)) continue;
      mixSum += m * v;
      mixTotal += v;
    }
    if (mixTotal > 0) {
      mult = mixSum / mixTotal;
      basis = `their own segment mix, Laspeyres ${fyPair}`;
    } else if (company?.multiplier != null) {
      mult = company.multiplier;
      basis = `company index ${fyPair} (no own mix available)`;
    }
    if (mult != null && mult > 0) {
      const realGrowth = ((1 + f.growthPct / 100) / mult - 1) * 100;
      const sev = sevBelow(realGrowth, 0, -5, -10);
      if (sev) cards.push(card({
        code: "V1", family: "V", title: "Real decline",
        severity: sev, value: realGrowth, label: "real growth, own segment-weighted index",
        formatted: `${f.growthPct >= 0 ? "+" : ""}${f.growthPct.toFixed(1)}% nominal is ${realGrowth.toFixed(1)}% real (index ${mult.toFixed(3)}, ${basis})`,
        threshold: { yellow: 0, orange: -5, red: -10, direction: "below" },
        source: `sale_line like months YoY, deflated by ${basis} — never one company figure when their own mix exists`,
        suggestedAction: "The honest reading nominal figures hide — treat as a decline even where nominal looks flat.",
      })!);
    }
  }

  // ── Suppression ──────────────────────────────────────────────────────────────
  const SUPPRESSED_BY_R1 = new Set(["B1", "D2", "E3"]);
  const root: WarningCard[] = [];
  const suppressed: WarningCard[] = [];
  for (const c of cards) {
    if (r1Red && SUPPRESSED_BY_R1.has(c.code)) {
      suppressed.push({ ...c, suppressedBy: "R1" });
    } else {
      root.push(c);
    }
  }
  const sevOrder: Record<WarningSeverity, number> = { RED: 0, ORANGE: 1, YELLOW: 2, NOT_AVAILABLE: 3 };
  root.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  return {
    normKey: g.normKey,
    name: g.name,
    retailerCount: g.retailerCount,
    activeCount: g.activeCount,
    orderBooking: g.orderBooking,
    obSharePct: g.obSharePct,
    hasFlows: f != null && f.hasPrimaryData,
    insufficientHistory,
    daysSinceLastOrder: daysSince,
    rootWarnings: root,
    suppressedWarnings: suppressed,
    suppressedCount: suppressed.length,
  };
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function buildDistributorWarnings(
  fy: string,
  stateHead: string,
): Promise<DistributorWarningsResponse> {
  const dd: DistributorDeepDiveResult = await loadDistributorDeepDiveResilient(fy, stateHead);
  const groups = dd.distributors;
  const prior = prevFyLabel(fy);
  const closedMonths = closedMonthsForFy(fy);
  const fyPair = `${prior}→${fy}`;

  const [{ per, terrNormAcc, companyNormAcc }, catMap, company] = await Promise.all([
    loadPerDistData(fy, stateHead, groups),
    computeCategoryMultipliers(prior, fy),
    computeCompanyMultiplier(prior, fy),
  ]);

  // E2: unassigned count per distributor — districts they serve (whitespace).
  const unassignedByDist = new Map<string, number>();
  for (const ds of dd.whitespace?.districtStats ?? []) {
    if (ds.noneCount <= 0) continue;
    for (const dn of ds.distributorNames) {
      const k = normDistKey(dn);
      unassignedByDist.set(k, (unassignedByDist.get(k) ?? 0) + ds.noneCount);
    }
  }

  const distributors = groups
    .map((g) =>
      computeOne(
        g,
        per.get(g.normKey) ?? emptyPerDist(),
        terrNormAcc,
        companyNormAcc,
        catMap,
        company,
        closedMonths,
        fyPair,
        unassignedByDist.get(g.normKey) ?? null,
      ),
    )
    .sort((a, b) => {
      const worst = (d: DistributorWarnings) =>
        d.rootWarnings.some((w) => w.severity === "RED") ? 0
        : d.rootWarnings.some((w) => w.severity === "ORANGE") ? 1
        : d.rootWarnings.some((w) => w.severity === "YELLOW") ? 2
        : 3;
      const wa = worst(a), wb = worst(b);
      return wa !== wb ? wa - wb : b.orderBooking - a.orderBooking;
    });

  const largest = groups.reduce<{ name: string; sharePct: number } | null>((best, g) => {
    if (g.obSharePct == null) return best;
    return !best || g.obSharePct > best.sharePct ? { name: g.name, sharePct: g.obSharePct } : best;
  }, null);

  return {
    fy,
    stateHead,
    availableStateHeads: dd.stateHeads,
    period: closedMonths.length
      ? `like months ${closedMonths[0]}–${closedMonths[closedMonths.length - 1]} vs ${toPriorYearMonths(closedMonths)[0]}–${toPriorYearMonths(closedMonths)[closedMonths.length - 1]}`
      : `${fy} to date`,
    channelNote:
      "The channel is two levels deep: Prayag → Distributor → Retailer. Direct Dealers are a PARALLEL branch buying straight from Prayag — no distributor above them. \"Total Retailers\" counts retail outlets (formerly labelled \"Total Dealer\"). Distributors have no targets, so target warnings (A1–A4) do not apply here.",
    distributors,
    directDealer: dd.directDealer
      ? { retailerCount: dd.directDealer.retailerCount, dashboardOb: dd.directDealer.dashboardOb }
      : null,
    summary: {
      distributorCount: groups.length,
      withWarnings: distributors.filter((d) => d.rootWarnings.some((w) => w.severity !== "NOT_AVAILABLE")).length,
      largestShare: largest,
      totalRetailers: groups.reduce((s, g) => s + g.retailerCount, 0),
      assignmentGapRetailers: dd.whitespace?.totalAssignmentGapRetailers ?? 0,
      indexBasis: company?.multiplier != null
        ? `Laspeyres ${fyPair}, company ${company.multiplier.toFixed(3)}; V1 uses each distributor's own segment mix`
        : `Laspeyres ${fyPair} unavailable`,
    },
    membersFailed: dd.membersFailed,
    ...(dd.stale ? { stale: true } : {}),
  };
}
