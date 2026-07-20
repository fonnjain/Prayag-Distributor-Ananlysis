import { Router, type IRouter, type Request, type Response } from "express";
import { ORDER_BOOKING_SHEET_IDS } from "../lib/mgmt/primaryAttribution.js";
import { readOrderTabInventory } from "../lib/mgmt/primarySheets.js";

// Booked-order Q1 sale anchors (primary register, Apr–Jun) for booking/sale
// ratio cross-check.  FY2026-27 also serves as the content self-test anchor:
// the dry-run total must match the live-sheet companyBooking of Rs.86.82 Cr.
const SALE_Q1_ANCHORS: Record<string, { label: string; crore: number }> = {
  "2026-27": { label: "booking self-test anchor",  crore: 86.82 },
  "2025-26": { label: "Q1 primary sale comparator", crore: 74.2  },
  "2024-25": { label: "Q1 primary sale comparator", crore: 68.6  },
  "2023-24": { label: "Q1 primary sale comparator", crore: 87.4  },
};

const router: IRouter = Router();

// ── Dry-run: read Order Book sheets without writing to DB ──────────────────
//
// For each FY in ORDER_BOOKING_SHEET_IDS (or just the requested FY), reads
// every tab of the Order Booking workbook via the existing readOrderTabInventory
// infrastructure and returns a structured report:
//
//   - Per-tab: role, includedInSum, row count, date range, taxable value,
//     Ltr/piece breakdown, content verification result.
//   - FY total: sum of monthly-tab taxable values (company booking).
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

        const companyBooking = included.reduce((s, t) => s + t.taxableValue, 0);
        const companyBookingCrore = Math.round((companyBooking / 1e7) * 100) / 100;

        const totalLtrRows  = included.reduce((s, t) => s + t.ltrRows,  0);
        const totalLtrQty   = included.reduce((s, t) => s + t.ltrQty,   0);
        const totalPieceRows = included.reduce((s, t) => s + t.pieceRows, 0);
        const totalPieceQty  = included.reduce((s, t) => s + t.pieceQty,  0);

        const anchor = SALE_Q1_ANCHORS[fy];
        const ratioVsAnchor =
          anchor && anchor.crore > 0
            ? Math.round((companyBookingCrore / anchor.crore) * 1000) / 1000
            : null;

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
          anchor: anchor
            ? {
                label:  anchor.label,
                crore:  anchor.crore,
                ratio:  ratioVsAnchor,
                withinBand: ratioVsAnchor != null
                  ? ratioVsAnchor >= 1.0 && ratioVsAnchor <= 1.15
                  : null,
              }
            : null,
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

export default router;
