---
name: Tombstone identity-key bugs (qty units + serial number)
description: Two root causes that made the manual tombstone-orphans endpoint produce false candidates for water tank rows; both fixed July 2026.
---

## Bug 1 — qty unit mismatch (raw litres vs. pieces)

**Rule:** The tombstone-orphans route (`POST /registers/:fy/tombstone-orphans`) MUST apply `resolveWaterTankRow` to the sheet rows before building `seenIdentities`, exactly as `registerSync.ts` does before calling `versionedSyncLines`.

**Why:** `registerSync.ts` overwrites `line.qty` with converted pieces (e.g. "2") before storing to DB. The manual tombstone route called `toSaleLine` directly (raw sheet litres, e.g. "1500"). Identity key mismatch → every water tank row appeared as an orphan candidate every time the manual endpoint ran. 639 water tank rows in May-26 produced 634 false candidates (the 5-row gap = WT-002 accessory codes that pass through unresolved with raw qty on both sides).

**How to apply:** After `allLines` is populated in the tombstone-orphans route, run the same `lines.map(resolveWaterTankRow)` step that `registerSync.ts` does (lines 203–244 of registerSync.ts). Fall back to Route 2 (division) when SAP load fails. Fixed in registers.ts tombstone-orphans handler.

## Bug 2 — serial number missing from identity key

**Rule:** `identityKey()` in ingest.ts accepts an optional 6th `serialNo` parameter. Always pass `serialNo` at all call sites in the sync hot path (tombstoneOrphans, versionedSyncLines). The DB SELECT in `tombstoneOrphans` must also include `serialNo` — it was missing before the fix.

**Why:** Two physically distinct sheet rows sharing the same invoice+code+colour+qty but on different rows get the same identity key without serial number. They swap places (supersede each other) on every sync indefinitely. `lineUidKey` (for `line_uid` hashing) already included `serialNo` to give them distinct hashes, but the identity comparison did not.

**How to apply:**
- `identityKey(invoiceNo, code, color, qty, monthLabel, serialNo?)` — when serialNo != null, appends `|sn:<n>` to base key.
- Historical FYs without a SERIALNO column return null → falls back to 5-field key (backward compatible).
- The `tombstoneOrphans` DB query SELECT must include `saleLines.serialNo` or `r.serialNo` will be undefined and the key will never include the serial suffix (100% blast radius bug).

## Verification (post-fix)

May-26 dry-run: 634 → 0 candidates. Jun-26 dry-run: 861 → 0 candidates.

## Remaining callers not yet updated

Other callers of `identityKey` in registers.ts (reconciliation, audit, cross-check endpoints at lines ~1694, 1748, 1966, 2028, 2211, 2274, 2457, 2508) do not pass `serialNo`. These are diagnostic/reporting endpoints, not the live sync path — low priority, but should be aligned when those endpoints are next touched.
