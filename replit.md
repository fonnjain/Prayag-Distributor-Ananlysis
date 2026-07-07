# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

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
  - `src/components/dashboard/*` — Overview, Regional, Resources, Products, OrderMomentum, DataSources, Analyst
  - `src/data/dashboard-context.tsx` — `DashboardProvider` / `useDashboard()`; fetches live data via generated hooks, falls back to bundled seed
  - `src/data/dataset.ts` — formatters/colors; `src/data/prayag_data.json` — bundled seed + canonical payload shape (drives TS types)
- API: `artifacts/api-server` (Express, proxied at `/api`)
  - `src/lib/sheets.ts` — Google Drive connector XLSX export + exceljs cell helpers
  - `src/lib/dashboard/{transform,seed,sync}.ts` — Sheets→aggregate transform, seed loader, snapshot sync/persistence
  - `src/routes/dashboard.ts` — `GET /dashboard`, `POST /dashboard/refresh`; `src/routes/analyze.ts` — AI Analyst (reads latest snapshot)
  - `data/prayag_data.json` — seed source for the baseline snapshot
- DB schema (source of truth): `lib/db/src/schema/dashboardSnapshot.ts` (table `dashboard_snapshots`)
- API contract (source of truth): `lib/api-spec/openapi.yaml` — regenerate hooks/schemas with `pnpm --filter @workspace/api-spec run codegen`

## Architecture decisions

- Dashboard data is stored as immutable snapshots (jsonb `data` + `manifest`) in `dashboard_snapshots`; each sync appends a row and the latest is served. This gives free history and a graceful fallback.
- `GET /dashboard` always returns data via `ensureSeeded()` (seeds bundled baseline if empty). `POST /dashboard/refresh` runs a live sync and, on failure, returns the last good snapshot plus a `refreshError` string — the UI never goes blank.
- On startup the server seeds synchronously then kicks off a background live sync, so first paint is instant (seed) and upgrades to live shortly after.
- FY24-25 totals come from the item-wise SALE tab (only PRODUCT_GROUP-mapped codes → exact 3,417,311,917). Orders come from the per-month MONTHLY tabs, not the formula-driven Combined tab (which is not cached in the export).
- Monthly order tabs have no retail/resource flag, so Regional aggregates over all order customers; distributors/dealers/coverage remain seed-sourced. See `.agents/memory/prayag-sheets-transform.md`.

## Product

Prayag India — Sales Intelligence: a mobile-first dashboard over live Google Sheets sales data (FY24-25 product sales + FY26-27 order book). Shows total sales, order YTD, retailer/channel-partner counts, monthly trends, product mix, regional breakdown, order momentum, and an AI Analyst that answers questions against the current snapshot. A "Refresh data" button pulls the latest from Sheets; a header shows live status and last-synced time.

## User preferences

- No emojis anywhere (UI, code, or copy).

## Gotchas

- New API routes require restarting the `artifacts/api-server` workflow to take effect.
- Never `console.log` in server code — use `req.log` in handlers, `logger` elsewhere.
- Monthly numeric cells in the order sheets are stored as strings; use the `src/lib/sheets.ts` cell helpers, which coerce them.
- If `sheets.ts` fails to typecheck with a `Buffer<ArrayBufferLike>` mismatch on `xlsx.load`, cast via `Parameters<typeof workbook.xlsx.load>[0]` (multi-version `@types/node`). Delete stale `*.tsbuildinfo` if line numbers look wrong.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
