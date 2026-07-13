---
name: Drizzle GROUP BY bare-column trap
description: PostgreSQL rejects bare column references in SELECT expressions when the GROUP BY uses a wrapped form (e.g. coalesce); fix is max(col) or repeating the exact expression.
---

## Rule

When a Drizzle `db.select` groups by a wrapped expression like `coalesce(${saleLines.groupRaw}, '')`,
you cannot reference the raw column `${saleLines.groupRaw}` in another SELECT expression (e.g. a
CASE statement). PostgreSQL error: `column "table.col" must appear in the GROUP BY clause or be
used in an aggregate function`.

**Why:** PostgreSQL does not recognise `group_raw` as equivalent to `coalesce(group_raw, '')` for
the purposes of the GROUP BY functional-dependency check, even if they evaluate identically for
non-null values.

**How to apply:** Two safe fixes:
1. Use `max(${saleLines.groupRaw})` in the CASE/expression — valid because all rows in the group
   share the same value when the column is also a GROUP BY key.
2. Repeat the exact GROUP BY expression: `coalesce(${saleLines.groupRaw}, '')`.

Example (companyReports.ts `queryQty`):
```ts
// WRONG — Postgres error
unit: sql<string>`case when ${saleLines.groupRaw} = 'WATER TANK' then 'Ltr' …`

// RIGHT — aggregate wrapper
unit: sql<string>`case when max(${saleLines.groupRaw}) = 'WATER TANK' then 'Ltr' …`
```
