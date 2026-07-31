---
name: Tank dedup serial collision
description: Why synthetic serials for Schema B FYs must be assigned after tank resolution, not during sheet read
---

## Rule
Assign synthetic `serialNo` for null-serial rows (Schema B FYs: 2024-25, 2025-26) AFTER tank resolution in step 2c of `doSync`, not in the `onRow` callback during sheet reading.

**Why:** `dedupeBySerialNo` uses the 6-field key `[fy, month, serialNo, invoiceNo, code, color, qty]` where `qty` is the POST-resolution value (pieces for tank rows). If two rows have different ltr quantities (e.g. 500L and 1000L) that floor-divide to the same pieces count (e.g. both = 1 piece), and synthetic serials were assigned pre-resolution using ltr-based identity keys, both rows independently get `serialNo=0` from their own counter keys. After tank resolution, they share the same 6-field key → one gets dropped by `dedupeBySerialNo`.

**How to apply:** Step 2c in `doSync` (registerSync.ts) applies `postResOccCounter` after `linesWithResolvedUids` is built. For null-serial rows, it assigns `syntheticSerial = counter.next(postIdKey)` where `postIdKey = invoiceNo|code|color|resolvedQty|monthLabel`, then recomputes `lineUid` using the full `lineUidKey` formula with the synthetic serial. Schema A rows (FY2026-27 with real SERIALNO) are untouched (`line.serialNo != null`).

**Verified:** FY2024-25 → 141,201 rows · Rs 341.14 Cr; FY2025-26 → 145,613 rows · Rs 361.00 Cr; both 0 superseded on dev after the fix.
