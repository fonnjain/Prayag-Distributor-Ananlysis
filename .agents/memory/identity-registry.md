---
name: Identity registry architecture
description: How member name resolution works; the Ashutosh Kumar collision; normSecKey re-export; sale override from stateDashboard.
---

## Registry module
`artifacts/api-server/src/lib/mgmt/identityRegistry.ts`
- `IdentityRegistry` class — built lazily per FY when deepDiveData first loads
- Stable ID = normSecKey(name) + ":" + normSecKey(stateHead)
- `normSecKey` is now canonical in `names.ts`; re-exported from deepDiveData for backward compat
- Collision detection: normName groups with >1 distinct stable ID → logged at load time
- `resolve(input, context?)` result kinds: `found | ambiguous | not_found`

## Resolution logic (critical — do not simplify)
Two input forms require different handling:
- **Bare name** (inputNsk === inputNn, no parenthetical): "Ashutosh Kumar"
  → Check normName collision group FIRST. If >1 person → Ambiguous even if one has an exact normSecKey match.
- **Specific name** (inputNsk ≠ inputNn, has parenthetical): "Ashutosh Kumar (Rudrapur)"
  → Use normSecKey for exact lookup → Found if unique. Do NOT union with normName (would make specific input ambiguous).

**Why:** "Ashutosh Kumar" bare is inherently ambiguous (could be Sandeep's or Anant's). "Ashutosh Kumar (Rudrapur)" is unambiguous (unique normSecKey "ashutoshkumarrudrapur"). The parenthetical is the disambiguation signal.

## Ashutosh Kumar collision (confirmed)
- "Ashutosh Kumar" under Sandeep Dadheech (Dhanbad) → normSecKey "ashutoshkumar"
- "Ashutosh Kumar (Rudrapur)" under Anant Singh → normSecKey "ashutoshkumarrudrapur"
- `?member=Ashutosh+Kumar` → 400 Ambiguous ✓
- `?member=Ashutosh+Kumar+(Rudrapur)` → sale 2,329,983 under Anant Singh ✓
- `?member=Ashutosh+Kumar&stateHead=Sandeep+Dadheech` → sale 5,979,073 ✓

## Registry integration points
- Built in `deepDiveData.ts: loadAllMembers()` (both DB snapshot and live Sheets paths)
- Exported: `getRegistry(fy)` (sync, null if FY not yet loaded), `loadRegistry(fy)` (async, triggers load)
- Used in: routes/aiPayload.ts, aiReport.ts, mgmt.ts, aiArtifacts.ts (suggestions, travel-plan, performance-review, presentation)
- All 6 member-resolution callers: loadRegistry → resolve → 400 if Ambiguous, normSecKey fallback if registry null

## Sale override (kpis.sale from stateDashboard)
In `deepDiveData.ts: loadDeepDiveData()` — after finding kpis by member key:
- Calls `getCachedStateDashboard(fy)` (sync, no Sheets read)
- Finds matching SecMember by `m.normKey === kpis.normKey`
- Prefers `sdRow.allMonthsSalesReceived` (all months including open) when > 0, else `ytdSalesReceived`
- Overrides kpis.sale when sdSale ≠ kpis.sale
- **Why:** SALEREPORT2627 formula in Data tab may reference only the member's own working-sheet retailers (on-roll only). The state head's SOBR accumulation is the complete secondary register total. Example: Tarun Giri formula reads 1,647,589 (his 54 on-roll retailers); stateDashboard Q1 = 2,558,148 (all secondary buyers). Override improves accuracy. Full 3,295,178 requires July SOBR entry by state head.
- **Override only fires when stateDashboard is cached** (warm after first dashboard load).

## Tarun Giri half-value root cause (REPORTED — no Rahul Singh fix needed)
- SALEREPORT2627 formula for Tarun Giri references only his working-sheet sub-total (54 on-roll retailers, sum = 1,647,589).
- The secondary register has 3,295,178 for him (all retailers buying through his distributor, on-roll + off-roll).
- Rahul Singh's null kpis.sale is CORRECT — his member sheet totalSale = 0, no fix needed.
- Code fix: stateDashboard override (above). Sheet fix: correct the SALEREPORT2627 formula for Tarun's row.

## AiPayload type changes
`performance.sources` and `coverage.sources` added to the AiPayload type in `aiPayload.ts`.
These label every count with its exact sheet source so Claude can cite provenance accurately.

## A4A deck guard fix
`aiArtifacts.ts` line ~727: changed `guardCustom(a4aDeck, payload, null)` to `guardCustom(a4aDeck, payload, memberSummary)`.
This allows per-member figures in the deck (OB, sale, achievementPct per member) to be validated.
