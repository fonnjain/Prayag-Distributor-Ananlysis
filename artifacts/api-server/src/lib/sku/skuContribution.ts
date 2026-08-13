/**
 * Gross contribution lookup from margin_fact.
 *
 * Formula (per the specification):
 *   contribution_per_unit = avg_sale − bom_cost            (volume-weighted, ₹/unit)
 *   contribution_pct      = (avg_sale − bom_cost) / avg_sale
 *   opportunity_contribution = opportunity_qty × contribution_per_unit
 *
 * BOM cost is FACTORY cost only. No freight, overhead, or SG&A.
 * Every derived figure must be labelled GROSS CONTRIBUTION, never "margin" or "profit".
 *
 * Uses the trailing 12 calendar months from margin_fact, volume-weighted by qty.
 * Codes with no rows (or rows where bom_cost / avg_sale is null) are absent from the
 * returned map — callers treat missing = null (no cost data), sort last.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type CodeContribution = {
  /** Volume-weighted (avg_sale − bom_cost), ₹ per unit. */
  contributionPerUnit: number;
  /** (avg_sale − bom_cost) / avg_sale as a fraction 0–1. */
  contributionPct: number;
  /** Month count with usable data in the trailing 12-month window. */
  coverageMonths: number;
};

export type SegmentContribution = {
  /** Volume-weighted (sale_value − bom_value) / sale_value as a fraction 0–1. */
  contributionPct: number;
  coverageMonths: number;
};

// ── Trailing-month cache (15-min TTL) ─────────────────────────────────────────

let _trailingMonthsCache: { labels: string[]; at: number } | null = null;
const TRAILING_TTL_MS = 15 * 60 * 1000;

export async function getTrailing12Months(): Promise<string[]> {
  if (_trailingMonthsCache && Date.now() - _trailingMonthsCache.at < TRAILING_TTL_MS) {
    return _trailingMonthsCache.labels;
  }
  const res = await db.execute<{ month_label: string }>(sql`
    SELECT month_label
    FROM (
      SELECT month_label, TO_DATE(month_label, 'Mon-YY') AS d
      FROM   margin_fact
      GROUP  BY month_label
    ) t
    ORDER  BY d DESC
    LIMIT  12
  `);
  const labels = res.rows.map((r) => r.month_label);
  _trailingMonthsCache = { labels, at: Date.now() };
  return labels;
}

// ── Code-level lookup ─────────────────────────────────────────────────────────

/**
 * Returns gross contribution data for each item code that has usable margin_fact
 * rows in the trailing 12 months.  Codes absent from the returned Map have no
 * cost data and must be labelled "no cost data" / sorted last.
 */
export async function getCodeContributions(
  codes: string[],
): Promise<Map<string, CodeContribution>> {
  if (codes.length === 0) return new Map();
  const months = await getTrailing12Months();
  if (months.length === 0) return new Map();

  const res = await db.execute<{
    item_code: string;
    vw_avg_sale: string | null;
    vw_bom_cost: string | null;
    coverage_months: string;
  }>(sql`
    SELECT
      item_code,
      (SUM(qty * avg_sale)::numeric / NULLIF(SUM(qty), 0))  AS vw_avg_sale,
      (SUM(qty * bom_cost)::numeric / NULLIF(SUM(qty), 0))  AS vw_bom_cost,
      COUNT(DISTINCT month_label)::text                      AS coverage_months
    FROM   margin_fact
    WHERE  item_code  = ANY(ARRAY[${sql.join(codes.map((c) => sql`${c}`), sql`, `)}])
      AND  bom_cost   IS NOT NULL
      AND  avg_sale   IS NOT NULL
      AND  qty        > 0
      AND  month_label = ANY(ARRAY[${sql.join(months.map((m) => sql`${m}`), sql`, `)}])
    GROUP  BY item_code
  `);

  const out = new Map<string, CodeContribution>();
  for (const r of res.rows) {
    const avgSale = parseFloat(r.vw_avg_sale ?? "0") || 0;
    const bomCost = parseFloat(r.vw_bom_cost ?? "0") || 0;
    if (avgSale <= 0) continue;
    const cpUnit = avgSale - bomCost;
    out.set(r.item_code, {
      contributionPerUnit: cpUnit,
      contributionPct:     cpUnit / avgSale,
      coverageMonths:      parseInt(r.coverage_months, 10) || 0,
    });
  }
  return out;
}

// ── Segment-level lookup ──────────────────────────────────────────────────────

/**
 * Returns volume-weighted gross contribution% per segment from the trailing
 * 12 months.  Used when code-level data is unavailable (e.g. Growth Report
 * entity-level estimates).
 */
export async function getSegmentContributions(): Promise<Map<string, SegmentContribution>> {
  const months = await getTrailing12Months();
  if (months.length === 0) return new Map();

  const res = await db.execute<{
    segment: string;
    vw_sale: string | null;
    vw_bom: string | null;
    coverage_months: string;
  }>(sql`
    SELECT
      segment,
      (SUM(qty * avg_sale)::numeric / NULLIF(SUM(qty), 0)) AS vw_sale,
      (SUM(qty * bom_cost)::numeric / NULLIF(SUM(qty), 0)) AS vw_bom,
      COUNT(DISTINCT month_label)::text                     AS coverage_months
    FROM   margin_fact
    WHERE  bom_cost   IS NOT NULL
      AND  avg_sale   IS NOT NULL
      AND  qty        > 0
      AND  month_label = ANY(ARRAY[${sql.join(months.map((m) => sql`${m}`), sql`, `)}])
    GROUP  BY segment
  `);

  const out = new Map<string, SegmentContribution>();
  for (const r of res.rows) {
    const sale = parseFloat(r.vw_sale ?? "0") || 0;
    const bom  = parseFloat(r.vw_bom  ?? "0") || 0;
    if (sale <= 0) continue;
    out.set(r.segment, {
      contributionPct:  (sale - bom) / sale,
      coverageMonths:   parseInt(r.coverage_months, 10) || 0,
    });
  }
  return out;
}

// ── Sorting helper ─────────────────────────────────────────────────────────────

/** Sort comparator: null last, descending. */
export function sortByContrib(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;   // a is null → goes after b
  if (b == null) return -1;  // b is null → goes after a
  return b - a;              // descending
}

/** Compute noCostData stats from any array that has contributionPerUnit and a net field. */
export function noCostStats(
  items: { contributionPerUnit?: number | null; net?: number; peerNet?: number; priorNet?: number }[],
): { codeCount: number; sharePct: number } {
  let noCost = 0;
  let noCostNet = 0;
  let totalNet = 0;
  for (const it of items) {
    const net = it.net ?? it.peerNet ?? it.priorNet ?? 0;
    totalNet += net;
    if (it.contributionPerUnit == null) { noCost++; noCostNet += net; }
  }
  return {
    codeCount: noCost,
    sharePct:  totalNet > 0 ? Math.round((noCostNet / totalNet) * 1000) / 10 : 0,
  };
}
