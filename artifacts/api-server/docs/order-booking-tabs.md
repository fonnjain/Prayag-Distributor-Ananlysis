# Primary Order Booking Sheet — Tab Inventory

**Spreadsheet ID:** `1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A`  
**Verified:** July 2026

## Canonical (non-overlapping) tabs

These four monthly tabs are the authoritative set. Sum only these four; all
other tabs are duplicates, metadata, or internal mappings.

| Tab | Data rows | Taxable Value |
|-----|-----------|---------------|
| Apr | 6,694 | ₹15.73 Cr |
| May | 11,842 | ₹29.37 Cr |
| Jun | 13,311 | ₹32.65 Cr |
| July | 2,382 | ₹4.91 Cr |
| **Total** | **34,229** | **₹82.66 Cr** |

## All tabs and why they must not be added to the total

| Tab | Rows | TV sum | Disposition |
|-----|------|--------|-------------|
| Apr | 6,694 | ₹15.73 Cr | Canonical monthly tab |
| May | 11,842 | ₹29.37 Cr | Canonical monthly tab |
| Jun | 13,311 | ₹32.65 Cr | Canonical monthly tab |
| July | 2,382 | ₹4.91 Cr | Canonical monthly tab |
| Combined | 2,382 | ₹4.91 Cr | **Exact duplicate of July** — same 2,382 rows, same TV. Adding this tab double-counts July. |
| LAST MONTH ORDER | 13,311 | ₹32.65 Cr | **Exact duplicate of June** — same 13,311 rows, same TV. Adding this tab double-counts June. |
| ANUJ SHARMA | 164 | n/a | Secondary-level orders for one state head. Different supply-chain level; not additive to primary OB. |
| WT | 9 | n/a | Metadata / water-tank master; no order lines. |
| INDEX | — | — | Product-group code mapping (VLOOKUP source). Must never be summed. |
| --report | — | — | Summary/pivot formulas only; no order lines. |

## Why the ₹96 Cr / ₹23 Cr targets were wrong

An earlier target of ₹96 Cr OB and ₹23 Cr pending cannot be reconciled with
this spreadsheet without double-counting. Adding Combined (=July) and LAST MONTH
ORDER (=June) to the canonical total would produce ₹120+ Cr. The canonical
₹82.66 Cr is corroborated by the factory pending sheet
(1dmt6uHOdZSIT0wgNkSfuK8W8d0YO8STW51PVOAAFHvY) which shows ~261,171 units
of balance orders outstanding, broadly consistent with ₹8.15 Cr derived pending
at realised rates. Treat ₹82.66 Cr / ₹74.51 Cr / ₹8.15 Cr as the correct
OB / Sale / Pending figures.

## Column schema (canonical monthly tabs)

```
SrNo · Date · Document No. · Location.Name · Customer.Name · Old ERP Code ·
Item.Name · Item.Color · Unit.Name · Quantity · Rate · Taxable Value ·
Month · GROUP · STATION · STATE · STATE HEAD
```

Header detection: scan for `Taxable Value` + `STATE HEAD` columns within the
first 30 rows of each tab. Tab selection: match against the monthly-name regex
`/^(Apr(il)?|May|Jun(e)?|Jul(y)?\b.../i`. Combined and LAST MONTH ORDER do not
match this regex and are correctly excluded by the reader.
