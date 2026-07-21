---
name: Register two-schema gap + missing aliases
description: FY2024-25 and FY2025-26 dispatch registers use 21-col SAP format; two column names not aliased in normalize.ts; unmapped_heads guardrail does not catch missing-column case.
---

## The two schemas

Schema A — FY2026-27, 18-col SALE SHEET layout (live sync target):
`Serial, InvoiceNo, Date, BillFrom, CustomerName, City, Destination, ItemCode, Color, Quantity, MRP, SaleRate, TaxableValue, GROUP, STATION, STATE, STATE HEAD, MONTH`

Schema B — FY2024-25 and FY2025-26, 21-col SAP-format layout:
`SrNo, Date, Document No., Location.Name, Customer.Name, State Name, Item Code, Old ERP Code, Item.Name, Item.Color, Item.Segment, Unit.Name, Quantity, Rate, Sale Rate, Taxable Value, State Head.Name, Month, GROUP, STATION, STATE`

Column detection is by name (normHeader + findIndex in mapRegisterColumns) — correct design.

## Missing aliases (normalize.ts mapRegisterColumns)

| Field | SAP header | normHeader result | Current find() list | Gap |
|-------|-----------|-------------------|--------------------|----|
| color | Item.Color | ITEMCOLOR | COLOR, COLOUR | missing ITEMCOLOR → -1 |
| head  | State Head.Name | STATEHEADNAME | STATEHEADA, STATEHEAD | missing STATEHEADNAME → -1 |

## Guardrail gap

When `head = -1`, every row's `headRaw = null`. `canonHead(null, ...)` returns early without bumping `unmapped_heads`. The ingestion guardrail check "zero unmapped heads" does NOT fire — the guardrail only catches values that appear but don't match, not columns that are absent. So an un-aliased head column would pass ingestion silently with null headCanon on every row.

## Fix (not yet applied)

Two additive alias additions in `normalize.ts` `mapRegisterColumns()`:
```
color: find("COLOR", "COLOUR", "ITEMCOLOR"),
head: find("STATEHEADA", "STATEHEAD", "STATEHEADNAME"),
```
These do not affect FY2026-27 (Schema A) — additive only.

**Why:** Both un-pausing FY2025-26 and any historical re-sync of FY2024-25 via live Sheets require these aliases first. Without them, ingestion succeeds but all rows get null head/color, silently breaking the territory/institutional analytics split for those FYs.

**How to apply:** Add the two alias strings before any live Sheets read of FY2024-25 or FY2025-26 is attempted. The register_sheets.json comment now documents this prerequisite.
