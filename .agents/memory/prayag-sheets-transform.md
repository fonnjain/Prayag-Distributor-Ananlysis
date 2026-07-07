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

## Gotchas
- **Why cell helpers exist:** numeric cells in the monthly tabs are stored as
  STRINGS, and exceljs cells can be plain values, `{ result }` (formula), or
  `{ text }` (rich text). Always read through the `sheets.ts` cell helpers, which
  coerce all of these — never read `cell.value` directly.
- **Regional deviation:** monthly order tabs have no retail/resource flag, so
  Regional aggregates over ALL order customers. Distributors/dealers/coverage
  counts stay seed-sourced (from `prayag_data.json`), not live.
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
