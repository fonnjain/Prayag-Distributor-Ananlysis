// Secondary Gate 3 CLI — post-commit calculation verification.
// Usage: pnpm --filter @workspace/api-server run secondary-gate3
//
// Runs all seven secondary calculation rules against the committed DB data and
// prints a PASS/FAIL report.  No data is modified.

import { runGate3 } from "./lib/secondary/gate3Runner.js";

const RULE_LABELS: Record<string, string> = {
  R1: "R1  achievement_recomputed    ",
  R2: "R2  ytd_closed_months_only    ",
  R3: "R3  anomaly_flag_consistent   ",
  R4: "R4  territory_split_populated ",
  R5: "R5  grand_total_cross_foot    ",
  R6: "R6  complete_months_yoy       ",
  R7: "R7  no_double_count_guard     ",
};

async function main(): Promise<void> {
  console.log("\n=== Secondary Gate 3: Calculation Verification ===\n");
  const report = await runGate3();

  for (const check of report.checks) {
    const label = RULE_LABELS[check.rule] ?? check.rule.padEnd(32);
    const status = check.passed ? "[PASS]" : "[FAIL]";
    console.log(`  ${status} ${label}${check.detail}`);
  }

  console.log(`\n  Overall: ${report.gate}`);
  if (report.gate === "FAIL") {
    console.log("\n  Fail reasons:");
    for (const r of report.failReasons) console.log(`    - ${r}`);
    process.exit(1);
  } else {
    console.log(`  Generated: ${report.generatedAt}\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Gate 3 error:", err);
  process.exit(1);
});
