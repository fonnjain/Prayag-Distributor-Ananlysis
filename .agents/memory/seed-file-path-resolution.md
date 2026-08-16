---
name: Seed file path resolution in api-server routes
description: How to reliably locate attached_assets/ from any route file in the api-server, regardless of cwd or tsx import.meta.url depth quirks.
---

# Seed file path resolution

## Rule
Never derive the seed XLSX path from `import.meta.url` depth-counting or `process.cwd()` alone inside api-server route files — both fail in different environments:
- `process.cwd()` in dev = `artifacts/api-server/` (not repo root)
- `import.meta.url` depth from `src/routes/` resolves one level deeper than expected under some tsx versions

**Why:** Burned twice: first attempt (`import.meta.url` 4 levels up from `src/routes/`) gave `/home/runner/attached_assets/`; second attempt (`process.cwd()`) gave `/home/runner/workspace/artifacts/api-server/attached_assets/`.

## How to apply
Use the `locateSeedFile()` helper in `masterOrg.ts` (probes 4 candidates including an absolute fallback) — or export a path constant from a `src/` level module (not `src/routes/`) and import it, since `import.meta.url` at `src/` depth resolves correctly.

The absolute fallback `/home/runner/workspace/attached_assets/...` is intentional and safe for this workspace layout.
