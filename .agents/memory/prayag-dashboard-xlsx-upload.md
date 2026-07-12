---
name: Dashboard xlsx upload pattern
description: STATE HEAD DASHBOARD xlsx upload, parsing, and report integration rules
---

## Parser rules
- The "Data" tab header row is detected by scanning the first 10 rows for a row that contains BOTH a "Name" column (exact match) and a "State Head" column (partial match).
- Do NOT hardcode a row number — the header differs by FY (row 2 in FY2025-26, row 3 in FY2026-27).
- If the "Target" cell contains the text "Primary" → secondaryTarget = null (the TM is a primary-only rep).
- "Active/ Left" column values are normalised to "Active" | "Left" | null.

## FY-specific target period rules
- FY2025-26: targets are ANNUAL. Store `secondaryTarget` as annual; leave `secondaryMonthly` all null (renderer auto-splits).
- FY2026-27: targets are QUARTERLY Q1 (Apr-Jun). Store Q1 total in `secondaryTarget` on the record; in the TargetRow set `annual.secondary = null` and `monthly.secondary = [total/3, total/3, total/3, null×9]`.

## Storage and cache
- Parsed JSON: `uploads/dashboard-state-head-{fy}.json`
- Raw xlsx: `uploads/dashboard-state-head-{fy}.xlsx`
- In-process Map cache; call `invalidateDashboardXlsxCache(fy)` after each re-upload.

## Report integration
- `assembleRows` in report.ts loads `buildDashboardXlsxLookup(fy)` AFTER loading the Target Master.
- Target Master (Sheets) entries take precedence — xlsx only fills gaps.
- Departed TMs (in order file but not roster) now resolve `stateHead` via the xlsx lookup because the xlsx includes Left members. Without an uploaded xlsx AND an empty Target Master, supplemental rows are silently skipped (no error — they're just dropped from the report output).

## Upload flow
- GET /api/mgmt/dashboard-xlsx/upload-url → presigned GCS PUT URL
- PUT <uploadUrl> (browser → object storage directly)
- POST /api/mgmt/dashboard-xlsx/register {fy, uploadUrl, fileName} → download, parse, store
- GET /api/mgmt/dashboard-xlsx/:fy → status summary

**Why:** The xlsx files contain manual data (targets, CTC, designation, emp-code, DOJ, Active/Left) that exists nowhere else in any system — no Sheets API, no DB. They are uploaded once per FY.
