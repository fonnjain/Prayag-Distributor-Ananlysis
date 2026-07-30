---
name: sale_line table rename
description: sale_line is now a current-only VIEW; the raw table is sale_line_all. Migration runner wires this into every server start.
---

## What changed

| Name | Kind | Meaning |
|---|---|---|
| `sale_line_all` | TABLE | Raw physical store — all rows including `version_status='superseded'` |
| `sale_line` | VIEW | Current-only (`WHERE version_status='current'`) — safe default |
| `sale_line_current` | VIEW | Same as `sale_line`; kept for backward compat with existing analytics |

## How it is enforced

`lib/db/src/runMigrations.ts` — migration `001_sale_line_rename` runs on every server start before `app.listen`. Uses a `DO $$ ... IF relkind='r' $$` guard so it is idempotent whether or not the rename was already applied.

`schema_migrations` table tracks applied migrations (created by the runner if absent).

## Drizzle schema

`lib/db/src/schema/salesRegister.ts` — `saleLines = pgTable("sale_line_all", ...)`. All Drizzle ORM queries target `sale_line_all`. All callers continue using the `saleLines` exported symbol unchanged.

## Code files updated

8 source files that had raw SQL strings with bare `sale_line` were updated to `sale_line_all` via sed:
- `routes/registers.ts` (30 occurrences — all UPDATE/FROM paths)
- `lib/sku/catalogue.ts` (13)
- `lib/customers/analytics.ts`, `registerSync.ts`, `dashboard/sync.ts`, `routes/orders.ts`, `lib/schemes/nudge.ts`, `lib/registers/reconcileVersions.ts`

Files using `sale_line_current` or Drizzle `saleLines` symbol were NOT touched.

## Laspeyres multiplier

Before and after: company = 1.0699077635901517. All per-category multipliers identical. No restatement required.

**Why:** The rename only changes which table name SQL targets. All analytics were already guarded — either via `sale_line_current` view, explicit `WHERE version_status='current'`, or Drizzle ORM guard. Row counts unchanged.

## DB trigger

`sale_line_delete_guard` trigger followed the rename automatically (Postgres binds triggers to OID, not name). Now attached to `sale_line_all`.

## Fresh DB behaviour

`drizzle-kit push` creates `sale_line_all` (the raw table). Migration runner then creates the two views. No manual psql needed.
