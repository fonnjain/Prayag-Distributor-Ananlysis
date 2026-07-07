# Prayag Analytics — Data-Layer & Sanity-Check Specification

**Purpose.** Define exactly how the app turns the Google Sheets into its dataset (the
*read → normalize → compute* layer), and how a Claude-based audit independently
re-checks that dataset twice a day.

**Governing rule (from the owner).** The only data seeded into the app is the **channel
network**: distributors, dealers, retailers (+ the state-head mapping). *Everything else —
revenue, quantity, item-wise, regional, coverage, orders, and margin — is derived live from
Google Sheets. Nothing else is typed into the app.*

**Access method.** The app reads sheets with a **Google service account via the Sheets API
(`spreadsheets.values.get`)**, tab/range at a time. This has **no 10 MB cap** (that cap is
only on Drive *export*), so the large registers are readable. Credentials stay server-side.

---

## 0. Source-of-truth catalog

All file IDs already live in `public/file_ids.json`. The ones the data layer needs:

| Role | Source | Key columns / tab | Provides |
|---|---|---|---|
| **Sale register** | `state_head_sales` / `product_itemwise_sales` files (per year) | transaction tab; see §1 schema | Qty, Amount, Sale Rate, Group, Station, State, State Head, Month — the backbone |
| **Order book** | `order_book` files (per year) | monthly tabs `Apr…Mar` | live order pipeline |
| **Rate master** | `rate_list_master` (`rate list`) | see §1 schema | item cost input (needs cleaning — §2.4) |
| **Cost master** *(to create)* | new tab, Sheets | `Item Code → Finished-Good Cost` | the clean cost source for margin (§2.4) |
| **Channel master** | seeded in app (uploaded xlsx) | distributors / dealers / retailers / mapping | resources & coverage denominators |

> The register file titled `…2026-27` currently contains **FY2025-26 rows** (dates `Apr-25`).
> **Never key the period off the file name** — key off the row-level `DATE` / `FY` column.

---

## 1. Observed source schemas (verified against live sheets)

**Sale register — transaction tab.** Header row (note the quirks — match tolerantly):

```
INVOICE NO | DATE | CUSTOMER | CODE | M0NTH | QTY | SALE RATE | AMOUNT |
GROUP | STATION | STATE | STATE HEAD A | TYPE | FY-2025-26
```
- `M0NTH` is spelled with a zero. `STATE HEAD A` has a trailing letter. `FY-2025-26` is a
  data column, not a label. → Do **header-name matching by fuzzy/normalized label or by
  detecting the row that contains `QTY`+`AMOUNT`**, not by fixed cell coordinates.
- `TYPE` holds a coarse bucket (`PTMT GROUP`, `C P GROUP`, `SINK GROUP`, …) but it is
  **unreliable** (e.g. `WASTE PIPE` rows are tagged `PTMT GROUP`). Use the fine `GROUP`
  field as the primary key; `TYPE` only as a fallback.

**Rate master (`rate list`).** Header:
```
SrNo | Item Code | Item Name | Parameter(Y/N) | Item Group | Item Type | Item Category |
Unit | Alt Unit | Material Center | Purchase Price | MRP | Sale Price | HSN/SA No. | GST Category
```
- **Multiple rows per Item Code**, many with `Purchase Price = 0` and/or `MRP/Sale Price = 0`.
- **`Sale Price` = `MRP`** in this sheet (list price). It is **not** the realized distributor
  rate. → The master is a **cost source only**; revenue always comes from the register's
  `AMOUNT`.

**Category GP sheets** (`… Sale Gp Margin …`). **Non-uniform** — do **not** parse with one
rule: e.g. *Sanitaryware* is a per-SKU sale-vs-cost summary with totals in the top row;
*PTMT* is a bill-of-materials costing sheet. Treat these as the human source that feeds the
**Cost Master** tab (§2.4), not as a direct app input.

---

## 2. Normalize layer

### 2.1 Canonical group taxonomy (7 groups — matches the dashboard)

Map the register's fine `GROUP` value → canonical group. Primary key = `GROUP`.
**Any unmapped value must raise an audit flag — never silently bucket it.**

| Canonical group | Register `GROUP` values |
|---|---|
| PTMT / Faucets | `PTMT`, `CISTERN`, `SEAT COVER` |
| CP (Chrome-Plated) | `C P`, `CP ACCESSORIES` |
| Plumbing (Pipes & Fittings) | `CPVC`, `CPVC PIPE`, `UPVC`, `UPVC PIPE`, `SWR`, `HDPE PIPE`, `WATER TANK`, `GARDEN PIPE`, `AGRI` |
| Sink | `SINK` |
| Sanitaryware | `SANITARYWARE` |
| Connection / Waste | `WASTE PIPE`, `CONNECTION` |
| Hardware | `HARDWARE` |

Maintain this as a lookup table in config (not hard-coded in logic) so new codes are a
one-line edit. Trim/upper-case before matching.

### 2.2 State-head normalization

- Upper-case and collapse whitespace: `Sandeep ji` ≡ `SANDEEP JI`. There are **11 heads**
  (per the mapping file).
- **`PROJECT`, `OTHER`, `GOVT` are NOT state heads** — they are institutional / project /
  government channels. Keep them as explicit separate buckets so they neither inflate a head
  nor get dropped. Report them as their own line ("Non-territory / Project / Govt").
- Maharashtra is split by name (`MAHARASTRA L` = Lalan, etc.) per the mapping file's
  Maharashtra-resolution logic — reuse that map.

### 2.3 State normalization

Register `STATE` is dirty: `W-BENGAL`, `UP ( R )`, `MAHARASTRA L`, mixed case, plus channel
tokens (`PROJECT`, `GOVT`, `OTHER`). Map to the canonical state list in the mapping file;
route channel tokens to the non-territory bucket (2.2). Unmapped states → audit flag.

### 2.4 Cost source — build ONE Cost Master (the key decision)

There is **no clean cost-per-code source today**: the rate master's `Purchase Price` has
several conflicting values per code (component vs finished-good, many zeros), and reliable
finished-good cost is scattered across the non-uniform GP sheets.

**Recommended:** maintain a single **Cost Master** tab in Sheets:
```
Item Code | Finished-Good Cost (₹/unit) | Cost as-of date | Source (BOM/GP/manual)
```
Populate it from the GP sheets' `PUR RATE 2026-27` / BOM. This keeps the "everything from
Sheets" rule (it's a sheet, not app input) and makes cost unambiguous and auditable.

If instead you clean the rate master directly, the rule is: **finished goods only**
(`Item Type = FG`), drop `Purchase Price = 0`, dedupe to one row per code (latest non-zero),
and expect **low coverage** — which the audit will surface as risk.

### 2.5 Rate-master cleaning (still useful for classification / MRP)

Even with a Cost Master, dedupe the rate master to one row per `Item Code` for group/MRP
lookup: group by `Item Code`, drop zero-only rows, prefer `Item Type = FG`, take the latest
non-zero. Record how many codes survived (coverage %) — an audit input.

---

## 3. Compute layer (canonical outputs)

All figures derived; none entered. Mirror the existing `prayag_data.json` shape so the
dashboard is unchanged. Core derivations, all from the **register** unless noted:

- **Revenue / item-wise / by-group / by-state-head / by-station(state)** = `SUM(AMOUNT)` and
  `SUM(QTY)` grouped accordingly, filtered to the target period by row `DATE`.
- **Coverage** = distinct Station/State/District/City touched (register) against the channel
  master (seeded) for reach vs. potential.
- **Orders** = order-book monthly tabs.
- **Gross margin** = `SUM(AMOUNT) − SUM(QTY × Cost[Code])`, where `Cost` = Cost Master
  (§2.4). Report **cost coverage %** = share of revenue whose codes have a valid cost —
  margin is only trustworthy on the covered portion.

Emit, alongside the dataset, a small **`build_meta`** block the audit consumes:
```json
{
  "period": "FY2026-27 / Apr..Jun",
  "rows_read": 41250, "rows_dropped": 118,
  "grand_total_amount": 784300000,
  "cost_coverage_pct": 0.81,
  "unmapped_groups": [], "unmapped_states": [], "unmapped_heads": [],
  "generated_at": "2026-07-07T06:00:00Z"
}
```

---

## 4. Sanity-check layer (three layers)

### Layer A — Production pipeline
The read→normalize→compute above. Produces the dataset + `build_meta`.

### Layer B — In-code reconciliation (exact, free, every load; this is the GATE)
Deterministic invariants, run in code — **the LLM is never the calculator here**:

1. **Cross-foot:** Σ(group amounts) = Σ(state-head amounts) = Σ(station amounts) =
   `grand_total_amount` (within ₹1 rounding).
2. **No leakage:** `rows_read − rows_dropped` = rows actually aggregated.
3. **Mapping completeness:** `unmapped_groups/states/heads` all empty.
4. **Sign/sanity:** no negative Qty/Amount unless flagged as returns; margin per line not < −X%.
5. **Cost coverage:** `cost_coverage_pct ≥ threshold` (e.g. 0.75).
6. **Period integrity:** every row's `DATE`/`FY` falls in the intended period.

Any hard failure blocks publish and pages you. Passing gates go to Layer C.

### Layer C — Claude audit (2×/day, independent second opinion + judgment)
The app POSTs a compact payload to a new `/api/audit`. Claude **re-derives the headline
numbers from the raw-ish inputs** and compares to the app's outputs, then interprets.

**Audit request (app → Claude):**
```json
{
  "build_meta": { ...as above... },
  "app_outputs": {
    "by_group":  [{"group":"PTMT / Faucets","amount":...,"qty":...}, ...],
    "by_head":   [{"head":"Sandeep ji","amount":...,"partners":...}, ...],
    "margin_by_group": [{"group":"Sanitaryware","revenue":...,"cost":...,"gp_pct":0.378}, ...]
  },
  "raw_rollup":        "<CSV: Code × Head × Group × Month → SUM(Qty), SUM(Amount)>",
  "raw_rate_master":   "<CSV: deduped Item Code → Purchase Price, MRP, Item Group>",
  "cost_master":       "<CSV: Item Code → Finished-Good Cost>",
  "register_sample":   "<20 random raw register lines, all columns>",
  "group_map": { ... §2.1 table ... },
  "prev_snapshot": { "by_group": [...], "cost_coverage_pct": 0.83 }
}
```
Guardrails: send **rollups, not raw lines** (group×head×month is tiny; code-level is a few
thousand rows — fine). Cap `register_sample` at ~20 rows. The rate master (~few thousand
deduped rows) is sendable once per run.

**What Claude does:**
1. **Independent recompute** — from `raw_rollup`, recompute by_group / by_head totals and
   grand total; from `raw_rate_master`/`cost_master` re-derive cost coverage; recompute
   margins. Compare to `app_outputs` within tolerance (e.g. 0.5%).
2. **Mapping spot-check** — apply `group_map` to the 20 `register_sample` lines and confirm
   the app's group/head/cost join matches.
3. **Soft anomalies** — margin outliers (e.g. category GP swing >X pts vs `prev_snapshot`),
   cost-coverage drop, revenue trend break, new codes/groups not in the map, a state head
   collapsing to ~0.
4. **Root cause, in English** — which sheet/tab/column to inspect.

**Audit response (Claude → app):**
```json
{
  "status": "pass | warn | fail",
  "recompute_match": true,
  "checks": [
    {"name":"grand_total_recompute","result":"pass","app":784300000,"claude":784300000,"delta_pct":0.0},
    {"name":"cost_coverage","result":"warn","value":0.71,"threshold":0.75}
  ],
  "anomalies": [
    {"severity":"medium","what":"Sanitaryware GP fell 37.8%→31.2% vs last snapshot",
     "likely_cause":"cost rows changed for codes 4381/4463/4254 without a sale-rate update",
     "inspect":"Sanitaryware GP sheet / Cost Master rows for those codes"}
  ],
  "summary_for_human": "Totals reconcile. One margin regression and a cost-coverage dip to review."
}
```
`fail` or unresolved `warn` → notify (email/Slack). Persist each response as the next run's
`prev_snapshot` for drift detection.

**Model.** Use `claude-sonnet-5` (or the configured `ANTHROPIC_MODEL`) for the audit — the
reasoning is light; the value is judgment + reconciliation, not heavy generation.

### Scheduling
Two runs/day via **Replit Scheduled Deployment / cron** (e.g. 06:00 and 18:00 IST) hitting an
internal `/cron/audit` route that runs Layer A→B, then POSTs Layer C, stores the verdict, and
alerts on `warn`/`fail`. Keep the analyst panel (`/api/analyze`) separate from `/api/audit`.

---

## 5. Build order (suggested)
1. Read layer + header-tolerant parser (§1) → raw rows.
2. Normalize (§2) incl. group/state/head maps + Cost Master.
3. Compute (§3) + `build_meta`.
4. Layer B invariants (§4B) as the publish gate.
5. `/api/audit` + Claude contract (§4C).
6. Cron 2×/day + alerting (§4 scheduling).

## 6. Open items to confirm before coding
- Which **tab** in each register file holds the transaction rows, and whether **FY2026-27**
  data exists yet (the 26-27 file currently shows 25-26 rows).
- Ownership + refresh cadence of the **Cost Master** tab.
- Alert channel (email vs Slack) and the numeric **thresholds** (cost coverage, margin-swing,
  reconcile tolerance).
