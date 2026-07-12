# Replit Agent Prompt — Dashboard Excel upload for MANUAL data + fix the Order-Booking regression

> Paste below the line. Two parts: (A) an urgent regression fix, (B) a new upload path that solves the
> empty-targets problem for good. Read both before starting.

---

# THE ARCHITECTURE (this is the key idea — apply it consistently)

There are two kinds of data, and they must be sourced differently:

| Kind | Examples | Source | Why |
|---|---|---|---|
| **Transactional** (system-generated) | primary sale, secondary order booking, retailers, item master, customer→head map, roster | **LIVE Google Sheets** (unchanged) | SAP / SFA / order systems already write these |
| **Manual** (typed by people; exists nowhere else) | **Targets, CTC/salary, designation, emp code, D.O.J, Active/Left, Old/New** | **the two STATE HEAD DASHBOARD files** (uploaded .xlsx, or the same file once it's a Google Sheet in Drive) | there is **no** system that generates these |

**Do not ask the user to re-key manual data into a separate Target Master sheet.** That is duplicate
entry of data the team already maintains in these dashboards, and it is why targets have stayed empty.
Read the manual data from the dashboard file itself.

Keep the existing `Prayag Target Master` write-back for *edits made inside the app*, but the dashboard
file is the **bulk source of truth** on import. On conflict, most-recently-updated wins; log it.

---

# PART A — REGRESSION (fix first)

FY2025-26 **Order Booking** now shows **₹46.34 Cr**. It previously showed ₹217.50 Cr. The correct
figure is **₹240.14 Cr**. Sale shows blank. Per-member values are also wrong
(Sujan Ghata shows ₹1.04 Cr; the approved dashboard says ₹4.72 Cr).

Diagnose and report — do not guess:
1. Row count read from Secondary Order Booking 2025-26
   (`1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80`). Is the whole sheet being read, or is a
   chunk/pagination limit truncating it? **₹46 Cr ≈ 19% of ₹240 Cr — this smells like reading only the
   first chunk of rows.**
2. The value column in use. It must be **`Sub Total`** (net after discount) — not Order Total, not MRP,
   not a partial column.
3. The FY/date filter — must include **Apr 2025 → Mar 2026** inclusive.
4. Distinct `Team Member Name` count, and how many match the roster after normalisation. List every
   unmatched name with its order value.
5. **Members = 180, but the approved dashboard has 240.** Which 60 are missing and why?

**Sale** must come from the primary register — **State Head Sale 2025-26**
(`1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA`), expected **≈ ₹361.14 Cr**.
Sale (primary) and Order Booking (secondary) are **different metrics from different sheets and must
never be equal or blank**.

---

# PART B — UPLOAD THE DASHBOARD FILES (manual data)

## B1. Upload UI
Add **Settings → Data Imports → "State Head Dashboard"**: drag/drop `.xlsx`, pick the **FY**
(2025-26 / 2026-27). Store in object storage keyed by FY (survives restarts). Re-uploading the same FY
**replaces** it. Show: file name, FY, rows parsed, uploaded-at, and a parse summary.
Also support reading the same workbook from Drive when its file id is configured
(`config/dashboard_sources.json` → `{ "2025-26": "<id>", "2026-27": "<id>" }`) — **same parser both ways**.

## B2. Parse the `Data` tab — ⚠️ HEADER ROW DIFFERS BY YEAR
- **2025-26 → header on row 2**
- **2026-27 → header on row 3**

**Detect the header by content** (the row containing both `Name` and `State Head`) — do NOT hardcode a
row number. Data starts on the next row. Stop at the first blank `Name`, and skip any `Total` row.

Verified columns (same positions in both files, but resolve by **header text**, not index):

| Field | Header text | Col |
|---|---|---|
| State Head / State / Name / Working State / Headquarter / D.O.J | as named | 1–6 |
| **Primary Target** | `Primary Target` | 7 |
| **Secondary Target** | `Target` | 8 |
| Achievement (order booking) | `Achievement` | 9 |
| **CTC Monthly** / **CTC** | `CTC Monthly` / `CTC` | 36 / 37 |
| Active / Left | `Active/ Left` | 53 |
| Target monthly | `Target monthly` | 57 |
| **Direct Dealer Primary Target** | `Direct Dealer Primary Target` | 64 |
| **Total target** | `Total target` | 65 |
| **Designation** / **Emp code** | `designation` / `emp code` | 75 / 76 |

**Dirty-data rules (real, seen in the files):**
- `Target` (col 8) sometimes contains the **text `"Primary"`** instead of a number → treat as **no
  secondary target**, not 0, not an error.
- `Target monthly` (col 57) likewise can hold text.
- `Target Achievement (%)` can be the string `"No Target"`.
- Numbers may be blank/0 → 0 and blank are different: **blank = no target**, **0 = a zero target**.

## B3. ⚠️ TARGET PERIOD DIFFERS BY YEAR — do not get this wrong
- **FY2025-26 targets are ANNUAL.** (Sujan Ghata `Target` = ₹6,06,00,000 for the year.)
- **FY2026-27 targets are QUARTERLY (Q1: Apr–Jun).** Verified: `Total target ÷ Target monthly = 3.0`
  for 126 of 133 members; achievement matches the file's own % (Sujan Ghata `8,561,254 ÷ 15,000,000 =
  57.1%`).
  → Store FY26-27 targets against **Apr/May/Jun** (target ÷ 3 per month), leave the annual figure
  **blank**. **Treating them as annual makes every achievement ~4× wrong.**
- `achievement % = actual(period) ÷ Σ target months in the selected period`.
- A member with **no** target → render **`No Target`**, never `0%`.

## B4. What to import vs what to ignore
**Import (manual data):** targets (primary / secondary / direct-dealer / total / monthly), CTC Monthly,
CTC, designation, emp code, D.O.J, Active-Left, Old/New, Secondary/Primary flag.
**Ignore (already live from Sheets — do NOT import, or you'll create a stale second copy):**
order booking, sale, retailers, orders, visits/GPS. Those stay live.
*(Exception: if a live source for a metric does not exist — e.g. FY2026-27 secondary order booking —
the dashboard's figure may be used as a clearly-labelled fallback: "from uploaded dashboard, not live".)*

## B5. Join
Join on **Name → roster Name**, normalised (uppercase, trim, collapse spaces, strip `(Off Roll)` /
`(city)` suffixes). Report match % and list unmatched names with their target/CTC — an unmatched name
is a silently-lost target. Target > 95%.

---

# ACCEPTANCE
- [ ] **A:** FY2025-26 Order Booking = **₹240.14 Cr** (±1%), 240 members, Sandeep ₹157.39 Cr,
      Biju C.O ₹5.55 Cr. Root cause of the ₹46 Cr figure identified and stated (chunking? filter? column?).
- [ ] **A:** FY2025-26 Sale = **₹361.14 Cr** (±1%) from the primary register. Sale ≠ Order Booking.
- [ ] **B:** Uploading `STATE_HEAD_DASHBOARD_2025-26.xlsx` populates targets + CTC for ~194 members;
      "no target" drops from 180 to ~46.
- [ ] **B:** Uploading `STATE_HEAD_DASHBOARD_2026-27.xlsx` populates ~154 targets (as **Q1** monthlies)
      + CTC; Sujan Ghata achievement = **57.1%**, Surojit Mondal = **23.8%**.
- [ ] Header row auto-detected (row 2 in 25-26, row 3 in 26-27) — no hardcoded index.
- [ ] `"Primary"` text in the Target column is handled as *no target*, not a crash or 0.
- [ ] Each KPI tile shows its source ("live: Secondary Order Booking 25-26" / "uploaded: dashboard 25-26").
- [ ] Transactional metrics still read LIVE from Google Sheets — nothing transactional imported from Excel.

# WHAT NOT TO DO
- Do not import order booking / sale / retailers from the Excel — those are live from Sheets.
- Do not treat FY2026-27's quarterly targets as annual.
- Do not write `0%` where a target is absent — show `No Target`.
- Do not hardcode the header row; it differs between the two files.
- Do not let Sale and Order Booking read from the same source, and never leave Sale blank.
