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
  | "C1" | "C2" | "C3" | "C4" | "C5" | "C6"  // Category C — territory/segment
  | "S1";                               // Category S — supply chain (destocking)

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
  category: "A" | "B" | "C" | "S";
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
  // Raw candidates BEFORE any guard — used by the calibration report to show
  // how many alerts the engines produce before the guard layer filters them.
  rawCount: number;
  rawByCode: Record<AlertCode, number>;
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

// Retailer-level sale aggregates from secondary_sku_line (the authoritative source
// for retailer transactions). Used by B1–B5 for retailer-type entities; primary
// sale_line_current is NOT used for retailers because it records primary dispatch
// (distributor→company) not per-retailer sell-out.
export type RetailerSaleRow = {
  fy: string;
  monthLabel: string;
  retailer: string;          // RET# identifier from secondary_sku_line.retailer
  value: number;             // SUM(net_amount) for the retailer/month
};

export type RetailerSkuRow = {
  fy: string;
  monthLabel: string;
  retailer: string;
  itemCode: string;
  segmentCanon: string | null;
  value: number;             // SUM(net_amount)
};

// Unfiltered channel/head metadata for Guard 1.
// Queried WITHOUT the is_territory filter so customers reclassified to
// Project/Govt/non-territory still appear in the current window.
export type CustomerMetaRow = {
  fy: string;
  monthLabel: string;
  customer: string;
  channel: string | null;
  headCanon: string | null;
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

  // Primary sale data — territory rows only; used for distributors/direct dealers
  customerSale: CustomerSaleRow[];
  customerCode: CustomerCodeRow[];

  // Secondary retailer sale data from secondary_sku_line — authoritative for retailers.
  // Retailers do not appear in sale_line_current (primary dispatch); their sell-out
  // transactions live here. B1–B5 route to this source for retailer-type entities.
  retailerSale: RetailerSaleRow[];
  retailerSku: RetailerSkuRow[];

  // Unfiltered channel/head metadata (no is_territory filter) — Guard 1 only.
  // Customers reclassified to Project/non-territory vanish from customerSale;
  // this separate field keeps them visible so the reclassification is detectable.
  customerMeta: CustomerMetaRow[];

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

  // Retailer → distributor mappings keyed by `${fy}|${monthLabel}` (for Guard 5).
  // Preserving the month dimension prevents a reassignment outside the alert window
  // from suppressing a legitimate within-window B3.
  retailerDistributors: Map<string, Map<string, Set<string>>>;  // retailer → `${fy}|${month_label}` → Set<distributor>

  // Primary (highest-value) distributor per retailer per FY — for B3 rollup.
  // Built from secondary_sku_line: for each (fy, retailer), the distributor with the
  // highest SUM(net_amount). Used to attribute a stopped retailer to its main supplier.
  retailerPrimaryDist: Map<string, Map<string, string>>;  // fy → retailer → primary_distributor

  // Distributor monthly secondary sell-through — for S1 destocking detection.
  // Key: `${distributor_name}|${fy}|${monthLabel}`. Value: SUM(net_amount).
  distSecMonthly: Map<string, number>;  // `${dist}|${fy}|${month}` → net_amount

  // head_canon → state_head mapping derived from person_registry.
  // head_canon = LOWER(canonical_name). Used by the territorial concentration alert.
  headToStateHead: Map<string, string | null>;  // head_canon → state_head

  // Primary head_canon per (fy, retailer) — for C6 territorial concentration.
  // Built from secondary_sku_line: for each (fy, retailer), the head_canon from the
  // highest-value transaction row. Excludes rows where head_canon IS NULL.
  retailerHeadCanon: Map<string, Map<string, string>>;  // fy → retailer → head_canon

  // Frozen months per FY (for Guard 3 — primary data completeness)
  frozenMonths: Map<string, Set<string>>;  // fy → Set<monthLabel>

  // Secondary complete months per head per FY (for Guard 9)
  secCompleteMonths: Map<string, Map<string, string[]>>;  // fy → headCanon → monthLabels[]

  // Last sheet read per member (for C5)
  lastSheetRead: Map<string, Date>;  // headCanon → latest ingested_at across all months

  // Secondary lookup for Guard 4: base name keys (head_canon format) that resolve to
  // a person with is_person=true.  Built from two sources:
  //   (a) the part before ":" in collision-disambiguation norm_keys
  //       e.g. "ashutoshkumarrudrapur:anantsingh" → "ashutoshkumarrudrapur"
  //   (b) LOWER(REPLACE(REPLACE(canonical_name,' ',''),'.','')) for numeric norm_keys
  // Allows Guard 4 to resolve entityKeys that come from secondary_head_month.head_canon
  // even when the registry's primary norm_key is an employee code or contains a suffix.
  personsByNameKey: Set<string>;

  // Departed or holding state heads, keyed by lowercase alphanumeric-only name.
  // C6 (and any per-head alert firing) must skip these heads entirely.
  departedHeadNames: Set<string>;
};
