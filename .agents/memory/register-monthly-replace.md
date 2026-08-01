---
name: Register monthly full-replace pipeline
description: Open-FY register sync design (Aug 2026) — nightly per-month delete+insert replace, DB-persisted short-read baseline, clock-derived month freeze on the 7th.
---

# Register monthly full-replace pipeline (supersedes versioned sync for open FY)

The sale register sheet has NO stable row identity (col-A serials renumber on re-sort; ~0.3% of rows are fully identical on every field). Any identity-key reconciliation (versionedSyncLines + tombstoneOrphans) doubles rows when the sheet re-sorts — this happened twice in production (July 2026, ₹41 Cr vs ₹26 Cr).

**Design (user-mandated, replaces identity-key approach):**
- Nightly (24h) sync reads the whole FY sheet; each non-frozen month is deleted and re-inserted in ONE transaction (`replaceOpenMonths` in `monthlyReplace.ts`). No identity key, dedup, tombstone, supersede, or revive.
- Only guard: abort if read < 98% of `register_month_state.last_good_rows` (DB-persisted baseline, survives restarts). `force=true` overrides and resets the baseline.
- Months freeze permanently on the 7th of the following month, derived from the CLOCK (never config). Frozen month = no read/write; rows+amount anchored in `register_month_state` and asserted on startup (`assertMonthAnchors`).
- Each month is processed inside `pg_advisory_xact_lock(hashtext('register-month|fy|month'))`; baseline read, guard, delete+insert, and state upsert are all in that one transaction (concurrent scheduler + manual route cannot interleave). Freeze-transition anchors come only from a verified replace, never from an unverified DB snapshot.
- Routes: POST `/registers/:fy/replace-months` (?force / ?now require API key), GET `/registers/:fy/month-state`. Legacy month-mutating routes (tombstone-orphans, orphan-audit apply/reverse, invoice-restore-apply) return 423 on frozen months; force-resync `clearFirst` is refused for FYs with frozen months.

- **Rule-based month scope (Aug 2026):** `openMonthLabels(fy, now)` enumerates every started, unfrozen month of the FY; empty tabs (current month before first invoices) are still attempted, get a baseline of 0, and are logged as explicit no-ops. A 0 baseline never trips the guard; an empty read against ANY positive baseline aborts (explicit `sheetRows === 0` branch — floor(1×0.98)=0 rounding gap would otherwise delete a 1-row month). Between the 1st and 6th BOTH the prior month (edit window) and the current month are in scope.

**Why:** correctness by construction (DB == last read, always); the only failure mode left is a bad read, caught by the baseline guard.

**How to apply:** never reintroduce sheet-serial or identity-key reconciliation for the open FY. Old versioned-sync machinery still exists in `ingest.ts` for legacy routes but is out of the sync path. FY-level frozen registers (23-24/24-25/25-26) are a separate, unchanged system.
