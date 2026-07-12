---
name: Audit engine architecture
description: How the Prayag audit engine is structured — endpoint, check groups, workbook, and frontend wiring.
---

## Key facts

- `GET /api/audit?fy=<fy>` → runs `runFullVerify(fy)` + `runExtraGroups(fy)` in parallel, returns `FullVerifyReport` (same shape as old /mgmt/verify but with 9 groups instead of 6).
- `GET /api/audit/download?fy=<fy>` → re-runs audit then calls `buildAuditWorkbook()` from exceljs; 8-tab .xlsx (Summary, Checks, Failures, Source Health, Unmatched Names, Head Reconciliation, Cross-foots, Anchors).
- Extra groups: `artifacts/api-server/src/lib/audit/extraGroups.ts` — truncation (1.1), report logic (6), cross-foots (7).
- Config anchors: `artifacts/api-server/config/audit_anchors.json` (separate from `verify_anchors.json`).
- DataHealth.tsx now calls `/api/audit`, auto-reruns when `useDashboard().syncedAt` changes.

## Why runFullVerify was unwired
The old `GET /api/mgmt/verify` called `runVerify` (verify.ts, secondary only). `runFullVerify` from verifyFull.ts existed but was never exposed in a route — the new `/api/audit` is the first caller.

## Group 6 (Report Logic)
- Only runs for `fy === "2026-27"` (anchored to CY FY26-27 Sunil Patel Q1).
- Like-months: CY = ["Apr-26","May-26","Jun-26"], LY = ["Apr-25","May-25","Jun-25"].
- All DB queries: headCanon = 'Sunil Patel', filtered by monthLabel IN (...) via sql join.
- Pending if actual = 0 (no DB rows) — not a fail; user needs to run backfill for the FY.
- Tolerance: 0.1% (tight spot-check); >0.1% → warn; >1% → fail.

## Truncation check
- Fails if `agg.rowsRead` is in the suspicious set: [100,500,1000,5000,10000,50000,100000].
- Also fails if rowsRead < expectedMinRows (20,000 for FY2025-26).
- FY2026-27 is always pending (file doesn't exist yet — expected gap).

## Cross-foots
- 7.1: Σ(tm.saleAmount) ≈ agg.totalSaleAmount (tolerance ₹1 for pass, ₹10k for warn).
- 7.2: No member with negative saleAmount.
- 7.3/7.4: Expected member/retailer counts anchored in audit_anchors.json by FY.
