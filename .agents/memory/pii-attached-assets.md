---
name: PII attached_assets trap
description: Uploaded CSVs in attached_assets contain personnel PII and must never be committed
---
- Uploaded master-load CSVs (sales user list, retailer/distributor/product uploads) land in attached_assets/ and contain personnel contact PII.
**Why:** they were committed once by accident and removed in a dedicated commit; a later `git add -A` re-committed new uploads and code review flagged it again (fixed by untracking + gitignore `attached_assets/*.csv`).
**How to apply:** stage files explicitly when uploads exist, or verify `git status` shows no attached_assets CSVs before committing.
