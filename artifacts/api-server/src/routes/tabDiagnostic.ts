// GET /api/mgmt/tab-diagnostic?fy=2026-27
//
// Returns the full tab inventory (with content-verification results) for both
// the booking and sale sheets for the requested FY, plus a per-month summary
// of DB rows grouped by sheet_confirmed_at status.
//
// The disputed-rows table is only meaningful after the first post-migration
// backfill run: before that first run, all rows show sheet_confirmed_at=null.
import { Router, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db, saleLines } from "@workspace/db";
import {
  BOOKING_SHEETS,
  SALE_SHEETS,
  readOrderTabInventory,
} from "../lib/mgmt/primarySheets.js";

const router = Router();

router.get(
  "/mgmt/tab-diagnostic",
  async (req: Request, res: Response): Promise<void> => {
    const fy =
      typeof req.query["fy"] === "string" ? req.query["fy"].trim() : "2026-27";

    const bookingSheetId = BOOKING_SHEETS[fy] ?? null;
    const saleSheetId = SALE_SHEETS[fy] ?? null;

    if (!bookingSheetId && !saleSheetId) {
      res
        .status(400)
        .json({ error: `No primary sheets configured for FY ${fy}` });
      return;
    }

    try {
      const [bookingTabs, saleTabs, disputedRows] = await Promise.all([
        bookingSheetId
          ? readOrderTabInventory(bookingSheetId).catch((err: unknown) => {
              req.log.warn({ err, fy }, "tab-diagnostic: booking inventory failed");
              return null;
            })
          : Promise.resolve(null),

        saleSheetId
          ? readOrderTabInventory(saleSheetId).catch((err: unknown) => {
              req.log.warn({ err, fy }, "tab-diagnostic: sale inventory failed");
              return null;
            })
          : Promise.resolve(null),

        // Per-month count of rows by confirmation status.
        // sheet_confirmed_at IS NULL  → row has never been confirmed in a live read
        //                  IS NOT NULL → row was present in the sheet on that read
        db
          .select({
            monthLabel: saleLines.monthLabel,
            total: sql<number>`count(*)::int`,
            confirmed: sql<number>`count(${saleLines.sheetConfirmedAt})::int`,
            disputed: sql<number>`(count(*) - count(${saleLines.sheetConfirmedAt}))::int`,
            totalAmount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
            confirmedAmount: sql<number>`coalesce(sum(case when ${saleLines.sheetConfirmedAt} is not null then ${saleLines.amount}::numeric else 0 end), 0)::float8`,
            disputedAmount: sql<number>`coalesce(sum(case when ${saleLines.sheetConfirmedAt} is null then ${saleLines.amount}::numeric else 0 end), 0)::float8`,
          })
          .from(saleLines)
          .where(eq(saleLines.fy, fy))
          .groupBy(saleLines.monthLabel)
          .orderBy(saleLines.monthLabel),
      ]);

      res.json({
        fy,
        generatedAt: new Date().toISOString(),
        sheets: {
          booking: bookingSheetId
            ? { sheetId: bookingSheetId, tabs: bookingTabs }
            : null,
          sale: saleSheetId
            ? { sheetId: saleSheetId, tabs: saleTabs }
            : null,
        },
        disputedRows: {
          note:
            "sheet_confirmed_at=null means the row was never confirmed by a live-sheet read. " +
            "Before the first post-migration backfill, all rows appear as disputed. " +
            "After the first run, null rows were in the DB but absent from the live sheet (ghost rows).",
          byMonth: disputedRows.map((r) => ({
            monthLabel: r.monthLabel,
            total: r.total,
            confirmed: r.confirmed,
            disputed: r.disputed,
            totalAmount: Math.round(r.totalAmount),
            confirmedAmount: Math.round(r.confirmedAmount),
            disputedAmount: Math.round(r.disputedAmount),
          })),
        },
      });
    } catch (err) {
      req.log.error({ err, fy }, "tab-diagnostic: request failed");
      res.status(502).json({ error: "Tab diagnostic failed." });
    }
  },
);

export default router;
