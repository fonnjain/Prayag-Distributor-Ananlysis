/**
 * Prompt 115 Release 1 nodes.
 *
 * This module is intentionally a small read-only boundary around the existing
 * resolution register and margin_fact table.  In particular, held margin
 * values are never selected into the returned object (not even as null).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sanitizeMetadata, type GraphNode, type MeasureValue } from "./types.js";
import { resolveHoldExclusions } from "../../resolution/holdResolver.js";

const now = () => new Date().toISOString();

export type MarginPeriodSlice = { fiscalYear: string; monthLabels: string[] };
export function selectMarginPeriodSlices(period: string, fy: string): MarginPeriodSlice[] {
  const monthNames = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const endpoints = [...period.matchAll(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2})/gi)]
    .map((match) => ({ month: monthNames.indexOf(match[1]!.toLowerCase()), year: 2000 + Number(match[2]) }));
  const from = endpoints[0]?.month ?? monthNames.findIndex((m) => period.toLowerCase().includes(m));
  const startYear = endpoints[0]?.year ?? Number((period.match(/20\d{2}/) ?? [fy.slice(0, 4)])[0]);
  const endMonth = endpoints.at(-1)?.month ?? from;
  const endYear = endpoints.at(-1)?.year ?? startYear;
  const entries: Array<{ label: string; month: number; year: number }> = [];
  if (from >= 0) {
    let month = from;
    let calendarYear = startYear;
    while (calendarYear < endYear || (calendarYear === endYear && month <= endMonth)) {
      const name = monthNames[month]!;
      entries.push({ label: `${name[0]!.toUpperCase()}${name.slice(1)}-${String(calendarYear).slice(-2)}`, month, year: calendarYear });
      month++;
      if (month === 12) { month = 0; calendarYear++; }
      if (entries.length > 24) break;
    }
  }
  const slices = new Map<string, string[]>();
  for (const entry of entries) {
    const fiscalYear = entry.month >= 3
      ? `${entry.year}-${String((entry.year + 1) % 100).padStart(2, "0")}`
      : `${entry.year - 1}-${String(entry.year % 100).padStart(2, "0")}`;
    slices.set(fiscalYear, [...(slices.get(fiscalYear) ?? []), entry.label]);
  }
  return [...slices.entries()].map(([fiscalYear, monthLabels]) => ({ fiscalYear, monthLabels }));
}

function heldMeasure(
  measure: MeasureValue["measure"],
  label: string,
  hold: { code?: string; category: string; reason: string },
): MeasureValue {
  return ({
    measure, label,
    unit: measure === "gross_contribution" ? "INR" : "pct",
    availability: "held", hold,
  }) as MeasureValue;
}

function marginMeasure(
  measure: "gross_margin" | "gross_contribution",
  label: string,
  value: number,
  saleBasis: string,
): MeasureValue {
  return ({
    measure, label, value,
    unit: measure === "gross_contribution" ? "INR" : "pct",
    availability: "measured",
    ...(measure === "gross_margin" ? {
      basis: {
        numerator: "gross contribution (sale value less factory cost)",
        denominator: "sale value",
        population: "margin_fact",
        period: saleBasis,
        source: "margin_fact",
      },
    } : {}),
  }) as MeasureValue;
}
function unavailableMarginMeasure(
  measure: "gross_margin" | "gross_contribution",
  label: string,
): MeasureValue {
  return {
    measure, label, unit: measure === "gross_contribution" ? "INR" : "pct",
    availability: "unavailable",
    ...(measure === "gross_margin" ? {
      basis: {
        numerator: "gross contribution (sale value less factory cost)",
        denominator: "sale value", population: "margin_fact", period: "requested period", source: "margin_fact",
      },
    } : {}),
  } as MeasureValue;
}

function base(path: string, fy: string, name: string, source: string): GraphNode {
  return {
    path, level: "gap", fy, name, measures: [], population: "Resolution register",
    source, cutoff: "read at request time", readTime: now(), category: "Unmapped",
    flags: [], parent: null, children: [], childrenSumToParent: null, isGap: false,
  };
}

/** Open/pending/resolved items, with held value-at-stake omitted by construction. */
export async function resolveResolutionRegister(fy: string): Promise<GraphNode> {
  const result = await db.execute(sql`
    SELECT id, code, type, title, category, fiscal_year, month, scope_product,
           scope_measure, reason, owner, priority, status, raised_on,
           (CURRENT_DATE - raised_on)::int AS days_open,
           resolved_on, resolved_by, resolution_note, blocks_api,
           CASE WHEN type = 'HOLD' AND blocks_api THEN NULL ELSE value_at_stake END AS value_at_stake
    FROM resolution_item
    WHERE (fiscal_year = ${fy} OR fiscal_year IS NULL OR status <> 'open')
    ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, raised_on ASC
    LIMIT 500
  `);
  const items = (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id, code: row.code, type: row.type, title: row.title,
    category: row.category, scope: {
      fiscalYear: row.fiscal_year, month: row.month, product: row.scope_product,
      measure: row.scope_measure,
    },
    reason: row.reason, owner: row.owner, priority: row.priority ?? null,
    daysOpen: Number(row.days_open ?? 0),
    blocksMeasures: row.blocks_api === true
      ? String(row.scope_measure ?? "").split(/[;,|]/).map((x) => x.trim()).filter(Boolean)
      : [],
    status: row.status, raisedOn: row.raised_on, resolvedOn: row.resolved_on ?? null,
    resolvedBy: row.resolved_by ?? null, resolutionNote: row.resolution_note ?? null,
    blocksApi: row.blocks_api === true,
    ...(row.value_at_stake == null ? {} : { valueAtStake: Number(row.value_at_stake) }),
  }));
  const node = base(`resolution/${fy}`, fy, "Resolution register", "resolution_item");
  node.detail = sanitizeMetadata({ items });
  node.flags = ["HELD_VALUE_AT_STAKE_OMITTED"];
  return node;
}

/** Margin facts with H1 applied before construction of any measure. */
export async function resolveMargin(
  fy: string,
  product = "PTMT",
  period = "January-April 2026",
): Promise<GraphNode> {
  const periodSlices = selectMarginPeriodSlices(period, fy);
  const periodLabels = periodSlices.flatMap((slice) => slice.monthLabels);
  const periodWhere = periodLabels.length
    ? sql.join(periodSlices.map(({ fiscalYear: sliceFy, monthLabels: labels }) => sql`(fy = ${sliceFy} AND month_label = ANY(ARRAY[${sql.join(labels.map((m) => sql`${m}`), sql`, `)}]))`), sql` OR `)
    : sql`fy = ${fy}`;
  const exclusions = await resolveHoldExclusions({
    // Resolution H1 uses the registered scope term "margin". The graph's
    // outward measure remains the stricter typed "gross_margin".
    measure: "margin",
    product,
    requestedPeriods: [period],
    strictFiscalYear: true,
  });
  const registryResult = await db.execute(sql`
    SELECT canonical_category
      FROM canonical_item_category_registry
     WHERE UPPER(BTRIM(canonical_category)) = UPPER(${product})
       AND review_status IN ('seeded', 'confirmed')
     ORDER BY effective_from DESC NULLS LAST, id DESC
     LIMIT 1
  `);
  const registryCategory = String(
    ((registryResult.rows[0] as Record<string, unknown> | undefined)?.canonical_category ?? "Unmapped"),
  );
  const h1 = exclusions.find((x) => x.scopeProduct?.toLowerCase().includes(product.toLowerCase()));
  const node: GraphNode = {
    path: `margin/${product}/${/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2}/i.test(period) ? period : fy}`,
    level: "segment",
    fy,
    name: `${product} gross margin`,
    measures: [],
    population: "margin_fact; bom_cost is factory cost only (no freight, overhead, or SG&A)",
    source: "margin_fact joined to resolution_item through holdResolver",
    cutoff: fy === "2025-26" ? "FY complete" : "FY2026-27 through June only",
    readTime: now(),
    category: registryCategory,
    flags: ["GROSS_MARGIN_NOT_PROFIT", "BOM_COST_FACTORY_COST_ONLY"],
    parent: `company/${fy}`, children: [], childrenSumToParent: null, isGap: false,
  };
  if (h1) {
    // Keep the register's full numeric evidence in resolution_item, but do not
    // expose those blocked inputs through the model-facing hold reason.
    const hold = {
      code: "H1",
      category: "data quality",
      reason:
        "Factory cost is materially understated for this period, which would overstate gross margin. " +
        "The underlying margin is withheld pending correction.",
    };
    node.measures = [
      heldMeasure("gross_margin", `${product} gross margin — ${period}`, hold),
      heldMeasure("gross_contribution", `${product} gross contribution — ${period}`, hold),
    ];
    node.detail = sanitizeMetadata({
      availability: "held", hold: { code: "H1", category: hold.category, reason: hold.reason },
      coverage: "FY2025-26 complete; FY2026-27 through June only",
    });
    node.flags.push("H1_MARGIN_HOLD");
    return node;
  }
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(sale_value), 0) AS sale_value,
           COALESCE(SUM(bom_value), 0) AS bom_value,
           COUNT(*)::int AS row_count
    FROM margin_fact
    WHERE segment = ${product} AND (${periodWhere})
  `);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  const sale = Number(row.sale_value ?? 0);
  const bom = Number(row.bom_value ?? 0);
  const rowCount = Number(row.row_count ?? 0);
  const contribution = sale - bom;
  const ratio = sale ? contribution / sale : 0;
  node.measures = rowCount === 0
    ? [
        unavailableMarginMeasure("gross_margin", `${product} gross margin — ${period}`),
        unavailableMarginMeasure("gross_contribution", `${product} gross contribution — ${period}`),
      ]
    : [
        marginMeasure("gross_margin", `${product} gross margin`, ratio * 100, fy),
        marginMeasure("gross_contribution", `${product} gross contribution`, contribution, fy),
      ];
  node.detail = sanitizeMetadata({
    coverage: fy === "2025-26" ? "complete" : "through June only",
    rowCount, saleValue: sale, bomValue: bom,
    requestedPeriod: period, monthLabels: periodLabels,
  });
  const breakdown = await db.execute(sql`
    SELECT segment, item_code, COALESCE(SUM(sale_value),0) AS sale_value,
           COALESCE(SUM(bom_value),0) AS bom_value, COUNT(*)::int AS row_count
      FROM margin_fact
     WHERE segment = ${product} AND (${periodWhere})
     GROUP BY segment, item_code
     ORDER BY sale_value DESC
     LIMIT 1000
  `);
  node.detail = sanitizeMetadata({
    ...(node.detail as Record<string, unknown>),
    granularity: (breakdown.rows as Array<Record<string, unknown>>).map((r) => ({
      category: r.segment, subcategory: r.segment, sku: r.item_code,
      saleValue: Number(r.sale_value), bomValue: Number(r.bom_value), rowCount: Number(r.row_count),
    })),
  });
  return node;
}
