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

**Key finding (live probe Jul-2026)**: the header row has 20 labeled columns (0–19);
data rows extend to col 20.  Col 20 in data rows = SEGMENT (customer market category:
'Govt', 'Retail', possibly others) — **NOT a channel flag**.  SEGMENT is NOT used for
ntBooking or is_territory.  CHANNEL_COL_OVERRIDE sets chanIdx=-1 to block detection.

STATE HEAD columns 23–25 appear in the HEADER ROW only; they are EMPTY in ALL data rows.
headIdx=-1 in readAndAggregate → ntBooking = 0 for FY2023-24 (honest: no HEAD, no channel).
is_territory = null for all FY2023-24 rows in primary_order_line.

Verified column positions (0-indexed, from header row):
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
| 17  | Amount       | net booking value (the detected value column) |
| 19  | Month        | text "Apr-2023" / "Mar-2024" — last labeled header col |
| 20  | SEGMENT      | customer market category — NOT a channel; BLOCKED by override |

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
Route uses readOrderTabInventory (companyBooking) + readBookingAggregated (ntBooking).
ntBooking comes from readAndAggregate: HEAD method when headIdx>=0; channel-column
'Govt' rows when headIdx=-1.  govtValue is stored as an audit field, NEVER drives ntBooking.

Per-FY ntBooking source (confirmed Jul-2026):
  FY2026-27  HEAD column → NON_TERRITORY_RE
  FY2024-25  HEAD column → NON_TERRITORY_RE (captures GEM/JJM/PROJECT heads)
  FY2025-26  headIdx=-1; channel col (last-non-empty header fallback)
  FY2023-24  headIdx=-1; SEGMENT at col 20 BLOCKED via CHANNEL_COL_OVERRIDE (chanIdx=-1) → ntBooking=0

Verified anchors (July 2026, CHANNEL_COL_OVERRIDE block for FY2023-24):
  FY2026-27: booking ₹87.01 Cr, ntBooking ₹6.57 Cr, govtAudit ₹0
  FY2025-26: booking ₹342.03 Cr, ntBooking ₹12.56 Cr (channel), govtAudit ₹12.56 Cr
  FY2024-25: booking ₹333.81 Cr, ntBooking ₹41.34 Cr (HEAD), govtAudit ₹16.76 Cr
  FY2023-24: booking ₹377.39 Cr, ntBooking ₹0 (no HEAD + col 20=SEGMENT blocked), govtAudit ₹0

Cold-cache warm-up: startup fires readOrderTabInventory+readBookingAggregated for all 4 FYs
sequentially in the background. Both have 30-min TTL module-level caches. First call ~2 min.

## isTerritory detection rules for primary_order_line ingest
chanIsExplicit=true (explicit header match OR CHANNEL_COL_OVERRIDE with explicit=true):
  cell matches /^govt/i → isTerritory=false; else → isTerritory=true.
chanIsExplicit=false (last-non-empty fallback, no override):
  Can't trust cell value as channel flag → use HEAD column vs NON_TERRITORY_RE.
  HEAD empty and no override → isTerritory=null.
CHANNEL_COL_OVERRIDE chanIdx=-1: blocks channel detection entirely → isTerritory=null.

FY2023-24: chanIdx=-1 (SEGMENT blocked) + headIdx=-1 → all rows isTerritory=null.
FY2024-25: NON_TERRITORY_RE on HEAD → 14,554 institutional rows (₹41.62 Cr).
FY2025-26: 4,274 institutional rows = ₹12.56 Cr; 143,732 territory; 0 null ✓
FY2026-27: 2,627 institutional rows = ₹6.57 Cr; 33,645 territory; 0 null ✓

## Insert pipeline status (July 2026) — COMPLETE
`primary_order_line` schema at `lib/db/src/schema/orderLines.ts` — migrated.
`ingestOrderBookingFy(fy, opts)` in primarySheets.ts — monthly tabs only; ON CONFLICT DO NOTHING.
`POST /api/orders/ingest?fy=<fy>&dry_run=true|false` — trigger route.
lineUid key: sha1(fy|sourceTab|customer|code|qty|taxableValue|occurrence); occurrence per-tab.
monthLabel: from invoice_date column first, then from tab title + FY year offsets.

Verified DB row counts and totals (all 4 FYs, Jul-2026):
  FY2023-24: 138,950 rows ₹377.39 Cr — all is_territory=null (no HEAD col; SEGMENT blocked)
  FY2024-25: 145,781 rows ₹333.81 Cr — 131,227 territory / 14,554 institutional / 0 null ✓
  FY2025-26: 148,006 rows ₹342.03 Cr — 143,732 territory / 4,274 institutional (₹12.56 Cr) / 0 null ✓
  FY2026-27:  36,272 rows  ₹87.01 Cr —  33,645 territory / 2,627 institutional (₹6.57 Cr) / 0 null ✓
  Total: 469,009 rows. Per-head unique rows (e.g. ANUJ SHARMA) not yet inserted.
  Ingest idempotency verified: re-running any FY returns inserted=0.
