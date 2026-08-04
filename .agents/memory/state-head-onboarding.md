---
name: State Head onboarding (Sales Deep Dive)
description: How to onboard a new state head's team — config-only change plus the reconciliation identity to verify.
---

Onboarding a head's team is **config-only**: add each member as `normSecKey(name) → Google file ID` in `config/member_sheet_map.json` (normSecKey = lowercase alphanumerics, so "Vikas Kumar (Bareilly)" → `vikaskumarbareilly`). Roster/head resolution comes from the STATE HEAD DASHBOARD Data tab + `head_alias.json`; the frontend head dropdown populates dynamically — no code edits.

**Reconciliation identity (per member):** own-sheet order booking (sum of retailerDetail rows) = kpis.orderBooking (old-party) + kpis.newPartyOrderBooking + kpis.directDealersOrder. Comparing against old-party+DD alone leaves a gap exactly equal to new-party OB. Paise-level (≤ ₹2) diffs are sheet rounding, not errors.

**Why:** verified on Syed Aqil Rizvi's 32 members (Aug 2026): 31/32 exact, 1 off by ₹1.21.

**How to apply:** after adding map entries, restart api-server, hit `/api/mgmt/deep-dive?stateHead=<name>` for team totals, then per-member `&member=<name>` (retailerDetail loads in background — retry after ~45s on `status:"loading"`). Money figures verified against a dated memo can drift if a register sync ran since the memo (sales received / cost move; OB and target are more stable).

**Tab-name variants (Aug 2026):** some member workbooks title the current-FY retailer table `Retailer Report <FY>` instead of `Summary Report <FY>` — the loader accepts that FY-exact alternate. NEVER accept a bare unlabelled "Summary Report" tab: in at least one workbook it is a frozen legacy 2023-24 layout, and reading it silently yields OB=0 for every retailer.

**Register misspellings:** the secondary register's PS-code vocabulary carries misspelled member names (e.g. Sonawane→"SANWANE", Sasane→"SAASNE"). `config/member_name_alias.json` maps roster name → register spelling for `resolveHeadForSecondary`; add new cases there, never as a second person.

**Whole-team roster quirks:** a folder of member files can contain Copies, LEFT members, other teams' members, and even distributor sheets — only ever use the explicitly resolved file IDs, never folder listing.

## Drive search route semantics (Aug 2026)
GET /api/drive/files?q=<substring> wraps q as a `name contains` clause — raw Drive query syntax ("in parents", operators) does NOT work through it. Disambiguate same-name files by listing tabs (listSheetTabs), never by folder listing. A search miss means NOT SHARED with the service account, not that the file doesn't exist — ask the user for a direct link.

**Sheet-title matching rule (user-confirmed, Aug 2026):** when hunting for a member's working sheet in Drive, match on a normalised name (lowercase alphanumerics, normSecKey-style), never exact title. Three known title drifts: "k.v thamizhaselvan" (extra "a"), JITHENDER REDDY (surname missing), HEMANT SRIVASTAVA (middle name missing). Sheets may also live outside the head's team folder.
