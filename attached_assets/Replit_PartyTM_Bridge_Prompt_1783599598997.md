# Replit Agent Prompt — Wire the Party → Team Member bridge into the Management Report

> Paste below the line. This adds the missing link that lets per-member **Sale** columns fill.
> It builds on the existing report engine; do not change tabs/layout — only fill more cells.

---

## WHY

The sale register tags each sale to a **State Head + Customer (a distributor)** — not to a team
member. So per-member Sale columns were blank. The fix is a **Party → Team Member bridge**: a map
of which distributor/retailer belongs to which member. That ownership lives in each per-member
working file (folder **"STATE HEAD (Team Member Report)"**, id `1-guQptN9S4NrW024jGizKo0V4nFDtHMv`),
in two tabs per file: **"Distributor Visit Report 26-27"** (DIST# rows) and **"Retailer Report
26-27"** (RET# rows). Both embed **Team Member Name** + **Reporting Manager (=State Head)** in their
top rows.

## TASK 1 — Build the bridge source (`Party TM Map`)

Support BOTH inputs; config `party_tm_map.sheetId`:
- **If a `Party TM Map` sheet exists**, read it. Columns:
  `Party Type | Party ID | Party Name | Team Member | State Head | Channel Type | Assigned Distributor | Source File`.
- **Else auto-build it**: walk the "STATE HEAD (Team Member Report)" folder tree; for every
  spreadsheet that HAS a "Distributor Visit Report" or "Retailer Report" tab, read those tabs via
  chunked `values.get` (NO `files.export`), pull `Team Member Name` + `Reporting Manager` from the
  top band, and emit one row per DIST#/RET#. De-dupe on `(Party ID, Team Member)`. Cache the result
  to a `Party TM Map` sheet so it isn't rebuilt every run (rebuild on demand / daily).

Header rows drift — detect by content (`ID`/`Retailer ID` + `Name`), tolerant of the "26-27" suffix.
Skip rows where Party ID is blank/`--`/`TOTAL`.

## TASK 2 — Normalise names before joining (critical)

State-head and member names differ across sources. Apply the app's existing head-normalisation map
and extend it so bridge names match the roster/register, e.g.:
`Aqil Rizvi / RIZVI JI → Syed Aqil Rizvi` · `Biju C.O → Biju C.O` · `Sandeep Dadheech → Sandeep ji`
(align to whatever the roster/register canonical is). Team Member names: trim, collapse spaces,
case-insensitive. Log any bridge member/head that doesn't match the roster.

## TASK 3 — Join to fill per-member SALE columns

The register row has `Customer` (a distributor). Match it to the bridge:
1. **Preferred:** if the register carries the distributor **code/ID**, join on `Party ID` (DIST#).
2. **Fallback:** fuzzy-match register `Customer` name → bridge `Party Name` (normalise case,
   punctuation, trailing `(CITY)` suffixes like `LOHIA & SONS (GHAZIABAD)`).
Then attribute that line's `Amount` to the matched **Team Member** and fill:
`Sale Report 26-27` (Σ Amount) · by-group/segment split · Q1–Q4 · `Sale 25-26` (prior-year block).

Order columns already come from Secondary Order Booking (has Team Member) — keep those; use the
bridge's RETAILER rows only to validate/fill retailer census where the order file is thin.

## TASK 4 — Reconcile (acceptance gate)

For each State Head: **Σ(members' Sale Report via bridge) must equal the head's register total (± ₹1).**
Anchor: **Anant Singh FY2026-27 = ₹2.57 Cr** — his members must sum to that. Any register `Customer`
that doesn't match the bridge → attribute to an **"Unassigned (Head)"** bucket per State Head and
**list it in the Missing Data tab** (never silently drop, never fabricate a member).

## HANDLE THESE REAL DATA ISSUES

- **"via retailer assignment" distributors** (in the starter) are inferred and NOT authoritative —
  always prefer the member's actual "Distributor Visit Report" tab for distributor→member ownership.
- One distributor can appear under multiple members across files → if a `Party ID` maps to >1 member,
  flag the conflict in Missing Data and use the most-recently-modified source file; don't guess.
- Register `Customer` names carry city suffixes and casing noise — normalise before fuzzy-match; log
  match rate (target > 90% of revenue matched).
- FY2026-27 is partial (July incomplete) — populate months present; never annualise.

## ACCEPTANCE
- [ ] `Party TM Map` builds (or reads) with rows for the members present; log members/heads covered.
- [ ] Per-member `Sale Report 26-27` populates on the Data tab via the bridge.
- [ ] Anant Singh's members reconcile to **₹2.57 Cr** (± ₹1); other heads cross-foot too.
- [ ] Register customers with no bridge match go to "Unassigned (Head)" + Missing Data, with the
      matched-revenue % logged (> 90% target).
- [ ] Head/member names normalised so bridge ↔ roster ↔ register align (zero unmatched heads).
- [ ] No `files.export`; all reads chunked `values.get`. No tab/layout change.

## WHAT NOT TO DO
- Do not attribute unmatched sales to a random member — bucket as "Unassigned (Head)".
- Do not trust "via retailer assignment" distributor rows over a real Distributor Visit tab.
- Do not rebuild the bridge from ~180 files on every report run — cache it.
- Do not infer FY from a file name; filter on the FY column (registers hold two years).
