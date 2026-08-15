---
name: Red Alert calibration findings
description: Guard 3 bug, data source gaps, and threshold calibration results for the Red Alert engine (B/C categories).
---

## Guard 3 closed-FY fix

`register_month_state` only records freeze events for the **open FY** (the one currently being loaded).
Closed FYs (March 31 passed) never get entries. Guard 3 was incorrectly treating all months of closed FYs
as incomplete, suppressing every B/C alert for them.

**Fix (guards.ts):** Added `isFyClosed(fy, nowDate)` helper. Guard 3 now passes without a frozen-months
entry when the FY's March 31 has passed. Open FYs still require explicit entries.

**Why:** FY2024-25 and FY2025-26 had 1,191 candidates suppressed by Guard 3 before the fix.

## Data source gaps that cause 0 alerts

**B-primary (distributor/dealer) alerts:** `buildPrimaryBAlerts` reads `sale_line_current` filtered by
`is_territory=true`. FY2024-25 and FY2025-26 (Schema-B registers) have NO rows with `is_territory=true`
in `sale_line_current` — only FY2023-24 and FY2026-27 do. So distributor-level B-alerts only fire for
FY2026-27 (comparing vs FY2025-26 secondary data).

**C1/C2 (state territory alerts):** Both use `stateCanon` from `customerSale`. FY2024-25 and FY2025-26
rows in `sale_line_current` have `state_canon = NULL` (schema-B registers have no STATE col; migration 008
backfills customer master but sale_line rows remain NULL). C1/C2 will fire 0 for any analysis using
those FYs as current or prior.

## Confirmed data source for retailer B-alerts

B1-B5 retailer alerts correctly use `secondary_sku_line` (ctx.retailerSale + ctx.retailerSku).
`sale_line_current` does NOT carry per-retailer data — it records distributor→company shipments only.
This is confirmed by Aug 2026 calibration: all fired B-alerts show RET# identifiers.

## Calibrated thresholds (Aug 2026)

After Guard 3 fix, FY2025-26 full-year produced 1,193 B-alerts at original settings (RETAILER_RUPEES=₹2L).

Revised config (red_alert_config.json):
- `RETAILER_RUPEES`: 200,000 → **1,000,000** (₹10L) — cuts eligible pool from ~2,300 to ~994 retailers
- `B2_NOMINAL_DECLINE_FLOOR_PCT`: 25 → **40** — tighter sustained collapse threshold
- `B5_PRIOR_CODE_FLOOR`: 20 → **30** — broader baseline basket required
- `B5_BREADTH_DROP_FLOOR_PCT`: 50 → **60** — structural collapse, not seasonal noise
- Result at new thresholds: 236 alerts for FY2025-26 full-year (B1=121, B2=8, B3=23, B4=18, B5=64)
- The page cap of 20 is a display limit; alerts are sorted by rupeesAtStake and top-N shown.

## Section 9 sensitivity run (engine health)

At deliberately permissive thresholds (B1=-5%, B2=5%, ₹0 floor) the B-engine fires on virtually all
retailers showing any decline. This confirms the Guard 3 fix and secondary_sku_line data path are correct.
