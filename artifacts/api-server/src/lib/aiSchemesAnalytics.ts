/**
 * Read-only arithmetic for AI Schemes Sections B (E2) and C (E3).
 *
 * This module intentionally contains no scheme-generation or recommendation
 * logic. Secondary order booking and primary dispatch remain separate sources.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { currentOpenFy } from "./fyAnchors.js";
import {
  getOpenResolutionHolds,
  resolveHoldExclusionsFromRows,
  type ResolutionHold,
} from "./resolution/holdResolver.js";
import { secondarySourceForMonth, SecondarySourceSeamError } from "./secondary/sourceContract.js";

const OPEN_FY_TTL_MS = 5 * 60 * 1000;
const CLOSED_FY_TTL_MS = 60 * 60 * 1000;

export type PairDistribution = {
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  bottomDecileAverage: number;
  topDecileAverage: number;
};

export type PairValueRow = { retailer: string; itemCode: string; value: number; category: string };

/** Stable cache input containing only hold fields that can affect arithmetic. */
export function aiSchemesHoldSignature(holds: ResolutionHold[]): string {
  return JSON.stringify(holds.map((hold) => ({
    id: String(hold.id),
    type: hold.type,
    scope: hold.scope,
    fiscalYear: hold.fiscalYear,
    month: hold.month,
    scopeProduct: hold.scopeProduct,
    scopeMeasure: hold.scopeMeasure,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

export type SkuBand = {
  band: "VERY HIGH" | "HIGH" | "MEDIUM" | "LOW" | "SCARCE" | "DORMANT";
  codes: number;
  primaryValue: number;
  primarySharePct: number;
  salesPerCode: number;
  retailersPerSkuMean: number;
  retailersPerSkuMedian: number;
  dormantBasis: string | null;
};

export type MarginCategory = {
  category: string;
  grossMarginPct: number | null;
  marginTier: "RICH" | "MID" | "THIN" | "BARE" | null;
  maximumSchemeDepthPct: number;
  maximumSchemeShareOfGrossMarginPct: number;
  skuCoveragePct: number;
  valueCoveragePct: number;
  heldCategories: string[];
};

export type AiSchemesFyReport = {
  fy: string;
  coverage: {
    fy: string;
    loadedMonths: string[];
    sourceMonths: {
      primary: string[];
      secondary: string[];
      margin: string[];
    };
    heldPeriods: string[];
    heldMetadata: Array<Record<string, unknown>>;
    sources: Record<string, string>;
    geography: { available: boolean; statement: string };
  };
  pairMatrix: {
    positivePairs: number;
    activeRetailers: number;
    skus: number;
    pairDensityPct: number;
    valueDistribution: PairDistribution;
    identityRule: string;
  };
  breadthArithmetic: {
    increments: Array<{
      additionalSkusPerRetailer: number;
      lowValue: number;
      medianValue: number;
      highValue: number;
    }>;
    label: string;
  };
  skuBands: SkuBand[];
  dormant: {
    catalogueCodes: number;
    neverSold: number;
    zeroPrimarySales: number;
    salesPeriod: string;
  };
  marginHeadroom: {
    categories: MarginCategory[];
    marginFactMonths: string[];
    suppressedUnknownMargin: boolean;
    secondarySkuCount: number;
    usableSecondarySkuCount: number;
    secondaryValue: number;
    usableSecondaryValue: number;
    valueRepresentedPct: number;
    heldCategories: string[];
  };
};

type CatalogueCode = { code: string; primaryValue: number };
type MarginCode = {
  item_code: string;
  segment: string;
  sale_value: string;
  bom_value: string;
  month_count: string;
};

function normalizeCategoryLabel(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\/\s*/g, "/");
}

/**
 * Canonicalizes the ERP item group where it carries the pipe/fittings split.
 * This deliberately uses exact normalized source labels, not name heuristics.
 * The margin segment (or secondary segment) remains the fallback when an
 * item-master code is absent.
 */
export function canonicalMarginCategory(
  itemGroup: string | null | undefined,
  marginSegment?: string | null,
  secondarySegment?: string | null,
): string {
  const group = normalizeCategoryLabel(itemGroup).toUpperCase();
  const splitGroups: Record<string, string> = {
    "CPVC PIPE FG": "CPVC Pipe",
    "CPVC FINISHED GOODS": "CPVC Fittings",
    "CPVC TRADING GOODS": "CPVC Fittings",
    "AGRI PIPE FG": "AGRI Pipe",
    "AGRI FG": "AGRI Fittings",
    "AGRI TRADING": "AGRI Fittings",
    "AGRI TRADING GOODS": "AGRI Fittings",
    "UPVC PIPE FG": "UPVC Pipe",
    "UPVC FINISHED GOODS": "UPVC Fittings",
    "UPVC TRADING GOODS": "UPVC Fittings",
    "SWR PIPE FG": "SWR Pipe",
    "SWR FG": "SWR Fittings",
    "SWR TRADING GOODS": "SWR Fittings",
  };
  if (splitGroups[group]) return splitGroups[group];
  if (group === "CISTERN FINISHED GOODS" || group === "CISTERN") return "Cistern";
  if (group === "PTMT FINISH GOODS" || group === "PTMT TRADING" || group === "PTMT TRADING GOODS" || group === "PTMT") return "PTMT";
  if (group.startsWith("SINK")) return "Sink";
  if (group === "CP" || group.startsWith("CP ")) return "CP";

  const source = normalizeCategoryLabel(marginSegment ?? secondarySegment);
  if (source) {
    const sourceKey = source.toUpperCase();
    const knownLabels: Record<string, string> = {
      "GARDEN PIPE": "Garden Pipe",
      "SANITARYWARE": "Sanitaryware",
      "HARDWARE": "Hardware",
      "PLUMBING": "Plumbing",
      "PTMT": "PTMT",
      "PTMT / FAUCETS": "PTMT",
      "SINK": "Sink",
      "CISTERN": "Cistern",
      "CP": "CP",
      "CP (CHROME-PLATED)": "CP",
      "CONNECTION / WASTE": "Plumbing",
    };
    return knownLabels[sourceKey] ?? source;
  }
  return normalizeCategoryLabel(itemGroup) || "Unmapped";
}

const n = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function coveragePercent(usable: number, total: number): number {
  return total > 0 ? round(usable / total * 100) : 0;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export function pairDistribution(values: number[]): PairDistribution {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const decileSize = Math.max(1, Math.ceil(sorted.length * 0.1));
  const average = (part: number[]) => part.length
    ? part.reduce((sum, value) => sum + value, 0) / part.length
    : 0;
  return {
    p10: round(percentile(sorted, 0.1)),
    p25: round(percentile(sorted, 0.25)),
    median: round(percentile(sorted, 0.5)),
    p75: round(percentile(sorted, 0.75)),
    p90: round(percentile(sorted, 0.9)),
    bottomDecileAverage: round(average(sorted.slice(0, decileSize))),
    topDecileAverage: round(average(sorted.slice(Math.max(0, sorted.length - decileSize)))),
  };
}

export function breadthArithmetic(
  activeRetailers: number,
  distribution: PairDistribution,
): AiSchemesFyReport["breadthArithmetic"] {
  const increments = [1, 2, 3].map((additionalSkusPerRetailer) => ({
    additionalSkusPerRetailer,
    lowValue: round(activeRetailers * additionalSkusPerRetailer * distribution.p10),
    medianValue: round(activeRetailers * additionalSkusPerRetailer * distribution.median),
    highValue: round(activeRetailers * additionalSkusPerRetailer * distribution.p90),
  }));
  return {
    increments,
    label: "Arithmetic at observed P10, median, and P90 secondary order-booking pair values; not a forecast.",
  };
}

function bandForStart(startShare: number): SkuBand["band"] {
  if (startShare < 0.5) return "VERY HIGH";
  if (startShare < 0.8) return "HIGH";
  if (startShare < 0.95) return "MEDIUM";
  if (startShare < 0.99) return "LOW";
  return "SCARCE";
}

export function makeSkuBands(
  soldCodes: CatalogueCode[],
  retailerCounts: ReadonlyMap<string, number>,
  dormantCodes: CatalogueCode[] = soldCodes.filter((row) => row.primaryValue <= 0),
): {
  bands: SkuBand[];
  dormant: { catalogueCodes: number; neverSold: number; zeroPrimarySales: number };
} {
  const sorted = soldCodes
    .filter((row) => row.primaryValue > 0)
    .sort((a, b) => b.primaryValue - a.primaryValue || a.code.localeCompare(b.code));
  const total = sorted.reduce((sum, row) => sum + row.primaryValue, 0);
  const dormantCount = dormantCodes.length;
  const grouped = new Map<SkuBand["band"], CatalogueCode[]>(
    ["VERY HIGH", "HIGH", "MEDIUM", "LOW", "SCARCE", "DORMANT"].map((band) => [band as SkuBand["band"], []]),
  );
  let cumulative = 0;
  for (const row of sorted) {
    const band = bandForStart(total > 0 ? cumulative / total : 1);
    grouped.get(band)!.push(row);
    cumulative += row.primaryValue;
  }
  grouped.set("DORMANT", dormantCodes);
  const bands = [...grouped.entries()].map(([band, rows]) => {
    const value = rows.reduce((sum, row) => sum + row.primaryValue, 0);
    const breadth = rows.map((row) => retailerCounts.get(row.code) ?? 0);
    return {
      band,
      codes: rows.length,
      primaryValue: round(value),
      primarySharePct: total > 0 ? round(value / total * 100) : 0,
      salesPerCode: rows.length > 0 ? round(value / rows.length) : 0,
      retailersPerSkuMean: breadth.length ? round(breadth.reduce((s, v) => s + v, 0) / breadth.length) : 0,
      retailersPerSkuMedian: round(percentile([...breadth].sort((a, b) => a - b), 0.5)),
      dormantBasis: band === "DORMANT"
        ? "Authoritative current catalogue codes with zero primary sales in the requested FY."
        : null,
    } satisfies SkuBand;
  });
  return {
    bands,
    dormant: { catalogueCodes: dormantCodes.length, neverSold: 0, zeroPrimarySales: dormantCount },
  };
}

function heldPeriods(
  holds: ResolutionHold[],
  fy: string,
  periods: string[],
  measure: string,
): { periods: string[]; metadata: Array<Record<string, unknown>> } {
  const exclusions = holds.flatMap((hold) => resolveHoldExclusionsFromRows(
    { measure, product: hold.scopeProduct, requestedPeriods: periods, strictFiscalYear: true },
    [hold],
  )).filter((exclusion) => !exclusion.fiscalYear || exclusion.fiscalYear === fy);
  // Keep a fiscal-year hold visible even when its source month has no rows
  // (notably H2/Aug-26). The absence is coverage metadata, not a fabricated
  // source row, and the calculation still only filters loaded months.
  const matchedIds = new Set(exclusions.map((exclusion) => String(exclusion.resolutionItemId)));
  const absentPeriodExclusions = holds.flatMap((hold) => resolveHoldExclusionsFromRows(
    { measure, product: hold.scopeProduct, requestedPeriods: [], strictFiscalYear: true },
    [hold],
  )).filter((exclusion) =>
    (!exclusion.fiscalYear || exclusion.fiscalYear === fy)
    && !matchedIds.has(String(exclusion.resolutionItemId)),
  );
  const allExclusions = [...exclusions, ...absentPeriodExclusions];
  const held = [...new Set(allExclusions.flatMap((exclusion) => exclusion.coverage.heldPeriods))];
  return {
    periods: held,
    metadata: allExclusions.map((exclusion) => ({
      resolutionItemId: exclusion.resolutionItemId,
      title: exclusion.title,
      reason: exclusion.reason,
      resolutionUrl: exclusion.resolutionUrl,
      heldPeriods: exclusion.coverage.heldPeriods,
      scope: exclusion.scope,
    })),
  };
}

function marginHoldFilter(
  holds: ResolutionHold[],
  months: string[],
): ReturnType<typeof sql> {
  const clauses = holds.flatMap((hold) => {
    const exclusion = resolveHoldExclusionsFromRows(
      { measure: "gross contribution", product: hold.scopeProduct, requestedPeriods: months, strictFiscalYear: true },
      [hold],
    )[0];
    if (!exclusion || exclusion.coverage.heldPeriods.length === 0) return [];
    const held = sql.join(exclusion.coverage.heldPeriods.map((month) => sql`${month}`), sql`, `);
    const product = hold.scopeProduct?.trim();
    const productKey = product?.split(/\s+/)[0];
    return [product
      ? sql`NOT (mf.month_label IN (${held}) AND LOWER(BTRIM(mf.segment)) LIKE ${`%${productKey?.toLowerCase() ?? ""}%`})`
      : sql`mf.month_label NOT IN (${held})`];
  });
  if (clauses.length === 0) return sql``;
  return sql`AND ${sql.join(clauses, sql` AND `)}`;
}

async function buildFyReport(fy: string, holds: ResolutionHold[]): Promise<AiSchemesFyReport> {
  const legacyMonthRows = await db.execute<{ month_label: string }>(sql`
    SELECT DISTINCT month_label
      FROM secondary_sku_line
     WHERE fy = ${fy}
       AND (fy < '2026-27' OR (fy = '2026-27' AND month_label IN ('Apr-26','May-26','Jun-26','Jul-26')))
  `);
  const productWiseMonthRows = fy >= "2026-27"
    ? await db.execute<{ month_label: string }>(sql`
        SELECT DISTINCT TO_CHAR(order_datetime AT TIME ZONE 'Asia/Kolkata', 'Mon-YY') AS month_label
          FROM secondary_order_line
         WHERE fiscal_year = ${fy} AND source_kind = 'product_wise'
           AND order_datetime >= TIMESTAMPTZ '2026-08-01'
      `)
    : { rows: [] as Array<{ month_label: string }> };
  const loadedMonths = [...new Set([
    ...legacyMonthRows.rows.map((row) => row.month_label),
    ...productWiseMonthRows.rows.map((row) => row.month_label),
  ])].sort();
  const loadedSources = new Set(loadedMonths.map((month) => secondarySourceForMonth(month)));
  if (loadedSources.size > 1) {
    throw new SecondarySourceSeamError(
      `AI Schemes monetary pair arithmetic is unavailable for ${fy}: selected secondary months cross the PSCode3/Product-Wise seam. Counts may be compared, but rupees are not summed or compared across Jul-26/Aug-26.`,
    );
  }
  const secondaryHeld = heldPeriods(holds, fy, loadedMonths, "secondary SKU");
  const availableSecondaryMonths = loadedMonths.filter((month) => !secondaryHeld.periods.includes(month));
  const monthArray = (months: string[]) => months.length
    ? sql`AND month_label = ANY(ARRAY[${sql.join(months.map((month) => sql`${month}`), sql`, `)}])`
    : sql`AND FALSE`;

  const pairRows = await db.execute<{ retailer: string; item_code: string; category: string | null; value: string }>(sql`
    WITH secondary_pairs AS (
      SELECT
        CASE WHEN NULLIF(BTRIM(retailer_id), '') IS NOT NULL
          THEN 'RET#:' || BTRIM(retailer_id)
          ELSE 'NAME:' || regexp_replace(LOWER(BTRIM(COALESCE(retailer, ''))), '[^a-z0-9]+', ' ', 'g')
        END AS retailer,
        BTRIM(item_code) AS item_code,
        COALESCE(NULLIF(BTRIM(segment_canon), ''), NULLIF(BTRIM(segment_raw), ''), 'Unmapped') AS category,
        net_amount::numeric AS value, month_label
      FROM secondary_sku_line
      WHERE fy = ${fy}
        AND NOT (fy = '2026-27' AND month_label NOT IN ('Apr-26','May-26','Jun-26','Jul-26'))
      UNION ALL
      SELECT
        'RET#:' || BTRIM(dealer_id), BTRIM(product_code),
        COALESCE(NULLIF(BTRIM(segment_canon), ''), NULLIF(BTRIM(category_name), ''), 'Unmapped'),
        basic_order_value::numeric,
        TO_CHAR(order_datetime AT TIME ZONE 'Asia/Kolkata', 'Mon-YY')
      FROM secondary_order_line
      WHERE fiscal_year = ${fy} AND source_kind = 'product_wise'
        AND order_datetime >= TIMESTAMPTZ '2026-08-01'
    )
    SELECT retailer, item_code, MAX(category) AS category, SUM(value)::text AS value
    FROM secondary_pairs
    WHERE month_label IN (${sql.join(availableSecondaryMonths.map((month) => sql`${month}`), sql`, `)})
      AND NULLIF(BTRIM(item_code), '') IS NOT NULL
    GROUP BY 1, 2
    HAVING SUM(value) > 0
  `);
  const pairs: PairValueRow[] = pairRows.rows.map((row) => ({
    retailer: row.retailer,
    itemCode: row.item_code,
    category: row.category ?? "Unmapped",
    value: n(row.value),
  }));
  const values = pairs.map((pair) => pair.value);
  const distribution = pairDistribution(values);
  const retailers = new Set(pairs.map((pair) => pair.retailer));
  const skus = new Set(pairs.map((pair) => pair.itemCode));
  const density = retailers.size && skus.size
    ? pairs.length / (retailers.size * skus.size) * 100
    : 0;
  const retailerCounts = new Map<string, number>();
  for (const pair of pairs) retailerCounts.set(pair.itemCode, (retailerCounts.get(pair.itemCode) ?? 0) + 1);

  const marginMonthsRows = await db.execute<{ month_label: string }>(sql`
    SELECT DISTINCT month_label FROM margin_fact WHERE fy = ${fy} ORDER BY month_label
  `);
  const marginMonths = marginMonthsRows.rows.map((row) => row.month_label);
  const marginHeld = heldPeriods(holds, fy, marginMonths, "gross contribution");
  const marginMonthFilter = marginHoldFilter(holds, marginMonths);

  const [primaryRows, primaryMonthRows, catalogueRows, neverSoldRows, marginRows] = await Promise.all([
    db.execute<{ code: string; primary_value: string }>(sql`
      SELECT BTRIM(code) AS code, COALESCE(SUM(amount), 0)::text AS primary_value
      FROM sale_line_current
      WHERE fy = ${fy} AND NULLIF(BTRIM(code), '') IS NOT NULL
      GROUP BY BTRIM(code)
    `),
    db.execute<{ month_label: string }>(sql`
      SELECT DISTINCT month_label FROM sale_line_current WHERE fy = ${fy} ORDER BY month_label
    `),
    db.execute<{ item_code: string }>(sql`
      SELECT DISTINCT UPPER(BTRIM(item_code)) AS item_code
      FROM mrp_current_catalogue
      WHERE NULLIF(BTRIM(item_code), '') IS NOT NULL
    `),
    db.execute<{ item_code: string }>(sql`
      SELECT c.item_code
      FROM (SELECT DISTINCT UPPER(BTRIM(item_code)) AS item_code FROM mrp_current_catalogue) c
      LEFT JOIN (
        SELECT DISTINCT UPPER(BTRIM(code)) AS code
        FROM sale_line_current
        WHERE NULLIF(BTRIM(code), '') IS NOT NULL
      ) sold ON sold.code = c.item_code
      WHERE sold.code IS NULL
    `),
    db.execute<{
      item_code: string;
      segment: string | null;
      sale_value: string;
      bom_value: string;
      month_count: string;
    }>(sql`
      -- This CTE is deliberately at FY + item_code grain before any category
      -- or primary-sales association. Never join margin_fact row-by-row.
      WITH margin_by_code AS (
         SELECT mf.fy, BTRIM(mf.item_code) AS item_code,
               MAX(NULLIF(BTRIM(mf.segment), '')) AS segment,
               SUM(mf.sale_value)::numeric AS sale_value,
               SUM(mf.bom_value)::numeric AS bom_value,
               COUNT(DISTINCT mf.month_label)::text AS month_count
        FROM margin_fact mf
        WHERE mf.fy = ${fy}
          AND mf.sale_value IS NOT NULL
          AND mf.bom_value IS NOT NULL
          AND mf.avg_sale IS NOT NULL
          AND mf.bom_cost IS NOT NULL
          ${marginMonthFilter}
         GROUP BY mf.fy, BTRIM(mf.item_code)
      )
      SELECT item_code, segment, sale_value::text, bom_value::text, month_count
      FROM margin_by_code
      WHERE sale_value > 0
    `),
  ]);
  const categoryCodes = [...new Set([
    ...pairs.map((pair) => pair.itemCode),
    ...marginRows.rows.map((row) => row.item_code),
  ])];
  const itemMasterCodeFilter = categoryCodes.length
    ? sql`AND BTRIM(code) = ANY(ARRAY[${sql.join(categoryCodes.map((code) => sql`${code}`), sql`, `)}])`
    : sql`AND FALSE`;
  const itemGroupRows = await db.execute<{ item_code: string; item_group: string | null }>(sql`
    SELECT BTRIM(code) AS item_code, MAX(NULLIF(BTRIM(item_group), '')) AS item_group
    FROM item_master
    WHERE NULLIF(BTRIM(code), '') IS NOT NULL
      ${itemMasterCodeFilter}
    GROUP BY BTRIM(code)
  `);
  const itemGroupByCode = new Map(itemGroupRows.rows.map((row) => [row.item_code, row.item_group]));
  const primaryByCode = new Map(primaryRows.rows.map((row) => [row.code, n(row.primary_value)]));
  const catalogueCodes = catalogueRows.rows.map((row) => row.item_code);
  const dormantCodes: CatalogueCode[] = catalogueCodes.filter((code) => (primaryByCode.get(code) ?? 0) <= 0).map((code) => ({
    code,
    primaryValue: 0,
  }));
  // E2 bands are based on every positive primary code, including codes that
  // are not currently in the authoritative catalogue. The catalogue is only
  // the denominator for the separate DORMANT population.
  const soldCodes: CatalogueCode[] = primaryRows.rows
    .map((row) => ({ code: row.code, primaryValue: n(row.primary_value) }))
    .filter((row) => row.primaryValue > 0);
  const bandResult = makeSkuBands(soldCodes, retailerCounts, dormantCodes);
  bandResult.dormant.neverSold = neverSoldRows.rows.length;
  const marginByCategory = new Map<string, { sale: number; bom: number; codes: Set<string>; value: number }>();
  const marginCategoryByCode = new Map<string, string>();
  for (const row of marginRows.rows as MarginCode[]) {
    const sale = n(row.sale_value);
    const bom = n(row.bom_value);
    const code = row.item_code;
    const category = canonicalMarginCategory(itemGroupByCode.get(code), row.segment);
    const entry = marginByCategory.get(category) ?? { sale: 0, bom: 0, codes: new Set<string>(), value: 0 };
    entry.sale += sale;
    entry.bom += bom;
    entry.codes.add(code);
    entry.value += primaryByCode.get(code) ?? 0;
    marginByCategory.set(category, entry);
    marginCategoryByCode.set(code, category);
  }
  const secondaryByCategory = new Map<string, { codes: Set<string>; value: number; usableCodes: Set<string>; usableValue: number }>();
  let secondaryValue = 0;
  let usableSecondaryValue = 0;
  const usableSecondaryCodes = new Set<string>();
  for (const pair of pairs) {
    const category = canonicalMarginCategory(
      itemGroupByCode.get(pair.itemCode),
      undefined,
      pair.category,
    );
    const entry = secondaryByCategory.get(category) ?? {
      codes: new Set<string>(),
      value: 0,
      usableCodes: new Set<string>(),
      usableValue: 0,
    };
    entry.codes.add(pair.itemCode);
    entry.value += pair.value;
    secondaryValue += pair.value;
    if (marginCategoryByCode.has(pair.itemCode)) {
      entry.usableCodes.add(pair.itemCode);
      entry.usableValue += pair.value;
      usableSecondaryValue += pair.value;
      usableSecondaryCodes.add(pair.itemCode);
    }
    secondaryByCategory.set(category, entry);
  }
  const marginCategories: MarginCategory[] = [...marginByCategory.entries()].map(([category, entry]) => {
    const grossMarginPct = entry.sale > 0 ? (entry.sale - entry.bom) / entry.sale * 100 : null;
    const marginTier: MarginCategory["marginTier"] = grossMarginPct == null ? null
      : grossMarginPct >= 55 ? "RICH"
        : grossMarginPct >= 40 ? "MID"
          : grossMarginPct >= 27 ? "THIN" : "BARE";
    const depth = marginTier === "RICH" ? 8 : marginTier === "MID" ? 6 : marginTier === "THIN" ? 4 : 0;
    const secondaryCoverage = secondaryByCategory.get(category);
    const matchingHoldScopes = marginHeld.metadata
      .flatMap((row) => ((row.scope as { products?: string[] } | undefined)?.products ?? []))
      .filter((scope) => category.toLowerCase().includes(scope.toLowerCase().split(" ")[0]!));
    return {
      category,
      grossMarginPct: grossMarginPct == null ? null : round(grossMarginPct),
      marginTier,
      maximumSchemeDepthPct: depth,
      maximumSchemeShareOfGrossMarginPct: grossMarginPct
        ? round(depth / grossMarginPct * 100)
        : 0,
      skuCoveragePct: secondaryCoverage && secondaryCoverage.codes.size > 0
        ? coveragePercent(secondaryCoverage.usableCodes.size, secondaryCoverage.codes.size)
        : 0,
      valueCoveragePct: secondaryCoverage && secondaryCoverage.value > 0
        ? coveragePercent(secondaryCoverage.usableValue, secondaryCoverage.value)
        : 0,
      heldCategories: matchingHoldScopes.length > 0 ? [category] : [],
    };
  }).sort((a, b) => a.category.localeCompare(b.category));

  return {
    fy,
    coverage: {
      fy,
      loadedMonths: [...new Set([...primaryMonthRows.rows.map((row) => row.month_label), ...loadedMonths, ...marginMonths])],
      sourceMonths: {
        primary: primaryMonthRows.rows.map((row) => row.month_label),
        secondary: loadedMonths,
        margin: marginMonths,
      },
      heldPeriods: [...new Set([...secondaryHeld.periods, ...marginHeld.periods])],
      heldMetadata: [...secondaryHeld.metadata, ...marginHeld.metadata],
      sources: {
        primaryRevenue: "sale_line_current.amount (current rows; dispatch)",
        secondaryBreadth: "PSCode3 secondary_sku_line.net_amount through Jul-26; Product-Wise secondary_order_line.basic_order_value ex-GST from Aug-26 onward (signed rows aggregated by pair; positive aggregate pairs only)",
        catalogue: "mrp_current_catalogue (authoritative current catalogue)",
        margin: "margin_fact.sale_value and margin_fact.bom_value (gross contribution; factory BOM only)",
      },
      geography: {
        available: false,
        statement: "Geography is not used by Sections B/C; no geography availability is asserted and no peer set is generated.",
      },
    },
    pairMatrix: {
      positivePairs: pairs.length,
      activeRetailers: retailers.size,
      skus: skus.size,
      pairDensityPct: round(density, 4),
      valueDistribution: distribution,
      identityRule: "Positive pair identity is RET# first; rows without RET# use normalized retailer name.",
    },
    breadthArithmetic: breadthArithmetic(retailers.size, distribution),
    skuBands: bandResult.bands,
    dormant: {
      catalogueCodes: catalogueCodes.length,
      neverSold: bandResult.dormant.neverSold,
      zeroPrimarySales: bandResult.dormant.zeroPrimarySales,
      salesPeriod: `Primary sale_line_current.amount for ${fy}; never-sold uses all loaded fiscal years.`,
    },
    marginHeadroom: {
      categories: marginCategories,
      marginFactMonths: marginMonths,
      suppressedUnknownMargin: true,
      secondarySkuCount: skus.size,
      usableSecondarySkuCount: usableSecondaryCodes.size,
      secondaryValue: round(secondaryValue),
      usableSecondaryValue: round(usableSecondaryValue),
      valueRepresentedPct: coveragePercent(usableSecondaryValue, secondaryValue),
      heldCategories: marginCategories
        .filter((category) => category.heldCategories.length > 0)
        .map((category) => category.category),
    },
  };
}

const cache = new Map<string, { at: number; value: AiSchemesFyReport }>();

export async function getAiSchemesAnalytics(fys: string[]): Promise<{
  fys: string[];
  reports: AiSchemesFyReport[];
  readOnly: true;
  source: string;
}> {
  const normalized = [...new Set(fys.map((fy) => fy.trim()).filter(Boolean))];
  const holds = await getOpenResolutionHolds();
  const holdSignature = aiSchemesHoldSignature(holds);
  const reports = await Promise.all(normalized.map(async (fy) => {
    const ttl = fy === currentOpenFy() ? OPEN_FY_TTL_MS : CLOSED_FY_TTL_MS;
    const cacheKey = `${fy}:${holdSignature}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const report = await buildFyReport(fy, holds);
    for (const key of cache.keys()) {
      if (key.startsWith(`${fy}:`) && key !== cacheKey) cache.delete(key);
    }
    cache.set(cacheKey, { at: Date.now(), value: report });
    return report;
  }));
  return {
    fys: normalized,
    reports,
    readOnly: true,
    source: "AI Schemes E2/E3 arithmetic from production database sources; no proposals or forecasts.",
  };
}

export function clearAiSchemesAnalyticsCache(): void {
  cache.clear();
}