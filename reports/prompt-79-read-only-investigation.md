# Prompt 79 — Read-Only Investigation Report

**Date:** 13 September 2026  
**Scope:** Unstable audit counts, PSCode3 brand mirror, and absent August 2026 SKU data  
**Change status:** No files, database rows, freezes, source data, caches, or application configuration were changed.

## Executive findings

1. **The unstable audit count is real.** The endpoint can serve an older persisted snapshot while refreshing in the background. Several audit groups also return an empty check list when dependencies fail, allowing checks to disappear.
2. **The exact 49th check cannot now be identified.** The first 49-check response body was not retained; the production snapshot table now contains only the replacement 48-check payload.
3. **Audit check 7.6 is structurally unsuitable for historical FYs.** The PSCode3 brand mirror exists only for July 2026. It has never been populated for FY2023-24, FY2024-25, or FY2025-26.
4. **August 2026 SKU data is not loaded in production.** It has zero rows and value, while its monthly state retains a nonzero last-good baseline but no freeze anchor.
5. **The August absence does not affect every SKU surface.** Retailer-level SKU Deep Dive and Red Alert B3 depend on the secondary SKU table. Breadth trajectory and the distributor Push list use the primary sale-line table.
6. **No alert treated August’s empty SKU month as zero business.** August is excluded as unavailable. Only one alert was newly raised after 7 September, covering April–May.

# Section A — Why the audit count varies

## A1. Dependencies and failure behavior

| Audit group | Normal checks | Inputs | Failure behavior |
|---|---:|---|---|
| targets_achievement | Dynamic; normally up to 13 | Target maps, roster, order files, anchors | Missing files may yield pending/skip; outer errors return zero checks |
| sale_order_booking | Fixed 6 | Secondary OB, state-head sale, primary OB, anchors | Retains checks as pending, skip, or warning |
| secondary | Dynamic | Secondary anchors, order file, roster | Missing anchors or outer errors return zero checks |
| primary | Dynamic | sale_line/current and primary anchors | Zero rows may warn; DB exceptions return zero checks |
| name_match | Dynamic; normally 2–3 | Target maps, roster, target anchors | Missing data or outer errors return zero checks |
| source_health | Configured; currently 8 | Google Sheets probes | Retains checks as pending, skip, warning, or failure |
| truncation | Fixed 2 | Secondary order files and anchors | Missing or unreadable files become skip |
| report_logic | Configured; currently 8 | sale_line and report anchors | Query errors skip; invalid FY can return zero checks |
| crossfoot | Dynamic | Order Sheet, primary mirror, SKU/mirror tables, secondary OB | Partial checks may remain; outer errors can return zero checks |
| pending_crosscheck | Fixed 3 | Pending Sheet and derived OB/sale | Usually warning/skip; outer errors can return zero checks |
| sap_lag | Fixed 1 | SAP source and sale_line_current | Missing configuration or outer errors return zero checks |
| frozen-anchors | Two per frozen FY | sale_line_all and frozen anchors | Retains an explicit failure if its query throws |
| secondary_pipeline | Fixed 1 | Latest secondary ingestion | No data warns; query exceptions return zero checks |
| sku_canary | Dynamic by completed/frozen month | SKU rows, monthly state, canary baselines | Inapplicable months skip; outer errors return zero checks |
| productwise_freshness | Fixed 1 | Product-Wise provenance and lock state | Normally pass/pending/warn; lookup errors return zero checks |

**Source:** Application code in audit.ts, verifyFull.ts, extraGroups.ts, and payloadSnapshot.ts.

A check that cannot evaluate may become pending, skip, warning, failure, or be omitted entirely. The suspected silent-omission behavior is therefore present.

## A2. Did checks change, or only results?

| Production response | Pass | Pending | Fail | Skip | Warning | Total |
|---|---:|---:|---:|---:|---:|---:|
| Initial | 43 | 2 | 1 | 2 | 1 | 49 |
| Settled | 40 | 2 | 2 | 2 | 2 | 48 |

**Source:** Production GET /api/audit responses captured after publishing.

The total falling from 49 to 48 proves that at least one check disappeared. The status changes also prove that outcomes changed. Check keys are deterministic, so this was not a rename.

The exact missing key cannot be recovered because the initial body was not retained, the persisted row has been overwritten, and the application stores no response-level key manifest.

Current production snapshot:

| Key | Saved at | Groups | Checks |
|---|---|---:|---:|
| audit\|2025-26 | 13 Sep 2026, 07:33:52 UTC | 15 | 48 |

**Source:** Production route_payload_snapshot.

## A3. Why two answers appeared

GET /api/audit uses a 15-minute snapshot TTL. When a snapshot exists, the endpoint returns it immediately with refreshing metadata, starts a live rebuild in the background, and later replaces the snapshot. This explains the older 49-check response followed by the 48-check response.

Existing state includes saved_at, computedAt, snapshotSavedAt, refreshing, process-local cache state, source timestamps, anchors, and freeze records. Missing state includes an expected-key manifest, source-generation fingerprint, dependency-settled marker, and explicit declaration that every expected check was evaluated.

## A4. Recommended stable response contract

A provisional build should not be presented as final. It should return HTTP 503 or 409 with:

- status: refreshing or dependencies_not_settled
- fiscal year and retry interval
- source generation identifier
- expected and evaluated check counts
- complete missing-check list with reasons
- provisional: true

A final HTTP 200 should include all expected keys, refreshing: false, and provisional: false.

Consumers requiring updates:

1. **Data Health page:** display a refreshing state, keep old data visibly stale, and retry.
2. **Post-publish verification:** retry provisional responses and require two consecutive matching final manifests.
3. **Audit workbook:** refuse generation from provisional or incomplete input.

## A5. Audit-read count

The verification identity was created at **13 Sep 2026, 07:26:49 UTC** and was last used, when queried, at **07:35:01 UTC**.

**Source:** Production api_keys.

The exact number of audit reads is not recoverable: last_used_at records only the latest use across all approved endpoints; auth_audit does not record GET reads; snapshots record writes, not reads; and complete request telemetry is absent.

At least **five** production audit reads are directly known from this verification work. The first and a later comparison disagreed; the final three were identical.

# Section B — PSCode3 brand mirror

## B1. Objects and production coverage

The mirror is not a separate table:

- Item-level source: public.secondary_sku_line
- Brand mirror: public.secondary_register_line
- Discriminator: source='pscode3_brand_rollup'

| FY | SKU rows | SKU NET | Mirror rows | Mirror NET |
|---|---:|---:|---:|---:|
| 2023-24 | 261,566 | ₹1,678,757,743.34 | 0 | ₹0 |
| 2024-25 | 335,255 | ₹2,160,002,656.00 | 0 | ₹0 |
| 2025-26 | 379,439 | ₹2,310,913,869.00 | 0 | ₹0 |
| 2026-27 | 123,326 | ₹813,640,008.00 | 34,147 | ₹223,436,806.00 |

**Source:** Production secondary_sku_line and secondary_register_line.

FY2026-27 monthly coverage:

| Month | SKU rows | SKU NET | Mirror rows | Mirror NET |
|---|---:|---:|---:|---:|
| Apr-26 | 21,613 | ₹131,087,397 | 0 | ₹0 |
| May-26 | 31,266 | ₹210,078,126 | 0 | ₹0 |
| Jun-26 | 36,300 | ₹249,037,679 | 0 | ₹0 |
| Jul-26 | 34,147 | ₹223,436,806 | 34,147 | ₹223,436,806 |

**Source:** Production database. July 2026 is the only populated and matching mirror month.

## B2. Writers and readers

Direct writers identified in code are the protected July PSCode3 loader, one-off PSCode3 load scripts, and the brand-backfill repair script. The protected loader uses a transaction, advisory lock, wipe guard, and provenance record.

The containing secondary-register table is read by SKU spread, distributor analysis, AI Growth, win-back, comparison, Red Alerts, Market Survey, and MRP analytics. These readers do not use the absent FY2025-26 mirror as their only data source.

## B3. Meaning of audit check 7.6

For FY2025-26, check 7.6 compares a populated historical SKU table against mirror rows that were never generated. It therefore does not prove a recent deletion and does not directly explain a user-facing zero. It is a permanently failing historical comparison.

The check should apply only to months loaded through the dual-write PSCode3 process, currently July 2026, or first verify that a mirror generation is expected for the selected FY/month.

## B4. Safe historical correction path

No rebuild was performed. A safe frozen-FY correction would require source/hash approval, dry-run staging, monthly cross-footing, explicit frozen-data approval, narrow target guards, advisory locking, wipe protection, an atomic mirror-only replacement, post-write reconciliation, and provenance. The July loader should not simply be redirected to FY2025-26.

# Section C — August 2026 SKU absence

## C1. Production state

### secondary_sku_line — FY2026-27 / Aug-26

| Measure | Value |
|---|---:|
| Rows | 0 |
| Quantity | 0 |
| NET amount | ₹0 |
| Gross amount | ₹0 |
| Row frozen_at | null |
| Latest ingestion | null |
| Source/source file | none |

**Source:** Production secondary_sku_line.

### register_month_state — FY2026-27 / Aug-26

| Field | Value |
|---|---:|
| last_good_rows | 12,870 |
| last_good_amount | ₹304,193,273.69 |
| last_replaced_at | 13 Sep 2026, 07:27:12 UTC |
| frozen_at | null |
| frozen_rows | null |
| frozen_amount | null |

**Source:** Production register_month_state.

August is calendar-frozen but unanchored. It has a nonzero baseline but zero current SKU rows; it is not anchored at zero.

Older closed FY months also lack row/month freeze timestamps, but they are populated and governed by closed-FY freeze policy. The live dangerous state is specifically August 2026.

## C2. User-facing surfaces

| Surface | Actual source | Current effect of missing August secondary SKU rows |
|---|---|---|
| Retailer-level SKU Deep Dive | secondary_sku_line | August is unavailable/absent, not a fabricated numeric zero |
| Breadth trajectory | sale_line_current | Unaffected by missing secondary SKU rows |
| Distributor Push list | sale_line_current | Unaffected by missing secondary SKU rows |
| Red Alert B3 | secondary_sku_line plus register_month_state | August is excluded/unavailable, not evaluated as zero |

**Source:** Application route and query implementations.

## C3. Alerts raised since 7 September

Exactly one alert was newly raised after 7 September:

| ID | Code | Entity | Period | Status | First seen | Last seen | Rupees at stake | Values |
|---:|---|---|---|---|---|---|---:|---|
| 153 | B3 | RET#16632 | Apr-26..May-26 | Open | 8 Sep 2026, 11:52 UTC | 13 Sep 2026, 07:37 UTC | ₹3,096,266 | Current ₹0; prior ₹3,096,266 |

**Source:** Production alert, filtered by first_seen_at from 7 September 2026.

No alert was raised for August’s empty SKU month. Four older B3 records were observed and cleared on 8 September, but they were first raised on 16 August and are not alerts raised since 7 September.

## C4. Required status distinction

Audit 12.1 should distinguish:

1. **Not loaded:** zero rows, no source/provenance, and no anchor.
2. **Loaded but short:** rows and provenance exist, but counts fall below the prior-like-month floor.
3. **Frozen empty:** the month is explicitly frozen with zero frozen rows.

Production August is **not loaded/unanchored**, not loaded-but-short. The current ratio-failure result conflates different causes.

# Final priority

1. Stabilize the audit response and represent missing checks explicitly.
2. Resolve the live August 2026 unanchored zero-row state.
3. Restrict or retire historical check 7.6 until historical mirror generations actually exist.

The mirror issue is a structurally invalid historical comparison. The August condition is the live data gap. The unstable audit contract affects confidence in both.
