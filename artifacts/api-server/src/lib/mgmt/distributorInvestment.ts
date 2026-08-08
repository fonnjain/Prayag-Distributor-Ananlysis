// Phase D4: Investment, ROI and tiering per distributor.
//
// Investment sources (in order of availability today):
//   1. Effective discount — secondary_register_line (gross_amount, discount_pct,
//      net_amount). All FYs 2021-22 through 2025-26 have 100% discount_pct
//      coverage. Anomalous discounts (> 100 %) are excluded from the weighted
//      average and flagged. Attribution via D1 retailer list, LOWER(TRIM(customer)).
//   2. Cost to serve — distributorVisits × memberCostPerVisit.
//      memberCostPerVisit = (ctcMonthly × elapsed months + taBillYtd) / totalVisits.
//      This is the SAME formula as Sales Deep Dive Phase 4 — both are shown so
//      the user can compare them.
//   3. Credit outstanding & scheme payouts — "no_source" state only.
//      Never estimated, never zero, never a placeholder value.
//
// Return:
//   netToCostMultiple: D3 skuSpread.totalNet / visitCostToServe.
//   Margin ROI: requires cost_master (fg_cost). Always unavailable until the
//   cost master table is populated. MRP and Purchase Price are never used.
//
// Tiering:
//   Composite score (0 – 100) over four inputs:
//     NET position (top/mid/low among peers)          — up to 30 pts
//     Primary YoY growth (from D2 flows.growthPct)    — up to 25 pts
//     Active retailer ratio (from D1)                 — up to 25 pts
//     Effective discount (weighted avg %)              — up to 20 pts
//   A (>= 70), B (45 – 69), C (< 45).
//   Each tier has a recommended visit cadence and credit posture.
//   All scoring inputs are returned so the classification can be challenged.
//
// Never console.log — use logger.

import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { logger } from "../logger.js";
import type { DistributorGroup } from "./distributorDeepDive.js";
import { getRetailerRegistry, normRetailerName } from "./retailerRegistry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EffectiveDiscount = {
  recentFy: string;
  grossTotal: number;
  netTotal: number;
  discountAmount: number;
  weightedDiscountPct: number;         // (1 − netTotal / grossTotal) × 100, anomalous lines excluded
  hasAnomalousLines: boolean;          // any discount_pct > 100 in this distributor's rows
  peerMedianDiscountPct: number | null;
  abovePeerMedian: boolean;
  // Reconciliation: one sample line from the register
  sampleLineGross: number | null;
  sampleLineDiscountPct: number | null;
  sampleLineNet: number | null;
  sampleLineComputed: number | null;   // sampleLineGross × (1 − pct / 100)
};

export type CostToServe = {
  distributorVisits: number;
  memberCostPerVisit: number;          // matches Sales Deep Dive Phase 4 formula
  visitCostToServe: number;            // distributorVisits × memberCostPerVisit
};

export type DistributorRoi = {
  netRevenue: number;                  // D3 skuSpread.totalNet (most recent closed FY)
  revenueRecentFy: string;
  visitCostToServe: number;
  netToCostMultiple: number;           // netRevenue / visitCostToServe
  marginRoiAvailable: false;           // always false until cost_master is populated
};

export type TierInput = {
  label: string;
  value: string;
  score: number;
  note: string;
};

export type DistributorTier = {
  tier: "A" | "B" | "C";
  score: number;
  // D4 actions (strings)
  visitCadence: string;
  creditPosture: string;
  inputs: TierInput[];
  // D7 extensions
  cadenceDistributorPerMonth: number;  // visits/month to the distributor office
  cadenceRetailerPerMonth: number;     // total retailer visits/month demanded by this tier × retailer count
  rangeFocus: string[];                // which whitespace segments to push first (D7, from D3/D5)
  // Override (applied in Step 15, null until then)
  isOverridden: boolean;
  overrideReason: string | null;
};

export type DistributorInvestment = {
  effectiveDiscount: EffectiveDiscount | null;   // null for live FY (brand-level register table not populated)
  costToServe: CostToServe | null;               // null when visits or CTC unavailable
  creditOutstanding: { status: "no_source" };    // no AR source wired — never estimated
  schemePayouts: { status: "no_source" };        // no scheme source wired — never estimated
  roi: DistributorRoi | null;                    // null when cost data unavailable
  tier: DistributorTier;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreNet(net: number | null | undefined, allNets: number[]): TierInput {
  const v = net ?? 0;
  const sorted = [...allNets].filter((n) => n > 0).sort((a, b) => b - a);
  let score: number;
  let note: string;
  if (sorted.length === 0 || v <= 0) {
    score = 8; note = "no secondary NET data";
  } else {
    const rank = sorted.indexOf(v);
    const topCut = Math.max(1, Math.ceil(sorted.length * 0.4));
    if (rank < topCut) {
      score = 30; note = "top-NET distributor in territory";
    } else if (rank < sorted.length - 1) {
      score = 18; note = "mid-tier NET";
    } else {
      score = 8; note = "lowest-NET distributor in territory";
    }
  }
  return {
    label: "Net revenue (D3 secondary)",
    value: v > 0 ? "Rs " + (v / 100_000).toFixed(2) + "L" : "--",
    score,
    note,
  };
}

function scoreGrowth(growthPct: number | null | undefined): TierInput {
  let score: number;
  let note: string;
  if (growthPct == null) {
    score = 12; note = "no primary growth data";
  } else if (growthPct > 5) {
    score = 25; note = "growing (> +5 %)";
  } else if (growthPct >= 0) {
    score = 18; note = "stable (0 % to +5 %)";
  } else if (growthPct >= -10) {
    score = 10; note = "declining";
  } else {
    score = 5; note = "contracting (< -10 %)";
  }
  return {
    label: "Primary YoY growth (D2)",
    value: growthPct != null
      ? (growthPct >= 0 ? "+" : "") + growthPct.toFixed(1) + " %"
      : "--",
    score,
    note,
  };
}

function scoreActiveRatio(active: number, total: number): TierInput {
  const ratio = total > 0 ? active / total : 0;
  let score: number;
  let note: string;
  if (ratio > 0.6) {
    score = 25; note = "high activation (> 60 %)";
  } else if (ratio >= 0.4) {
    score = 18; note = "moderate activation (40 – 60 %)";
  } else {
    score = 8; note = "low activation (< 40 %)";
  }
  return {
    label: "Active retailer ratio (D1)",
    value: total > 0 ? (ratio * 100).toFixed(0) + " % (" + active + " / " + total + ")" : "--",
    score,
    note,
  };
}

function scoreDiscount(discountPct: number | null | undefined): TierInput {
  let score: number;
  let note: string;
  if (discountPct == null) {
    score = 12; note = "no discount data (live FY)";
  } else if (discountPct < 40) {
    score = 20; note = "disciplined (< 40 %)";
  } else if (discountPct <= 50) {
    score = 12; note = "moderate (40 – 50 %)";
  } else {
    score = 5; note = "high discount (> 50 %) — review terms";
  }
  return {
    label: "Effective discount (D4)",
    value: discountPct != null ? discountPct.toFixed(1) + " %" : "--",
    score,
    note,
  };
}

function tierLabel(score: number): "A" | "B" | "C" {
  if (score >= 70) return "A";
  if (score >= 45) return "B";
  return "C";
}

const VISIT_CADENCE: Record<string, string> = {
  A: "Weekly visit; priority for scheme participation",
  B: "Fortnightly visit; standard terms",
  C: "Monthly visit; reduce credit exposure before next cycle",
};

const CREDIT_POSTURE: Record<string, string> = {
  A: "Standard credit terms; eligible for scheme uplift",
  B: "Review outstanding before next order cycle",
  C: "Tighten credit; resolve outstanding before restocking",
};

// D7: numeric cadences (visits/month to distributor HQ)
const CADENCE_DISTRIBUTOR_PER_MONTH: Record<"A" | "B" | "C", number> = {
  A: 4,   // weekly
  B: 2,   // fortnightly
  C: 1,   // monthly
};

// D7: retailer visit rate per active retailer per month
const RETAILER_VISIT_RATE: Record<"A" | "B" | "C", number> = {
  A: 2.0,  // fortnightly per active retailer
  B: 1.0,  // monthly per active retailer
  C: 0.5,  // bi-monthly per active retailer
};

// D7: which whitespace/range segments to push first (static per tier; enriched in future via D3 + D5)
const RANGE_FOCUS: Record<"A" | "B" | "C", string[]> = {
  A: [
    "Expand: introduce new product lines to top-OB accounts",
    "Target dormant districts for new retailer activation",
  ],
  B: [
    "Maintain: sustain range depth across existing active accounts",
    "Push unassigned retailers into distributor network",
  ],
  C: [
    "Consolidate: focus on core SKUs with paying accounts only",
    "Resolve outstanding credit before any range extension",
  ],
};

// D7: helper used by distributorDeepDive when applying manual tier overrides so
// the textual and numeric cadence fields stay consistent with the new tier.
export function buildTierActions(
  tier: "A" | "B" | "C",
  activeCount: number,
): Pick<
  DistributorTier,
  "visitCadence" | "creditPosture" | "cadenceDistributorPerMonth" | "cadenceRetailerPerMonth" | "rangeFocus"
> {
  return {
    visitCadence:               VISIT_CADENCE[tier]!,
    creditPosture:              CREDIT_POSTURE[tier]!,
    cadenceDistributorPerMonth: CADENCE_DISTRIBUTOR_PER_MONTH[tier],
    cadenceRetailerPerMonth:    Math.round(activeCount * RETAILER_VISIT_RATE[tier] * 10) / 10,
    rangeFocus:                 RANGE_FOCUS[tier]!,
  };
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Mutates distGroups[n].investment in place (same pattern as D3 skuSpread).
 * memberCostPerVisit: computed from CTC + TA / total visits, matching Phase 4.
 */
export async function loadDistributorInvestment(
  fy: string,
  distGroups: DistributorGroup[],
  memberCostPerVisit: number | null,
): Promise<void> {
  if (!distGroups.length) return;

  // FY2026-27 is populated via the PSCode_3 brand-level backfill, so the
  // effective-discount query runs for every FY.
  const isLiveFy = false;

  // ── Step A: Effective discount ─────────────────────────────────────────────
  const discountByNormKey = new Map<string, EffectiveDiscount>();

  if (!isLiveFy) {
    // Collect all retailer names across all distributors in one map
    const retailerToNormKey = new Map<string, string>(); // LOWER(TRIM) → normKey
    for (const g of distGroups) {
      for (const r of g.retailers) {
        retailerToNormKey.set(r.name.toLowerCase().trim(), g.normKey);
      }
    }
    const allRetailers = Array.from(retailerToNormKey.keys());

    // Retailer identity check (task 172): secondary_register_line carries no
    // RET#, so the discount query below matches by name (name+distributor
    // fallback). Surface names the registry knows map to multiple RET#s —
    // their rows may include a different retailer's discounts.
    try {
      const registry = await getRetailerRegistry();
      const ambiguous = registry.ambiguousNameKeys();
      const hits = allRetailers.filter((n) => ambiguous.has(normRetailerName(n)));
      if (hits.length > 0) {
        logger.warn(
          { fy, ambiguousNames: hits.length, sample: hits.slice(0, 5) },
          "distributorInvestment: retailer names mapping to multiple RET#s — name-keyed discount rows may mix retailers",
        );
      }
    } catch (err) {
      logger.warn({ err }, "distributorInvestment: retailer registry unavailable — ambiguity check skipped");
    }

    if (allRetailers.length > 0) {
      try {
        // One batch query: aggregate gross, clean net, anomaly flag, sample line
        // per retailer. We aggregate to distributor in TypeScript.
        // Build IN list the same way D3 (distributorSkuSpread.ts) does:
        // sql.join expands each value as a bound parameter — avoids the pg-array
        // serialisation issue that arises when passing a plain JS array to ANY().
        const retailerInList: SQL = sql.join(
          allRetailers.map((r) => sql`${r}`),
          sql`, `,
        );

        const rows = (await db.execute(sql`
          SELECT
            LOWER(TRIM(customer))                                             AS retailer,
            SUM(gross_amount::float8)                                         AS gross_total,
            SUM(
              CASE
                WHEN discount_pct IS NOT NULL AND discount_pct::float8 <= 100
                  THEN net_amount::float8
                ELSE gross_amount::float8
              END
            )                                                                 AS net_clean,
            BOOL_OR(
              discount_pct IS NOT NULL AND discount_pct::float8 > 100
            )                                                                 AS has_anomalous,
            -- One sample line for the reconciliation check:
            --   gross_amount | discount_pct | net_amount (pipe-separated string)
            MAX(
              CASE
                WHEN discount_pct IS NOT NULL
                  AND discount_pct::float8 > 0
                  AND discount_pct::float8 <= 100
                  AND net_amount IS NOT NULL
                  THEN gross_amount::text || '|' || discount_pct::text || '|' || net_amount::text
              END
            )                                                                 AS sample_line
          FROM secondary_register_line
          WHERE fy         = ${fy}
            AND gross_amount IS NOT NULL
            AND gross_amount::float8 > 0
            AND LOWER(TRIM(customer)) IN (${retailerInList})
          GROUP BY LOWER(TRIM(customer))
        `)).rows as Array<{
          retailer: string;
          gross_total: string | null;
          net_clean: string | null;
          has_anomalous: boolean;
          sample_line: string | null;
        }>;

        // Aggregate from retailer → distributor level
        type DistAgg = {
          grossTotal: number;
          netClean: number;
          hasAnomalous: boolean;
          sampleLine: string | null;
        };
        const distAgg = new Map<string, DistAgg>();

        for (const row of rows) {
          const normKey = retailerToNormKey.get(row.retailer);
          if (!normKey) continue;
          const ex = distAgg.get(normKey) ?? {
            grossTotal: 0, netClean: 0, hasAnomalous: false, sampleLine: null,
          };
          ex.grossTotal   += Number(row.gross_total  ?? 0);
          ex.netClean     += Number(row.net_clean    ?? 0);
          ex.hasAnomalous  = ex.hasAnomalous || Boolean(row.has_anomalous);
          if (!ex.sampleLine && row.sample_line) ex.sampleLine = row.sample_line;
          distAgg.set(normKey, ex);
        }

        // Compute weighted discount per distributor + peer median
        const rawDiscounts: Array<{ normKey: string; pct: number }> = [];
        for (const [normKey, agg] of distAgg.entries()) {
          if (agg.grossTotal > 0) {
            const pct = (1 - agg.netClean / agg.grossTotal) * 100;
            rawDiscounts.push({ normKey, pct });
          }
        }
        const peerMedian = median(rawDiscounts.map((r) => r.pct));

        for (const { normKey, pct } of rawDiscounts) {
          const agg = distAgg.get(normKey)!;

          // Parse the sample line
          let sG: number | null = null;
          let sD: number | null = null;
          let sN: number | null = null;
          let sC: number | null = null;
          if (agg.sampleLine) {
            const parts = agg.sampleLine.split("|");
            sG = parts[0] ? Number(parts[0]) : null;
            sD = parts[1] ? Number(parts[1]) : null;
            sN = parts[2] ? Number(parts[2]) : null;
            if (sG != null && sD != null) sC = sG * (1 - sD / 100);
          }

          discountByNormKey.set(normKey, {
            recentFy:             fy,
            grossTotal:           agg.grossTotal,
            netTotal:             agg.netClean,
            discountAmount:       agg.grossTotal - agg.netClean,
            weightedDiscountPct:  pct,
            hasAnomalousLines:    agg.hasAnomalous,
            peerMedianDiscountPct: peerMedian,
            abovePeerMedian:      peerMedian !== null && pct > peerMedian,
            sampleLineGross:       sG,
            sampleLineDiscountPct: sD,
            sampleLineNet:         sN,
            sampleLineComputed:    sC,
          });
        }
      } catch (err) {
        logger.warn({ err }, "distributorInvestment: discount query failed — skipping");
      }
    }
  }

  // ── Step B: Relative NET for tiering ──────────────────────────────────────
  const allNets = distGroups
    .map((g) => g.skuSpread?.totalNet ?? null)
    .filter((n): n is number => n !== null && n > 0);

  // ── Step C: Assemble per-distributor investment ────────────────────────────
  for (const g of distGroups) {
    const effectiveDiscount = discountByNormKey.get(g.normKey) ?? null;

    // Cost to serve
    const costToServe: CostToServe | null =
      g.visits !== null && g.visits > 0 && memberCostPerVisit !== null
        ? {
            distributorVisits:  g.visits,
            memberCostPerVisit,
            visitCostToServe:   g.visits * memberCostPerVisit,
          }
        : null;

    // Revenue-to-cost ROI
    const netRevenue  = g.skuSpread?.totalNet ?? null;
    const recentFy    = g.skuSpread?.recentFy ?? null;
    const roi: DistributorRoi | null =
      netRevenue != null && recentFy && costToServe?.visitCostToServe
        ? {
            netRevenue,
            revenueRecentFy:     recentFy,
            visitCostToServe:    costToServe.visitCostToServe,
            netToCostMultiple:   netRevenue / costToServe.visitCostToServe,
            marginRoiAvailable:  false,
          }
        : null;

    // Tier
    const netInput      = scoreNet(netRevenue, allNets);
    const growthInput   = scoreGrowth(g.flows?.growthPct);
    const activeInput   = scoreActiveRatio(g.activeCount, g.retailerCount);
    const discountInput = scoreDiscount(effectiveDiscount?.weightedDiscountPct ?? null);
    const totalScore    = netInput.score + growthInput.score + activeInput.score + discountInput.score;
    const tier          = tierLabel(totalScore);

    const cadenceRetailerPerMonth =
      Math.round(g.activeCount * RETAILER_VISIT_RATE[tier] * 10) / 10;

    const tierObj: DistributorTier = {
      tier,
      score: totalScore,
      visitCadence:  VISIT_CADENCE[tier]!,
      creditPosture: CREDIT_POSTURE[tier]!,
      inputs: [netInput, growthInput, activeInput, discountInput],
      cadenceDistributorPerMonth: CADENCE_DISTRIBUTOR_PER_MONTH[tier],
      cadenceRetailerPerMonth,
      rangeFocus: RANGE_FOCUS[tier]!,
      isOverridden:   false,
      overrideReason: null,
    };

    (g as DistributorGroup & { investment: DistributorInvestment }).investment = {
      effectiveDiscount,
      costToServe,
      creditOutstanding: { status: "no_source" },
      schemePayouts:     { status: "no_source" },
      roi,
      tier: tierObj,
    };

    logger.info(
      {
        normKey:              g.normKey,
        tier:                 tierObj.tier,
        score:                tierObj.score,
        weightedDiscountPct:  effectiveDiscount?.weightedDiscountPct?.toFixed(1) ?? null,
        memberCostPerVisit:   memberCostPerVisit?.toFixed(0) ?? null,
        distributorVisits:    g.visits,
        visitCostToServe:     costToServe?.visitCostToServe?.toFixed(0) ?? null,
        netRevenue:           netRevenue?.toFixed(0) ?? null,
        netToCostMultiple:    roi?.netToCostMultiple?.toFixed(2) ?? null,
      },
      "distributorInvestment D4: tier computed — verify against acceptance criteria",
    );
  }
}
