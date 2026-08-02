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
  | "business_plan";   // Annual business plan (from member working sheet)

export type NodeLevel =
  | "company"
  | "head"
  | "salesperson"
  | "distributor"
  | "retailer"
  | "segment"
  | "time"
  | "gap";

export type MeasureValue = {
  measure: MeasureKind;
  label: string;
  value: number | null;
  unit: "INR" | "count" | "pct";
};

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
  detail?: Record<string, unknown> | null;
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
