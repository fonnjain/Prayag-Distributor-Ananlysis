// Red Alert — 10 guard functions.
//
// Each guard takes a RawAlert candidate and returns either
// { pass: true } or { pass: false, guard: N, reason: string }.
//
// Guards run in order 1–10. The first failing guard short-circuits evaluation.
//
// Guard applicability by alert code:
//   G1  — B/C customer-level only
//   G2  — all EXCEPT C5 (C5 has no prior-period comparison)
//   G3  — B/C EXCEPT C5 (C5 is a freshness check, not a period comparison)
//   G4  — A1, A2 only (NOT A3 — A3 is a team aggregate, not a person key)
//   G5  — B3 only
//   G6  — B1-B5, C1-C4 (customer-level territory check)
//   G7  — A1, A2 only (NOT A3 — A3 aggregates member targets internally)
//   G8  — A1, A2 only (NOT A3 — A3 uses member-count, not single-member tenure)
//   G9  — A1, A2 only
//   G10 — C4 only

import type { RawAlert, GuardResult, DetectionContext } from "./types.js";

// ── Guard context helpers ─────────────────────────────────────────────────────

// Uses customerMeta (unfiltered — no is_territory filter) so that customers
// reclassified to Project/Govt/non-territory still appear in the current window.
// Scoped to the alert's window months so out-of-window changes can't suppress.
function customerChannelsForWindow(
  ctx: DetectionContext, customer: string, fy: string, months: string[],
): Set<string> {
  const ms = new Set(months);
  const seen = new Set<string>();
  for (const r of ctx.customerMeta) {
    if (r.customer === customer && r.fy === fy && ms.has(r.monthLabel) && r.channel != null) {
      seen.add(r.channel);
    }
  }
  return seen;
}

function customerHeadsForWindow(
  ctx: DetectionContext, customer: string, fy: string, months: string[],
): Set<string> {
  const ms = new Set(months);
  const seen = new Set<string>();
  for (const r of ctx.customerMeta) {
    if (r.customer === customer && r.fy === fy && ms.has(r.monthLabel) && r.headCanon != null) {
      seen.add(r.headCanon);
    }
  }
  return seen;
}

// Returns the set of distributors serving a retailer within a specific set of months in a FY.
// Uses the month-keyed retailerDistributors map so only within-window attribution is considered.
function distForWindow(
  ctx: DetectionContext, retailer: string, fy: string, months: string[],
): Set<string> {
  const out = new Set<string>();
  const retailerMap = ctx.retailerDistributors.get(retailer);
  if (!retailerMap) return out;
  for (const month of months) {
    const key = `${fy}|${month}`;
    for (const d of retailerMap.get(key) ?? []) out.add(d);
  }
  return out;
}

// ── Guard implementations ─────────────────────────────────────────────────────

/**
 * Guard 1 — CHANNEL RECLASSIFICATION.
 * Exclude customers whose channel or head_canon changed between the two periods.
 * A customer reclassified as project reads as a total collapse when compared naively.
 */
function guard1ChannelReclassification(
  alert: RawAlert, ctx: DetectionContext, currentFy: string, priorFy: string,
): GuardResult {
  if (!["B1", "B2", "B3", "B4", "B5", "C1"].includes(alert.code)) return { pass: true };
  const { entityKey, currentMonths, priorMonths } = alert;

  // Uses customerMeta (unfiltered) and is scoped to the alert's own window months.
  // Uses symmetric comparison: flag if ANY value appears in one window but not the other,
  // including the case where the current set is empty (customer moved out of territory).
  const curChannels = customerChannelsForWindow(ctx, entityKey, currentFy, currentMonths);
  const priChannels = customerChannelsForWindow(ctx, entityKey, priorFy, priorMonths);
  const curHeads = customerHeadsForWindow(ctx, entityKey, currentFy, currentMonths);
  const priHeads = customerHeadsForWindow(ctx, entityKey, priorFy, priorMonths);

  // Symmetric channel check — catches both new channels (current-only) and lost channels
  // (prior-only, including the empty-current case where every prior channel is "lost").
  if (priChannels.size > 0) {
    for (const c of priChannels) {
      if (!curChannels.has(c)) {
        return {
          pass: false, guard: 1,
          reason: `Customer channel changed within window: prior had "${c}", `
            + `current has ${curChannels.size > 0 ? `"${[...curChannels].join('", "')}"` : "no channel rows (possible non-territory reclassification)"}`,
        };
      }
    }
    for (const c of curChannels) {
      if (!priChannels.has(c)) {
        return { pass: false, guard: 1, reason: `Customer gained channel "${c}" in current window (prior: ${[...priChannels].join(", ")})` };
      }
    }
  }

  // Symmetric head_canon check
  if (priHeads.size > 0) {
    for (const h of priHeads) {
      if (!curHeads.has(h)) {
        return {
          pass: false, guard: 1,
          reason: `Customer head_canon changed within window: prior had "${h}", `
            + `current has ${curHeads.size > 0 ? `"${[...curHeads].join('", "')}"` : "no head rows"}`,
        };
      }
    }
    for (const h of curHeads) {
      if (!priHeads.has(h)) {
        return { pass: false, guard: 1, reason: `Customer head_canon added "${h}" in current window (prior: ${[...priHeads].join(", ")})` };
      }
    }
  }

  return { pass: true };
}

/**
 * Guard 2 — LIKE MONTHS ONLY.
 * Never compare unequal windows or different calendar months.
 * C5 is a point-in-time freshness check with priorMonths=[] by design — exempt.
 */
function guard2LikeMonths(alert: RawAlert): GuardResult {
  if (alert.code === "C5") return { pass: true };
  const { currentMonths, priorMonths } = alert;
  if (currentMonths.length !== priorMonths.length) {
    return {
      pass: false, guard: 2,
      reason: `Month count mismatch: current=${currentMonths.length} vs prior=${priorMonths.length}. `
        + `Alert: [${currentMonths.join(",")}] vs [${priorMonths.join(",")}]`,
    };
  }
  for (let i = 0; i < currentMonths.length; i++) {
    const cm = currentMonths[i]!;
    const pm = priorMonths[i]!;
    if (cm.split("-")[0] !== pm.split("-")[0]) {
      return {
        pass: false, guard: 2,
        reason: `Month name mismatch at position ${i}: "${cm}" vs "${pm}" — not the same calendar month`,
      };
    }
  }
  return { pass: true };
}

/**
 * Guard 3 — COMPLETE MONTHS ONLY.
 * For B/C category (primary data): use frozenMonths.
 * For A category: completeness is handled by the A engine (not_yet_recorded=false).
 * C5: a point-in-time freshness check — does not require period completeness.
 */
function guard3CompleteMonths(
  alert: RawAlert, ctx: DetectionContext, currentFy: string, priorFy: string,
): GuardResult {
  if (alert.category === "A") return { pass: true };
  if (alert.code === "C5") return { pass: true }; // operational freshness alert — no period dependency
  const frozenCur = ctx.frozenMonths.get(currentFy) ?? new Set<string>();
  const frozenPri = ctx.frozenMonths.get(priorFy) ?? new Set<string>();
  for (const m of alert.currentMonths) {
    if (!frozenCur.has(m)) {
      return { pass: false, guard: 3, reason: `Month "${m}" in ${currentFy} not yet frozen` };
    }
  }
  for (const m of alert.priorMonths) {
    if (!frozenPri.has(m)) {
      return { pass: false, guard: 3, reason: `Month "${m}" in ${priorFy} not yet frozen` };
    }
  }
  return { pass: true };
}

/**
 * Guard 4 — IDENTITY RESOLUTION.
 * A1 and A2 only: resolve individual members through person_registry.
 * A3 is a team-level alert keyed on a state-head name, not a person norm_key —
 * the person_registry lookup would always fail for it and must not apply.
 */
function guard4IdentityResolution(alert: RawAlert, ctx: DetectionContext): GuardResult {
  if (!["A1", "A2"].includes(alert.code)) return { pass: true };
  const { entityKey } = alert;
  const person = ctx.persons.find((p) => p.normKey === entityKey);
  if (!person) {
    return { pass: false, guard: 4, reason: `Member "${entityKey}" not found in person_registry` };
  }
  if (!person.isPerson) {
    return { pass: false, guard: 4, reason: `Registry entry "${entityKey}" is not a person (is_person=false)` };
  }
  return { pass: true };
}

/**
 * Guard 5 — DISTRIBUTOR REASSIGNMENT.
 * A retailer moving between distributors is NOT a lost retailer.
 * Suppress B3 whenever:
 *   (a) the retailer's distributor set differs between the two periods, OR
 *   (b) the retailer is absent from current-period secondary data but was
 *       present in the prior period (possible redistribution gap).
 */
function guard5DistributorReassignment(
  alert: RawAlert, ctx: DetectionContext, currentFy: string, priorFy: string,
): GuardResult {
  if (alert.code !== "B3") return { pass: true };
  const { entityKey, currentMonths, priorMonths } = alert;

  // Compare distributor sets scoped to the alert's window months only — a
  // reassignment that happens outside the compared window must not suppress
  // a legitimate within-window zero-purchase finding.
  const curDists = distForWindow(ctx, entityKey, currentFy, currentMonths);
  const priDists = distForWindow(ctx, entityKey, priorFy, priorMonths);

  if (priDists.size === 0) return { pass: true }; // no prior attribution in window — can't assess

  // (a) Distributor set changed between the two windows (any addition or removal)
  const changedDistributors =
    [...priDists].some((d) => !curDists.has(d)) ||
    [...curDists].some((d) => !priDists.has(d));

  if (changedDistributors) {
    return {
      pass: false, guard: 5,
      reason: `Retailer "${entityKey}" served by different distributors within the alert windows `
        + `(prior window: ${[...priDists].join(", ")}; current window: ${curDists.size > 0 ? [...curDists].join(", ") : "none"}) `
        + `— possible redistribution, not confirmed dropout`,
    };
  }

  // (b) Absent from current window but attributed in prior window — redistribution gap
  if (curDists.size === 0 && priDists.size > 0) {
    return {
      pass: false, guard: 5,
      reason: `Retailer "${entityKey}" absent from current-window secondary data `
        + `but had distributor attribution in the prior window — possible redistribution gap`,
    };
  }

  return { pass: true };
}

/**
 * Guard 6 — TERRITORY ONLY.
 * Exclude customers whose primary channel is non-territory (Govt, Project, etc.).
 * Only fires when ALL of a customer's sales are non-territory in the current FY.
 */
function guard6TerritoryOnly(alert: RawAlert, ctx: DetectionContext, currentFy: string): GuardResult {
  if (!["B1", "B2", "B3", "B4", "B5", "C1", "C2", "C3", "C4"].includes(alert.code)) return { pass: true };
  const { entityKey } = alert;
  const nonTerritoryChannels = new Set(["Govt", "Project", "JJM", "Gem", "Export"]);
  const custRows = ctx.customerSale.filter((r) => r.customer === entityKey && r.fy === currentFy);
  if (custRows.length === 0) return { pass: true };
  const hasTerritory = custRows.some((r) => r.channel == null || !nonTerritoryChannels.has(r.channel ?? ""));
  if (!hasTerritory) {
    const ch = custRows[0]?.channel ?? "unknown";
    return { pass: false, guard: 6, reason: `Customer "${entityKey}" has no territory sales in ${currentFy} (channel: ${ch})` };
  }
  return { pass: true };
}

/**
 * Guard 7 — NO TARGET, NO ALERT.
 * A1 and A2 only: individual member must have a plan_amount > 0 in the current FY.
 * A3 is excluded: the A3 engine already gates on team-level targets internally.
 */
function guard7NoTarget(alert: RawAlert, ctx: DetectionContext, currentFy: string): GuardResult {
  if (!["A1", "A2"].includes(alert.code)) return { pass: true };
  const hasTarget = ctx.secHeadMonths.some(
    (r) => r.headCanon === alert.entityKey && r.fy === currentFy && (r.planAmount ?? 0) > 0,
  );
  if (!hasTarget) {
    return { pass: false, guard: 7, reason: `Member "${alert.entityKey}" has no secondary target in ${currentFy}` };
  }
  return { pass: true };
}

/**
 * Guard 8 — PARTIAL TENURE.
 * A1 and A2 only: individual member must have enough working days.
 * A3 is excluded: the A3 engine measures team complete-month coverage, not
 * individual tenure, and already enforces A3_SUSTAINED_MONTHS internally.
 */
function guard8PartialTenure(
  alert: RawAlert, ctx: DetectionContext, currentFy: string, minWorkingDays: number,
): GuardResult {
  if (!["A1", "A2"].includes(alert.code)) return { pass: true };
  const completeMonths = ctx.secCompleteMonths.get(currentFy)?.get(alert.entityKey) ?? [];
  const estimatedDays = completeMonths.length * 26;
  if (estimatedDays < minWorkingDays) {
    return {
      pass: false, guard: 8,
      reason: `Partial tenure: ${completeMonths.length} complete month(s) (≈${estimatedDays} days) — below ${minWorkingDays}-day threshold`,
    };
  }
  return { pass: true };
}

/**
 * Guard 9 — SHEET-READ FAILURE IS NOT ZERO.
 * A1 and A2 only: suppress if the member's secondary data may have failed to load.
 */
function guard9SheetReadFailure(
  alert: RawAlert, ctx: DetectionContext, currentFy: string, nowDate: Date,
): GuardResult {
  if (!["A1", "A2"].includes(alert.code)) return { pass: true };
  const completeMonths = ctx.secCompleteMonths.get(currentFy)?.get(alert.entityKey) ?? [];
  if (completeMonths.length === 0) {
    return { pass: false, guard: 9, reason: `Member "${alert.entityKey}" has no complete secondary months in ${currentFy}` };
  }
  const lastRead = ctx.lastSheetRead.get(alert.entityKey);
  if (lastRead == null) {
    return { pass: false, guard: 9, reason: `Member "${alert.entityKey}" has no ingestion timestamp` };
  }
  const daysSince = (nowDate.getTime() - lastRead.getTime()) / 86_400_000;
  if (daysSince > 60) {
    return { pass: false, guard: 9, reason: `Member "${alert.entityKey}" sheet last read ${Math.round(daysSince)} days ago` };
  }
  return { pass: true };
}

/**
 * Guard 10 — COST DATA GATE.
 * C4 only: requires factory cost (bom_cost) to exist in margin_fact for the current FY.
 */
function guard10CostDataGate(alert: RawAlert, ctx: DetectionContext, currentFy: string): GuardResult {
  if (alert.code !== "C4") return { pass: true };
  const hasCost = ctx.marginFact.some((r) => r.fy === currentFy && r.bomCost != null && r.bomCost > 0);
  if (!hasCost) {
    return { pass: false, guard: 10, reason: `No margin_fact rows with bom_cost found for ${currentFy}` };
  }
  return { pass: true };
}

// ── Main exported function ────────────────────────────────────────────────────

export function runGuards(
  alert: RawAlert,
  ctx: DetectionContext,
  currentFy: string,
  priorFy: string,
  nowDate: Date,
  minWorkingDays: number,
): GuardResult {
  const checks: GuardResult[] = [
    guard1ChannelReclassification(alert, ctx, currentFy, priorFy),
    guard2LikeMonths(alert),
    guard3CompleteMonths(alert, ctx, currentFy, priorFy),
    guard4IdentityResolution(alert, ctx),
    guard5DistributorReassignment(alert, ctx, currentFy, priorFy),
    guard6TerritoryOnly(alert, ctx, currentFy),
    guard7NoTarget(alert, ctx, currentFy),
    guard8PartialTenure(alert, ctx, currentFy, minWorkingDays),
    guard9SheetReadFailure(alert, ctx, currentFy, nowDate),
    guard10CostDataGate(alert, ctx, currentFy),
  ];
  for (const result of checks) {
    if (!result.pass) return result;
  }
  return { pass: true };
}
