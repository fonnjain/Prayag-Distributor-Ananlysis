// Red Alert detection — shared types.
//
// NO routes, NO UI, NO persisted tables. This module is pure detection logic.
// The calibration script runs detectAlerts() against historical data and prints
// counts so threshold defaults can be validated before any page is built.

// Minimal pool interface so the redAlert module does not depend on pg types directly.
// The actual pool always comes from @workspace/db.
export type DbPool = {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
};

export type AlertCode =
  | "A1" | "A2" | "A3"         // Category A — salesperson
  | "B1" | "B2" | "B3" | "B4" | "B5"  // Category B — dealer/retailer
  | "C1" | "C2" | "C3" | "C4" | "C5"; // Category C — territory/segment

export type EntityType =
  | "member"        // individual territory manager
  | "team"          // state head + their reports
  | "distributor"
  | "direct_dealer"
  | "retailer"
  | "state"
  | "segment";

// Numbers stored alongside each alert — the raw values that drove it.
// Kept as a plain record so the calibration report can print whatever is relevant.
export type AlertNumbers = {
  currentValue?: number;
  priorValue?: number;
  valueGrowthPct?: number;
  mrpIncreasePct?: number;
  realGrowthPct?: number;
  realisedRealGrowthPct?: number;
  declinePct?: number;
  cumulativeOb?: number;
  cumulativeTarget?: number;
  achievementPct?: number;
  priorAchievementPct?: number;    // for "sustained" display
  codePrior?: number;
  codeCurrent?: number;
  statePct?: number;
  companyPct?: number;
  gapPts?: number;
  concentrationSharePct?: number;
  grossContribCurrentCr?: number;
  grossContribPriorCr?: number;
  daysSinceRead?: number;
  [key: string]: number | string | null | undefined;
};

export type RawAlert = {
  code: AlertCode;
  category: "A" | "B" | "C";
  entity: string;          // human-readable name for reports
  entityKey: string;       // DB lookup key (customer name, head_canon, state_canon, segment)
  entityType: EntityType;
  currentMonths: string[]; // month labels in the current window e.g. ["Apr-26","May-26"]
  priorMonths: string[];   // corresponding prior-year months
  numbers: AlertNumbers;
  rupeesAtStake: number;   // ₹ at stake (current period value, or delta, depending on context)
  // Extra fields needed by specific calibration report sections
  extraForReport?: Record<string, number | string | null | undefined>;
};

export type GuardResult =
  | { pass: true }
  | { pass: false; guard: number; reason: string };

export type SuppressedAlert = {
  alert: RawAlert;
  guard: number;      // 0 = cross-suppression by another alert
  reason: string;
  suppressingCode?: AlertCode;  // for cross-suppression
};

// Final output of detectAlerts() for one FY/period.
export type CalibrationResult = {
  fy: string;
  currentMonths: string[];
  priorMonths: string[];
  alerts: RawAlert[];            // passed all guards, not cross-suppressed
  suppressed: SuppressedAlert[]; // guard-suppressed OR cross-suppressed
  suppressedByGuard: Record<number, number>; // guard# → count
  crossSuppressed: number;       // count suppressed by B3/C5 cross-rules
  byCode: Record<AlertCode, { count: number; rupeesAtStake: number }>;
};

// Pre-fetched DB context — built once per calibration run, shared across periods.
export type CustomerSaleRow = {
  fy: string;
  monthLabel: string;
  customer: string;
  headCanon: string | null;
  stateCanon: string | null;
  channel: string | null;
  groupCanon: string | null;
  value: number;   // SUM(amount)
  qty: number;     // SUM(qty)
};

export type CustomerCodeRow = {
  fy: string;
  monthLabel: string;
  customer: string;
  code: string;
  groupCanon: string | null;
  qty: number;
  value: number;
  avgRate: number | null;  // for MRP realised-price index
};

export type SecHeadMonthRow = {
  fy: string;
  headCanon: string;
  stateHead: string | null;
  monthLabel: string;
  monthIdx: number;
  planAmount: number | null;
  orderedAmount: number | null;
  receivedAmount: number | null;
  notYetRecorded: boolean;
  isAnomaly: boolean;
  ingestedAt: Date | null;
};

export type MrpHistoryRow = {
  itemCode: string;
  segment: string;
  mrp: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isCurrent: boolean;
};

export type MarginFactRow = {
  fy: string;
  monthLabel: string;
  itemCode: string;
  segment: string;
  qty: number;
  saleValue: number;
  bomCost: number | null;
  avgSale: number | null;
};

export type PersonRow = {
  normKey: string;
  canonicalName: string;
  stateHead: string | null;
  isStateHead: boolean;
  hrStatus: string | null;
  isPerson: boolean;
};

export type CustomerMasterRow = {
  id: string;
  company: string;
  entityType: string | null;  // "Distributors" | "Direct Dealers" | null
  stateHead: string | null;
};

// The full pre-fetched context shared across both period calibrations.
export type DetectionContext = {
  pool: DbPool;

  // Sale data — territory rows only; all FYs needed for like-month comparisons
  customerSale: CustomerSaleRow[];
  customerCode: CustomerCodeRow[];

  // Secondary member data
  secHeadMonths: SecHeadMonthRow[];

  // MRP tables
  mrpHistory: MrpHistoryRow[];
  ambiguousCodes: Set<string>;  // codes that exist in multiple segments

  // Margin fact (for C4)
  marginFact: MarginFactRow[];

  // Person registry
  persons: PersonRow[];

  // Customer master (entity type)
  customerMaster: Map<string, CustomerMasterRow>;  // keyed by company name (normalised)

  // Retailer → distributor across FYs (for Guard 5)
  retailerDistributors: Map<string, Map<string, Set<string>>>;  // retailer → fy → Set<distributor>

  // Frozen months per FY (for Guard 3 — primary data completeness)
  frozenMonths: Map<string, Set<string>>;  // fy → Set<monthLabel>

  // Secondary complete months per head per FY (for Guard 9)
  secCompleteMonths: Map<string, Map<string, string[]>>;  // fy → headCanon → monthLabels[]

  // Last sheet read per member (for C5)
  lastSheetRead: Map<string, Date>;  // headCanon → latest ingested_at across all months
};
