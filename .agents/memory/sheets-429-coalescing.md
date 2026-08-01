---
name: Sheets 429 coalescing + negative cache
description: How cold-start Sheets quota stampedes are prevented at the sheetsApi layer
---

Cold-start stampedes (many loaders scanning the same workbook) are handled **inside `sheetsApi.ts`**, not per-loader:

- Every `values.get`/metadata GET is coalesced by exact request path: in-flight dedupe + a 60s snapshot cache (`SNAPSHOT_TTL_MS`). Independent loaders (orderBookSale, stateHeadSale, primarySheets aggregate + tab inventory) issue identical chunk ranges, so they share one physical read.
- A final 429 (after in-request backoff) sets a per-spreadsheet negative cache (`QUOTA_BLOCK_MS` = 60s); further reads of that spreadsheet throw `SheetsQuotaError` immediately instead of burning quota. CSV export path participates too.

**Why:** production cold-starts fired parallel multi-tab reads → per-minute quota 429s → blank Sale/Pending tiles; per-loader single-flight alone didn't cover cross-loader overlap.

**How to apply:** new Sheets loaders get coalescing for free by going through `sheetsGet`/`readTabRowsChunked`; do NOT add another raw fetch path. The 60s snapshot is a coalescing window, not a data cache — loaders keep their own 30-min TTL aggregate caches. Callers should treat `SheetsQuotaError` as transient (retry after ≤60s).
