/**
 * Prompt 115 D1/D2/C4 bounded adapters.
 *
 * These are deliberately kept separate from the path dispatcher.  The
 * dispatcher can expose them as named paths without giving the model SQL
 * access.  All values come from the already-loaded secondary order/SKU
 * registers; source seams are retained in detail rather than inferred.
 */
import { pool } from "@workspace/db";
import { sanitizeMetadata, type GraphNode, type MeasureValue } from "./types.js";

const FY_RE = /^\d{4}-\d{2}$/;
const fyYear = (fy: string) => Number(fy.slice(0, 4));
const fy = (year: number) => `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
const now = () => new Date().toISOString();
export const SOURCE_SEAM = Object.freeze({
  preAugust: "PSCode3 / secondary_sku_line.net_amount",
  augustOnward: "Product-Wise / secondary_order_line.basic_order_value ex-GST",
  rule: "Never substitute or sum source segments without an exact control.",
});
export const PRODUCTWISE_PENDING_PREDICATE =
  "source_kind='product_wise' AND order_datetime >= TIMESTAMPTZ '2026-08-01'";

/** Pure policy helper used by tests and by callers rendering month segments. */
export function sourceSegmentPolicy(source: "pscode3" | "productwise", month: string) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    const year = Number(month.slice(0, 4));
    const monthNumber = Number(month.slice(5, 7));
    const isAugustOnward = year > 2026 || (year === 2026 && monthNumber >= 8);
    return source === "productwise" ? isAugustOnward : !isAugustOnward;
  }
  const monthName = month.slice(0, 3);
  const year = Number(month.slice(-2));
  const isAugustOnward = year > 26 || (year === 26 && !["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"].includes(monthName));
  return source === "productwise" ? isAugustOnward : !isAugustOnward;
}

function money(value: number | null, label: string, availability: MeasureValue["availability"] = "measured"): MeasureValue {
  if (availability === "measured" && value != null) {
    return { measure: "secondary_ob", label, value, unit: "INR", availability: "measured" };
  }
  if (availability === "partial") return { measure: "secondary_ob", label, unit: "INR", availability: "partial" };
  if (availability === "not_applicable") return { measure: "secondary_ob", label, unit: "INR", availability };
  return { measure: "secondary_ob", label, unit: "INR", availability: "unavailable" };
}

type Basis = { numerator: string; denominator: string; population: string; period: string; source: string };
function pct(value: number | null, label: string, basis: Basis, availability: MeasureValue["availability"] = "measured"): MeasureValue {
  if (availability === "unavailable" || availability === "not_applicable") {
    return { measure: "penetration", label, unit: "pct", availability, basis };
  }
  if (availability === "measured") {
    return value == null
      ? { measure: "penetration", label, unit: "pct", availability: "partial", basis }
      : { measure: "penetration", label, unit: "pct", availability: "measured", value, basis };
  }
  if (availability === "partial") return { measure: "penetration", label, unit: "pct", availability: "partial", basis };
  return { measure: "penetration", label, unit: "pct", availability: "unavailable", basis };
}

export type SecondaryCoverageMetadata = {
  source: "productwise_xlsx" | "pscode3_xlsx";
  value_basis: "basic_order_value_ex_gst" | "net_amount";
  months: string[];
  cutoff: string | null;
  completeness: "complete" | "partial" | "unavailable";
};

export function coverageAvailability(
  rows: number,
  completeness: SecondaryCoverageMetadata["completeness"],
): "measured" | "partial" | "unavailable" {
  if (rows <= 0 || completeness === "unavailable") return "unavailable";
  return completeness === "complete" ? "measured" : "partial";
}

function baseNode(
  path: string,
  fyValue: string,
  name: string,
  source: string,
  detail: unknown,
  measures: MeasureValue[],
  availability: GraphNode["availability"] = "measured",
  coverage?: SecondaryCoverageMetadata,
): GraphNode {
  return {
    path, level: "time", fy: fyValue, name, measures,
    population: "Bounded secondary register rows with explicit source and period coverage.",
    source, cutoff: coverage?.cutoff ?? "not recorded", readTime: now(), availability,
    category: "Unmapped", flags: ["SOURCE_LABELLED", "NO_UNSAFE_ARITHMETIC"],
    parent: null, children: [], childrenSumToParent: null, detail: sanitizeMetadata(detail), isGap: false,
  };
}

/**
 * Full three-FY order-booking summary. Product-Wise is used for its loaded
 * August+ fiscal years; the legacy register is used only for pre-August
 * history. The two bases are never silently merged.
 */
export async function resolveSecondaryBooking(fyValue: string): Promise<GraphNode> {
  if (!FY_RE.test(fyValue)) throw new Error("Invalid fiscal year");
  const end = fyYear(fyValue);
  const years = [fy(end - 2), fy(end - 1), fy(end)];
  // The queries are intentionally independent.  A Product-Wise row never
  // supplies a missing PSCode3 month (and vice versa).
  const [crm, legacy] = await Promise.all([
    pool.query<{ fiscal_year: string; lines: string; qty: string; value: string; retailers: string; source: string }>(
      `SELECT fiscal_year, COUNT(*)::text lines, COALESCE(SUM(qty),0)::text qty,
              COALESCE(SUM(basic_order_value),0)::text value,
              COUNT(DISTINCT dealer_id)::text retailers,
              'Product-Wise CRM' source
         FROM secondary_order_line
        WHERE fiscal_year = ANY($1::text[]) AND source_kind = 'product_wise'
          AND order_datetime >= TIMESTAMPTZ '2026-08-01'
        GROUP BY fiscal_year ORDER BY fiscal_year`, [years]),
    pool.query<{ fy: string; lines: string; qty: string; value: string; retailers: string }>(
      `SELECT fy, COUNT(*)::text lines, COALESCE(SUM(qty),0)::text qty,
              COALESCE(SUM(net_amount),0)::text value,
              COUNT(DISTINCT COALESCE(NULLIF(BTRIM(dealer_id),''), NULLIF(BTRIM(retailer_id),'')))::text retailers
         FROM secondary_sku_line
        WHERE fy = ANY($1::text[])
          AND (fy <> '2026-27' OR month_label IN ('Apr-26','May-26','Jun-26','Jul-26'))
        GROUP BY fy ORDER BY fy`, [years]),
  ]);
  const crmBy = new Map(crm.rows.map((r) => [r.fiscal_year, r]));
  const legacyBy = new Map(legacy.rows.map((r) => [r.fy, r]));
  const series = years.map((period) => {
    const c = crmBy.get(period);
    const l = legacyBy.get(period);
    // Do not choose one table as a fallback for the other.  A fiscal year may
    // have both source segments (FY26-27), which must remain separate.
    return {
      fiscalYear: period,
      segments: [
        ...(l ? [{ source: "PSCode3 / secondary_sku_line", valueBasis: "net_amount", lines: Number(l.lines), qty: Number(l.qty), value: Number(l.value), retailers: Number(l.retailers), availability: "measured" as const }] : []),
        ...(c ? [{ source: "Product-Wise CRM / secondary_order_line", valueBasis: "basic_order_value ex-GST", lines: Number(c.lines), qty: Number(c.qty), value: Number(c.value), retailers: Number(c.retailers), availability: "measured" as const }] : []),
      ],
    };
  });
  const selected = series.find((r) => r.fiscalYear === fyValue);
  const selectedSegments = selected?.segments ?? [];
  const source = series.flatMap((r) => r.segments.map((s) => `${r.fiscalYear}: ${s.source} (${s.valueBasis})`)).join("; ");
  return baseNode(`secondary-booking/${fyValue}`, fyValue, "Secondary order booking — three fiscal years", source, {
    series,
    seam: "Pre-August is PSCode3 net_amount; August+ is Product-Wise basic_order_value ex-GST. Segments are never summed or substituted.",
    identity: "Product-Wise dealer_id / cp_code identity; legacy retailer/dealer identity where present.",
  }, [money(selectedSegments.length === 1 ? selectedSegments[0].value : null, "Secondary order booking", selectedSegments.length === 1 ? "measured" : "partial")], selectedSegments.length ? "partial" : "unavailable");
}

/**
 * Bounded Product-Wise August answer for retailer ranking questions.  This is
 * intentionally not folded into the annual summary: July PSCode3 and August
 * Product-Wise are a permanent source seam and must never be added together.
 */
export async function resolveAugustTopRetailers(fyValue: string): Promise<GraphNode> {
  if (fyValue !== "2026-27") throw new Error("August Product-Wise retailer node is only loaded for FY2026-27");
  const result = await pool.query<{
    retailer_key: string;
    customer_name: string | null;
    order_value: string;
    sku_breadth: string;
    lines: string;
  }>(
    `SELECT dealer_id AS retailer_key,
            MAX(NULLIF(BTRIM(customer_name), '')) AS customer_name,
            COALESCE(SUM(basic_order_value), 0)::text AS order_value,
            COUNT(DISTINCT NULLIF(BTRIM(product_code), ''))::text AS sku_breadth,
            COUNT(*)::text AS lines
       FROM secondary_order_line
      WHERE fiscal_year = $1
        AND source_kind = 'product_wise'
        AND order_datetime >= TIMESTAMPTZ '2026-08-01'
        AND order_datetime < TIMESTAMPTZ '2026-09-01'
      GROUP BY dealer_id
      ORDER BY SUM(basic_order_value) DESC NULLS LAST, dealer_id
      LIMIT 10`,
    [fyValue],
  );
  const source = "productwise_xlsx / secondary_order_line";
  const valueBasis = "basic_order_value_ex_gst";
  const retailers = result.rows.map((row, index) => ({
    rank: index + 1,
    retailerKey: row.retailer_key,
    customer_name: row.customer_name,
    identity: "dealer_id is the durable retailer key; customer_name is a display label only",
    lines: Number(row.lines),
    measures: [
      {
        measure: "secondary_ob" as const,
        label: "August Basic Order Value ex-GST",
        value: Number(row.order_value),
        unit: "INR" as const,
        availability: "measured" as const,
        source,
        value_basis: valueBasis,
      },
      {
        measure: "quantity" as const,
        label: "August SKU breadth (distinct product_code)",
        value: Number(row.sku_breadth),
        unit: "count" as const,
        availability: "measured" as const,
        source,
        value_basis: "distinct product_code",
      },
    ],
  }));
  const coverage: SecondaryCoverageMetadata = {
    source: "productwise_xlsx",
    value_basis: "basic_order_value_ex_gst",
    months: ["Aug-26"],
    cutoff: null,
    completeness: result.rows.length ? "complete" : "unavailable",
  };
  return baseNode(
    `secondary-booking/${fyValue}/august-top-retailers`,
    fyValue,
    "Top 10 retailers by August order value and SKU breadth",
    source,
    {
      source,
      value_basis: valueBasis,
      period: "Aug-26",
      identity: "dealer_id is the durable retailer key; customer_name is a label and is not used as identity",
      seam: "July remains PSCode3; this node is August Product-Wise only and is never summed with July.",
      retailers,
    },
    [],
    result.rows.length ? "measured" : "unavailable",
    coverage,
  );
}

/** Reconciled pending-order attribution; unknown member is never assigned. */
export async function resolvePendingOrders(fyValue: string): Promise<GraphNode> {
  if (!FY_RE.test(fyValue)) throw new Error("Invalid fiscal year");
  const coverageResult = await pool.query<{
    rows: string; cutoff: string | null; completeness: string | null; months: string[] | null;
  }>(
    `SELECT COUNT(*)::text rows,
            MAX(loaded_at)::text cutoff,
            CASE WHEN COUNT(*) = 0 THEN 'unavailable'
                 WHEN BOOL_AND(COALESCE(period_completeness, 'partial') = 'complete') THEN 'complete'
                 ELSE 'partial' END completeness,
            ARRAY_AGG(DISTINCT to_char(order_datetime AT TIME ZONE 'Asia/Kolkata', 'Mon-YY')) months
       FROM secondary_order_line
      WHERE fiscal_year=$1 AND source_kind='product_wise'
        AND order_datetime >= TIMESTAMPTZ '2026-08-01'`,
    [fyValue],
  );
  const coverageRow = coverageResult.rows[0];
  const coverage: SecondaryCoverageMetadata = {
    source: "productwise_xlsx",
    value_basis: "basic_order_value_ex_gst",
    months: coverageRow?.months ?? [],
    cutoff: coverageRow?.cutoff ?? null,
    completeness: coverageRow?.completeness === "complete"
      ? "complete"
      : coverageRow?.completeness === "partial"
        ? "partial"
        : "unavailable",
  };
  const coverageRows = Number(coverageRow?.rows ?? 0);
  const coverageState = coverageAvailability(coverageRows, coverage.completeness);
  const sourceMetadata = {
    source: "productwise_xlsx",
    value_basis: "basic_order_value_ex_gst",
    months: coverage.months,
    month: coverage.months.length === 1 ? coverage.months[0] : null,
    cutoff: coverage.cutoff,
    completeness: coverage.completeness,
  };
  if (coverageState === "unavailable") {
    return baseNode(
      `pending-orders/${fyValue}`,
      fyValue,
      "Pending secondary orders — reconciled attribution",
      "Product-Wise / secondary_order_line",
      {
        sourceMetadata,
        unavailableReason: `Product-Wise order source is not loaded for ${fyValue}; pending order value is unavailable, not zero.`,
        attribution: "Legacy PSCode3 rows are excluded.",
      },
      [money(null, "Pending order booking value", "unavailable")],
      "unavailable",
      coverage,
    );
  }
  const result = await pool.query<{
    bucket: string; lines: string; qty: string; value: string; heads: string;
  }>(
    `SELECT CASE
              WHEN NULLIF(BTRIM(sales_user_name),'') IS NULL THEN 'unassigned'
              WHEN NULLIF(BTRIM(state),'') IS NULL THEN 'disputed'
              ELSE 'assigned'
            END bucket,
            COUNT(*)::text lines, COALESCE(SUM(qty),0)::text qty,
            COALESCE(SUM(basic_order_value),0)::text value,
            COUNT(DISTINCT NULLIF(BTRIM(sales_user_name),''))::text heads
       FROM secondary_order_line
      WHERE fiscal_year=$1 AND ${PRODUCTWISE_PENDING_PREDICATE}
        AND UPPER(COALESCE(order_status,''))='PENDING'
      GROUP BY 1 ORDER BY 1`, [fyValue]);
  const rows = result.rows.map((r) => ({ bucket: r.bucket, lines: Number(r.lines), qty: Number(r.qty), value: Number(r.value), heads: Number(r.heads) }));
  const total = rows.reduce((n, r) => n + r.lines, 0);
  const totalQty = rows.reduce((n, r) => n + r.qty, 0);
  const totalValue = rows.reduce((n, r) => n + r.value, 0);
  return baseNode(`pending-orders/${fyValue}`, fyValue, "Pending secondary orders — reconciled attribution", "secondary_order_line (Product-Wise CRM order_status; August 2026 onward)", {
    rows, reconciliation: { totalLines: total, totalQty, totalBasicOrderValue: totalValue, sumOfBucketsEqualsTotal: true },
    coverage: rows.map((r) => ({ bucket: r.bucket, lines: r.lines, qty: r.qty, sharePct: total ? r.lines / total * 100 : null })),
    sourceMetadata,
    attribution: "assigned by sales_user_name; missing member is unassigned; missing state is disputed; no member is inferred. Legacy PSCode3 rows are excluded.",
  }, [money(totalValue, "Pending order booking value", coverageState === "measured" ? "measured" : "partial")], coverageState === "measured" ? "measured" : "partial", coverage);
}

export type PeerBasis = "same-distributor" | "same-state" | "national";
export const targetAnchoredQuintile = (targetValue: number, peerValues: number[]) => {
  const all = [targetValue, ...peerValues].sort((a, b) => b - a || 0);
  const rank = all.findIndex((v) => v === targetValue);
  const quintile = Math.min(4, Math.floor(rank * 5 / all.length));
  return { quintile, peerCount: peerValues.filter((v) => Math.min(4, Math.floor(all.indexOf(v) * 5 / all.length)) === quintile).length };
};

/** Prompt 105 peer-set penetration, with the five-retailer safety floor. */
export async function resolveCustomerSkuPenetration(retailer: string, fyValue: string, basis: PeerBasis = "same-distributor", state?: string): Promise<GraphNode> {
  if (!FY_RE.test(fyValue) || !/^RET#\d+$/i.test(retailer)) throw new Error("Invalid retailer or fiscal year");
  const target = await pool.query<{ value: string; cp_code: string | null; state: string | null }>(
    `SELECT COALESCE(SUM(basic_order_value),0)::text value, MIN(cp_code) cp_code, MIN(state) state
       FROM secondary_order_line
      WHERE fiscal_year=$1 AND dealer_id=$2 AND source_kind='product_wise'
        AND order_datetime >= TIMESTAMPTZ '2026-08-01'`, [fyValue, retailer]);
  if (!target.rows[0]) throw new Error("Retailer is not present in secondary_order_line");
  const t = target.rows[0];
  const match = basis === "same-distributor" ? "cp_code=$3" : basis === "same-state" ? "state=$3" : "TRUE";
  const value = Number(t.value);
  const params: unknown[] = basis === "national" ? [fyValue, retailer] : [fyValue, retailer, basis === "same-state" ? (state ?? t.state) : t.cp_code];
  const peers = await pool.query<{ id: string; value: string }>(
    `SELECT dealer_id id, COALESCE(SUM(basic_order_value),0)::text value
       FROM secondary_order_line WHERE fiscal_year=$1 AND source_kind='product_wise'
         AND order_datetime >= TIMESTAMPTZ '2026-08-01' AND ${match}
      GROUP BY dealer_id HAVING dealer_id<>$2`, params);
  const raw = peers.rows.map((r) => ({ id: r.id, value: Number(r.value) }));
  let selected = raw;
  let quintile: number | null = null;
  if (raw.length > 40) {
    quintile = targetAnchoredQuintile(value, raw.map((r) => r.value)).quintile;
    const sorted = [{ id: retailer, value }, ...raw].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    selected = sorted.filter((r) => r.id !== retailer && Math.min(4, Math.floor(sorted.indexOf(r) * 5 / sorted.length)) === quintile);
  }
  const basisText = `Product-Wise secondary_order_line dealer_id + ${basis} identity; basic_order_value annual quintile`;
  // July is a control only. It never populates the August peer set.
  const control = await pool.query<{ crm_lines: string; crm_value: string; legacy_lines: string; legacy_value: string }>(
    `SELECT
       (SELECT COUNT(*)::text FROM secondary_order_line WHERE source_kind='product_wise' AND order_datetime >= TIMESTAMPTZ '2026-07-01' AND order_datetime < TIMESTAMPTZ '2026-08-01') crm_lines,
       (SELECT COALESCE(SUM(basic_order_value),0)::text FROM secondary_order_line WHERE source_kind='product_wise' AND order_datetime >= TIMESTAMPTZ '2026-07-01' AND order_datetime < TIMESTAMPTZ '2026-08-01') crm_value,
       (SELECT COUNT(*)::text FROM secondary_sku_line WHERE fy='2026-27' AND month_label='Jul-26') legacy_lines,
       (SELECT COALESCE(SUM(net_amount),0)::text FROM secondary_sku_line WHERE fy='2026-27' AND month_label='Jul-26') legacy_value`, []);
  const controlRow = control.rows[0];
  const julyControl = controlRow && controlRow.crm_lines === controlRow.legacy_lines && controlRow.crm_value === controlRow.legacy_value
    ? { availability: "measured", exact: true, productWiseLines: Number(controlRow.crm_lines), productWiseValue: Number(controlRow.crm_value), psCode3Lines: Number(controlRow.legacy_lines), psCode3Value: Number(controlRow.legacy_value) }
    : { availability: "unavailable", exact: false, reason: "July sources do not reconcile exactly; no equivalence is asserted." };
  if (selected.length < 5) {
    return baseNode(`penetration/${retailer}/${fyValue}`, fyValue, `Customer-SKU penetration — ${retailer}`, basisText, {
      peerBasis: basis, rawPeerCount: raw.length, refinedPeerCount: selected.length, quintile, julyControl,
      reason: `Cohort has ${selected.length} peers; minimum is 5.`, refinement: raw.length > 40 ? "annual-value-quintile" : "none",
    }, [pct(null, "SKU penetration", { numerator: "unavailable", denominator: "unavailable", population: "peer cohort", period: fyValue, source: basisText }, "unavailable")], "unavailable");
  }
  const ids = selected.map((r) => r.id);
  const penetration = await pool.query<{ code: string; buyers: string }>(
    `SELECT product_code code, COUNT(DISTINCT dealer_id)::text buyers
       FROM secondary_order_line
      WHERE fiscal_year=$1 AND source_kind='product_wise'
        AND order_datetime >= TIMESTAMPTZ '2026-08-01'
        AND dealer_id=ANY($2::text[])
      GROUP BY product_code ORDER BY product_code`, [fyValue, ids]);
  const values = penetration.rows.map((r) => ({ code: r.code, buyers: Number(r.buyers), eligible: selected.length, pct: Number(r.buyers) / selected.length * 100 }));
  return baseNode(`penetration/${retailer}/${fyValue}`, fyValue, `Customer-SKU penetration — ${retailer}`, basisText, {
    peerBasis: basis, rawPeerCount: raw.length, refinedPeerCount: selected.length, quintile,
    refinement: raw.length > 40 ? "annual-value-quintile" : "none", julyControl,
    productFacts: "Product-Wise secondary_order_line.product_code and dealer_id only", items: values,
  }, [pct(null, "SKU penetration", { numerator: "items by peer buyers", denominator: "eligible same-distributor peers", population: `${selected.length} Product-Wise peers`, period: fyValue, source: "Product-Wise secondary_order_line.product_code + dealer_id" }, "partial")], "partial");
}
