---
name: Prayag Sheets → dashboard transform
description: Non-obvious rules for turning the two Prayag Google Sheets into the dashboard aggregate; read before touching sheets.ts / transform.ts.
---

# Prayag Sheets → dashboard transform

The dashboard's live numbers come from two Google Sheets exported as XLSX via the
google-drive connector proxy and parsed with exceljs. The mapping is fiddly and
NOT inferable from the sheets themselves.

## Which tabs / columns
- FY24-25 product sales: use the **item-wise SALE** tab. Row layout: code in
  column 2, month values in columns 3..14. Only keep codes that map to a known
  PRODUCT_GROUP — doing so reproduces the exact grand total **3,417,311,917**.
  Any other selection drifts off this control number.
- Orders (FY26-27): use the per-month **MONTHLY tabs** (Apr/May/Jun/July...),
  NOT the "Combined" tab. Combined is formula-driven and the XLSX export only
  caches the latest month's computed values, so it is unreliable.
- Monthly tab columns: 3 Doc, 5 Customer, 10 Qty, 12 Taxable, 13 Month,
  14 GROUP, 15 Station, 16 State, 17 State Head.
- Resources/coverage (live since Jul 2026): two more workbooks.
  - "Retailer-Distributor Data": "Retailer" tab (RET# rows; name c4, state c10,
    district c11, city c12) -> coverage; "Distributor" tab (DIST# rows; name c2,
    state c8) -> distributor counts.
  - "STATE HEAD DASHBOARD(2026-27)": "Data" tab (rows from 4; head c1, state c2)
    -> state->head mapping and states-per-head; "SECONDARY ORDER BOOKING
    REPORT " tab (trailing space in name; rows from 7; head c2, Total Dealer
    26-27 c11, Order Booked 26-27 c13) -> dealers per head + retailer_sales_inr.
  - Distributors are attributed to heads by voting their roster state through
    the state->head map. Head names need HEAD_ALIAS and states STATE_ALIAS
    canonicalization (e.g. ASSAM->NORTH EAST, strip trailing digits) to line up
    with order-book labels; skip the "LEFT TEAM MEMBERS" section in Data.
- Sheets API (v4) is NOT reachable through the google-drive connector proxy —
  only Drive API endpoints work. Very large sheets (e.g. "State Head Sale
  2026-27", "PARTY O/S") fail Drive XLSX export with 403; pick smaller
  dashboards/rosters as sources instead.

## Gotchas
- **Why cell helpers exist:** numeric cells in the monthly tabs are stored as
  STRINGS, and exceljs cells can be plain values, `{ result }` (formula), or
  `{ text }` (rich text). Always read through the `sheets.ts` cell helpers, which
  coerce all of these — never read `cell.value` directly.
- **Regional deviation (verified exhaustively, Jul 2026):** NO retail/resource
  customer classification exists anywhere in the order workbook — monthly tabs
  have no flag; INDEX's "TYPE" column is product type (PTMT/CP), not customer
  type; "--report" is uncached broken formulas; "LAST MONTH ORDER" has no flag.
  Exact-normalized matching of order customers to the live rosters classifies
  only ~23% (107/458). So Regional aggregates over ALL order customers by
  design; filtering by roster match would silently drop ~77% of order value.
  Do not attempt to split retail vs resource unless a real classifier column
  appears in the source sheets.
- **Live vs seed magnitudes differ legitimately:** live rosters give ~269
  distributors / ~11.5k dealers / ~18k retailers vs the old seed's 604/169/5065.
  The seed used a different (stale, manually curated) definition; live numbers
  are authoritative. Do not "fix" this by reverting to seed.
- **exceljs xlsx.load typecheck:** multi-version `@types/node` makes
  `arrayBuffer` type `Buffer<ArrayBufferLike>` clash with exceljs's expected
  `Buffer`. Cast via `Parameters<typeof workbook.xlsx.load>[0]`. If the error
  line number looks stale, delete the package's `*.tsbuildinfo` and recheck.

## Snapshot / serving model
- Data persists as immutable rows in `dashboard_snapshots` (jsonb data+manifest,
  sourceStatus, syncedAt). Latest row is served.
- `ensureSeeded()` returns the latest snapshot and only inserts a baseline when
  the table is empty; a shared in-flight promise prevents duplicate seed rows on
  concurrent first requests. It must keep returning the *latest* row (the AI
  Analyst relies on it), so do NOT permanently cache its result.
- `POST /dashboard/refresh` on sync failure returns the last good snapshot plus a
  `refreshError` string — never a blank UI. `refreshError` travels only on the
  POST response, so the frontend surfaces it from the mutation, while rendered
  data comes from the GET query (source of truth).
