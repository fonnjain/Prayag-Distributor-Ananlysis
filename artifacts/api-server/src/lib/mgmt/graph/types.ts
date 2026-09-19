/**
 * Phase A8 — Metrics Graph
 *
 * A traversable map of every reconciled figure in the application.
 * Every node carries five properties (measure, value, population, source, flags)
 * that this project already requires of any figure shown on screen — the graph
 * makes them machine-readable.
 *
 * DESIGN RULE: Nodes are computed by EXISTING verified functions. No arithmetic
 * lives here. If a figure is not already computed somewhere, it becomes a gap
 * node, not a new formula.
 */

export type MeasureKind =
  | "primary_ob"       // Primary order booking
  | "primary_sale"     // Primary sale / dispatch
  | "secondary_ob"     // Secondary order booking (distributor → retailer)
  | "secondary_sale"   // Secondary sales received
  | "target"           // Monthly or annual target
  | "business_plan"    // Annual business plan (from member working sheet)
  | "gross_margin"
  | "gross_contribution"
  | "projection"
  | "penetration"
  | "growth_pct"
  | "comparison_pct"
  | "quantity";
export const MEASURE_LABELS: Record<MeasureKind, string> = {
  primary_ob: "Primary Order Booking",
  primary_sale: "Primary Dispatch",
  secondary_ob: "Secondary Order Booking",
  secondary_sale: "Secondary Sales Received",
  target: "Target",
  business_plan: "Business Plan",
  gross_margin: "Gross Margin",
  gross_contribution: "Gross Contribution",
  projection: "Seasonal Projection",
  penetration: "Customer-SKU Penetration",
  growth_pct: "Growth",
  comparison_pct: "Comparison",
  quantity: "Quantity",
};

export type NodeLevel =
  | "company"
  | "head"
  | "salesperson"
  | "distributor"
  | "retailer"
  | "segment"
  | "time"
  | "gap";

type MeasureCommon = {
  measure: Exclude<MeasureKind, "projection">;
  label: string;
  unit: "INR" | "count" | "pct";
  /** Source lineage is repeated on every typed measure when a seam matters. */
  source?: string;
  value_basis?: string;
};
type PercentageBasis = {
  numerator: string; denominator: string; population: string; period: string; source: string;
};
export type MeasureValue =
  | (Omit<MeasureCommon, "measure" | "unit"> & { measure: "projection"; unit: "INR" | "count"; availability: "measured" | "partial"; value: number; basis?: never; projection: ProjectionMetadata })
  | (Omit<MeasureCommon, "measure" | "unit"> & { measure: "projection"; unit: "INR" | "count"; availability: "unavailable" | "not_applicable"; value?: never; basis?: never; projection?: never })
  | (Omit<MeasureCommon, "unit"> & { availability: "measured"; value: number; unit: "pct"; basis: PercentageBasis })
  | (Omit<MeasureCommon, "unit"> & { availability: "measured"; value: number; unit: "INR" | "count"; basis?: PercentageBasis })
  | (Omit<MeasureCommon, "unit"> & { availability: "partial"; value?: number; unit: "pct"; basis: PercentageBasis })
  | (Omit<MeasureCommon, "unit"> & { availability: "partial"; value?: number; unit: "INR" | "count"; basis?: PercentageBasis })
  | (Omit<MeasureCommon, "unit"> & { availability: "unavailable" | "not_applicable"; unit: "pct"; value?: never; basis: PercentageBasis })
  | (Omit<MeasureCommon, "unit"> & { availability: "unavailable" | "not_applicable"; unit: "INR" | "count"; value?: never; basis?: never })
  | (MeasureCommon & { availability: "held"; value?: never; basis?: never; hold: {
      code?: string; category: string; reason: string;
    }});
/* Percentage measures are constructible only with a structured basis. */
export type PercentageMeasure = Extract<MeasureValue, { unit: "pct" }> & { basis: PercentageBasis };
export type ProjectionMetadata = {
  calibrationBasis: string;
  observedMonths: string[];
  seasonalService: string;
};
export type ProjectionMeasure = Extract<MeasureValue, { measure: "projection" }> & {
  value: number;
  availability: "measured" | "partial";
  projection: ProjectionMetadata;
};
/* Recursive metadata is deliberately JSON-safe and cannot contain functions,
 * class instances, SQL objects, or arbitrary payload references. */
export type SafeMetadata = string | number | boolean | null | SafeMetadata[] | {
  [key: string]: SafeMetadata;
};
export function sanitizeMetadata(value: unknown, depth = 0): SafeMetadata {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 2000).map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value === "object") {
    const out: { [key: string]: SafeMetadata } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 2000)) {
      out[key] = sanitizeMetadata(item, depth + 1);
    }
    return out;
  }
  return String(value);
}
export function stripNumericMetadata(value: SafeMetadata, depth = 0): SafeMetadata {
  if (depth > 8 || value == null || typeof value === "number") return null;
  if (typeof value === "string") {
    return /^\s*(?:₹|rs\.?|inr)?\s*[+-]?\d[\d,]*(?:\.\d+)?\s*(?:k|l|lakh|cr|crore|%)?\s*$/i.test(value)
      ? null : value;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => stripNumericMetadata(item, depth + 1));
  const out: { [key: string]: SafeMetadata } = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = stripNumericMetadata(item, depth + 1);
  }
  return out;
}
/** Detail is descriptive metadata; nested typed measures are the sole exception. */
export function sanitizeDetailMetadata(value: unknown, depth = 0): SafeMetadata {
  if (depth > 8 || value == null) return null;
  if (typeof value === "number") return null;
  if (typeof value === "string") return /^\s*[+-]?\d[\d,]*(?:\.\d+)?\s*(?:k|l|lakh|cr|crore|%)?\s*$/i.test(value) ? null : value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeDetailMetadata(v, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.availability === "held" || "hold" in record) return null;
  if (typeof record.measure === "string" && Object.prototype.hasOwnProperty.call(MEASURE_LABELS, record.measure) &&
      ["INR", "count", "pct"].includes(String(record.unit)) &&
      ["measured", "partial"].includes(String(record.availability)) && Number.isFinite(record.value)) {
    return sanitizeMetadata({
      measure: record.measure, label: record.label, unit: record.unit,
      availability: record.availability, value: record.value, basis: record.basis, projection: record.projection,
      source: record.source, value_basis: record.value_basis,
    });
  }
  const out: { [key: string]: SafeMetadata } = {};
  for (const [key, item] of Object.entries(record)) out[key] = sanitizeDetailMetadata(item, depth + 1);
  return out;
}
/*
  hold?: {
    code?: string;
    category: string;
    reason: string;
  };
*/

// A full graph node — returned by POST /api/graph/resolve.
export type GraphNode = {
  path: string;
  level: NodeLevel;
  fy: string;
  name: string;
  // Reconciled measure values.
  measures: MeasureValue[];
  // What is included / excluded in the population.
  population: string;
  // Where the figure comes from (function / sheet / table).
  source: string;
  // Data cutoff (e.g. "30 Jun 2026" or "FY closed").
  cutoff: string;
  availability?: "measured" | "partial" | "unavailable" | "held" | "not_applicable";
  /** Timestamp at which this bounded node was read, never implied by cache time. */
  readTime?: string;
  /** Registry assignment; unresolved facts are explicitly Unmapped. */
  category?: string;
  // Data-quality flags.
  flags: string[];
  // Graph edges.
  parent: string | null;
  children: string[];
  // True when children.measures sum to this.measures. Null when unknown.
  childrenSumToParent: boolean | null;
  // When children do NOT sum to parent, state the residual.
  residual?: { value: number; description: string } | null;
  // Additional rich data for salesperson level (full A1 payload subset).
  detail?: SafeMetadata | null;
  // Gap node fields — present when level === "gap".
  isGap: boolean;
  gapReason?: string;
  gapBlocks?: string;
};

// Graph index — returned by GET /api/graph/index. Must be small enough to send
// in every prompt regardless of company size.
export type LevelMeta = {
  level: NodeLevel;
  count: number;          // approximate node count
  measuresAvailable: MeasureKind[];
  examplePaths: string[]; // 1-2 example path patterns
};

export type GraphIndex = {
  fy: string;
  period: string | null;
  generatedAt: string;
  levels: LevelMeta[];
  fys: string[];          // fiscal years with data, newest first
  gapNodes: GapNodeMeta[];
  crossFyKeySplits: CrossFyKeySplit[];
  // Known residuals at company level.
  companyResiduals: { description: string; customers: number; value?: number }[];
  // Free-form usage notes surfaced in the prompt.
  notes: string[];
};

export type GapNodeMeta = {
  path: string;
  reason: string;
  blocks: string;
};

export type CrossFyKeySplit = {
  level: "head" | "salesperson";
  name: string;      // key as it appears in the newer FY
  missingIn: string; // the FY where this key is absent or named differently
  alias?: string;    // how it appears in the other FY
};

// POST /api/graph/resolve request + response.
export type ResolveRequest = {
  paths: string[];           // e.g. ["company/2026-27", "head/Anant Singh/2026-27"]
  fy?: string;               // default FY when path omits it
};

export type ResolveResponse = {
  nodes: GraphNode[];
  truncated: boolean;
  truncationReason?: string;
  errors: { path: string; error: string }[];
};

// Cap: max nodes returned per resolve call.
export const MAX_NODES_PER_RESOLVE = 20;
