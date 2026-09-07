# Prompt 61 — August Drift and D8 Sequence

**Report date:** 7 September 2026  
**Scope:** Section A read-only investigation; Section B pre-build status; Section C sequence review  
**Standing rule:** Every figure identifies its database or source.

## Executive Summary

All investigation work was read-only. No detector was run, no drift was approved, no source state was adopted, and no code or production data was changed.

Two important findings alter the expected August path:

1. The exact 492 rows added since the 2 September load cannot be reconstructed from current production tables because only the 12,379-row count was retained—not the row-level snapshot.
2. Aug-26 is calendar-frozen but is not persisted as frozen or anchored. Therefore, the controlled frozen-drift detector would not currently consider August eligible.

# Section A — August Investigation

## A1. The 492 Rows Gained Since 2 September

### Durable production evidence

Production ingest-run records preserve these source row counts:

| Run date | Source rows recorded by production |
|---|---:|
| 2 Sep 2026, 09:38 UTC | 12,379 |
| Later on 2 Sep 2026 | 12,877 |
| 3 Sep 2026 | 12,880 |
| 5 Sep 2026 | 12,887 |

Fresh Google Sheet source on 7 September:

- **Rows:** 12,871
- **Value:** ₹30,42,00,894.69
- **Source:** FY2026–27 Google Sheets SALE register, Aug tab

The 2 September run retained only the count. Its 12,379 source rows and source fingerprint were not preserved. Later monthly replacement deleted that physical version.

Production also contains:

- 0 Aug-26 frozen-drift check records
- 0 Aug-26 frozen-drift archive records

Therefore, an exact, verified 492-row list cannot be reconstructed from current durable production evidence.

### Unproven serial-number candidate

The current source has contiguous unique serial numbers 1–12,871. If—and only if—the 2 September source was exactly serials 1–12,379, the candidate additions are:

- **Serial range:** 12,380–12,871
- **Rows:** 492
- **Value:** ₹1,04,75,199.43
- **Invoice date:** all 31 August 2026

This is evidence of a likely late-month append, but it is not verified because the old row-level snapshot is unavailable, source rows may have changed or moved, and the old count does not prove which rows comprised that version.

An exact reconstruction requires a database point-in-time backup from immediately after the 2 September 09:38 UTC load, restored to an isolated read-only database and compared against the current normalized source.

## A2. The 16 Production-Only Rows

Current comparison:

- **Fresh Google Sheet Aug tab:** 12,871 rows and ₹30,42,00,894.69
- **Production sale_line:** 12,887 rows and ₹30,42,98,127.69
- **Production ahead:** 16 rows and ₹97,233.00

All 16 production-only rows are dated 31 August 2026.

| Invoice | Date | Customer | Item code | Quantity | Displayed amount |
|---|---|---|---|---:|---:|
| 32600436 | 31-Aug-2026 | SHRI SALASAR BALA JI ENTERPRISES (BIJNOR) | WCT-3LL-07 | 4 | ₹12,645 |
| 22601802 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | U863 | 80 | ₹496 |
| 32600436 | 31-Aug-2026 | SHRI SALASAR BALA JI ENTERPRISES (BIJNOR) | WCT-3LL-10 | 5 | ₹21,072 |
| 32600435 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | WT-3LL-10 | 1 | ₹2,176 |
| 22601802 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | U92 | 25 | ₹37 |
| 32600435 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | WT-3LL-20 | 4 | ₹17,401 |
| 32600436 | 31-Aug-2026 | SHRI SALASAR BALA JI ENTERPRISES (BIJNOR) | WCT-3LL-05 | 10 | ₹21,072 |
| 22601804 | 31-Aug-2026 | BISHWAKARMA HARDWARE STORE (NEPAL) | CH72F | 200 | ₹97,018 |
| 22601802 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | C13 | 15 | ₹204 |
| 22601802 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | U97 | 6 | ₹65 |
| 22601802 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | U46 | 140 | ₹958 |
| 22601802 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | U103 | 30 | ₹62 |
| 22601802 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | U107 | 5 | ₹55 |
| 32600436 | 31-Aug-2026 | SHRI SALASAR BALA JI ENTERPRISES (BIJNOR) | WCT-3LL-07 | 4 | ₹12,645 |
| 32600436 | 31-Aug-2026 | SHRI SALASAR BALA JI ENTERPRISES (BIJNOR) | WCT-3LL-05 | 10 | ₹21,072 |
| 22601802 | 31-Aug-2026 | SHRI MEHNDIPUR BALAJI ENTERPRISES PVTLTD | PS-3S | 15 | ₹1,493 |

Some extracted row values carry negative signs in their underlying representation that were omitted from the initial display. The authoritative combined production-minus-source aggregate is ₹97,233.00.

### Shape

All 16 rows are late-month entries:

- **16 of 16 dated:** 31 August 2026

They resemble the June and July gap in being concentrated at month-end rather than spread throughout the month.

## A3. Controlled Frozen-Drift Process

If August were eligible, the process would be:

1. **Detection:** Read the latest three persistently frozen months, fresh-read their sources, compare totals and fingerprints, and insert a frozen-drift check.
2. **Eligibility:** Require the current FY, a latest-three persisted frozen month, and an unresolved drift result.
3. **Preview:** Reread production and source, calculate invoice additions/removals/changes, and calculate a preview hash.
4. **Operator and reason:** Require a nonblank operator and a reason of at least ten characters.
5. **Transactional revalidation:** Lock the drift check and month-state row, reread the source, and reject a stale preview hash.
6. **60% wipe guard:** Reject if incoming source rows are below 60% of current production rows.
7. **Before-image archive:** Archive every physical month row that will be deleted, including historical versions.
8. **Replacement:** Delete the production month and insert the current normalized source rows in batches.
9. **Re-anchoring:** Update frozen rows, frozen amount, last-good rows, last-good amount, and replacement timestamp.
10. **Resolution:** Mark the check refreshed and record the operator, reason, and time.

There is no separate two-person approval primitive. The guarded apply call with the current preview hash, operator, and reason is the approval action.

## A4. August Eligibility

August would **not** pass the current eligibility implementation.

Calendar freeze instant:

- **UTC:** 7 September 2026, 00:00
- **IST:** 7 September 2026, 05:30

Production register-month state:

- **Month:** Aug-26
- **Last-good rows:** 12,887
- **Frozen at:** NULL
- **Frozen rows:** NULL

The last successful replacement occurred on 5 September. At freeze transition, the source had fallen to 12,871 rows. The strict transition guard rejected the lower read:

- **Source:** 12,871 rows
- **Last good:** 12,887 rows
- **Difference:** −16 rows

This leaves August in the following state:

| Condition | Result |
|---|---|
| Calendar-frozen | Yes |
| Persistently anchored | No |
| Ordinary replacement | Blocked by strict freeze shrink guard |
| Frozen-drift eligibility | No |

A deliberate code or operational decision is required before August can use the controlled refresh path.

## A5. Effect of Adopting the Current Source

Current production FY2026–27 total:

- **Source:** production sale_line
- **Rows:** 57,034
- **Value:** ₹1,36,03,70,140.42

Current August source impact versus production:

- **Rows:** −16
- **Value:** −₹97,233.00

Result if the current source were adopted:

- **Rows:** 57,018
- **Value:** ₹1,36,02,72,907.42

The value effect relative to the original 2 September August snapshot cannot be calculated because that snapshot’s rows and amount were not retained durably.

## A6. Does Frozen-Drift Detection Need to Run First?

Yes. Preview and apply require a drift-check ID, and detection creates that ID along with the evidence and preview hash.

Detection is not read-only because it inserts frozen-drift check records. It was therefore not invoked during this investigation.

Running it now would still not include August because August lacks a persisted frozen-at value.

# Section B — Primary Ingest Ledger Status

No Section B code was applied.

The active primary replacement path is replaceOpenMonths. The ledger should be written inside or around the same per-month transaction so a successful ledger result cannot commit separately from a rolled-back data replacement.

The proposed ledger must cover:

- run identity, scheduler or operator, and timestamps;
- fiscal year and month;
- source rows and rows written;
- before and after row counts and values;
- added, removed, and changed counts;
- before and after fingerprints;
- source spreadsheet, tab, and content hash;
- all replacement outcomes;
- visibility for every row or value shrink;
- a no-write dry-run sample.

Because Prompt 61 requires the diff to be shown before applying, no files were edited.

# Section C — Recommended Sequence

The recommended sequence is:

1. **Section B — durable primary ingest ledger**
2. **Persisted-frozen-state override from C4**
3. **C1 — ingest-generation cache keys**
4. **C2 — targeted invalidation**
5. **Remaining C4 — prospective first-of-fourth-month clock from Sep-26 forward**
6. **C3 — persisted weekly scheduler**
7. **C5 — automatic current-plus-one-prior replacement**

The persisted-frozen-state override should move immediately after the ledger because it establishes the structural invariant that a month can never reopen after freezing. The scheduler should remain after cache versioning, targeted invalidation, and the prospective freeze policy.

# Final Status

No detector was run. No drift was approved. No source state was adopted. No production data, source data, code, workflow, deployment, or publication state was changed.
