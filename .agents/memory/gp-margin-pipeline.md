---
name: GP Margin pipeline
description: margin_fact table, Drive-based loader, async load route, and known quirks for the GP margin feature.
---

# GP Margin Pipeline

## Data structure
- Files live as **native Google Sheets** on Google Drive (mimeType `application/vnd.google-apps.spreadsheet`), NOT as uploaded xlsx files.
- Must be read via Sheets API (tabular row reads) — Drive export hangs for some segments.
- Folder structure is **FLAT** at the Drive root level: "PTMT GP MARGIN 26-27", "CP GP MARGIN 25-26", etc. — NOT nested under a single parent.
- `listDriveFiles({ q: "GP MARGIN" })` (the existing working function) is the correct discovery entry point.
- `listDriveFolder` requires `spaces=drive` parameter or it returns 0 items.

## Column detection rules
- GP margin tabs detected by scanning rows 2–6 for: col B contains "CODE" AND row contains "DISCOUNT" AND ("BOM COST" or "PUR RATE").
- Header is on **row 4** for PTMT/Sink (not row 3 — the spec was approximate for FY25-26 typical case).
- Columns mapped from header text; never hardcoded positions.

## Key field semantics
- `discount_frac` is a **FRACTION** (0.53 = 53% discount, realised sale is 47% of MRP). Stored as-is; never treat as percentage.
- `bom_cost` is factory BOM / purchase cost per unit. No freight, overhead, or SG&A.
- Gross contribution = (avg_sale − bom_cost) / avg_sale. Always label as "gross contribution", never "profit".

## Async load
- The load (177+ files) takes ~45–60 minutes. Route returns **202** immediately.
- `POST /api/admin/margin/load` → 202, starts background job.
- `GET /api/admin/margin/load-status` (X-Admin-Secret header) → polls job state.
- `GET /api/margin/stats` → rows visible only AFTER the full load completes (single-transaction commit).
- Only one load at a time; 409 if another is running.

## PTMT Jan/Feb/Mar-26 conflict
Three PTMT months exist as **two physically separate files with differing `bom_cost` values** (same item codes, same qty, same avg_sale, different costs). The loader's CONFLICT path fires and loads NONE for those months. This is expected and correct — the source data is genuinely ambiguous. These three months are absent from `margin_fact` in both dev and production. Do not try to force-load one file over the other without reconciling the source cost data first.

## Classification counts (FY2025-26 + FY2026-27)
- 177 monthly files, 51 cumulative, 2 summary, 0 unknown.
- Cumulative files are cross-validated only (not inserted). Monthly files are truth.

## DB: margin_fact (migration 024)
- Columns: fy, month_label, segment, item_code, tab_name, qty, weight, mrp, discount_frac, avg_sale, bom_cost, sale_value, bom_value, source_file, loaded_at.
- Indexes on (fy, month_label, item_code) and (fy, segment).
- Full replace on each load (DELETE all → INSERT).

## The hanging-fetch problem and solution

### Root cause
For certain segments (CP, Hardware, Sink, Sanitaryware), the Sheets API's undici socket hangs indefinitely — no data, no EOF, no error. This is not a quota error (no 429), it is a silent socket hang. The socket remains open but delivers nothing.

### Why JS timers cannot fix this
- `Promise.race + setTimeout` in the main thread: the timer phase saturates under concurrent I/O load and the timeout never fires for the stuck file.
- `worker_threads` with worker-internal `setTimeout`: works for the FIRST stuck file in a batch (the timer fires), but subsequent batches' workers have the same hang and their timers also stop firing. Root cause is unclear but reproducible.
- Both approaches confirmed broken across multiple server restarts and builds.

### Definitive fix: OS `timeout` command + `child_process.execFile`
The loader now spawns each file fetch as a **separate child Node.js process** under the Unix `timeout` command:
```
timeout 90 node --enable-source-maps gpMarginFetcher.mjs <fileId>
```
When the OS `timeout` alarm fires after 90 s, it sends SIGTERM to the child. The child's stdout/stderr pipes close. The parent's `execFile` callback fires via an **I/O event** (pipe-close), which the parent processes reliably even when its timer phase is saturated. HTTP requests keep working throughout.

### Architecture
- `gpMarginFetcher.ts` — standalone script, compiled as its own esbuild entry point to `dist/gpMarginFetcher.mjs`. Reads fileId from argv, fetches all tabs via sheetsApi, writes JSON to stdout, exits.
- `loader.ts` → `fetchWorkbookViaProcess(fileId, timeoutSec=90)` — calls `execFile(TIMEOUT_CMD, [timeoutSec, NODE_EXEC, FETCHER_PATH, fileId])`. 
- TIMEOUT_CMD is the full nix store path to `timeout` (stable within a nix store version).
- Files processed in batches of 5 (`Promise.allSettled`) with `fetchWorkbookViaProcess`.

### Observed behaviour
- Files that hang get killed at 90 s. The execFile error arrives in the parent via I/O callback. "fetch failed — skipping" is logged.
- Files that load quickly (< 30 s) complete normally.
- Some segments (Plumbing) have no GP margin tabs at all — "no GP margin tabs — skipping".
- Pino's async transport buffer fills under heavy concurrent load; log file may appear frozen while the load progresses (watch `ps aux | grep gpMarginFetcher` to track active processes).
- Stats (`GET /api/margin/stats`) show 0 rows until the entire load completes (single-transaction commit).

**Why:** OS-level kill is the only mechanism guaranteed to work regardless of the child process's internal JS event loop state. I/O-based pipe-close callbacks in the parent fire reliably even when the parent's timer phase is busy.

**How to apply:** any future "bulk fetch with per-file timeout" pattern should use `execFile + OS timeout`, not `Promise.race + setTimeout` or `worker_threads + setTimeout`.
