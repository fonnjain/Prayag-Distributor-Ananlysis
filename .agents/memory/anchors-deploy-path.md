---
name: verify_anchors.json deploy path resolution
description: In deployed monorepo the process cwd is the REPO ROOT, not artifacts/api-server — cwd-relative config paths 500 in production.
---

# verify_anchors.json path must not be cwd-relative

**Rule:** resolve `config/verify_anchors.json` via `anchorsFilePath()` in `verifyAnchors.ts`, never `path.join(process.cwd(), "config", ...)`.

**Why:** dev runs the api-server with cwd = `artifacts/api-server`; the deployed monorepo runs `node artifacts/api-server/dist/index.mjs` from the repo root. A cwd-relative path caused ENOENT → `/api/dashboard` 500s + failed healthchecks in production (1 Aug 2026). GCS restore also `mkdir -p`s the parent so a first deploy with no config dir still restores.

**How to apply:** any new code reading or writing files under the api-server package must resolve against the package dir (or reuse `anchorsFilePath()`-style dual-candidate resolution), not cwd. Same trap applies to any other cwd-relative asset in the deployed bundle.
