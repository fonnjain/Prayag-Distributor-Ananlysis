import { pool } from "@workspace/db";

export type ParityMetric = {
  table: string;
  rowCount: number;
  distinctKeys: number;
  populatedKeys: number;
  materialColumn: string;
  populatedMaterial: number;
  distinctMaterial: number;
};

export type EnvironmentParitySnapshot = {
  environment: string;
  database: "PostgreSQL";
  queriedAt: string;
  metrics: ParityMetric[];
};

export type ParityDifference = {
  key: string;
  status: "pass" | "warn" | "fail";
  development: number | null;
  production: number | null;
  delta: number | null;
  deltaPct: number | null;
  note: string;
};

const METRICS = [
  ["canonical_item_category_registry", "item_code", "master_category"],
  ["sale_line_current", "line_uid", "code"],
  ["secondary_sku_line", "line_uid", "item_code"],
  ["secondary_register_line", "line_uid", "brand_canon"],
  ["resolution_item", "code", "status"],
] as const;

export async function loadEnvironmentParitySnapshot(): Promise<EnvironmentParitySnapshot> {
  const metrics: ParityMetric[] = [];
  for (const [table, keyColumn, materialColumn] of METRICS) {
    // Names come only from the fixed allowlist above; no request value reaches SQL.
    const result = await pool.query<{
      row_count: string;
      distinct_keys: string;
      populated_keys: string;
      populated_material: string;
      distinct_material: string;
    }>(`
      SELECT
        COUNT(*)::text AS row_count,
        COUNT(DISTINCT ${keyColumn})::text AS distinct_keys,
        COUNT(*) FILTER (WHERE NULLIF(BTRIM(${keyColumn}::text), '') IS NOT NULL)::text AS populated_keys,
        COUNT(*) FILTER (WHERE NULLIF(BTRIM(${materialColumn}::text), '') IS NOT NULL)::text AS populated_material,
        COUNT(DISTINCT ${materialColumn}) FILTER (
          WHERE NULLIF(BTRIM(${materialColumn}::text), '') IS NOT NULL
        )::text AS distinct_material
      FROM ${table}
    `);
    const row = result.rows[0];
    metrics.push({
      table,
      rowCount: Number(row.row_count),
      distinctKeys: Number(row.distinct_keys),
      populatedKeys: Number(row.populated_keys),
      materialColumn,
      populatedMaterial: Number(row.populated_material),
      distinctMaterial: Number(row.distinct_material),
    });
  }
  return {
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    database: "PostgreSQL",
    queriedAt: new Date().toISOString(),
    metrics,
  };
}

function compareNumber(
  key: string,
  development: number,
  production: number,
  zeroVsPopulatedIsFailure = false,
): ParityDifference {
  const delta = development - production;
  const deltaPct = production === 0 ? (development === 0 ? 0 : null) : (delta / production) * 100;
  const materiallyDifferent = Math.abs(delta) >= 100 && (deltaPct == null || Math.abs(deltaPct) >= 5);
  const zeroMismatch = (development === 0) !== (production === 0);
  const status = zeroMismatch && zeroVsPopulatedIsFailure ? "fail" : materiallyDifferent ? "warn" : "pass";
  return {
    key,
    status,
    development,
    production,
    delta,
    deltaPct,
    note: status === "pass"
      ? "Within the materiality threshold (both ≥100 rows and ≥5%)."
      : zeroMismatch && zeroVsPopulatedIsFailure
        ? "FAIL: populated in one environment and empty in the other."
        : "WARN: row/key population differs by at least 100 and 5%.",
  };
}

export function compareEnvironmentParity(
  development: EnvironmentParitySnapshot | null,
  production: EnvironmentParitySnapshot | null,
): ParityDifference[] {
  if (!development || !production) {
    return [{
      key: "environment.counterpart",
      status: "fail",
      development: development ? 1 : null,
      production: production ? 1 : null,
      delta: null,
      deltaPct: null,
      note: "NOT EVALUATED: both development and production snapshots are required; this must never pass silently.",
    }];
  }
  const prodByTable = new Map(production.metrics.map((metric) => [metric.table, metric]));
  const differences: ParityDifference[] = [];
  for (const dev of development.metrics) {
    const prod = prodByTable.get(dev.table);
    if (!prod) {
      differences.push({
        key: `${dev.table}.counterpart`,
        status: "fail",
        development: dev.rowCount,
        production: null,
        delta: null,
        deltaPct: null,
        note: "NOT EVALUATED: table metric is missing from production.",
      });
      continue;
    }
    differences.push(compareNumber(`${dev.table}.row_count`, dev.rowCount, prod.rowCount));
    differences.push(compareNumber(`${dev.table}.distinct_keys`, dev.distinctKeys, prod.distinctKeys));
    differences.push(compareNumber(`${dev.table}.${dev.materialColumn}.population`, dev.populatedMaterial, prod.populatedMaterial, true));
    differences.push(compareNumber(`${dev.table}.${dev.materialColumn}.vocabulary`, dev.distinctMaterial, prod.distinctMaterial, true));
  }
  return differences;
}