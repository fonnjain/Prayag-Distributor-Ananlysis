---
name: Google Drive connector integration
description: How the Prayag app reads Google Drive via the Replit connector proxy
---

# Google Drive connector

Drive access goes through the Replit `google-drive` connector, NOT the `googleapis`
npm package. `addIntegration` yields a proxy snippet, not a googleapis client.

**Rule:** call `connectors.proxy("google-drive", path, { method })` fresh each request;
never cache the `ReplitConnectors` client (tokens expire). The proxy returns a raw
`Response` — call `.json()` yourself. Server-only; keep the SDK out of the browser bundle.

**Why:** the connector injects/refreshes the OAuth token; a cached client goes stale.

**How to apply:**
- Escape user search text before embedding in a Drive `name contains '...'` clause
  (backslash then single-quote), and pass params via URLSearchParams.
- Contract-first: endpoint lives in the OpenAPI spec; run api-spec codegen after any
  spec change to regenerate the hook + zod schemas.

**Security caveat:** the connector uses the repl owner's Drive token. Any route exposing
it has no per-user authz by default and inherits the API server's permissive CORS, so a
public deployment leaks the owner's Drive metadata to anyone with the URL. Gate such
routes behind auth before publishing if the Drive is private.
