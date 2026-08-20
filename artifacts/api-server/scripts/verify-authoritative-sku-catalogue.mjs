#!/usr/bin/env node
/**
 * Read-only reconciliation for the SKU catalogue authority cutover.
 *
 * Usage:
 *   node artifacts/api-server/scripts/verify-authoritative-sku-catalogue.mjs
 */

import { spawnSync } from "node:child_process";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL env var required");

function queryJson(query) {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${query.replace(/;\s*$/, "")}) t;`;
  const result = spawnSync("psql", [connectionString, "--tuples-only", "--no-align"], {
    input: wrapped,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr?.trim() || result.error || "unknown error"}`);
  }
  return JSON.parse(result.stdout.trim() || "[]");
}

function main() {
    const [catalogue] = queryJson(`
      WITH active AS (
        SELECT generation_id FROM mrp_sync_generation WHERE is_active = TRUE
      ),
      old_catalogue AS (
        SELECT COUNT(DISTINCT code)::int AS codes
        FROM item_master WHERE mrp IS NOT NULL AND mrp > 0
      ),
      authority_catalogue AS (
        SELECT COUNT(DISTINCT item_code)::int AS codes,
               COUNT(DISTINCT item_code) FILTER (WHERE mrp IS NULL OR mrp <= 0)::int AS unpriced
        FROM mrp_synced WHERE generation_id = (SELECT generation_id FROM active)
      )
      SELECT old_catalogue.codes AS old_codes,
             authority_catalogue.codes AS authority_codes,
             authority_catalogue.codes - old_catalogue.codes AS delta,
             authority_catalogue.unpriced AS authority_unpriced
      FROM old_catalogue CROSS JOIN authority_catalogue
    `);

    const [neverSold] = queryJson(`
      WITH active AS (
        SELECT generation_id FROM mrp_sync_generation WHERE is_active = TRUE
      ),
      sold AS (
        SELECT DISTINCT code FROM sale_line_current
        WHERE version_status = 'current' AND code IS NOT NULL AND code <> ''
      ),
      old_never_sold AS (
        SELECT COUNT(DISTINCT im.code)::int AS codes
        FROM item_master im LEFT JOIN sold ON sold.code = im.code
        WHERE im.mrp IS NOT NULL AND im.mrp > 0 AND sold.code IS NULL
      ),
      authority_never_sold AS (
        SELECT COUNT(DISTINCT s.item_code)::int AS codes
        FROM mrp_synced s LEFT JOIN sold ON sold.code = s.item_code
        WHERE s.generation_id = (SELECT generation_id FROM active)
          AND sold.code IS NULL
      )
      SELECT old_never_sold.codes AS old_codes,
             authority_never_sold.codes AS authority_codes,
             authority_never_sold.codes - old_never_sold.codes AS delta
      FROM old_never_sold CROSS JOIN authority_never_sold
    `);

    const pushRows = queryJson(`
      WITH current_fy AS (
        SELECT MAX(fy) AS fy FROM sale_line_current WHERE version_status = 'current'
      )
      SELECT DISTINCT sl.customer, sl.code
      FROM sale_line_current sl
      LEFT JOIN item_master im ON im.code = sl.code
      WHERE sl.version_status = 'current'
        AND sl.fy = (SELECT fy FROM current_fy)
        AND sl.customer IS NOT NULL AND sl.customer <> ''
        AND sl.code IS NOT NULL AND sl.code <> ''
        AND im.item_group IS NULL
      ORDER BY sl.customer, sl.code
    `);

    const headTotals = queryJson(`
      SELECT COALESCE(head_canon, 'Unattributed') AS head,
             SUM(amount)::numeric(18,2)::text AS net
      FROM sale_line_current
      WHERE version_status = 'current' AND fy = '2025-26'
      GROUP BY 1
      ORDER BY 1
    `);
    const protectedTables = queryJson(`
      SELECT 'mrp_master' AS table_name, COUNT(*)::int AS rows FROM mrp_master
      UNION ALL SELECT 'mrp_history', COUNT(*)::int FROM mrp_history
      UNION ALL SELECT 'sale_line_all', COUNT(*)::int FROM sale_line_all
      UNION ALL SELECT 'margin_fact', COUNT(*)::int FROM margin_fact
      ORDER BY 1
    `);

    console.log("SKU catalogue authority reconciliation (read-only)");
    console.log(`Products exist: old local=${catalogue.old_codes}, authority=${catalogue.authority_codes}, delta=${catalogue.delta}; source-unpriced=${catalogue.authority_unpriced}`);
    console.log(`Never sold: old local=${neverSold.old_codes}, authority=${neverSold.authority_codes}, delta=${neverSold.delta}`);
    console.log(`Recovered Push List taxonomy rows: ${pushRows.length}; distinct codes=${new Set(pushRows.map((row) => row.code)).size}`);
    console.log("Recovered Push List codes (customer | code):");
    for (const row of pushRows) console.log(`  ${row.customer} | ${row.code}`);
    console.log("FY2025-26 net by head baseline (sale data is read-only):");
    for (const row of headTotals) console.log(`  ${row.head} | ₹${row.net}`);
    console.log("Protected table row-count evidence:");
    for (const row of protectedTables) console.log(`  ${row.table_name} | ${row.rows}`);
}

main();