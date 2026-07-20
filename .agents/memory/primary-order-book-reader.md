---
name: Primary Order Book reader quirks
description: Column detection rules, per-FY layout differences, and dry-run anchors for readOrderTabInventory (primarySheets.ts)
---

## Value column aliases
The header-detection regex accepts three variants (all three call sites in primarySheets.ts):
- `Taxable Value` — FY2024-25, FY2025-26, FY2026-27
- `Taxable Amount` — alternate spelling
- `Amount` (anchored `^amount$`) — FY2023-24

## State Head column — optional
Detection gate is `tI >= 0` only (not `&& hI >= 0`) in both `readAndAggregate` and
`readOrderTabInventory`.  When `headIdx = -1`, head-level aggregation is skipped;
row counts and totals are still correct.
Head-column alias regex: `/state\s*head|^head$|^tm\s*(name)?$|^rsm$|^sm$|sales\s*head|^zone$/i`

## FY2023-24 layout (Order Sheet 23-24, 1jtSUGE6…)
The header IS present at row 1 (Sheets rows are 1-based; readTabRowsChunked starts
at start=1, so globalRow starts at 1 — the old `globalRow === 0` positional fallback
was dead code).  After the alias fix the header is found normally.

Verified column positions (0-indexed):
| idx | header       | notes |
|-----|--------------|-------|
| 0   | SrNo         | — |
| 1   | Date         | **text "DD-MMM-YY"** e.g. "01-Mar-24", NOT Excel serial |
| 2   | Vch/BillNo   | invoice no |
| 3   | Customer     | customer name |
| 4   | Item Group   | — |
| 5   | Item Code    | product code |
| 10  | Qty          | piece qty |
| 11  | Free Qty     | captured separately, never folded into Qty |
| 12  | Unit         | "Nos" / "Ltr." — **plain "Unit"**, NOT "Unit.Name" |
| 13  | MRP          | — |
| 14  | Base Price   | — |
| 15  | Discount(%)  | — |
| 16  | Sale Price   | — |
| 17  | Amount       | net booking value (the detected value column) |
| 18  | ITEM CODE    | alternate code col |
| 19  | Month        | text "Mar-2024" (not "Mar-24") |
| 20  | SEGMENT      | — |
| 21  | Station      | — |
| 22  | STATE        | — |
| 23  | STATE HEAD   | use this one |
| 24  | STATE HEAD B | concatenated "GROUP+HEAD+STATE" — DO NOT parse |
| 25  | STATE HEAD A | alternate head col |

Unit regex fix: `unitIdx = findCol(row, /^(unit(\.name| name)?|uom|measure)$/i)`
Date parsing: `parseOrderDate` handles DD-MMM-YY via explicit regex branch.

Litre rule in FY2023-24 order sheet:
- Feb: 537 Ltr rows, 26.87 lakh litres; Apr-Jan: 0 Ltr rows (all Nos)
- Mar: 558 Ltr rows, 23.73 lakh litres
- Total FY2023-24: 1,095 Ltr rows, 50.59 lakh litres; 137,855 piece rows

Tab structure anomaly:
- "SHEET" tab: lookup/exclusion list (7 entity names like BHIWADI CASH, DELHI CASH,
  PRAYAG PLYMER entities, SAMPLE). Added to SKIP_TAB_RE.
- "SEGMENT INDEX" tab: classified as per-head (two title-case words), cv=unreadable
  (no tax header). Zero contribution to total — harmless but could add to SKIP_TAB_RE.
- "combined" + "LAST MONTH ORDER": confirmed-subset (correctly excluded, not double-counted).

## Per-head unique-row correction (dry-run vs live path)
`loadPrimarySheetData` adds `cv.uniqueAmount` from per-head tabs with `status === "has-unique-rows"`.
The dry-run route MUST apply the same correction to match.
Known instance: **ANUJ SHARMA** tab — 162 unique rows, ₹39.39 lakh (FY2026-27 booking).
Without this correction, dry-run total was ₹86.56 Cr vs live ₹86.82 Cr.

## Self-test route (GET /api/orders/selftest)
Clears cache, runs both paths back-to-back, reports delta.
FY2026-27 self-test result (July 2026): PASS, delta = 0, both paths = ₹86.96 Cr.

## Dry-run anchors (GET /api/orders/dry-run, corrected totals)
| FY | Full-year booking | Notes |
|----|-------------------|-------|
| 2026-27 | ₹86.96 Cr (Apr–Jul) | ANUJ SHARMA correction included; self-test PASS |
| 2025-26 | ₹342.03 Cr | No BOOKING_SHEETS entry; from ORDER_BOOKING_SHEET_IDS only |
| 2024-25 | ₹333.81 Cr | — |
| 2023-24 | ₹377.39 Cr | Q1 ratio 1.21 — accepted by user |

## SALE_SHEETS["2025-26"] discrepancy
Sheet ID 1RuXHIXfusOT… ("State Head Sale 2025-26") returns ₹702.28 Cr via readAndAggregate,
vs primary register total ₹361.14 Cr.  Ratio ≈ 1.94 — likely double-counting or wrong
sheet type (secondary vs primary).  Do not use this entry for booking-vs-sale ratio
analysis until clarified.  For territory/institutional split on FY2025-26, use analytics
route (sale_line) not SALE_SHEETS.

## Booking vs Sale split (GET /api/orders/booking-vs-sale)
Route compares loadPrimarySheetData booking vs sale by FY, splitting by Non-territory bucket.
FY2026-27 (4 months booking, 3 months sale — not comparable):
  booking ₹86.96 Cr, sale ₹77.68 Cr, ntSale ₹6.24 Cr, ntBooking ₹6.55 Cr.
  Note: ₹6.55 Cr of booking triggers NON_TERRITORY_RE — contradicts "100% Retail" Phase 0.
FY2025-26: booking = 0 in BOOKING_SHEETS (only in ORDER_BOOKING_SHEET_IDS).
  SALE_SHEETS["2025-26"] total unreliable (see discrepancy above).

## Insert pipeline status (July 2026)
`primary_order_line` schema at `lib/db/src/schema/orderLines.ts`.
`GET /api/orders/dry-run` reads all four FY workbooks (corrected total).
`GET /api/orders/selftest` — path A vs path B agreement test.
`GET /api/orders/booking-vs-sale` — territory/institutional split vs booking.
Insert pipeline (DB write) not yet built — dry-run only.
