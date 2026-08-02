---
name: State Head onboarding (Sales Deep Dive)
description: How to onboard a new state head's team — config-only change plus the reconciliation identity to verify.
---

Onboarding a head's team is **config-only**: add each member as `normSecKey(name) → Google file ID` in `config/member_sheet_map.json` (normSecKey = lowercase alphanumerics, so "Vikas Kumar (Bareilly)" → `vikaskumarbareilly`). Roster/head resolution comes from the STATE HEAD DASHBOARD Data tab + `head_alias.json`; the frontend head dropdown populates dynamically — no code edits.

**Reconciliation identity (per member):** own-sheet order booking (sum of retailerDetail rows) = kpis.orderBooking (old-party) + kpis.newPartyOrderBooking + kpis.directDealersOrder. Comparing against old-party+DD alone leaves a gap exactly equal to new-party OB. Paise-level (≤ ₹2) diffs are sheet rounding, not errors.

**Why:** verified on Syed Aqil Rizvi's 32 members (Aug 2026): 31/32 exact, 1 off by ₹1.21.

**How to apply:** after adding map entries, restart api-server, hit `/api/mgmt/deep-dive?stateHead=<name>` for team totals, then per-member `&member=<name>` (retailerDetail loads in background — retry after ~45s on `status:"loading"`). Money figures verified against a dated memo can drift if a register sync ran since the memo (sales received / cost move; OB and target are more stable).
