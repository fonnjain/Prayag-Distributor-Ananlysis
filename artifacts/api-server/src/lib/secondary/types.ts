// Shared types for the secondary-data layer.
// Secondary = distributor -> retailer (order booking + sales received).
// PRIMARY = Prayag -> distributor.  The two must NEVER be summed together.

export type CellValue = string | number | boolean | Date | null | undefined;

// ── Grain ─────────────────────────────────────────────────────────────────────
//
// "line"     — register rows are individual customer-level invoice lines
//              (FY2021-22, FY2022-23, FY2024-25).
// "subtotal" — register rows are head/month/brand sub-total aggregates, not
//              individual customer lines (FY2023-24). The loader detects and
//              excludes any intermediate sub-total marker rows before parsing.
//              uid key: fy|monthLabel|headRaw|stateRaw|(null customer)|brandRaw|amount|occurrence.
export type SecGrain = "line" | "subtotal";

// ── Column map ────────────────────────────────────────────────────────────────

// Column indices discovered by header-scanning a secondary register sheet.
// -1 means the column was not found in this file.
export type SecColMap = {
  headerRowNumber: number;
  grain: SecGrain;   // data grain for this FY — passed through from config
  head: number;      // Team Member column (-1 when not found)
  state: number;
  customer: number;
  brand: number;
  month: number;
  fy: number;
  grossAmount: number;  // Order Value column (before discount)
  netAmount: number;    // Sub Total column (-1 when not found; computed from discount as fallback)
  discount: number;     // Discount % column (may be blank on continuation rows)
  qty: number;
};

// ── Unmapped report ───────────────────────────────────────────────────────────

export type SecUnmappedReport = {
  unmapped_heads: Record<string, number>;   // raw head -> occurrence count
  unmapped_states: Record<string, number>;
  unmapped_brands: Record<string, number>;  // brands that had no alias mapping
};

export function emptySecUnmapped(): SecUnmappedReport {
  return {
    unmapped_heads: {},
    unmapped_states: {},
    unmapped_brands: {},
  };
}

export function bumpSecUnmapped(
  report: SecUnmappedReport,
  field: keyof SecUnmappedReport,
  raw: string,
): void {
  report[field][raw] = (report[field][raw] ?? 0) + 1;
}

// ── Assertion ─────────────────────────────────────────────────────────────────

export type SecIngestAssertion = {
  name: string;
  passed: boolean;
  detail: string;
};

// ── Cross-foot result ─────────────────────────────────────────────────────────
//
// Moved here (from rules.ts) so Gate1FyReport can reference it without
// creating a circular import chain (rules.ts already imports from types.ts).
export type CrossFootResult = {
  passed: boolean;
  grandTotal: number;
  byHeadSum: number;
  deltaRupees: number;
  headCount: number;
};

// ── Dry-run summary ───────────────────────────────────────────────────────────

export type SecDryRunSummary = {
  fy: string;
  source: "register_xlsx" | "register_sheets" | "state_head_dashboard";
  grain: SecGrain;
  // Row accounting — these four fields must satisfy:
  //   dataRows + subTotalRowsExcluded + blankRowsSkipped == rowsRead
  rowsRead: number;
  dataRows: number;              // rows that parsed as valid data lines
  subTotalRowsExcluded: number;  // rows detected as sub-total markers and skipped
  blankRowsSkipped: number;      // rows with no amount / header repeats / blanks
  rowsToInsert: number;          // dataRows after dedup against DB
  existingInDb: number;          // count already present (would be skipped on insert)
  crossFoot: CrossFootResult | null;  // null for state_head_dashboard source
  assertions: SecIngestAssertion[];
  unmapped: SecUnmappedReport;
  anomalies: AnomalySummary[];
  errors: string[];
};

export type AnomalySummary = {
  head: string;
  monthLabel: string;
  salesAmount: number;
  orderedAmount: number;
  ratio: number;
};

// ── Parsed register row ───────────────────────────────────────────────────────

// Normalised row ready for uid generation and DB insert.
export type SecParsedRow = {
  fy: string;
  monthLabel: string;
  headRaw: string | null;
  stateRaw: string | null;
  customer: string | null;       // null for sub-total grain FYs
  brandRaw: string | null;
  grossAmount: number;           // Order Value before discount
  netAmount: number | null;      // grossAmount × (1 - discountPct/100); filled by loader after carry
  discountPct: number | null;    // as parsed from cell (null when blank); loader carries across order rows
  qty: number | null;
};

// ── State Head Dashboard month row ────────────────────────────────────────────

// One month of aggregated data for one team member, ready for DB upsert.
export type SecHeadMonthRow = {
  fy: string;
  headRaw: string | null;
  headCanon: string;
  stateHead: string | null;
  monthLabel: string;
  monthIdx: number;
  planAmount: number | null;
  orderedAmount: number | null;
  receivedAmount: number | null;
  achievementPct: number | null;
  isAnomaly: boolean;
  notYetRecorded: boolean;
  sourceSheetId: string | null;
};

// ── Gate 1 dry-run report ─────────────────────────────────────────────────────
//
// The Gate 1 report is the formal pre-commit validation gate. It must be
// produced in dry-run mode (no data committed) and all fyGate values must be
// "PASS" before any FY is eligible for --commit.
//
// Row accounting identity (must hold for every Gate1FyReport):
//   dataRows + subTotalRowsExcluded + blankRowsSkipped === rowsRead

export type Gate1FyReport = {
  fy: string;
  source: SecDryRunSummary["source"];
  grain: SecGrain;

  // Row accounting
  rowsRead: number;
  dataRows: number;
  subTotalRowsExcluded: number;
  blankRowsSkipped: number;
  rowsToInsert: number;
  existingInDb: number;
  // rowAccountingPassed: dataRows + subTotalRowsExcluded + blankRowsSkipped === rowsRead
  rowAccountingPassed: boolean;

  // All seven validators
  assertions: SecIngestAssertion[];
  allAssertionsPassed: boolean;

  // Grand-total cross-foot (null for state_head_dashboard source, which is
  // pre-aggregated and has no raw lines to cross-foot against)
  crossFoot: CrossFootResult | null;

  // Unmapped heads/states (empty for state_head_dashboard source)
  unmapped: SecUnmappedReport;

  // Anomalous months (only populated for state_head_dashboard source)
  anomalies: AnomalySummary[];

  // Parse / loader errors (non-validator)
  errors: string[];

  // Per-FY gate decision
  fyGate: "PASS" | "FAIL";
  fyFailReasons: string[];
};

export type Gate1DryRunReport = {
  // ISO-8601 timestamp — when the dry run was executed
  generatedAt: string;
  // Always "dry_run" — Gate 1 must never commit data
  mode: "dry_run";

  // Aggregates across all FYs
  totalRowsRead: number;
  totalDataRows: number;
  totalSubTotalRowsExcluded: number;
  totalBlankRowsSkipped: number;
  totalRowsToInsert: number;
  totalExistingInDb: number;

  // Per-FY breakdown
  fyReports: Gate1FyReport[];

  // Overall gate decision
  gate: "PASS" | "FAIL";
  // Human-readable reasons for FAIL (one entry per failing FY/check)
  failReasons: string[];
};
