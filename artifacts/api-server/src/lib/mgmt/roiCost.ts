// Phase 4 — ROI on cost.
//
// Computes the revenue-to-cost multiple and related per-unit metrics for a
// field representative, given:
//   • Monthly CTC (from the Data tab) × elapsed complete fiscal months → YTD CTC cost
//   • T.A. Bill (YTD cumulative, from the Data tab)
//   • Retailer spread (OB, sale, visits, retailer counts) from the member's
//     own working sheet (Phase 2).
//
// Margin-based ROI requires finished-goods cost from the Cost Master table.
// Until that table is populated, marginRoiAvailable is always false.
// MRP and Purchase Price are NEVER used as cost proxies.
//
// Rules:
//   • Elapsed months = complete fiscal months only (whole months that have ended).
//   • T.A. bill is already YTD cumulative — never multiply by elapsed months.
//   • All divisions guard against zero denominators (return null, not Infinity).
//   • Never console.log — use logger.
//   • This module has no Sheets reads; it is pure computation.

import { logger } from "../logger.js";
import type { RetailerSpread } from "./memberSheet.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type RoiCost = {
  // Inputs (from Data tab)
  ctcMonthly: number;
  taBillYtd: number;
  elapsedCompleteMonths: number;

  // Cost components
  ctcCostYtd: number;   // ctcMonthly × elapsedCompleteMonths
  totalCost: number;    // ctcCostYtd + taBillYtd

  // Revenue-to-cost multiples (higher = more efficient)
  obToCostMultiple: number | null;    // OB / totalCost
  saleToCostMultiple: number | null;  // Sale / totalCost

  // Per-unit cost metrics
  costPerRetailer: number | null;        // cost / totalRetailers
  costPerVisit: number | null;           // cost / totalVisitsDone
  costPerActiveRetailer: number | null;  // cost / activeRetailers ("cost per order")

  // Efficiency ratio
  costRatioPct: number | null;   // (totalCost / OB) × 100

  // Margin ROI placeholder — always false until Cost Master exists
  marginRoiAvailable: false;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fyStartYear(fy: string): number {
  return parseInt(fy.split("-")[0]!, 10);
}

/**
 * Count the number of complete fiscal months elapsed from April 1 up to asOf.
 * A month is complete when its last calendar day has passed.
 *
 * Example: FY2026-27, asOf = July 23, 2026
 *   April (complete), May (complete), June (complete) → 3.
 *   July is still in progress → not counted.
 */
function completeFiscalMonths(fy: string, asOf: Date): number {
  const startYear = fyStartYear(fy);
  const fyStartMonth = 3; // April = 3 (0-indexed)
  // Number of whole months from FY start to the BEGINNING of the current month.
  const months =
    (asOf.getFullYear() - startYear) * 12 +
    (asOf.getMonth() - fyStartMonth);
  return Math.max(0, Math.min(12, months));
}

function div(a: number, b: number | null | undefined): number | null {
  if (!b || b === 0) return null;
  return a / b;
}

// ── Main computation ──────────────────────────────────────────────────────────

export function computeRoiCost(
  ctcMonthly: number | null,
  taBillYtd: number | null,
  fy: string,
  spread: RetailerSpread,
  asOf?: Date,
): RoiCost | null {
  // Cannot compute without CTC — T.A. alone is insufficient.
  if (ctcMonthly == null) return null;

  const now = asOf ?? new Date();
  const elapsedCompleteMonths = completeFiscalMonths(fy, now);
  const taBill = taBillYtd ?? 0;

  const ctcCostYtd = ctcMonthly * elapsedCompleteMonths;
  const totalCost  = ctcCostYtd + taBill;

  const ob      = spread.totalOrderBooking;
  const sale    = spread.totalSale;
  const visits  = spread.totalVisits ?? null;
  const total   = spread.totalRetailers;
  const active  = spread.activeRetailers;

  const obToCostMultiple    = totalCost > 0 ? div(ob, totalCost) : null;
  const saleToCostMultiple  = totalCost > 0 ? div(sale, totalCost) : null;
  const costRatioPct        = ob > 0 ? (totalCost / ob) * 100 : null;

  const costPerRetailer       = div(totalCost, total > 0 ? total : null);
  const costPerVisit          = visits != null && visits > 0 ? totalCost / visits : null;
  const costPerActiveRetailer = active > 0 ? totalCost / active : null;

  const result: RoiCost = {
    ctcMonthly,
    taBillYtd: taBill,
    elapsedCompleteMonths,
    ctcCostYtd,
    totalCost,
    obToCostMultiple,
    saleToCostMultiple,
    costPerRetailer,
    costPerVisit,
    costPerActiveRetailer,
    costRatioPct,
    marginRoiAvailable: false,
  };

  logger.info(
    {
      fy,
      elapsedCompleteMonths,
      ctcMonthly,
      ctcCostYtd,
      taBillYtd: taBill,
      totalCost,
      ob,
      sale,
      obToCostMultiple: obToCostMultiple?.toFixed(2),
      costRatioPct: costRatioPct?.toFixed(2),
    },
    "roiCost: computed — verify against acceptance criteria",
  );

  return result;
}
