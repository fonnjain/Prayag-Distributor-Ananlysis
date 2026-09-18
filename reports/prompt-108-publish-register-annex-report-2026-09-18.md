# Prompt 108 — publish, register amendments, and annex answer

**Date:** 18 September 2026  
**Production URL:** <https://prayag-sales.com>

## A. Prompt 105 publish and acceptance

### Repository and deployment

- Prompt 105 was already contained in commit
  `299cc3beb02777754d08c6bd342ebdae128decef`, whose commit object was verified
  with `git cat-file -t`.
- That commit was pushed to `origin/main` and was the healthy deployed build
  observed before the Prompt 108 register migration.
- The behavior-changing Prompt 105 content in that commit includes the shared
  API route, frozen Top-80 snapshot and metrics, tests, AI Sales Plan page, and
  navigation. The generic commit subject, `Published your App`, does not
  describe those changes accurately.
- **Source:** local Git object database, `origin/main`, and Replit deployment
  metadata/logs.
- The Prompt 105 shared-computation unit suite passed **5/5**.
- **Source:** Vitest run for
  `artifacts/api-server/src/routes/aiSalesPlanShared.test.ts`.

### Production acceptance result

The deployed retailer-specific acceptance checks do **not** pass with the
current Prompt 105 query, but the production data does contain source-specific
RET# values.

- Production browser navigation to `/ai-sales-plan` reached the live login
  page. The configured bootstrap login returned HTTP 401, so no authenticated
  browser state was claimed as verified.
- **Source:** production browser test against `https://prayag-sales.com`.
- The original Prompt 108 check queried `dealer_id` and `cp_code`:
  - FY2025–26: **379,439** `secondary_sku_line` rows, **0 nonblank
    `dealer_id`**, and **0 nonblank `cp_code`**.
  - FY2026–27: **123,326** `secondary_sku_line` rows, **0 nonblank
    `dealer_id`**, and **0 nonblank `cp_code`**.
- **Source:** production Replit PostgreSQL read replica,
  `secondary_sku_line`, queried on 18 September 2026.

That zero result did not prove RET# was absent. A field-by-field production
query established:

- FY2025–26 Sheets source:
  - `retailer_id` is nonblank on **52,515** rows, but all 52,515 values are
    numeric order serials and **0** match the RET# format.
  - `retailer` matches RET# on all **379,439** rows, representing
    **9,078 distinct RET# values**.
- FY2026–27 PSCode 3 source:
  - `retailer_id` matches RET# on all **123,326** rows, representing
    **6,194 distinct RET# values**.
  - `dealer_id` and `cp_code` are null on all rows.
- **Source:** production `secondary_sku_line`, grouped by `fy` and `source`,
  queried on 18 September 2026.

There was no data change between P44 and the zero query. The columns differed:
P44 counted nonblank `retailer_id`; the zero query counted `dealer_id`. P44's
FY2025–26 wording was itself inaccurate because its 52,515 values are numeric
order serials, not RET#.

The authoritative RET# field is source-dependent:

- FY2025–26 Sheets source: validated RET# from `retailer`;
- FY2026–27 PSCode 3 source: validated RET# from `retailer_id`;
- Product-Wise CRM source: validated RET# from `dealer_id`, also copied into
  `retailer_id` by its loader.

`dealer_id` and `cp_code` were introduced by migration
`075_productwise_secondary_sku_seam` for Product-Wise CRM rows and intentionally
remain null on legacy rows.

Prompt 105 requires non-null `dealer_id`, so it queries the wrong fixed field
for the frozen production populations. Consequently production cannot
currently return a retailer for Tab 1, and these requested states cannot yet
be confirmed on the deployed screen:

1. a retailer with a real STOPPED list;
2. a retailer below the 10-SKU / 3-month threshold with flags suppressed;
3. visible peer basis and cohort size for an actual retailer; or
4. a cohort below five returning unavailable.

The UI and API source do implement those contracts:

- eligibility requires at least 10 prior-year SKUs and three prior-year months;
- ineligible retailers get a Limited history notice and null trend flags;
- peer basis and refined cohort size are rendered;
- peer cohorts below five return `availability: unavailable`.
- **Source:** `AiSalesPlanPage.tsx` and `aiSalesPlanShared.ts`.

This is source verification only, not a substitute for deployed acceptance.
Prompt 105 must use a validated, source-aware RET# expression before Tab 1 can
be accepted. The evidence does not support a production RET# reload.

### Tab 5 frozen state-versus-India basis

- Active snapshot: `top80-prod-2026-09-17`.
- Period: FY2026–27 through **17 September 2026**.
- Frozen membership: **564 codes**.
- Frozen membership value: **₹1,120,023,424.93**, displayed as **₹112.00 Cr**.
- Source population value: **₹1,399,918,651.57**.
- Ranking rule: production `sale_line_current`, `version_status=current`,
  exact `BTRIM(code)`, cumulative amount descending with code tie-break, with
  the boundary code crossing 80% included.
- **Source:** `prompt105-top80-snapshots.json` and frozen
  `prompt105Top80Metrics.ts` state/India metrics.

The deployed browser state was not authenticated, so the visible state table
was not claimed as tested. The frozen configuration and rendering contract are
present in the deployed Prompt 105 commit.

## B. Resolution-register amendments

Migration `124_prompt108_resolution_amendments` was applied and verified in
development, then committed and pushed in behavior-changing commit
`5e16b68901c328fb953c3caaff96fa8c5eec54ab`.

### Applied in development

1. **P4:** removed the WCT-to-WT candidate premise. The row now says
   WCT-3LL-05, WCT-3LL-07, and WCT-3LL-10 need independent MRP entries;
   value at stake **₹12,153,183.03**; priority high.
   - **Source:** development `sale_line_current`, `source=sheets`, through
     17 September 2026, as reproduced in Prompt 107.
2. **P48:** added the colour-aware resolver issue as non-blocking PENDING.
   It records **118** products with ivory prices 10.0%–48.1% above base,
   median **+19.7%**; **107** sold **₹55,584,548.39**; **106 WHITE**, one
   unknown `.`, **0 IVORY**; measurable correction **₹0.00 / 0.00 pp**.
   - **Source:** Prayag authoritative MRP workbook joined to production
     `sale_line_current` through 17 September 2026, as reproduced in Prompt
     107.
3. **P7:** reduced the follow-up to BEA-103A and BS-28; priority low; recorded
   value **₹135,067**. BS-65 is retained only as a two-piece July tail.
   - **Source:** production `sale_line_current` plus the authoritative MRP
     workbook, as reproduced in Prompt 107.
4. **P23:** changed to the 10 August PEA master correction, priority low,
   financial impact **₹0**.
   - **Source:** authoritative MRP workbook plus production/development
     `sale_line_current`.
5. **P3:** classified the **870 codes / ₹110,342,437.59** population into
   **328 steady / ₹51,851,757.65** and
   **542 declining / ₹58,490,679.94**, with **70 discontinued / ₹20.15 lakh**
   kept separate.
   - **Source:** production `sale_line_current` joined to the active MRP
     authority through 17 September 2026; discontinued classification from
     the Drive-reviewed master.
6. **P21:** answered and closed. Codes 20, 25, and 32 are the only three
   `Invalid Input by Prayag` rows and have no sales; recorded impact **₹0**.
   - **Source:** authoritative workbook `excluded_do_not_load` plus
     production/development `sale_line_current`.
7. **P29:** answered and closed. The eight PS codes are absent from all held
   master sheets, not recorded as discontinued, with no FY2025–26 or
   FY2026–27 exact-code sales; recorded impact **₹0**.
   - **Source:** authoritative MRP workbook plus production/development
     `sale_line_current`.
8. **P39:** corrected the false no-booking premise and retained an internal
   check. Ravi Upadhyay has **3 rows / ₹11,405** on 29 May 2026; Shiv Kumar has
   **24 rows / ₹57,883** on 30 May 2026; combined recorded value **₹69,288**.
   - **Source:** development `secondary_order_line`, `person`, and
     `member_targets`, as reproduced in Prompt 107.
9. **P24:** answered and closed. `Unchanged — carried forward` appears on
   **2,175** rows, but **500** carry changed prices, up to **89.1%**.
   - **Source:** Drive/MRP master reconciliation supplied in Prompt 108.

P48 is linked to P26 with `ask-supported-by`. All changes are non-blocking; no
HOLD was created because the current measurable colour correction is zero.

### Production status

Production still showed the pre-amendment open rows when queried before
publish. Publishing commit `5e16b68...` is required to apply migration 124 to
the production Resolution register. Direct production SQL was not used.

## C. Annex population answer

### C1. Population used for the 52 names

The 52 are from the **current development identity population**, not a verified
subset of the frozen historic 130.

- Current breakdown: **19 exact after stripping + 1 strong similarity
  ≥0.80 + 8 possible 0.60–0.79 + 24 weak/no plausible = 52**.
- **Source:** development `retailer_distributor` and `distributor_identity`,
  as recorded in the Prompt 106 and Prompt 107 reports.
- Historic source: Resolution register P30 recorded **399 distributor names,
  130 blank codes, ₹6.52 Cr unattributed** on 14 September 2026.
- **Source:** dated Resolution-register evidence reproduced in Prompt 106 and
  Prompt 107.

There is no evidence that the current 52 were selected by joining back to the
original 130-name annex. They must not be described as “52 of 130.”

### C2. Original 130 versus current identity table

The overlap is **not quantifiable from held evidence** because the exact frozen
130-name/value annex is not retained. Names subsequently coded, merged, or
removed cannot be reconstructed reliably from the current table.

The measurable difference in headline counts is **78 names** (130 historic
blank-code names versus 52 current unresolved names), but that is **not** an
overlap count and must not be presented as one.

### C3. Historic 58-name population

The current overlap is also **not quantifiable** because the exact frozen
58-name list and its roster comparison are not retained.

- The historic aggregate is supported: **25,575 FY2025–26 order-booking rows /
  ₹13.51 Cr** against names absent from the then-current roster.
- **Source:** dated Resolution-register evidence reproduced in Prompt 106 and
  Prompt 107.
- Current reconstruction is unsafe because aliases and off-roll labels changed;
  the current database contains **181 `departed_import` persons**.
- **Source:** current development person registry, as recorded in Prompt 107.

The 52-name distributor list and any reconstructed 58-name staff list should
not be sent to Prayag as confirmation of the original annexes. The required
evidence is the dated frozen 130-name/value extract and the frozen 58-name
roster comparison.