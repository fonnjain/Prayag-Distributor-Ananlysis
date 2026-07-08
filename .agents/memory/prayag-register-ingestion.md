---
name: Prayag invoice-line register ingestion
description: Non-obvious rules for ingesting the State Head Sale registers (xlsx + live Sheets) into sale_line without breaking uid stability or quota.
---

## line_uid stability (hard-won)

Rule: `line_uid = fy|month_label|customer|code|qty|sale_rate|amount|occurrence`. Invoice number is EXCLUDED.

**Why:** The FY25-26 prior-year block inside newer register files has no invoice column, while the live Sheets register does. Including invoice_no made xlsx and Sheets produce different uids for the same line (176k mismatches). Excluding it, all 176,315 live uids matched the xlsx backfill exactly.

**How to apply:** Never add invoice_no (or any column absent from one source) to the uid. The occurrence counter must run over ALL rows in source order (both FY blocks) BEFORE any fy filter — filtering first changes occurrence numbers and breaks idempotency.

## Month year comes from FY, not the date cell

`month_label` (e.g. Apr-26) derives its year from the FY column, because register date cells are inconsistent across blocks. Deriving from the date produced cross-FY collisions.

## Guardrail: blank source cells vs normalization loss

The sum-consistency guardrail must distinguish two null-canon cases: raw value present but canon null = normalization dropped a bucket → FAIL; raw itself blank = upstream data-entry gap → bucket as "(blank)" (SQL NULL-group semantics) and pass.

**Why:** The FY26-27 register has a handful of rows with genuinely blank head/state cells (one customer, ₹10k of ₹73 Cr). Hard-failing on those would block every future sync over an upstream gap the pipeline cannot fix.

**How to apply:** Never make an ingestion guardrail fail on conditions already present in accepted historical data unless it is an actual pipeline defect.

## Verification invariants

- xlsx source rows = DB rows WHERE source='xlsx_backfill'; sheets-verify backfills use source='sheets_verify_backfill'.
- FY24-25 grand total must stay exactly 3,417,311,917; FY26-27 register: 176,315 rows.
- Comparing sources: 0.5% delta threshold; anything above is flagged, never auto-corrected.
