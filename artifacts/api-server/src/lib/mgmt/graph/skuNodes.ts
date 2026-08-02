/**
 * Part 3 — SKU / segment / discount / seasonality graph nodes.
 *
 * Every resolver reuses EXISTING verified computation (skuRecommendations,
 * skuPushList, skuK4, skuFacts, companyReports likeMonths). No new arithmetic.
 * Each node carries source, population and cutoff.
 */

import type { GraphNode, MeasureValue } from "./types.js";
import { getSkuRecommendations } from "../../sku/skuRecommendations.js";
import { getSkuPushList } from "../../sku/skuPushList.js";
import {
  getSeasonality,
  getSecondaryDiscountByCode,
  getPrimaryDiscountByCode,
  getDiscountNormFlags,
  getPeakQuarterMap,
} from "../../sku/skuK4.js";
import { loadSkuFacts } from "../../sku/skuFacts.js";
import { computeLikeMonths } from "../../companyReports.js";
import { fiscalMonthsToLabels } from "../primaryPeriod.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function mv(
  measure: MeasureValue["measure"],
  label: string,
  value: number | null,
  unit: MeasureValue["unit"] = "INR",
): MeasureValue {
  return { measure, label, value, unit };
}

/** The open (live) fiscal year, derived from the server clock. */
export function openFy(now = new Date()): string {
  const y = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/**
 * Month labels for a target FY, restricted to the LIKE-MONTHS window of the
 * open FY (complete months only). For a closed FY when the question is not a
 * like-months comparison, callers pass the full year instead.
 */
async function likeMonthLabelsFor(targetFy: string): Promise<{ labels: string[]; monthNames: string[] }> {
  const { current } = await computeLikeMonths(openFy());
  const n = current.length;
  if (n === 0) return { labels: [], monthNames: [] };
  const labels = fiscalMonthsToLabels(targetFy, 1, n);
  return { labels, monthNames: current.map((l) => l.split("-")[0]) };
}

/** Full-year labels for closed FYs; like-months for the open FY. */
async function periodFor(fy: string): Promise<{ labels: string[]; desc: string }> {
  if (fy === openFy()) {
    const lm = await likeMonthLabelsFor(fy);
    return { labels: lm.labels, desc: `like months (${lm.monthNames.join(", ")}) — open FY, complete months only` };
  }
  return { labels: fiscalMonthsToLabels(fy, 1, 12), desc: "full fiscal year (closed FY)" };
}

// ── sku/gaps/{fy}  and  sku/gaps/{head}/{fy} ──────────────────────────────────

export async function resolveSkuGaps(fy: string, head?: string): Promise<GraphNode> {
  const period = await periodFor(fy);
  const result = await getSkuRecommendations({
    fy,
    monthLabels: period.labels,
    level: "distributor",
    scope: head ? "head" : "company",
    scopeId: head,
  });

  const top = result.recommendations.slice(0, 10);
  const measures: MeasureValue[] = [
    mv("primary_sale", "Total gap value (historical net of unbought codes, same fiscal months)", result.totalGapNet),
    ...top.slice(0, 5).map((r) =>
      mv("primary_sale", `Gap value — ${r.segment}`, r.gapNet),
    ),
  ];

  return {
    path: head ? `sku/gaps/${head}/${fy}` : `sku/gaps/${fy}`,
    level: "segment",
    fy,
    name: head ? `SKU gap segments — ${head}` : "SKU gap segments (company)",
    measures,
    population:
      "Territory distributor channel only — project / Non-territory / Govt business is EXCLUDED " +
      "from gap and breadth baselines. Gap value = historical net of codes NOT bought in the period, " +
      "same fiscal months across all loaded FYs.",
    source: "getSkuRecommendations (sale_line_current, item catalogue)",
    cutoff: period.desc,
    flags: fy === openFy() ? ["LIKE_MONTHS_BASIS"] : [],
    parent: head ? `head/${head}/${fy}` : `company/${fy}`,
    children: top.map((r) => `segment/${r.segment}/${fy}`),
    childrenSumToParent: null,
    detail: {
      fiscalMonths: result.fiscalMonths,
      topGapSegments: top.map((r) => ({
        rank: r.rank,
        segment: r.segment,
        gapNet: r.gapNet,
        gapCodeCount: r.gapCodeCount,
        breadthPct: r.breadthPct,
        codesBought: r.codesBought,
        codesEverSold: r.codesEverSold,
        topGapCodes: r.topGapCodes.slice(0, 5),
      })),
    },
    isGap: false,
  };
}

// ── sku/push/{distributorKey}/{fy} ───────────────────────────────────────────

export async function resolveSkuPush(distributorKey: string, fy: string): Promise<GraphNode> {
  const period = await periodFor(fy);
  const result = await getSkuPushList({
    fy,
    monthLabels: period.labels,
    level: "distributor",
    distributorKey,
  });

  // K4 enrichment: peak quarter + above-own-norm discount flags (same as the route).
  const allCodes = new Set<string>();
  for (const seg of result.segments ?? []) for (const c of seg.topCodes ?? []) allCodes.add(c.code);
  const [normFlags, peakMap] = await Promise.all([
    getDiscountNormFlags(fy, [...allCodes], period.labels).catch(() => new Map()),
    getPeakQuarterMap().catch(() => new Map()),
  ]);

  const measures: MeasureValue[] = result.segments
    .slice(0, 5)
    .map((s) => mv("primary_sale", `Peer net — ${s.segment}`, s.topCodes.reduce((a, c) => a + c.peerNet, 0)));

  const flags: string[] = [];
  if (result.suppressed) flags.push("PUSH_LIST_SUPPRESSED");
  if (result.isFallback) flags.push(`FALLBACK_POOL_${(result.fallbackTier ?? "state").toUpperCase()}`);
  if (fy === openFy()) flags.push("LIKE_MONTHS_BASIS");

  return {
    path: `sku/push/${distributorKey}/${fy}`,
    level: "segment",
    fy,
    name: `Push list — ${distributorKey}`,
    measures,
    population:
      `Peer cohort: ${result.cohortSize} distributors (${result.cohortBasis} basis, cohort FY 2025-26` +
      `${result.quintile != null ? `, quintile ${result.quintile}` : ""}). ` +
      "Gap codes require ≥3 segment-active peers. Territory channel only — project business excluded.",
    source: "getSkuPushList + getDiscountNormFlags + getPeakQuarterMap (sale_line_current)",
    cutoff: period.desc,
    flags,
    parent: `distributor/${distributorKey}/${fy}`,
    children: [],
    childrenSumToParent: null,
    detail: {
      suppressed: result.suppressed,
      suppressReason: result.suppressReason ?? null,
      isFallback: result.isFallback,
      fallbackScopeName: result.fallbackScopeName ?? null,
      peerNames: result.peerNames,
      segments: result.segments.slice(0, 8).map((s) => ({
        rank: s.rank,
        segment: s.segment,
        segmentPeerCount: s.segmentPeerCount,
        totalGapCodes: s.totalGapCodes,
        peakQuarter: (peakMap.get(s.segment) as { peakQuarterLabel?: string } | undefined)?.peakQuarterLabel ?? null,
        topCodes: s.topCodes.slice(0, 5).map((c) => ({
          ...c,
          discountAboveOwnNorm: normFlags.has(c.code)
            ? (normFlags.get(c.code) as { aboveNormPts: number }).aboveNormPts
            : null,
        })),
      })),
    },
    isGap: false,
  };
}

// ── segment/{name}/{fy} — seasonality + period facts ─────────────────────────

export async function resolveSegment(segment: string, fy: string): Promise<GraphNode | null> {
  const [seasonality, period] = await Promise.all([
    getSeasonality("territory"),
    periodFor(fy),
  ]);
  const seg = seasonality.segments.find(
    (s) => s.segment.toLowerCase() === segment.toLowerCase(),
  );

  // Period net for this segment in the requested FY (verified primary SKU facts).
  const facts = await loadSkuFacts({
    fy,
    level: "distributor",
    scope: "company",
    monthLabels: period.labels,
    segment: seg?.segment ?? segment,
  }).catch(() => null);
  const segFact = facts?.facts?.bySegment.find(
    (b) => b.segment.toLowerCase() === segment.toLowerCase(),
  );

  if (!seg && !segFact) return null;

  const measures: MeasureValue[] = [];
  if (segFact) measures.push(mv("primary_sale", `Net (${period.desc})`, segFact.net));
  if (seg) measures.push(mv("primary_sale", "Historical net, closed FYs pooled (seasonality basis)", seg.totalNet));

  return {
    path: `segment/${seg?.segment ?? segment}/${fy}`,
    level: "segment",
    fy,
    name: seg?.segment ?? segment,
    measures,
    population:
      "Territory channel only — project rows excluded. Seasonality pooled over closed FYs; " +
      "period net from sale_line_current for the requested FY.",
    source: "getSeasonality(territory) + loadSkuFacts (sale_line_current)",
    cutoff: period.desc,
    flags: fy === openFy() ? ["LIKE_MONTHS_BASIS"] : [],
    parent: `company/${fy}`,
    children: [],
    childrenSumToParent: null,
    detail: seg
      ? {
          peakQuarter: seg.peakQuarterLabel,
          peakMonth: seg.peakMonth,
          quarterShare: seg.quarterShare,
          yearsConsistent: seg.yearsConsistent,
          seasonalityBasis: seasonality.basis,
          seasonalityFys: seasonality.fys,
        }
      : { note: "No seasonality curve — segment absent from closed-FY history." },
    isGap: false,
  };
}

// ── sku/discounts/{fy} — effective discount per code + variance ──────────────

export async function resolveSkuDiscounts(fy: string): Promise<GraphNode> {
  const period = await periodFor(fy);
  const [secondary, primary] = await Promise.all([
    getSecondaryDiscountByCode(fy),
    getPrimaryDiscountByCode(fy, "territory", fy === openFy() ? period.labels : null),
  ]);

  const measures: MeasureValue[] = [];
  const flags: string[] = [];
  if (!secondary.available) flags.push("SECONDARY_DISCOUNT_UNAVAILABLE");
  if (fy === openFy()) flags.push("LIKE_MONTHS_BASIS");

  const trim = (rows: typeof primary.codes) =>
    rows.slice(0, 15).map((c) => ({
      code: c.code,
      segment: c.segment,
      customers: c.customers,
      net: c.net,
      avgDiscountPct: Math.round(c.avgDiscount * 1000) / 10,
      minDiscountPct: Math.round(c.minDiscount * 1000) / 10,
      maxDiscountPct: Math.round(c.maxDiscount * 1000) / 10,
      spreadPts: Math.round(c.spread * 1000) / 10,
      lowCustomer: c.lowCustomer,
      highCustomer: c.highCustomer,
    }));

  return {
    path: `sku/discounts/${fy}`,
    level: "segment",
    fy,
    name: "Effective discount by item code",
    measures,
    population:
      "TWO DIFFERENT MEASURES — never mix: (1) primary = discount off rate-list MRP, what the " +
      "distributor pays vs list, territory channel only; (2) secondary = the register Discount " +
      "column at retailer level (gross×(1−d%)=Sub Total). Neither is margin — no cost master exists.",
    source:
      "getPrimaryDiscountByCode (sale_line_current + item_master MRP); " +
      "getSecondaryDiscountByCode (secondary_sku_line register Discount column)",
    cutoff: period.desc,
    flags,
    parent: `company/${fy}`,
    children: [],
    childrenSumToParent: null,
    detail: {
      primary: {
        measureLabel: primary.measureLabel,
        mrpCoverage: primary.mrpCoverage,
        topCodesByNet: trim(primary.codes),
        widestVariance: trim(primary.widestGaps),
      },
      secondary: secondary.available
        ? {
            measureLabel: secondary.measureLabel,
            topCodesByNet: trim(secondary.codes as typeof primary.codes),
            widestVariance: trim(secondary.widestGaps as typeof primary.codes),
            verification: secondary.verification,
          }
        : { available: false, reason: secondary.reason },
    },
    isGap: false,
  };
}

// ── sku/detail/{fy} — live-year secondary detail (retailer×code×distributor) ─

export async function resolveSkuDetail(fy: string): Promise<GraphNode> {
  const period = await periodFor(fy);
  const result = await loadSkuFacts({
    fy,
    level: "retailer",
    scope: "company",
    monthLabels: period.labels,
  });

  const cap = result.capability.retailer;
  const facts = result.facts;

  const measures: MeasureValue[] = facts
    ? [
        mv("secondary_sale", "Secondary register net (period)", facts.summary.totalNet),
        mv("secondary_sale", "Distinct item codes", facts.summary.totalCodes, "count"),
        mv("secondary_sale", "Segments bought", facts.summary.segmentsBought, "count"),
      ]
    : [];

  const flags: string[] = [];
  if (!cap.available) flags.push("SECONDARY_DETAIL_UNAVAILABLE");
  if (fy === openFy()) flags.push("PARTIAL_LIVE_REGISTER");

  return {
    path: `sku/detail/${fy}`,
    level: "segment",
    fy,
    name: "Secondary SKU register detail",
    measures,
    population:
      "secondary_sku_line — retailer × item code × distributor rows with the register discount. " +
      "A DIFFERENT population from primary sale_line; never sum the two. " +
      (fy === openFy()
        ? "FY2026-27 covers Apr–Jun 2026 only (PSCode_3 xlsx drop); later months are absent, not zero."
        : ""),
    source: "loadSkuFacts level=retailer (secondary_sku_line)",
    cutoff: cap.available ? period.desc : (cap.reason ?? "not available"),
    flags,
    parent: `company/${fy}`,
    children: [],
    childrenSumToParent: null,
    detail: facts
      ? {
          bySegment: facts.bySegment.slice(0, 12),
          topCodes: facts.byCode.slice(0, 15),
          unmapped: facts.unmapped,
        }
      : { available: false, reason: cap.reason ?? "not available" },
    isGap: false,
  };
}

// ── likemonths window description (shared with company/head likemonths nodes) ─

export async function likeMonthsWindow(targetFy: string): Promise<{
  labels: string[];
  monthNames: string[];
  desc: string;
}> {
  const lm = await likeMonthLabelsFor(targetFy);
  return {
    ...lm,
    desc:
      lm.monthNames.length > 0
        ? `Like months only: ${lm.monthNames[0]}–${lm.monthNames[lm.monthNames.length - 1]} of FY${targetFy} (complete months of the open FY)`
        : "No complete months in the open FY yet",
  };
}
