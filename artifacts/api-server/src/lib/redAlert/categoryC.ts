// Red Alert — Category C (territory/segment/operational) engine.
// C1: a customer >= 60% of a state's value declines >= 15%.
// C2: a state's territory value down >= 15%, sustained 2 periods.
// C3: a segment >= 20 pts below company rate; only fires when the comparison
//     window covers >= 20% of annual seasonal weight (prevents noise from 1-month views).
// C4: volume up while gross contribution down >= 15% (gate: bom_cost exists).
// C5: a head's working sheet not read for >= 10 days (operational, open-FY only).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { RawAlert, DetectionContext } from "./types.js";
import {
  isLegacyNumericSourceKey,
  resolveUniquePersonIdentityKey,
} from "../employeeCodeIdentity.js";

type CConfig = {
  C1_CONCENTRATION_SHARE_PCT: number;
  C1_DECLINE_PCT: number;
  C2_STATE_DECLINE_PCT: number;
  C2_SUSTAINED_PERIODS: number;
  C3_SEGMENT_UNDER_INDEX_PTS: number;
  C4_GROSS_CONTRIBUTION_DROP_PCT: number;
  C5_SHEET_STALENESS_DAYS: number;
  C6_MIN_STOPS: number;
  C6_MIN_STOP_SHARE_PCT: number;
  C6_MATERIALITY_FLOOR_RUPEES: number;
  /** Set false in red_alert_config.json to disable C6 without deleting its code. */
  C6_ACTIVE?: boolean;
};

// ── Seasonal weights ──────────────────────────────────────────────────────────
// Monthly weights Apr=0 … Mar=11, sourced from config/seasonal_weights.json.
// Used by C3 to require the comparison window covers a meaningful fraction of
// the year before raising a segment-vs-company-rate gap alert.

type SeasonalConfig = {
  versions: Array<{ fy: string; monthly: number[] }>;
  default: string;
};

let _seasonalWeights: number[] | null = null;

function getMonthlyWeights(): number[] {
  if (_seasonalWeights) return _seasonalWeights;
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../../config/seasonal_weights.json"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../config/seasonal_weights.json"),
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(p, "utf8")) as SeasonalConfig;
      const ver = cfg.versions.find((v) => v.fy === cfg.default) ?? cfg.versions[0];
      if (ver) { _seasonalWeights = ver.monthly; return _seasonalWeights; }
    } catch { /* try next */ }
  }
  // Fallback: uniform weights (1/12 each) — safe but no seasonal filtering
  _seasonalWeights = Array(12).fill(1 / 12) as number[];
  return _seasonalWeights;
}

// Map month label "Apr-26" → index 0 (Apr=0 … Mar=11)
const MONTH_IDX: Record<string, number> = {
  Apr: 0, May: 1, Jun: 2, Jul: 3, Aug: 4, Sep: 5, Oct: 6, Nov: 7, Dec: 8, Jan: 9, Feb: 10, Mar: 11,
};

function periodSeasonalWeight(months: string[]): number {
  const weights = getMonthlyWeights();
  return months.reduce((sum, m) => {
    const name = m.split("-")[0] ?? "";
    const idx = MONTH_IDX[name] ?? 0;
    return sum + (weights[idx] ?? 0);
  }, 0);
}

// ── Utility helpers ───────────────────────────────────────────────────────────

function prevFy(fy: string): string {
  const start = parseInt(fy.slice(0, 4), 10);
  return `${start - 1}-${String(start % 100).padStart(2, "0")}`;
}

function toPriorYearMonths(months: string[]): string[] {
  return months.map((m) => {
    const parts = m.split("-");
    if (parts.length !== 2) return m;
    return `${parts[0]}-${String(parseInt(parts[1]!, 10) - 1).padStart(2, "0")}`;
  });
}

function stateValue(ctx: DetectionContext, fy: string, months: string[], stateCanon: string): number {
  const ms = new Set(months);
  return ctx.customerSale
    .filter((r) => r.fy === fy && ms.has(r.monthLabel) && r.stateCanon === stateCanon)
    .reduce((s, r) => s + r.value, 0);
}

function stateCustomerValues(ctx: DetectionContext, fy: string, months: string[]): Map<string, Map<string, number>> {
  const ms = new Set(months);
  const out = new Map<string, Map<string, number>>();
  for (const r of ctx.customerSale) {
    if (r.fy !== fy || !ms.has(r.monthLabel) || !r.stateCanon) continue;
    if (!out.has(r.stateCanon)) out.set(r.stateCanon, new Map());
    const cm = out.get(r.stateCanon)!;
    cm.set(r.customer, (cm.get(r.customer) ?? 0) + r.value);
  }
  return out;
}

function segmentValues(ctx: DetectionContext, fy: string, months: string[]): Map<string, number> {
  const ms = new Set(months);
  const out = new Map<string, number>();
  for (const r of ctx.customerSale) {
    if (r.fy !== fy || !ms.has(r.monthLabel) || !r.groupCanon) continue;
    out.set(r.groupCanon, (out.get(r.groupCanon) ?? 0) + r.value);
  }
  return out;
}

function totalValue(ctx: DetectionContext, fy: string, months: string[]): number {
  const ms = new Set(months);
  return ctx.customerSale
    .filter((r) => r.fy === fy && ms.has(r.monthLabel))
    .reduce((s, r) => s + r.value, 0);
}

// ── Main engine ───────────────────────────────────────────────────────────────

export function buildCategoryCAlerts(
  ctx: DetectionContext,
  currentFy: string,
  currentMonths: string[],
  cfg: CConfig,
  /** Reference date for C5 staleness. For a closed FY pass the FY-end date,
   *  not today, so historical sheets don't appear stale relative to the present. */
  asOfDate: Date,
): RawAlert[] {
  const alerts: RawAlert[] = [];
  if (currentMonths.length === 0) return alerts;

  const priorFy = prevFy(currentFy);
  const priorMonths = toPriorYearMonths(currentMonths);
  const priorPriorFy = prevFy(priorFy);
  const priorPriorMonths = toPriorYearMonths(priorMonths);

  // ── C1: customer concentration ────────────────────────────────────────────
  const curStateCust = stateCustomerValues(ctx, currentFy, currentMonths);
  const priStateCust = stateCustomerValues(ctx, priorFy, priorMonths);

  for (const [state, custMap] of curStateCust) {
    const stateTotal = [...custMap.values()].reduce((s, v) => s + v, 0);
    if (stateTotal === 0) continue;

    for (const [customer, curVal] of custMap) {
      const share = (curVal / stateTotal) * 100;
      if (share < cfg.C1_CONCENTRATION_SHARE_PCT) continue;

      const priorStateMap = priStateCust.get(state) ?? new Map<string, number>();
      const priorStateTotal = [...priorStateMap.values()].reduce((s, v) => s + v, 0);
      const priorCustVal = priorStateMap.get(customer) ?? 0;
      if (priorCustVal === 0) continue;

      const custDecline = ((curVal - priorCustVal) / priorCustVal) * 100;
      if (custDecline <= -cfg.C1_DECLINE_PCT) {
        alerts.push({
          code: "C1",
          category: "C",
          entity: `${customer} (${state})`,
          entityKey: customer,
          entityType: "distributor",
          currentMonths,
          priorMonths,
          numbers: {
            currentValue: curVal,
            priorValue: priorCustVal,
            concentrationSharePct: share,
            valueGrowthPct: custDecline,
            statePct: stateTotal,
          },
          rupeesAtStake: priorCustVal - curVal,
          extraForReport: { state, stateCurrentTotal: stateTotal, statePriorTotal: priorStateTotal },
        });
      }
    }
  }

  // ── C2: state territory down >= 15%, sustained 2 periods ──────────────────
  const allStates = new Set<string>();
  for (const r of ctx.customerSale) {
    if (r.stateCanon) allStates.add(r.stateCanon);
  }

  for (const state of allStates) {
    const curVal = stateValue(ctx, currentFy, currentMonths, state);
    const priVal = stateValue(ctx, priorFy, priorMonths, state);
    if (priVal === 0) continue;

    const declinePct = ((curVal - priVal) / priVal) * 100;
    if (declinePct > -cfg.C2_STATE_DECLINE_PCT) continue;

    let sustained = cfg.C2_SUSTAINED_PERIODS <= 1;
    if (!sustained) {
      const priorPriorVal = stateValue(ctx, priorPriorFy, priorPriorMonths, state);
      if (priorPriorVal > 0) {
        sustained = ((priVal - priorPriorVal) / priorPriorVal) * 100 <= -cfg.C2_STATE_DECLINE_PCT;
      }
    }
    if (!sustained) continue;

    alerts.push({
      code: "C2",
      category: "C",
      entity: state,
      entityKey: state,
      entityType: "state",
      currentMonths,
      priorMonths,
      numbers: { currentValue: curVal, priorValue: priVal, declinePct: -declinePct, valueGrowthPct: declinePct },
      rupeesAtStake: priVal - curVal,
    });
  }

  // ── C3: segment >= N pts below company rate ───────────────────────────────
  // Seasonal gate: only fire when the comparison window covers >= 20% of annual
  // seasonal weight. A 1-month or very short window creates volatile, noisy gaps
  // between segment and company rates.
  const C3_MIN_PERIOD_WEIGHT = 0.20;
  const periodWeight = periodSeasonalWeight(currentMonths);

  if (periodWeight >= C3_MIN_PERIOD_WEIGHT) {
    const companyCurrentVal = totalValue(ctx, currentFy, currentMonths);
    const companyPriorVal = totalValue(ctx, priorFy, priorMonths);
    const companyGrowthPct = companyPriorVal > 0
      ? ((companyCurrentVal - companyPriorVal) / companyPriorVal) * 100
      : null;

    if (companyGrowthPct !== null) {
      const curSegs = segmentValues(ctx, currentFy, currentMonths);
      const priSegs = segmentValues(ctx, priorFy, priorMonths);

      for (const [seg, priVal] of priSegs) {
        if (seg === "Unmapped" || priVal === 0) continue;
        const curVal = curSegs.get(seg) ?? 0;
        const segGrowthPct = ((curVal - priVal) / priVal) * 100;
        const gapPts = companyGrowthPct - segGrowthPct;

        if (gapPts >= cfg.C3_SEGMENT_UNDER_INDEX_PTS) {
          alerts.push({
            code: "C3",
            category: "C",
            entity: seg,
            entityKey: seg,
            entityType: "segment",
            currentMonths,
            priorMonths,
            numbers: {
              statePct: segGrowthPct,
              companyPct: companyGrowthPct,
              gapPts,
              currentValue: curVal,
              priorValue: priVal,
              periodSeasonalWeight: periodWeight,
            },
            rupeesAtStake: priVal - curVal,
          });
        }
      }
    }
  }

  // ── C4: volume up, gross contribution down >= 15% ─────────────────────────
  const marginMonthsCur = new Set(currentMonths.map((m) => `${currentFy}|${m}`));
  const marginMonthsPri = new Set(priorMonths.map((m) => `${priorFy}|${m}`));

  let c4CurQty = 0, c4CurGC = 0, c4PriQty = 0, c4PriGC = 0;
  const c4Segments = new Set<string>();

  for (const r of ctx.marginFact) {
    if (r.bomCost == null || r.bomCost <= 0) continue;
    const key = `${r.fy}|${r.monthLabel}`;
    const gc = r.saleValue - r.qty * r.bomCost;
    if (marginMonthsCur.has(key)) { c4CurQty += r.qty; c4CurGC += gc; c4Segments.add(r.segment); }
    if (marginMonthsPri.has(key)) { c4PriQty += r.qty; c4PriGC += gc; }
  }

  if (c4PriQty > 0 && c4CurQty > c4PriQty && c4PriGC > 0) {
    const gcDeclinePct = ((c4CurGC - c4PriGC) / Math.abs(c4PriGC)) * 100;
    if (gcDeclinePct <= -cfg.C4_GROSS_CONTRIBUTION_DROP_PCT) {
      alerts.push({
        code: "C4",
        category: "C",
        entity: "Company (territory, cost-covered codes)",
        entityKey: "COMPANY",
        entityType: "segment",
        currentMonths,
        priorMonths,
        numbers: {
          currentValue: c4CurQty,
          priorValue: c4PriQty,
          grossContribCurrentCr: c4CurGC / 1e7,
          grossContribPriorCr: c4PriGC / 1e7,
          declinePct: -gcDeclinePct,
          valueGrowthPct: gcDeclinePct,
        },
        rupeesAtStake: Math.max(0, c4PriGC - c4CurGC),
        extraForReport: { segments: [...c4Segments].join(", ") },
      });
    }
  }

  // ── C5: sheet not read for >= staleness days ──────────────────────────────
  // Only considers members active in the current FY.
  // Uses `asOfDate` (not today) for the staleness calculation so that running
  // calibration against a closed FY does not make all historical sheets appear stale.
  // Skip members where ingested_at is not recorded (untracked, not stale).
  const stalenessDays = cfg.C5_SHEET_STALENESS_DAYS;
  const currentFyHeads = [...new Set(
    ctx.secHeadMonths.filter((r) => r.fy === currentFy).map((r) => r.headCanon),
  )];

  for (const headCanon of currentFyHeads) {
    // A numeric key is a legacy source alias and may represent more than one
    // person. C5 has no Guard 4 pass, so it must fail closed here rather than
    // letting Array.find() select whichever registry row appears first.
    if (isLegacyNumericSourceKey(headCanon)) continue;

    const lastRead = ctx.lastSheetRead.get(headCanon);
    if (lastRead == null) continue; // ingested_at not tracked for this member — skip

    const daysSince = (asOfDate.getTime() - lastRead.getTime()) / 86_400_000;
    if (daysSince >= stalenessDays) {
      const person = resolveUniquePersonIdentityKey(
        headCanon,
        ctx.persons,
        (candidate) => candidate.normKey,
      );
      const name = person?.canonicalName ?? headCanon;
      const stateHead = ctx.secHeadMonths.find((r) => r.headCanon === headCanon)?.stateHead ?? null;
      alerts.push({
        code: "C5",
        category: "C",
        entity: name,
        entityKey: headCanon,
        entityType: "member",
        currentMonths,
        priorMonths: [],
        numbers: { daysSinceRead: Math.round(daysSince) },
        rupeesAtStake: 0,
        extraForReport: {
          stateHead: stateHead ?? "—",
          lastReadDate: lastRead.toISOString().slice(0, 10),
          asOfDate: asOfDate.toISOString().slice(0, 10),
        },
      });
    }
  }

  // ── C6: territorial concentration of B3 retailer stops ───────────────────────
  // Fires when a single state head's territory accounts for:
  //   - >= C6_MIN_STOPS individual retailer stops, AND
  //   - >= C6_MIN_STOP_SHARE_PCT of all attributable stops in the period.
  //
  // "Stop" = a retailer whose prior-period purchases (prior like-months for currentFy)
  // exceeded C6_MATERIALITY_FLOOR_RUPEES but had zero purchases in the current window.
  //
  // Denominator: all stopped retailers above the floor with a resolvable state head.
  // Product-category registry rows (no hr_status AND not is_state_head) are excluded.
  // The denominator and basis are stated explicitly in the alert detail.
  //
  // C6 uses a retailer-level stop count (not distributor cards) so the alert naturally
  // detects territory-wide churn patterns rather than individual distributor failures.
  //
  // Set C6_ACTIVE=false in red_alert_config.json to disable without removing the code.
  // Re-enable when: (a) normalised by territory size, (b) 23-stop gap reconciled,
  // (c) running on a full quarter (not a partial secondary period).
  if (cfg.C6_ACTIVE === false) return alerts;
  {
    // Build normalised name → state_head map from persons.
    // Normalisation strips all non-alphanumeric chars (handles "A. Prasath" ↔ "a.prasath").
    const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

    const normHeadToStateHead = new Map<string, string | null>();
    for (const p of ctx.persons) {
      if (!p.isPerson) continue;
      // Exclude product-category rows: must have hr_status recorded OR be a state head
      if (!p.hrStatus && !p.isStateHead) continue;
      const norm = normName(p.canonicalName);
      if (norm) normHeadToStateHead.set(norm, p.stateHead);
    }

    // Identify the prior window (like-months in the prior FY).
    const priorFyC6 = prevFy(currentFy);
    const priorMonthsC6 = toPriorYearMonths(currentMonths);

    // Retailer value maps: retailer → total value in the given window.
    const priorFyMap = ctx.retailerHeadCanon.get(priorFyC6) ?? new Map<string, string>();

    // Sum prior-period value per retailer using retailerSale rows.
    const priorMs = new Set(priorMonthsC6);
    const curMs = new Set(currentMonths);

    const priorRetailerValue = new Map<string, number>();
    for (const r of ctx.retailerSale) {
      if (r.fy !== priorFyC6 || !priorMs.has(r.monthLabel)) continue;
      priorRetailerValue.set(r.retailer, (priorRetailerValue.get(r.retailer) ?? 0) + r.value);
    }

    // Current-period retailers (any purchase in the window).
    const curRetailers = new Set<string>();
    for (const r of ctx.retailerSale) {
      if (r.fy !== currentFy || !curMs.has(r.monthLabel)) continue;
      if (r.value > 0) curRetailers.add(r.retailer);
    }

    // Stopped retailers above materiality floor — grouped by state head.
    const stopsByHead = new Map<string, { count: number; rupees: number }>();
    let totalStops = 0;
    let totalRupees = 0;

    for (const [retailer, priorVal] of priorRetailerValue) {
      if (priorVal < cfg.C6_MATERIALITY_FLOOR_RUPEES) continue;
      if (curRetailers.has(retailer)) continue; // still active — not a stop

      // Resolve state head via prior-FY head_canon
      const headCanon = priorFyMap.get(retailer) ?? null;
      if (!headCanon) continue;
      const stateHead = normHeadToStateHead.get(normName(headCanon)) ?? null;
      if (!stateHead) continue; // unmapped — excluded from denominator
      // Departed heads (left_date recorded) and holding persons are excluded
      // from C6 entirely — both from firing AND from the denominator, so a
      // departure never distorts the remaining heads' stop shares.
      if (ctx.departedHeadNames.has(normName(stateHead))) continue;

      const existing = stopsByHead.get(stateHead) ?? { count: 0, rupees: 0 };
      existing.count += 1;
      existing.rupees += priorVal;
      stopsByHead.set(stateHead, existing);
      totalStops += 1;
      totalRupees += priorVal;
    }

    if (totalStops > 0) {
      for (const [stateHead, { count, rupees }] of stopsByHead) {
        const sharePct = (count / totalStops) * 100;
        if (count >= cfg.C6_MIN_STOPS && sharePct >= cfg.C6_MIN_STOP_SHARE_PCT) {
          alerts.push({
            code: "C6",
            category: "C",
            entity: stateHead,
            entityKey: stateHead,
            entityType: "team",
            currentMonths,
            priorMonths: priorMonthsC6,
            numbers: {
              stopCount: count,
              totalStops,
              stopSharePct: Math.round(sharePct * 10) / 10,
              rupeesCr: Math.round(rupees / 1e5) / 100,
              totalRupeesCr: Math.round(totalRupees / 1e5) / 100,
            },
            rupeesAtStake: rupees,
            extraForReport: {
              stateHead,
              denominator: `retailer stops above ₹${Math.round(cfg.C6_MATERIALITY_FLOOR_RUPEES / 1e5)} L prior-period floor with mapped state head`,
              excludedProductCategories: 1,
            },
          });
        }
      }
    }
  }

  return alerts;
}
