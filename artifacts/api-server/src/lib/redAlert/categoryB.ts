// Red Alert — Category B (dealer/retailer) engine.
// B1: real value growth (nominal - MRP increase) < -20%, like-months.
// B2: nominal value down >= 25%, sustained 2 periods.
// B3: zero purchase now, non-zero in prior comparable period.
// B4: a segment with prior value >= 5L has zero purchase now.
// B5: distinct item codes down >= 50%, prior >= 20 codes.
//
// DATA SOURCES:
//   Retailers: secondary_sku_line (ctx.retailerSale + ctx.retailerSku)
//     — the authoritative sell-out source. sale_line_current (primary dispatch)
//       records distributor→company shipments and does NOT carry per-retailer figures.
//   Distributors / direct dealers: sale_line_current (ctx.customerSale + ctx.customerCode)

import type { RawAlert, DetectionContext } from "./types.js";
import { computeMrpIndex, computeRetailerMrpIndex } from "./mrpIndex.js";

type BConfig = {
  B1_REAL_GROWTH_FLOOR_PCT: number;
  B2_NOMINAL_DECLINE_FLOOR_PCT: number;
  B2_SUSTAINED_PERIODS: number;
  B4_SEGMENT_FLOOR_RUPEES: number;
  B5_BREADTH_DROP_FLOOR_PCT: number;
  B5_PRIOR_CODE_FLOOR: number;
  MATERIALITY_FLOORS: { DISTRIBUTOR_RUPEES: number; DIRECT_DEALER_RUPEES: number; RETAILER_RUPEES: number };
  // B3 retailer rollup thresholds
  B3_RETAILER_ROLLUP_MIN_RETAILERS: number;
  B3_RETAILER_ROLLUP_MIN_COMBINED_RUPEES: number;
  B3_RETAILER_INDIVIDUAL_FLOOR_RUPEES: number;
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

// ── Primary-data helpers (distributors / direct dealers) ──────────────────────

function customerValue(ctx: DetectionContext, customer: string, fy: string, months: string[]): number {
  const ms = new Set(months);
  return ctx.customerSale
    .filter((r) => r.customer === customer && r.fy === fy && ms.has(r.monthLabel))
    .reduce((s, r) => s + r.value, 0);
}

function customersIn(ctx: DetectionContext, fy: string, months: string[]): Set<string> {
  const ms = new Set(months);
  const out = new Set<string>();
  for (const r of ctx.customerSale) {
    if (r.fy === fy && ms.has(r.monthLabel)) out.add(r.customer);
  }
  return out;
}

function distinctCodes(ctx: DetectionContext, customer: string, fy: string, months: string[]): Set<string> {
  const ms = new Set(months);
  const out = new Set<string>();
  for (const r of ctx.customerCode) {
    if (r.customer === customer && r.fy === fy && ms.has(r.monthLabel)) out.add(r.code);
  }
  return out;
}

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

// ── Pre-built lookup indexes for secondary retailer data ──────────────────────
// Built ONCE per buildRetailerBAlerts call so per-retailer lookups are O(months),
// not O(rows). With 838 k rows and 18 k retailers the naive approach hangs.

type RetailerIndex = {
  // retailer → `${fy}|${monthLabel}` → net_amount total
  valueByMonth: Map<string, Map<string, number>>;
  // retailer → `${fy}|${monthLabel}` → Set<itemCode>
  codesByMonth: Map<string, Map<string, Set<string>>>;
  // retailer → `${fy}|${monthLabel}` → segmentCanon → net_amount total
  segsByMonth: Map<string, Map<string, Map<string, number>>>;
  // all retailers with sale rows in a given `${fy}|${monthLabel}` window key
  retailersInWindow: Map<string, Set<string>>;  // window key → Set<retailer>
};

function buildRetailerIndex(ctx: DetectionContext): RetailerIndex {
  const valueByMonth   = new Map<string, Map<string, number>>();
  const codesByMonth   = new Map<string, Map<string, Set<string>>>();
  const segsByMonth    = new Map<string, Map<string, Map<string, number>>>();
  const retailersInWindow = new Map<string, Set<string>>();

  for (const r of ctx.retailerSale) {
    const wk = `${r.fy}|${r.monthLabel}`;
    if (!retailersInWindow.has(wk)) retailersInWindow.set(wk, new Set());
    retailersInWindow.get(wk)!.add(r.retailer);

    if (!valueByMonth.has(r.retailer)) valueByMonth.set(r.retailer, new Map());
    const vm = valueByMonth.get(r.retailer)!;
    vm.set(wk, (vm.get(wk) ?? 0) + r.value);
  }

  for (const r of ctx.retailerSku) {
    const wk = `${r.fy}|${r.monthLabel}`;

    if (!codesByMonth.has(r.retailer)) codesByMonth.set(r.retailer, new Map());
    const cm = codesByMonth.get(r.retailer)!;
    if (!cm.has(wk)) cm.set(wk, new Set());
    cm.get(wk)!.add(r.itemCode);

    if (!segsByMonth.has(r.retailer)) segsByMonth.set(r.retailer, new Map());
    const sm = segsByMonth.get(r.retailer)!;
    if (!sm.has(wk)) sm.set(wk, new Map());
    const seg = r.segmentCanon ?? "Unmapped";
    const segMap = sm.get(wk)!;
    segMap.set(seg, (segMap.get(seg) ?? 0) + r.value);
  }

  return { valueByMonth, codesByMonth, segsByMonth, retailersInWindow };
}

function idxRetailerValue(idx: RetailerIndex, retailer: string, fy: string, months: string[]): number {
  const vm = idx.valueByMonth.get(retailer);
  if (!vm) return 0;
  let total = 0;
  for (const m of months) total += vm.get(`${fy}|${m}`) ?? 0;
  return total;
}

function idxRetailersIn(idx: RetailerIndex, fy: string, months: string[]): Set<string> {
  const out = new Set<string>();
  for (const m of months) {
    for (const r of idx.retailersInWindow.get(`${fy}|${m}`) ?? []) out.add(r);
  }
  return out;
}

function idxRetailerCodes(idx: RetailerIndex, retailer: string, fy: string, months: string[]): Set<string> {
  const cm = idx.codesByMonth.get(retailer);
  if (!cm) return new Set();
  const out = new Set<string>();
  for (const m of months) for (const c of cm.get(`${fy}|${m}`) ?? []) out.add(c);
  return out;
}

function idxRetailerSegs(idx: RetailerIndex, retailer: string, fy: string, months: string[]): Map<string, number> {
  const sm = idx.segsByMonth.get(retailer);
  const out = new Map<string, number>();
  if (!sm) return out;
  for (const m of months) {
    for (const [seg, v] of sm.get(`${fy}|${m}`) ?? []) {
      out.set(seg, (out.get(seg) ?? 0) + v);
    }
  }
  return out;
}

// ── FY helpers ────────────────────────────────────────────────────────────────

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

// ── B-alert builder for PRIMARY entities (distributors / direct dealers) ──────

function buildPrimaryBAlerts(
  ctx: DetectionContext,
  currentFy: string,
  currentMonths: string[],
  priorFy: string,
  priorMonths: string[],
  priorPriorFy: string,
  priorPriorMonths: string[],
  cfg: BConfig,
): RawAlert[] {
  const alerts: RawAlert[] = [];

  const allCustomers = new Set([
    ...customersIn(ctx, currentFy, currentMonths),
    ...customersIn(ctx, priorFy, priorMonths),
  ]);

  for (const customer of allCustomers) {
    const ctype = customerType(ctx, customer);
    if (ctype === "retailer") continue; // retailers handled separately

    const floor = materialityFloor(ctype, cfg);
    const currentVal = customerValue(ctx, customer, currentFy, currentMonths);
    const priorVal   = customerValue(ctx, customer, priorFy, priorMonths);

    if (priorVal < floor) continue;

    const valueGrowthPct = priorVal > 0 ? ((currentVal - priorVal) / priorVal) * 100 : null;

    // B3
    if (currentVal === 0 && priorVal > 0) {
      alerts.push({
        code: "B3", category: "B", entity: customer, entityKey: customer, entityType: ctype,
        currentMonths, priorMonths,
        numbers: { currentValue: 0, priorValue: priorVal, valueGrowthPct: -100 },
        rupeesAtStake: priorVal,
      });
      continue;
    }

    if (currentVal === 0 || priorVal === 0 || valueGrowthPct === null) continue;

    // B1
    const mrpResult = computeMrpIndex(ctx, customer, priorMonths, currentMonths);
    if (mrpResult != null) {
      const realGrowthPct = valueGrowthPct - mrpResult.mrpIncreasePct;
      const realisedRealGrowthPct = valueGrowthPct - mrpResult.realisedIncreasePct;
      if (realGrowthPct < cfg.B1_REAL_GROWTH_FLOOR_PCT) {
        alerts.push({
          code: "B1", category: "B", entity: customer, entityKey: customer, entityType: ctype,
          currentMonths, priorMonths,
          numbers: { currentValue: currentVal, priorValue: priorVal, valueGrowthPct,
            mrpIncreasePct: mrpResult.mrpIncreasePct, realGrowthPct, realisedRealGrowthPct,
            mrpCoveragePct: mrpResult.coveragePct },
          rupeesAtStake: priorVal - currentVal,
          extraForReport: { mrpBasketSize: mrpResult.basketSize, mrpCoveragePct: mrpResult.coveragePct, realisedRealGrowthPct },
        });
      }
    }

    // B2
    const declinePct = -valueGrowthPct;
    if (declinePct >= cfg.B2_NOMINAL_DECLINE_FLOOR_PCT) {
      const priorPriorVal = customerValue(ctx, customer, priorPriorFy, priorPriorMonths);
      const sustained = cfg.B2_SUSTAINED_PERIODS <= 1 ||
        (priorPriorVal > 0 && ((priorPriorVal - priorVal) / priorPriorVal) * 100 >= cfg.B2_NOMINAL_DECLINE_FLOOR_PCT);
      if (sustained) {
        alerts.push({
          code: "B2", category: "B", entity: customer, entityKey: customer, entityType: ctype,
          currentMonths, priorMonths,
          numbers: { currentValue: currentVal, priorValue: priorVal, priorPriorValue: priorPriorVal, declinePct, valueGrowthPct },
          rupeesAtStake: priorVal - currentVal,
        });
      }
    }

    // B4
    const priorSegs = segmentValues(ctx, customer, priorFy, priorMonths);
    const curSegs   = segmentValues(ctx, customer, currentFy, currentMonths);
    for (const [seg, priorSegVal] of priorSegs) {
      if (priorSegVal < cfg.B4_SEGMENT_FLOOR_RUPEES) continue;
      if ((curSegs.get(seg) ?? 0) === 0) {
        alerts.push({
          code: "B4", category: "B", entity: `${customer} — ${seg}`, entityKey: customer, entityType: ctype,
          currentMonths, priorMonths,
          numbers: { priorValue: priorSegVal, currentValue: 0 },
          rupeesAtStake: priorSegVal, extraForReport: { segment: seg },
        });
      }
    }

    // B5 — "at least 50% drop" means curCodes.size <= threshold (boundary inclusive)
    const priorCodes = distinctCodes(ctx, customer, priorFy, priorMonths);
    const curCodes   = distinctCodes(ctx, customer, currentFy, currentMonths);
    if (
      priorCodes.size >= cfg.B5_PRIOR_CODE_FLOOR &&
      curCodes.size <= priorCodes.size * (1 - cfg.B5_BREADTH_DROP_FLOOR_PCT / 100)
    ) {
      const dropPct = ((priorCodes.size - curCodes.size) / priorCodes.size) * 100;
      alerts.push({
        code: "B5", category: "B", entity: customer, entityKey: customer, entityType: ctype,
        currentMonths, priorMonths,
        numbers: { codePrior: priorCodes.size, codeCurrent: curCodes.size, declinePct: dropPct, priorValue: priorVal, currentValue: currentVal },
        rupeesAtStake: priorVal - currentVal,
      });
    }
  }

  return alerts;
}

// ── B-alert builder for SECONDARY entities (retailers) ────────────────────────

function buildRetailerBAlerts(
  ctx: DetectionContext,
  currentFy: string,
  currentMonths: string[],
  priorFy: string,
  priorMonths: string[],
  priorPriorFy: string,
  priorPriorMonths: string[],
  cfg: BConfig,
): RawAlert[] {
  const alerts: RawAlert[] = [];

  // Build index once — O(rows). All per-retailer lookups below are then O(months).
  const idx = buildRetailerIndex(ctx);

  const allRetailers = new Set([
    ...idxRetailersIn(idx, currentFy, currentMonths),
    ...idxRetailersIn(idx, priorFy, priorMonths),
  ]);

  const floor = materialityFloor("retailer", cfg);

  for (const retailer of allRetailers) {
    const currentVal = idxRetailerValue(idx, retailer, currentFy, currentMonths);
    const priorVal   = idxRetailerValue(idx, retailer, priorFy, priorMonths);

    if (priorVal < floor) continue;

    const valueGrowthPct = priorVal > 0 ? ((currentVal - priorVal) / priorVal) * 100 : null;

    // B3
    if (currentVal === 0 && priorVal > 0) {
      alerts.push({
        code: "B3", category: "B", entity: retailer, entityKey: retailer, entityType: "retailer",
        currentMonths, priorMonths,
        numbers: { currentValue: 0, priorValue: priorVal, valueGrowthPct: -100 },
        rupeesAtStake: priorVal,
      });
      continue;
    }

    if (currentVal === 0 || priorVal === 0 || valueGrowthPct === null) continue;

    // B1 — uses secondary-basket MRP index (value-weighted Laspeyres from retailerSku).
    // Primary customerCode is NOT consulted; retailer IDs are absent from that source.
    const mrpResult = computeRetailerMrpIndex(ctx, retailer, priorMonths, currentMonths);
    if (mrpResult != null) {
      const realGrowthPct = valueGrowthPct - mrpResult.mrpIncreasePct;
      const realisedRealGrowthPct = valueGrowthPct - mrpResult.realisedIncreasePct;
      if (realGrowthPct < cfg.B1_REAL_GROWTH_FLOOR_PCT) {
        alerts.push({
          code: "B1", category: "B", entity: retailer, entityKey: retailer, entityType: "retailer",
          currentMonths, priorMonths,
          numbers: { currentValue: currentVal, priorValue: priorVal, valueGrowthPct,
            mrpIncreasePct: mrpResult.mrpIncreasePct, realGrowthPct, realisedRealGrowthPct,
            mrpCoveragePct: mrpResult.coveragePct },
          rupeesAtStake: priorVal - currentVal,
          extraForReport: { mrpBasketSize: mrpResult.basketSize, mrpCoveragePct: mrpResult.coveragePct, realisedRealGrowthPct },
        });
      }
    }

    // B2
    const declinePct = -valueGrowthPct;
    if (declinePct >= cfg.B2_NOMINAL_DECLINE_FLOOR_PCT) {
      const priorPriorVal = idxRetailerValue(idx, retailer, priorPriorFy, priorPriorMonths);
      const sustained = cfg.B2_SUSTAINED_PERIODS <= 1 ||
        (priorPriorVal > 0 && ((priorPriorVal - priorVal) / priorPriorVal) * 100 >= cfg.B2_NOMINAL_DECLINE_FLOOR_PCT);
      if (sustained) {
        alerts.push({
          code: "B2", category: "B", entity: retailer, entityKey: retailer, entityType: "retailer",
          currentMonths, priorMonths,
          numbers: { currentValue: currentVal, priorValue: priorVal, priorPriorValue: priorPriorVal, declinePct, valueGrowthPct },
          rupeesAtStake: priorVal - currentVal,
        });
      }
    }

    // B4 — segment dropout using secondary_sku_line segment_canon
    const priorSegs = idxRetailerSegs(idx, retailer, priorFy, priorMonths);
    const curSegs   = idxRetailerSegs(idx, retailer, currentFy, currentMonths);
    for (const [seg, priorSegVal] of priorSegs) {
      if (priorSegVal < cfg.B4_SEGMENT_FLOOR_RUPEES) continue;
      if ((curSegs.get(seg) ?? 0) === 0) {
        alerts.push({
          code: "B4", category: "B", entity: `${retailer} — ${seg}`, entityKey: retailer, entityType: "retailer",
          currentMonths, priorMonths,
          numbers: { priorValue: priorSegVal, currentValue: 0 },
          rupeesAtStake: priorSegVal, extraForReport: { segment: seg },
        });
      }
    }

    // B5 — breadth collapse using secondary_sku_line item_code.
    // "at least X% drop" includes the exact boundary (<=).
    const priorCodes = idxRetailerCodes(idx, retailer, priorFy, priorMonths);
    const curCodes   = idxRetailerCodes(idx, retailer, currentFy, currentMonths);
    if (
      priorCodes.size >= cfg.B5_PRIOR_CODE_FLOOR &&
      curCodes.size <= priorCodes.size * (1 - cfg.B5_BREADTH_DROP_FLOOR_PCT / 100)
    ) {
      const dropPct = ((priorCodes.size - curCodes.size) / priorCodes.size) * 100;
      alerts.push({
        code: "B5", category: "B", entity: retailer, entityKey: retailer, entityType: "retailer",
        currentMonths, priorMonths,
        numbers: { codePrior: priorCodes.size, codeCurrent: curCodes.size, declinePct: dropPct, priorValue: priorVal, currentValue: currentVal },
        rupeesAtStake: priorVal - currentVal,
      });
    }
  }

  return alerts;
}

// ── B3 retailer rollup ────────────────────────────────────────────────────────
// Aggregates per-retailer B3 stops into distributor-level cards.
// Rule (applied in order):
//   1. If ≥ B3_RETAILER_ROLLUP_MIN_RETAILERS stopped retailers share a primary
//      distributor, OR combined prior value ≥ B3_RETAILER_ROLLUP_MIN_COMBINED_RUPEES:
//      emit ONE distributor-level alert; retailer list in extraForReport.
//   2. Individual retailers where no qualifying group exists survive only if
//      their own prior value ≥ B3_RETAILER_INDIVIDUAL_FLOOR_RUPEES.
//   3. Everything else is suppressed.
//
// "Primary distributor" = the distributor with the highest prior-window value
// for that retailer, from ctx.retailerPrimaryDist[priorFy][retailer].
// If no mapping exists (retailer never appeared with a distributor), the
// retailer is kept as-is at its individual floor.
function rollupB3Retailers(
  rawB3: RawAlert[],
  ctx: DetectionContext,
  priorFy: string,
  cfg: BConfig,
): RawAlert[] {
  const out: RawAlert[] = [];
  const priorDistMap = ctx.retailerPrimaryDist.get(priorFy) ?? new Map<string, string>();

  // Group retailer B3 alerts by their primary distributor
  type RetailerEntry = { retailer: string; priorValue: number; alert: RawAlert };
  const byDist = new Map<string, RetailerEntry[]>();
  const noDist: RetailerEntry[] = [];

  for (const alert of rawB3) {
    if (alert.entityType !== "retailer") {
      out.push(alert); // non-retailer B3 (distributor / direct dealer) — pass through
      continue;
    }
    const dist = priorDistMap.get(alert.entityKey);
    const priorVal = alert.numbers.priorValue ?? 0;
    if (!dist) {
      noDist.push({ retailer: alert.entityKey, priorValue: priorVal, alert });
      continue;
    }
    if (!byDist.has(dist)) byDist.set(dist, []);
    byDist.get(dist)!.push({ retailer: alert.entityKey, priorValue: priorVal, alert });
  }

  // Process each distributor group
  for (const [dist, entries] of byDist) {
    const combinedPrior = entries.reduce((s, e) => s + e.priorValue, 0);
    const shouldRoll =
      entries.length >= cfg.B3_RETAILER_ROLLUP_MIN_RETAILERS ||
      combinedPrior >= cfg.B3_RETAILER_ROLLUP_MIN_COMBINED_RUPEES;

    if (shouldRoll) {
      // One distributor-level alert
      const firstAlert = entries[0]!.alert;
      out.push({
        code: "B3",
        category: "B",
        entity: dist,
        entityKey: dist,
        entityType: "distributor",
        currentMonths: firstAlert.currentMonths,
        priorMonths: firstAlert.priorMonths,
        numbers: {
          currentValue: 0,
          priorValue: combinedPrior,
          valueGrowthPct: -100,
          retailerCount: entries.length,
        },
        rupeesAtStake: combinedPrior,
        extraForReport: {
          retailers: entries.map((e) => e.retailer).join(","),
          retailerCount: entries.length,
          combinedPriorValue: combinedPrior,
          rollupTrigger:
            entries.length >= cfg.B3_RETAILER_ROLLUP_MIN_RETAILERS
              ? `${entries.length} retailers ≥ threshold of ${cfg.B3_RETAILER_ROLLUP_MIN_RETAILERS}`
              : `combined prior ₹${(combinedPrior / 1e7).toFixed(2)} Cr ≥ ₹${(cfg.B3_RETAILER_ROLLUP_MIN_COMBINED_RUPEES / 1e7).toFixed(2)} Cr`,
        },
      });
    } else {
      // Group doesn't qualify — each retailer survives only above individual floor
      for (const e of entries) {
        if (e.priorValue >= cfg.B3_RETAILER_INDIVIDUAL_FLOOR_RUPEES) {
          out.push(e.alert);
        }
        // else: suppressed (below floor, small group)
      }
    }
  }

  // Retailers with no distributor mapping — apply individual floor
  for (const e of noDist) {
    if (e.priorValue >= cfg.B3_RETAILER_INDIVIDUAL_FLOOR_RUPEES) {
      out.push(e.alert);
    }
  }

  return out;
}

// ── Root export ───────────────────────────────────────────────────────────────

export function buildCategoryBAlerts(
  ctx: DetectionContext,
  currentFy: string,
  currentMonths: string[],
  cfg: BConfig,
): RawAlert[] {
  if (currentMonths.length === 0) return [];

  const priorFy         = prevFy(currentFy);
  const priorMonths     = toPriorYearMonths(currentMonths);
  const priorPriorFy    = prevFy(priorFy);
  const priorPriorMonths = toPriorYearMonths(priorMonths);

  const primaryAlerts  = buildPrimaryBAlerts(ctx, currentFy, currentMonths, priorFy, priorMonths, priorPriorFy, priorPriorMonths, cfg);
  const retailerRaw    = buildRetailerBAlerts(ctx, currentFy, currentMonths, priorFy, priorMonths, priorPriorFy, priorPriorMonths, cfg);

  // Apply B3 rollup to retailer stops; other retailer codes (B1,B2,B4,B5) are unaffected.
  const retailerB3Raw  = retailerRaw.filter((a) => a.code === "B3");
  const retailerOther  = retailerRaw.filter((a) => a.code !== "B3");
  const retailerB3Rolled = rollupB3Retailers(retailerB3Raw, ctx, priorFy, cfg);

  return [...primaryAlerts, ...retailerOther, ...retailerB3Rolled];
}
