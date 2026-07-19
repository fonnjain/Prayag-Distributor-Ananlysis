// Shared types for the secondary-data layer.
// Secondary = distributor → retailer (order booking + sales received).
// PRIMARY = Prayag → distributor.  The two must NEVER be summed together.

export type CellValue = string | number | boolean | Date | null | undefined;

// ── Column map ────────────────────────────────────────────────────────────────

// Column indices discovered by header-scanning a secondary register sheet.
// -1 means the column was not found in this file.
export type SecColMap = {
  headerRowNumber: number;
  head: number;
  state: number;
  customer: number;
  brand: number;
  month: number;
  fy: number;
  amount: number;
  qty: number;
};

// ── Unmapped report ───────────────────────────────────────────────────────────

export type SecUnmappedReport = {
  unmapped_heads: Record<string, number>;   // raw head → occurrence count
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

// ── Dry-run summary ───────────────────────────────────────────────────────────

export type SecDryRunSummary = {
  fy: string;
  source: "register_xlsx" | "register_sheets" | "state_head_dashboard";
  rowsRead: number;
  rowsToInsert: number;
  existingInDb: number;           // count already present (would be skipped)
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
  customer: string | null;
  brandRaw: string | null;
  amount: number;
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
