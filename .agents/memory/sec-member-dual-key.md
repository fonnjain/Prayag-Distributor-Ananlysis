---
name: SecMember dual-key design
description: SecMember carries two separate key fields for DB uniqueness vs roster join; mixing them silently drops secondary data for disambiguated members.
---

## The rule

`SecMember` has two distinct keys — never use one where the other is needed:

| Field | Computed by | Purpose |
|---|---|---|
| `normKey` | `normSecKey(rawName)` — keeps parentheticals | DB `head_canon` column; unique per person in `secondary_head_month` |
| `joinKey` | `normName(rawName)` — strips parentheticals | Roster join in `mgmt.ts` / `targets.ts`; aligns with `RosterMember.normKey` |

`normSecKey` keeps `"Ravi (Faridabad)"` → `"ravifaridabad"` so two people with similar names are stored as separate DB rows.  
`normName` strips parentheticals → `"ravi"` so it matches the roster's own normKey (which also uses `normName`).

## Where each key is used

- **DB persistence** (`stateHeadLoader.ts`): `member.normKey` → `head_canon`
- **secByKey Map in `mgmt.ts`**: build with `sm.joinKey` (first-entry wins); look up with `r.m.normKey` (roster key)
- **secPlanByKey Map in `targets.ts`**: build with `sm.joinKey`
- **primaryRoleKeys** (`stateDashboard.ts`): built with `normName` (not normSecKey) — already aligned with roster

## Why

Before the split, `normKey` was `normSecKey` but the roster join used `secByKey.get(r.m.normKey)` with a normName-based roster key. The lookup silently returned `undefined` for every member whose secondary-sheet name contained a parenthetical disambiguator, causing those members to appear without secondary data in the management report.

## ytdPlanSum denominator note

Left members excluded from `ytdSalesSum` (numerator) are now included in `ytdPlanSum` (denominator) via `m.ytdPlan ?? m.businessPlan`. In practice, FY2025-26 left members have null businessPlan cells in the sheet, so the ratio is unchanged for that FY. The fix matters for FYs where left members do have a plan column populated.
