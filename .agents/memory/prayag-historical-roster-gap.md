---
name: Prayag historical roster gap
description: How the FY<current Order Booking shortfall happens and how it is fixed in assembleRows.
---

## The problem

`assembleRows` uses the current (FY2026-27) STATE HEAD DASHBOARD fallback as the
roster spine for ALL fiscal years. For FY2025-26 the 2026-27 roster has ~180
active members; the 2025-26 order file has ~200 distinct TMs. The ~20 departed
employees (no longer in the active roster) carry the bulk of the missing money.

## The fix (report.ts — assembleRows)

After the main roster rows are built, iterate `agg.perTm` for the current FY.
For each TM key not in the active roster's normKey set:
1. Look up the target master row for that FY — it has `stateHead`.
2. Skip if stateHead is empty (cannot assign to a head).
3. Build a synthetic `RosterMember` (state = "", leftDateSerial = null, activeLeft = "Left").
4. Push a supplemental `MemberRow` (computeOrderStats uses normKey to pull values from perTm).

**Why:** The target master for FY2025-26 carries ~194 rows including the departed
high-earners, so their stateHead is available. This brings the order booking
total from ₹46.34 Cr up to ~₹240.14 Cr.

## Remaining limitation

40 departed TMs had ZERO order bookings in FY2025-26 — they are not in the
order file, so they cannot be recovered by this approach. Getting from ~200
(recovered) to exactly 240 (approved dashboard) requires a historical roster:
either the HR roster file (fileId in mgmt_sources.json, not shared yet) or a
FY-specific STATE HEAD DASHBOARD workbook. No financial impact from these 40.

## Diagnostic surface

`NameMatchInfo.unmatchedFromFileWithAmounts` (added alongside this fix) lists
every TM in the order file with no roster match, sorted by descending amount.
Exposed in the API as `meta.orderBookingNameMatches`.
