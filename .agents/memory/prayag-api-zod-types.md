---
name: api-zod types re-export conflict
description: Why api-zod/src/index.ts no longer re-exports from ./generated/types, and how to avoid TS2308 duplicate export errors when adding new query params.
---

## Rule

`lib/api-zod/src/index.ts` MUST NOT re-export from `./generated/types`.

Only export Zod schemas: `export * from "./generated/api";`

## Why

Orval generates Zod schema constants (e.g. `export const GetSalesPersonReportsParams = zod.object({...})`) in `./generated/api.ts` AND TypeScript type declarations with the same names (e.g. `export type GetSalesPersonReportsParams = {...}`) in `./generated/types/`.

When both are re-exported from `index.ts`, TypeScript raises TS2308 ("already exported a member named X") because the internal `./generated/types/index.ts` barrel uses `export *` (not `export type *`) so TypeScript cannot disambiguate.

`export type * from './generated/types'` does NOT fix this because the barrel itself uses `export *` internally, making TypeScript treat the re-exports as ambiguous values.

## How to apply

- Server-side: import Zod schemas from `@workspace/api-zod` — only value schemas (zod.object) are needed for validation.
- Frontend: import TypeScript types and hooks from `@workspace/api-client-react` — this package has its own generated types.
- If a new endpoint gains enum query params (e.g. `basis: { enum: [secondary, primary] }`), Orval will generate a new Params Zod schema that will conflict with the types barrel. The fix is already in place by not re-exporting types.
- Never add `export * from './generated/types'` back to `lib/api-zod/src/index.ts`.
