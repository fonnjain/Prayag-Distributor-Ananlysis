---
name: Departed-import pattern
description: How historical departed TM names are imported as inactive person records to enable Band B assignment suggestions
---

## Rule
Import distinct `former_person_name_raw` values from `customer_assignment` as inactive `person` rows with `source='departed_import'` so the Band B suggestion engine can bridge departed→head→active TM.

## Why
180 departed TM names in customer_assignment had no matching person row. Without them, Band B (former colleague match) was 0/737; with them it jumped to 465/737. The names are exact-match bridges only — no fuzzy matching.

## Key facts
- Migration `049_person_source_departed_import` added `'departed_import'` to the `person_source_check` constraint (previously only `'hr_sheet'` and `'app_created'`).
- Inserted rows: `is_active=false`, `is_state_head=false`, `is_holding=false`, `state_head_person_id` and `reports_to_person_id` both set to the dominant territory state head.
- State head resolved from: the territory where the departed TM's customers are most concentrated, joined via `person_territory` → count of active TMs → `DISTINCT ON` descending.
- Attribution check: FY2025-26 `sale_line` totals by `head_canon` were byte-for-byte identical before/after insert (no FK from sale_line to person).
- Band B join: `LOWER(TRIM(person.name)) = LOWER(TRIM(former_person_name_raw))` — case-insensitive exact match; source='departed_import' filter prevents active-person false matches.

## How to apply
If more departed names surface in future, re-run the distinct-name query against `customer_assignment`, diff against existing `source='departed_import'` rows, and batch-insert new ones. The Band B engine picks them up automatically — no code change needed.

## Structural gap (Rajasthan)
Narendra Kumar Sharma (person_id=25, RAJASTHAN) has **0 active TMs** (Aug 2026). Departed TMs in RAJASTHAN resolved to his head correctly, but Band B requires an active TM under that head in the territory — finding none, they fall to Band C. Fix: update those departed persons' `state_head_person_id` from 25 → 14 (Pawan Kumar Sharma), who actually staffs RAJASTHAN with 5 TMs. This would convert ~36 of the 158 Band C residual to Band B.
