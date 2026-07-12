# Prayag — SALE SHEET 26-27 Import & Derivation Spec

How the FY2026-27 primary sales register is assembled: SAP provides the raw transaction (A–M via
Excel), and the app derives every classification column from the **rate list** Google Sheet. Google
Sheets remain the source for everything except A–M.

---

## 1. Sources (confirmed)

| Part | Source | Notes |
|---|---|---|
| **A–M** (transaction) | **SAP export, pasted as Excel** | app reads the Excel **directly**; does NOT write A–M back to any Google Sheet |
| GROUP + product classification | **rate list `Sheet1`** | item master, keyed on Item Code |
| STATE HEAD / STATE / channel | **rate list `Sheet2`** | **Customer → State Head master**, keyed on Customer Name |
| everything downstream (dashboards, reports) | Google Sheets | unchanged — Sheets is the live source |

**SALE SHEET A–M columns:** `A Serial · B Invoice No · C Date · D Bill From · E Customer Name ·
F City · G Destination · H Item Code · I Color · J Quantity · K MRP · L Sale Rate · M Taxable Value`.

## 2. rate list `Sheet1` — item master (for GROUP)

Header (row 5): `SrNo · Item Code · Item Code(name) · Parameter(Y/N) · Item Group · Item Type ·
Item Category · Unit · Alt Unit · Material Center · Purchase Price · MRP · Sale Price · HSN · GST`.

**Dirty — must dedupe before joining:**
- Item Codes repeat many times (code `101`→5 rows, `105`→5, `111`→5…).
- `Purchase Price` conflicts across a code's rows (`103` = 8.106/47/0/47/92) → **cost is NOT reliable
  here; never derive cost from this sheet.**
- `MRP` = `Sale Price`, both frequently `0` → **do not use these for price;** MRP/Sale Rate come from
  the SALE SHEET itself (cols K/L).
- Early rows are `SFG`/component (`ROD`, KG unit) → prefer `Item Type` in {FG, WASH BASIN, …}, skip SFG.

**Build once, cache:** `itemMap[ItemCode] = { itemGroup, itemType, itemCategory, unit }`
— one row per code: prefer FG, drop zero/SFG noise, first non-empty group wins (group is consistent
across a code's dupes).

**Derive GROUP:** `Item Code (H) → itemMap.itemGroup → canonical group` via `group_map.json`:
`PTMT Finish Goods→PTMT/Faucets`, `SINK FG→Sink`, `SANITARYWARE TRADING→Sanitaryware`, etc.
Unmapped item group → `by_group.unmapped` + log (do not silently bucket).

## 3. rate list `Sheet2` — Customer → State Head master (for STATE HEAD / STATE / channel)

Header (row 1): `A Name(Customer) · B station · C STATE · D head · E Payment · F GROUP(channel) ·
G Party Contact · H State Head Contact`. ~3,133 rows, **~3,116 unique customers** (effectively one
row per customer). `head` (col D) has 20 values = territory heads (RIZVI JI, ANANT SINGH, SANDEEP JI,
PAWAN KUMAR, LALAN, BABU, BIJJU, SUNIL PATEL, SULINDER PAL, …) + institutional (OTHER, PROJECT, GOVT,
GEM, JJM).

**Build once, cache:** `custMap[normName] = { head: D, state: C, channel: F }`.

**Derive per SALE SHEET row (key = Customer Name, col E):**
- `STATE HEAD` = `custMap[norm(Customer)].head`
- `STATE` = `custMap[norm(Customer)].state` (fallback: normalize the SALE SHEET's own City/Destination)
- `channel` = `custMap[norm(Customer)].GROUP` (Retail / Project / Govt) — useful for the institutional split

**Name normalization (both sides) before match:** uppercase, collapse spaces, strip trailing
`(CITY)`/`(STATE)` in parens, strip trailing punctuation. Match on the normalized key.

**No match →** `STATE HEAD = "Unmapped (review)"`, add the customer to a Missing/Unmatched list so it
gets added to Sheet2. **Never guess a head; never default to a person.** Track match rate (target
> 95% of rows and of revenue).

## 4. MONTH & other derived fields

- `MONTH` = from `Date (C)` → `MMM-YY` (e.g. `Apr-26`). FY from date (Apr–Mar).
- `Taxable Value (M)` is the **net** value → use it for all revenue metrics (consistent with the
  net/target basis chosen earlier). Do not recompute from MRP.

## 5. Institutional handling (unchanged rule)

`OTHER / PROJECT / GOVT / GEM / JJM` in `head` are **channels, not territory heads** — bucket as
`Non-territory (Project/Govt/GeM/JJM)`; keep in company totals; never attribute to a salesperson/head.

## 6. Verification / reconciliation

- Company FY2026-27 total (Σ Taxable Value, Apr–Jul) should reconcile to the **State Head Sale
  register FY2026-27 benchmark ≈ ₹73 Cr** (± a few %). Large gap ⇒ customer-match or group-map issue.
- Cross-foot: Σ(by group) = Σ(by head) = Σ(by state) = grand total.
- Report: rows read, unmatched customers (count + revenue), unmapped item groups, match %.

## 7. What the app must NOT do
- Not write A–M (or anything) back to a Google Sheet — A–M lives in the SAP/Excel only.
- Not derive **cost** from the rate list (unreliable); margins wait on a Cost Master.
- Not use rate-list MRP/Sale Price for value; use SALE SHEET K/L/M.
- Not infer STATE HEAD from State alone (UP splits R/A across Rizvi/Anant; Maharashtra splits) — it
  comes from the **Customer** master (Sheet2).
