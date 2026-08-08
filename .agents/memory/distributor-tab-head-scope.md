---
name: Distributor tab head scoping
description: Secondary/SKU tabs aggregate across a state head's distributors; push stays per-distributor; filtered deep-dive cache rules
---

# Distributor tab head scoping (Aug 2026)

- `GET /api/mgmt/distributor-tab` accepts EITHER `dist=<normKey>` OR `head=<state head name>` (+ optional `states=` comma list of canonical states) for `tab=secondary|sku`. Push is per-distributor only (peer-cohort logic) — head requests for push 400.
- Head scope = directory distributors whose `heads` include the head, intersected with geography states. Builders take `string | TabScope { keys, label }`; name lists are unioned per key from recon maps (`unionNames`). Baseline names for SKU union per-key `mapRegisterNamesForKey` results.
- **Identity rule holds in aggregates**: every scoped key is resolved against the distributor identity registry; ambiguous keys are EXCLUDED and disclosed in the label ("N ambiguous names excluded"), registry unavailability fails closed (503).
- Some heads legitimately have zero mapped distributors (e.g. Anuj Sharma, Sunil Mohanty in FY26-27) — 404 with an explanatory message, not a bug.

**Why:** users expected the State Head filter to change the Secondary/SKU tab data; previously tabs required a single distributor and ignored the head entirely.

# Filtered deep-dive cache

- Period-filtered (`months`) distributor deep-dive builds never touch the persisted snapshot, but ARE cached in-memory: complete loads 15 min (member-sheet TTL), degraded loads 2 min. Key = `dist-deep-dive|<fy>|<HEAD>|<sorted months>`.
- `invalidateFilteredDistDdCache(fy?)` is exported and called from `invalidateMgmtDataCache` so a register re-sync/upload drops pre-sync filtered payloads.
- **How to apply:** any new mgmt cache-invalidation path must also drop this cache (or route through `invalidateMgmtDataCache`).
