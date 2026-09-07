# Prompt 60 Revised — Investigation Report

**Report date:** 7 September 2026  
**Scope:** Freeze-date safety check, FY2026–27 source comparison, and weekly re-sync assessment  
**Operating rule:** Every figure identifies its database or source.

## Executive Summary

The requested global freeze-date change was **not applied**. On 7 September 2026, August was already frozen under the existing rule. Moving its freeze date to 15 September would reopen it and expose it to rewriting, triggering the prompt’s mandatory stop condition.

The fresh source comparison found that production is ahead of the FY2026–27 Google Sheet by **72 rows and ₹11,41,895.94**. June and July retain the same 56-row difference found on 2 September; August now has an additional 16-row difference. September contains 122 matching rows.

The recommended future design is the middle option: automatically refresh the current and immediately prior month, while handling older corrections through an explicit, logged frozen-drift approval process.

# Section A — Freeze-Date Code Change

## Result

**Stopped before applying. No code was changed, published, or pushed.**

At the current date, 7 September 2026, the existing implementation considers August frozen from:

- **UTC:** 7 September 2026, 00:00
- **IST:** 7 September 2026, 05:30

Changing the clock globally to the 15th would make August writable again until:

- **UTC:** 14 September 2026, 18:30
- **IST:** 15 September 2026, 00:00

Therefore, the answer to the mandatory safety question is:

> **Does any currently frozen month become unfrozen? Yes — Aug-26.**

Apr-26 through Jul-26 remain frozen under both rules, but Aug-26 would reopen. The requested change was therefore stopped before application.

## A1. Callers Found

Production callers of monthFreezeAt or isMonthFrozen occur in:

- monthly register replacement: open-month scope, write refusal, replacement, and freeze anchoring;
- register routes: write guards, status payloads, frozen filtering, and diagnostics;
- management routes: freeze metadata;
- Product-Wise processing: closure and status timestamps;
- Red Alert context: period closure metadata.

Tests call these functions in the open-month-label and Product-Wise test suites. A separate analytics month-completeness helper claims to match the existing freeze clock, but Prompt 60 explicitly excludes that helper from this change.

## A2. Frozen State on 7 September 2026

| Month | Existing rule | Proposed 15th rule |
|---|---|---|
| Apr-26 | Frozen | Frozen |
| May-26 | Frozen | Frozen |
| Jun-26 | Frozen | Frozen |
| Jul-26 | Frozen | Frozen |
| Aug-26 | Frozen | Open until 15 Sep 00:00 IST |
| Sep-26 | Open | Open |

## A3. Safe Implementation Choices

A safe implementation now requires one of the following:

1. Preserve August’s already-established frozen state and apply the new clock only from Sep-26 onward.
2. Make persisted frozen or anchored state override the calculated clock, ensuring that a month can never reopen after freezing.
3. Leave August frozen and use the existing controlled frozen-drift refresh mechanism if its difference is explicitly approved.

A simple global monthFreezeAt change is no longer safe.

## A4. Other Existing 7th/8th Assumptions

The old rule is stated or assumed in:

- monthly replacement design and open-window comments;
- register route freeze-guard comments;
- management freeze metadata comments;
- register synchronization scope comments;
- startup anchor assertion comments;
- open-month boundary tests;
- dashboard synchronization test comments;
- Data Health user-facing text;
- the separate analytics month-completeness helper.

No Secondary Data Storage document was found in the repository.

# Section B — Fresh FY2026–27 Source Comparison

## Sources

- **Fresh source:** FY2026–27 Google Sheets SALE register, spreadsheet ID 19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps, Apr–Sep tabs.
- **Database:** production sale_line, exposing current-version rows from sale_line_all.
- Differences below are calculated as **production database minus fresh source**.

## B1–B2. Monthly Comparison

| Month | Source rows | Source value | Production rows | Production value | Row difference | Value difference |
|---|---:|---:|---:|---:|---:|---:|
| Apr-26 | 5,542 | ₹13,10,81,249.77 | 5,542 | ₹13,10,81,249.77 | 0 | ₹0.00 |
| May-26 | 11,812 | ₹28,27,83,021.58 | 11,812 | ₹28,27,83,021.58 | 0 | ₹0.00 |
| Jun-26 | 12,848 | ₹31,37,95,962.53 | 12,868 | ₹31,42,78,773.47 | +20 | +₹4,82,810.94 |
| Jul-26 | 13,767 | ₹32,04,67,052.63 | 13,803 | ₹32,10,28,904.63 | +36 | +₹5,61,852.00 |
| Aug-26 | 12,871 | ₹30,42,00,894.69 | 12,887 | ₹30,42,98,127.69 | +16 | +₹97,233.00 |
| Sep-26 | 122 | ₹69,00,063.28 | 122 | ₹69,00,063.28 | 0 | ₹0.00 |

Production is ahead of the source in June, July, and August. April, May, and September match exactly.

## B3. June and July Since 2 September

The combined difference has stayed exactly the same:

- **Rows:** 56
- **Value:** ₹10,44,662.94

Breakdown:

- Jun-26: 20 rows and ₹4,82,810.94
- Jul-26: 36 rows and ₹5,61,852.00

## B4. August

The 2 September load contained 12,379 rows. The fresh Google Sheet now contains 12,871 rows, an increase of 492 rows.

Production contains 12,887 rows, which is 16 rows and ₹97,233.00 ahead of the current source.

Under the existing clock, August passed out of ordinary sync scope on 7 September at 00:00 UTC. Normal open-month sync will therefore not adopt the current source. A naïve move to the 15th would reopen August and make the 16 database-only rows eligible for deletion.

## B5. September

September now contains data. Both the fresh Google Sheet and production database contain:

- **Rows:** 122
- **Value:** ₹69,00,063.28

## B6. FY2026–27 Total Through September

**Fresh Google Sheet source:**

- 56,962 rows
- ₹1,35,92,28,244.48

**Production sale_line:**

- 57,034 rows
- ₹1,36,03,70,140.42

**Production minus source:**

- +72 rows
- +₹11,41,895.94

Compared with the 2 September baseline of 56,404 rows and ₹1,34,37,87,941.72:

- Fresh source increased by 558 rows and ₹1,54,40,302.76.
- Production increased by 630 rows and ₹1,65,82,198.70.

## B7. Frozen Drift Checks

Production frozen_drift_check contains zero records for FY2026–27 with checked_at on or after 2 September 2026.

No detector was invoked during this investigation because its run path records results and this section was strictly read-only.

# Section C — Current Plus Three Prior Months

## C1. Frozen-Month Writes

Ordinary sync cannot write a frozen month. Frozen months are excluded from open-month scope, manual writes are rejected, and anchored months are skipped.

There is, however, an existing controlled exception that can reconcile a frozen month without generally unfreezing it. It requires:

1. frozen-drift detection;
2. current-FY and recent-month eligibility;
3. unresolved drift;
4. a preview hash;
5. an operator and reason;
6. archival of the complete before-image;
7. a 60% wipe guard;
8. explicit approval before replacement and re-anchoring.

This controlled path is safer than making older months generally writable.

## C2. Four-Month Scope Boundary

Under current month plus three prior months, the scope exits are:

| Month | Leaves scope |
|---|---|
| Apr-26 | 1 Aug 2026 |
| May-26 | 1 Sep 2026 |
| Jun-26 | 1 Oct 2026 |
| Jul-26 | 1 Nov 2026 |
| Aug-26 | 1 Dec 2026 |

If leaving scope and becoming immutable are intended to coincide, freezing should occur on the **1st**. Freezing on the 15th leaves a 14-day interval where a month is outside the four-month read window but remains writable.

## C3. Earlier-Settlement Dependencies

The following depend on earlier settlement:

- monthly full replacement and immutable anchors;
- startup anchor assertion;
- open-month scheduler scope;
- the strict final freeze-transition guard;
- the 98% short-read guard;
- dashboard completeness and YTD behavior;
- Product-Wise closure and timestamps;
- Red Alert period-closure context;
- frozen-drift eligibility;
- dashboard snapshots;
- alert history;
- AI report caches and generated artefacts.

Existing AI cache keys do not include an ingest generation, so a report can remain stale after a prior-month correction.

## C4. Reopening Closed Months

Reopening June and July would expose them to full delete-and-insert replacement, anchor changes, repeated scheduled rewriting, and changes to figures previously quoted by reports and alerts. The confirmed 56 database-only rows would disappear if the current source were adopted.

As of 7 September, a naïve Aug-26-forward rule also reopens August. The safe choices are now:

- apply the new clock only from Sep-26 forward;
- make persisted frozen state permanently override the calculated clock; or
- keep August frozen and handle its 16-row difference through controlled approval.

# Section D — Weekly Mechanism

## D1. Current Scheduling

The current design uses production-only interval schedulers initialized at process startup:

- primary open-FY register mirror: delayed first run, then every six hours;
- secondary dashboard: delayed first run, then every six hours;
- secondary raw SKU refresh: independently every six hours;
- alert detection: delayed first run, then every six hours;
- weekly digest: 15-minute polling with an IST window and persisted last-run state.

A weekly re-sync should use a polling interval plus a persisted weekly run key. A process restart may initialize the scheduler, but it must not decide that work is due. This prevents deployment-driven repetition like the previous MRP refresh behavior.

## D2. Runtime and API Quota

The primary register read processes roughly 45,000–50,000 rows, but Sheets API quota is based on requests rather than returned rows. Large tab ranges mean the request count is modest; parsing, data transfer, transactional deletion, and batched reinsertion are the heavier costs.

A weekly job alone is unlikely to threaten quota. The main risk is overlap with existing six-hour register, dashboard, SKU, distributor, and alert jobs. It should reuse an overlap guard or shared scheduler lock.

The earlier closed-year metadata 403 responses came from the connected Google account. The application’s own Sheets client successfully read the workbooks, so those responses do not establish that the application client is currently rate-limited.

## D3. Replace or Merge

The current primary sync performs complete monthly replacement, not merge:

1. read the complete month;
2. obtain a transaction-scoped lock;
3. delete the database month;
4. insert the source rows;
5. verify that rows written equal rows read;
6. commit atomically.

The 98% rule protects against materially truncated reads. It does not prevent small source deletions. The 56-row June/July reduction is approximately 0.2% of those two months combined and would pass the guard, causing those rows to disappear.

Recommended policy:

- current month: continue automatic source-authoritative replacement;
- immediately prior month: allow automatic replacement, but record and alert on every nonzero deletion or value reduction;
- older frozen months: require controlled preview and explicit approval;
- retain 98% as a catastrophic-read guard, not as approval for normal shrinkage.

## D4. Per-Run Evidence

The primary register persists the latest baseline and frozen anchor, and runtime results include rows read and written. It lacks a durable per-run ledger containing additions, removals, changes, before/after fingerprints, and scheduler identity.

The secondary dashboard is stronger: it has a durable ingest-run record, append-only row revisions, and successful snapshots.

The secondary raw SKU path has structured results and logs but lacks an equivalent durable revision ledger. The frozen-drift correction path records the operator, reason, preview hash, complete before-image, and resolution.

## D5. Downstream Invalidation

Invalidation is incomplete:

- SKU and retailer-registry caches are cleared after successful reload.
- Secondary dashboard snapshots are rewritten after successful loads.
- Alerts rerun independently and eventually reflect changes.
- There is no general dependency-aware invalidation for all reports affected by a prior-month correction.
- AI cache keys lack a data-version token.
- Existing generated reports and exports are not retroactively corrected.
- Alert history remains historical evidence and is not rewritten.

## D6. Trade-Off

Automatically keeping four months mutable captures most of Prayag’s approximately two-month editing tail and would resolve the 56-row discrepancy automatically.

The cost is approximately 92 days before settlement, weaker closed-period guarantees, silent acceptance of small deletions, possible disagreement with previously generated reports, repeated full replacement, and incomplete change history.

## D7. Middle Option

The safer middle option is:

**Automatic:**

- current month;
- one immediately prior month.

**Explicit and logged:**

- months two and three prior.

Older corrections should use the existing frozen-drift approval workflow rather than generally unfreezing those months.

Before enabling weekly prior-month replacement, add:

- one durable run record per affected month;
- before/after counts, values, and fingerprints;
- visibility for every shrink;
- ingest-generation-aware report and AI cache keys;
- targeted invalidation for affected periods;
- a persisted weekly schedule key and overlap lock.

## D8. Recommendation

Adopt the middle option:

1. Do not globally reopen Jun-26, Jul-26, or Aug-26.
2. Keep the current month automatic.
3. Allow one immediately prior month automatically only under a prospective freeze policy.
4. Require frozen-drift preview and approval for months two and three prior.
5. Add a durable primary monthly ingest ledger first.
6. Make every row or value shrink visible, even below 2%.
7. Version dependent snapshots and AI caches by ingest generation.
8. Use persisted weekly scheduling rather than startup-triggered execution.

This captures most late edits automatically while retaining control over already-settled periods.

# Final Status

No source data, production data, files, workflows, or deployment state were modified during the investigation. Section A was not published or pushed because its mandatory safety stop condition was triggered.
