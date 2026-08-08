---
name: Upload master loads (product / roster / customer)
description: Aug 2026 CSV master loads — variant table design, roster compound identity, customer junctions, loader safety rules
---

## Product master upload
- `item_master` stays keyed on `code` (exact-code joins everywhere); upload variants live in child table `item_master_variant` (UNIQUE code+feature_name+segment_source so MRP conflicts keep both rows, `mrp_conflict` flagged, never silently picked).
- item_master.mrp is only backfilled where NULL (rate-list MRP is never overwritten); `mrp_source='product_upload'` marks upload-sourced values.
- Register-join resolver `src/lib/sku/productCodeResolver.ts`: strict order exact → P-strip → colour-suffix (B/G/P/J/W) → whitespace-collapse. Exact MUST run first. After the load, most spec-predicted gap families resolve exactly (rate list already had them) — post-load gap is only 17 codes.

## HR roster (Sales_User_List)
- `config/hr_roster.csv` is the single authoritative roster file (transcoded cp1252→UTF-8 from the Sales_User_List upload); loader stays file-based, CSV is enrichment only.
- Enrichment identity = compound key normSecKey(name)+":"+normSecKey(reporting manager); name-only fallback ONLY for unambiguous names; ambiguous name without manager match attaches NOTHING (ambiguous-blocked, surfaced in roster health). `resolveMemberEnrichment` in roster.ts + regression tests.
- **Why:** file has duplicate names (Ashutosh Kumar, Ranjeet Kumar., Pawan Kumar., Manish Kumar..); name-only lookup attaches another person's emp code/CTC.
- Employee codes are unreliable (62 active implausible; valid = numeric ≤4 digits); never merge on name similarity.

## Customer master upload
- customer_master now populated from Distributer+Retailer upload files via ONE loader script with type param; status vocabularies kept separate per file (status vs lead_status/status_source), route VALID_STATUSES extended, never normalised together.
- Multi-value Assign User / Assign Distributor cells need QUOTE-AWARE comma split (names contain commas) → junction tables retailer_user / retailer_distributor with norm keys + resolved flags.
- Direct-dealer truth = customer_master.entity_type ('Distributors' 2107 / 'Direct Dealers' 1209) from the distributor file's Customer Type; old `type_raw ILIKE '%direct%'` predicates SUPERSEDED-commented, not deleted (they return zero).
- Loader safety rule (from review): parse+validate BOTH files fully in memory (exact row/column counts) BEFORE any DB mutation; delete+insert in ONE transaction; snapshot and re-apply human-edited state_head/head_confidence/notes across re-runs. `--dry-run` supported.
- 59 same-state+district different-phone duplicate groups carry review_group numbers — review UI only, never auto-merge.

## Shared
- All three upload CSVs are cp1252 (NOT UTF-8) with embedded newlines — always Buffer + windows-1252 decode + RFC-4180 state-machine parser; raw line counts exceeding row counts is the tell.
- Parallel-subagent pattern: main agent writes shared migrations (runMigrations.ts) upfront so workers never touch the same file.
