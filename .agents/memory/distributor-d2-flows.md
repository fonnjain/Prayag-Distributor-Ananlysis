---
name: Distributor D2 Flows & Pending
description: Architecture for primary-in / secondary-out flow comparison per distributor in DistributorDeepDive.
---

## Rule
Apply `normDistKey()` to both member-sheet distributor names AND `sale_line.customer` so the two sides always join on the same key. This handles "TRADERS"→"TRADE", "ENTERPRISES"→"ENTERPRISE" etc.

**Why:** The company name in SAP (sale_line) often differs from the spelling in the member working sheet. A shared normalization makes the join robust without fuzzy matching.

**How to apply:** In any code that needs to match a distributor in sale_line, call `normDistKey(customer)` and compare against the distGroup's `normKey`. Do not ILIKE-match raw strings.

## DB query strategy
Three parallel queries per call:
1. `sale_line` grouped by `(customer, monthLabel)` for current FY + headCanon — gives FY total AND closed-months subset from a single round trip.
2. `primary_order_line` grouped by `customer` for current FY + headCanon, filtered `OR(isNull(channel), channel != 'Govt')` — OB excluding institutional.
3. `sale_line` for prior FY, same calendar months, grouped by `(customer, monthLabel)` — for YoY.

Then aggregate in TypeScript using the closedMonths set from `verify_anchors.json` — no extra SQL round trip needed for the closed-month subset.

## Three output states
- `hasPrimaryData=true`: sale_line rows found and fyTotal > 0.
- `hasPrimaryData=false`: normKey not found (or total=0) in sale_line — show "no primary data", never show a zero.
- `flows=null`: DB query threw — UI skips the panel entirely.

## primaryOb nullable
`primary_order_line` may have no rows for a given distributor (e.g. they order via institutional channel, or OB isn't captured for their state head). When null: pendingValue/fillRate are also null, UI shows "--". Do not treat null as zero.

## Only Prasun Chatterjee's member sheet is mapped (Jul 2026)
`config/member_sheet_map.json` has one entry: `"prasunchatterjee" → <sheet_id>`.
Prasun is under **Anant Singh** state head. All other state heads return `membersLoaded: 0`.
Test D2 against `stateHead=Anant Singh` to get live flows data.
