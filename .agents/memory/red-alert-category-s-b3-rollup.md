---
name: Red Alert Category S + B3 rollup architecture
description: Destocking alert (S1), B3 distributor rollup, A1/A2 cross-suppression, and secondary state_canon backfill patterns.
---

## S1 Destocking alert (categoryS.ts)

**Rule:** fires when a distributor has ≥3 consecutive zero-primary months while secondary sell-through continues — supply exhaustion early warning, fires ~6 months before retailers go silent.

**Why:** Aradhya Kedia case showed secondary exhausted Jul-26 while primary stopped Oct-25; traditional retailer B3 alert would only fire after stock ran out.

**How to apply:**
- Only fires for the current FY (alert must be active in the current window's last complete month)
- Does NOT double-fire for the prior FY even if the streak was active then
- Linkage: secondary_sku_line.distributor → `norm2()` → sale_line_current.customer (first two words ≥4 chars, lowercase); handles name variants like "ARADHYA KEDIA DIST. PVT." ↔ "ARADHYA KEDIA DISTRIBUTION HOUSE PVT LTD"
- Context field `distSecMonthly`: `${dist}|${fy}|${month}` → net_amount (from secondary_sku_line query #15)
- Context field `retailerPrimaryDist`: fy → retailer → primary_distributor (from query #14, DISTINCT ON max-value)

## B3 retailer rollup (rollupB3Retailers in categoryB.ts)

**Rule:**  
- ≥3 stopped retailers sharing a primary distributor → one distributor-level card (retailers listed in extraForReport.retailers)  
- Combined prior ≥₹50L for a group → also rolls up  
- Individual retailers with no qualifying group survive only if prior ≥₹25L  
- Below all floors → suppressed (don't appear in any card)

**Config keys** (config/red_alert_config.json → CATEGORY_B_DEALERS_RETAILERS):
- `B3_RETAILER_ROLLUP_MIN_RETAILERS`: 3
- `B3_RETAILER_ROLLUP_MIN_COMBINED_RUPEES`: 5_000_000
- `B3_RETAILER_INDIVIDUAL_FLOOR_RUPEES`: 2_500_000

**How to apply:**
- Test mocks must use prior value ≥₹25L (3_000_000) to survive rollup and reach Guard 5
- CFG in unit test overrides: set MIN_RETAILERS=999, MIN_COMBINED_RUPEES=1e12 to preserve individual-level assertions

## A1/A2 cross-suppression (detectAlerts.ts)

**Rule:** If A2 (zero booking = Critical) fires for an entityKey, A1 (below threshold = Warning) for the SAME entityKey is suppressed. A2 supersedes A1.

**Why:** A member with zero booking trivially satisfies A1's threshold condition too — double-firing gives false impression of 2 separate problems.

**How to apply:** Build `a2Members = Set(passedAlerts.filter(A2).map(entityKey))` after guard pass; suppress any A1 whose entityKey is in a2Members.

## B3-S1 cross-linking

If a rolled-up B3 distributor also fires S1, add `hasDestockingAlert: 1` to the B3 card's `extraForReport`. Use `1` not `true` — extraForReport only allows `string|number|null|undefined`.

## #298 secondary state_canon backfill

`secondary_sku_line.state_raw` and `secondary_register_line.state_canon` are both NULL for all rows. Geographic source: `distributor_identity.state` (real state name). Territory grouping source: `person_registry.state_head` (state head's name).

Backfill used `state_head` from person_registry via `LOWER(canonical_name) = head_canon` join — 532,773 rows filled for FY2025-26/2026-27. The territorial concentration alert uses this field for grouping by territory owner.

Future ingests: skuLoader.ts notes that post-load UPDATE is the right pattern (same as how the backfill was done).

## Calibration results (commit 19c6bfc)

| FY | Raw | Final | B3 | S1 | A1→A2 suppressed |
|----|-----|-------|----|----|-----------------|
| 2025-26 | 300 | 275 | 4 | 0 | 25 cross-suppressed |
| 2026-27 | 39 | 33 | 7 | 1 | 6 (A2→A1) |

FY2026-27 breakdown: A1=11 A2=13 A3=1 B3=7 S1=1 = 33 ✓
