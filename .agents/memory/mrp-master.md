---
name: MRP Master pipeline
description: Effective-dated MRP database — two tables, 6-workbook loader, admin route, frontend page.
---

## Tables (migration 022_mrp_tables)
- `mrp_master` (item_code PK, item_name, segment, series, packing)
- `mrp_history` (id, item_code FK ON DELETE CASCADE, mrp, effective_from, effective_to, source_file, is_current)

## Workbook configs (artifacts/api-server/config/mrp_files/)
| File | Tab | Code col | Old MRP col | New MRP col | w.e.f. |
|------|-----|----------|-------------|-------------|--------|
| PTMT MRP w.e.f. List as on 05th March, 2026.xlsx | MASTER | col3=CAT No. | col5 | col6 | 2026-03-05 |
| MRP w.e.f. 01st Feb, 2026 Pipe & Fitting.xlsx | MASTER | col3=CODE | col6 | col7 | 2026-02-01 |
| New CP MRP w.e.f. 01st Aug, 2026.xlsx | MASTER | col3=ITEM CODE, col5=OLD(May-26) | col5 | col6 | 2026-08-01 |
| SANITARYWARE NEW MRP w.e.f. 01st May, 2026.xlsx | Old MRP VS New MRP | col3=Cat No. | col6 (White) | col10 (White) | 2026-05-01; data starts row 3 |
| NEW HARDWARE Price List as on 01st Mar, 2026.xlsx | HW FG + HW TRD FG | col2=code | col5 | col6 | 2026-03-01; oldEff=2024-06-01 |
| MRP w.e.f. 15th Feb, 2024 QUAA & FERN.xlsx | QUAA + FERN | col2=CODE | col4 | col5 | 2024-02-15; data starts row 3; QUAA oldEff=2022-01-01, FERN oldEff=2017-12-01 |

## Key numbers (Aug 2026 load)
- 5,694 master codes; 9,211 history rows; 3,152 codes with revision
- 208 duplicates dropped (CNS-15 etc. appear in both PTMT and CP MASTER)
- Match rate vs FY2026-27 sale_line: 77.8% (exact=2736, p_strip=18, colour_suffix=36, whitespace=76, unresolved=817)
- 856 codes newly have MRP (not in item_master.mrp); their FY2026-27 amount = ₹62.9 L

## Admin load route
POST /api/admin/mrp/load with X-Admin-Secret header — full replace (delete mrp_history, mrp_master, re-insert).

## Frontend
Route: /mrp · Component: artifacts/prayag/src/components/mrp/MrpContent.tsx
Nav: SALES > MRP Master (IndianRupee icon)
History panel: click any row → slide-over showing effective-dated price timeline.

**Why:** mrp_master and mrp_history are intentionally NOT exported from lib/db/src/schema/index.ts (same reason as schemes.ts — prevents Replit deploy provisioner from conflicting with runMigrations). Import from lib/db/src/schema/mrp.ts directly.

**How to apply:** To reload data after workbook updates: POST /api/admin/mrp/load. To add a new workbook format, add a parser in artifacts/api-server/src/lib/mrp/loader.ts following the existing pattern.
