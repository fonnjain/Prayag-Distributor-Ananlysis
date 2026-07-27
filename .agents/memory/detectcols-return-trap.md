---
name: detectCols return-then-mutate trap
description: esbuild strips types without type-checking; code after `return {...}` in a function is silently dead — mutations to a variable that doesn't exist never error at build time.
---

## Rule
Never place mutations after `return { ... }` in a function and expect them to run. In `deepDiveData.ts → detectCols()`, the pattern:

```typescript
return {
  fieldA: -1,      // placeholder
  ...
};
colMap.fieldA = computedValue;  // DEAD CODE — never runs
return colMap;                  // DEAD CODE
```

compiles and builds without error (esbuild does not type-check), but `fieldA` is always -1.

## Fix
Assign the object literal to a variable first, then mutate, then return:

```typescript
const colMap: ColMap = {
  fieldA: -1,   // placeholder while find() is still in scope
  ...
};
const detected = find("HEADER1", "HEADER2");
colMap.fieldA = detected;
colMap.fieldB = detected >= 0 ? detected + 3 : -1;
return colMap;
```

## Why
- `pnpm tsc --noEmit` is only run on the frontend (`artifacts/prayag`), not on `artifacts/api-server`.
- The api-server build script (`build.mjs`) uses esbuild, which transpiles without type-checking.
- TypeScript errors in `artifacts/api-server/src/` are invisible unless you explicitly run `tsc --noEmit` there.

## How to apply
- Any time you add post-return mutations in `detectCols` or any other esbuild-built file, convert `return {...}` → `const x = {...}` + mutations + `return x`.
- After api-server edits, run `cd artifacts/api-server && npx tsc --noEmit` before building, or grep for unreachable mutation patterns.
