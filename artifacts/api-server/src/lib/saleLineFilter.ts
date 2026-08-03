// Shared State Head / State / Distributor filtering over sale_line.
//
// Extracted from lib/companyReports.ts so other sale_line-based report
// endpoints (Products, Growth/analytics) can reuse the exact same filter
// semantics without a circular import (companyReports imports from
// analytics.ts, and analytics also needs these helpers).
//
// Names must match sale_line values: heads → head_canon, states → the
// NORMALISED state (normStateExpr output), customers → customer.
import { and, eq, sql } from "drizzle-orm";
import { db, saleLines } from "@workspace/db";

export type EntityFilter = {
  heads?: string[];
  states?: string[];
  customers?: string[];
  /** Match nothing — set when a prior-FY scope resolves to zero customers. */
  none?: boolean;
};

export function hasEntityFilterValues(f?: EntityFilter): boolean {
  if (!f) return false;
  return Boolean(f.heads?.length || f.states?.length || f.customers?.length);
}

/**
 * SQL expression that normalises management territory splits to canonical
 * geographic state names. Use this everywhere instead of bare
 * coalesce(stateCanon, 'Unmapped') so that DELHI A + DELHI NCR aggregate
 * together, UP variants merge into UTTAR PRADESH, HP maps to HIMACHAL
 * PRADESH, and KARNATAKA (B) maps to KARNATAKA.
 */
export function normStateExpr() {
  return sql<string>`CASE
    WHEN ${saleLines.stateCanon} IN ('DELHI A', 'DELHI NCR')              THEN 'DELHI'
    WHEN ${saleLines.stateCanon} IN ('UP ( A )', 'UP (AS)', 'UP (S)')      THEN 'UTTAR PRADESH'
    WHEN ${saleLines.stateCanon} = 'HP'                                    THEN 'HIMACHAL PRADESH'
    WHEN ${saleLines.stateCanon} = 'KARNATAKA (B)'                         THEN 'KARNATAKA'
    ELSE COALESCE(${saleLines.stateCanon}, 'Unmapped')
  END`;
}

// sql.join IN-clause (ANY(jsArray) silently matches nothing with drizzle).
export function inList(expr: ReturnType<typeof sql<string>>, values: string[]) {
  return sql`${expr} IN (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;
}

export function entityConds(f?: EntityFilter) {
  const conds = [];
  if (f?.none) conds.push(sql`false`);
  if (f?.heads?.length) conds.push(inList(sql<string>`coalesce(${saleLines.headCanon}, 'Unmapped')`, f.heads));
  if (f?.states?.length) conds.push(inList(normStateExpr(), f.states));
  if (f?.customers?.length) conds.push(inList(sql<string>`coalesce(${saleLines.customer}, '')`, f.customers));
  return conds;
}

/**
 * Prior-FY entity scope: head/state filters describe the CURRENT FY
 * territory tree; historical head/state columns can disagree for reassigned
 * parties. So heads/states are resolved to the current-FY customer set and
 * the prior FY is filtered by those customers only.
 */
export async function resolvePriorEntityFilter(
  fy: string,
  filter?: EntityFilter,
): Promise<EntityFilter | undefined> {
  if (!filter || !(filter.heads?.length || filter.states?.length)) return filter;
  const custRows = await db.selectDistinct({ customer: sql<string>`coalesce(${saleLines.customer}, '')` })
    .from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.versionStatus, "current"), ...entityConds(filter)));
  const customers = custRows.map((r) => r.customer).filter(Boolean);
  // Empty resolution must match nothing in the prior year. Never use a
  // sentinel string containing \u0000 — Postgres rejects null bytes in
  // parameters; the `none` flag becomes a literal `false` condition instead.
  return customers.length > 0 ? { customers } : { none: true };
}
