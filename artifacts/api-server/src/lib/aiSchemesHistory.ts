/**
 * Prompt 95: historical-basis scheme analytics and proposal generation.
 *
 * This module is deliberately read-only.  The scheme tables are an observed
 * definition source, not an outcome ledger: nothing here infers qualification,
 * payout, ordering, cost, or lift from those definitions.
 */
import { pool } from "@workspace/db";

export type HistoryScheme = {
  schemeId: string;
  name: string;
  source: string;
  qualificationBasis: string;
  settlement: string;
  audience: string[];
  territoryGroup: string | null;
  productScope: string | null;
  periodFrom: string;
  periodTo: string | null;
  periodNote: string | null;
  itemGroups: string[];
  slabs: Array<{
    slabOrder: number;
    thresholdFrom: number;
    thresholdTo: number | null;
    unit: string;
    ratePct: number | null;
    altReward: string | null;
    freeGoods: string | null;
    rewardStatus: string;
    rawText: string | null;
  }>;
  observedStructure: {
    slabCount: number;
    thresholdUnit: string | null;
    hasAlternativeReward: boolean;
    hasFreeGoods: boolean;
  };
};

type RawScheme = Record<string, unknown>;
type RawSlab = Record<string, unknown>;
type RawTerritory = Record<string, unknown>;
type RawItemGroup = Record<string, unknown>;

const SOURCE = "database scheme, scheme_reward_slab, scheme_item_group, and territory_group tables";
export const MODELED_COST_ASSUMPTION =
  "Conservative modeled cost assumption: first usable observed percentage slab threshold × breadthOpportunityRetailers.";
const SOURCE_LABELS = {
  definitions: SOURCE,
  scheme: "scheme table (observed definition; not an outcome record)",
  slabs: "scheme_reward_slab table (observed threshold/reward text)",
  itemGroups: "scheme_item_group table (raw basket mapping)",
  territories: "territory_group table (raw territory mapping)",
};

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function dateText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.valueOf()) ? null : value.toISOString().slice(0, 10);
  }
  const result = String(value);
  const isoDate = result.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;
  const parsed = new Date(result);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function rounded(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function monthLabels(from: string, to: string | null): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to ?? from}T00:00:00Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return [];
  const result: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end && result.length < 120) {
    result.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

function normal(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleUpperCase();
}

function territoryMatches(requested: string, group: HistoryScheme["territoryGroup"], states: string[]): boolean {
  if (!group) return false;
  const needle = normal(requested);
  return normal(group) === needle ||
    states.some((state) => normal(state) === needle) ||
    normal(group).includes(needle) ||
    needle.includes(normal(group));
}

function historicalScheme(raw: RawScheme, slabs: RawSlab[], itemGroups: string[]): HistoryScheme {
  const mappedSlabs = slabs
    .sort((a, b) => (number(a.slab_order) ?? 0) - (number(b.slab_order) ?? 0))
    .map((slab) => ({
      slabOrder: number(slab.slab_order) ?? 0,
      thresholdFrom: number(slab.threshold_from) ?? 0,
      thresholdTo: number(slab.threshold_to),
      unit: text(slab.unit) ?? "unavailable",
      ratePct: number(slab.rate) === null ? null : rounded((number(slab.rate) ?? 0) * 100),
      altReward: text(slab.alt_reward),
      freeGoods: text(slab.free_goods),
      rewardStatus: text(slab.reward_status) ?? "unavailable",
      rawText: text(slab.raw_text),
    }));
  return {
    schemeId: text(raw.scheme_id) ?? "",
    name: text(raw.name) ?? "",
    source: SOURCE_LABELS.scheme,
    qualificationBasis: text(raw.qualification_basis) ?? "unavailable",
    settlement: text(raw.settlement) ?? "unavailable",
    audience: Array.isArray(raw.audience) ? raw.audience.map(String) : [],
    territoryGroup: text(raw.territory_group),
    productScope: text(raw.product_scope),
    periodFrom: dateText(raw.period_from) ?? "",
    periodTo: dateText(raw.period_to),
    periodNote: text(raw.period_note),
    itemGroups: [...new Set(itemGroups)].sort(),
    slabs: mappedSlabs,
    observedStructure: {
      slabCount: mappedSlabs.length,
      thresholdUnit: mappedSlabs[0]?.unit ?? null,
      hasAlternativeReward: mappedSlabs.some((slab) => Boolean(slab.altReward)),
      hasFreeGoods: mappedSlabs.some((slab) => Boolean(slab.freeGoods)),
    },
  };
}

function sourceCoverage(schemes: HistoryScheme[]) {
  const rawValues = [...new Set(schemes.flatMap((scheme) => scheme.itemGroups))].sort();
  return {
    raw: {
      available: rawValues.length > 0,
      distinctValues: rawValues.length,
      values: rawValues,
      source: SOURCE_LABELS.itemGroups,
    },
    canonical: {
      available: false,
      distinctValues: null,
      values: [],
      source: "unavailable: scheme_item_group stores raw item_group values and has no canonical mapping column",
    },
    statement: "Raw scheme basket labels are observed. Canonical item-group coverage is unavailable and is not inferred.",
  };
}

function timeline(schemes: HistoryScheme[]) {
  const observed = [...new Set(schemes.flatMap((scheme) => monthLabels(scheme.periodFrom, scheme.periodTo)))].sort();
  const gaps: string[] = [];
  if (observed.length > 1) {
    const cursor = new Date(`${observed[0]}-01T00:00:00Z`);
    const end = new Date(`${observed[observed.length - 1]}-01T00:00:00Z`);
    const set = new Set(observed);
    while (cursor <= end) {
      const value = cursor.toISOString().slice(0, 7);
      if (!set.has(value)) gaps.push(value);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  const gapQuarters = [...new Set(gaps.map((month) => {
    const monthNumber = Number(month.slice(5, 7));
    return `${month.slice(0, 4)}-Q${monthNumber <= 3 ? 4 : monthNumber <= 6 ? 1 : monthNumber <= 9 ? 2 : 3}`;
  }))];
  return {
    observedPeriods: observed,
    gaps,
    gapQuarters,
    statement: gaps.length
      ? "Only periods represented by scheme definition dates are observed; gaps have no scheme-definition evidence."
      : "No gap can be established from the observed scheme definition dates.",
  };
}

function precedentBounds(schemes: HistoryScheme[]) {
  const slabs = schemes.flatMap((scheme) => scheme.slabs);
  const rates = slabs.map((slab) => slab.ratePct).filter((rate): rate is number => rate !== null);
  const counts = schemes.map((scheme) => scheme.slabs.length);
  return {
    slabCount: { min: counts.length ? Math.min(...counts) : null, max: counts.length ? Math.max(...counts) : null },
    ratePct: { min: rates.length ? Math.min(...rates) : null, max: rates.length ? Math.max(...rates) : null },
    threshold: {
      min: slabs.length ? Math.min(...slabs.map((slab) => slab.thresholdFrom)) : null,
      max: slabs.length ? Math.max(...slabs.map((slab) => slab.thresholdFrom)) : null,
    },
    breadth: {
      available: false,
      min: null,
      max: null,
      statement: "No historical breadth outcome or qualification ledger is available.",
    },
    spend: {
      available: false,
      largestSchemeCost: null,
      statement: "Exact historical scheme cost is unavailable; no spend comparison is inferred.",
    },
    statement: "Bounds describe observed definition structures only; they are not qualification, payout, cost, or lift limits.",
  };
}

export async function readAiSchemesHistory(filters?: {
  itemGroup?: string;
  skuBand?: string;
  territory?: string;
  year?: string;
  fy?: string;
}): Promise<Record<string, unknown>> {
  const [schemeResult, slabResult, territoryResult, itemResult] = await Promise.all([
    pool.query("SELECT * FROM scheme ORDER BY scheme_id"),
    pool.query("SELECT * FROM scheme_reward_slab ORDER BY scheme_id, slab_order"),
    pool.query("SELECT * FROM territory_group ORDER BY group_raw"),
    pool.query("SELECT * FROM scheme_item_group ORDER BY item_group, scheme_id"),
  ]);
  const territories = territoryResult.rows as RawTerritory[];
  const territoryStates = new Map(
    territories.map((row) => [text(row.group_raw) ?? "", Array.isArray(row.states) ? row.states.map(String) : []]),
  );
  const groupsByScheme = new Map<string, string[]>();
  for (const row of itemResult.rows as RawItemGroup[]) {
    const id = text(row.scheme_id) ?? "";
    const groups = groupsByScheme.get(id) ?? [];
    groups.push(text(row.item_group) ?? "");
    groupsByScheme.set(id, groups);
  }
  let schemes = (schemeResult.rows as RawScheme[]).map((row) => historicalScheme(
    row,
    (slabResult.rows as RawSlab[]).filter((slab) => text(slab.scheme_id) === text(row.scheme_id)),
    groupsByScheme.get(text(row.scheme_id) ?? "") ?? [],
  ));
  if (filters?.itemGroup) {
    const group = normal(filters.itemGroup);
    schemes = schemes.filter((scheme) => scheme.itemGroups.some((item) => normal(item) === group));
  }
  if (filters?.territory) {
    schemes = schemes.filter((scheme) => territoryMatches(
      filters.territory!,
      scheme.territoryGroup,
      territoryStates.get(scheme.territoryGroup ?? "") ?? [],
    ));
  }
  const year = filters?.year ?? filters?.fy;
  if (year) {
    const rawYear = year.trim();
    const yearNeedle = rawYear.slice(0, 4);
    const startDate = rawYear.includes("-") ? `${yearNeedle}-04-01` : `${yearNeedle}-01-01`;
    const endDate = rawYear.includes("-")
      ? `${Number(yearNeedle) + 1}-03-31`
      : `${yearNeedle}-12-31`;
    schemes = schemes.filter((scheme) =>
      scheme.periodFrom <= endDate && (!scheme.periodTo || scheme.periodTo >= startDate),
    );
  }
  // SKU bands are an outcome-analysis classification, not a scheme-table
  // dimension. Keep the filter explicit rather than pretending it is a join.
  const skuBand = filters?.skuBand?.trim() || null;
  const allItemGroups = [...new Set((itemResult.rows as RawItemGroup[])
    .map((row) => text(row.item_group))
    .filter((value): value is string => Boolean(value)))].sort();
  const periodValues = schemes.flatMap((scheme) => [scheme.periodFrom, scheme.periodTo].filter((value): value is string => Boolean(value)));
  const periodFrom = periodValues.length ? periodValues.sort()[0] : null;
  const periodTo = periodValues.length ? periodValues.sort().at(-1) ?? null : null;
  const now = new Date().toISOString().slice(0, 10);
  const liveCount = schemes.filter((scheme) => !scheme.periodTo || scheme.periodTo >= now).length;
  const coveredGroups = allItemGroups.filter((group) => schemes.some((scheme) => scheme.itemGroups.includes(group)));
  const durationKinds = [...new Set(schemes.map((scheme) => {
    const months = monthLabels(scheme.periodFrom, scheme.periodTo).length;
    return months >= 12 ? "annual-or-open" : months >= 3 ? "quarter-or-season" : "short-period";
  }))];
  const slabCounts = schemes.map((scheme) => scheme.slabs.length);
  const typicalSlabCount = slabCounts.length ? Math.round(slabCounts.reduce((sum, count) => sum + count, 0) / slabCounts.length) : null;
  const rates = schemes.flatMap((scheme) => scheme.slabs.map((slab) => slab.ratePct).filter((rate): rate is number => rate !== null));
  const rateSteps = rates.length > 1 ? [...new Set(rates.slice(1).map((rate, index) => rounded(rate - rates[index])))].sort((a, b) => a - b) : [];
  return {
    readOnly: true,
    source: SOURCE,
    sourceLabels: SOURCE_LABELS,
    schemes,
    filters: {
      applied: {
        itemGroup: filters?.itemGroup ?? null,
        skuBand,
        territory: filters?.territory ?? null,
        year: year ?? null,
      },
      metadata: {
        itemGroups: allItemGroups,
        skuBands: ["VERY HIGH", "HIGH", "MEDIUM", "LOW", "SCARCE", "DORMANT"],
        territories: territories.map((row) => ({
          raw: text(row.group_raw) ?? "",
          label: text(row.label) ?? "",
          states: Array.isArray(row.states) ? row.states.map(String) : [],
        })),
      },
    },
    timeline: timeline(schemes),
    observedGrammar: {
      qualificationBases: [...new Set(schemes.map((scheme) => scheme.qualificationBasis))].sort(),
      settlementModes: [...new Set(schemes.map((scheme) => scheme.settlement))].sort(),
      thresholdUnits: [...new Set(schemes.flatMap((scheme) => scheme.slabs.map((slab) => slab.unit)))].sort(),
      rewardForms: {
        percentage: schemes.some((scheme) => scheme.slabs.some((slab) => slab.ratePct !== null)),
        alternativeReward: schemes.some((scheme) => scheme.observedStructure.hasAlternativeReward),
        freeGoods: schemes.some((scheme) => scheme.observedStructure.hasFreeGoods),
      },
      typicalSlabCount,
      thresholdSpacing: {
        available: schemes.length > 0,
        statement: "Threshold values are copied from observed slabs; no optimal spacing is inferred.",
        values: [...new Set(schemes.flatMap((scheme) => scheme.slabs.map((slab) => slab.thresholdFrom)))].sort((a, b) => a - b),
      },
      rateLadder: {
        available: rates.length > 0,
        observedRatesPct: [...new Set(rates)].sort((a, b) => a - b),
        observedRateStepsPct: rateSteps,
      },
      duration: durationKinds,
      itemGroupsPerScheme: {
        available: true,
        min: schemes.length ? Math.min(...schemes.map((scheme) => scheme.itemGroups.length)) : null,
        max: schemes.length ? Math.max(...schemes.map((scheme) => scheme.itemGroups.length)) : null,
      },
      territoryScope: {
        available: schemes.length > 0,
        observed: [...new Set(schemes.map((scheme) => scheme.territoryGroup ?? "unavailable"))],
      },
      statement: "Grammar is copied from observed definition rows; no missing qualification or payout terms are filled in.",
    },
    historySummary: {
      schemeCount: schemes.length,
      periodFrom,
      periodTo,
      historicalCount: schemes.length - liveCount,
      currentlyLiveCount: liveCount,
      source: SOURCE_LABELS.definitions,
    },
    outcomeEvidence: {
      qualificationRecorded: false,
      payoutRecorded: false,
      schemeOrderLinkageRecorded: false,
      statement: "No table records who qualified, payout, or a link between a scheme and orders.",
      source: "Unavailable in scheme definition tables",
    },
    controlAndLift: {
      available: false,
      controlGroupAvailable: false,
      liftAvailable: false,
      statement: "Controls and lift are unavailable where no valid uncovered-territory mapping exists; no historical outcome series is available.",
      source: "Unavailable: scheme definitions contain no outcome/control observations",
    },
    itemGroupCoverage: {
      allItemGroups,
      covered: coveredGroups,
      neverCovered: allItemGroups.filter((group) => !coveredGroups.includes(group)),
      neverCoveredAvailable: true,
      statement: "The universe is the distinct raw item_group values present in scheme_item_group. Values absent from that table cannot be claimed as never-covered without an external item-group master.",
      source: SOURCE_LABELS.itemGroups,
    },
    coverage: sourceCoverage(schemes),
    outcomeAvailability: {
      available: false,
      statement: "Historical qualification, payout, exact scheme cost, order linkage, and measured lift/outcomes are unavailable.",
      evidenceBasis: SOURCE,
    },
    precedentBounds: precedentBounds(schemes),
  };
}

function isHeldOrUnknown(body: Record<string, unknown>): boolean {
  const status = normal(text(body.marginStatus));
  const nestedMargins = ["margin", "marginInput", "marginInputs"]
    .map((key) => body[key])
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object");
  const nestedStatus = nestedMargins.some((margin) => {
    const value = normal(text(margin.status ?? margin.marginStatus));
    return value === "HELD" || value === "UNKNOWN" || value === "UNAVAILABLE" ||
      margin.held === true || margin.unknown === true;
  });
  const heldPeriods = body.heldPeriods;
  return body.held === true || status === "HELD" || status === "UNKNOWN" || status === "UNAVAILABLE" ||
    body.marginUnknown === true || body.marginHeld === true || body.dataHeld === true ||
    body.resolutionHeld === true || nestedStatus ||
    (Array.isArray(heldPeriods) && heldPeriods.length > 0);
}

function inputNumber(body: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const direct = number(body[key]);
    if (direct !== null) return direct;
    for (const nested of ["margin", "marginInput", "marginInputs", "breadth", "breadthInput", "breadthInputs"]) {
      const value = body[nested];
      if (value && typeof value === "object") {
        const nestedValue = number((value as Record<string, unknown>)[key]);
        if (nestedValue !== null) return nestedValue;
      }
    }
  }
  return null;
}

export async function generateAiSchemesHistoryProposal(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (isHeldOrUnknown(body)) throw new Error("Cannot generate a historical-basis proposal from held or unknown-margin input");
  const marginCapPct = inputNumber(body, ["marginCapPct", "marginCap", "maximumSchemeDepthPct"]);
  const breadthOpportunityRetailers = inputNumber(body, ["breadthOpportunityRetailers"]);
  const categoryGrossMarginInr = inputNumber(body, ["categoryGrossMarginInr"]);
  const grossMarginRatePct = inputNumber(body, ["grossMarginRatePct"]);
  if (marginCapPct === null || marginCapPct <= 0 || !Number.isFinite(marginCapPct)) {
    throw new Error("A known positive marginCapPct is required");
  }
  if (breadthOpportunityRetailers === null || !Number.isInteger(breadthOpportunityRetailers) || breadthOpportunityRetailers <= 0) {
    throw new Error("A positive integer breadthOpportunityRetailers is required");
  }
  if (categoryGrossMarginInr === null || categoryGrossMarginInr <= 0 || !Number.isFinite(categoryGrossMarginInr)) {
    throw new Error("A positive categoryGrossMarginInr is required");
  }
  if (grossMarginRatePct === null || grossMarginRatePct <= 0 || !Number.isFinite(grossMarginRatePct)) {
    throw new Error("A positive grossMarginRatePct is required");
  }
  const itemGroup = text(body.itemGroup)?.trim() || undefined;
  const skuBand = text(body.skuBand)?.trim() || undefined;
  if (!itemGroup && !skuBand) throw new Error("Exactly one of itemGroup or skuBand is required");
  if (itemGroup && skuBand) throw new Error("Provide itemGroup or skuBand, not both");
  const territory = text(body.territory)?.trim();
  if (!territory) throw new Error("territory is required");
  const history = await readAiSchemesHistory({ itemGroup, skuBand, territory });
  const schemes = history.schemes as HistoryScheme[];
  // If a SKU band was requested it is intentionally not treated as a
  // canonical item-group join; all observed structures remain candidates.
  const comparableHistory = schemes.length
    ? history
    : await readAiSchemesHistory({ itemGroup, skuBand });
  const candidates = (comparableHistory.schemes as HistoryScheme[]).length
    ? comparableHistory.schemes as HistoryScheme[]
    : (await readAiSchemesHistory()).schemes as HistoryScheme[];
  const usableCandidates = candidates.filter((candidate) =>
    candidate.slabs.some((slab) => slab.ratePct !== null && slab.ratePct > 0 && slab.rewardStatus === "ok"),
  );
  if (!usableCandidates.length) {
    throw new Error("No observed precedent with a usable percentage slab matches the requested item/territory");
  }
  const precedent = [...usableCandidates].sort((a, b) =>
    Math.abs(a.slabs.length - 6) - Math.abs(b.slabs.length - 6) ||
    a.schemeId.localeCompare(b.schemeId),
  )[0];
  const firstUsableSlab = precedent.slabs.find((slab) =>
    slab.ratePct !== null && slab.ratePct > 0 && slab.rewardStatus === "ok",
  );
  if (!firstUsableSlab) {
    throw new Error("No usable percentage slab is available for modeled economics");
  }
  const proposedSlabs = precedent.slabs.map((slab) => ({
    ...slab,
    ratePct: slab.ratePct === null ? null : Math.min(slab.ratePct, marginCapPct),
  }));
  const rateClamped = proposedSlabs.some((slab, index) => slab.ratePct !== precedent.slabs[index].ratePct);
  const maxObserved = Math.max(...precedent.slabs.map((slab) => slab.ratePct ?? 0), 0);
  const modeledCostInr = firstUsableSlab.thresholdFrom * breadthOpportunityRetailers;
  const costAsMarginPct = modeledCostInr / categoryGrossMarginInr * 100;
  const breakevenLiftRequiredInr = modeledCostInr / (grossMarginRatePct / 100);
  // "Beyond precedent" is limited to observed definition structure. The
  // supplied margin cap is a modeled design ceiling, not historical cost
  // evidence, and exact historical spend bounds are unavailable.
  const beyondPrecedent = false;
  const validTerritory = Boolean(precedent.territoryGroup);
  const targetGroupHistoryAvailable = itemGroup
    ? precedent.itemGroups.some((group) => normal(group) === normal(itemGroup))
    : true;
  return {
    readOnly: true,
    persisted: false,
    writes: [],
    source: SOURCE,
    input: {
      itemGroup: itemGroup ?? null,
      skuBand: skuBand ?? null,
      territory,
      breadthOpportunityRetailers,
      categoryGrossMarginInr,
      grossMarginRatePct,
      marginCapPct,
    },
    closestPrecedent: {
      schemeId: precedent.schemeId,
      name: precedent.name,
      source: precedent.source,
      comparableBasis: targetGroupHistoryAvailable
        ? "Requested item group/band and territory"
        : "Nearest observed comparable structure; no history exists for the requested item group",
      reason: "Closest observed structure after item/band and territory filtering; no outcome similarity is claimed.",
    },
    proposal: {
      name: `Historical-basis proposal from ${precedent.schemeId}`,
      territory,
      itemGroup: itemGroup ?? null,
      skuBand: skuBand ?? null,
      qualificationBasis: precedent.qualificationBasis,
      settlement: precedent.settlement,
      slabs: proposedSlabs,
      duration: {
        periodFrom: precedent.periodFrom,
        periodTo: precedent.periodTo,
        periodNote: precedent.periodNote,
      },
      estimatedCostInr: modeledCostInr,
      costAsMarginPct,
      costType: "modeled_not_actual",
      costStatement: "Modeled cost only; it is not actual historical spend.",
      modeledCostAssumption: MODELED_COST_ASSUMPTION,
    },
    margin: {
      marginCapPct,
      maximumProposedRatePct: Math.min(maxObserved, marginCapPct),
      rateClamped,
      statement: "Every proposed percentage is capped at the supplied margin cap; this is a design constraint, not historical cost evidence.",
    },
    breakeven: {
      available: true,
      value: breakevenLiftRequiredInr,
      unit: "rupees",
      statement: "Modeled breakeven lift required from modeled cost and supplied gross margin rate; it is not an observed outcome.",
      evidenceBasis: MODELED_COST_ASSUMPTION,
    },
    breakevenLiftRequired: {
      available: true,
      valueInr: breakevenLiftRequiredInr,
      statement: "Modeled breakeven lift required; exact historical cost and payout remain unavailable.",
      evidenceBasis: MODELED_COST_ASSUMPTION,
    },
    flags: {
      beyondPrecedent,
      observedDefinitionExceeded: beyondPrecedent,
      rateClamped,
      modeledRateCeilingApplied: true,
      modeledRateCeilingBinding: rateClamped,
      historicalCostCeilingAvailable: false,
      historicalCostComparisonPerformed: false,
      breadthBeyondPrecedent: false,
      amountBeyondPrecedent: false,
      targetGroupHistoryAvailable,
      borrowedFromComparableGroup: !targetGroupHistoryAvailable,
      controlsAndLiftAvailable: validTerritory ? false : false,
      statement: beyondPrecedent
        ? "Requested definition structure goes beyond observed scheme definitions. No historical cost comparison was performed."
        : "No observed definition structure was exceeded. The supplied margin cap is a modeled rate ceiling, not an observed historical cost ceiling; no historical cost comparison was performed.",
    },
    controlLift: {
      available: false,
      value: null,
      statement: "Controls and lift are unavailable: no valid uncovered-territory mapping or historical outcome/control series is available.",
    },
    evidenceBasis: [
      SOURCE_LABELS.scheme,
      SOURCE_LABELS.slabs,
      SOURCE_LABELS.itemGroups,
      "Historical outcomes, exact cost, payout, and scheme order linkage: unavailable",
      MODELED_COST_ASSUMPTION,
    ],
    guardrails: {
      schemeItemGroupMutated: false,
      schemeTablesMutated: false,
      sourceHonesty: "Observed definitions are copied; unavailable outcomes are not estimated.",
    },
  };
}