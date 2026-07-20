import { Router, type IRouter, type Request, type Response } from "express";
import { db, saleLines } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { ORDER_BOOKING_SHEET_IDS } from "../lib/mgmt/primaryAttribution.js";
import {
  readOrderTabInventory,
  loadPrimarySheetData,
  invalidatePrimarySheetCache,
  readSaleSheetFyFiltered,
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
// Compares order-book booking (ORDER_BOOKING_SHEET_IDS, all four FYs) against
// primary dispatch from sale_line (DB), split by the is_territory flag:
//
//   is_territory = TRUE  → territory (Retail channel)
//   is_territory = FALSE → institutional (Govt / Project / JJM / GEM)
//   is_territory = NULL  → unclassified (historical FYs before flag was set)
//
// Hypothesis: institutional business is dispatched but never booked, so:
//   booking / territory_sale ≈ 1.0  while  booking / total_sale < 1.0
//
// GET /api/orders/booking-vs-sale
router.get(
  "/orders/booking-vs-sale",
  async (req: Request, res: Response): Promise<void> => {
    const fys = Object.keys(ORDER_BOOKING_SHEET_IDS).sort().reverse();
    req.log.info({ fys }, "orders booking-vs-sale: starting");

    const results = await Promise.allSettled(
      fys.map(async (fy) => {
        // ── Booking: Order Booking sheet (same correction as dry-run) ─────────
        const bookingSheetId = ORDER_BOOKING_SHEET_IDS[fy];
        const inventory = await readOrderTabInventory(bookingSheetId);
        const included = inventory.filter((t) => t.includedInSum);
        const excluded = inventory.filter((t) => !t.includedInSum);
        const monthlyTotal = included.reduce((s, t) => s + t.taxableValue, 0);
        const perHeadUniqueAmount = excluded
          .filter(
            (t) =>
              t.role === "per-head" &&
              t.contentVerification?.status === "has-unique-rows" &&
              (t.contentVerification.uniqueAmount ?? 0) > 0,
          )
          .reduce((s, t) => s + (t.contentVerification?.uniqueAmount ?? 0), 0);
        const companyBooking = monthlyTotal + perHeadUniqueAmount;

        // ── Sale: sale_line (primary register in DB), split by is_territory ───
        const [saleRow] = await db
          .select({
            totalSale:          sql<string>`sum(amount)`,
            territorySale:      sql<string>`sum(amount) filter (where is_territory = true)`,
            institutionalSale:  sql<string>`sum(amount) filter (where is_territory = false)`,
            unclassifiedSale:   sql<string>`sum(amount) filter (where is_territory is null)`,
            rowCount:           sql<number>`count(*)::int`,
            unclassifiedRows:   sql<number>`count(*) filter (where is_territory is null)::int`,
          })
          .from(saleLines)
          .where(eq(saleLines.fy, fy));

        const totalSale         = Number(saleRow?.totalSale         ?? 0);
        const territorySale     = Number(saleRow?.territorySale     ?? 0);
        const institutionalSale = Number(saleRow?.institutionalSale ?? 0);
        const unclassifiedSale  = Number(saleRow?.unclassifiedSale  ?? 0);
        const rowCount          = saleRow?.rowCount         ?? 0;
        const unclassifiedRows  = saleRow?.unclassifiedRows ?? 0;

        const crore = (n: number) => Math.round((n / 1e7) * 100) / 100;
        const ratio = (n: number, d: number) =>
          d > 0 ? Math.round((n / d) * 1000) / 1000 : null;

        return {
          fy,
          booking: {
            total: Math.round(companyBooking),
            crore: crore(companyBooking),
          },
          sale: {
            total:              Math.round(totalSale),
            territory:          Math.round(territorySale),
            institutional:      Math.round(institutionalSale),
            unclassified:       Math.round(unclassifiedSale),
            rowCount,
            unclassifiedRows,
            crore:              crore(totalSale),
            territoryCrore:     crore(territorySale),
            institutionalCrore: crore(institutionalSale),
          },
          ratios: {
            bookingVsTotalSale:     ratio(companyBooking, totalSale),
            bookingVsTerritorySale: ratio(companyBooking, territorySale),
          },
          note: unclassifiedRows > 0
            ? `${unclassifiedRows} rows (${crore(unclassifiedSale)} Cr) have is_territory=NULL`
            : null,
        };
      }),
    );

    const report = results.map((r, i) => {
      if (r.status === "rejected") return { fy: fys[i], error: String(r.reason) };
      return r.value;
    });

    req.log.info(
      report.map((r) => ({ fy: r.fy, error: "error" in r ? r.error : null })),
      "orders booking-vs-sale: complete",
    );

    res.json(report);
  },
);

// ── FY reconciliation: DB vs filtered State Head Sale workbooks ─────────────
//
// Each "State Head Sale" workbook holds TWO fiscal years (prior + named FY).
// This route reads the target FY from every workbook that contains it by
// filtering on the FY YEAR column ("FY-2024-25" format), then compares the
// filtered total against sale_line (DB).
//
// Three-way comparison for FY2024-25:
//   1. sale_line (DB) — primary register, fully ingested
//   2. State Head Sale 2025-26 filtered on "FY-2024-25"  (configured below)
//   3. State Head Sale 2024-25 filtered on "FY-2024-25"  (sheet ID pending)
//
// Naming convention: workbook "20AA-BB" holds FY20(AA-1)-AA and FY20AA-BB.
// For a target FY "2024-25": the workbook named "2024-25" AND "2025-26" both contain it.
//
// GET /api/orders/fy-reconcile              — defaults to FY2024-25
// GET /api/orders/fy-reconcile?fy=2025-26
router.get(
  "/orders/fy-reconcile",
  async (req: Request, res: Response): Promise<void> => {
    const fy =
      typeof req.query["fy"] === "string" ? req.query["fy"].trim() : "2024-25";
    req.log.info({ fy }, "orders fy-reconcile: starting");

    const crore = (n: number) => Math.round((n / 1e7) * 100) / 100;

    // ── DB: sale_line total for the target FY ─────────────────────────────────
    const [dbRow] = await db
      .select({
        total:    sql<string>`sum(amount)`,
        rowCount: sql<number>`count(*)::int`,
      })
      .from(saleLines)
      .where(eq(saleLines.fy, fy));

    const dbTotal    = Number(dbRow?.total    ?? 0);
    const dbRowCount = dbRow?.rowCount ?? 0;

    // ── Sheets: State Head Sale workbooks that contain the target FY ──────────
    // Workbook "20AA-BB" contains the FY named after it AND the prior FY.
    // So FY "2024-25" appears in workbook "2024-25" (not configured) and "2025-26".
    const startYear = parseInt(fy.split("-")[0], 10);
    const endYY     = (startYear + 1) % 100;
    const nextFyKey = `${startYear + 1}-${String(endYY + 1).padStart(2, "0")}`;

    type SheetInfo = { sheetId: string; label: string };
    // Add entries here as sheet IDs become known.
    const STATE_HEAD_SALE: Partial<Record<string, SheetInfo>> = {
      "2025-26": {
        sheetId: SALE_SHEETS["2025-26"],
        label:   "State Head Sale 2025-26 (holds FY2024-25 + FY2025-26)",
      },
      // "2024-25": { sheetId: "<id>", label: "State Head Sale 2024-25 (holds FY2023-24 + FY2024-25)" },
      // "2026-27": { sheetId: "1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs", label: "State Head Sale 2026-27 (holds FY2025-26 + FY2026-27)" },
    };

    const sheetKeys = [fy, nextFyKey];
    const configured: Array<SheetInfo & { fyKey: string }> = [];
    const unconfigured: string[] = [];

    for (const key of sheetKeys) {
      const info = STATE_HEAD_SALE[key];
      if (info) {
        configured.push({ ...info, fyKey: key });
      } else {
        unconfigured.push(
          `State Head Sale ${key} — sheet ID not yet configured (filter: FY-${fy})`,
        );
      }
    }

    const sheetResults = await Promise.allSettled(
      configured.map(async ({ sheetId, label }) => {
        const r = await readSaleSheetFyFiltered(sheetId, fy);
        return {
          label,
          sheetId,
          total:        Math.round(r.total),
          crore:        crore(r.total),
          delta:        Math.round(r.total - dbTotal),
          deltaCrore:   crore(r.total - dbTotal),
          fyYearValues: r.fyYearValues,
          ntHeads:      r.ntHeads,
        };
      }),
    );

    const sheets = sheetResults.map((r, i) => {
      if (r.status === "rejected") {
        return {
          label:   configured[i].label,
          sheetId: configured[i].sheetId,
          error:   String(r.reason),
        };
      }
      return r.value;
    });

    req.log.info(
      { fy, dbTotal: Math.round(dbTotal), sheets: sheets.length },
      "orders fy-reconcile: complete",
    );

    res.json({
      fy,
      db: {
        total:    Math.round(dbTotal),
        crore:    crore(dbTotal),
        rowCount: dbRowCount,
        source:   `sale_line WHERE fy = '${fy}'`,
      },
      sheets,
      unconfigured,
      note: `FY YEAR filter: "FY-${fy}". Each workbook holds two FYs; this isolates the target FY only.`,
    });
  },
);

export default router;
