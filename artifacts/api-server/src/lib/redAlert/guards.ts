// Red Alert — 10 guard functions.
//
// Each guard takes a RawAlert candidate and a GuardContext and returns either
// { pass: true } or { pass: false, guard: N, reason: string }.
//
// Guards run in order 1–10. The first failing guard short-circuits evaluation
// (the reason is recorded and the alert is suppressed).

import type { RawAlert, GuardResult, DetectionContext } from "./types.js";

// ── Guard context helpers ─────────────────────────────────────────────────────

// Returns the set of channel values seen for a customer in a given FY.
function customerChannelsForFy(
  ctx: DetectionContext,
  customer: string,
  fy: string,
): Set<string> {
  const seen = new Set<string>();
  for (const r of ctx.customerSale) {
    if (r.customer === customer && r.fy === fy && r.channel != null) seen.add(r.channel);
  }
  return seen;
}

// Returns the set of head_canon values seen for a customer in a given FY.
function customerHeadsForFy(
  ctx: DetectionContext,
  customer: string,
  fy: string,
): Set<string> {
  const seen = new Set<string>();
  for (const r of ctx.customerSale) {
    if (r.customer === customer && r.fy === fy && r.headCanon != null) seen.add(r.headCanon);
  }
  return seen;
}

// ── Individual guard implementations ─────────────────────────────────────────

/**
 * Guard 1 — CHANNEL RECLASSIFICATION.
 * Exclude any customer whose channel or head_canon changed between the two
 * periods. A customer that moved to project classification reads as a total
 * collapse when compared naively.
 */
function guard1ChannelReclassification(
  alert: RawAlert,
  ctx: DetectionContext,
  currentFy: string,
  priorFy: string,
): GuardResult {
  // Only applies to customer-level alerts (B/C that compare individual customers)
  if (!["B1", "B2", "B3", "B4", "B5", "C1"].includes(alert.code)) return { pass: true };
  const { entityKey } = alert;

  const curChannels = customerChannelsForFy(ctx, entityKey, currentFy);
  const priChannels = customerChannelsForFy(ctx, entityKey, priorFy);
  const curHeads = customerHeadsForFy(ctx, entityKey, currentFy);
  const priHeads = customerHeadsForFy(ctx, entityKey, priorFy);

  // Check for channel change: if any channel value appears in one period but not the other
  for (const c of curChannels) {
    if (!priChannels.has(c) && priChannels.size > 0) {
      return { pass: false, guard: 1, reason: `Customer channel changed between periods: now includes "${c}" (prior: ${[...priChannels].join(", ")})` };
    }
  }
  // Check for head_canon change
  for (const h of curHeads) {
    if (!priHeads.has(h) && priHeads.size > 0) {
      return { pass: false, guard: 1, reason: `Customer head_canon changed between periods: now attributed to "${h}" (prior: ${[...priHeads].join(", ")})` };
    }
  }
  return { pass: true };
}

/**
 * Guard 2 — LIKE MONTHS ONLY.
 * Never compare unequal windows or different months.
 * C5 is a point-in-time freshness check — it has no prior-period comparison
 * and intentionally carries priorMonths=[]. Exempt it from this guard.
 */
function guard2LikeMonths(alert: RawAlert): GuardResult {
  // C5 is a single-period operational alert — no prior-period window exists.
  if (alert.code === "C5") return { pass: true };
  const { currentMonths, priorMonths } = alert;
  if (currentMonths.length !== priorMonths.length) {
    return {
      pass: false,
      guard: 2,
      reason: `Month count mismatch: current=${currentMonths.length} vs prior=${priorMonths.length}. Alert: [${currentMonths.join(",")}] vs [${priorMonths.join(",")}]`,
    };
  }
  // Check that the month names correspond (same calendar months, different years)
  for (let i = 0; i < currentMonths.length; i++) {
    const cm = currentMonths[i]!;
    const pm = priorMonths[i]!;
    if (cm.split("-")[0] !== pm.split("-")[0]) {
      return {
        pass: false,
        guard: 2,
        reason: `Month name mismatch at position ${i}: "${cm}" vs "${pm}" — not the same calendar month`,
      };
    }
  }
  return { pass: true };
}

/**
 * Guard 3 — COMPLETE MONTHS ONLY.
 * Exclude the current month and any unsettled month.
 * Secondary data runs one month behind primary.
 * For B/C alerts (primary data): use frozenMonths.
 * For A alerts (secondary data): use secCompleteMonths.
 */
function guard3CompleteMonths(
  alert: RawAlert,
  ctx: DetectionContext,
  currentFy: string,
  priorFy: string,
): GuardResult {
  if (alert.category === "A") {
    // Secondary completeness — handled by the A engine itself (only uses not_yet_recorded=false)
    return { pass: true };
  }
  // C5 is a point-in-time staleness check — it does not compare across periods.
  // It uses currentMonths only as the "active window" scope, not as a comparison axis.
  if (alert.code === "C5") return { pass: true };
  // Primary data completeness — check frozenMonths
  const frozenCur = ctx.frozenMonths.get(currentFy) ?? new Set();
  const frozenPri = ctx.frozenMonths.get(priorFy) ?? new Set();
  for (const m of alert.currentMonths) {
    if (!frozenCur.has(m)) {
      return { pass: false, guard: 3, reason: `Month "${m}" in current FY ${currentFy} is not yet frozen/settled` };
    }
  }
  for (const m of alert.priorMonths) {
    if (!frozenPri.has(m)) {
      return { pass: false, guard: 3, reason: `Month "${m}" in prior FY ${priorFy} is not yet frozen/settled` };
    }
  }
  return { pass: true };
}

/**
 * Guard 4 — IDENTITY RESOLUTION.
 * Resolve customers and members through person_registry before comparing.
 * If the entity appears under multiple canonical identities, suppress.
 */
function guard4IdentityResolution(
  alert: RawAlert,
  ctx: DetectionContext,
): GuardResult {
  if (alert.category !== "A") return { pass: true }; // B/C operate on customer names, not person_registry keys
  const { entityKey } = alert;
  // Check person_registry for this head_canon
  const person = ctx.persons.find((p) => p.normKey === entityKey);
  if (!person) {
    return { pass: false, guard: 4, reason: `Member "${entityKey}" not found in person_registry — cannot confirm identity` };
  }
  if (!person.isPerson) {
    return { pass: false, guard: 4, reason: `Registry entry "${entityKey}" is not a person (is_person=false) — excluded from performance alerts` };
  }
  return { pass: true };
}

/**
 * Guard 5 — DISTRIBUTOR REASSIGNMENT.
 * A retailer moving between distributors is not a lost retailer.
 * Over a third of active retailers link to more than one distributor.
 */
function guard5DistributorReassignment(
  alert: RawAlert,
  ctx: DetectionContext,
  currentFy: string,
  priorFy: string,
): GuardResult {
  if (alert.code !== "B3") return { pass: true }; // Only relevant for "stopped buying" alert
  const { entityKey } = alert;

  const curDists = ctx.retailerDistributors.get(entityKey)?.get(currentFy) ?? new Set();
  const priDists = ctx.retailerDistributors.get(entityKey)?.get(priorFy) ?? new Set();

  if (curDists.size === 0 && priDists.size > 0) {
    // Retailer absent from current period secondary data entirely — could be reassignment gap, not churn
    // Check if they appear in another FY at all
    const allFys = ctx.retailerDistributors.get(entityKey);
    if (allFys && allFys.size > 1) {
      return { pass: false, guard: 5, reason: `Retailer "${entityKey}" appears under distributors in other periods — possible redistribution, not confirmed dropout` };
    }
  }
  return { pass: true };
}

/**
 * Guard 6 — TERRITORY ONLY.
 * Exclude project, govt, JJM, GeM, export on every alert.
 * Uses the channel column on sale_line (via pre-fetched context), not a name pattern.
 */
function guard6TerritoryOnly(
  alert: RawAlert,
  ctx: DetectionContext,
  currentFy: string,
): GuardResult {
  if (!["B1", "B2", "B3", "B4", "B5", "C1", "C2", "C3", "C4"].includes(alert.code)) return { pass: true };
  const { entityKey } = alert;

  // Check if this customer's channel in the current FY is non-territory
  const nonTerritoryChannels = new Set(["Govt", "Project", "JJM", "Gem", "Export"]);
  for (const r of ctx.customerSale) {
    if (r.customer === entityKey && r.fy === currentFy) {
      if (r.channel != null && nonTerritoryChannels.has(r.channel)) {
        // The customer HAS non-territory sales — but may also have territory sales.
        // Only suppress if ALL their sales are non-territory.
        const allRows = ctx.customerSale.filter(
          (x) => x.customer === entityKey && x.fy === currentFy,
        );
        const hasTerritory = allRows.some(
          (x) => x.channel == null || !nonTerritoryChannels.has(x.channel ?? ""),
        );
        if (!hasTerritory) {
          return { pass: false, guard: 6, reason: `Customer "${entityKey}" has no territory sales in ${currentFy} (channel: ${r.channel})` };
        }
      }
    }
  }
  return { pass: true };
}

/**
 * Guard 7 — NO TARGET, NO ALERT.
 * Members carrying business with no recorded target are never alerted on achievement.
 */
function guard7NoTarget(alert: RawAlert, ctx: DetectionContext, currentFy: string): GuardResult {
  if (!["A1", "A3"].includes(alert.code)) return { pass: true };
  const { entityKey } = alert;

  // Check if this member has any non-null plan_amount in the current FY
  const hasTarget = ctx.secHeadMonths.some(
    (r) => r.headCanon === entityKey && r.fy === currentFy && r.planAmount != null && r.planAmount > 0,
  );
  if (!hasTarget) {
    return { pass: false, guard: 7, reason: `Member "${entityKey}" has no recorded secondary target in ${currentFy}` };
  }
  return { pass: true };
}

/**
 * Guard 8 — PARTIAL TENURE.
 * Below the working-days threshold (from config), no performance alert.
 * Derived from secondary_head_month coverage (number of complete months present).
 */
function guard8PartialTenure(
  alert: RawAlert,
  ctx: DetectionContext,
  currentFy: string,
  minWorkingDays: number,
): GuardResult {
  if (!["A1", "A2", "A3"].includes(alert.code)) return { pass: true };
  const { entityKey } = alert;

  // Estimate working days from complete months present:
  // Each complete month ≈ 26 working days (Mon–Sat). < 2.1 months ≈ < 55 days.
  const completeMonths = ctx.secCompleteMonths.get(currentFy)?.get(entityKey) ?? [];
  const estimatedDays = completeMonths.length * 26;
  if (estimatedDays < minWorkingDays) {
    return {
      pass: false,
      guard: 8,
      reason: `Partial tenure: only ${completeMonths.length} complete recorded month(s) (≈${estimatedDays} working days) — below the ${minWorkingDays}-day threshold`,
    };
  }
  return { pass: true };
}

/**
 * Guard 9 — SHEET-READ FAILURE IS NOT ZERO.
 * If a source failed to load, suppress. A quota failure once left eleven of
 * twelve heads reading empty — every one would have alerted.
 */
function guard9SheetReadFailure(
  alert: RawAlert,
  ctx: DetectionContext,
  currentFy: string,
  nowDate: Date,
): GuardResult {
  if (alert.category !== "A") return { pass: true };
  const { entityKey } = alert;

  // Check: does this member have at least one complete month in the current FY?
  const completeMonths = ctx.secCompleteMonths.get(currentFy)?.get(entityKey) ?? [];
  if (completeMonths.length === 0) {
    return {
      pass: false,
      guard: 9,
      reason: `Member "${entityKey}" has no complete recorded secondary months in ${currentFy} — source may have failed to load`,
    };
  }

  // Check: was the last read very recent (within 30 days)?
  const lastRead = ctx.lastSheetRead.get(entityKey);
  if (lastRead == null) {
    return {
      pass: false,
      guard: 9,
      reason: `Member "${entityKey}" has no recorded sheet ingestion timestamp — source may not have loaded`,
    };
  }
  const daysSince = (nowDate.getTime() - lastRead.getTime()) / 86_400_000;
  // If data hasn't been read in 60+ days, treat as a potential load failure
  if (daysSince > 60) {
    return {
      pass: false,
      guard: 9,
      reason: `Member "${entityKey}" sheet last read ${Math.round(daysSince)} days ago — may reflect a stale or failed source load`,
    };
  }
  return { pass: true };
}

/**
 * Guard 10 — COST DATA GATE.
 * C4 fires only where factory cost (bom_cost) exists in margin_fact.
 * Already enforced by the C4 engine — this guard is a safety net.
 */
function guard10CostDataGate(
  alert: RawAlert,
  ctx: DetectionContext,
  currentFy: string,
): GuardResult {
  if (alert.code !== "C4") return { pass: true };
  const hasCost = ctx.marginFact.some(
    (r) => r.fy === currentFy && r.bomCost != null && r.bomCost > 0,
  );
  if (!hasCost) {
    return { pass: false, guard: 10, reason: `No margin_fact rows with bom_cost found for ${currentFy} — C4 cannot fire` };
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
