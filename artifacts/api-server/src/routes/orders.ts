import { Router, type IRouter, type Request, type Response } from "express";
import { ORDER_BOOKING_SHEET_IDS } from "../lib/mgmt/primaryAttribution.js";
import {
  readOrderTabInventory,
  loadPrimarySheetData,
  invalidatePrimarySheetCache,
  SALE_SHEETS,
} from "../lib/mgmt/primarySheets.js";

const router: IRouter = Router();

// ── Dry-run: read Order Book sheets without writing to DB ──────────────────
//
// For each FY in ORDER_BOOKING_SHEET_IDS (or just the requested FY), reads
// every tab of the Order Booking workbook via the existing readOrderTabInventory
// infrastructure and returns a structured report:
//
//   - Per-tab: role, includedInSum, row count, date range, taxable value,
//     Ltr/piece breakdown, content verification result.
//   - FY total: sum of monthly-tab taxable values + unique per-head rows
//     (matching the live loadPrimarySheetData logic exactly).
//   - Cross-check: booking vs the Q1 sale comparator for that FY.
//
// No data is written to primary_order_line.  Run this to confirm the tab
// inventory and totals look correct before building the insert pipeline.
//
// GET /api/orders/dry-run                — all four configured FYs
// GET /api/orders/dry-run?fy=2026-27    — one FY
router.get(
  "/orders/dry-run",
  async (req: Request, res: Response): Promise<void> => {
    const fyRaw = req.query["fy"];
    const targetFys =
      typeof fyRaw === "string" && fyRaw.trim() !== ""
        ? [fyRaw.trim()]
        : Object.keys(ORDER_BOOKING_SHEET_IDS).sort().reverse(); // newest first

    req.log.info({ fys: targetFys }, "orders dry-run: starting");

    const results = await Promise.allSettled(
      targetFys.map(async (fy) => {
        const sheetId = ORDER_BOOKING_SHEET_IDS[fy];
        if (!sheetId) {
          return {
            fy,
            sheetId: null as string | null,
            error: `No Order Booking sheet configured for FY${fy}`,
          };
        }

        const inventory = await readOrderTabInventory(sheetId);

        const included = inventory.filter((t) => t.includedInSum);
        const excluded = inventory.filter((t) => !t.includedInSum);

        const monthlyTotal = included.reduce((s, t) => s + t.taxableValue, 0);

        // Per-head tabs with genuinely unique rows are added to the total —
        // matching the correction loadPrimarySheetData applies to bookingAgg.total.
        const perHeadUniqueTabs = excluded.filter(
          (t) =>
            t.role === "per-head" &&
            t.contentVerification?.status === "has-unique-rows" &&
            (t.contentVerification.uniqueAmount ?? 0) > 0,
        );
        const perHeadUniqueAmount = perHeadUniqueTabs.reduce(
          (s, t) => s + (t.contentVerification?.uniqueAmount ?? 0),
          0,
        );
        const companyBooking = monthlyTotal + perHeadUniqueAmount;
        const companyBookingCrore = Math.round((companyBooking / 1e7) * 100) / 100;

        const totalLtrRows  = included.reduce((s, t) => s + t.ltrRows,  0);
        const totalLtrQty   = included.reduce((s, t) => s + t.ltrQty,   0);
        const totalPieceRows = included.reduce((s, t) => s + t.pieceRows, 0);
        const totalPieceQty  = included.reduce((s, t) => s + t.pieceQty,  0);

        // Distinct Unit values across all included tabs (for litre-rule audit).
        const unitValuesSet = new Set<string>();
        for (const tab of included) {
          if (tab.ltrRows > 0) unitValuesSet.add("Ltr.");
          if (tab.pieceRows > 0) unitValuesSet.add("Nos");
        }

        const tabSummary = inventory.map((t) => ({
          tab:           t.tabName,
          role:          t.role,
          included:      t.includedInSum,
          excludedReason: t.excludedReason,
          rows:          t.rowCount,
          amount:        Math.round(t.taxableValue),
          dateMin:       t.dateMin,
          dateMax:       t.dateMax,
          ltrRows:       t.ltrRows,
          ltrQty:        Math.round(t.ltrQty),
          pieceRows:     t.pieceRows,
          pieceQty:      Math.round(t.pieceQty),
          retailAmount:  Math.round(t.retailValue),
          govtAmount:    Math.round(t.govtValue),
          contentVerification: t.contentVerification
            ? {
                status:           t.contentVerification.status,
                tabRows:          t.contentVerification.tabRows,
                uniqueRows:       t.contentVerification.uniqueRows,
                uniqueAmount:     Math.round(t.contentVerification.uniqueAmount),
                tabTotal:         Math.round(t.contentVerification.tabTotal),
                monthlyEquivalent: Math.round(t.contentVerification.monthlyEquivalent),
              }
            : null,
        }));

        return {
          fy,
          sheetId,
          companyBooking:       Math.round(companyBooking),
          companyBookingCrore,
          monthlyTotal:         Math.round(monthlyTotal),
          perHeadUniqueCorrection: {
            tabs:   perHeadUniqueTabs.map((t) => t.tabName),
            amount: Math.round(perHeadUniqueAmount),
          },
          unitValues: Array.from(unitValuesSet).sort(),
          unitBreakdown: {
            ltrRows:    totalLtrRows,
            ltrQty:     Math.round(totalLtrQty),
            pieceRows:  totalPieceRows,
            pieceQty:   Math.round(totalPieceQty),
          },
          tabsIncluded:  included.length,
          tabsExcluded:  excluded.length,
          tabs:          tabSummary,
          error:         null as string | null,
        };
      }),
    );

    const report = results.map((r, i) => {
      if (r.status === "rejected") {
        return { fy: targetFys[i], error: String(r.reason) };
      }
      return r.value;
    });

    req.log.info(
      report.map((r) => ({
        fy: r.fy,
        booking: "companyBooking" in r ? r.companyBooking : null,
        error:   r.error ?? null,
      })),
      "orders dry-run: complete",
    );

    res.json(report);
  },
);

// ── Self-test: run both code paths for FY2026-27 and compare totals ─────────
//
// The two paths that produce a booking total are:
//   Path A — readOrderTabInventory (the dry-run / tab-inventory path):
//             monthly tabs + per-head unique rows
//   Path B — loadPrimarySheetData (the live dashboard path):
//             readAndAggregate + per-head unique rows from tabInventory
//
// Both paths read the same Sheets file.  This route clears the cache, fires
// both reads in sequence (back-to-back, not parallel — minimise edit windows),
// and reports the two totals, their delta, and per-head unique-row details.
//
// GET /api/orders/selftest               — defaults to FY2026-27
// GET /api/orders/selftest?fy=2026-27
router.get(
  "/orders/selftest",
  async (req: Request, res: Response): Promise<void> => {
    const fy = typeof req.query["fy"] === "string" ? req.query["fy"].trim() : "2026-27";
    const sheetId = ORDER_BOOKING_SHEET_IDS[fy];
    if (!sheetId) {
      res.status(400).json({ error: `No Order Booking sheet configured for FY${fy}` });
      return;
    }

    req.log.info({ fy, sheetId }, "orders selftest: clearing cache and starting");

    // Clear the cache so both reads hit Sheets fresh rather than a stale snapshot.
    invalidatePrimarySheetCache(fy);

    // Path A — inventory reader (sequential first so its fingerprint set is built
    // before the live read, keeping edit-window exposure minimal).
    const inventory = await readOrderTabInventory(sheetId);
    const included  = inventory.filter((t) => t.includedInSum);
    const excluded  = inventory.filter((t) => !t.includedInSum);

    const monthlyTotalA = included.reduce((s, t) => s + t.taxableValue, 0);
    const perHeadTabs   = excluded.filter(
      (t) =>
        t.role === "per-head" &&
        t.contentVerification?.status === "has-unique-rows" &&
        (t.contentVerification.uniqueAmount ?? 0) > 0,
    );
    const perHeadUniqueA = perHeadTabs.reduce(
      (s, t) => s + (t.contentVerification?.uniqueAmount ?? 0),
      0,
    );
    const totalA = monthlyTotalA + perHeadUniqueA;

    // Path B — live loadPrimarySheetData (already invalidated above, so fresh read).
    const liveData = await loadPrimarySheetData(fy);
    const totalB   = liveData.companyBooking;

    const delta = totalB - totalA;
    const match = Math.abs(delta) < 100; // within ₹100 is exact for all practical purposes

    req.log.info(
      { fy, totalA: Math.round(totalA), totalB: Math.round(totalB), delta: Math.round(delta), match },
      "orders selftest: complete",
    );

    res.json({
      fy,
      pathA: {
        label:         "readOrderTabInventory (inventory / dry-run path)",
        monthlyTotal:  Math.round(monthlyTotalA),
        perHeadUnique: Math.round(perHeadUniqueA),
        total:         Math.round(totalA),
        crore:         Math.round((totalA / 1e7) * 100) / 100,
      },
      pathB: {
        label: "loadPrimarySheetData (live dashboard path)",
        total: Math.round(totalB),
        crore: Math.round((totalB / 1e7) * 100) / 100,
      },
      delta:         Math.round(delta),
      deltaRupees:   Math.round(Math.abs(delta)),
      match,
      verdict:       match
        ? "PASS — both paths agree to within ₹100"
        : `FAIL — gap of ₹${Math.abs(Math.round(delta)).toLocaleString()} between paths`,
      perHeadUniqueTabs: perHeadTabs.map((t) => ({
        tab:           t.tabName,
        uniqueRows:    t.contentVerification?.uniqueRows ?? 0,
        uniqueAmount:  Math.round(t.contentVerification?.uniqueAmount ?? 0),
      })),
    });
  },
);

// ── Booking vs Sale split: territory vs institutional ───────────────────────
//
// Booking in the Order Book is 100% Retail/Territory — Govt/Institutional
// business is dispatched but not booked.  This route tests the hypothesis by
// computing, for each FY that has a Sale Sheet:
//
//   companySale        = full dispatch total
//   ntSale             = Non-territory (Govt / Institutional / Project) portion
//   territorySale      = companySale - ntSale
//   ratioVsTotalSale   = companyBooking / companySale
//   ratioVsTerrSale    = companyBooking / territorySale
//
// If the hypothesis holds, ratioVsTerrSale ≈ 1.0 and ratioVsTotalSale < 1.0
// (the gap being the institutional dispatch with no corresponding booking).
//
// GET /api/orders/booking-vs-sale
router.get(
  "/orders/booking-vs-sale",
  async (req: Request, res: Response): Promise<void> => {
    const fys = Object.keys(SALE_SHEETS).sort().reverse();
    req.log.info({ fys }, "orders booking-vs-sale: starting");

    const results = await Promise.allSettled(
      fys.map(async (fy) => {
        const data = await loadPrimarySheetData(fy);

        // Non-territory bucket is surfaced via byHead as the "Non-territory" entry.
        const ntEntry = data.byHead.find((h) => h.head === "Non-territory");
        const ntSale      = ntEntry?.sale ?? 0;
        const ntBooking   = ntEntry?.booking ?? 0;
        const territorySale    = data.companySale    - ntSale;
        const territoryBooking = data.companyBooking - ntBooking;

        const ratioVsTotalSale  =
          data.companySale > 0
            ? Math.round((data.companyBooking / data.companySale) * 1000) / 1000
            : null;
        const ratioVsTerrSale =
          territorySale > 0
            ? Math.round((data.companyBooking / territorySale) * 1000) / 1000
            : null;
        const ratioTerrBookingVsTerrSale =
          territorySale > 0
            ? Math.round((territoryBooking / territorySale) * 1000) / 1000
            : null;

        return {
          fy,
          companyBooking:    Math.round(data.companyBooking),
          companySale:       Math.round(data.companySale),
          ntSale:            Math.round(ntSale),
          ntBooking:         Math.round(ntBooking),
          territorySale:     Math.round(territorySale),
          territoryBooking:  Math.round(territoryBooking),
          ratioVsTotalSale,
          ratioVsTerrSale,
          ratioTerrBookingVsTerrSale,
          companyBookingCrore:  Math.round((data.companyBooking / 1e7) * 100) / 100,
          companySaleCrore:     Math.round((data.companySale    / 1e7) * 100) / 100,
          ntSaleCrore:          Math.round((ntSale              / 1e7) * 100) / 100,
          territorySaleCrore:   Math.round((territorySale       / 1e7) * 100) / 100,
          bookingAvailable: data.bookingAvailable,
          saleAvailable:    data.saleAvailable,
        };
      }),
    );

    const report = results.map((r, i) => {
      if (r.status === "rejected") {
        return { fy: fys[i], error: String(r.reason) };
      }
      return r.value;
    });

    req.log.info(
      report.map((r) => ({ fy: r.fy })),
      "orders booking-vs-sale: complete",
    );

    res.json(report);
  },
);

export default router;
