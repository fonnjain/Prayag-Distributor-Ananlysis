// Red Alert — Category B (dealer/retailer) engine.
// B1: real value growth (nominal - MRP increase) < -20%, like-months.
// B2: nominal value down >= 25%, sustained 2 periods.
// B3: zero purchase now, non-zero in prior comparable period.
// B4: a segment with prior value >= 5L has zero purchase now.
// B5: distinct item codes down >= 50%, prior >= 20 codes.

import type { RawAlert, DetectionContext } from "./types.js";
import { computeMrpIndex } from "./mrpIndex.js";

type BConfig = {
  B1_REAL_GROWTH_FLOOR_PCT: number;
  B2_NOMINAL_DECLINE_FLOOR_PCT: number;
  B2_SUSTAINED_PERIODS: number;
  B4_SEGMENT_FLOOR_RUPEES: number;
  B5_BREADTH_DROP_FLOOR_PCT: number;
  B5_PRIOR_CODE_FLOOR: number;
  MATERIALITY_FLOORS: { DISTRIBUTOR_RUPEES: number; DIRECT_DEALER_RUPEES: number; RETAILER_RUPEES: number };
};

type CustomerType = "distributor" | "direct_dealer" | "retailer";

function customerType(ctx: DetectionContext, customer: string): CustomerType {
  const key = customer.toUpperCase().trim();
  const cm = ctx.customerMaster.get(key);
  if (!cm) return "retailer";
  if (cm.entityType === "Distributors") return "distributor";
  if (cm.entityType === "Direct Dealers") return "direct_dealer";
  return "retailer";
}

function materialityFloor(type: CustomerType, cfg: BConfig): number {
  if (type === "distributor") return cfg.MATERIALITY_FLOORS.DISTRIBUTOR_RUPEES;
  if (type === "direct_dealer") return cfg.MATERIALITY_FLOORS.DIRECT_DEALER_RUPEES;
  return cfg.MATERIALITY_FLOORS.RETAILER_RUPEES;
}

// Aggregate sale value for a set of customers across a set of months in a FY.
function customerValue(ctx: DetectionContext, customer: string, fy: string, months: string[]): number {
  const ms = new Set(months);
  return ctx.customerSale
    .filter((r) => r.customer === customer && r.fy === fy && ms.has(r.monthLabel))
    .reduce((s, r) => s + r.value, 0);
}

// All distinct customers appearing in any of the given months/fy
function customersIn(ctx: DetectionContext, fy: string, months: string[]): Set<string> {
  const ms = new Set(months);
  const out = new Set<string>();
  for (const r of ctx.customerSale) {
    if (r.fy === fy && ms.has(r.monthLabel)) out.add(r.customer);
  }
  return out;
}

// Distinct item codes for customer in fy/months
function distinctCodes(ctx: DetectionContext, customer: string, fy: string, months: string[]): Set<string> {
  const ms = new Set(months);
  const out = new Set<string>();
  for (const r of ctx.customerCode) {
    if (r.customer === customer && r.fy === fy && ms.has(r.monthLabel)) out.add(r.code);
  }
  return out;
}

// Segment (group_canon) → value for customer in fy/months
function segmentValues(ctx: DetectionContext, customer: string, fy: string, months: string[]): Map<string, number> {
  const ms = new Set(months);
  const out = new Map<string, number>();
  for (const r of ctx.customerCode) {
    if (r.customer !== customer || r.fy !== fy || !ms.has(r.monthLabel)) continue;
    const seg = r.groupCanon ?? "Unmapped";
    out.set(seg, (out.get(seg) ?? 0) + r.value);
  }
  return out;
}

// "2026-27" → "2025-26"
function prevFy(fy: string): string {
  const start = parseInt(fy.slice(0, 4), 10);
  return `${start - 1}-${String(start % 100).padStart(2, "0")}`;
}

// Map current-FY months to prior-FY months: ["Apr-26"] → ["Apr-25"]
function toPriorYearMonths(months: string[]): string[] {
  return months.map((m) => {
    const parts = m.split("-");
    if (parts.length !== 2) return m;
    return `${parts[0]}-${String(parseInt(parts[1]!, 10) - 1).padStart(2, "0")}`;
  });
}

export function buildCategoryBAlerts(
  ctx: DetectionContext,
  currentFy: string,
  currentMonths: string[],
  cfg: BConfig,
): RawAlert[] {
  const alerts: RawAlert[] = [];
  if (currentMonths.length === 0) return alerts;

  const priorFy = prevFy(currentFy);
  const priorMonths = toPriorYearMonths(currentMonths);
  const priorPriorFy = prevFy(priorFy);
  const priorPriorMonths = toPriorYearMonths(priorMonths);

  // All customers who appear in either the current or prior period
  const allCustomers = new Set([
    ...customersIn(ctx, currentFy, currentMonths),
    ...customersIn(ctx, priorFy, priorMonths),
  ]);

  for (const customer of allCustomers) {
    const ctype = customerType(ctx, customer);
    const floor = materialityFloor(ctype, cfg);

    const currentVal = customerValue(ctx, customer, currentFy, currentMonths);
    const priorVal = customerValue(ctx, customer, priorFy, priorMonths);

    // Materiality: prior-year value must meet the floor
    if (priorVal < floor) continue;

    const valueGrowthPct = priorVal > 0 ? ((currentVal - priorVal) / priorVal) * 100 : null;

    // ── B3: zero now, non-zero before ────────────────────────────────────────
    if (currentVal === 0 && priorVal > 0) {
      alerts.push({
        code: "B3",
        category: "B",
        entity: customer,
        entityKey: customer,
        entityType: ctype,
        currentMonths,
        priorMonths,
        numbers: { currentValue: 0, priorValue: priorVal, valueGrowthPct: -100 },
        rupeesAtStake: priorVal,
      });
      continue; // B3 suppresses B1/B2/B4/B5 for this customer (applied in detectAlerts)
    }

    if (currentVal === 0 || priorVal === 0 || valueGrowthPct === null) continue;

    // ── B1: real growth < floor ──────────────────────────────────────────────
    const mrpResult = computeMrpIndex(ctx, customer, priorMonths, currentMonths);
    if (mrpResult != null) {
      const realGrowthPct = valueGrowthPct - mrpResult.mrpIncreasePct;
      const realisedRealGrowthPct = valueGrowthPct - mrpResult.realisedIncreasePct;
      if (realGrowthPct < cfg.B1_REAL_GROWTH_FLOOR_PCT) {
        alerts.push({
          code: "B1",
          category: "B",
          entity: customer,
          entityKey: customer,
          entityType: ctype,
          currentMonths,
          priorMonths,
          numbers: {
            currentValue: currentVal,
            priorValue: priorVal,
            valueGrowthPct,
            mrpIncreasePct: mrpResult.mrpIncreasePct,
            realGrowthPct,
            realisedRealGrowthPct,
            mrpCoveragePct: mrpResult.coveragePct,
          },
          rupeesAtStake: priorVal - currentVal,
          extraForReport: {
            mrpBasketSize: mrpResult.basketSize,
            mrpCoveragePct: mrpResult.coveragePct,
            realisedRealGrowthPct,
          },
        });
      }
    }

    // ── B2: nominal decline >= 25%, sustained 2 periods ──────────────────────
    const declinePct = -valueGrowthPct; // positive means decline
    if (declinePct >= cfg.B2_NOMINAL_DECLINE_FLOOR_PCT) {
      // Check sustained: prior vs prior-prior must ALSO show >= 25% decline
      const priorPriorVal = customerValue(ctx, customer, priorPriorFy, priorPriorMonths);
      const sustained =
        cfg.B2_SUSTAINED_PERIODS <= 1 ||
        (priorPriorVal > 0 &&
          ((priorPriorVal - priorVal) / priorPriorVal) * 100 >= cfg.B2_NOMINAL_DECLINE_FLOOR_PCT);

      if (sustained) {
        alerts.push({
          code: "B2",
          category: "B",
          entity: customer,
          entityKey: customer,
          entityType: ctype,
          currentMonths,
          priorMonths,
          numbers: {
            currentValue: currentVal,
            priorValue: priorVal,
            priorPriorValue: priorPriorVal,
            declinePct,
            valueGrowthPct,
          },
          rupeesAtStake: priorVal - currentVal,
        });
      }
    }

    // ── B4: segment dropout ──────────────────────────────────────────────────
    const priorSegs = segmentValues(ctx, customer, priorFy, priorMonths);
    const curSegs = segmentValues(ctx, customer, currentFy, currentMonths);

    for (const [seg, priorSegVal] of priorSegs) {
      if (priorSegVal < cfg.B4_SEGMENT_FLOOR_RUPEES) continue;
      const curSegVal = curSegs.get(seg) ?? 0;
      if (curSegVal === 0) {
        alerts.push({
          code: "B4",
          category: "B",
          entity: `${customer} — ${seg}`,
          entityKey: customer,
          entityType: ctype,
          currentMonths,
          priorMonths,
          numbers: { priorValue: priorSegVal, currentValue: 0 },
          rupeesAtStake: priorSegVal,
          extraForReport: { segment: seg },
        });
      }
    }

    // ── B5: breadth collapse ──────────────────────────────────────────────────
    const priorCodes = distinctCodes(ctx, customer, priorFy, priorMonths);
    const curCodes = distinctCodes(ctx, customer, currentFy, currentMonths);

    if (
      priorCodes.size >= cfg.B5_PRIOR_CODE_FLOOR &&
      curCodes.size < priorCodes.size * (1 - cfg.B5_BREADTH_DROP_FLOOR_PCT / 100)
    ) {
      const dropPct = ((priorCodes.size - curCodes.size) / priorCodes.size) * 100;
      alerts.push({
        code: "B5",
        category: "B",
        entity: customer,
        entityKey: customer,
        entityType: ctype,
        currentMonths,
        priorMonths,
        numbers: {
          codePrior: priorCodes.size,
          codeCurrent: curCodes.size,
          declinePct: dropPct,
          priorValue: priorVal,
          currentValue: currentVal,
        },
        rupeesAtStake: priorVal - currentVal,
      });
    }
  }

  return alerts;
}
