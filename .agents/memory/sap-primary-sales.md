---
name: SAP primary-sales pipeline (FY2026-27)
description: How the SAP Excel upload pipeline, verification gate, and analytics cutover work; the invariants that must hold.
---

# SAP primary-sales pipeline

FY2026-27 primary sales come from monthly SAP Excel exports (cols A-M) uploaded per FY+month, not from Google Sheets order tabs or the invoice-line register. Each upload is streamed from object storage and enriched by a live "rate list" Google Sheet (Sheet1 item master -> product GROUP; Sheet2 customer master -> STATE HEAD / STATE / channel).

## Non-negotiable invariants
- **Cross-foot by construction**: every SAP row contributes to a group, a head, and a state bucket, with explicit `Unmapped` / `Unmapped (review)` buckets so unmatched rows never vanish. Σgroup = Σhead = Σstate = grand total (±₹1). Do not "filter out" unmapped rows — that breaks the balance.
- **Cost/MRP are NEVER taken from the rate list.** MRP is read for reference/cross-check only. SAP margins come only from `cost_master` (same rule as the register path).
- **Verification-gated, non-destructive cutover**: analytics serve FY2026-27 from SAP **only** when `isSapVerified(fy)` is true; otherwise the `sale_line` register is the fallback. `compareFy` (prior FY) is ALWAYS register-sourced. Never delete or overwrite `sale_line`.
- **Re-upload overwrites** a month (UNIQUE(fy, month_label), onConflictDoUpdate). The object path is a fresh UUID per upload; the register endpoint normalizes the signed URL to that path.

## Verified gate
`buildSapVerifyReport` reports customer match % (rows + revenue), the Apr-Jul benchmark vs the signed-off total, cross-foot balance, and any unmatched customers / unmapped groups. The `verified` gate itself is exactly three conditions: revenue match % > target, benchmark ok (all months present + within tolerance), and cross-foot ok. Unmapped groups are surfaced for review but do NOT block the gate (they still land in an explicit bucket, so the cross-foot stays balanced regardless). `isSapVerified` caches ~30s; `clearVerifiedCache()` is called after every register/delete so the UI reflects changes immediately.

## Auth gap (known, out of scope of the build task)
None of the mutating API endpoints in this app are authenticated — `POST /targets`, `POST /verify/backfill`, and the SAP `POST /sap/upload-url|/register` + `DELETE /sap/upload` all mutate with no authz. This is an app-wide characteristic, not specific to SAP. Adding auth should be done across all mutating endpoints together, not piecemeal on SAP.
