// Seven validators for the secondary-data ingestion pipeline.
// Each returns a SecIngestAssertion. All are pure functions (no DB access).
// Designed to be run in dry-run mode (before any commit) and in live mode.

import type { InsertSecRegLine } from "@workspace/db";
import type { SecIngestAssertion, SecUnmappedReport, SecHeadMonthRow } from "./types.js";
import { isAnomalous } from "./rules.js";
import expectedCountsConfig from "../../../config/secondary_expected_counts.json";

const EXPECTED: Record<string, number | null> = (() => {
  const registers = (expectedCountsConfig as {
    registers: Record<string, number | null>;
  }).registers;
  return Object.fromEntries(
    Object.entries(registers).map(([fy, count]) => [fy, count]),
  );
})();

// ── Validator 1: row_count_fy ─────────────────────────────────────────────────
//
// The parsed row count for each FY must match the recorded expected count.
// When the expected count is null (not yet established), emit a warning
// assertion that passes=false but detail explains no baseline exists yet.
export function assertSecRowCounts(
  fyCounts: Record<string, number>,
): SecIngestAssertion[] {
  const results: SecIngestAssertion[] = [];
  for (const [fy, count] of Object.entries(fyCounts)) {
    const expected = EXPECTED[fy];
    if (expected == null) {
      results.push({
        name: `row_count_${fy}`,
        passed: false,
        detail: `no expected count established yet for FY ${fy} (got ${count}); update secondary_expected_counts.json after first verified ingest`,
      });
    } else {
      results.push({
        name: `row_count_${fy}`,
        passed: count === expected,
        detail: `expected ${expected}, got ${count}`,
      });
    }
  }
  return results;
}

// ── Validator 2: unmapped_heads_empty ─────────────────────────────────────────
//
// Any head/TM name that could not be mapped to a canonical name is an error.
// Unmapped heads cause dropped rows in the by-head cross-foot, breaking sum
// consistency. Add the raw name to head_alias.json or normalize.json to fix.
export function assertSecUnmappedHeadsEmpty(
  unmapped: SecUnmappedReport,
): SecIngestAssertion {
  const count = Object.keys(unmapped.unmapped_heads).length;
  return {
    name: "unmapped_heads_empty",
    passed: count === 0,
    detail:
      count === 0
        ? "none"
        : `${count} unmapped heads: ${JSON.stringify(unmapped.unmapped_heads)}`,
  };
}

// ── Validator 3: unmapped_states_empty ───────────────────────────────────────
//
// Any state that could not be mapped causes inconsistency in regional rollups.
// Add the raw name to the state_map in normalize.json to fix.
export function assertSecUnmappedStatesEmpty(
  unmapped: SecUnmappedReport,
): SecIngestAssertion {
  const count = Object.keys(unmapped.unmapped_states).length;
  return {
    name: "unmapped_states_empty",
    passed: count === 0,
    detail:
      count === 0
        ? "none"
        : `${count} unmapped states: ${JSON.stringify(unmapped.unmapped_states)}`,
  };
}

// ── Validator 4: no_negative_amounts ─────────────────────────────────────────
//
// Negative secondary amounts (returns / credit notes) require manual
// investigation. A negative line in an automated ingest almost certainly
// represents a mis-read cell or a format the parser does not handle.
export function assertSecNoNegativeAmounts(
  lines: Pick<InsertSecRegLine, "amount" | "headCanon" | "monthLabel">[],
): SecIngestAssertion {
  const negatives = lines.filter((l) => Number(l.amount) < 0);
  const samples = negatives
    .slice(0, 3)
    .map((l) => `${l.headCanon ?? "?"}/${l.monthLabel}: ${l.amount}`);
  return {
    name: "no_negative_amounts",
    passed: negatives.length === 0,
    detail:
      negatives.length === 0
        ? "none"
        : `${negatives.length} negative amounts, e.g. ${samples.join("; ")}`,
  };
}

// ── Validator 5: sum_by_head_consistent ───────────────────────────────────────
//
// sum(amount) broken down by headCanon must equal the grand total within ±1
// rupee. Discrepancies indicate dropped rows (unmapped heads with no canon)
// or NaN amounts that slipped through.
export function assertSecSumByHeadConsistent(
  lines: Pick<InsertSecRegLine, "amount" | "headCanon" | "headRaw">[],
): SecIngestAssertion {
  let grand = 0;
  let badAmounts = 0;
  const byHead = new Map<string, number>();
  let droppedHead = 0;

  for (const line of lines) {
    const amt = Number(line.amount);
    if (!Number.isFinite(amt)) { badAmounts++; continue; }
    grand += amt;
    if (line.headCanon) {
      byHead.set(line.headCanon, (byHead.get(line.headCanon) ?? 0) + amt);
    } else if (line.headRaw?.trim()) {
      droppedHead++;
    } else {
      byHead.set("(blank)", (byHead.get("(blank)") ?? 0) + amt);
    }
  }

  const headSum = [...byHead.values()].reduce((a, b) => a + b, 0);
  const delta = Math.abs(headSum - grand);
  const passed = badAmounts === 0 && droppedHead === 0 && delta <= 1;
  const problems: string[] = [];
  if (badAmounts > 0) problems.push(`${badAmounts} non-numeric amounts`);
  if (droppedHead > 0) problems.push(`${droppedHead} rows lost head_canon despite raw value`);
  if (delta > 1) problems.push(`by_head sum off by ${Math.round(delta)} rupees`);

  return {
    name: "sum_by_head_consistent",
    passed,
    detail:
      problems.length > 0
        ? problems.join("; ")
        : `grand=${Math.round(grand)}, by_head=${Math.round(headSum)} (${byHead.size} heads)`,
  };
}

// ── Validator 6: no_anomalous_achievement ─────────────────────────────────────
//
// Months where salesAmount > orderedAmount × 1.5 (and orderedAmount > 0) are
// physically impossible — secondary received cannot exceed 1.5× orders booked.
// These must be flagged and excluded from rankings and YTD.
// The validator fails when ANY anomalous months exist (they require manual
// investigation in the source sheet).
export function assertSecNoAnomalousAchievement(
  rows: Pick<
    SecHeadMonthRow,
    "headCanon" | "monthLabel" | "receivedAmount" | "orderedAmount"
  >[],
): SecIngestAssertion {
  const anomalies = rows.filter((r) =>
    isAnomalous(r.receivedAmount ?? null, r.orderedAmount ?? null),
  );
  const samples = anomalies.slice(0, 3).map((a) => {
    const ratio =
      (a.orderedAmount ?? 0) > 0
        ? ((a.receivedAmount ?? 0) / (a.orderedAmount ?? 1)).toFixed(2)
        : "∞";
    return `${a.headCanon}/${a.monthLabel} ratio=${ratio}`;
  });
  return {
    name: "no_anomalous_achievement",
    passed: anomalies.length === 0,
    detail:
      anomalies.length === 0
        ? "none"
        : `${anomalies.length} anomalous month(s) (salesReceived > ordered×1.5): ${samples.join("; ")}`,
  };
}

// ── Validator 7: all_months_present ──────────────────────────────────────────
//
// For closed fiscal years (every month's last day has passed), all 12 months
// must appear in the data set. A missing month means data was not captured or
// the register is incomplete.
// For the current open FY, only closed months are required.
export function assertSecAllMonthsPresent(
  fy: string,
  monthsFound: Set<number>, // set of monthIdx values (0=Apr..11=Mar) present in data
  nowMs = Date.now(),
): SecIngestAssertion {
  const startYear = Number(fy.slice(0, 4));
  const endYear = startYear + 1;
  // FY is fully closed when March of the second year has elapsed.
  const fyEndMs = Date.UTC(endYear, 3, 0); // last day of March (UTC)
  const fyIsClosed = nowMs > fyEndMs;

  const required: number[] = [];
  for (let idx = 0; idx < 12; idx++) {
    if (fyIsClosed || isMonthClosedInner(idx, fy, nowMs)) {
      required.push(idx);
    }
  }

  const MONTH_LABELS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
  const missing = required.filter((idx) => !monthsFound.has(idx));
  return {
    name: "all_months_present",
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${required.length} required months present`
        : `missing ${missing.length} month(s): ${missing.map((i) => MONTH_LABELS[i]).join(", ")}`,
  };
}

// Internal: same logic as rules.ts isMonthClosed, duplicated to avoid circular
// import between validate.ts and rules.ts.
function isMonthClosedInner(monthIdx: number, fy: string, nowMs: number): boolean {
  const startYear = Number(fy.slice(0, 4));
  const calMonth = (monthIdx + 3) % 12;
  const calYear = monthIdx <= 8 ? startYear : startYear + 1;
  const lastDayMs = Date.UTC(calYear, calMonth + 1, 0);
  return nowMs > lastDayMs;
}

// ── Run all register validators ───────────────────────────────────────────────

export function runSecRegisterValidators(
  lines: InsertSecRegLine[],
  unmapped: SecUnmappedReport,
  fyCounts: Record<string, number>,
  fy: string,
): SecIngestAssertion[] {
  const monthsFound = new Set(
    lines.map((l) => {
      const abbr = l.monthLabel.slice(0, 3);
      const MONTHS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
      return MONTHS.indexOf(abbr);
    }).filter((i) => i >= 0),
  );

  return [
    ...assertSecRowCounts(fyCounts),
    assertSecUnmappedHeadsEmpty(unmapped),
    assertSecUnmappedStatesEmpty(unmapped),
    assertSecNoNegativeAmounts(lines),
    assertSecSumByHeadConsistent(lines),
    assertSecAllMonthsPresent(fy, monthsFound),
    // Validator 6 (no_anomalous_achievement) applies to SecHeadMonthRow, not
    // register lines — it is called separately in the state-head-dashboard path.
  ];
}

// ── Run all state-head-dashboard validators ───────────────────────────────────

export function runSecDashboardValidators(
  rows: SecHeadMonthRow[],
  fy: string,
): SecIngestAssertion[] {
  const monthsFound = new Set(
    rows.map((r) => r.monthIdx).filter((i) => i >= 0),
  );

  // For dashboard source, head/state are pre-normalized by stateDashboard.ts;
  // unmapped reports are not applicable. Run the four relevant validators.
  return [
    assertSecNoAnomalousAchievement(rows),
    assertSecAllMonthsPresent(fy, monthsFound),
    // Validators 2, 3, 4, 5 are not meaningful for aggregated dashboard rows
    // (no raw amounts per register line). Record them as skipped.
    {
      name: "unmapped_heads_empty",
      passed: true,
      detail: "skipped: not applicable to state_head_dashboard source",
    },
    {
      name: "unmapped_states_empty",
      passed: true,
      detail: "skipped: not applicable to state_head_dashboard source",
    },
    {
      name: "no_negative_amounts",
      passed: rows.every((r) => (r.receivedAmount ?? 0) >= 0 && (r.planAmount ?? 0) >= 0),
      detail: rows.every((r) => (r.receivedAmount ?? 0) >= 0 && (r.planAmount ?? 0) >= 0)
        ? "none"
        : "negative plan or received amounts found",
    },
    {
      name: "sum_by_head_consistent",
      passed: true,
      detail: "skipped: not applicable to pre-aggregated state_head_dashboard source",
    },
    {
      name: "row_count_fy",
      passed: true,
      detail: "skipped: expected counts are not defined for state_head_dashboard source",
    },
  ];
}
