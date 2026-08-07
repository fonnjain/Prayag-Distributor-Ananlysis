# HR Roster Discrepancies — Working Sheets vs Roster Status

**Purpose:** Tracks members whose working sheets show recent or current-FY activity but whose roster status is Deactive/LEFT. Each case requires business confirmation: either correct the roster status (and add an active roster row) or confirm the sheet is historical-only.

---

## Open cases requiring business resolution

### Case 1 — Shiv Kumar Patel (MP/Rewa, under Faraz Khan)

| Field | Value |
|-------|-------|
| Roster status | Deactive since **13 Sep 2025** |
| Roster DOJ | 01-Sep-2022 |
| Roster DOL | 13-Sep-2025 |
| Emp Code | 812 |
| Reporting Manager | Faraz Khan (464) |
| HQ (roster) | Rewa, MADHYA PRADESH |
| Working sheet ID | `1xUKQcbDwYMW0gppBwEYDVX4butdCRbJhc-AGKQLvMzY` |
| Sheet last dated | **7 August 2026** |
| Sheet content | Summary Report 25-26 tab — 84 retailers across Rewa, Satna and Mauganj |
| normSecKey | `shivkumarpatel` |

**Discrepancy:** Roster marks him departed Sep 2025, but the working sheet carries a date of 7 Aug 2026, well into FY 2026-27. The sheet is maintained and mapped for historical read (`member_sheet_map.json`). This is the same class as the Ashutosh Kumar (Rudrapur) gap identified earlier.

**Resolution required from business:**
- If **active**: confirm current territory and reporting line; a new active roster row must be added to `hr_roster.csv` and the `member_sheet_map.json` entry retained.
- If **departed**: no code change needed; sheet entry retained for historical read-back only.

---

### Case 2 — Neeraj (Haryana, under Pawan Kumar Sharma)

| Field | Value |
|-------|-------|
| Roster status | Deactive / LEFT since **3 Jun 2026** |
| Roster DOJ | 01-Dec-2025 |
| Roster DOL | 03-Jun-2026 |
| Emp Code | 259369696 |
| Reporting Manager | Pawan Kumar Sharma (856) |
| HQ (roster) | Ateli-Mahendragarh, HARYANA (roster district: Rewari — mismatch noted below) |
| Working sheet ID | `1hBER3zTZpkPEdxBS-u7qW1ycgJwvdCYaiyqb9HCWGHk` |
| Sheet content | **Summary Report 26-27** tab — 42 retailers in Mahendragarh district |
| normSecKey | `neeraj` |

**Discrepancy (two issues):**
1. Roster marks him departed 3 Jun 2026, but the working sheet contains a Summary Report **26-27** tab, implying FY 2026-27 data was collected after his recorded departure.
2. Roster lists his district as **Rewari**, but the sheet records all 42 retailers under **Ateli-Mahendragarh** (Mahendragarh district) — a geographic inconsistency.

The `neeraj` entry already exists in `member_sheet_map.json` and is retained for historical read-back.

**Resolution required from business:**
- If **active**: confirm current status, correct DOL in roster, and clarify correct district (Rewari or Mahendragarh); update `hr_roster.csv` accordingly.
- If **departed**: no code change needed; confirm whether the 26-27 sheet data was pre-departure work or entered in error.

---

## How to act on a resolution

### Confirming active — add roster row

Add a new row to `artifacts/api-server/config/hr_roster.csv` with current details (Status = Active, no Date of Leaving). The `member_sheet_map.json` entry already exists (or has been added) and requires no further change.

### Confirming departed — no action

The sheet entry in `member_sheet_map.json` is intentionally retained so historical member-sheet reads continue to work. No code or config change is required.

---

## History

| Date | Event |
|------|-------|
| Aug 2026 | Both cases identified during sheet-mapping review (Task 157 / Task 158) |
| Aug 2026 | `shivkumarpatel` added to `member_sheet_map.json`; `neeraj` was already present |
| Aug 2026 | Cases surfaced to business for resolution alongside existing nine HR discrepancies |
