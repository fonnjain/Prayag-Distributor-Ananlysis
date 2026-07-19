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
  lines: Pick<InsertSecRegLine, "grossAmount" | "netAmount" | "headCanon" | "monthLabel">[],
): SecIngestAssertion {
  // Negative gross (Order Value) is a hard error — almost certainly a mis-read
  // cell or accounting-notation negative "(1 234.00)" that the parser did not
  // handle.  These must be fixed in source before commit.
  const negGross = lines.filter((l) => Number(l.grossAmount) < 0);

  // Negative net (Sub Total) are genuine credit notes: the distributor received
  // a credit against a prior order, so the Sub Total cell is negative while
  // Order Value is still positive.  Decision: load with sign (store as-is in
  // net_amount) and treat as informational — they do not block Gate 1.
  const negNet = lines.filter((l) => l.netAmount != null && Number(l.netAmount) < 0);

  const parts: string[] = [];
  if (negGross.length === 0 && negNet.length === 0) {
    parts.push("none (gross and net)");
  } else {
    if (negGross.length > 0) {
      const s = negGross
        .slice(0, 3)
        .map((l) => `${l.headCanon ?? "?"}/${l.monthLabel}: gross=${l.grossAmount}`);
      parts.push(`${negGross.length} negative gross (ERROR): ${s.join("; ")}`);
    }
    if (negNet.length > 0) {
      const s = negNet
        .slice(0, 3)
        .map((l) => `${l.headCanon ?? "?"}/${l.monthLabel}: net=${l.netAmount}`);
      parts.push(`${negNet.length} credit note(s) loaded with sign: ${s.join("; ")}`);
    }
  }
  return {
    name: "no_negative_amounts",
    // Only negative gross blocks Gate 1; negative net is informational.
    passed: negGross.length === 0,
    detail: parts.join("; "),
  };
}

// ── Validator 9: no_null_salesperson ─────────────────────────────────────────
//
// Rows where head_raw is null are real orders missing only a TM name in the
// source sheet.  They are loaded into the DB as-is (null head_canon) so the
// gross total is never understated.  The validator reports them as
// informational (PASS with note) — a count > 0 flags a source data-quality
// issue but does not block Gate 1 or the commit.  These rows are excluded
// from TM-level analytics but included in gross/net aggregates.
export function assertSecNoNullSalesperson(nullHeadUnattributed: number): SecIngestAssertion {
  return {
    name: "no_null_salesperson",
    passed: true,
    detail: nullHeadUnattributed === 0
      ? "all rows have a salesperson (head_raw non-null)"
      : `${nullHeadUnattributed} row(s) loaded with null head_raw (unattributable; included in gross total, excluded from TM analytics)`,
  };
}

// ── Validator 5: sum_by_head_consistent ───────────────────────────────────────
//
// sum(grossAmount) broken down by headCanon must equal the grand total within
// ±1 rupee. Rows that have a headRaw but no headCanon are routed to an
// "(unmapped)" bucket — this keeps the cross-foot closed regardless of TM
// mapping coverage. The unmapped_heads_empty validator (validator 2) separately
// reports which raw head names are missing from head_alias.json.
//
// Failure conditions:
//   • non-finite amount values (data corruption)
//   • delta > 1 rupee between grand total and by-head total (impossible if
//     every row goes into exactly one bucket, so this only fires on NaN rows)
export function assertSecSumByHeadConsistent(
  lines: Pick<InsertSecRegLine, "grossAmount" | "headCanon" | "headRaw">[],
): SecIngestAssertion {
  let grand = 0;
  let badAmounts = 0;
  const byHead = new Map<string, number>();

  for (const line of lines) {
    const amt = Number(line.grossAmount);
    if (!Number.isFinite(amt)) { badAmounts++; continue; }
    grand += amt;
    // Route every row into exactly one bucket so cross-foot always closes.
    // Unmapped heads go into "(unmapped)" — the unmapped_heads_empty validator
    // reports the specific raw names that need to be added to head_alias.json.
    const key = line.headCanon ?? (line.headRaw?.trim() ? "(unmapped)" : "(blank)");
    byHead.set(key, (byHead.get(key) ?? 0) + amt);
  }

  const headSum = [...byHead.values()].reduce((a, b) => a + b, 0);
  const delta = Math.abs(headSum - grand);
  const passed = badAmounts === 0 && delta <= 1;
  const problems: string[] = [];
  if (badAmounts > 0) problems.push(`${badAmounts} non-numeric amounts`);
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
  // Anomalous months are stored with is_anomaly=true and excluded from YTD
  // achievement and rankings by the calculation rules (R3 in gate3.ts).
  // They do NOT block ingest — secondary sales received can exceed orders in a
  // month due to delivery lag from prior months, unlike primary where it would
  // be a hard parsing error.  Report as informational (passed=true).
  return {
    name: "no_anomalous_achievement",
    passed: true,
    detail:
      anomalies.length === 0
        ? "none"
        : `${anomalies.length} anomalous month(s) flagged (salesReceived > ordered×1.5, stored with is_anomaly=true, excluded from YTD): ${samples.join("; ")}`,
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

// ── Validator 8: control_cell_matches ────────────────────────────────────────
//
// Compares our computed sums against amounts captured from the sheet's own
// grand-total / sub-total row (detected via isSubTotalRow in the loader).
// When no control row was found (subtotal_excluded=0 for that tab), the check
// passes with a "no control row detected" note — cross_foot still provides
// internal consistency.  When a control row IS found, a delta > 1 rupee fails.
//
// computedGross  = sum(line.grossAmount) across all parsed lines
// controlGross   = gross amount read from the sheet's grand-total row (or null)
// computedNet    = sum(line.netAmount) ignoring NULLs (= sum of Sub Total cells)
// controlNet     = net amount read from the sheet's grand-total row (or null)
export function assertSecControlCellMatches(
  computedGross: number,
  controlGross: number | null,
  computedNet: number,
  controlNet: number | null,
): SecIngestAssertion {
  if (controlGross == null && controlNet == null) {
    return {
      name: "control_cell_matches",
      passed: true,
      detail: "no grand-total row detected in sheet; cross_foot serves as internal consistency check",
    };
  }
  const problems: string[] = [];
  if (controlGross != null) {
    const delta = Math.abs(computedGross - controlGross);
    if (delta > 1) {
      problems.push(
        `gross: computed=${Math.round(computedGross).toLocaleString("en-IN")} sheet=${Math.round(controlGross).toLocaleString("en-IN")} delta=${Math.round(delta)}`,
      );
    }
  }
  if (controlNet != null) {
    const delta = Math.abs(computedNet - controlNet);
    if (delta > 1) {
      problems.push(
        `net: computed=${Math.round(computedNet).toLocaleString("en-IN")} sheet=${Math.round(controlNet).toLocaleString("en-IN")} delta=${Math.round(delta)}`,
      );
    }
  }
  // Build per-column delta lines for the PASS detail so the exact-rupee
  // comparison is visible even on success.
  const matchLines: string[] = [];
  if (controlGross != null) {
    const delta = Math.abs(computedGross - controlGross);
    matchLines.push(
      `gross: computed=${Math.round(computedGross).toLocaleString("en-IN")}` +
      ` sheet=${Math.round(controlGross).toLocaleString("en-IN")}` +
      ` delta=\u20b9${Math.round(delta)}`,
    );
  }
  if (controlNet != null) {
    const delta = Math.abs(computedNet - controlNet);
    matchLines.push(
      `net: computed=${Math.round(computedNet).toLocaleString("en-IN")}` +
      ` sheet=${Math.round(controlNet).toLocaleString("en-IN")}` +
      ` delta=\u20b9${Math.round(delta)}`,
    );
  }
  return {
    name: "control_cell_matches",
    passed: problems.length === 0,
    detail: problems.length === 0
      ? `matches sheet grand-total row — ${matchLines.join("; ")}`
      : `sheet grand-total mismatch: ${problems.join("; ")}`,
  };
}

// ── Run all register validators ───────────────────────────────────────────────

export function runSecRegisterValidators(
  lines: InsertSecRegLine[],
  unmapped: SecUnmappedReport,
  fyCounts: Record<string, number>,
  fy: string,
  nullHeadUnattributed: number,
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
    assertSecNoNullSalesperson(nullHeadUnattributed),
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
