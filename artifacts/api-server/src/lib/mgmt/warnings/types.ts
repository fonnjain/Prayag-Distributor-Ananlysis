// Warning System — shared types for engine, routes, and frontend.

export type WarningSeverity =
  | "RED"
  | "ORANGE"
  | "YELLOW"
  | "NOT_AVAILABLE"; // data exists but metric not computable (J-family or missing required)

export type WarningTrend = "IMPROVING" | "WORSENING" | "STABLE";

export type WarningCard = {
  code: string;            // "A1", "D1", "J3", etc.
  family: string;          // "A", "C", "D", "E", "G", "I", "J"
  title: string;
  severity: WarningSeverity;
  baseSeverity: WarningSeverity; // before trend adjustment (for display)
  trend: WarningTrend | null;
  metric: {
    value: number | null;
    label: string;
    formatted: string;    // pre-formatted string e.g. "44.8%", "0.52"
  };
  threshold: {
    red?: number;
    orange?: number;
    yellow?: number;
    direction: "above" | "below"; // "above" = higher value is worse (e.g. unassigned %)
  };
  source: string;           // data source description
  suggestedAction: string;
  notAvailableReason?: string; // when severity === "NOT_AVAILABLE"
  suppressedBy?: string;    // warning code that suppressed this one
  suppresses: string[];     // codes this warning suppresses when it fires RED
};

// Separated result after suppression is applied
export type MemberWarnings = {
  memberKey: string;
  name: string;
  stateHead: string;
  hasMappedSheet: boolean;
  isPartialTenure: boolean;
  workingDaysActual: number | null;
  // Closed months with booking present but sales not yet entered (data-entry
  // lag). These months are excluded from trend, A4, and J2.
  lagMonths?: number;
  retailersTotal: number | null;
  unassignedCount: number | null;
  visitsToUnassigned: number | null;
  // After suppression:
  rootWarnings: WarningCard[];      // visible warnings (not suppressed)
  suppressedWarnings: WarningCard[]; // collapsed beneath a root warning
  jFlags: WarningCard[];            // J-family always visible alongside root warnings
  suppressedCount: number;
};

export type WarningsResponse = {
  fy: string;
  stateHead: string;
  availableStateHeads: string[];
  elapsedFraction: number;
  members: MemberWarnings[];
  teamSummary: {
    totalRetailers: number;
    unassignedRetailers: number;
    visitsToUnassigned: number;
    membersWithSheet: number;
    membersWithoutSheet: number;
    activeRetailers: number;
    normWorkingDays: number;
    normBasis: "team-median" | "company-fallback";
    partialTenureCutoffDays: number;
  };
};
