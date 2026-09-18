/**
 * Prompt 115 D3/D4 commercial graph adapters.
 *
 * These adapters are deliberately thin boundaries around the computations used
 * by the report routes. They publish the already-prepared payload; they do not
 * re-aggregate sale lines or calculate a second version of any KPI.
 */
import { buildCompanyReports } from "../../companyReports.js";
import { buildMomentumInsights } from "../../momentum/momentumInsights.js";
import { buildOverviewPerformance } from "../../overviewPerformance.js";
import { ensureSeeded } from "../../dashboard/sync.js";
import { buildPayload as buildCoveragePayload } from "../../../routes/coverageReports.js";
import { runComparison } from "../../comparison/comparison.js";
import { computeEngineTargets } from "../targetEngine.js";
import { sanitizeMetadata, type GraphNode, type MeasureValue, type ProjectionMetadata } from "./types.js";

const readTime = () => new Date().toISOString();

export type CommercialSurface =
  | "company-report"
  | "momentum"
  | "growth"
  | "targets"
  | "coverage"
  | "comparison";

export type CommercialPath = {
  surface: CommercialSurface;
  fy: string;
  report?: number;
};

/** Strict path contract shared by the resolver integration and tests. */
export function parseCommercialPath(path: string): CommercialPath | null {
  const parts = path.split("/").filter(Boolean);
  const surface = parts[0] as CommercialSurface | undefined;
  const fy = parts.at(-1);
  if (!surface || !fy || !/^\d{4}-\d{2}$/.test(fy)) return null;
  if (surface === "company-report") {
    const report = Number(parts[1]);
    return parts.length === 3 && Number.isInteger(report) && report >= 1 && report <= 7
      ? { surface, fy, report }
      : null;
  }
  return parts.length === 2 &&
    ["momentum", "growth", "targets", "coverage", "comparison"].includes(surface)
    ? { surface, fy }
    : null;
}

/** Exact report-to-prepared-payload mapping; reports 1 and 2 are not aliases. */
export const COMPANY_REPORT_PAYLOAD_KEYS = [
  "r1r2_byState",
  "r2_byStateMonth",
  "r3_byGroup",
  "r4_byGroupQty",
  "r5_byCustomer",
  "r6_byGroupFull",
  "r7_asOf",
] as const;

/** Every prepared drill variant belonging to each report surface. */
export const COMPANY_REPORT_VARIANTS: Record<number, readonly string[]> = {
  1: ["r1r2_byState", "r1_partyByCustomer"],
  2: ["r2_byStateMonth", "r2_byPartyMonth"],
  3: ["r3_byGroup", "r3_bySubcategory", "r3a_byStateGroup", "r3b_byPartyGroup", "r3c_byGroupFull"],
  4: ["r4_byGroupQty"],
  5: ["r5_byCustomer"],
  6: ["r6_byGroupFull", "r6_bySubcategoryFull"],
  7: ["r7_asOf"],
};

function measure(
  kind: MeasureValue["measure"],
  label: string,
  value: number | undefined,
  unit: MeasureValue["unit"],
  basis?: NonNullable<MeasureValue["basis"]>,
  projection?: ProjectionMetadata,
): MeasureValue {
  if (kind === "projection" && !projection) throw new Error("Projection requires approved seasonal metadata");
  if (value == null) {
    return unit === "pct"
      ? { measure: kind, label, unit, availability: "unavailable", basis: basis ?? pctBasis("unspecified", "unspecified") } as MeasureValue
      : { measure: kind, label, unit, availability: "unavailable" } as MeasureValue;
  }
  if (unit === "pct") {
    const percentageBasis = basis ?? pctBasis("unspecified", "unspecified");
    return ({
      measure: kind, label, value, unit, availability: "measured",
      basis: percentageBasis,
    }) as MeasureValue;
  }
  return {
    measure: kind,
    label,
    value,
    unit,
    availability: "measured",
    ...(basis ? { basis } : {}),
    ...(projection ? { projection } : {}),
    } as MeasureValue;
}

function node(
  path: string,
  fy: string,
  name: string,
  source: string,
  detail: Record<string, unknown>,
  measures: MeasureValue[],
  population: string,
  cutoff = "complete months in prepared service payload",
): GraphNode {
  return {
    path,
    level: "time",
    fy,
    name,
    measures,
    population,
    source,
    cutoff,
    readTime: readTime(),
    category: "Unmapped",
    flags: ["PREPARED_SERVICE_PAYLOAD", "CATEGORY_UNMAPPED_UNLESS_ASSIGNED"],
    parent: `company/${fy}`,
    children: [],
    childrenSumToParent: null,
    isGap: false,
    detail: sanitizeMetadata(detail),
  };
}

const pctBasis = (period: string, source: string): NonNullable<MeasureValue["basis"]> => ({
  numerator: "prepared current-period amount less prepared comparison amount",
  denominator: "prepared comparison-period amount",
  population: "service-defined like-month population",
  period,
  source,
});

function reportDrillMeasures(report: number, rows: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(rows) ? rows.slice(0, 80) : [];
  return list.map((raw, index) => {
    const row = raw as Record<string, unknown>;
    const label = String(row.label ?? row.group ?? row.customer ?? row.state ?? `row-${index + 1}`);
    const current = Number(row.thisFy ?? row.thisFyLike ?? row.amountThisFy ?? row.qtyThisFy);
    const prior = Number(row.lastFy ?? row.lastFyLike ?? row.amountLastFy ?? row.qtyLastFy);
    const unit = row.qtyThisFy != null ? "count" : "INR";
    const measures: MeasureValue[] = [
      measure(report === 4 ? "quantity" : "primary_sale", `${label} current`, current, unit),
      measure(report === 4 ? "quantity" : "primary_sale", `${label} comparison period`, prior, unit),
      measure("comparison_pct", `${label} comparison`, row.growthPct == null && row.growthLike == null
        ? undefined : Number(row.growthPct ?? row.growthLike), "pct",
        pctBasis("prepared report comparison", "buildCompanyReports")),
    ];
    return { label, measures };
  });
}

function reportVariantRows(
  report: number,
  payload: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const variants = COMPANY_REPORT_VARIANTS[report] ?? [];
  return variants.flatMap((variant) => {
    const value = payload[variant];
    if (variant === "r2_byPartyMonth" && Array.isArray(value)) {
      return value.flatMap((party) => {
        const row = party as Record<string, unknown>;
        return (Array.isArray(row.months) ? row.months : []).map((month) => ({
          ...reportDrillMeasures(2, [{
            label: `${String(row.customer ?? "customer")} ${String((month as Record<string, unknown>).month ?? "")}`,
            thisFy: (month as Record<string, unknown>).thisFy,
            lastFy: (month as Record<string, unknown>).lastFy,
          }])[0],
          variant,
        }));
      });
    }
    if (variant === "r7_asOf" && value && typeof value === "object") {
      const snapshot = value as Record<string, unknown>;
      return [
        ...reportDrillMeasures(report, snapshot.byGroup).map((row) => ({ ...row, variant })),
        ...reportDrillMeasures(report, snapshot.byState).map((row) => ({ ...row, variant })),
        {
          variant,
          label: "as-of total",
          measures: [
            measure("primary_sale", "As-of total", Number(snapshot.total), "INR"),
            measure("quantity", "Invoice count", Number(snapshot.invoiceCount), "count"),
            measure("quantity", "Customer count", Number(snapshot.customerCount), "count"),
          ],
        },
      ];
    }
    return reportDrillMeasures(report, value).map((row) => ({ ...row, variant }));
  });
}

export async function resolveCommercialSurface(
  request: CommercialPath,
): Promise<GraphNode> {
  const { surface, fy } = request;
  const source = surface === "momentum"
    ? "buildMomentumInsights"
    : surface === "targets"
      ? "computeEngineTargets"
      : "buildCompanyReports";

  if (surface === "company-report") {
    const report = request.report!;
    const payload = await buildCompanyReports(fy);
    const reportKey = COMPANY_REPORT_PAYLOAD_KEYS[report - 1]!;
    const payloadRecord = payload as unknown as Record<string, unknown>;
    const drill = reportVariantRows(report, payloadRecord);
    return node(
      `company-report/${report}/${fy}`, fy, `Company Report ${report}`, source,
        {
          report,
          payloadKey: reportKey,
          variants: COMPANY_REPORT_VARIANTS[report],
          likeMonths: payload.likeMonths,
          priorLikeMonths: payload.likeMonthsPrior,
          drill,
        },
      [],
      "Primary sale_line; report-specific prepared drill population is exposed as bounded typed measures",
      payload.asOfDate,
    );
  }

  if (surface === "momentum") {
    const payload = await buildMomentumInsights(fy, null);
    return node(
      `momentum/${fy}`, fy, "Momentum", source,
      {
        generatedAt: payload.meta.generatedAt,
        likeMonths: payload.meta.likeMonths,
        monthly: payload.acceleration.months.map((month) => ({
          label: month.month,
          measures: [measure("growth_pct", "Like-month growth", month.yoyPct ?? undefined, "pct",
            pctBasis(month.month, "buildMomentumInsights"))],
        })),
      },
      [
        measure("primary_sale", "Primary Sale / Dispatch", payload.headline.nominal.current * 1e7, "INR"),
        measure(
          "growth_pct", "Like-month growth",
          payload.headline.nominal.growthPct ?? undefined, "pct",
          pctBasis(fy, "buildMomentumInsights"),
        ),
        measure("projection", "Seasonal year-end projection",
          payload.runRate.projection == null ? undefined : payload.runRate.projection * 1e7,
          "INR", undefined, {
            calibrationBasis: payload.runRate.curveName,
            observedMonths: payload.meta.likeMonths,
            seasonalService: "buildMomentumInsights",
          }),
        { measure: "projection", label: "Flat pacing comparator (not a recommendation)",
          unit: "INR", availability: "not_applicable" } as MeasureValue,
      ],
      "Territory sale_line like-month population; Product-Wise secondary indicators remain source-labelled",
      payload.meta.latestMonthNote ?? payload.meta.generatedAt,
    );
  }

  if (surface === "targets") {
    const payload = await computeEngineTargets({ fy });
    return node(
      `targets/${fy}`, fy, "Targets", source,
      { baselineFy: payload.baselineFy, parameterSource: payload.params.source, attributionBasis: payload.memberAttribution.basis },
      [
        measure("target", "Grand target", payload.combined.grandTarget, "INR"),
        measure("primary_sale", "Baseline actual", payload.combined.base, "INR"),
      ],
      `Target engine baseline ${payload.baselineFy}; proposal parameters and attribution basis are retained in detail`,
    );
  }

  if (surface === "growth") {
    const payload = await buildOverviewPerformance(fy);
    return node(
      `growth/${fy}`, fy, "Growth", "buildOverviewPerformance",
      { fy: payload.fy, priorFy: payload.priorFy, months: payload.months },
      [
        measure("primary_sale", "Comparable primary sales", payload.closedComparableYtd.currentSalesInr ?? undefined, "INR"),
        measure(
          "primary_sale", "Comparable like-month growth",
          payload.closedComparableYtd.growthPct ?? undefined, "pct",
          {
            numerator: "closedComparableYtd.growthNumeratorInr",
            denominator: "closedComparableYtd.growthDenominatorInr",
            population: "closed comparable primary sale months",
            period: payload.closedComparableYtd.throughDate ?? "closed comparable period",
            source: "buildOverviewPerformance",
          },
        ),
      ],
      "Primary sale_line comparable closed months; numerator and denominator are supplied by the overview service",
      payload.closedComparableYtd.throughDate ?? "closed comparable period",
    );
  }

  if (surface === "coverage") {
    const snapshot = await ensureSeeded();
    const payload = buildCoveragePayload(
      snapshot.data as never,
      snapshot.syncedAt.toISOString(),
    );
    return node(
      `coverage/${fy}`, fy, "Coverage", "coverageReports.buildPayload",
      { syncedAt: payload.syncedAt, headsFullTerritory: payload.headsFullTerritory },
      [
        measure("primary_sale", "Covered retailers", payload.coverageTotals.retailers, "count"),
      ],
      "Roster reach stock from the latest dashboard snapshot; it has no month or distributor dimension",
      payload.syncedAt,
    );
  }

  if (surface === "comparison") {
    const payload = await runComparison({
      entityType: "company",
      entities: ["company"],
      periods: [{ kind: "ytd", fy }],
      measures: [{ measure: "sales", source: "sale_line" }],
      basis: "primary",
    });
    return node(
      `comparison/${fy}`, fy, "Comparison", "runComparison",
      { basis: payload.basis },
      [],
      "Comparison service population and basis are retained in the prepared response",
      fy,
    );
  }

  const reports = await buildCompanyReports(fy);
  const detail: Record<string, unknown> = {
    likeMonths: reports.likeMonths,
    priorLikeMonths: reports.likeMonthsPrior,
    monthlyPrimary: reports.monthlyPrimary,
    r1r2_byState: reports.r1r2_byState,
  };
  return node(`comparison/${fy}`, fy, "Comparison", "buildCompanyReports", detail, [],
    "Comparison service adapter unavailable for this report-only path");
}
