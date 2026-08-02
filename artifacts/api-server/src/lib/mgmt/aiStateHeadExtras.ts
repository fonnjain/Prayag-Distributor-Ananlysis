/**
 * Part 4 — State-head report extras.
 *
 * Verified, app-computed additions to the state-head AI report:
 *   - sku:           territory gap segments + per-distributor push lists with
 *                    tiers, peer counts, named peers, peak quarters, and
 *                    above-own-norm discount flags.
 *   - multiYear:     like-months primary net for this head across all loaded
 *                    FYs (same fiscal window, complete months of the open FY).
 *   - rosterChanges: joiner/leaver picture with achievement computed BOTH
 *                    including and excluding departed (LEFT) members, so the
 *                    report can say when a movement is organisational.
 *
 * All figures are computed here (app = numbers, Claude = judgement) and are
 * passed to the numeric guard as citable values.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getSkuRecommendations } from "../sku/skuRecommendations.js";
import { getSkuPushList, getDistributorList } from "../sku/skuPushList.js";
import { getDiscountNormFlags, getPeakQuarterMap } from "../sku/skuK4.js";
import { computeLikeMonths } from "../companyReports.js";
import { fiscalMonthsToLabels } from "./primaryPeriod.js";
import type { MemberKpis } from "./deepDiveData.js";
import { logger } from "../logger.js";

// ── types ─────────────────────────────────────────────────────────────────────

export type StateHeadSkuExtras = {
  basis: string;
  fiscalMonths: string[];
  topGapSegments: {
    rank: number;
    segment: string;
    gapNet: number;
    gapCodeCount: number;
    breadthPct: number;
    peakQuarter: string | null;
  }[];
  pushLists: {
    distributor: string;
    cohortBasis: string;
    peerNames: string[];
    suppressed: boolean;
    topCodes: {
      code: string;
      itemName: string | null;
      segment: string;
      tier: number;
      tierLabel: string;
      peerCount: number;
      peerNet: number;
      peakQuarter: string | null;
      discountAboveOwnNormPts: number | null;
    }[];
  }[];
};

export type StateHeadMultiYear = {
  basis: string;
  likeMonths: string[];
  /** Company-wide head-attribution residual in FY24-25/25-26 (rupees) — cite this, do not restate from memory. */
  unmappedResidualApproxRupees: number;
  years: { fy: string; primaryNet: number | null }[];
};

export type StateHeadRosterChanges = {
  activeCount: number;
  departedCount: number;
  departedNames: string[];
  salesActive: number;
  targetActive: number | null;
  salesIncludingDeparted: number;
  targetIncludingDeparted: number | null;
  achievementPctActiveOnly: number | null;
  achievementPctIncludingDeparted: number | null;
  note: string;
};

export type StateHeadExtras = {
  sku: StateHeadSkuExtras | null;
  multiYear: StateHeadMultiYear | null;
  rosterChanges: StateHeadRosterChanges;
};

// ── helpers ───────────────────────────────────────────────────────────────────

const LOADED_FYS = ["2023-24", "2024-25", "2025-26", "2026-27"];

function openFy(now = new Date()): string {
  const y = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

// ── sku block ─────────────────────────────────────────────────────────────────

async function buildSkuExtras(fy: string, stateHead: string): Promise<StateHeadSkuExtras | null> {
  try {
    const { current } = await computeLikeMonths(openFy());
    const n = current.length;
    if (n === 0) return null;
    const monthLabels = fiscalMonthsToLabels(fy, 1, n);
    const fiscalMonths = current.map((l) => l.split("-")[0]);

    const [recs, peakMap, distList] = await Promise.all([
      getSkuRecommendations({ fy, monthLabels, level: "distributor", scope: "head", scopeId: stateHead }),
      getPeakQuarterMap().catch(() => new Map()),
      getDistributorList(fy, "distributor").catch(
        () => [] as Awaited<ReturnType<typeof getDistributorList>>,
      ),
    ]);

    const topGapSegments = recs.recommendations.slice(0, 6).map((r) => ({
      rank: r.rank,
      segment: r.segment,
      gapNet: Math.round(r.gapNet),
      gapCodeCount: r.gapCodeCount,
      breadthPct: Math.round(r.breadthPct * 10) / 10,
      peakQuarter:
        (peakMap.get(r.segment) as { peakQuarterLabel?: string } | undefined)?.peakQuarterLabel ?? null,
    }));

    // Top 2 distributors in this head's territory by cohort-FY net.
    const headDists = distList
      .filter((d) => d.headCanon === stateHead && d.cohortFyNet > 0)
      .sort((a, b) => b.cohortFyNet - a.cohortFyNet)
      .slice(0, 2);

    const pushLists: StateHeadSkuExtras["pushLists"] = [];
    for (const d of headDists) {
      const pl = await getSkuPushList({ fy, monthLabels, level: "distributor", distributorKey: d.customer });
      const codes = pl.segments.flatMap((s) => s.topCodes.map((c) => ({ ...c, segment: s.segment })));
      const flagged = await getDiscountNormFlags(fy, codes.map((c) => c.code), monthLabels).catch(
        () => new Map(),
      );
      pushLists.push({
        distributor: d.customer,
        cohortBasis: pl.isFallback
          ? `state-typical fallback (${pl.fallbackScopeName ?? pl.fallbackTier ?? "pool"})`
          : `${pl.cohortSize}-distributor ${pl.cohortBasis} peer cohort`,
        peerNames: pl.peerNames.slice(0, 12),
        suppressed: pl.suppressed,
        topCodes: codes
          .sort((a, b) => a.tier - b.tier || b.peerNet - a.peerNet)
          .slice(0, 10)
          .map((c) => ({
            code: c.code,
            itemName: c.itemName,
            segment: c.segment,
            tier: c.tier,
            tierLabel: c.tierLabel,
            peerCount: c.peerCount,
            peerNet: Math.round(c.peerNet),
            peakQuarter:
              (peakMap.get(c.segment) as { peakQuarterLabel?: string } | undefined)?.peakQuarterLabel ?? null,
            discountAboveOwnNormPts: flagged.has(c.code)
              ? Math.round((flagged.get(c.code) as { aboveNormPts: number }).aboveNormPts * 10) / 10
              : null,
          })),
      });
    }

    return {
      basis:
        "Territory channel only (project / Non-territory / Govt excluded). Gap value = historical " +
        `net of codes not bought in the like-months window (${fiscalMonths.join(", ")}). ` +
        "Push tiers: 1 Range, 2 Lapsed, 3 Active, 4 New. Peak quarter from closed-FY seasonality. " +
        "Discount flag = current avg MRP discount ≥5 pts above the code's own closed-year norm.",
      fiscalMonths,
      topGapSegments,
      pushLists,
    };
  } catch (err) {
    logger.warn({ err, fy, stateHead }, "stateHeadExtras: sku block failed");
    return null;
  }
}

// ── multi-year block ──────────────────────────────────────────────────────────

async function buildMultiYear(stateHead: string): Promise<StateHeadMultiYear | null> {
  try {
    const { current } = await computeLikeMonths(openFy());
    if (current.length === 0) return null;
    const fiscalMonths = current.map((l) => l.split("-")[0]);

    const rows = await db.execute<{ fy: string; net: string }>(sql`
      SELECT fy, SUM(amount::numeric)::text AS net
      FROM sale_line_current
      WHERE head_canon = ${stateHead}
        AND fy = ANY(ARRAY[${sql.join(LOADED_FYS.map((f) => sql`${f}`), sql`, `)}])
        AND split_part(month_label, '-', 1) = ANY(ARRAY[${sql.join(fiscalMonths.map((m) => sql`${m}`), sql`, `)}])
      GROUP BY fy
    `);
    const byFy = new Map(rows.rows.map((r) => [r.fy, Math.round(parseFloat(r.net) || 0)]));

    return {
      basis:
        `Primary sale register (invoice-line level, current rows) attributed to this state head, ` +
        `LIKE MONTHS ONLY (${fiscalMonths.join(", ")}) in every year shown. ` +
        "FY2024-25/2025-26 head attribution is backfilled per customer; a structural Unmapped " +
        "residual (see unmappedResidualApproxRupees, company-wide) sits outside all heads in " +
        "those years, so absence can be attribution, not zero business.",
      likeMonths: fiscalMonths,
      unmappedResidualApproxRupees: 130_000_000,
      years: LOADED_FYS.map((f) => ({ fy: f, primaryNet: byFy.get(f) ?? null })),
    };
  } catch (err) {
    logger.warn({ err, stateHead }, "stateHeadExtras: multiYear block failed");
    return null;
  }
}

// ── roster changes block ──────────────────────────────────────────────────────

function buildRosterChanges(members: MemberKpis[]): StateHeadRosterChanges {
  const active = members.filter((m) => !m.isLeft);
  const departed = members.filter((m) => m.isLeft);

  const sales = (list: MemberKpis[]) => Math.round(list.reduce((s, m) => s + (m.sale ?? 0), 0));
  const target = (list: MemberKpis[]) => {
    const t = list.reduce((s, m) => s + (m.totalTargetToDate ?? 0), 0);
    return t > 0 ? Math.round(t) : null;
  };
  const pct = (s: number, t: number | null) =>
    t != null && t > 0 ? Math.round((s / t) * 1000) / 10 : null;

  const salesActive = sales(active);
  const targetActive = target(active);
  const salesAll = sales(members);
  const targetAll = target(members);

  return {
    activeCount: active.length,
    departedCount: departed.length,
    departedNames: departed.map((m) => m.name),
    salesActive,
    targetActive,
    salesIncludingDeparted: salesAll,
    targetIncludingDeparted: targetAll,
    achievementPctActiveOnly: pct(salesActive, targetActive),
    achievementPctIncludingDeparted: pct(salesAll, targetAll),
    note:
      departed.length > 0
        ? "Any difference between the two achievement figures is an ORGANISATIONAL effect of " +
          "excluding departed members' targets and business — not a commercial improvement."
        : "No departed members in this team for the selected period.",
  };
}

// ── entry point ───────────────────────────────────────────────────────────────

export async function buildStateHeadExtras(
  fy: string,
  stateHead: string,
  allMembers: MemberKpis[],
): Promise<StateHeadExtras> {
  const [sku, multiYear] = await Promise.all([
    buildSkuExtras(fy, stateHead),
    buildMultiYear(stateHead),
  ]);
  return { sku, multiYear, rosterChanges: buildRosterChanges(allMembers) };
}
