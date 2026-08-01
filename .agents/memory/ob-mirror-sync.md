---
name: OB mirror sync (primary_order_line)
description: How the Order Booking DB mirror stays aligned with the live Order Sheet, and why replace mode exists.
---

# OB mirror sync

`primary_order_line` mirrors the monthly tabs of the Order Sheet (BOOKING_SHEETS in primarySheets.ts). The app reads OB live from the sheet; the DB mirror serves analytics (distributor deep-dive pending, flows).

**Rule:** an append-only mirror ingest (ON CONFLICT DO NOTHING) can never remove rows deleted from the source sheet, so the mirror silently drifts stale. Replace mode (per-tab transactional delete + re-insert, plus orphan-tab cleanup for tabs deleted/renamed in the sheet) is the only accurate sync.

**Why:** user-facing OB reads are live from the sheet, so mirror staleness produces no visible fault — it only corrupts DB-side analytics, and nothing surfaces it without an explicit cross-check.

**How to apply:**
- The scheduled replace-mode sync covers the open FY only; audit cross-foot 7.0 compares mirror vs live sheet every audit run and names the re-sync command on failure.
- Orphan cleanup must be skipped whenever any tab read errored — a transient Sheets failure must never cascade into deleting a month.
- Manual replace ingest is destructive: gated by admin token (ORDERS_ADMIN_TOKEN, disabled when unset) and by the frozen-FY unfreeze+reason convention.
