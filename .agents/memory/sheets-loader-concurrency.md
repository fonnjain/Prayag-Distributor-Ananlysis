---
name: Sheets loader concurrency rules
description: Conventions for in-process caches over Google Sheets reads and per-request report state
---

Two rules for anything that reads Google Sheets on demand (report generators, sync loaders):

1. TTL caches over expensive Sheets reads must also dedupe in-flight promises. Concurrent uncached requests otherwise each run the full multi-call chunked read, multiplying latency and 429 quota risk (a single cold read already takes ~70s for a full order workbook).
**How to apply:** keep a `Map<key, Promise<T>>` beside the result cache; return the pending promise when present; clear it in `.finally()`.

2. Workbook/report builders must never accumulate per-request state (e.g. missing-data trackers) in module-level mutables. Parallel report requests interleave and contaminate each other's output.
**How to apply:** create the tracker inside the build function and pass it to helpers.

**Why:** architect review caught both in the Management Reports feature; fixed and verified with parallel curl requests producing isolated Missing Data tabs.

**Aug 2026 production incident:** autoscale cold start (fresh instance after republish) stampeded Sheets — startup sync + dashboard sync + several /mgmt/data requests each ran full multi-tab reads, exhausting the per-minute quota (429) despite sheetsGet's 4-attempt backoff. Dashboard tiles (Sale/Pending) rendered blank/negative because failures aren't cached, but new instances re-stampede. Single-flight added to stateHeadSale, orderBookSale, loadPrimarySheetData, readBookingAggregated, readOrderTabInventory. Remaining gap: independent loaders still scan the same workbook concurrently (no cross-loader coalescing), and 429 failures have no short negative cache.
