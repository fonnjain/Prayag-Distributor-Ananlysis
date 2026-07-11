# Replit Agent Prompt — FY2026-27 sales via SAP Excel (A–M) + rate-list derivation

> Paste below the line. This wires the new FY2026-27 primary sales pipeline. Google Sheets remain the
> live source for everything except the A–M transaction lines, which come from a SAP Excel export.
> Do not change the other dashboards' sources.

---

## PIPELINE (confirmed with the client)

FY2026-27 sales = **SAP Excel (columns A–M, read directly) enriched by rate-list lookups**:
- **A–M** comes from a SAP export pasted as Excel. The app reads that Excel **directly** and does
  **NOT** write A–M (or anything) back to any Google Sheet.
- **All classification is derived** from the **rate list** Google Sheet
  (`1njO-srsS29qiE4t45-zr5njbB7R2Zb-oSnv2NL1ONY4`), which stays live.
- Older years (FY2024-25, FY2025-26) keep their existing register sources; only FY2026-27 uses this.

**SALE SHEET A–M:** `A Serial · B Invoice No · C Date · D Bill From · E Customer Name · F City ·
G Destination · H Item Code · I Color · J Quantity · K MRP · L Sale Rate · M Taxable Value (net)`.

## STEP 1 — Read the SAP Excel (A–M)

Accept the SAP export as an uploaded `.xlsx` (or a configured path/object-storage key). **Stream it**
(`exceljs` WorkbookReader / `openpyxl read_only`) — do not load whole into memory. Detect the header
by content (row containing `Item Code` + `Taxable Value`). Keep only A–M; ignore anything past M.
Coerce numbers (strip commas). Parse `Date (C)`.

## STEP 2 — Build two cached maps from the rate list (chunked `values.get`, NO files.export)

**`itemMap` from `Sheet1`** (item master; header on row 5). DEDUPE — the sheet is dirty:
- Item Codes repeat; `Purchase Price` conflicts per code; `MRP=Sale Price` often 0; early rows are
  SFG/components.
- Rule: one row per `Item Code`; prefer `Item Type` = FG/traded (skip SFG); first non-empty
  `Item Group` wins. Store `{ itemGroup, itemType, itemCategory, unit }`.
- **Never take cost or MRP from here** (unreliable).

**`custMap` from `Sheet2`** (Customer → State Head master; header row 1:
`Name · station · STATE · head · Payment · GROUP(channel) · contacts`). ~3,116 unique customers.
- Key = **normalized Customer Name**. Store `{ head, state, channel }`.

## STEP 3 — Derive the classification per SALE SHEET row

- **GROUP** = `itemMap[ItemCode].itemGroup` → canonical via `config/group_map.json`
  (`PTMT Finish Goods→PTMT / Faucets`, `SINK FG→Sink`, `SANITARYWARE TRADING→Sanitaryware`, …).
  Unmapped group → log to `unmapped_groups`, bucket as `(unmapped)`.
- **STATE HEAD** = `custMap[norm(Customer)].head`.
- **STATE** = `custMap[norm(Customer)].state` (fallback: normalize City/Destination).
- **channel** = `custMap[norm(Customer)].GROUP` (Retail/Project/Govt).
- **MONTH** = from `Date` → `MMM-YY`; FY from date (Apr–Mar).
- **Value** = use `Taxable Value (M)` (net) for all revenue metrics; do not recompute from MRP.

**Name normalization (both sides):** uppercase, collapse whitespace, strip trailing `(CITY)`/`(STATE)`
parentheses and trailing punctuation, then match. This is required — Sheet2 has names like
`"SANJAY KUMAR GUPTA (DELHI"`, `"Vrinda Distributors (Delhi)"` that won't match byte-for-byte.

## STEP 4 — Institutional buckets (unchanged rule)

`head` ∈ {OTHER, PROJECT, GOVT, GEM, JJM} = channels, not territory heads → bucket as
`Non-territory (Project/Govt/GeM/JJM)`; keep in company totals; never attribute to a person.

## STEP 5 — Unmatched handling (never guess)

- Customer not in `custMap` → `STATE HEAD = "Unmapped (review)"`, add to an **Unmatched Customers**
  list (name + revenue) surfaced in the UI so it can be added to Sheet2. Do not default to a head.
- Item Code not in `itemMap` → `(unmapped)` group + logged.
- Target: customer match > 95% of rows AND > 95% of revenue; log both.

## STEP 6 — Verification (build in)

`GET /api/sales2627/verify`:
- Company FY2026-27 Σ(Taxable Value) for Apr–Jul reconciles to the **State Head Sale register FY26-27
  benchmark ≈ ₹73 Cr** (± a few %). Big gap ⇒ customer-match or group-map problem — surface which.
- Cross-foot: Σ(by group) = Σ(by head) = Σ(by state) = grand total (± ₹1).
- Panel shows: rows read, customer match %, revenue match %, unmatched customers, unmapped groups.

## ACCEPTANCE
- [ ] App reads SAP Excel A–M by streaming; nothing written back to Sheets.
- [ ] GROUP derived from rate list Sheet1 (deduped); STATE HEAD/STATE/channel from Sheet2 by
      normalized Customer match; MONTH from Date; value = Taxable Value.
- [ ] Customer & item matching normalized; >95% match; unmatched listed, never defaulted.
- [ ] Institutional heads bucketed, not attributed to people.
- [ ] FY2026-27 total reconciles to ~₹73 Cr benchmark; cross-foot passes.
- [ ] No `files.export`; rate-list read via chunked `values.get`; other dashboards untouched.
- [ ] Cost/MRP never taken from rate list; margins remain off until a Cost Master exists.

## WHAT NOT TO DO
- Do not write A–M back to any Google Sheet (SAP/Excel is their home).
- Do not infer STATE HEAD from State alone (UP splits R/A; Maharashtra splits) — use the Customer
  master (Sheet2).
- Do not derive cost or MRP from the rate list.
- Do not guess a head for unmatched customers — bucket + list them.
- Do not load the whole Excel or whole rate list into memory; stream / chunk.
