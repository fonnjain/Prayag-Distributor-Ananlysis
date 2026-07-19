// Gate 1 dry-run report builder.
// Gate 1 is the formal pre-commit validation gate for the secondary data
// pipeline. It must be run in dry-run mode (no data committed) and every
// fyGate must be "PASS" before any FY is eligible for --commit.
//
// Invariants enforced here:
//   1. Row accounting:  dataRows + subTotalRowsExcluded + blankRowsSkipped === rowsRead
//   2. All assertions:  every SecIngestAssertion must have passed=true
//   3. Cross-foot:      crossFoot.passed must be true (register sources only)
//   4. No parse errors: errors array must be empty
//
// This file contains only pure functions — no DB access, no I/O.
import { crossFootByHead } from "./rules.js";
import type {
  SecDryRunSummary,
  Gate1DryRunReport,
  Gate1FyReport,
  CrossFootResult,
} from "./types.js";

// ── Per-FY report builder ─────────────────────────────────────────────────────

function buildFyReport(summary: SecDryRunSummary): Gate1FyReport {
  const fyFailReasons: string[] = [];

  // Invariant 1: row accounting identity
  const accountingSum =
    summary.dataRows + summary.subTotalRowsExcluded + summary.blankRowsSkipped;
  const rowAccountingPassed = accountingSum === summary.rowsRead;
  if (!rowAccountingPassed) {
    fyFailReasons.push(
      `row accounting mismatch: dataRows(${summary.dataRows}) + subTotal(${summary.subTotalRowsExcluded}) + blank(${summary.blankRowsSkipped}) = ${accountingSum} != rowsRead(${summary.rowsRead})`,
    );
  }

  // Invariant 2: all assertions passed
  const allAssertionsPassed = summary.assertions.every((a) => a.passed);
  if (!allAssertionsPassed) {
    for (const a of summary.assertions.filter((a) => !a.passed)) {
      fyFailReasons.push(`validator '${a.name}' failed: ${a.detail}`);
    }
  }

  // Invariant 3: cross-foot (register sources only)
  const crossFoot: CrossFootResult | null = summary.crossFoot;
  if (crossFoot != null && !crossFoot.passed) {
    fyFailReasons.push(
      `cross-foot failed: grand=${crossFoot.grandTotal} vs by_head_sum=${crossFoot.byHeadSum} (delta=${crossFoot.deltaRupees} rupees)`,
    );
  }

  // Invariant 4: no parse errors
  if (summary.errors.length > 0) {
    for (const e of summary.errors) {
      fyFailReasons.push(`parse error: ${e}`);
    }
  }

  const fyGate: "PASS" | "FAIL" = fyFailReasons.length === 0 ? "PASS" : "FAIL";

  return {
    fy: summary.fy,
    source: summary.source,
    grain: summary.grain,
    rowsRead: summary.rowsRead,
    dataRows: summary.dataRows,
    subTotalRowsExcluded: summary.subTotalRowsExcluded,
    blankRowsSkipped: summary.blankRowsSkipped,
    rowsToInsert: summary.rowsToInsert,
    existingInDb: summary.existingInDb,
    rowAccountingPassed,
    assertions: summary.assertions,
    allAssertionsPassed,
    crossFoot,
    unmapped: summary.unmapped,
    anomalies: summary.anomalies,
    errors: summary.errors,
    fyGate,
    fyFailReasons,
  };
}

// ── Top-level report builder ───────────────────────────────────────────────────

export function buildGate1Report(
  summaries: SecDryRunSummary[],
): Gate1DryRunReport {
  const fyReports = summaries.map(buildFyReport);

  const failReasons: string[] = [];
  for (const r of fyReports) {
    if (r.fyGate === "FAIL") {
      for (const reason of r.fyFailReasons) {
        failReasons.push(`[FY ${r.fy}] ${reason}`);
      }
    }
  }

  const gate: "PASS" | "FAIL" = failReasons.length === 0 ? "PASS" : "FAIL";

  return {
    generatedAt: new Date().toISOString(),
    mode: "dry_run",
    totalRowsRead: fyReports.reduce((s, r) => s + r.rowsRead, 0),
    totalDataRows: fyReports.reduce((s, r) => s + r.dataRows, 0),
    totalSubTotalRowsExcluded: fyReports.reduce((s, r) => s + r.subTotalRowsExcluded, 0),
    totalBlankRowsSkipped: fyReports.reduce((s, r) => s + r.blankRowsSkipped, 0),
    totalRowsToInsert: fyReports.reduce((s, r) => s + r.rowsToInsert, 0),
    totalExistingInDb: fyReports.reduce((s, r) => s + r.existingInDb, 0),
    fyReports,
    gate,
    failReasons,
  };
}
