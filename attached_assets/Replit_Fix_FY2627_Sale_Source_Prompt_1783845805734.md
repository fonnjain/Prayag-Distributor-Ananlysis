# Replit Agent Prompt — Fix the State Head Dashboard's empty FY2026-27 view

> Paste below the line. Three small fixes. The page is working correctly — it just isn't pointed at
> the right sale source, and it defaults to a year whose order data doesn't exist yet.

---

## FIX 1 — Wire the FY2026-27 **Sale** source (currently showing "—")

`Sale Report 26-27` has a live source. Use **Order Sheet 26-27**:

```
order_sheet_26_27 = "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A"
```

Read via chunked `values.get` (no `files.export`). Header row 1. Columns (detect by header text, not
index):

`Date · Document No. · Location.Name · Customer.Name · GROUP · Old ERP Code · Item.Color · Unit.Name ·
Quantity · Rate · **Taxable Value** · Month · STATION · STATE · **STATE HEAD** · STATE HEAD B ·
STATE HEAD A · GROUP (bucket) · channel (Retail/Govt)`

- **Sale value = `Taxable Value`** (net). Filter to the selected FY/period via `Date` / `Month`.
- **STATE HEAD is already in the sheet** — no lookup needed. Apply the existing head-alias
  normalisation (`BIJJU→Biju C.O`, `RIZVI JI→Syed Aqil Rizvi`, `PAWAN KUMAR→Pawan Sharma`, …) and
  bucket `OTHER/PROJECT/GOVT/GEM/JJM` as **Non-territory** (never a person).
- Roll up to State Head for the Summary view. Per-member Sale only where the Party→TM bridge resolves;
  otherwise show at head level (do not guess).
- Sanity check: FY2026-27 total Σ Taxable Value should land near the **₹73 Cr** register benchmark.

Fallback source if needed (same data, 2-year combined): `State Head Sale 2026-27` =
`1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs` (filter on its FY column).

## FIX 2 — Default the FY selector to **2025-26**

FY2026-27 has **no Secondary Order Booking file**, so Order Booking and Achievement cannot be computed
for that year. FY2025-26 is complete and works fully.

- Default the FY selector to **2025-26** so the page loads with real data.
- Keep 2026-27 selectable; when chosen, it shows targets + Sale, with Order Booking / Achievement
  marked **Pending** (current behaviour is correct — keep it).
- Once a FY2026-27 secondary file appears in folder `1Ww2B1FKjpshRTcOa_F7OUBiBsBzpVCPZ`, auto-discover
  it and switch the default to the latest FY with complete data.

## FIX 3 — "180 no target" is a data problem, not a bug

The app is reading `Prayag Target Master` (`1ZLok3_8AZHdfrUm4T2lJmonAjngQFz4TuNLkHtU3p2I`) correctly —
the sheet currently holds only 2 test rows (hence Target ₹0.07 Cr). The client is pasting in the
FY2025-26 (194 rows, annual) and FY2026-27 (154 rows, Q1 monthly) backfills.

Make sure the reader handles **both target shapes**:
- **FY2025-26 rows**: `*_annual` populated, monthly = annual/12.
- **FY2026-27 rows**: only `*_m_Apr/May/Jun` populated, `*_annual` **blank** — this is a **valid
  target**, not "No Target".
- `achievement % = actual(period) ÷ Σ target_m_<months in selected period>`. Never divide an annual
  target by 12 when explicit monthly values exist.
- Only show `No Target` when a member has **no** target value in the period.

## ACCEPTANCE
- [ ] FY2026-27 **Sale** tile and column populate from Order Sheet 26-27 (≈ ₹73 Cr total).
- [ ] Page defaults to FY2025-26 and loads with real Order Booking, Achievement, and Low Performers.
- [ ] FY2026-27 still shows Order Booking / Achievement as "Pending" with the existing banner.
- [ ] After the target backfill is pasted, Target + Achievement populate for both years; "no target"
      count drops to the genuinely target-less members only.
- [ ] Head names normalised; institutional bucketed; no `files.export`.

## WHAT NOT TO DO
- Do not put Sale (primary) numbers into the Order Booking column — different metric.
- Do not treat FY26-27's blank `*_annual` as "No Target" when monthly values exist.
- Do not fabricate FY2026-27 secondary order data.
