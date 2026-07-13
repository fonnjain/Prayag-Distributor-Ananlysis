# Replit Agent Prompt — Upload feature for **Secondary Order Booking 2026-27**

> Paste below the line. The FY2026-27 secondary file does not exist in Drive yet. Build an upload path
> so the client can drop it in manually the moment they have it, and everything that is currently
> "Pending" fills automatically.

---

## WHY
Secondary Order Booking is the **only** source that carries a salesperson (`Team Member Name`). Without
the FY2026-27 file, per-person **Order Booking**, **Achievement**, **Low Performers** and the
**Performance vs History** page all show "Pending". Drive has 2023-24, 2024-25 and 2025-26 — no 2026-27.
The client will produce it from the SFA export and upload it manually.

## 1. UPLOAD UI

Add to **Settings → Data Imports** (alongside the State Head Dashboard upload) a card:
**"Secondary Order Booking"**

- Drag/drop or file-picker: accepts **.xlsx and .csv**
- **FY selector** (default 2026-27) — so the same feature can also re-upload an older year
- Store the raw file in **object storage keyed by FY** so it survives restarts/redeploys
- Re-uploading the same FY **replaces** it (never appends — that would double-count)
- Show after upload: filename, FY, rows parsed, date range found, distinct team members, total value,
  uploaded-at, and who uploaded it
- Allow **delete / revert** to the previous upload

**Also keep auto-discovery from Drive.** Keep checking folder
`1Ww2B1FKjpshRTcOa_F7OUBiBsBzpVCPZ` for a 2026-27 file. **Precedence: a Drive file wins over an upload**
(Sheets stays the system of record). If both exist, use Drive and show a note saying the upload is being
ignored because the live sheet now exists.

## 2. EXPECTED SCHEMA (match the existing 2025-26 file)

Reference: `1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80`

| Column | Notes |
|---|---|
| **Date** | order date (daily) |
| Retailer Id | |
| **Retailer** | |
| Order ID | |
| **Segment** | product segment |
| Cat No | item code |
| Qty | |
| Order Value | gross |
| **Distributor** | |
| **Sub Total** | ⭐ **NET — this is the value column to sum. Not Order Value.** |
| **Team Member Name** | ⭐ the salesperson — the whole reason this file matters |

**Resolve columns by header text, not position** — the SFA export's column order may drift. Detect the
header row by content (the row containing `Team Member Name` and `Sub Total`).

## 3. PARSE + VALIDATE (do this before accepting the file)

Run a **validation pass** and show the result *before* committing the import:

- Required columns present? If any of `Date`, `Sub Total`, `Team Member Name`, `Retailer`,
  `Distributor` is missing → **reject with a clear message naming the missing column.**
- Dates within the selected FY (Apr 2026 – Mar 2027)? Report any out-of-range rows and their count.
- `Sub Total` numeric (strip commas/currency)? Report non-numeric rows.
- **Team member name match** against the roster after normalisation (uppercase, trim, collapse spaces,
  strip `(Off Roll)` / trailing `(city)`): report match % **by rows and by value**, and **list every
  unmatched name with its order value**.
- Duplicate `Order ID`s → warn.
- Show a **preview**: rows, date range, distinct team members, distinct retailers, distinct
  distributors, total ₹.
- Then: **Confirm import** / Cancel.

**Stream-parse the file** (exceljs WorkbookReader / streaming CSV). It may be large — the 2025-26 file
is ~8 MB. Do not load it whole into memory.

## 4. CRITICAL RULES (these have broken the app before)

- **Member spine = UNION** of the roster **and** every distinct `Team Member Name` in this file. A
  person with orders but no roster row is still a real salesperson (off-roll / left / newly added) —
  **show them, count their revenue, mark "not in roster"**. Never drop revenue because a name is
  missing from the roster. *(FY25-26 had 240 members vs a 182-person roster; using the roster as the
  spine dropped 60 people and ₹22.6 Cr.)*
- **Sum `Sub Total`**, never `Order Value`.
- **Read every row** — no chunk/row cap. Log rows read + min/max order date so a truncated read is
  visible. *(A truncated read once showed ₹46 Cr instead of ₹240 Cr.)*
- This is **SECONDARY** (distributor → retailer). **Never** merge it with primary (Order Sheet /
  SALE SHEET) or let it fill a primary tile. Label every figure "Secondary (net)".

## 5. WHAT LIGHTS UP AUTOMATICALLY ONCE IT'S UPLOADED

Wire the upload into the existing pipeline so no further work is needed:
- State Head Dashboard: **Order Booking**, **Achievement %**, **Low Performers** for FY2026-27
- Sales page: per-person secondary reports
- **Performance vs History (Secondary)**: switch from the primary-bridge proxy to real secondary data,
  and make it the main view
- Remove the "2026-27 Secondary Order Booking file not found" banner

## 6. VERIFICATION (prove the loader works, using a year you already have)

Add a self-test: **upload the FY2025-26 file through this same feature** and confirm it reproduces the
known-good anchors — **₹240.14 Cr total, 240 team members, ~52,515 orders, Sandeep Dadheech ₹157.39 Cr,
Biju C.O ₹5.55 Cr.** If the uploader can reproduce those, it will handle 2026-27 correctly.

## ACCEPTANCE
- [ ] Upload accepts .xlsx/.csv, FY-tagged, persisted to object storage, replace-on-reupload.
- [ ] Validation runs **before** import; missing columns rejected by name; unmatched member names listed
      with their value; preview shown; explicit Confirm step.
- [ ] Columns resolved by header text; file stream-parsed; every row read.
- [ ] Member spine = union(roster, file); nobody dropped; `Sub Total` used for value.
- [ ] Drive file takes precedence over an upload if one appears.
- [ ] Uploading the FY2025-26 file reproduces ₹240.14 Cr / 240 members / Biju C.O ₹5.55 Cr.
- [ ] Once a 2026-27 file is loaded, Order Booking / Achievement / Low Performers / Performance-vs-History
      populate and the "not found" banner disappears.

## WHAT NOT TO DO
- Do not append on re-upload (double-counting) — replace.
- Do not use the roster as the member spine.
- Do not sum `Order Value` — use `Sub Total`.
- Do not let secondary data feed a primary tile, or vice versa.
- Do not silently drop rows whose team member isn't in the roster — surface them.
