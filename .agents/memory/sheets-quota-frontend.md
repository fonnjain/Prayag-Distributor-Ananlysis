---
name: Sheets quota surfaced to frontend
description: How Google Sheets quota rate-limits travel from api-server to the dashboard UI
---

Quota state travels two ways and the frontend must handle both:
- No last-good data → route returns 503 `{ error, quota: true, retryAfter }` + `Retry-After` header via `respondIfQuotaError` (lib/quotaResponse.ts); react-query retry config auto-recovers.
- Last-good snapshot exists → route returns **200** with the fallback payload flagged `{ quota: true, retryAfter }`; the client must read the flag off the successful payload and schedule its own retry (dashboard-context does this, capped at 5).

**Why:** a code review rejected the first pass because the common case (fallback snapshot available) returned a plain 200, so the banner/auto-retry never fired.

**How to apply:** any new Sheets-backed route with a graceful fallback must either 503 on quota or flag the fallback payload; any new consumer must check both the error and the payload for `quota: true`.
