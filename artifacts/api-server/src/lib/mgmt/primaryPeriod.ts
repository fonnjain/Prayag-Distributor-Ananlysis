// Shared period-aware primary data service.
//
// Single source of truth for Order Sheet booking and dispatch-sale figures
// across State Head dashboard, Primary Performance, and any future consumer.
//
// BOOKING (FY2026-27)
//   Reads the Order Sheet via loadOrderBookSaleByHead(), which caches a
//   per-tab byHeadByMonth map, then filters to exactly the requested months
//   via 3-char month-prefix matching ("Apr-26", "April", "Apr" → "Apr").
//   Falls back to the FY-total byHead if the requested month tabs are not
//   yet present in the sheet.
//
// BOOKING (historical FYs)
//   loadPrimarySheetData() returns an FY-level aggregate only.
//   periodFiltered=false is set so callers can surface a warning.
//
// SALE / DISPATCH (all FYs)
//   Reads sale_line DB via loadDispatchSaleFromDb() — always period-exact.
//   Falls back to the Sheets-based loadStateHeadSale() for FYs not yet
//   present in the DB, with periodFiltered=false.
//
// Usage:
//   import { fiscalMonthsToLabels, loadPrimaryPeriodData } from "./primaryPeriod.js";
//   const labels = fiscalMonthsToLabels(fy, monthFrom, monthTo);
//   const { booking, sale } = await loadPrimaryPeriodData(fy, labels);

import { loadOrderBookSaleByHead } from "./orderBookSale.js";
import { loadDispatchSaleFromDb } from "./saleFromDb.js";
import { loadStateHeadSale } from "./stateHeadSale.js";
import { loadPrimarySheetData } from "./primarySheets.js";
import { logger } from "../logger.js";

// ── Utility ───────────────────────────────────────────────────────────────────

const SHORT_MONTH = [
  "Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan","Feb","Mar",
] as const;

/**
 * Convert a fiscal-month range to an array of month_label strings.
 * monthFrom/monthTo are 1-based fiscal months (1 = Apr, 12 = Mar).
 *
 * e.g. fy="2026-27", monthFrom=1, monthTo=3 → ["Apr-26","May-26","Jun-26"]
 *      fy="2026-27", monthFrom=10, monthTo=10 → ["Jan-27"]
 */
export function fiscalMonthsToLabels(
  fy: string,
  monthFrom: number,
  monthTo: number,
): string[] {
  const fyStart = parseInt(fy.split("-")[0], 10);
  const labels: string[] = [];
  for (let idx = monthFrom - 1; idx <= monthTo - 1; idx++) {
    // Apr(0)–Dec(8) → first calendar year; Jan(9)–Mar(11) → second.
    const calYear = idx <= 8 ? fyStart : fyStart + 1;
    labels.push(`${SHORT_MONTH[idx]}-${String(calYear).slice(2)}`);
  }
  return labels;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PrimaryPeriodSide = {
  /** Company-wide total (Σ byHead). */
  total: number;
  /**
   * Display head name → Σ amount (rupees).
   * May include "Non-territory" and "Unattributed" keys.
   */
  byHead: Map<string, number>;
  /**
   * true  — figures correspond to exactly the requested period months.
   * false — figures are an FY total (sub-year filtering not available
   *         for this source; callers must surface a "FY total" warning).
   */
  periodFiltered: boolean;
  /** Human-readable source label for tile sub-lines. */
  source: string;
};

export type PrimaryPeriodResult = {
  booking: PrimaryPeriodSide;
  sale: PrimaryPeriodSide;
};

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Load period-filtered primary booking and dispatch-sale data.
 *
 * Booking and sale loads run in parallel.
 */
export async function loadPrimaryPeriodData(
  fy: string,
  monthLabels: string[],
): Promise<PrimaryPeriodResult> {
  const [booking, sale] = await Promise.all([
    _loadBookingPeriod(fy, monthLabels),
    _loadSalePeriod(fy, monthLabels),
  ]);
  return { booking, sale };
}

// ── Booking ───────────────────────────────────────────────────────────────────

async function _loadBookingPeriod(
  fy: string,
  monthLabels: string[],
): Promise<PrimaryPeriodSide> {
  // ── FY2026-27: Order Sheet with per-tab byHeadByMonth ────────────────────
  if (fy === "2026-27") {
    try {
      const ob = await loadOrderBookSaleByHead();
      if (ob.error || ob.total === 0) {
        logger.warn(
          { fy, error: ob.error },
          "primaryPeriod: booking sheet empty or unavailable",
        );
        return {
          total: 0,
          byHead: new Map(),
          periodFiltered: false,
          source: ob.error ?? "order sheet unavailable",
        };
      }

      // Filter byHeadByMonth to the requested months.
      // Tab titles vary: "Apr", "Apr-26", "April", "Apr 2026" —
      // compare on 3-char prefix so all variants resolve correctly.
      const requestedPrefixes = new Set(
        monthLabels.map((ml) => ml.slice(0, 3).toLowerCase()),
      );
      const periodByHead = new Map<string, number>();
      for (const [tabTitle, headMap] of ob.byHeadByMonth) {
        if (requestedPrefixes.has(tabTitle.trim().slice(0, 3).toLowerCase())) {
          for (const [head, amt] of headMap) {
            periodByHead.set(head, (periodByHead.get(head) ?? 0) + amt);
          }
        }
      }

      if (periodByHead.size > 0) {
        const total = Array.from(periodByHead.values()).reduce(
          (s, v) => s + v,
          0,
        );
        const pLabel =
          monthLabels.length === 1
            ? monthLabels[0]
            : `${monthLabels[0]}–${monthLabels[monthLabels.length - 1]}`;
        logger.info(
          { fy, months: monthLabels.length, total, heads: periodByHead.size },
          "primaryPeriod: booking period-filtered",
        );
        return {
          total,
          byHead: periodByHead,
          periodFiltered: true,
          source: `Order Sheet 26-27 (orders committed ${pLabel})`,
        };
      }

      // Requested months not yet available as sheet tabs — return FY total.
      logger.info(
        {
          fy,
          monthLabels,
          availableTabs: [...ob.byHeadByMonth.keys()],
        },
        "primaryPeriod: requested months not yet in booking sheet — FY total",
      );
      return {
        total: ob.total,
        byHead: ob.byHead,
        periodFiltered: false,
        source: "Order Sheet 26-27 (FY total — period tabs not yet available)",
      };
    } catch (err) {
      logger.warn({ err, fy }, "primaryPeriod: booking load failed");
      return {
        total: 0,
        byHead: new Map(),
        periodFiltered: false,
        source: `booking unavailable: ${String(err)}`,
      };
    }
  }

  // ── Historical FYs: FY-level aggregate from primarySheets.ts ────────────
  try {
    const sd = await loadPrimarySheetData(fy);
    const byHead = new Map<string, number>(
      sd.byHead.map((r) => [r.head, r.booking]),
    );
    return {
      total: sd.companyBooking,
      byHead,
      periodFiltered: false,
      source: sd.sources.booking ?? `Order Sheet ${fy} (FY total)`,
    };
  } catch (err) {
    logger.warn({ err, fy }, "primaryPeriod: historical booking load failed");
    return { total: 0, byHead: new Map(), periodFiltered: false, source: "unavailable" };
  }
}

// ── Sale / Dispatch ───────────────────────────────────────────────────────────

async function _loadSalePeriod(
  fy: string,
  monthLabels: string[],
): Promise<PrimaryPeriodSide> {
  // Primary path: sale_line DB — always period-exact for FYs in the DB.
  try {
    const dbSale = await loadDispatchSaleFromDb(fy, monthLabels);
    if (!dbSale.error && dbSale.total > 0) {
      logger.info(
        { fy, months: monthLabels.length, total: dbSale.total, heads: dbSale.byHead.size },
        "primaryPeriod: dispatch sale from DB (period-filtered)",
      );
      return {
        total: dbSale.total,
        byHead: dbSale.byHead,
        periodFiltered: true,
        source: dbSale.source,
      };
    }
    logger.info(
      { fy, monthLabels, error: dbSale.error },
      "primaryPeriod: DB sale returned no data — trying Sheets fallback",
    );
  } catch (err) {
    logger.warn({ err, fy }, "primaryPeriod: DB sale query failed — trying Sheets fallback");
  }

  // Fallback: Sheets-based loader (FY total only, no period filter).
  try {
    const sd = await loadStateHeadSale(fy);
    if (!sd.error && sd.total > 0) {
      logger.info(
        { fy, total: sd.total },
        "primaryPeriod: dispatch sale from Sheets (FY total fallback)",
      );
      return {
        total: sd.total,
        byHead: sd.byHead,
        periodFiltered: false,
        source: sd.label ?? `Sale Sheet ${fy} (FY total — period filter not applied)`,
      };
    }
  } catch (err) {
    logger.warn({ err, fy }, "primaryPeriod: Sheets sale fallback also failed");
  }

  return {
    total: 0,
    byHead: new Map(),
    periodFiltered: false,
    source: "dispatch sale unavailable",
  };
}
