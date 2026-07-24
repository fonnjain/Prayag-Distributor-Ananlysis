// Phase A5 — Distributor AI Payload builder.
//
// Transforms a DistributorDeepDiveResult into a lean, Claude-safe payload:
//   - No raw retailer row lists (only aggregates and top-N summaries)
//   - Direct dealer branch explicitly labelled as PARALLEL
//   - Flow gap carries the two-reading note in the type so every consumer sees it
//   - Coverage/assignment gaps are kept separate with different remedies
//   - Data quality flags populated from result fields
//
// Rules:
//   app = numbers. Claude = judgement.
//   Never expose individual retailer arrays to Claude.
//   Never console.log.

import type { DistributorDeepDiveResult } from "./distributorDeepDive.js";

// ── Public payload type ───────────────────────────────────────────────────────

export type DistributorPayloadDistributor = {
  name: string;
  normKey: string;
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  orderBooking: number;
  obSharePct: number | null;       // share of partyObTotal
  isConcentrationRisk: boolean;    // obSharePct >= 60%
  flows: {
    hasPrimaryData: boolean;
    primaryDispatch: number;
    secondaryOut: number;
    flowGap: number | null;        // positive = stock building OR outside-channel, see note
    flowGapTwoReadings: "positive gap may mean (1) stock building at distributor OR (2) business moving outside attributed channel — both readings valid; no stock data to distinguish";
    growthPct: number | null;
    yoyPeriod: string;
    daysSinceLastOrder: number | null;
  } | null;
  tier: {
    tier: "A" | "B" | "C";
    score: number;
    visitCadence: string;
    creditPosture: string;
    isOverridden: boolean;
  } | null;
  effectiveDiscountPct: number | null;    // D4 closed-FY only; null for live FY
  topRetailerName: string | null;         // within-distributor top retailer
  topRetailerSharePct: number | null;
};

export type DistributorAiPayload = {
  identity: {
    fy: string;
    stateHead: string;
    scope: "single_distributor" | "all_distributors";
    distributorName: string | null;
    dataCutoff: string;
    generatedAt: string;
  };
  channelStructure: {
    namedDistributorRetailers: number;
    directDealerRetailers: number;
    unassignedRetailers: number;
    sharedRetailers: number;
    malformedRetailers: number;
    distributorCount: number;
    partyObTotal: number;
    directDealerOb: number;
    unassignedOb: number;
    directDealerIsParallelChannel: true;   // literal guard — never a child of any distributor
  };
  distributors: DistributorPayloadDistributor[];
  whitespace: {
    totalAssignmentGapRetailers: number;
    totalAssignmentGapDistricts: number;
    totalCoverageGapRetailers: number;
    totalCoverageGapDistricts: number;
    coverageGapPriorYearOb: number;
    channelConflictCount: number;
    coverageGapNote: "No distributor in district — fix by appointing one (strategic, slow)";
    assignmentGapNote: "Distributor exists but retailers unassigned — fix by admin assignment (immediate)";
    coverageGapDistricts: Array<{ district: string; priorYearOb: number; retailerCount: number }>;
    assignmentGapDistricts: Array<{ district: string; noneCount: number }>;
  } | null;
  concentration: {
    totalOb: number;
    top5SharePct: number | null;
    top10SharePct: number | null;
    topDistributorName: string | null;
    topDistributorSharePct: number | null;
    topDistributorSinglePointFlag: boolean;
  } | null;
  dataQuality: Array<{ code: string; message: string }>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveCutoff(result: DistributorDeepDiveResult): string {
  let latest = "";
  for (const d of result.distributors) {
    if (d.flows?.lastInvoiceDate && d.flows.lastInvoiceDate > latest) {
      latest = d.flows.lastInvoiceDate;
    }
  }
  if (latest) {
    return new Date(latest).toLocaleDateString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
    });
  }
  const [sy] = result.fy.split("-");
  const ey = Number(sy) + 1;
  const today = new Date();
  const fyEnd = new Date(ey, 2, 31);
  return today < fyEnd
    ? today.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : `31 Mar ${ey}`;
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Build a lean, Claude-safe distributor payload.
 * If selectedNormKey is provided, distributors array contains only that distributor.
 */
export function buildDistributorPayload(
  result: DistributorDeepDiveResult,
  selectedNormKey?: string,
): DistributorAiPayload {
  const mq = result.mappingQuality;
  const ws = result.whitespace;
  const conc = result.concentration;

  // Channel structure counts
  const channelStructure: DistributorAiPayload["channelStructure"] = {
    namedDistributorRetailers: mq?.distributorCount ?? 0,
    directDealerRetailers: mq?.blankCount ?? (result.directDealer?.retailerCount ?? 0),
    unassignedRetailers: mq?.noneCount ?? (result.noneAssigned?.retailerCount ?? 0),
    sharedRetailers: mq?.sharedCount ?? 0,
    malformedRetailers: mq?.malformedCount ?? 0,
    distributorCount: result.distributors.length,
    partyObTotal: result.partyObTotal,
    directDealerOb: result.directDealer?.orderBooking ?? 0,
    unassignedOb: result.noneAssigned?.orderBooking ?? 0,
    directDealerIsParallelChannel: true,
  };

  // Filter to requested scope
  const srcDistributors = selectedNormKey
    ? result.distributors.filter((d) => d.normKey === selectedNormKey)
    : result.distributors;

  const distributors: DistributorPayloadDistributor[] = srcDistributors.map((d) => ({
    name: d.name,
    normKey: d.normKey,
    retailerCount: d.retailerCount,
    activeCount: d.activeCount,
    dormantCount: d.dormantCount,
    orderBooking: d.orderBooking,
    obSharePct: d.obSharePct,
    isConcentrationRisk: d.isConcentrationRisk,
    flows: d.flows
      ? {
          hasPrimaryData: d.flows.hasPrimaryData,
          primaryDispatch: d.flows.primaryDispatch,
          secondaryOut: d.flows.secondaryOut,
          flowGap: d.flows.flowGap,
          flowGapTwoReadings: "positive gap may mean (1) stock building at distributor OR (2) business moving outside attributed channel — both readings valid; no stock data to distinguish",
          growthPct: d.flows.growthPct,
          yoyPeriod: d.flows.yoyPeriod,
          daysSinceLastOrder: d.flows.daysSinceLastOrder,
        }
      : null,
    tier: d.investment?.tier
      ? {
          tier: d.investment.tier.tier,
          score: d.investment.tier.score,
          visitCadence: d.investment.tier.visitCadence,
          creditPosture: d.investment.tier.creditPosture,
          isOverridden: d.investment.tier.isOverridden,
        }
      : null,
    effectiveDiscountPct: d.investment?.effectiveDiscount?.weightedDiscountPct ?? null,
    topRetailerName: d.retailerConcentration?.topRetailerName ?? null,
    topRetailerSharePct: d.retailerConcentration?.topRetailerSharePct ?? null,
  }));

  // Whitespace
  const whitespace: DistributorAiPayload["whitespace"] = ws
    ? {
        totalAssignmentGapRetailers: ws.totalAssignmentGapRetailers,
        totalAssignmentGapDistricts: ws.totalAssignmentGapDistricts,
        totalCoverageGapRetailers: ws.totalCoverageGapRetailers,
        totalCoverageGapDistricts: ws.totalCoverageGapDistricts,
        coverageGapPriorYearOb: ws.coverageGapPriorYearOb,
        channelConflictCount: ws.channelConflictCount,
        coverageGapNote: "No distributor in district — fix by appointing one (strategic, slow)",
        assignmentGapNote: "Distributor exists but retailers unassigned — fix by admin assignment (immediate)",
        coverageGapDistricts: ws.districtStats
          .filter((d) => d.gapType === "coverage" || d.gapType === "both")
          .map((d) => ({ district: d.district, priorYearOb: d.priorYearOb, retailerCount: d.totalCount })),
        assignmentGapDistricts: ws.districtStats
          .filter((d) => d.gapType === "assignment" || d.gapType === "both")
          .map((d) => ({ district: d.district, noneCount: d.noneCount })),
      }
    : null;

  // Concentration — top distributor by obSharePct
  const topDist = [...result.distributors].sort((a, b) => (b.obSharePct ?? 0) - (a.obSharePct ?? 0))[0];
  const concentration: DistributorAiPayload["concentration"] = conc
    ? {
        totalOb: conc.totalOb,
        top5SharePct: conc.top5SharePct,
        top10SharePct: conc.top10SharePct,
        topDistributorName: topDist?.name ?? null,
        topDistributorSharePct: topDist?.obSharePct ?? null,
        topDistributorSinglePointFlag: (topDist?.obSharePct ?? 0) >= 60,
      }
    : null;

  // Data quality flags
  const dataQuality: DistributorAiPayload["dataQuality"] = [];

  if (result.error) {
    dataQuality.push({ code: "LOAD_ERROR", message: result.error });
  }
  if (result.membersNotMapped > 0) {
    dataQuality.push({
      code: "MEMBERS_NOT_MAPPED",
      message: `${result.membersNotMapped} member working sheet(s) could not be loaded. Distributor aggregates are partial.`,
    });
  }
  if (mq && mq.malformedCount > 0) {
    dataQuality.push({
      code: "MALFORMED_ROWS",
      message: `${mq.malformedCount} retailer row(s) excluded — numeric distributor field (malformed data).`,
    });
  }
  if (topDist && (topDist.obSharePct ?? 0) >= 60) {
    dataQuality.push({
      code: "SINGLE_POINT_DEPENDENCY",
      message: `${topDist.name} accounts for ${topDist.obSharePct?.toFixed(1) ?? "?"}% of party order booking — single-point dependency risk.`,
    });
  }
  if (ws && ws.channelConflictCount > 0) {
    dataQuality.push({
      code: "CHANNEL_CONFLICT",
      message: `${ws.channelConflictCount} direct dealer(s) operate in districts that also have a named distributor — structural channel conflict.`,
    });
  }
  for (const d of result.distributors) {
    if (!d.flows?.hasPrimaryData) {
      dataQuality.push({
        code: "NO_PRIMARY_DATA",
        message: `${d.name}: no primary sale_line match found. Primary dispatch is unknown — do not show a zero.`,
      });
    }
  }

  return {
    identity: {
      fy: result.fy,
      stateHead: result.stateHeads[0] ?? "Unknown",
      scope: selectedNormKey ? "single_distributor" : "all_distributors",
      distributorName: srcDistributors[0]?.name ?? null,
      dataCutoff: deriveCutoff(result),
      generatedAt: new Date().toISOString(),
    },
    channelStructure,
    distributors,
    whitespace,
    concentration,
    dataQuality,
  };
}
