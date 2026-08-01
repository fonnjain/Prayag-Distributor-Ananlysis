# QA Report — Glossaries v2 + QA Reference vs Application
*Run 1 August 2026, ~09:30–09:45 IST. DB and API compared against `QA_Reference_Detailed.md` (built earlier the same day) and the four glossary v2 documents (G1–G4).*

---

## 1. Frozen closed years — PASS (exact)

| FY | Reference | Database | Result |
|---|---|---|---|
| 2023-24 | 137,619 rows · ₹349.02 Cr | 137,619 · ₹349.02 | ✅ exact |
| 2024-25 | 141,201 rows · ₹341.14 Cr | 141,201 · ₹341.14 | ✅ exact |
| 2025-26 | 145,613 rows · ₹361.00 Cr | 145,613 · ₹361.00 | ✅ exact |

No writes to frozen years. Freeze guards intact.

## 2. FY2026-27 primary sale, month-wise

| Month | Ref rows / ₹ Cr | DB rows / ₹ Cr | Result |
|---|---|---|---|
| Apr-26 | 5,542 / 13.11 | 5,542 / 13.11 | ✅ exact (also invoices 1,012, customers 214) |
| May-26 | 11,812 / 28.28 | 11,812 / 28.28 | ✅ exact |
| Jun-26 | 12,868 / 31.43 | 12,868 / 31.43 | ✅ exact |
| **Jul-26** | 11,454 / 25.90 | **11,848 / 27.36** | ⚠️ see §7 — **the live sheet itself now holds 11,848 / ₹27.36** |

Period roll-ups (API `/api/mgmt/data`):
- Q1 (Apr–Jun): **₹72.81 Cr** ✅ (cross-check #1)
- YTD (Apr–Jul): ₹100.17 Cr vs reference ₹98.71 — difference is exactly July (§7)
- Month filter (Jul only): ₹27.36 — matches DB and live sheet

## 3. FY2026-27 primary order booking — PASS

| Month | Ref ₹ Cr | App ₹ Cr |
|---|---|---|
| Apr | 15.73 | ✅ |
| May | 29.37 | ✅ |
| Jun | 32.65 | ✅ (Q1 total ₹77.76 booking via API) |
| Jul | 32.56 | ✅ (month filter returns 32.56) |
| **YTD** | **110.32** | **✅ 110.32 exact** (cross-check #3) |

Note: the DB copy `primary_order_line` is stale (last ingested 20 Jul, July only ₹9.25 Cr) — **the app reads OB live from the Order Sheet, so no user-facing fault**, but the DB mirror should not be used for OB analytics until re-synced.

## 4. Dimensional breakdowns (FY2026-27 sale)

- **By State Head:** matches the reference ranking and totals within rounding + the July delta: SANDEEP JI 52.69 (ref 51.80 + July delta), RIZVI JI 17.81 (17.78), ANANT SINGH 3.05 ✅, GEM 1.04 ✅, JJM 0.01 ✅, NARENDRA SHARMA 0.05 ✅. All 16 heads present, no unmapped heads (sync log: `unmappedHeads: 0`).
- **By product group:** ordering matches (CP ≈ 24.35 incl. CP Accessories mapping, PTMT 23.66, CPVC 10.66 ✅ exact, SWR 7.25 ✅, UPVC 6.36 ✅, Sanitaryware 5.19, Water Tank 4.86, Sink 4.79, Cistern 3.12). Differences beyond July's delta come from canon-vs-raw group naming (`group_canon` merges CP Accessories into CP), which the glossary sanctions — `group_canon` is the authority, Unmapped bucket is zero ✅.
- **Non-territory channels** (PROJECT/GOVT/GEM/JJM/OTHER) ≈ ₹7.3 Cr, consistent with the reference's ₹7.09 + July delta; excluded from territory views per G2/G3 ✅.

## 5. FY2026-27 secondary (State Head Dashboard)

| Check | Reference | App | Result |
|---|---|---|---|
| Q1 Plan | ₹82.60 Cr | ₹82.60 | ✅ |
| Q1 OB | ₹57.70 Cr | ₹57.70 | ✅ (cross-check #5) |
| Q1 Sales Received | **₹62.86 Cr** | **₹63.09** | ⚠️ see below |
| Jul (month filter) | plan ₹26.02, no actuals | plan ₹27.59, OB 0.08, sales 0.00 | ⚠️ plan differs ₹1.57 — sheet moved intraday; OB/sales correctly near-zero |
| Members | 162 SOBR rows | 162 (row-completeness check passed in logs) | ✅ |

**Sales Received is not period-scoped.** The API returns ₹63.09 Cr for FY, Q1 and YTD alike. This is partly by design (the earlier decision: gross "all received" total vs achievement ratio are separate), and the State Head page labels it "Apr–Jul". But on the Secondary Performance page a Q1 selection shows a Q1 plan (₹82.60) beside an all-months Sales Received (₹63.09) — mixed bases in one tile row. Flagged as a follow-up.

## 6. Cross-checks (reference Part 9)

| # | Check | Result |
|---|---|---|
| 1 | Q1 sale ₹72.81 | ✅ |
| 2 | Apr–Jul sale ₹98.71 | ⚠️ ₹100.17 — July source moved (§7) |
| 3 | OB ₹110.32 | ✅ exact |
| 4 | Pending never negative | ✅ (Apr 2.63✅ via月 filters; YTD ₹10.15 vs ref ₹11.60 — same July cause) |
| 5–7 | Secondary Q1 OB / Sales / Ach | OB ✅ · Sales ⚠️ (63.09 vs 62.86) · Ach follows |
| 8–9 | Monthly sums = YTD | ✅ internally consistent |
| 11–13 | Frozen years | ✅ all exact |

## 7. The July ₹1.46 Cr "deviation" — resolved as SOURCE MOVEMENT

The reference (Part 11) predicted the app was ₹1.46 Cr high on July and said the DB should hold 11,454 rows. Following the reference's own rule ("re-read the source before treating any difference as a bug"), a **force-resync was run at 09:36** — it re-read the live `SALE SHEET 26-27` July tab and got **11,848 rows / ₹27.36 Cr from the sheet itself** (sync log: `rowsWritten: 11848, amountCr: 27.36`). The DB, API and sheet are now in exact agreement.

**Conclusion: the sheet gained/regained ~394 rows / ₹1.46 Cr between the reference snapshot and 09:36.** Either the cleanup the reference observed was reverted, or new July invoices were entered on 1 Aug. DB-side analysis found only 3 near-duplicate rows (₹0.00 net extra) — the 394-row difference is invoice-dated 29–31 Jul and appears to be genuine late entries, not residual cleanup rows.

**Decision (1 Aug 2026): the authoritative source is the live SALE SHEET 26-27.** The app must match whatever the sheet holds at freeze time. Data owners will review the sheet before 7 Aug and remove any rows that should not be there; a force-resync must be run immediately after any sheet edits so the DB reflects the final state before the freeze guard activates.

### July freeze checklist (complete before 7 Aug 2026)

1. **Data owners:** open `SALE SHEET 26-27` → July tab and verify the row count is correct.
   - If rows need to be removed: delete them in the sheet, then run `POST /api/registers/2026-27/force-resync`.
   - If the sheet is correct as-is (11,848 rows / ₹27.36 Cr): no action needed — nightly sync will keep the DB aligned until the freeze.
2. **After any sheet edit:** confirm the API returns the expected figure:
   ```
   curl "$API_BASE/api/mgmt/data" | jq '.months["jul-26"]'
   ```
3. **On or before 7 Aug:** the month freeze guard will lock July automatically. Verify `frozen_months` in the sync log includes `jul-26`.

Pending ₹10.15 vs ₹11.60 and YTD ₹100.17 vs ₹98.71 are the same single fact — both will resolve once July is finalised in the sheet.

## 8. Glossary-conformance spot checks (G1–G4)

| Rule | Status |
|---|---|
| NET = Taxable/Sub Total, never Order Total | ✅ register ingests col M/TAXABLEVALUE |
| SOBR TOTAL row #REF! in K–S | ✅ app reads members rows + row-completeness check passed |
| Zero-target members → "no target recorded", never 0% | ✅ State Head page shows "40 no target" beside Members |
| Headcount not period-scoped (181) | ✅ shown as 181 with the no-target count moving |
| Achievement = Sales Received ÷ Plan, own tile | ✅ Sales Received has its own tile; Achievement labelled "Sales Received ÷ Plan" |
| Primary YTD Apr–Jul vs Secondary Apr–Jun, each card states its range | ✅ State Head tiles carry per-card ranges (Apr–Jul / Apr–Aug as applicable) |
| Frozen months guard | ✅ resync skipped Apr/May/Jun as `frozen-skipped` |
| G1/G4 band conflict (Correction 4: one band set on both pages) | ⚠️ not yet verified in code — follow-up |

## 9. UI period-labelling fixes shipped in this session

User-reported gap: headings and tile descriptions did not state the selected period.
- **Primary Performance**: heading now shows `· FY <fy> · <period>`; each KPI tile (Order Booking / Sale / Pending) shows `FY <fy> · <period>` or `FY <fy> full year` when the period filter cannot apply. Verified in preview: "Primary Performance · FY 2026-27 · YTD (Apr–Jul)".
- **Secondary Performance**: same treatment on the heading and all four tiles (Plan / Order Booked / Sales Received / Achievement).
- State Head page already carried per-tile ranges; Overview is intentionally YTD-only and says so under the FY selector.

## 10. Verdict

Data layer: **all anchors exact** except July FY2026-27, which will be finalised by data owners in the sheet before the 7 Aug freeze (checklist in §7). Application periods (month / quarter / YTD / full-year) filter correctly on primary sale and OB; secondary Sales Received is the one figure that ignores the period filter (partly by design — needs an explicit label or scoping). UI now states the selected period in headings and tiles on both performance pages.
