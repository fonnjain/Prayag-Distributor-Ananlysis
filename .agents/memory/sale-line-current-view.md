---
name: sale_line_current view
description: The sale_line_current PostgreSQL view must be created manually — it is not managed by Drizzle schema push
---

## Problem
`sale_line_current` is used throughout the codebase (analytics.ts, laspeyres.ts, schemes.ts, audit extraGroups, SKU facts) but is NOT declared in any Drizzle schema file. Drizzle `push` does not create it.

If it is missing, all these queries fail silently (the `db.execute` call throws, callers catch it and return null/0, giving wrong results with no obvious error).

## Fix
Run once on any new DB instance:
```sql
CREATE OR REPLACE VIEW sale_line_current AS
  SELECT * FROM sale_line WHERE version_status = 'current';
```

Or via psql: `psql $DATABASE_URL -c "CREATE OR REPLACE VIEW sale_line_current AS SELECT * FROM sale_line WHERE version_status = 'current';"`

**Why:** Drizzle-kit push does not support view definitions; the view was presumably created on the original DB manually and not tracked in any migration.

## Detection
Check: `SELECT column_name FROM information_schema.columns WHERE table_name = 'sale_line_current';` — returns 0 rows if missing.
