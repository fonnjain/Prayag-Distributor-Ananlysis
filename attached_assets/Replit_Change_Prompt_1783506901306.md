# Replit Agent Prompt — Prayag Sales Intelligence (change request)

> Paste everything below the line into the Replit agent, and attach the 8 Excel files.
> This is a **modification of the existing app**, not a rebuild. Do not scaffold a new project.

---

## CONTEXT

This app is a sales-intelligence dashboard for Prayag India. It already runs and reads live
Google Sheets. I am attaching 8 Excel exports of those same sheets. Their purpose is
**verification and backfill only** — the app must keep reading live Google Sheets at runtime.

Attached files:

| File | Contents |
|---|---|
| `State_Head_Sale_2024-25.xlsx` | invoice-line sales register |
| `State_Head_Sale_2025-26.xlsx` | invoice-line sales register |
| `State_Head_Sale_2026-27.xlsx` | invoice-line sales register (current year) |
| `Order_Sheet_23-24.xlsx` … `Order_Sheet_26-27.xlsx` | order book, monthly tabs |
| `rate_list.xlsx` | item master (item group, unit, MRP) |

---

## NON-NEGOTIABLE CONSTRAINTS

1. **Live Google Sheets stay the runtime source of truth.** The Excel files are a one-time
   backfill + an ongoing verification fixture. Never make the app depend on them at runtime.

2. **The 10 MB ceiling exists in two places. Handle both.**
   - **Reading Sheets:** Google Drive `files.export` fails above 10 MB. **Do not use
     `drive.files.export` or `files.get?alt=media` on these spreadsheets.** Use the Sheets API
     `spreadsheets.values.get` / `values.batchGet` with **chunked A1 ranges** (e.g. 50,000 rows
     per call: `Sheet1!A1:N50000`, then `A50001:N100000`, …) until a call returns fewer rows
     than the chunk size. `values.get` has no 10 MB export cap.
   - **Ingesting the attached xlsx:** these files are 16–24 MB and will exhaust Replit's memory
     if loaded whole. **Stream them.** Use `exceljs`'s streaming `WorkbookReader` (Node) or
     `openpyxl` with `read_only=True, values_only=True` (Python). Never `XLSX.read()` the whole
     buffer. Do not commit the xlsx into the repo — parse them from a temp/object-storage path
     and discard.

3. **Backfill must be idempotent** and must run against **both** the dev database and the
   deployed/production database (same migration + same seed job, pointed at each
   `DATABASE_URL`). Re-running must insert nothing new and corrupt nothing. Use `ON CONFLICT
   (line_uid) DO NOTHING` (see schema below).

4. **Never invent or interpolate a number.** If a value is missing, leave it null and report it.

---

## VERIFIED DATA FACTS — implement exactly these; do not re-derive

These were confirmed against the full workbooks. Getting any of them wrong silently produces
wrong revenue.

### A. Each register file contains TWO fiscal years

`State Head Sale 2026-27` holds **145,657 FY-2025-26 rows AND 30,658 FY-2026-27 rows**.
Same pattern in the other two.

> **Filter rows on the FY column. Never infer the year from the file name.**
> Normalise `"FY-2026-27"` → `"2026-27"`.

Expected row counts (use as an ingestion assertion):

| File | FY | Rows |
|---|---|---|
| 2024-25 | FY-2023-24 | 137,619 |
| 2024-25 | FY-2024-25 | 141,201 |
| 2025-26 | FY-2024-25 | 141,201 |
| 2025-26 | FY-2025-26 | 145,657 |
| 2026-27 | FY-2025-26 | 145,657 |
| 2026-27 | FY-2026-27 | 30,658 |

Because the prior-year block repeats across files, **deduplicate on `line_uid`** (below).
The FY-2024-25 block is identical in both files — importing both must yield 141,201 rows, not
282,402.

### B. Column names differ per year — detect headers by CONTENT, not position

| Field | 2024-25 header | 2025-26 / 2026-27 header |
|---|---|---|
| item code | `Item Code` | `CODE` |
| quantity | `Quantity` | `QTY` |
| rate | `Rate` | `SALE RATE` |
| month | `MONTH` | `M0NTH` ← spelled with a **zero** |
| state head | `STATE HEAD A` | `STATE HEAD A ` ← **trailing space** |
| fiscal year | `FY YEAR` | `FY-2025-26` ← the FY value is the **header text** |
| category | `MASTER GROUP` | `TYPE` |
| invoice / date | *absent* | `INVOICE NO`, `DATE` |

Also: the 2025-26 file carries 8 unnamed junk columns and a literal **`#VALUE!`** column.
A positional parser dies here; a content-based one ignores them.

**Header detection rule:** scan the first 20 rows; the header is the row where
`(CODE | ITEMCODE)` AND `(QTY | QUANTITY)` AND `AMOUNT` all appear after
`upper().replace(/[^A-Z0-9]/g,'')`.

`TYPE` / `MASTER GROUP` is unreliable (e.g. `WASTE PIPE` rows are tagged `PTMT GROUP`).
**Use the fine `GROUP` column as the category key.** Keep `TYPE` only as a stored fallback.

### C. `rate_list.xlsx` — header is on row 3, and `Purchase Price` is NOT cost

- The header row is the **third** row (two blank rows above it).
- There are **two `Item Code` columns**: the first is the code, the second is the item name.
  Take the **first**.
- **`Purchase Price` is a list price, not a manufacturing cost.** Verified: code `151` has
  Purchase Price `262`, MRP `274`, and an **actual realised sale rate of ~₹141**.
  Applying it as cost yields **PTMT −81.9 % gross margin** and **−27.4 % blended**, on only
  53.9 % revenue coverage. Sanitaryware computes to 52.3 % vs a known-true 37.8 %.

> **Therefore: never use `Purchase Price` for margin. There must be no cost fallback.**
> Margins stay empty until a real Cost Master exists (see Task 6).
> A wrong margin is worse than no margin.
>
> Use `rate_list` only for: item group, unit, MRP, item-name lookup.

Item codes DO join: 5,312 of 5,331 register codes match the rate list = **99.1 % of revenue**.

### D. Canonical maps — these cover 100 % of rows (verified zero unmapped)

**30 distinct `GROUP` values → 7 canonical groups:**

```json
{
  "PTMT / Faucets":              ["PTMT", "CISTERN", "SEAT COVER"],
  "CP (Chrome-Plated)":          ["C P", "CP", "CP ACCESSORIES", "CP ALLIED"],
  "Plumbing (Pipes & Fittings)": ["CPVC", "CPVC PIPE", "UPVC", "UPVC PIPE", "OPVC", "SWR",
                                  "HDPE PIPE", "CORRUGATED PIPE", "WATER TANK", "WT LID",
                                  "GARDEN PIPE", "AGRI", "COLUMN"],
  "Sink":                        ["SINK", "PLATE RACK", "CABINET", "GLASS"],
  "Sanitaryware":                ["SANITARYWARE", "GEYSER"],
  "Connection / Waste":          ["WASTE PIPE", "CONNECTION", "FLOOR TRAP"],
  "Hardware":                    ["HARDWARE", "TEFELON TAPE", "QUAA", "OTHER"]
}
```

**18 distinct `STATE HEAD A` values = 13 territory heads + 5 institutional channels:**

```json
{
  "territory_heads": ["SANDEEP JI","RIZVI JI","ANANT SINGH","SUNIL PATEL","BABU","LALAN",
                      "PAWAN KUMAR","SURESH NAIR","BIJJU","NASIR HUSAIN","SULINDER PAL",
                      "ANUJ SHARMA","SHAILESH SHARMA"],
  "institutional":   ["PROJECT","GOVT","JJM","GEM","OTHER"]
}
```

`ANUJ SHARMA` and `SHAILESH SHARMA` are **new heads in FY26-27**.
Institutional rows are **not** state heads — bucket them separately as
`"Non-territory / Project / Govt"` so they neither inflate a head nor get dropped.

**State normalisation** (the STATE column also contains channel tokens):

```json
{"W-BENGAL":"WEST BENGAL","UP ( R )":"UTTAR PRADESH","UP":"UTTAR PRADESH",
 "MP":"MADHYA PRADESH","MAHARASTRA L":"MAHARASHTRA","MAHARASTRA R":"MAHARASHTRA",
 "MAHARASTRA S":"MAHARASHTRA","MAHARASTRA":"MAHARASHTRA","TAMILNADU":"TAMIL NADU"}
```
Route `PROJECT` / `GOVT` / `OTHER` appearing in STATE to the non-territory bucket.

Any value not in these maps → **raise it in the ingestion report; never silently bucket it.**

### E. Partial-month guard (this one has already produced a false alarm)

FY26-27 July holds only ~140 lines (data stops 6 July 2026). Comparing Apr–Jul YoY shows
**−27.4 %**, which is an artifact. Complete months only (Apr–Jun) show **−2.0 %**.

> Implement `isMonthComplete(fy, month)`: a month is complete only if the max invoice DATE in
> that month ≥ the last calendar day of that month. **Every YoY / trend view must exclude
> incomplete months by default**, and label them "partial" where shown.

### F. Known data-quality issues to surface, not fix silently

- **470 duplicate lines** in FY26-27 on `(INVOICE NO, CODE, AMOUNT)` — may be legitimate repeated
  codes on one invoice. Preserve them via the occurrence counter in `line_uid`; report the count.
- **Quantity units are mixed** (pieces vs metres/kg). FY26-27 Q1 shows 11.9 M units on ₹73 Cr;
  code `144` averages 752 units/line at ₹96. **Never sum QTY across groups** without a unit
  column. Revenue (`AMOUNT`) is the only safe cross-group aggregate.

---

## TASKS

### Task 1 — Rewrite the Sheets reader for chunked reads
Replace any `files.export` / whole-file fetch with `spreadsheets.values.get` using chunked A1
ranges (50k rows/call), `valueRenderOption=UNFORMATTED_VALUE`,
`dateTimeRenderOption=FORMATTED_STRING`. Loop until a chunk returns < chunk size.
Auto-detect the data tab (registers use `Sheet1`) and the header row per §B.

**Acceptance:** reading `State Head Sale 2026-27` returns 176,315 rows without a size error.

### Task 2 — Normalisation layer
Implement §D as **config files** (`config/group_map.json`, `config/normalize.json`), not
hard-coded logic. Emit `unmapped_groups`, `unmapped_heads`, `unmapped_states` on every build.

**Acceptance:** all three registers build with **zero unmapped** values.

### Task 3 — Database schema + idempotent upsert

```sql
CREATE TABLE sale_line (
  line_uid      TEXT PRIMARY KEY,   -- see below
  fy            TEXT NOT NULL,      -- '2026-27'
  invoice_no    TEXT,
  invoice_date  DATE,
  month_label   TEXT,               -- 'Apr-26'
  customer      TEXT,
  code          TEXT NOT NULL,
  qty           NUMERIC,
  sale_rate     NUMERIC,
  amount        NUMERIC NOT NULL,
  group_raw     TEXT,
  group_canon   TEXT,
  station       TEXT,
  state_raw     TEXT,
  state_canon   TEXT,
  head_raw      TEXT,
  head_canon    TEXT,
  is_territory  BOOLEAN,
  type_raw      TEXT,
  source        TEXT NOT NULL,      -- 'sheets' | 'xlsx_backfill'
  ingested_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON sale_line (fy, month_label);
CREATE INDEX ON sale_line (fy, head_canon);
CREATE INDEX ON sale_line (fy, group_canon);

CREATE TABLE item_master (
  code TEXT PRIMARY KEY, item_name TEXT, item_group TEXT, unit TEXT, mrp NUMERIC
);

CREATE TABLE cost_master (            -- populated later; see Task 6
  code TEXT PRIMARY KEY, fg_cost NUMERIC NOT NULL, as_of DATE, source TEXT
);

CREATE TABLE ingest_run (
  id SERIAL PRIMARY KEY, started_at TIMESTAMPTZ, source TEXT, fy TEXT,
  rows_read INT, rows_inserted INT, rows_skipped INT,
  unmapped JSONB, assertions JSONB, status TEXT
);
```

**`line_uid`** = `sha1( fy | invoice_no | code | qty | amount | month_label | occurrence )`
where `occurrence` is the 0-based index among rows with an otherwise identical tuple.
This preserves the 470 legitimate duplicates while making re-import a no-op.

Upsert with `ON CONFLICT (line_uid) DO NOTHING`. `source` records provenance; on conflict the
existing row wins (a Sheets row is never overwritten by a backfill row).

### Task 4 — xlsx backfill job (streaming, idempotent, runs on prod too)

Add `npm run backfill -- --file <path> [--fy 2026-27] [--dry-run]`:
- streams the workbook (`exceljs` `WorkbookReader`, or `openpyxl read_only`)
- detects header per §B, filters by FY column per §A
- normalises per §D, computes `line_uid`, batch-inserts (1,000 rows/tx) with `ON CONFLICT DO NOTHING`
- writes an `ingest_run` row with counts + unmapped values
- `--dry-run` reports what *would* insert, changes nothing

Run it against dev, then against the deployed DB by pointing `DATABASE_URL` at production.
It must be safe to re-run.

**Acceptance:** importing all three registers yields exactly **424,477** distinct sale lines
(137,619 + 141,201 + 145,657 + 30,658 — the repeated FY-2024-25 and FY-2025-26 blocks dedupe
away). Re-running inserts **0** rows.

### Task 5 — Verification / reconciliation report
Add `GET /api/verify?fy=2026-27` comparing three sources for the same FY:
`xlsx (as ingested)` vs `live Sheets (read now)` vs `DB`.
Report per source: row count, `SUM(amount)`, distinct invoices, distinct customers, and a
by-group + by-head breakdown. Flag any delta > 0.5 %. Surface it in the UI as a "Data health" panel.

This is how "populate missing entries" gets proven: rows present in xlsx but absent from DB
are listed explicitly, with a one-click backfill.

### Task 6 — Cost Master (margins are OFF until this exists)
- Create table `cost_master` (above) and an optional Sheets tab
  `Item Code | Finished-Good Cost | As-of date | Source`, fed from the per-category BOM/GP sheets.
- Margin = `SUM(amount) − SUM(qty × cost)`, computed **only** over codes present in `cost_master`.
- Always display **cost coverage %** = share of revenue whose codes have a cost. If coverage
  < 75 %, show margins as provisional.
- **Remove any existing fallback to `rate_list.Purchase Price`.** If `cost_master` is empty,
  `margin_by_group` returns `[]` and the UI shows "Add a Cost Master to enable margins."

### Task 7 — Fix the analytics that are currently wrong
- All YoY / trend views must exclude incomplete months (§E).
- Split every headline into **Territory** vs **Institutional** (§D). The two behave in opposite
  directions and must never be blended into one growth number.
- Add a **customer retention** view: retained / lost / new between comparable periods, and the
  prior-period revenue of lost customers.

### Task 8 — Ingestion guardrails (fail loudly)
Before publishing a build, assert:
1. `Σ(by_group.amount) == Σ(by_head.amount) == Σ(by_state.amount) == grand_total` (±₹1)
2. `unmapped_groups`, `unmapped_heads` are empty
3. no negative amounts outside flagged returns
4. row count matches the §A table for the FY being ingested

Any failure → block publish, write `ingest_run.status='fail'`, alert. Do not publish partial data.

---

## SANITY BASELINE — the build is correct if it reproduces these

| Metric | Expected |
|---|---|
| FY2025-26 total (full year) | **₹361.14 Cr** |
| FY2026-27 Q1 (Apr–Jun) | **₹73.09 Cr** |
| FY2025-26 Q1 (Apr–Jun) | **₹74.56 Cr** |
| Q1 YoY (complete months) | **−2.0 %** |
| Q1 Territory YoY | **+7.8 %** (₹67.67 Cr vs ₹62.76 Cr) |
| Q1 Institutional YoY | **−54.1 %** (₹5.42 Cr vs ₹11.80 Cr) |
| FY2025-26 top head | Sandeep ji, **₹164.22 Cr (45.5 %)** |
| FY2026-27 Q1 invoices / customers | 5,714 / 439 |

If your numbers differ, the FY filter (§A) or the header detection (§B) is wrong. Fix those
before touching anything else.

---

## DEFINITION OF DONE

- [ ] No `drive.files.export` anywhere; Sheets read in chunks; 176,315-row file reads clean
- [ ] xlsx ingested by streaming; peak memory < 512 MB; no xlsx committed to the repo
- [ ] `npm run backfill` is idempotent; second run inserts 0 rows; works against prod `DATABASE_URL`
- [ ] Zero unmapped groups / heads / states across all three registers
- [ ] `/api/verify` shows xlsx ≡ Sheets ≡ DB within 0.5 % for FY2026-27
- [ ] Margins return `[]` (not garbage) while `cost_master` is empty
- [ ] YoY views exclude partial months; Territory and Institutional reported separately
- [ ] All sanity-baseline figures reproduce exactly
- [ ] Google service-account key and Anthropic key remain server-side only

---

## WHAT NOT TO DO

- Do not infer the fiscal year from a file name.
- Do not use `Purchase Price` as cost, "just to have a number."
- Do not sum `QTY` across groups.
- Do not compare Apr–Jul YoY.
- Do not blend Territory and Institutional into a single growth figure.
- Do not load a whole xlsx into memory.
- Do not commit the Excel files to the repository.
