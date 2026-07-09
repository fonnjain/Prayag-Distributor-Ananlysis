# Replit Agent Prompt — Add a "Targets" tab (change request)

> Paste below the line into the Replit agent. This modifies the existing app; do not rebuild.
> This is the ONE part of the app that WRITES data — everything else only reads.

---

## GOAL

Add a **Targets** tab where a manager sets sales targets for the team. Names are pulled from the
existing roster (no typing names); targets are entered manually. Targets persist to a dedicated
**Target Master Google Sheet** (so they stay a Sheet like every other source and the Management
Report reads them back the same way).

## WHERE TARGETS ARE STORED (important — this tab writes)

Create/one-time-provision a Google Sheet **"Prayag Target Master"** with a tab `targets`. The app
writes to it via the **service account** (needs write scope — see "Auth" below). Schema, one row
per Team Member × Fiscal Year (annual figure) plus optional monthly overrides:

```
fy | team_member | state_head | level (TM|STATE_HEAD) |
primary_target_annual | secondary_target_annual | direct_dealer_target_annual | business_plan_annual |
primary_m_Apr..primary_m_Mar |            (12 monthly override cells, blank = use auto-split)
secondary_m_Apr..secondary_m_Mar |
direct_dealer_m_Apr..direct_dealer_m_Mar |
business_plan_m_Apr..business_plan_m_Mar |
updated_by | updated_at
```
Put the sheet id in `config/mgmt_sources.json → target_master.sheetId`. The Management Report reads
this sheet for all Achievement-% columns; when it's empty those columns stay blank (already specced).

## ROSTER SOURCE (names come from here — no manual name entry)

Read team members from the already-connected roster **`Team Member Details`**
(`1Nb8gRcdzY-iambAzwExTmeVY_ob6vnQ2`): `Name`, `State`, `Reporting Manager` (= State Head), `HQ`.
183 members, 12 State Heads. The dropdown lists these; do not allow free-text names.

## ENTRY MODEL (from the owner's choices)

**Level — "Both": State Head sets a total, then it splits across their members.**
1. Manager picks a **State Head** (dropdown, searchable).
2. Enters that State Head's **annual** target (the 4 fields below) — this is the STATE_HEAD total.
3. The app **splits the total across that head's team members**, default split = **pro-rata by each
   member's share of last year's actual** (from the sale/order data already in the app). If a member
   has no prior-year data, fall back to **equal split** among members with none, after the pro-rata
   members are allocated. Show the computed per-member numbers in an **editable grid** so the manager
   can override any cell; overrides re-balance so the members still sum to the State-Head total
   (show a live "allocated vs total" delta and block save if they don't reconcile, ± a small tolerance).
4. Manager can instead switch to **per-member direct entry** (skip the split) — a toggle.

**Time — "Both annual + monthly override".**
- Enter the **annual** figure per field. Default monthly = annual ÷ 12 (show the derived monthly row).
- Any monthly cell can be overridden; blank monthly cells fall back to the auto-split. If monthly
  overrides are present they must sum to the annual (same reconcile rule + tolerance), else block save.

**Fields — all four, per person:** `Primary Target`, `Secondary Target`, `Direct Dealer Target`,
`Business Plan`. Each has an annual value and 12 optional monthly overrides.

## UI

- New left-nav item **"Targets"**. Route `/targets`.
- Controls: **FY selector** (default 2026-27), **State Head** dropdown (searchable), a
  **Team-Member search** box to jump to a row, and a **level toggle** (State-Head split ⇄ per-member).
- Main area: editable grid, one row per team member of the selected State Head, columns = the 4
  target fields (annual) with an expandable monthly sub-row. Sticky header; running totals row.
- A **"State-Head total"** panel at top showing target vs sum-of-members with a green/red reconcile
  indicator.
- Buttons: **Save** (writes changed rows to the Sheet), **Recompute split** (re-runs pro-rata),
  **Revert**. Autosave off; explicit Save only. Show last `updated_by/updated_at`.
- Load existing values from the Sheet on open so edits are incremental, not overwrites.

## AUTH (this tab needs WRITE access)

The rest of the app uses read-only Sheets scope. The Targets tab needs
`https://www.googleapis.com/auth/spreadsheets` (read+write) **for the Target Master sheet only**.
Two safe options — implement (a):
(a) keep the existing read-only client for all report sources, and add a **second service-account
client with write scope used solely for the Target Master sheet id**; or
(b) upgrade the single client to read+write but guard writes so only `target_master.sheetId` is ever
written. Never write to any register, order, roster, or index sheet.

## WRITE MECHANICS

- Use `spreadsheets.values.update` / `batchUpdate` on `target_master` by row key
  `(fy, team_member)`; upsert (update if the key exists, else append). Never rewrite the whole sheet.
- Stamp `updated_by` (current app user if available, else "app") and `updated_at` (ISO).
- Validate before write: member exists in roster; numbers ≥ 0; reconcile rules pass.
- Concurrency: last-write-wins per row is fine; re-read the row before update to avoid clobbering
  unrelated columns.

## ENDPOINTS
- `GET  /api/targets?fy=2026-27&stateHead=...` → roster rows + any saved targets + computed split.
- `POST /api/targets` `{ fy, rows:[{team_member, ...fields, monthly:{...}}] }` → validates, upserts.
- `GET  /api/targets/split-preview?fy&stateHead&totals{...}` → returns the pro-rata suggestion
  (no write) so the grid can preview before the manager edits.

## ACCEPTANCE
- [ ] Team-member names come only from the roster dropdown; no free-text names.
- [ ] Picking a State Head + entering a total produces a per-member split (pro-rata by prior-year
      actual, equal-split fallback) that the manager can override; members always reconcile to the total.
- [ ] Annual entry auto-derives monthly (÷12); monthly overrides accepted and must sum to annual.
- [ ] All four fields (Primary, Secondary, Direct Dealer, Business Plan) save to the Target Master Sheet.
- [ ] Re-opening the tab loads saved values; edits are incremental upserts, not full rewrites.
- [ ] Only the Target Master sheet is ever written; all other sheets remain read-only.
- [ ] Management Report's Achievement-% columns populate from this sheet once targets are saved.

## WHAT NOT TO DO
- Do not allow typing arbitrary team-member names.
- Do not write to any sheet other than the Target Master.
- Do not store targets only in the app DB — they must live in the Google Sheet (single source of truth).
- Do not let per-member splits or monthly overrides save when they don't sum to their parent total.
