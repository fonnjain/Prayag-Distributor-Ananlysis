// Secondary SKU backfill CLI — Phase K1.
//
// Loads the closed-year secondary registers at item-code (Cat. No.) granularity
// into secondary_sku_line. The existing secondary-backfill stores at brand level;
// this CLI stores at SKU level for the K-series analytics.
//
// Dry-run by default — nothing is written unless --commit is passed.
//
// Usage:
//   pnpm --filter @workspace/api-server run secondary-sku-backfill -- --dry-run
//   pnpm --filter @workspace/api-server run secondary-sku-backfill -- --fy 2024-25 --dry-run
//   pnpm --filter @workspace/api-server run secondary-sku-backfill -- --fy 2024-25 --commit
//   pnpm --filter @workspace/api-server run secondary-sku-backfill -- --fy 2025-26 --commit
//   pnpm --filter @workspace/api-server run secondary-sku-backfill -- --all --commit
//
// FY2023-24: 14-column layout; Cat. No. detected by header name. If not found,
//   the tab is skipped cleanly (logged, not an error).
// FY2026-27: NOT present — register not yet loaded. Add its sheet ID to
//   SKU_SHEET_IDS in skuLoader.ts when the register arrives; no other change needed.

import { pool } from "@workspace/db";
import { logger } from "./lib/logger.js";
import { loadSecSkuFromSheets, SKU_SHEET_IDS, SUPPORTED_SKU_FYS } from "./lib/secondary/skuLoader.js";
import { getCatalogueCounts } from "./lib/sku/catalogue.js";

// ── Argument parsing ─────────────────────────────────────────────────────────

type Args = {
  fy?: string;
  all: boolean;
  commit: boolean;
  catalogueOnly: boolean;
  /** Delete the FY's sheets-sourced rows before reloading (RET# backfill). */
  replace: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, commit: false, catalogueOnly: false, replace: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--fy":       args.fy = argv[++i]; break;
      case "--all":      args.all = true; break;
      case "--commit":   args.commit = true; break;
      case "--dry-run":  args.commit = false; break;
      case "--replace":  args.replace = true; break;
      case "--catalogue-only": args.catalogueOnly = true; break;
    }
  }
  return args;
}

// ── Catalogue report ─────────────────────────────────────────────────────────

async function reportCatalogue(): Promise<void> {
  console.log("\n── Catalogue denominator (from item_master + group_map.json) ──");
  const cat = await getCatalogueCounts();
  const specCounts: Record<string, number> = {
    "CP (Chrome-Plated)": 903,
    "PTMT / Faucets": 829,
    "CPVC": 217,
    "Sanitaryware": 206,
    "AGRI": 169,
    "Connection / Waste": 95,
    "Garden Pipe": 63,
    "WATER TANK": 33,
    "CISTERN": 21,
  };
  let derivedMapped = 0;
  for (const [segment, count] of Object.entries(cat.bySegment).sort(([,a],[,b]) => b - a)) {
    const specCount = specCounts[segment];
    const match = specCount == null ? "" : specCount === count ? " ✓" : ` ✗ (spec says ${specCount})`;
    console.log(`  ${segment.padEnd(22)} ${String(count).padStart(5)}${match}`);
    derivedMapped += count;
  }
  console.log(`  ${"Unmapped".padEnd(22)} ${String(cat.unmappedCount).padStart(5)}`);
  console.log(`  ${"─".repeat(30)}`);
  console.log(`  ${"Total (mapped)".padEnd(22)} ${String(derivedMapped).padStart(5)}  (spec: 2,536)`);
  console.log(`  ${"Grand total".padEnd(22)} ${String(cat.totalCodes).padStart(5)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Always show catalogue counts first (acceptance criterion).
  await reportCatalogue();

  if (args.catalogueOnly) {
    await pool.end();
    return;
  }

  const fys = args.all
    ? SUPPORTED_SKU_FYS
    : args.fy
      ? [args.fy]
      : SUPPORTED_SKU_FYS; // default: all supported FYs in dry-run

  const dryRun = !args.commit;
  if (dryRun) {
    console.log("\n⚠  DRY-RUN mode — pass --commit to write to the database.\n");
  } else {
    console.log("\n🔴 COMMIT mode — writing to secondary_sku_line.\n");
  }

  for (const fy of fys) {
    const sheetId = SKU_SHEET_IDS[fy];
    if (!sheetId) {
      console.log(`FY${fy}: no sheet ID configured — skipping.`);
      continue;
    }

    console.log(`\n── FY${fy} ──────────────────────────────────────────`);
    console.log(`   Sheet ID: ${sheetId}`);

    try {
      // --replace (task 172 RET# backfill): carry-forward changes lineUids, so
      // the FY's sheets-sourced rows are swapped atomically inside the loader
      // (delete+insert in one txn, only after all tabs parsed). pscode3_*
      // sourced rows are untouched.
      const result = await loadSecSkuFromSheets(fy, sheetId, dryRun, { replace: args.replace });
      console.log(`   Tabs total:         ${result.tabs}`);
      console.log(`   Tabs with Cat. No.: ${result.tabsWithItemCodes}`);
      console.log(`   Rows parsed:        ${result.rowsParsed.toLocaleString()}`);
      if (dryRun) {
        console.log(`   Rows would insert:  ${result.rowsParsed.toLocaleString()} (dry-run)`);
      } else {
        console.log(`   Rows inserted (new):${result.rowsInserted.toLocaleString()}`);
      }
      console.log(`   Rows with RET#:     ${result.rowsWithRetId.toLocaleString()} (${result.rowsParsed > 0 ? Math.round((result.rowsWithRetId / result.rowsParsed) * 1000) / 10 : 0}%)`);
      if (result.noItemCode > 0) console.log(`   No Cat. No.:        ${result.noItemCode}`);
      if (result.noMonth > 0)    console.log(`   No date/month:      ${result.noMonth}`);
      if (result.skipped > 0)    console.log(`   Skipped (no value): ${result.skipped}`);
    } catch (err) {
      logger.error({ err, fy }, "secondary-sku-backfill: FY failed");
      console.error(`   ERROR: ${String(err)}`);
    }
  }

  console.log("\n── Primary sale_line row counts (acceptance check) ──");
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  for (const fy of ["2024-25", "2025-26", "2026-27"]) {
    const res = await db.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt FROM sale_line_current WHERE fy = ${fy} AND version_status = 'current'
    `).catch(() => null);
    const cnt = res ? parseInt(res.rows[0]?.cnt ?? "0", 10).toLocaleString() : "error";
    const expected = fy === "2024-25" ? "141,201" : fy === "2025-26" ? "144,365" : "38,857+";
    console.log(`  FY${fy}: ${cnt.padStart(10)}  (expected ${expected})`);
  }

  console.log("\n── Secondary sku_line row counts ──");
  const { db: db2 } = await import("@workspace/db");
  for (const fy of SUPPORTED_SKU_FYS) {
    const res = await db2.execute<{ cnt: string }>(sql`
      SELECT COUNT(*)::text AS cnt FROM secondary_sku_line WHERE fy = ${fy}
    `).catch(() => null);
    const cnt = res ? parseInt(res.rows[0]?.cnt ?? "0", 10).toLocaleString() : "0 (table missing)";
    console.log(`  FY${fy}: ${cnt}`);
  }

  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, "secondary-sku-backfill: fatal");
  process.exit(1);
});
