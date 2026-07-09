# Replit Agent Prompt — Management Report from the CORRECT source, with built-in verification

> Paste below the line. This corrects the data source for the per-member management report and adds
> a verification step that reconciles output against the approved FY2025-26 dashboard.

---

## THE ROOT MISTAKE (fix this first)

The report has been sourcing **Sale Report / order / retailer** columns from the **State Head Sale
register**. That is the WRONG source. The register is **primary dispatch** (Prayag → distributor).
The management dashboard's `Sale Report` and order columns are **secondary sale** (distributor →
retailer), tracked **per team member** in the **Secondary Order Booking** system.

Proof (FY2025-26): register total = **₹361 Cr**; approved dashboard `Sale Report` = **₹240 Cr**.
Different metric, different source. So:

- **Per-member management report** (`Sale Report 25-26`, Order Booked, Retailers, No. of Orders,
  Old/New Party, Business Achieved By, Achievement %) → **Secondary Order Booking**, joined on
  **Team Member Name**. NOT the register.
- The register stays the source for the *other* dashboards (Overview/Regional primary sales) only.

## DATA SOURCE

`Secondary Order Booking Segment Wise`, folder `1Ww2B1FKjpshRTcOa_F7OUBiBsBzpVCPZ`, tab `Data Sheet`:
```
files_by_year: {
  "2025-26": "1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80",
  "2024-25": "1sejEhXCaPXwYZ99mP0tPGo_pA623FQaBN2JBcreIy2g",
  "2023-24": "1c5ZmmcKUbp9hvW0aS_HQjkjL-FJyyZ2P8Orbc0uaPbY"
}
```
Read via chunked `values.get` (NO `files.export`; the file is ~8 MB). Columns (names drift by year —
detect by content): `Date, Retailer Id, Retailer, Order ID, Segment, Cat. No., Qty, MRP, Order Value,
Distributor, Discount, Order Total, Team Member Name` (2024-25 header says `TEAM MEMBER`; 2023-24 says
`Team member` and `ID`/`Retailers`). Multi-line orders repeat header fields blank — forward-fill
`Date/Retailer Id/Order ID/Team Member` down each order block.

Per team member, for the FY, compute:
- `Order Booked` = Σ `Order Value` (+ monthly split from Date)
- `No of Orders` = distinct `Order ID`
- `Total Retailers` = distinct `Retailer Id`; `New` = first-ever order in this FY; `Old` = rest
- `Old/New Party Order Booking` = Σ Order Value by old/new
- `Business Achieved By` = distinct retailers that ordered
- `Segment` split → canonical group via INDEX map `1g-4_lDCeXQfUmp-VQ_mEWXQJyLMJXUGmRwGgughYHFY`
- `Achievement %` = Order Booked (or Sale) ÷ Target (from Target Master; blank if no target)

Join to roster (`Team Member Details` `1Nb8gRcdzY-iambAzwExTmeVY_ob6vnQ2`) on Team Member Name for
State Head / State / HQ / DOJ.

## 2026-27 — IMPORTANT: the secondary source does not exist yet

There is **no FY2026-27 Secondary Order Booking file** in the folder (verified — only up to 2025-26).
So for FY2026-27 the per-member Sale/order columns **cannot be produced yet**. Handle gracefully:
- If no secondary file for the requested FY is found (search the folder for a title containing the
  FY), populate identity + targets, leave secondary columns **blank**, and add to Missing Data:
  "Secondary Order Booking 2026-27 not found — order/sale columns pending until the file is created."
- Do NOT substitute register (primary) numbers into the secondary `Sale Report` column — that mixes
  two different metrics and produces the ₹361-vs-₹240 confusion. Keep them separate.
- Auto-discover future files from the folder id so 2026-27 fills automatically once created.

## VERIFICATION (build this in — run after every generate)

Add a `GET /api/mgmt/verify?fy=2025-26` endpoint and a "Data health" panel that reconciles the app's
computed report for FY2025-26 against these **approved-dashboard anchors** (from the signed-off file):

| Check | Expected (FY2025-26) | Tolerance |
|---|---|---|
| Total `Sale Report` | **₹240.14 Cr** | ±1% |
| Total retailers | **15,809** | ±2% |
| Total orders | **52,515** | ±2% |
| Members | **240** | exact ±2 |
| Sandeep Dadheech Sale | **₹157.39 Cr** | ±1% |
| Syed Aqil Rizvi Sale | **₹45.23 Cr** | ±1% |
| Lalan Kumar Sale | **₹13.25 Cr** | ±1% |
| Anant Singh Sale | **₹9.86 Cr** | ±1% |
| Biju C.O Sale | **₹5.55 Cr** | ±1% |

Store these anchors in `config/verify_anchors.json`. The verify endpoint returns per-check
pass/warn/fail with app value vs expected vs delta%. Also cross-foot internally: Σ(member Sale) =
Σ(head Sale) = company total (± ₹1). Any head from the roster missing from output → flag (this is how
the old "Biju C.O = 0" bug is caught). Surface results as chips; block "final" export on a hard fail.

Also verify the **name normalisation** that previously dropped ₹10 Cr: register/roster/secondary all
spell heads differently (`BIJJU`↔`Biju C.O`, `RIZVI JI`↔`Syed Aqil Rizvi`, `PAWAN KUMAR`↔`Pawan
Sharma`). Apply `config/head_alias.json` on every source; log any unmatched head/member (target
match > 95%).

## ACCEPTANCE
- [ ] `Sale Report`/order/retailer columns come from Secondary Order Booking, not the register.
- [ ] FY2025-26 report reconciles to all anchors above (total ₹240.14 Cr; 240 members; 52,515 orders).
- [ ] `/api/mgmt/verify` returns per-check pass/fail with deltas; a mismatch shows which head/metric.
- [ ] FY2026-27 renders identity+targets, with secondary columns blank + a clear Missing-Data note
      (no register numbers substituted).
- [ ] No `files.export`; chunked reads; name aliasing applied; unmatched names logged (>95% match).
- [ ] No duplicate head rows; every roster head appears once.

## WHAT NOT TO DO
- Do not use register (primary) sales for the per-member `Sale Report` — it's a different metric.
- Do not fabricate 2026-27 secondary numbers; the source doesn't exist yet.
- Do not skip verification — the anchors are how we know the report is right, not just full.
