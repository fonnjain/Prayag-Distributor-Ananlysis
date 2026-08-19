/**
 * CLI script: Load the Product-Wise Secondary Order Report.
 *
 * Usage (from the api-server directory):
 *   # Use the file already in attached_assets (default):
 *   pnpm run load-secondary-orders
 *
 *   # Specify an explicit file path:
 *   SOL_XLSX=/path/to/file.xlsx pnpm run load-secondary-orders
 *
 *   # Dry run (parse only, no DB writes):
 *   pnpm run load-secondary-orders --dry-run
 *
 * The script:
 *   1. Runs pending DB migrations (creates secondary_order_line if needed)
 *   2. Loads the XLSX file
 *   3. Prints verification output with all anchor stats
 *   4. Reports idempotency (re-running produces the same row count)
 *   5. Confirms secondary_sku_line / secondary_register_line / sale_line are unchanged
 */

import { runMigrations, pool } from "@workspace/db";
import {
  loadSecondaryOrders,
  verifySecondaryOrders,
  resolveSecondaryOrderXlsx,
} from "./lib/secondaryOrders/loader.js";
import process from "node:process";

const isDryRun = process.argv.includes("--dry-run");

async function main() {
  console.log("=".repeat(70));
  console.log("Secondary Order Report Loader");
  console.log("=".repeat(70));

  // Step 1: Run migrations
  console.log("\n[1/4] Running migrations...");
  await runMigrations();
  console.log("      Migrations OK");

  // Confirm file
  let filePath: string;
  try {
    filePath = resolveSecondaryOrderXlsx();
    console.log(`\n[2/4] File: ${filePath}`);
  } catch (err) {
    console.error(`\n[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Capture before-counts for idempotency check
  const before = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM secondary_order_line`);
  const beforeCount = Number(before.rows[0]?.n ?? 0);

  const sideTablesBefore = await pool.query<{ ssl: string; srl: string; sl: string }>(`
    SELECT
      (SELECT COUNT(*) FROM secondary_sku_line)::text AS ssl,
      (SELECT COUNT(*) FROM secondary_register_line)::text AS srl,
      (SELECT COUNT(*) FROM sale_line_all)::text AS sl
  `);
  const btBefore = sideTablesBefore.rows[0];

  // Step 2: Load
  console.log(`\n[3/4] Loading... (dryRun=${isDryRun})`);
  let result;
  try {
    result = await loadSecondaryOrders({ dryRun: isDryRun });
  } catch (err) {
    console.error(`\n[ERROR] Load failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log("\n── Load Result ──────────────────────────────────────────────────────");
  console.log(`  Rows scanned:    ${result.rowsScanned.toLocaleString()}`);
  console.log(`  Rows inserted:   ${result.rowsInserted.toLocaleString()}`);
  console.log(`  Rows skipped:    ${result.rowsSkipped.toLocaleString()} (idempotent)`);
  console.log(`  Collisions:      ${result.collisions.length}`);
  if (result.collisions.length > 0) {
    console.log("\n  Collision details (first 20):");
    for (const c of result.collisions.slice(0, 20)) {
      console.log(`    ${c.orderId} / ${c.productCode} — ${c.field}: stored="${c.stored}" incoming="${c.incoming}"`);
    }
  }
  console.log(`  Repeated order/product pairs: ${result.sourcePairCollisions.length}`);
  for (const pair of result.sourcePairCollisions) {
    console.log(`    ${pair.orderId} / ${pair.productCode} — ${pair.identical ? "EXACT DUPLICATE EXPORT" : "distinct source lines"}`);
    for (const line of pair.occurrences) {
      console.log(`      occurrence ${line.occurrence}, source row ${line.sourceRowNumber}: qty=${line.qty} discount=${line.discountPct}% basic=${line.basicOrderValue} dealer=${line.dealerOrderValue}`);
    }
  }
  console.log(`  Retained exact duplicate export rows: ${result.exactDuplicateExportRows.length}`);
  if (result.exactDuplicateWarning) {
    console.log("  WARNING: exact duplicate export rows exceed 0.5% of parsed lines.");
  }
  console.log(`\n  Unresolved sales users (${result.unresolvedSalesUsers.length}): ${result.unresolvedSalesUsers.join(", ") || "none"}`);
  console.log(`  Unmapped categories (${result.unmappedCategories.length}): ${result.unmappedCategories.join(", ") || "none"}`);

  if (isDryRun) {
    console.log("\n  DRY RUN — no rows written to DB");
    await pool.end();
    return;
  }

  // Step 3: Verify
  console.log("\n[4/4] Verification...");
  let v;
  try {
    v = await verifySecondaryOrders();
  } catch (err) {
    console.error(`\n[ERROR] Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log("\n── Verification Report ──────────────────────────────────────────────");
  console.log(`  Rows loaded:          ${v.rowsLoaded.toLocaleString()} (expected 8,602)`);
  console.log(`  Distinct orders:      ${v.distinctOrders.toLocaleString()} (expected 1,361)`);
  console.log(`  Distinct retailers:   ${v.distinctRetailers.toLocaleString()} (expected 1,132)`);
  console.log(`  Distinct distributors:${v.distinctDistributors.toLocaleString()} (expected 128)`);
  console.log(`  Distinct product codes:${v.distinctProductCodes.toLocaleString()} (expected 1,605)`);
  console.log(`  Date range:           ${v.dateMin} to ${v.dateMax} (expected 1–19 Aug 2026)`);
  console.log(`  Total qty:            ${v.totalQty.toLocaleString()} (expected 322,465)`);
  console.log(`  Total basic (INR):    ${v.totalBasic.toLocaleString()} (expected 56,403,177)`);
  console.log(`  Total dealer (INR):   ${v.totalDealer.toLocaleString()} (expected 66,333,521)`);
  console.log(`\n  Status split:`);
  for (const [status, cnt] of Object.entries(v.statusSplit)) {
    const expected = status === "APPROVED" ? " (expected 8,172)" : " (expected 430)";
    console.log(`    ${status}: ${cnt.toLocaleString()}${expected}`);
  }

  console.log("\n── Join Test ────────────────────────────────────────────────────────");
  console.log(`  Dealer ID (RET#) join: ${v.dealerJoin.matched.toLocaleString()}/${v.dealerJoin.total.toLocaleString()} = ${v.dealerJoin.pct} (expected ~97.2%)`);
  if (v.dealerJoin.unmatched.length > 0) {
    console.log(`  Non-matching dealer_ids (${v.dealerJoin.unmatched.length}, expected ~32):`);
    for (const id of v.dealerJoin.unmatched.slice(0, 50)) console.log(`    ${id}`);
  }
  console.log(`\n  CP Code (DIST#) join: ${v.cpJoin.matched.toLocaleString()}/${v.cpJoin.total.toLocaleString()} = ${v.cpJoin.pct} (expected ~98.4%)`);
  if (v.cpJoin.unmatched.length > 0) {
    console.log(`  Non-matching cp_codes (${v.cpJoin.unmatched.length}, expected ~2):`);
    for (const id of v.cpJoin.unmatched.slice(0, 20)) console.log(`    ${id}`);
  }
  console.log(`\n  Sales user resolution: ${v.salesUserResolution.matched.toLocaleString()}/${v.salesUserResolution.total.toLocaleString()} = ${v.salesUserResolution.pct} (expected ~98.3%)`);
  if (v.salesUserResolution.unmatched.length > 0) {
    console.log(`  Non-matching users (${v.salesUserResolution.unmatched.length}, expected: PRAYAG, ADARSH GAURAV):`);
    for (const name of v.salesUserResolution.unmatched) console.log(`    ${name}`);
  }

  console.log("\n── Category Mapping ─────────────────────────────────────────────────");
  for (const { category, segmentCanon } of v.categoryMapping) {
    console.log(`  ${category.padEnd(35)} → ${segmentCanon ?? "UNMAPPED"}`);
  }
  console.log(`  Unmapped count: ${v.unmappedCategoryCount}`);

  console.log("\n── Retained Exact Duplicate Export Rows ─────────────────────────────");
  if (v.exactDuplicateExportRows.length === 0) {
    console.log("  None");
  } else {
    for (const row of v.exactDuplicateExportRows) {
      console.log(`  ${row.order_id} / ${row.product_code}: qty=${row.qty}, basic=${row.basic_order_value}`);
    }
    console.log(`  Count: ${v.exactDuplicateExportRows.length} — retained so totals reconcile to the source file.`);
  }
  if (v.exactDuplicateWarning) {
    console.log("  WARNING: exact duplicate rows exceed the 0.5% review threshold.");
  }

  console.log("\n── High-Discount Lines (>90%) ───────────────────────────────────────");
  if (v.discountAbove90.length === 0) {
    console.log("  None");
  } else {
    console.log(`  Count: ${v.discountAbove90.length}`);
    for (const r of v.discountAbove90.slice(0, 30)) {
      console.log(`  ${r.order_id} / ${r.dealer_id} / ${r.product_code}  qty=${r.qty}  basic=${r.basic_order_value}  disc=${r.discount_pct}%`);
    }
  }

  // Idempotency test
  console.log("\n── Idempotency Test ─────────────────────────────────────────────────");
  console.log(`  Row count before load: ${beforeCount.toLocaleString()}`);
  console.log(`  Row count after load:  ${v.rowsLoaded.toLocaleString()}`);
  if (beforeCount > 0 && beforeCount === v.rowsLoaded) {
    console.log("  ✓ IDEMPOTENT: same row count — upsert skipped all existing rows");
  } else if (beforeCount === 0) {
    console.log("  ✓ FIRST LOAD: table was empty");
  } else {
    console.log(`  ← ${beforeCount.toLocaleString()} rows before / ${v.rowsLoaded.toLocaleString()} after`);
  }

  // Re-run for idempotency confirmation
  console.log("\n  Re-running load for idempotency verification...");
  const result2 = await loadSecondaryOrders({ filePath });
  const after2 = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM secondary_order_line`);
  const afterCount2 = Number(after2.rows[0]?.n ?? 0);
  console.log(`  After second load: ${afterCount2.toLocaleString()} rows — inserted=${result2.rowsInserted}, skipped=${result2.rowsSkipped}`);
  if (afterCount2 === v.rowsLoaded && result2.rowsInserted === 0) {
    console.log("  ✓ CONFIRMED IDEMPOTENT");
  } else {
    console.log(`  ✗ IDEMPOTENCY FAILED: count changed from ${v.rowsLoaded} to ${afterCount2}`);
  }

  // Side-table check
  const sideTablesAfter = await pool.query<{ ssl: string; srl: string; sl: string }>(`
    SELECT
      (SELECT COUNT(*) FROM secondary_sku_line)::text AS ssl,
      (SELECT COUNT(*) FROM secondary_register_line)::text AS srl,
      (SELECT COUNT(*) FROM sale_line_all)::text AS sl
  `);
  const btAfter = sideTablesAfter.rows[0];

  console.log("\n── Side-Table Integrity ─────────────────────────────────────────────");
  const sslOk = btBefore.ssl === btAfter.ssl;
  const srlOk = btBefore.srl === btAfter.srl;
  const slOk = btBefore.sl === btAfter.sl;
  console.log(`  secondary_sku_line:      ${btBefore.ssl} → ${btAfter.ssl} ${sslOk ? "✓" : "✗ CHANGED"}`);
  console.log(`  secondary_register_line: ${btBefore.srl} → ${btAfter.srl} ${srlOk ? "✓" : "✗ CHANGED"}`);
  console.log(`  sale_line_all:           ${btBefore.sl} → ${btAfter.sl} ${slOk ? "✓" : "✗ CHANGED"}`);

  console.log("\n" + "=".repeat(70));
  console.log("Load complete.");

  await pool.end();
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
