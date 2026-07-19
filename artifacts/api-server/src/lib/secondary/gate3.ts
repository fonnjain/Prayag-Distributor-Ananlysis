// Gate 3: post-commit calculation verification for the secondary data pipeline.
// Pure functions — no DB access, no I/O.
// Each check exercises one of the seven calculation rules in rules.ts against
// pre-fetched (aggregated) DB data supplied by gate3Runner.ts.
//
// Run order: Gate 1 (pre-commit dry-run) → commit → Gate 2 (row-count + gross
// baseline) → Gate 3 (calculation rules on committed data).

import { isAnomalous, computeAchievement, completeMonthsForYoY } from "./rules.js";

// ── Output types ──────────────────────────────────────────────────────────────

export type Gate3Check = {
  rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";
  name: string;
  passed: boolean;
  detail: string;
};

export type Gate3Report = {
  generatedAt: string;
  checks: Gate3Check[];
  gate: "PASS" | "FAIL";
  failReasons: string[];
};

// ── Input shapes (aggregated; never raw row dumps) ────────────────────────────

// R1 / R2 / R3: rows from secondary_head_month
export type HeadMonthRow = {
  fy: string;
  headCanon: string;
  monthLabel: string;
  monthIdx: number;
  planAmount: number | null;
  orderedAmount: number | null;
  receivedAmount: number | null;
  storedAchievementPct: number | null; // achievement_pct as stored in DB
  isAnomaly: boolean;
  notYetRecorded: boolean;
};

// R4: is_territory population per FY
export type FyTerritoryStats = {
  fy: string;
  nullCount: number;
  territoryCount: number;
  nonTerritoryCount: number;
};

// R5: cross-foot inputs — grand total + per-head subtotals per FY
export type FyHeadGross = {
  fy: string;
  grandTotal: number;
  headTotals: Array<{ headBucket: string; gross: number }>;
};

// R6: which monthIdx values are present in the DB for each FY
export type FyMonthData = {
  fy: string;
  monthIdxsPresent: number[];
};

// R7: source-column distribution across all secondary_register_line rows
export type SourceCount = { source: string; count: number };

// ── R1: achievement_recomputed ─────────────────────────────────────────────────
//
// achievement_pct stored in secondary_head_month must equal
// received_amount / plan_amount (not ordered_amount / plan_amount).
// Tolerance: ±0.0001 (four decimal places) to absorb floating-point rounding.
export function checkR1AchievementRecomputed(rows: HeadMonthRow[]): Gate3Check {
  if (rows.length === 0) {
    return {
      rule: "R1",
      name: "achievement_recomputed",
      passed: true,
      detail: "secondary_head_month is empty — no rows to verify; rule exercised once rows are upserted from Sheets sync",
    };
  }

  const testable = rows.filter(
    (r) =>
      r.planAmount != null &&
      r.planAmount > 0 &&
      r.receivedAmount != null &&
      r.storedAchievementPct != null,
  );

  let mismatches = 0;
  const samples: string[] = [];
  for (const r of testable) {
    const expected = computeAchievement(r.receivedAmount, r.planAmount);
    if (expected == null) continue;
    const delta = Math.abs(expected - r.storedAchievementPct!);
    if (delta > 0.0001) {
      mismatches++;
      if (samples.length < 3) {
        samples.push(
          `${r.fy}/${r.headCanon}/${r.monthLabel}: stored=${r.storedAchievementPct?.toFixed(4)} expected=${expected.toFixed(4)}`,
        );
      }
    }
  }

  const passed = mismatches === 0;
  return {
    rule: "R1",
    name: "achievement_recomputed",
    passed,
    detail: passed
      ? `${testable.length} rows verified: achievement_pct = received / plan (not ordered / plan)`
      : `${mismatches} mismatch(es) in ${testable.length} testable rows: ${samples.join("; ")}`,
  };
}

// ── R2: ytd_closed_months_only ─────────────────────────────────────────────────
//
// Rows with not_yet_recorded=true must have received_amount = null.
// Storing a non-null received figure for a not-yet-recorded month would cause
// premature 0% (or negative) achievement to appear in YTD sums.
export function checkR2YtdClosedMonthsOnly(rows: HeadMonthRow[]): Gate3Check {
  if (rows.length === 0) {
    return {
      rule: "R2",
      name: "ytd_closed_months_only",
      passed: true,
      detail: "secondary_head_month is empty — no rows to verify",
    };
  }

  const violations = rows.filter((r) => r.notYetRecorded && r.receivedAmount != null);
  const passed = violations.length === 0;
  const samples = violations.slice(0, 3).map(
    (r) => `${r.fy}/${r.headCanon}/${r.monthLabel} received=${r.receivedAmount}`,
  );
  return {
    rule: "R2",
    name: "ytd_closed_months_only",
    passed,
    detail: passed
      ? `${rows.filter((r) => r.notYetRecorded).length} not_yet_recorded rows all have null received_amount`
      : `${violations.length} row(s) where not_yet_recorded=true but received_amount is non-null: ${samples.join("; ")}`,
  };
}

// ── R3: anomaly_flag_consistent ────────────────────────────────────────────────
//
// is_anomaly in every row must match isAnomalous(received_amount, ordered_amount).
// A mismatch means a sync wrote stale or manually overridden flags that disagree
// with the rule definition.
export function checkR3AnomalyFlagConsistent(rows: HeadMonthRow[]): Gate3Check {
  if (rows.length === 0) {
    return {
      rule: "R3",
      name: "anomaly_flag_consistent",
      passed: true,
      detail: "secondary_head_month is empty — no rows to verify",
    };
  }

  let mismatches = 0;
  const samples: string[] = [];
  for (const r of rows) {
    const expected = isAnomalous(r.receivedAmount ?? null, r.orderedAmount ?? null);
    if (expected !== r.isAnomaly) {
      mismatches++;
      if (samples.length < 3) {
        const ratio =
          (r.orderedAmount ?? 0) > 0
            ? ((r.receivedAmount ?? 0) / r.orderedAmount!).toFixed(2)
            : "n/a";
        samples.push(
          `${r.fy}/${r.headCanon}/${r.monthLabel}: stored=${r.isAnomaly} expected=${expected} ratio=${ratio}`,
        );
      }
    }
  }

  const passed = mismatches === 0;
  return {
    rule: "R3",
    name: "anomaly_flag_consistent",
    passed,
    detail: passed
      ? `${rows.length} rows: is_anomaly consistent with isAnomalous() rule`
      : `${mismatches} mismatch(es): ${samples.join("; ")}`,
  };
}

// ── R4: territory_split_populated ─────────────────────────────────────────────
//
// is_territory must never be NULL (every line must be classified before commit).
// A NULL means the normalizer failed to set the flag — the line is unclassified
// and will be silently omitted from territory-only aggregates.
//
// Note: FYs with subtotal grain (FY2023-24, FY2024-25) may have all rows
// classified as non-territory because the original pre-aggregated sheet did
// not carry individual-customer territory markers. This is documented and
// expected — those FYs contribute only to gross totals, not to is_territory
// splits.
export function checkR4TerritorySplitPopulated(stats: FyTerritoryStats[]): Gate3Check {
  const nullFys = stats.filter((s) => s.nullCount > 0);
  const zeroTerritoryFys = stats
    .filter((s) => s.nullCount === 0 && s.territoryCount === 0)
    .map((s) => s.fy);

  const passed = nullFys.length === 0;
  const nullDetail = nullFys.map(
    (s) => `${s.fy}: ${s.nullCount} null rows`,
  );
  const splitLines = stats.map(
    (s) =>
      `${s.fy}: territory=${s.territoryCount} non-territory=${s.nonTerritoryCount}` +
      (s.nullCount > 0 ? ` null=${s.nullCount}` : ""),
  );
  const noteLines: string[] = [];
  if (zeroTerritoryFys.length > 0) {
    noteLines.push(`${zeroTerritoryFys.join(", ")}: 0 territory rows (expected for subtotal-grain FYs)`);
  }
  return {
    rule: "R4",
    name: "territory_split_populated",
    passed,
    detail: [
      passed ? "is_territory not null in all rows" : `null is_territory in: ${nullDetail.join("; ")}`,
      ...splitLines,
      ...noteLines,
    ].join(" | "),
  };
}

// ── R5: grand_total_cross_foot ─────────────────────────────────────────────────
//
// sum(gross_amount) by head_canon must equal the per-FY grand total within
// ±1 rupee. The runner buckets rows with null head_canon into "(blank)" and
// rows with a raw but unmapped head into "(unmapped)" so the cross-foot is
// always closed regardless of TM mapping coverage.
export function checkR5CrossFootByHead(fyData: FyHeadGross[]): Gate3Check {
  const failures: string[] = [];
  const lines: string[] = [];

  for (const { fy, grandTotal, headTotals } of fyData) {
    const byHeadSum = headTotals.reduce((s, h) => s + h.gross, 0);
    const delta = Math.abs(Math.round(byHeadSum) - Math.round(grandTotal));
    lines.push(`${fy}: grand=${Math.round(grandTotal).toLocaleString("en-IN")} by_head=${Math.round(byHeadSum).toLocaleString("en-IN")} Δ=${delta}`);
    if (delta > 1) {
      failures.push(`${fy} delta=${delta} rupees`);
    }
  }

  const passed = failures.length === 0;
  return {
    rule: "R5",
    name: "grand_total_cross_foot",
    passed,
    detail: passed
      ? lines.join(" | ")
      : `cross-foot failed: ${failures.join("; ")} | ${lines.join(" | ")}`,
  };
}

// ── R6: complete_months_yoy ────────────────────────────────────────────────────
//
// For any YoY pair (fyA, fyB), completeMonthsForYoY() returns the month indices
// that are eligible for comparison. Both FYs must have those months present in
// the DB. For fully closed FYs, all 12 months must be present in both.
// We test the three most-recent adjacent pairs.
export function checkR6CompleteMonthsYoY(fyMonths: FyMonthData[], nowMs = Date.now()): Gate3Check {
  // Build a lookup: fy → Set of present monthIdx
  const lookup = new Map<string, Set<number>>(
    fyMonths.map((d) => [d.fy, new Set(d.monthIdxsPresent)]),
  );

  // Test adjacent pairs in the dataset, most-recent first
  const fys = fyMonths.map((d) => d.fy).sort();
  const pairs: Array<[string, string]> = [];
  for (let i = 1; i < fys.length; i++) {
    pairs.push([fys[i - 1], fys[i]]);
  }

  const failures: string[] = [];
  const lines: string[] = [];

  for (const [fyA, fyB] of pairs) {
    const required = completeMonthsForYoY(fyA, fyB, nowMs);
    const setA = lookup.get(fyA) ?? new Set();
    const setB = lookup.get(fyB) ?? new Set();
    const missingA = required.filter((i) => !setA.has(i));
    const missingB = required.filter((i) => !setB.has(i));
    const LABELS = ["Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar"];
    if (missingA.length > 0 || missingB.length > 0) {
      const msgs: string[] = [];
      if (missingA.length > 0) msgs.push(`${fyA} missing ${missingA.map((i) => LABELS[i]).join(",")}`);
      if (missingB.length > 0) msgs.push(`${fyB} missing ${missingB.map((i) => LABELS[i]).join(",")}`);
      failures.push(`${fyA}↔${fyB}: ${msgs.join("; ")}`);
    }
    lines.push(`${fyA}↔${fyB}: ${required.length} complete months`);
  }

  const passed = failures.length === 0;
  return {
    rule: "R6",
    name: "complete_months_yoy",
    passed,
    detail: passed
      ? lines.join(" | ")
      : `missing months for YoY: ${failures.join("; ")} | ${lines.join(" | ")}`,
  };
}

// ── R7: no_double_count_guard ──────────────────────────────────────────────────
//
// All rows in secondary_register_line must carry a secondary-layer source tag
// ('sheets' or 'xlsx_backfill'). A row tagged 'primary' would mean primary
// sale_line data was inserted into the secondary table — a data-integrity
// violation that would inflate secondary totals and cause double-counting.
export function checkR7NoDoubleCount(sources: SourceCount[]): Gate3Check {
  const VALID = new Set(["sheets", "xlsx_backfill"]);
  const invalid = sources.filter((s) => !VALID.has(s.source));
  const totalRows = sources.reduce((s, r) => s + r.count, 0);
  const passed = invalid.length === 0;
  return {
    rule: "R7",
    name: "no_double_count_guard",
    passed,
    detail: passed
      ? `all ${totalRows.toLocaleString("en-IN")} rows have valid secondary-layer source tags: ${sources.map((s) => `${s.source}=${s.count}`).join(", ")}`
      : `invalid source tags detected (would cause primary+secondary double-count): ${invalid.map((s) => `${s.source}=${s.count}`).join(", ")}`,
  };
}

// ── Report builder ─────────────────────────────────────────────────────────────

export function buildGate3Report(checks: Gate3Check[]): Gate3Report {
  const failReasons = checks
    .filter((c) => !c.passed)
    .map((c) => `[${c.rule}] ${c.name}: ${c.detail}`);
  return {
    generatedAt: new Date().toISOString(),
    checks,
    gate: failReasons.length === 0 ? "PASS" : "FAIL",
    failReasons,
  };
}
