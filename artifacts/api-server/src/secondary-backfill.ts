// Secondary data backfill CLI.
// Loads secondary sale registers and/or State Head Dashboards for the given
// fiscal years. Runs fully in dry-run mode by default — nothing is written
// to the database unless --commit is explicitly passed.
//
// Usage:
//   pnpm --filter @workspace/api-server run secondary-backfill -- --dry-run
//   pnpm --filter @workspace/api-server run secondary-backfill -- --fy 2023-24 --file <path.xlsx> --dry-run
//   pnpm --filter @workspace/api-server run secondary-backfill -- --fy 2025-26 --source state-head-dashboard --dry-run
//   pnpm --filter @workspace/api-server run secondary-backfill -- --gate1-report ./gate1.json
//   pnpm --filter @workspace/api-server run secondary-backfill -- --fy 2025-26 --source state-head-dashboard --commit
//
// Dry-run (the default when --commit is absent) runs the full parse + all
// seven validators and prints a report, but writes NOTHING to the database.
//
// Gate 1 report:
//   --gate1-report <path>  Implies --dry-run. Runs all configured FYs, then
//   writes a Gate1DryRunReport JSON file to <path>. Every fyGate must be PASS
//   before any FY is eligible for --commit.
import { writeFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger.js";
import { loadSecRegisterFromXlsx, loadSecRegisterFromSheets } from "./lib/secondary/loader.js";
import { loadAndPersistStateDashboard } from "./lib/secondary/stateHeadLoader.js";
import { buildGate1Report } from "./lib/secondary/gate1.js";
import type { SecDryRunSummary, SecIngestAssertion, Gate1DryRunReport } from "./lib/secondary/types.js";

// All FYs this pipeline covers.
const ALL_REGISTER_FYS = ["2021-22", "2022-23", "2023-24", "2024-25"];
const ALL_DASHBOARD_FYS = ["2025-26", "2026-27"];

// ── Argument parsing ─────────────────────────────────────────────────────────

type SourceFlag = "register" | "state-head-dashboard" | "all";

type Args = {
  fy?: string;
  file?: string;
  source: SourceFlag;
  dryRun: boolean;
  gate1ReportPath?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { source: "all", dryRun: true }; // dry-run by default
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--":
        break;
      case "--fy":
        args.fy = argv[++i];
        break;
      case "--file":
        args.file = argv[++i];
        break;
      case "--source":
        args.source = argv[++i] as SourceFlag;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--commit":
        args.dryRun = false;
        break;
      case "--gate1-report":
        args.gate1ReportPath = argv[++i];
        args.dryRun = true; // Gate 1 always implies dry-run
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!["register", "state-head-dashboard", "all"].includes(args.source)) {
    throw new Error(
      `--source must be one of: register, state-head-dashboard, all (got: ${args.source})`,
    );
  }
  if (args.file && !args.fy) {
    throw new Error("--file requires --fy to identify the fiscal year");
  }
  return args;
}

// ── Pretty-print helpers ──────────────────────────────────────────────────────

function passLabel(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

function printSummary(summary: SecDryRunSummary, prefix = ""): void {
  const p = prefix ? `${prefix} ` : "";
  console.log(
    `\n${p}FY ${summary.fy}  source=${summary.source}  grain=${summary.grain}`,
  );

  // Row accounting
  console.log(
    `  rows_read=${summary.rowsRead}` +
    `  data=${summary.dataRows}` +
    `  subtotal_excluded=${summary.subTotalRowsExcluded}` +
    `  blank_skipped=${summary.blankRowsSkipped}`,
  );
  console.log(
    `  rows_to_insert=${summary.rowsToInsert}  already_in_db=${summary.existingInDb}`,
  );

  // Row accounting identity check
  const accountingSum =
    summary.dataRows + summary.subTotalRowsExcluded + summary.blankRowsSkipped;
  if (accountingSum !== summary.rowsRead) {
    console.log(
      `  [FAIL] row accounting: ${summary.dataRows} + ${summary.subTotalRowsExcluded} + ${summary.blankRowsSkipped} = ${accountingSum} != ${summary.rowsRead}`,
    );
  } else {
    console.log(`  [PASS] row accounting (${accountingSum} = ${summary.rowsRead})`);
  }

  // Cross-foot
  if (summary.crossFoot != null) {
    const cf = summary.crossFoot;
    console.log(
      `  [${passLabel(cf.passed)}] cross_foot: grand=${cf.grandTotal.toLocaleString("en-IN")}  by_head=${cf.byHeadSum.toLocaleString("en-IN")}  delta=${cf.deltaRupees} rupees  heads=${cf.headCount}`,
    );
  }

  // Parse errors
  if (summary.errors.length > 0) {
    console.log("  ERRORS:");
    for (const e of summary.errors) console.log(`    ! ${e}`);
  }

  // Validators
  console.log("  Validators:");
  for (const a of summary.assertions) {
    console.log(`    [${passLabel(a.passed)}] ${a.name}: ${a.detail}`);
  }

  // Anomalies
  if (summary.anomalies.length > 0) {
    console.log(`  Anomalies (${summary.anomalies.length}):`);
    for (const a of summary.anomalies.slice(0, 10)) {
      console.log(
        `    ${a.head}/${a.monthLabel}  sales=${a.salesAmount.toLocaleString("en-IN")}  ordered=${a.orderedAmount.toLocaleString("en-IN")}  ratio=${a.ratio.toFixed(2)}`,
      );
    }
    if (summary.anomalies.length > 10) {
      console.log(`    ... and ${summary.anomalies.length - 10} more`);
    }
  }

  // Unmapped
  const unmappedHeads = Object.keys(summary.unmapped.unmapped_heads).length;
  const unmappedStates = Object.keys(summary.unmapped.unmapped_states).length;
  if (unmappedHeads + unmappedStates > 0) {
    console.log(`  Unmapped: ${unmappedHeads} heads, ${unmappedStates} states`);
    if (unmappedHeads > 0) {
      console.log(`    heads: ${JSON.stringify(summary.unmapped.unmapped_heads)}`);
    }
    if (unmappedStates > 0) {
      console.log(`    states: ${JSON.stringify(summary.unmapped.unmapped_states)}`);
    }
  }
}

function printGate1Summary(report: Gate1DryRunReport): void {
  console.log("\n" + "=".repeat(70));
  console.log("  GATE 1 DRY-RUN REPORT");
  console.log(`  Generated: ${report.generatedAt}`);
  console.log("=".repeat(70));
  console.log(
    `  Total FYs: ${report.fyReports.length} | rows_read=${report.totalRowsRead}` +
    ` | data=${report.totalDataRows}` +
    ` | subtotal_excluded=${report.totalSubTotalRowsExcluded}` +
    ` | blank_skipped=${report.totalBlankRowsSkipped}`,
  );
  console.log(
    `  to_insert=${report.totalRowsToInsert} | already_in_db=${report.totalExistingInDb}`,
  );
  console.log();
  for (const r of report.fyReports) {
    const line =
      `  [${r.fyGate}] FY ${r.fy}  grain=${r.grain}  data=${r.dataRows}` +
      (r.subTotalRowsExcluded > 0 ? `  subtotal_excluded=${r.subTotalRowsExcluded}` : "") +
      (r.crossFoot != null ? `  cross_foot=${r.crossFoot.passed ? "PASS" : "FAIL"}` : "");
    console.log(line);
    if (r.fyGate === "FAIL") {
      for (const reason of r.fyFailReasons) {
        console.log(`    ! ${reason}`);
      }
    }
  }
  console.log();
  console.log(`  Overall gate: ${report.gate}`);
  if (report.gate === "FAIL") {
    console.log("  Fail reasons:");
    for (const reason of report.failReasons) {
      console.log(`    ! ${reason}`);
    }
  } else {
    console.log("  All FYs passed. Ready for --commit (after DB migration if not yet run).");
  }
  console.log("=".repeat(70));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const isGate1 = !!args.gate1ReportPath;

  console.log("=".repeat(70));
  console.log("  Prayag Secondary Data Backfill");
  console.log(
    `  Mode: ${args.dryRun ? "DRY RUN (no data committed)" : "COMMIT (will write to DB)"}`,
  );
  if (isGate1) console.log(`  Gate 1 report: ${args.gate1ReportPath}`);
  console.log(`  Source: ${args.source}`);
  if (args.fy) console.log(`  FY filter: ${args.fy}`);
  if (args.file) console.log(`  File: ${args.file}`);
  console.log("=".repeat(70));

  const summaries: SecDryRunSummary[] = [];
  let anyFailed = false;

  // ── Register path ──────────────────────────────────────────────────────────
  if (args.source === "register" || args.source === "all") {
    const targetFys = args.fy ? [args.fy] : ALL_REGISTER_FYS;

    for (const fy of targetFys) {
      try {
        let summary: SecDryRunSummary;
        if (args.file) {
          summary = await loadSecRegisterFromXlsx(args.file, fy, args.dryRun);
        } else {
          summary = await loadSecRegisterFromSheets(fy, args.dryRun);
        }
        summaries.push(summary);
        if (summary.assertions.some((a) => !a.passed)) anyFailed = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error({ fy, error: msg }, "sec-backfill: register error");
        anyFailed = true;
        summaries.push({
          fy,
          source: "register_sheets",
          grain: "line",
          rowsRead: 0,
          dataRows: 0,
          subTotalRowsExcluded: 0,
          blankRowsSkipped: 0,
          rowsToInsert: 0,
          existingInDb: 0,
          crossFoot: null,
          assertions: [{ name: "loader_error", passed: false, detail: msg }],
          unmapped: { unmapped_heads: {}, unmapped_states: {}, unmapped_brands: {} },
          anomalies: [],
          errors: [msg],
        });
      }
    }
  }

  // ── State Head Dashboard path ──────────────────────────────────────────────
  if (args.source === "state-head-dashboard" || args.source === "all") {
    const targetFys = args.fy ? [args.fy] : ALL_DASHBOARD_FYS;

    for (const fy of targetFys) {
      try {
        const summary = await loadAndPersistStateDashboard(fy, args.dryRun);
        summaries.push(summary);
        if (summary.assertions.some((a) => !a.passed)) anyFailed = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error({ fy, error: msg }, "sec-backfill: dashboard error");
        anyFailed = true;
        summaries.push({
          fy,
          source: "state_head_dashboard",
          grain: "line",
          rowsRead: 0,
          dataRows: 0,
          subTotalRowsExcluded: 0,
          blankRowsSkipped: 0,
          rowsToInsert: 0,
          existingInDb: 0,
          crossFoot: null,
          assertions: [{ name: "loader_error", passed: false, detail: msg }],
          unmapped: { unmapped_heads: {}, unmapped_states: {}, unmapped_brands: {} },
          anomalies: [],
          errors: [msg],
        });
      }
    }
  }

  // ── Print per-FY report ────────────────────────────────────────────────────
  console.log("\n" + "-".repeat(70));
  console.log("  VALIDATION REPORT");
  console.log("-".repeat(70));
  for (const s of summaries) {
    printSummary(s);
  }

  // ── Gate 1 report ──────────────────────────────────────────────────────────
  if (isGate1) {
    const gate1 = buildGate1Report(summaries);
    printGate1Summary(gate1);
    try {
      writeFileSync(args.gate1ReportPath!, JSON.stringify(gate1, null, 2), "utf8");
      console.log(`\nGate 1 report written to: ${args.gate1ReportPath}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to write Gate 1 report: ${msg}`);
    }
    await pool.end();
    process.exit(gate1.gate === "PASS" ? 0 : 1);
  }

  // ── Overall summary ────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  const totalRead = summaries.reduce((s, r) => s + r.rowsRead, 0);
  const totalInsert = summaries.reduce((s, r) => s + r.rowsToInsert, 0);
  const totalExisting = summaries.reduce((s, r) => s + r.existingInDb, 0);
  const totalSubTotal = summaries.reduce((s, r) => s + r.subTotalRowsExcluded, 0);
  console.log(
    `  TOTAL: ${summaries.length} FY(s)` +
    ` | rows_read=${totalRead}` +
    ` | to_insert=${totalInsert}` +
    ` | already_in_db=${totalExisting}` +
    (totalSubTotal > 0 ? ` | subtotal_excluded=${totalSubTotal}` : ""),
  );
  console.log(`  Overall: ${anyFailed ? "FAIL — one or more validators failed" : "PASS"}`);
  if (args.dryRun) {
    console.log("  [DRY RUN] Nothing was committed. Pass --commit to write data.");
  }
  console.log("=".repeat(70));

  await pool.end();
  process.exit(anyFailed ? 1 : 0);
}

main().catch((e) => {
  logger.error({ error: e instanceof Error ? e.message : String(e) }, "sec-backfill: fatal");
  console.error("Fatal error:", e);
  process.exit(1);
});
