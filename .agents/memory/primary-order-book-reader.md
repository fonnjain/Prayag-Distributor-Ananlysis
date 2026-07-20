---
name: Primary Order Book reader quirks
description: Column detection rules and per-FY layout differences in readOrderTabInventory (primarySheets.ts)
---

## Value column aliases
The header-detection regex accepts three variants (all three call sites in primarySheets.ts):
- `Taxable Value` — FY2024-25, FY2025-26, FY2026-27
- `Taxable Amount` — alternate spelling
- `Amount` (anchored `^amount$`) — FY2023-24

## State Head column — optional
FY2023-24 has no State Head column.  The condition is `tI >= 0` only (not `&& hI >= 0`).
When `headIdx = -1`, head-level aggregation is silently skipped; row counts and totals are still correct.
Head-column alias regex (main reader + inventory reader):
`/state\s*head|^head$|^tm\s*(name)?$|^rsm$|^sm$|sales\s*head|^zone$/i`

## FY2023-24 positional fallback (no header row)
11 of 12 monthly tabs have **no header row** — data starts at row 0.
Activation signature (checked on globalRow === 0 only):
- col 1 = Excel date serial in range 40 000–60 000
- col 17 = positive numeric amount

Fixed column positions:
| idx | col | contents |
|-----|-----|----------|
| 0   | SrNo | — |
| 1   | Date | Excel serial |
| 2   | Vch/BillNo | invoice no |
| 3   | Customer | customer name |
| 4   | Item Group | — |
| 5   | Item Code | product code |
| 6   | Item Name | — |
| 7   | COLOR | — |
| 10  | Qty | — |
| 12  | Unit | Nos (no Ltr rows in FY2023-24) |
| 17  | Amount | net booking value |
| 19  | Month | text e.g. "Apr-2023" |
| 20  | Channel | "Retail" / "Govt" |

## Dry-run anchors (GET /api/orders/dry-run)
| FY | Full-year booking | Q1 (Apr–Jun) | Q1 sale anchor | Q1 ratio |
|----|-------------------|--------------|----------------|----------|
| 2026-27 | ₹86.56 Cr (Apr–Jul) | — | ₹86.82 Cr (self-test) | 0.997 ✓ |
| 2025-26 | ₹342.03 Cr | — | ₹74.2 Cr (sale) | n/a (full yr) |
| 2024-25 | ₹333.81 Cr | ₹79.13 Cr | ₹68.6 Cr (sale) | 1.154 |
| 2023-24 | ₹377.39 Cr | ₹105.38 Cr | ₹87.4 Cr (sale) | 1.21 |

**Why:** Booking > sale ratios are normal (orders placed > invoices raised in same period).
FY2023-24 ratio 1.21 is above the 1.0–1.15 expected band but was accepted by user.

## Insert pipeline status (July 2026)
`primary_order_line` table exists (schema at `lib/db/src/schema/orderLines.ts`).
`GET /api/orders/dry-run` reads all four FY workbooks and reports tab inventory.
Insert pipeline (write rows to DB) not yet built — dry-run only.
