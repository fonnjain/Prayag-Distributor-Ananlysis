---
name: Customer Master schema and routes
description: DB tables, API route patterns, and typecheck quirks for the customer_master feature.
---

## Tables (lib/db/src/schema/customerMaster.ts)
- `customer_master` — text PK `id` (customer code), typed enum (`Distributor/Direct Dealer/Retailer`), status enum (`Active/Inactive/Unknown`), head_confidence enum (`Confirmed/Guessed`), plus address/geo/stateHead/editedBy/updatedAt fields.
- `customer_master_log` — serial PK, fk to customer_master.id, tracks field/oldValue/newValue/changedAt/changedBy/reason/importBatch.
- `customer_mismatch_queue` — serial PK, tracks sale_line customers whose stateHead differs from customer_master, resolution enum (`pending/approved/dismissed`).

## Route (artifacts/api-server/src/routes/customerMaster.ts)
- Registered at `/api` prefix via routes/index.ts; specific paths (/export, /import/preview, /import/commit, /mismatch/…) MUST appear before `/:id` route.
- `patch` objects typed as `Record<string, any>` (not intersected with specific field types) to avoid TS2322 when iterating UPDATABLE_FIELDS over a drizzle row.
- Buffer cast for exceljs: `req.body as unknown as Parameters<typeof wb.xlsx.load>[0]` (double-cast through unknown).
- `req.params.id` typed as `string | string[]` in this Express version — always do `const id = String(req.params.id)` at the top of `:id` handlers before passing to `eq()`.

## Frontend (artifacts/prayag/src/components/customers/CustomerMasterPage.tsx)
- `listParams` cast as `any` to avoid enum-vs-string mismatch for `status`/`confidence` filter params.
- `useListCustomerMaster` second arg `query` option cast as `any` — TanStack v5 `UseQueryOptions` requires `queryKey` but orval generates it as a required field; `as any` avoids the error without affecting runtime.
- Generated query key function is `getGetCustomerMismatchCountQueryKey` (double "Get") — use that exact name.

**Why:** Drizzle inferred row types use `Date & string` for timestamp-with-timezone columns when there's a type intersection; keeping patch as `Record<string, any>` avoids structural incompatibility. Express 5 `req.params` types include `string[]` in the union, requiring explicit `String()` coercion for drizzle `eq()` calls.
