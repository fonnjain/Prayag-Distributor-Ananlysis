# Prayag India — Sales Intelligence

A mobile-first dashboard over live Google Sheets sales data: sales trends, growth analytics, coverage, order momentum, an AI Analyst, and a data-health reconciliation panel.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/api-server run test` — run the API server test suite (vitest; uses an isolated `dashboard_test` DB schema)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run backfill -- --file <register.xlsx> [--fy 2026-27] [--dry-run]` — idempotent xlsx backfill into `sale_line` (also `--item-master <rate_list.xlsx>`); runs against whatever `DATABASE_URL` points at (dev or prod)
- Required env: `DATABASE_URL` — Postgres connection string
- Optional env: `DASHBOARD_SYNC_INTERVAL_MINUTES` — scheduled live-sync interval (default 60, `0` disables)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- Frontend app: `artifacts/prayag` (Vite + React, previewPath `/`)
  - `src/pages/Dashboard.tsx` — shell (nav, live status header, Refresh button)
  - `src/components/dashboard/*` — Overview, Regional, Resources, Products, OrderMomentum, Growth (YoY/retention/margins), DataSources (+ DataHealth reconciliation panel), Analyst
  - `src/data/dashboard-context.tsx` — `DashboardProvider` / `useDashboard()`; fetches live data via generated hooks, falls back to bundled seed
  - `src/data/dataset.ts` — formatters/colors; `src/data/prayag_data.json` — bundled seed + canonical payload shape (drives TS types)
  - Tabs are deep-linkable (`/targets`, `/reports`, ...); `Dashboard.tsx` derives the active tab from the wouter route
- API: `artifacts/api-server` (Express, proxied at `/api`)
  - `src/lib/sheets.ts` — Google Drive connector XLSX export + exceljs cell helpers
  - `src/lib/dashboard/{transform,seed,sync}.ts` — Sheets→aggregate transform, seed loader, snapshot sync/persistence
  - `src/routes/dashboard.ts` — `GET /dashboard`, `POST /dashboard/refresh`; `src/routes/analyze.ts` — AI Analyst (reads latest snapshot)
  - `src/lib/registers/{normalize,ingest,sheetsApi,sheetsRegister,xlsxStream}.ts` — invoice-line register pipeline: header detection, normalization (config-driven), chunked Sheets reads with 429 retry, streaming xlsx, idempotent inserts + ingestion guardrails
  - `src/backfill.ts` — xlsx backfill CLI (registers + item master); `config/{group_map,normalize,expected_counts,register_sheets}.json` — normalization maps, expected row counts per FY, live register spreadsheet IDs
  - `src/lib/verify/verify.ts` + `src/routes/verify.ts` — `GET /verify` (xlsx vs live Sheets vs DB reconciliation), `POST /verify/backfill`
  - `src/lib/analytics/analytics.ts` + `src/routes/analytics.ts` — `GET /analytics` (complete-months YoY, territory vs institutional, retention, margins)
  - `data/prayag_data.json` — seed source for the baseline snapshot
- DB schema (source of truth): `lib/db/src/schema/dashboardSnapshot.ts` (table `dashboard_snapshots`) and `lib/db/src/schema/salesRegister.ts` (`sale_line`, `item_master`, `cost_master`, `ingest_run`)
- API contract (source of truth): `lib/api-spec/openapi.yaml` — regenerate hooks/schemas with `pnpm --filter @workspace/api-spec run codegen`

## Architecture decisions

- Dashboard data is stored as immutable snapshots (jsonb `data` + `manifest`) in `dashboard_snapshots`; each sync appends a row and the latest is served. This gives free history and a graceful fallback.
- `GET /dashboard` always returns data via `ensureSeeded()` (seeds bundled baseline if empty). `POST /dashboard/refresh` runs a live sync and, on failure, returns the last good snapshot plus a `refreshError` string — the UI never goes blank.
- On startup the server seeds synchronously then kicks off a background live sync, so first paint is instant (seed) and upgrades to live shortly after.
- FY24-25 totals come from the item-wise SALE tab (only PRODUCT_GROUP-mapped codes → exact 3,417,311,917). Orders come from the per-month MONTHLY tabs, not the formula-driven Combined tab (which is not cached in the export).
- Resources and coverage are live too: retailer/distributor rosters come from the "Retailer-Distributor Data" workbook; per-head dealers, states, and secondary order value come from "STATE HEAD DASHBOARD(2026-27)". The live sync no longer merges any seed fields. See `.agents/memory/prayag-sheets-transform.md` for tab/column mappings and alias rules.
- Monthly order tabs have no retail/resource flag, so Regional aggregates over all order customers.
- The refresh pipeline is regression-tested against fixture workbooks (`artifacts/api-server/src/__tests__/`): control totals, failure fallback, and first-run seeding. Tests run against a `dashboard_test` Postgres schema, never the real table.
- Invoice-line data lives in `sale_line` keyed by a deterministic `line_uid` (fy|month|customer|code|qty|rate|amount|occurrence — invoice number excluded; occurrence counter must see all rows in source order). Inserts are `ON CONFLICT DO NOTHING`, so xlsx backfill and live Sheets reads are idempotent and never overwrite each other.
- Live registers are read with `spreadsheets.values.get` in 50k-row chunks (never `files.export`); the dashboard sync fetches only the tabs it needs and retries 429/5xx with backoff.
- Targets: the Sheets client is read-only except for sheets registered in a writable allowlist (only the "Prayag Target Master" sheet, `lib/mgmt/targets.ts` + `routes/targets.ts`). Upserts are keyed (fy, team member), serialized via an in-process lock, and overwrite all duplicate rows. Pro-rata split: no-data members get an equal per-capita share first, remainder pro-rata by prior-FY actuals. Report target columns: monthly = override else annual/12; missing targets render blank/grey, never zero.
- Analytics rules: YoY/trends use complete months only (a month is complete when its max invoice date reaches the month's last calendar day); territory and institutional are never blended; QTY is never summed across groups; margins come only from `cost_master` (empty → `[]` + "Add a Cost Master" message; Purchase Price is a list price and must NEVER be used as cost).
- Ingestion guardrails (spec Task 8) in `lib/registers/ingest.ts`: expected per-FY row counts, zero unmapped groups/heads/states, sum consistency (±1 rupee), no negative amounts. Any failure writes `ingest_run.status='fail'` and blocks the insert.
- Sanity baselines (must reproduce exactly): FY25-26 ₹361.14 Cr; Q1 26-27 ₹73.09 Cr vs Q1 25-26 ₹74.56 Cr (YoY −2.0%); Territory +7.8%, Institutional −54.1%; top head FY25-26 Sandeep Ji ₹164.22 Cr (45.5%); Q1 invoices/customers 5,714/439.
- Trap 3 verification (salesperson coverage, FY2026-27): complete months = Apr–Jun (3 closed); secondary total (STATE HEAD DASHBOARD, closed-months-only by construction — secondary entered at month-end) / primary like-months (Apr–Jun from register = ₹73.09 Cr) ≈ 83%. The old "full year" tile divided Apr–Jun secondary by Apr–Jul primary (4 months) giving ~76–77% — that tile has been removed. `useCompleteMonths(fy)` in `src/hooks/useCompleteMonths.ts` is the canonical enforcement point; `CombinedPerformanceDashboard.tsx` uses explicit label-set intersection so primary and secondary always cover identical calendar months.

## Product

Prayag India — Sales Intelligence: a mobile-first dashboard over live Google Sheets sales data (FY24-25 product sales + FY26-27 order book + FY23-24→26-27 invoice-line registers). Shows total sales, order YTD, retailer/channel-partner counts, monthly trends, product mix, regional breakdown, order momentum, a Growth tab (complete-months YoY split territory vs institutional, customer retention, margins), an AI Analyst, and a Data Health panel that reconciles imported files vs live Sheets vs database with one-click backfill. A "Refresh data" button pulls the latest from Sheets; a header shows live status and last-synced time.

## User preferences

- No emojis anywhere (UI, code, or copy).

## Gotchas

- New API routes require restarting the `artifacts/api-server` workflow to take effect.
- Server config JSON (`artifacts/api-server/config/*.json`) must be statically imported so esbuild bundles it. Never read it with `fs.readFileSync(process.cwd(), ...)` — in production the server does not run from the artifact directory, so cwd-relative reads 500 with ENOENT.
- Never `console.log` in server code — use `req.log` in handlers, `logger` elsewhere.
- Monthly numeric cells in the order sheets are stored as strings; use the `src/lib/sheets.ts` cell helpers, which coerce them.
- If `sheets.ts` fails to typecheck with a `Buffer<ArrayBufferLike>` mismatch on `xlsx.load`, cast via `Parameters<typeof workbook.xlsx.load>[0]` (multi-version `@types/node`). Delete stale `*.tsbuildinfo` if line numbers look wrong.
- xlsx exports truncate tab titles to 31 characters; live Sheets tabs keep the full title. Match long tab names with `startsWith`, never equality.
- Never commit register/rate-list xlsx files to the repo (test fixtures excepted). Production `sale_line` can be loaded via the deployed `POST /api/verify/backfill` endpoint per FY (2024-25/2025-26/2026-27); FY23-24 exists only as the prior-FY block in the 2024-25 workbook and requires the xlsx CLI against the production `DATABASE_URL`.
- The historical live register workbooks (FY24-25, FY25-26) have no per-invoice DATE column, so Sheets-backfilled rows have null `invoice_date`. Analytics month-completeness falls back to the calendar (month fully elapsed) when a month has no dates — do not assume `invoice_date` is populated for past FYs in production.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
