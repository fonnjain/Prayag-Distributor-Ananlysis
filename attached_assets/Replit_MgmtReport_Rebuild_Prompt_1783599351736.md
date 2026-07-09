# Replit Agent Prompt — Rebuild the Management Report engine from the REAL source recipe

> Paste below the line. This supersedes the earlier "fix Secondary Order Booking" prompt.
> Do not change the report's tabs/columns/layout — only how the cells are filled.
> The engine's current output is ~90% empty because it wired ONLY the roster and skipped the three
> sources that actually carry the numbers. Wire all of them, in the order below.

---

## THE TRUE ARCHITECTURE (this is how Prayag builds the report by hand)

The report is **per Team Member**, rolled up to **State Head**. It draws from FOUR live sources:

1. **State-Head workbooks** — one per head, e.g. `Anant Singh JI 2026-27`
   (`1G3z_gOk5JR8yFmcVCadFCgpltjY1y0pI4ZBmGwrF2pU`). Each is the **dispatched-sale register filtered
   to that head**, holding **two fiscal years**. Columns (no header row in some; detect by content):
   `Invoice, Date, Customer(party), Code, Month, Qty, Rate, Amount, Group, Station, State,
   State Head, Type(group bucket), FY, FY`. → the **Sale** side.
2. **Secondary Order Booking Segment Wise** (`1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80`,
   folder `1Ww2B1FKjpshRTcOa_F7OUBiBsBzpVCPZ`). SFA app **order** export carrying **Team Member
   Name** + **Retailer Id** + Segment + Order Value + Distributor. → the **Order** side + retailer census.
3. **Party → Team Member bridge** (NEW — see "Bridge" below). Maps each register `Customer`(party)
   to the owning Team Member, so Sale splits from State-Head grain down to member grain.
4. **Team Member Details** (`1Nb8gRcdzY-iambAzwExTmeVY_ob6vnQ2`) — roster spine: Name, State,
   **Reporting Manager (=State Head)**, HQ. ~180 members, 12 heads.

Plus **Target Master** (consolidated targets) for Achievement %; and leave SFA-visit / CTC / T.A.
blank (no source).

## STATE-HEAD WORKBOOK REGISTRY

Discover the per-head workbooks from the **"State Heads"** Drive folder (the parent of
`Anant Singh JI 2026-27` is `1xjBSMrF43omlScNQTavwunSt2oQbtGrq`). Match one workbook per head per FY
by title (`<Head> ... <FY>`). Build a config map `state_head_workbooks[head][fy] = fileId`. Read the
transaction tab via chunked `values.get` (NO `files.export`); filter rows on the **FY column**
(each file holds 2 years). Do not infer FY from the file name.

## BRIDGE: Party → Team Member (the make-or-break artifact)

The register is tagged to **State Head + Customer(party)**, not to a team member. To fill per-member
Sale columns you need a bridge. Implement in this priority:
1. If a consolidated sheet **`Party TM Map`** exists (cols `Party/Customer | Team Member | State
   Head`), use it. (RECOMMEND the client create this; it's the one missing artifact.)
2. Else, derive it from the per-member working files (e.g. `Copy of <Name>` → their `Sale Report`
   tab lists that member's parties). Build `party → member` from those.
3. Else (no bridge yet): fill Sale columns at **State-Head grain only**, put per-member Sale = blank,
   and add "Party→TM bridge missing" to the Missing Data tab. **Do not guess** an allocation.

Validation: for each head, **Σ(members' Sale Report) must equal the head's register total** (± ₹1).

## COLUMN → SOURCE (fill exactly these; keep the rest blank + listed)

**Sale side — from State-Head workbook, per member via bridge:**
- `Sale Report 26-27` = Σ Amount (FY26-27) · split by `Group→segment` (INDEX map
  `1g-4_lDCeXQfUmp-VQ_mEWXQJyLMJXUGmRwGgughYHFY`) · `Q1–Q4` from Date · `Sale 25-26` from the
  FY-2025-26 block in the same workbook.

**Order side — from Secondary Order Booking, per member (Team Member Name):**
- `Order Booked` (+ monthly Apr→Mar split from Date) · `No of Orders` (distinct Order ID) ·
  `Total/New/Old Retailers` (distinct Retailer Id; new = first-ever order in FY across all years) ·
  `Old/New Party Order Booking` (Σ Order Value) · `Business Achived By No. of Old/New Parties` ·
  `Business Achieved By` (Σ Order Value) · `Business Per Retailer` (÷ Total Retailers) ·
  `Direct Dealer` split (Distributor/dealer flag; blank+note if no flag).

**Targets — from Target Master (or per-member Plan tab):**
- `Primary/Secondary/Monthly Target`, `Business Plan`, and every `Achievement %` = actual ÷ target.
  If Target Master empty → these stay blank + listed (do NOT zero them).

**Roster:** `State Head, Name, State/Working State, HQ, DOJ, Active/Left`.

**No source → blank + Missing Data (never 0):** all visit/lead/GPS/working-day columns, `CTC`,
`T.A. Bill / Cost Ratio`.

## HEADER / NORMALISATION RULES (reuse existing)

- State-Head workbooks & registers: detect header by content; `Group` is the category key (the
  `Type` bucket is unreliable). Canonical group + head + state maps already in config.
- Secondary Order Booking: header names drift across years (`Retailer Id`↔`ID`,
  `Team Member Name`↔`Team member`); detect by content; forward-fill repeated header cells within a
  multi-line order.
- Join Order Booking → roster on **Team Member Name** (normalise case/spaces); log unmatched names.
- FY2026-27 is partial (data ends early July) — populate months present; never annualise/back-fill.

## FAIL-LOUD ON SOURCE ERRORS

For every source, on failure surface the real reason (403 = not shared with the service account,
404 = wrong id, parse error) in the run log **and** the Missing Data tab — never silently write
"source needed". If 403/404, tell the user which file id + the service-account email to share.

## ACCEPTANCE (must pass)

- [ ] Run log shows rows read > 0 from: at least one State-Head workbook, the Secondary Order
      Booking file, and the roster — all via chunked `values.get`, no `files.export`.
- [ ] `Data` tab: order columns (`No of Orders, Total/New/Old Retailers, Business Achieved By,
      Order Booked`) populate per member; sale columns populate per member IF a bridge exists, else
      per State Head with a Missing-Data note.
- [ ] **Cross-foot:** for Anant Singh, Σ(members' Sale Report) = **₹2.57 Cr** (his FY26-27 register
      total; anchor). Per-head order totals equal Σ member order totals.
- [ ] Segment splits map via the INDEX file with zero unmapped segments (unmapped → logged).
- [ ] Achievement % populate wherever Target Master has a value; blank + listed otherwise.
- [ ] Missing Data tab lists ONLY genuinely-absent sources (SFA visits/GPS, CTC, T.A., and — until
      created — Party→TM bridge and Target Master). It must NOT list the register or Secondary Order
      Booking once wired.
- [ ] No tab/column/layout change vs the approved `STATE_HEAD_DASHBOARD_2026-27` template.

## WHAT NOT TO DO
- Do not wire only the roster (the current bug). Wire all four sources.
- Do not use `files.export`; read via chunked `values.get`.
- Do not fabricate zeros for Targets, SFA visits, GPS, CTC, or T.A.
- Do not guess a per-member split of Sale when the Party→TM bridge is missing — leave blank + note.
- Do not infer FY from a file name; filter on the FY column (workbooks hold two years).
