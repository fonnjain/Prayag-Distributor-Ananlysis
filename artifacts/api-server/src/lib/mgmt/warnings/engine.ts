// Warning System engine — W1 (families A, C, D, E, G, I, J)
// All metrics come from EXISTING verified computation. No new arithmetic.

import type { AiPayload } from "../aiPayload.js";
import type { RetailerRow } from "../memberSheet.js";
import type { WarningCard, WarningSeverity, WarningTrend } from "./types.js";

// ── Known cross-FY key splits ─────────────────────────────────────────────────
// head_canon values that differ between consecutive FYs; YoY comparisons for
// these heads return zero for the prior year instead of real data.
// Source of truth: src/lib/headSplits.ts — this map is a local copy for the
// warnings engine (avoids an async import).
//
// All six pairs are resolved (five via DB UPDATE Jul 2026; Pawan Kumar →
// Pawan Sharma confirmed by geography and merged Aug 2026). Map kept empty
// for the next split that appears.
const CROSS_FY_KEY_SPLITS: Record<string, string> = {};

function normKey(name: string): string {
  return name.toLowerCase().trim();
}

// ── Severity helpers ──────────────────────────────────────────────────────────

function severityBelow(
  value: number | null,
  redBelow: number,
  orangeBelow: number,
  yellowBelow: number,
): WarningSeverity | null {
  if (value === null) return null;
  if (value < redBelow) return "RED";
  if (value < orangeBelow) return "ORANGE";
  if (value < yellowBelow) return "YELLOW";
  return null; // no warning
}

function severityAbove(
  value: number | null,
  redAbove: number,
  orangeAbove: number,
  yellowAbove: number,
): WarningSeverity | null {
  if (value === null) return null;
  if (value >= redAbove) return "RED";
  if (value >= orangeAbove) return "ORANGE";
  if (value >= yellowAbove) return "YELLOW";
  return null;
}

function applyTrend(
  base: WarningSeverity,
  trend: WarningTrend | null,
): WarningSeverity {
  if (trend === "WORSENING") {
    if (base === "YELLOW") return "ORANGE";
    if (base === "ORANGE") return "RED";
  }
  if (trend === "IMPROVING") {
    if (base === "RED") return "ORANGE";
    if (base === "ORANGE") return "YELLOW";
    // YELLOW improving → no longer a warning (omit the card instead)
  }
  return base;
}

// ── Month-trend helper ────────────────────────────────────────────────────────

type Month = {
  monthLabel: string;
  orderedAmount: number;
  salesAmount: number;
  // True when the month has not been fully recorded yet — either the calendar
  // month is still open, or it closed with booking but sales not yet entered
  // (a data-entry lag, NOT a performance signal). Lag months must never feed
  // trend detection, A4, or J2 — they look like a collapse when they are not.
  notYetRecorded?: boolean;
};

// Months that are fully recorded — the only months trend/A4/J2 may read.
function recordedMonths(months: Month[]): Month[] {
  return months.filter((m) => !m.notYetRecorded);
}

// A "lag month": closed with order booking present but flagged notYetRecorded
// (sales entry is pending). Future months carry no booking, so orderedAmount>0
// distinguishes lag from simply-not-arrived months.
export function countLagMonths(months: Month[]): number {
  return months.filter((m) => m.notYetRecorded && m.orderedAmount > 0).length;
}

function detectTrend(values: number[]): WarningTrend | null {
  if (values.length < 2) return null;
  let ups = 0, downs = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1] * 1.02) ups++;
    else if (values[i] < values[i - 1] * 0.98) downs++;
  }
  if (downs >= Math.ceil(values.length / 2)) return "WORSENING";
  if (ups >= Math.ceil(values.length / 2)) return "IMPROVING";
  return "STABLE";
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function pctFmt(v: number | null, dp = 1): string {
  if (v === null) return "—";
  return `${v.toFixed(dp)}%`;
}
function ratioFmt(v: number | null, dp = 2): string {
  if (v === null) return "—";
  return v.toFixed(dp);
}
function countFmt(v: number | null): string {
  if (v === null) return "—";
  return String(v);
}

// ── Individual warning builders ───────────────────────────────────────────────

function makeCard(
  base: Omit<WarningCard, "baseSeverity" | "suppresses"> & {
    baseSeverity?: WarningSeverity;
    suppresses?: string[];
  },
): WarningCard {
  return {
    suppresses: [],
    ...base,
    baseSeverity: base.baseSeverity ?? base.severity,
  };
}

// A1 — Behind to-date target
function computeA1(
  achievementPct: number | null,
  months: Month[],
  totalOB: number | null,
): WarningCard | null {
  // Zero/absent to-date target with real business: never 0% or RED —
  // surface "no target recorded" instead.
  if (achievementPct === null && (totalOB ?? 0) > 0) {
    return makeCard({
      code: "A1",
      family: "A",
      title: "To-date target (not recorded)",
      severity: "NOT_AVAILABLE",
      baseSeverity: "NOT_AVAILABLE",
      trend: null,
      metric: { value: null, label: "Achievement vs pro-rated target", formatted: "No target recorded" },
      threshold: { direction: "below" },
      source: "member working sheet (to-date target = 0 or absent)",
      suggestedAction: "Record a to-date target to enable achievement tracking",
      notAvailableReason: "This member carries business but has no to-date target recorded — achievement cannot be judged.",
      suppresses: [],
    });
  }
  const base = severityBelow(achievementPct, 50, 70, 85);
  if (!base) return null;
  const obVals = recordedMonths(months).map((m) => m.orderedAmount);
  const trend = detectTrend(obVals);
  const sev = applyTrend(base, trend);
  return makeCard({
    code: "A1",
    family: "A",
    title: "Behind to-date target",
    severity: sev,
    baseSeverity: base,
    trend,
    metric: {
      value: achievementPct,
      label: "Achievement vs pro-rated target",
      formatted: pctFmt(achievementPct),
    },
    threshold: { red: 50, orange: 70, yellow: 85, direction: "below" },
    source: "member working sheet (achievement.totalOBPct)",
    suggestedAction: "Check whether it is coverage or conversion before pushing target",
    suppresses: [],
  });
}

// A2 — Run rate misses annual plan
function computeA2(
  totalOB: number | null,
  businessPlan: number | null,
  elapsedFraction: number,
  months: Month[],
): WarningCard | null {
  if (totalOB === null || businessPlan === null || businessPlan === 0 || elapsedFraction === 0) return null;
  const projected = totalOB / elapsedFraction;
  const pct = (projected / businessPlan) * 100;
  const base = severityBelow(pct, 50, 70, 85);
  if (!base) return null;
  const obVals = recordedMonths(months).map((m) => m.orderedAmount);
  const trend = detectTrend(obVals);
  const sev = applyTrend(base, trend);
  return makeCard({
    code: "A2",
    family: "A",
    title: "Run rate misses annual plan",
    severity: sev,
    baseSeverity: base,
    trend,
    metric: {
      value: pct,
      label: "Projected annual vs business plan",
      formatted: pctFmt(pct),
    },
    threshold: { red: 50, orange: 70, yellow: 85, direction: "below" },
    source: "member working sheet (totalOB / elapsedFraction vs businessPlan)",
    suggestedAction: "Re-plan the remaining months rather than restate the annual number",
    suppresses: [],
  });
}

// A3 — Momentum reversing
function computeA3(months: Month[]): WarningCard | null {
  if (months.length < 2) return null;
  const obVals = recordedMonths(months).map((m) => m.orderedAmount);
  const trend = detectTrend(obVals);
  if (trend !== "WORSENING") return null;
  return makeCard({
    code: "A3",
    family: "A",
    title: "Momentum reversing",
    severity: "YELLOW",
    baseSeverity: "YELLOW",
    trend: "WORSENING",
    metric: {
      value: null,
      label: "Month-on-month OB direction",
      formatted: "Declining",
    },
    threshold: { direction: "above" },
    source: "secondary register (monthly OB sequence)",
    suggestedAction: "Look at the month the direction changed and what happened in it",
    suppresses: [],
  });
}

// A4 — Booking not converting to sale
function computeA4(
  totalOB: number | null,
  salesReceived: number | null,
  months: Month[],
): WarningCard | null {
  // Lag-month guard: a closed month with booking but sales not yet entered
  // makes the OB–sale gap read as pure shortfall. When month data exists and
  // a lag month is present, compute the gap over fully-recorded months only.
  if (months.length > 0 && countLagMonths(months) > 0) {
    const rec = recordedMonths(months).filter((m) => m.orderedAmount > 0);
    if (rec.length === 0) return null; // nothing recorded yet — pure lag, no signal
    const obRec = rec.reduce((s, m) => s + m.orderedAmount, 0);
    const saleRec = rec.reduce((s, m) => s + m.salesAmount, 0);
    if (obRec <= 0) return null;
    if (saleRec === 0) return null; // J2 territory
    const gapPctRec = ((obRec - saleRec) / obRec) * 100;
    const baseRec = severityAbove(gapPctRec, 25, 15, 8);
    if (!baseRec) return null;
    return makeCard({
      code: "A4",
      family: "A",
      title: "Booking not converting to sale",
      severity: baseRec,
      baseSeverity: baseRec,
      trend: null,
      metric: {
        value: gapPctRec,
        label: "OB–sale gap as % of booking (recorded months only)",
        formatted: pctFmt(gapPctRec),
      },
      threshold: { red: 25, orange: 15, yellow: 8, direction: "above" },
      source: "secondary register (recorded months only — lag months excluded)",
      suggestedAction: "Check dispatch, credit hold, or an unmaintained sale column",
      suppresses: [],
    });
  }
  if (totalOB === null || totalOB === 0 || salesReceived === null) return null;
  if (salesReceived === 0) {
    // J2 handles the zero-sale case; skip here if totalOB is small
    return null;
  }
  const gapPct = ((totalOB - salesReceived) / totalOB) * 100;
  const base = severityAbove(gapPct, 25, 15, 8);
  if (!base) return null;
  return makeCard({
    code: "A4",
    family: "A",
    title: "Booking not converting to sale",
    severity: base,
    baseSeverity: base,
    trend: null,
    metric: {
      value: gapPct,
      label: "OB–sale gap as % of booking",
      formatted: pctFmt(gapPct),
    },
    threshold: { red: 25, orange: 15, yellow: 8, direction: "above" },
    source: "member working sheet (totalOB vs salesReceived)",
    suggestedAction: "Check dispatch, credit hold, or an unmaintained sale column",
    suppresses: [],
  });
}

// C1 — Visit pace ratio
// pace = (visits done / annual required) / elapsed fraction
function computeC1(
  visits: AiPayload["visits"],
  elapsedFraction: number,
): WarningCard | null {
  if (!visits) return null;
  if (visits.required === null || visits.required === 0) {
    return makeCard({
      code: "C1",
      family: "C",
      title: "Visit pace (not recorded)",
      severity: "NOT_AVAILABLE",
      baseSeverity: "NOT_AVAILABLE",
      trend: null,
      metric: { value: null, label: "Visit pace ratio", formatted: "—" },
      threshold: { direction: "below" },
      source: "member working sheet (annual visits required = 0 or absent)",
      suggestedAction: "Record annual visit requirement to enable pace tracking",
      notAvailableReason: "No annual visit requirement is recorded for this member",
      suppresses: [],
    });
  }
  if (visits.done === null || elapsedFraction === 0) return null;
  const pace = (visits.done / visits.required) / elapsedFraction;
  const base = severityBelow(pace, 0.60, 0.80, 0.95);
  if (!base) return null;
  return makeCard({
    code: "C1",
    family: "C",
    title: "Visit pace behind",
    severity: base,
    baseSeverity: base,
    trend: null,
    metric: {
      value: pace,
      label: "Visit pace ratio",
      formatted: ratioFmt(pace),
    },
    threshold: { red: 0.60, orange: 0.80, yellow: 0.95, direction: "below" },
    source: "member working sheet (visits done / annual required / elapsed%)",
    suggestedAction: "Compare against demonstrated capacity from a complete year before raising cadence",
    suppresses: [],
  });
}

// C2 — Visit productivity falling
function computeC2(
  visits: AiPayload["visits"],
  totalOB: number | null,
  months: Month[],
): WarningCard | null {
  if (!visits || visits.done === null || visits.done === 0 || totalOB === null) return null;
  const bpv = totalOB / visits.done;
  // Trend: if OB is falling while visits are stable or rising → productivity falling
  const obVals = recordedMonths(months).map((m) => m.orderedAmount);
  const trend = detectTrend(obVals);
  if (trend !== "WORSENING") return null;
  return makeCard({
    code: "C2",
    family: "C",
    title: "Visit productivity falling",
    severity: "YELLOW",
    baseSeverity: "YELLOW",
    trend: "WORSENING",
    metric: {
      value: bpv,
      label: "Business per visit (₹)",
      formatted: bpv > 0 ? `₹${Math.round(bpv).toLocaleString("en-IN")}` : "—",
    },
    threshold: { direction: "above" },
    source: "member working sheet (totalOB / visits done)",
    suggestedAction: "Look at which customer state the visits are going to",
    suppresses: [],
  });
}

// C3 — Visits converting nothing
function computeC3(
  visits: AiPayload["visits"],
  coverage: AiPayload["coverage"],
): WarningCard | null {
  if (!visits || visits.visitedNoOrder === null || visits.visitedNoOrder === 0) return null;
  const visited = coverage.visited ?? 0;
  const sharePct = visited > 0 ? (visits.visitedNoOrder / visited) * 100 : null;
  const base = severityAbove(sharePct, 60, 40, 20);
  if (!base) return null;
  return makeCard({
    code: "C3",
    family: "C",
    title: "Visits converting nothing",
    severity: base,
    baseSeverity: base,
    trend: null,
    metric: {
      value: sharePct,
      label: "Visited-with-no-order share",
      formatted: `${countFmt(visits.visitedNoOrder)} retailers (${pctFmt(sharePct)} of visited)`,
    },
    threshold: { red: 60, orange: 40, yellow: 20, direction: "above" },
    source: "member working sheet (visited retailers with orderBooking = 0)",
    suggestedAction: "Cap repeat visits to non-converting accounts and redirect",
    suppresses: [],
  });
}

// D1 — High unassigned share
function computeD1(
  unassignedCount: number,
  totalCount: number,
): WarningCard | null {
  if (totalCount === 0) return null;
  const pct = (unassignedCount / totalCount) * 100;
  const base = severityAbove(pct, 50, 35, 20);
  if (!base) return null;
  return makeCard({
    code: "D1",
    family: "D",
    title: "High unassigned retailer share",
    severity: base,
    baseSeverity: base,
    trend: null,
    metric: {
      value: pct,
      label: "Retailers with no assigned distributor",
      formatted: `${unassignedCount} of ${totalCount} (${pctFmt(pct)})`,
    },
    threshold: { red: 50, orange: 35, yellow: 20, direction: "above" },
    source: "member working sheet (distributor column = blank or '--')",
    suggestedAction:
      "Assign them. Administrative where a distributor already covers the district",
    // D1 RED suppresses G1, C3, E2
    suppresses: ["G1", "C3", "E2"],
  });
}

// D2 — Visits spent on unassigned
function computeD2(
  visitsToUnassigned: number,
  unassignedCount: number,
  totalVisits: number | null,
): WarningCard | null {
  if (visitsToUnassigned === 0) return null;
  const sharePct = totalVisits && totalVisits > 0 ? (visitsToUnassigned / totalVisits) * 100 : null;
  const base = severityAbove(sharePct, 30, 15, 5);
  const sev = base ?? "YELLOW";
  return makeCard({
    code: "D2",
    family: "D",
    title: "Visits spent on unassigned retailers",
    severity: sev,
    baseSeverity: sev,
    trend: null,
    metric: {
      value: visitsToUnassigned,
      label: "Visits to retailers with no distributor",
      formatted: `${visitsToUnassigned} visits to ${unassignedCount} unassigned retailers${sharePct ? ` (${pctFmt(sharePct)} of total visits)` : ""}`,
    },
    threshold: { red: 30, orange: 15, yellow: 5, direction: "above" },
    source: "member working sheet (visits × no distributor)",
    suggestedAction:
      "Stop scheduling them until assigned — a visit cannot convert without a supply route",
    suppresses: [],
  });
}

// D3 — District coverage gap (retailers in district but no distributor covering it)
function computeD3(rows: RetailerRow[]): WarningCard | null {
  const districtMap = new Map<string, { total: number; unassigned: number }>();
  for (const r of rows) {
    const dist = (r.district ?? "").trim() || "Unknown";
    const prev = districtMap.get(dist) ?? { total: 0, unassigned: 0 };
    prev.total++;
    const isUnassigned =
      !r.distributor || r.distributor.trim() === "" || r.distributor.trim() === "--";
    if (isUnassigned) prev.unassigned++;
    districtMap.set(dist, prev);
  }
  const gapDistricts = [...districtMap.entries()]
    .filter(([, v]) => v.unassigned === v.total && v.total > 0)
    .map(([d]) => d);
  if (gapDistricts.length === 0) return null;
  return makeCard({
    code: "D3",
    family: "D",
    title: "Districts with no distributor",
    severity: gapDistricts.length >= 3 ? "ORANGE" : "YELLOW",
    baseSeverity: gapDistricts.length >= 3 ? "ORANGE" : "YELLOW",
    trend: null,
    metric: {
      value: gapDistricts.length,
      label: "Districts with retailers but no distributor",
      formatted: `${gapDistricts.length} district${gapDistricts.length !== 1 ? "s" : ""}: ${gapDistricts.slice(0, 3).join(", ")}${gapDistricts.length > 3 ? "…" : ""}`,
    },
    threshold: { direction: "above" },
    source: "member working sheet (district × distributor cross)",
    suggestedAction:
      "Appoint. Size the gap by prior-year demand, not retailer count",
    suppresses: [],
  });
}

// E1 — At-risk value
// at-risk = dormant retailers who were visited OR have a business plan
// at-risk share = sum(businessPlan for at-risk rows) / sum(all businessPlan)
function computeE1(rows: RetailerRow[]): WarningCard | null {
  const atRiskRows = rows.filter(
    (r) => !r.isActive && ((r.totalVisit ?? 0) > 0 || (r.businessPlan ?? 0) > 0),
  );
  const atRiskBP = atRiskRows.reduce((s, r) => s + (r.businessPlan ?? 0), 0);
  const totalBP = rows.reduce((s, r) => s + (r.businessPlan ?? 0), 0);
  if (totalBP === 0 || atRiskRows.length === 0) return null;
  const sharePct = (atRiskBP / totalBP) * 100;
  const base = severityAbove(sharePct, 25, 15, 8);
  if (!base) return null;
  return makeCard({
    code: "E1",
    family: "E",
    title: "At-risk value",
    severity: base,
    baseSeverity: base,
    trend: null,
    metric: {
      value: sharePct,
      label: "Prior-year business plan from at-risk retailers",
      formatted: `${atRiskRows.length} retailers (${pctFmt(sharePct)} of planned value)`,
    },
    threshold: { red: 25, orange: 15, yellow: 8, direction: "above" },
    source: "member working sheet (dormant + visited/planned retailers vs total plan)",
    suggestedAction:
      "Win-back list ranked by prior-year value — proven demand, highest-value calls first",
    suppresses: [],
  });
}

// E2 — Dormancy rising
function computeE2(
  customerStates: AiPayload["customerStates"],
  coverage: AiPayload["coverage"],
): WarningCard | null {
  if (!customerStates || coverage.retailersTotal === null || coverage.retailersTotal === 0) return null;
  const active = customerStates.retained.count + customerStates.reactivated.count;
  const activePct = (active / coverage.retailersTotal) * 100;
  // Fire YELLOW if active share is below 50% — rough proxy without prior period
  if (activePct >= 50) return null;
  return makeCard({
    code: "E2",
    family: "E",
    title: "Dormancy rising",
    severity: "YELLOW",
    baseSeverity: "YELLOW",
    trend: null,
    metric: {
      value: activePct,
      label: "Active retailer share",
      formatted: `${active} of ${coverage.retailersTotal} (${pctFmt(activePct)})`,
    },
    threshold: { red: 20, orange: 30, yellow: 50, direction: "below" },
    source: "member working sheet (active retailers / total)",
    suggestedAction:
      "Separate supply-route dormancy from genuine lapse before acting",
    suppresses: [],
  });
}

// E3 — No new business
function computeE3(customerStates: AiPayload["customerStates"]): WarningCard | null {
  if (!customerStates) return null;
  if (customerStates.reactivated.count > 0) return null; // there is new/reactivated business
  if (customerStates.retained.count === 0 && customerStates.reactivated.count === 0) return null; // no sheet data
  return makeCard({
    code: "E3",
    family: "E",
    title: "No new business",
    severity: "YELLOW",
    baseSeverity: "YELLOW",
    trend: null,
    metric: {
      value: 0,
      label: "Newly onboarded / reactivated retailers",
      formatted: "0",
    },
    threshold: { direction: "above" },
    source: "member working sheet (active retailers with no business plan = newly active)",
    suggestedAction:
      "Keep separate from reactivation — a person can score zero here and still revive accounts",
    suppresses: [],
  });
}

// E4 — Never-bought being visited
function computeE4(customerStates: AiPayload["customerStates"]): WarningCard | null {
  if (!customerStates) return null;
  const { never } = customerStates;
  if (never.visits === 0) return null;
  return makeCard({
    code: "E4",
    family: "E",
    title: "Never-bought retailers being visited",
    severity: "YELLOW",
    baseSeverity: "YELLOW",
    trend: null,
    metric: {
      value: never.visits,
      label: "Visits to retailers with no business in either year",
      formatted: `${never.visits} visit${never.visits !== 1 ? "s" : ""} to ${never.count} retailers`,
    },
    threshold: { direction: "above" },
    source: "member working sheet (dormant, no plan, no visits from prior year)",
    suggestedAction: "Qualify before scheduling again",
    suppresses: [],
  });
}

// G1 — Effective retailers
function computeG1(effectiveRetailers: number | null): WarningCard | null {
  const base = severityBelow(effectiveRetailers, 5, 10, 20);
  if (!base) return null;
  return makeCard({
    code: "G1",
    family: "G",
    title: "Low effective retailers",
    severity: base,
    baseSeverity: base,
    trend: null,
    metric: {
      value: effectiveRetailers,
      label: "Effective retailers (10,000 ÷ HHI)",
      formatted: effectiveRetailers !== null ? effectiveRetailers.toFixed(1) : "—",
    },
    threshold: { red: 5, orange: 10, yellow: 20, direction: "below" },
    source: "member working sheet (concentration.effectiveRetailers = 10,000 ÷ HHI on percentage shares)",
    suggestedAction:
      "Broadening the active base matters more than growing the top accounts",
    suppresses: [],
  });
}

// I1 — Cost ratio drifting
function computeI1(cost: AiPayload["cost"], months: Month[]): WarningCard | null {
  if (!cost || cost.costRatioSale === null) return null;
  const r = cost.costRatioSale;
  // Zero sales received (often a lag month, not performance) → ratio is
  // Infinity/NaN — no meaningful cost signal, don't fire.
  if (!Number.isFinite(r)) return null;
  // Strict "above" semantics — exactly 6/10/15 % does not fire, matching the
  // Sales Deep Dive tile (green ≤ 6, amber ≤ 15, red > 15).
  if (r <= 6) return null;
  const obVals = recordedMonths(months).map((m) => m.orderedAmount);
  const obTrend = detectTrend(obVals);
  // Cost rising faster than business = OB falling while cost exists
  const trend: WarningTrend | null =
    obTrend === "WORSENING" ? "WORSENING" : obTrend === "IMPROVING" ? "IMPROVING" : "STABLE";
  const base: WarningSeverity = r > 15 ? "RED" : r > 10 ? "ORANGE" : "YELLOW";
  if (!base) return null;
  const sev = applyTrend(base, trend);
  return makeCard({
    code: "I1",
    family: "I",
    title: "Cost ratio drifting",
    severity: sev,
    baseSeverity: base,
    trend,
    metric: {
      value: r,
      label: "Cost as % of sales received",
      formatted: pctFmt(r),
    },
    threshold: { red: 15, orange: 10, yellow: 6, direction: "above" },
    source: "member working sheet (totalCost / salesReceived × 100)",
    suggestedAction: "Revenue efficiency only — margin needs a cost master that does not exist",
    suppresses: [],
  });
}

// I2 — Cost per visit rising
function computeI2(cost: AiPayload["cost"], months: Month[]): WarningCard | null {
  if (!cost || cost.costPerVisit === null) return null;
  const cpv = cost.costPerVisit;
  const obVals = recordedMonths(months).map((m) => m.orderedAmount);
  const trend: WarningTrend | null =
    detectTrend(obVals) === "WORSENING" ? "WORSENING" : null;
  // Three bands like every other rule: Yellow ≥ ₹1,000, Orange ≥ ₹2,000, Red ≥ ₹3,500.
  if (cpv < 1000 && trend !== "WORSENING") return null;
  const base: WarningSeverity =
    cpv >= 3500 ? "RED" : cpv >= 2000 ? "ORANGE" : "YELLOW";
  const sev = trend === "WORSENING" ? applyTrend(base, "WORSENING") : base;
  return makeCard({
    code: "I2",
    family: "I",
    title: "Cost per visit rising",
    severity: sev,
    baseSeverity: base,
    trend,
    metric: {
      value: cpv,
      label: "Cost per visit (₹)",
      formatted: `₹${Math.round(cpv).toLocaleString("en-IN")}`,
    },
    threshold: { red: 3500, orange: 2000, yellow: 1000, direction: "above" },
    source: "member working sheet (totalCost / visitsActual)",
    suggestedAction: "Read with the visit-productivity warning, not alone",
    suppresses: [],
  });
}

// J1 — No working sheet mapped
function makeJ1(): WarningCard {
  return makeCard({
    code: "J1",
    family: "J",
    title: "No working sheet mapped",
    severity: "NOT_AVAILABLE",
    baseSeverity: "NOT_AVAILABLE",
    trend: null,
    metric: { value: null, label: "Working sheet", formatted: "ABSENT" },
    threshold: { direction: "above" },
    source: "deep-dive configuration",
    suggestedAction:
      "Map a working sheet to enable retailer and visit analytics for this member",
    notAvailableReason:
      "Detail is ABSENT, not zero. No performance warnings can be drawn.",
    suppresses: [],
  });
}

// J2 — Booking with zero sale
function makeJ2(totalOB: number): WarningCard {
  return makeCard({
    code: "J2",
    family: "J",
    title: "Booking with zero sale",
    severity: "ORANGE",
    baseSeverity: "ORANGE",
    trend: null,
    metric: {
      value: totalOB,
      label: "Order booking present, sale exactly zero",
      formatted: `₹${Math.round(totalOB).toLocaleString("en-IN")} booked, sale = 0`,
    },
    threshold: { direction: "above" },
    source: "member working sheet (totalOB > 0, salesReceived = 0)",
    suggestedAction:
      "Confirm before assessing anyone — may be an unmaintained sale column",
    suppresses: [],
  });
}

// J3 — Partial tenure
function makeJ3(workingDaysActual: number, teamNorm: number): WarningCard {
  return makeCard({
    code: "J3",
    family: "J",
    title: "Partial tenure",
    severity: "NOT_AVAILABLE",
    baseSeverity: "NOT_AVAILABLE",
    trend: null,
    metric: {
      value: workingDaysActual,
      label: "Working days (member vs team norm)",
      formatted: `${workingDaysActual} days vs ~${teamNorm} team norm`,
    },
    threshold: { direction: "below" },
    source: "member working sheet (AG column — actual working days)",
    suggestedAction:
      "Suppress performance warnings — the basis is not comparable at full-period rates",
    notAvailableReason:
      "Working days are well below the team norm. Achievement and pace ratios are not comparable.",
    suppresses: [],
  });
}

// J4 — Cross-year key split
function makeJ4(memberName: string, splitNote: string): WarningCard {
  return makeCard({
    code: "J4",
    family: "J",
    title: "Cross-year key split",
    severity: "NOT_AVAILABLE",
    baseSeverity: "NOT_AVAILABLE",
    trend: null,
    metric: {
      value: null,
      label: "Key consistency across fiscal years",
      formatted: splitNote,
    },
    threshold: { direction: "above" },
    source: "cross-FY identity check",
    suggestedAction:
      "Suppress all year-on-year comparisons for this member — they will show last year as zero",
    notAvailableReason: splitNote,
    suppresses: [],
  });
}

// J5 — Cutoff lag
function computeJ5(dataCutoff: string): WarningCard | null {
  const cutoffDate = new Date(dataCutoff);
  const daysLag = Math.floor((Date.now() - cutoffDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysLag <= 7) return null;
  const base: WarningSeverity = daysLag >= 60 ? "RED" : daysLag >= 30 ? "ORANGE" : "YELLOW";
  return makeCard({
    code: "J5",
    family: "J",
    title: "Data cutoff lag",
    severity: base,
    baseSeverity: base,
    trend: null,
    metric: {
      value: daysLag,
      label: "Days since data cutoff",
      formatted: `${daysLag} days (cutoff: ${dataCutoff})`,
    },
    threshold: { red: 60, orange: 30, yellow: 7, direction: "above" },
    source: "data pipeline (last ingested invoice date)",
    suggestedAction: "Every warning on the page is as old as the cutoff",
    suppresses: [],
  });
}

// ── Suppression application ───────────────────────────────────────────────────

function applySuppression(warnings: WarningCard[]): WarningCard[] {
  const suppressors = warnings.filter(
    (w) => w.suppresses.length > 0 && w.severity === "RED",
  );
  if (suppressors.length === 0) return warnings;

  const suppressedCodes = new Set<string>();
  for (const sup of suppressors) {
    for (const code of sup.suppresses) suppressedCodes.add(code);
  }

  // J3 suppressors (J3 is NOT_AVAILABLE, always suppress regardless)
  const j3 = warnings.find((w) => w.code === "J3");
  const j3Suppresses = ["A1", "A2", "C1", "C2"];
  if (j3) {
    for (const code of j3Suppresses) suppressedCodes.add(code);
  }

  // J1 suppressors
  const j1 = warnings.find((w) => w.code === "J1");
  if (j1) {
    for (const w of warnings) {
      if (w.family !== "J") suppressedCodes.add(w.code);
    }
  }

  return warnings.map((w) => {
    if (suppressedCodes.has(w.code) && w.code !== w.code) return w; // self-suppression guard
    const suppressorCode = suppressors.find((s) => s.suppresses.includes(w.code))?.code
      ?? (j3 && j3Suppresses.includes(w.code) ? "J3" : null)
      ?? (j1 && w.family !== "J" ? "J1" : null);
    if (suppressorCode) {
      return { ...w, suppressedBy: suppressorCode };
    }
    return w;
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeMemberWarnings(opts: {
  payload: AiPayload;
  rows: RetailerRow[];
  kpisWorkingDaysActual: number | null;
  secMemberMonths: Month[] | null;
  elapsedFraction: number;
  // Per-member elapsed fraction from the sheet's BD column (elapsedMonths/12).
  // Used for all pace pro-rating (A2, C1) so a member present for 1.5 of 4
  // elapsed months is not measured against the full team period.
  memberElapsedFraction?: number | null;
  teamNormWorkingDays: number;
  // Partial-tenure cutoff in working days — derived from the team median by
  // the caller (0.85 × median), never hardcoded.
  partialTenureCutoffDays?: number;
}): WarningCard[] {
  const { payload, rows, kpisWorkingDaysActual, secMemberMonths, elapsedFraction, teamNormWorkingDays } = opts;
  const paceElapsedFraction =
    opts.memberElapsedFraction != null && opts.memberElapsedFraction > 0
      ? opts.memberElapsedFraction
      : elapsedFraction;
  const partialCutoff = opts.partialTenureCutoffDays ?? 55;
  const months = secMemberMonths ?? [];
  const warnings: WarningCard[] = [];

  // ── J flags ────────────────────────────────────────────────────────────────
  const hasMappedSheet = rows.length > 0 || payload.visits?.done != null;
  if (!hasMappedSheet) {
    warnings.push(makeJ1());
    return applySuppression(warnings);
  }

  const { totalOB, salesReceived } = payload.performance;
  const isPartialTenure =
    kpisWorkingDaysActual != null && kpisWorkingDaysActual < partialCutoff;
  if (isPartialTenure) {
    warnings.push(makeJ3(kpisWorkingDaysActual!, teamNormWorkingDays));
  }

  // J2 only where a month is genuinely closed AND recorded with booking but
  // zero sale. If every booked month is still a lag month (sales entry
  // pending), zero sales is a data-entry delay — no warning.
  if ((totalOB ?? 0) > 0 && salesReceived === 0) {
    const bookedMonths = months.filter((m) => m.orderedAmount > 0);
    // With month data: fire only when a RECORDED booked month shows zero sale
    // (month-level fact). Without month data: keep the aggregate behaviour.
    const genuineZero =
      bookedMonths.length > 0
        ? bookedMonths.some((m) => !m.notYetRecorded && m.salesAmount === 0)
        : true;
    if (genuineZero) warnings.push(makeJ2(totalOB!));
  }

  const j5 = computeJ5(payload.identity.dataCutoff);
  if (j5) warnings.push(j5);

  // J4 — cross-year key split
  const memberName = payload.identity.member ?? "";
  const splitNote = CROSS_FY_KEY_SPLITS[normKey(memberName)];
  if (splitNote) warnings.push(makeJ4(memberName, splitNote));

  // ── D warnings (compute unassigned from rows) ──────────────────────────────
  const isUnassigned = (r: RetailerRow) =>
    !r.distributor || r.distributor.trim() === "" || r.distributor.trim() === "--";
  const unassignedRows = rows.filter(isUnassigned);
  const totalRows = rows.length;

  const d1 = computeD1(unassignedRows.length, totalRows);
  if (d1) warnings.push(d1);

  const visitsToUnassigned = unassignedRows.reduce((s, r) => s + (r.totalVisit ?? 0), 0);
  const d2 = computeD2(visitsToUnassigned, unassignedRows.length, payload.visits?.done ?? null);
  if (d2) warnings.push(d2);

  const d3 = computeD3(rows);
  if (d3) warnings.push(d3);

  // ── A warnings ─────────────────────────────────────────────────────────────
  if (!isPartialTenure) {
    const a1 = computeA1(payload.achievement.totalOBPct, months, totalOB);
    if (a1) warnings.push(a1);

    const a2 = computeA2(totalOB, payload.targets.businessPlan, paceElapsedFraction, months);
    if (a2) warnings.push(a2);
  }

  const a3 = computeA3(months);
  if (a3) warnings.push(a3);

  const a4 = computeA4(totalOB, salesReceived, months);
  if (a4) warnings.push(a4);

  // ── C warnings ─────────────────────────────────────────────────────────────
  if (!isPartialTenure) {
    const c1 = computeC1(payload.visits, paceElapsedFraction);
    if (c1) warnings.push(c1);

    const c2 = computeC2(payload.visits, totalOB, months);
    if (c2) warnings.push(c2);
  } else {
    // Even for partial tenure, show C1 as NOT_AVAILABLE if required is null
    if (payload.visits?.required === null || payload.visits?.required === 0) {
      const c1Na = computeC1(payload.visits, paceElapsedFraction);
      if (c1Na?.severity === "NOT_AVAILABLE") warnings.push(c1Na);
    }
  }

  const c3 = computeC3(payload.visits, payload.coverage);
  if (c3) warnings.push(c3);

  // ── E warnings ─────────────────────────────────────────────────────────────
  const e1 = computeE1(rows);
  if (e1) warnings.push(e1);

  const e2 = computeE2(payload.customerStates, payload.coverage);
  if (e2) warnings.push(e2);

  const e3 = computeE3(payload.customerStates);
  if (e3) warnings.push(e3);

  const e4 = computeE4(payload.customerStates);
  if (e4) warnings.push(e4);

  // ── G warnings ─────────────────────────────────────────────────────────────
  const g1 = computeG1(payload.concentration?.effectiveRetailers ?? null);
  if (g1) warnings.push(g1);

  // ── I warnings ─────────────────────────────────────────────────────────────
  const i1 = computeI1(payload.cost, months);
  if (i1) warnings.push(i1);

  const i2 = computeI2(payload.cost, months);
  if (i2) warnings.push(i2);

  return applySuppression(warnings);
}

// ── Split warnings into root / suppressed / J flags ──────────────────────────

export function splitWarnings(all: WarningCard[]): {
  rootWarnings: WarningCard[];
  suppressedWarnings: WarningCard[];
  jFlags: WarningCard[];
} {
  const jFlags = all.filter((w) => w.family === "J");
  const performance = all.filter((w) => w.family !== "J");
  return {
    jFlags,
    rootWarnings: performance.filter((w) => !w.suppressedBy),
    suppressedWarnings: performance.filter((w) => !!w.suppressedBy),
  };
}

// ── Unassigned stats for team summary ────────────────────────────────────────

export function computeUnassignedStats(rows: RetailerRow[]): {
  unassignedCount: number;
  visitsToUnassigned: number;
  retailersTotal: number;
} {
  const isUnassigned = (r: RetailerRow) =>
    !r.distributor || r.distributor.trim() === "" || r.distributor.trim() === "--";
  const unassigned = rows.filter(isUnassigned);
  return {
    retailersTotal: rows.length,
    unassignedCount: unassigned.length,
    visitsToUnassigned: unassigned.reduce((s, r) => s + (r.totalVisit ?? 0), 0),
  };
}
