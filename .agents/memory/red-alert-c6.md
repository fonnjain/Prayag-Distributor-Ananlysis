---
name: Red Alert C6 — Territorial Concentration
description: Phase 2 implementation of territorial concentration alert (C6). Covers B3 analysis, threshold calibration, and implementation notes.
---

## What C6 does
Fires when a single state head's territory accounts for ≥ C6_MIN_STOPS retailer stops AND ≥ C6_MIN_STOP_SHARE_PCT share of all attributable stops in the period.

**"Stop"** = retailer above ₹10 L materiality floor with non-zero prior-period purchases and zero in the current window.

**Denominator** = all stopped retailers with a resolvable state_head (product-category rows excluded via: no hr_status AND not is_state_head).

**Basis stated on alert card** via extraForReport.denominator and extraForReport.excludedProductCategories.

## Calibration (Q1 FY2026-27 vs Q1 FY2025-26, ₹10 L floor)

| State Head          | Stops | ₹ Cr  | Share   |
|---------------------|-------|-------|---------|
| Sandeep Dadheech    | 52    | 9.48  | 78.8 %  |
| Syed Aqil Rizvi     | 10    | 1.35  | 15.2 %  |
| Lalan Kumar         |  2    | 0.37  |  3.0 %  |
| Biju C.O            |  1    | 0.23  |  1.5 %  |
| (unmapped)          |  1    | 0.11  |  1.5 %  |

**Threshold ≥10 AND ≥30%**: Sandeep fires (52, 78.8 %), Rizvi does not (15.2 % < 30 %). Separates cleanly.

Before Phase 1 (state_head chain walk): Sandeep ~40, Rizvi ~9, ~24 unmapped. Phase 1 resolved 23 of 24 unmapped, mostly to Sandeep (+12) and Rizvi (+1), Lalan (+2), Biju (+1).

## Implementation details

- **entityKey** = state_head canonical name; **entityType** = "team"
- **extraForReport.stateHead** = state_head name → scope.ts routing works without changes (non-person entity → detailHead lookup)
- Normalized name lookup via `s.toLowerCase().replace(/[^a-z0-9]/g, '')` handles "A. Prasath" ↔ "a.prasath" dot edge case
- Operates at individual retailer stop level (not distributor card level), for operational clarity

## Context additions
- **retailerHeadCanon**: Map<fy, Map<retailer, head_canon>> — Query 16 in context.ts, DISTINCT ON (fy, retailer) highest-value head_canon per retailer

## Narendra alias fix
Migration 038: alias_primary of id=19 (Narendra Sharma) gets "NARENDRA KUMAR SHARMA" appended. Applied directly to DB on 2026-08-16; migration is idempotent.

## What fires in calibration output
C6: 1 alert per period (Sandeep Dadheech). Shown in calibration script section 1 (by-code counts).
