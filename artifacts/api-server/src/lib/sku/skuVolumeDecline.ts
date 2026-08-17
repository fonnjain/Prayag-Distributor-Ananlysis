/**
 * SKU Volume Decline — Phase K5a.
 *
 * Compares identical fiscal months across the current FY and the prior FY.
 * Returns SKU codes whose absolute piece count has fallen, ranked by the
 * size of the fall.  Codes with zero purchases this period but purchases last
 * year are included and marked "stopped".
 *
 * Channel: territory only (project head excluded).  Level (distributor /
 * direct_dealer) still applies — the project and retailer options are not
 * supported by this service.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PROJECT_HEAD_CANON } from "./catalogue.js";
import { entityCondsAliased, type EntityFilter } from "../saleLineFilter.js";
import { getCodeContributions } from "./skuContribution.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type VolumeDeclineRow = {
  code: string;
  segment: string;
  itemName: string | null;
  qtyNow: number;
  qtyPrior: number;
  /** Always negative (or zero for "stopped" codes). */
  qtyChange: number;
  /** null only when qtyPrior is zero (shouldn't happen due to materiality floor). */
  qtyChangePct: number | null;
  netNow: number;
  netPrior: number;
  netChange: number;
  customersNow: number;
  customersPrior: number;
  /** true when qtyNow === 0 — bought last year, not at all this period. */
  stopped: boolean;
  /**
   * GROSS CONTRIBUTION — factory cost only, not profit.
   * null = no cost data in margin_fact; rows sort last.
   */
  contributionPerUnit: number | null;
};

export type VolumeDeclineSegment = {
  segment: string;
  /** Sum of qtyChange for all rows in this segment (negative number). */
  qtyDeclineTotal: number;
  netChangeTotal: number;
  rows: VolumeDeclineRow[];
};

export type VolumeDeclineResult = {
  fy: string;
  priorFy: string;
  currMonths: string[];
  priorMonths: string[];
  /** Materiality floor applied to prior-period net (₹). */
  floor: number;
  /** Segments sorted worst-first by their total piece decline. */
  segments: VolumeDeclineSegment[];
  totalCodes: number;
  stoppedCodes: number;
};

// ── Params ────────────────────────────────────────────────────────────────────

export type VolumeDeclineParams = {
  fy: string;
  priorFy: string;
  currMonths: string[];
  priorMonths: string[];
  level: "distributor" | "direct_dealer";
  scope: "company" | "head";
  scopeId?: string;
  entityFilter?: EntityFilter;
  /** Materiality floor on prior-period net.  Default 50 000. */
  floor: number;
};

// ── Main ──────────────────────────────────────────────────────────────────────

export async function getVolumeDecline(params: VolumeDeclineParams): Promise<VolumeDeclineResult> {
  const { fy, priorFy, currMonths, priorMonths, level, scope, scopeId, entityFilter, floor } = params;

  // Level filter — territory channels only (project always excluded).
  const projectExclude = sql`AND (sl.head_canon IS NULL OR sl.head_canon != ${PROJECT_HEAD_CANON})`;
  const levelFilter =
    level === "direct_dealer"
      ? sql`AND sl.type_raw ILIKE '%direct%' ${projectExclude}`
      : sql`AND (sl.type_raw IS NULL OR sl.type_raw NOT ILIKE '%direct%') ${projectExclude}`;

  const scopeFilter =
    scope === "head" && scopeId ? sql`AND sl.head_canon = ${scopeId}` : sql``;

  const entityFilterSql = entityCondsAliased(entityFilter, "sl");

  const currArr = sql.join(
    currMonths.map((m) => sql`${m}`),
    sql`, `,
  );
  const priorArr = sql.join(
    priorMonths.map((m) => sql`${m}`),
    sql`, `,
  );

  const rows = await db.execute<{
    segment: string;
    code: string;
    item_name: string | null;
    qty_now: string;
    qty_prior: string;
    net_now: string;
    net_prior: string;
    customers_now: string;
    customers_prior: string;
  }>(sql`
    WITH
    curr AS (
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        sl.code,
        SUM(sl.qty::numeric)         AS qty,
        SUM(sl.amount::numeric)      AS net,
        COUNT(DISTINCT sl.customer)  AS customers
      FROM sale_line_current sl
      WHERE sl.fy             = ${fy}
        AND sl.month_label    = ANY(ARRAY[${currArr}])
        AND sl.version_status = 'current'
        ${levelFilter}
        ${scopeFilter}
        ${entityFilterSql}
      GROUP BY 1, sl.code
    ),
    prior AS (
      SELECT
        COALESCE(sl.group_canon, sl.group_raw, 'Unmapped') AS segment,
        sl.code,
        SUM(sl.qty::numeric)         AS qty,
        SUM(sl.amount::numeric)      AS net,
        COUNT(DISTINCT sl.customer)  AS customers
      FROM sale_line_current sl
      WHERE sl.fy             = ${priorFy}
        AND sl.month_label    = ANY(ARRAY[${priorArr}])
        AND sl.version_status = 'current'
        ${levelFilter}
        ${scopeFilter}
        ${entityFilterSql}
      GROUP BY 1, sl.code
    )
    SELECT
      p.segment,
      p.code,
      im.item_name,
      COALESCE(c.qty,       0)::text  AS qty_now,
      p.qty::text                     AS qty_prior,
      COALESCE(c.net,       0)::text  AS net_now,
      p.net::text                     AS net_prior,
      COALESCE(c.customers, 0)::text  AS customers_now,
      p.customers::text               AS customers_prior
    FROM prior p
    LEFT JOIN curr c ON c.code = p.code AND c.segment = p.segment
    LEFT JOIN item_master im ON im.code = p.code
    WHERE p.net::numeric           >= ${floor}
      AND COALESCE(c.qty, 0)::numeric <  p.qty::numeric
    ORDER BY p.segment, (COALESCE(c.qty, 0)::numeric - p.qty::numeric) ASC
  `);

  // Gross contribution for all result codes
  const allCodes = [...new Set(rows.rows.map((r) => r.code))];
  const contributions = await getCodeContributions(allCodes);

  // Build typed rows
  const typedRows: VolumeDeclineRow[] = rows.rows.map((r) => {
    const qtyNow    = parseFloat(r.qty_now)   || 0;
    const qtyPrior  = parseFloat(r.qty_prior) || 0;
    const netNow    = parseFloat(r.net_now)   || 0;
    const netPrior  = parseFloat(r.net_prior) || 0;
    const qtyChange = qtyNow - qtyPrior;
    return {
      code:       r.code,
      segment:    r.segment,
      itemName:   r.item_name,
      qtyNow,
      qtyPrior,
      qtyChange,
      qtyChangePct: qtyPrior > 0 ? (qtyChange / qtyPrior) * 100 : null,
      netNow,
      netPrior,
      netChange:      netNow - netPrior,
      customersNow:   parseInt(r.customers_now,   10) || 0,
      customersPrior: parseInt(r.customers_prior, 10) || 0,
      stopped:              qtyNow === 0,
      contributionPerUnit:  contributions.get(r.code)?.contributionPerUnit ?? null,
    };
  });

  // Group by segment
  const segMap = new Map<string, VolumeDeclineRow[]>();
  for (const row of typedRows) {
    const existing = segMap.get(row.segment) ?? [];
    existing.push(row);
    segMap.set(row.segment, existing);
  }

  // Build segment summaries, sort rows within each segment worst-first
  const segments: VolumeDeclineSegment[] = [...segMap.entries()].map(([segment, segRows]) => {
    segRows.sort((a, b) => a.qtyChange - b.qtyChange); // most negative first
    return {
      segment,
      qtyDeclineTotal: segRows.reduce((s, r) => s + r.qtyChange, 0),
      netChangeTotal:  segRows.reduce((s, r) => s + r.netChange, 0),
      rows: segRows,
    };
  });

  // Sort segments worst-first by total piece decline
  segments.sort((a, b) => a.qtyDeclineTotal - b.qtyDeclineTotal);

  return {
    fy,
    priorFy,
    currMonths,
    priorMonths,
    floor,
    segments,
    totalCodes:   typedRows.length,
    stoppedCodes: typedRows.filter((r) => r.stopped).length,
  };
}
