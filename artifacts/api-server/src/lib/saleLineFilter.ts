// Shared State Head / State / Distributor filtering over sale_line.
//
// Extracted from lib/companyReports.ts so other sale_line-based report
// endpoints (Products, Growth/analytics) can reuse the exact same filter
// semantics without a circular import (companyReports imports from
// analytics.ts, and analytics also needs these helpers).
//
// Names must match sale_line values: heads → head_canon, states → the
// NORMALISED state (normStateExpr output), customers → customer.
import { and, eq, sql, type SQL } from "drizzle-orm";
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
 * Aliased variant of normStateExpr for raw-SQL query builders that reference
 * sale_line_current under a table alias (e.g. `sl`). Same normalisation rules.
 */
export function normStateExprAliased(alias: string): SQL<string> {
  const col = sql.raw(`${alias}.state_canon`);
  return sql<string>`CASE
    WHEN ${col} IN ('DELHI A', 'DELHI NCR')              THEN 'DELHI'
    WHEN ${col} IN ('UP ( A )', 'UP (AS)', 'UP (S)')      THEN 'UTTAR PRADESH'
    WHEN ${col} = 'HP'                                    THEN 'HIMACHAL PRADESH'
    WHEN ${col} = 'KARNATAKA (B)'                         THEN 'KARNATAKA'
    ELSE COALESCE(${col}, 'Unmapped')
  END`;
}

/**
 * Entity filter as a single appendable SQL chunk (`AND (…)` or empty) for
 * drizzle `db.execute(sql\`…\`)` queries that alias sale_line_current.
 * Semantics identical to entityConds().
 */
export function entityCondsAliased(f: EntityFilter | undefined, alias: string): SQL {
  if (!f || (!f.none && !hasEntityFilterValues(f))) return sql``;
  const parts: SQL[] = [];
  if (f.none) parts.push(sql`false`);
  if (f.heads?.length) {
    parts.push(
      sql`coalesce(${sql.raw(`${alias}.head_canon`)}, 'Unmapped') IN (${sql.join(f.heads.map((v) => sql`${v}`), sql`, `)})`,
    );
  }
  if (f.states?.length) {
    parts.push(sql`${normStateExprAliased(alias)} IN (${sql.join(f.states.map((v) => sql`${v}`), sql`, `)})`);
  }
  if (f.customers?.length) {
    parts.push(
      sql`coalesce(${sql.raw(`${alias}.customer`)}, '') IN (${sql.join(f.customers.map((v) => sql`${v}`), sql`, `)})`,
    );
  }
  return sql`AND (${sql.join(parts, sql` AND `)})`;
}

/**
 * Entity filter for text-parameterised pg pool queries. Returns a SQL
 * fragment (leading " AND (…)" or "") plus the positional params, starting at
 * $startIdx. node-postgres binds JS arrays to ::text[] correctly, so ANY() is
 * safe here (the drizzle ANY(jsArray) pitfall does not apply).
 */
export function entityCondsText(
  f: EntityFilter | undefined,
  alias: string,
  startIdx: number,
): { text: string; params: unknown[] } {
  if (!f || (!f.none && !hasEntityFilterValues(f))) return { text: "", params: [] };
  const a = alias ? `${alias}.` : "";
  const parts: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;
  if (f.none) parts.push("false");
  const stateCase = `CASE
    WHEN ${a}state_canon IN ('DELHI A', 'DELHI NCR')          THEN 'DELHI'
    WHEN ${a}state_canon IN ('UP ( A )', 'UP (AS)', 'UP (S)')  THEN 'UTTAR PRADESH'
    WHEN ${a}state_canon = 'HP'                                THEN 'HIMACHAL PRADESH'
    WHEN ${a}state_canon = 'KARNATAKA (B)'                     THEN 'KARNATAKA'
    ELSE COALESCE(${a}state_canon, 'Unmapped')
  END`;
  if (f.heads?.length) {
    parts.push(`COALESCE(${a}head_canon, 'Unmapped') = ANY($${i}::text[])`);
    params.push(f.heads);
    i++;
  }
  if (f.states?.length) {
    parts.push(`${stateCase} = ANY($${i}::text[])`);
    params.push(f.states);
    i++;
  }
  if (f.customers?.length) {
    parts.push(`COALESCE(${a}customer, '') = ANY($${i}::text[])`);
    params.push(f.customers);
    i++;
  }
  return { text: ` AND (${parts.join(" AND ")})`, params };
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
