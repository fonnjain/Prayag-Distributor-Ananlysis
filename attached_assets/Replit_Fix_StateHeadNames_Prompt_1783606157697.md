# Replit Agent Prompt — FIX: Sale Report drops ₹10.2 Cr due to State-Head name mismatch

> Paste below the line. Bug fix on the existing Management Report engine. Do not change tabs/layout.

---

## BUG

`Sale Report 26-27` is wrong. The engine joins the sale register to the roster on **State Head
name**, but the two sources spell heads differently, so unmatched heads are dropped or split into
duplicate rows. Verified against the live register (FY2026-27):

- **Biju C.O shows ₹0.00** — register says `BIJJU`, roster says `Biju C.O` → his **₹5.82 Cr** is dropped.
- Engine total **₹63.0 Cr** vs true **₹73.2 Cr** → **₹10.2 Cr (14%) missing**.
- Duplicate head rows appear (`NASIR HUSAIN` ₹0.99 Cr **and** `Nasir Hussain Khan` ₹0.00 Cr).
- Also undercounted: Anant Singh (2.32 vs 2.57), Pawan Kumar (1.49 vs 1.90); institutional buckets
  GOVT (2.86) and GeM (0.65) dropped.

Root cause = missing/partial **State-Head name normalisation**. Fix that one join.

## FIX 1 — Normalise State-Head names on BOTH sides before joining

Add this map (register value → canonical roster name). Apply `UPPER(trim())` then map. Put it in
config (e.g. `config/head_alias.json`), not inline.

```json
{
  "SANDEEP JI": "Sandeep Dadheech",
  "RIZVI JI": "Syed Aqil Rizvi",
  "BIJJU": "Biju C.O",
  "ANANT SINGH": "Anant Singh",
  "SULINDER PAL": "Sulinder Pal",
  "PAWAN KUMAR": "Pawan Sharma",
  "LALAN": "Lalan Kumar",
  "NASIR HUSAIN": "Nasir Hussain Khan",
  "SUNIL PATEL": "Sunil Patel",
  "ANUJ SHARMA": "Anuj Sharma",
  "SURESH NAIR": "Suresh Nair",
  "BABU": "Babu"
}
```
Normalise the **roster** side identically (uppercase/trim/alias) so both map to the same canonical
key. The canonical name is what appears on the report and what every roll-up groups by.

## FIX 2 — Institutional buckets are NOT heads (don't drop them)

Register values `PROJECT, GOVT, GEM, JJM, OTHER` (and blank) are channels, not team-member heads.
Map them all to one canonical bucket **"Non-territory (Project/Govt/GeM/JJM)"**, keep their sales in
the company total, and show them as their own summary line. Do not attribute them to a person and do
not drop them.

## FIX 3 — Collapse duplicates

After aliasing, **group by the canonical head** so a head can never appear twice. If any register
`STATE HEAD` value is not in the alias map and not institutional, do NOT silently drop it — add it to
the Missing Data tab as `unmapped state head: <value>` and bucket its sales under "Unmapped (review)".

## RECONCILE (acceptance gate — use these exact anchors)

After the fix, the register FY2026-27 Sale by canonical head must equal:

| Head | ₹Cr |
|---|---|
| Sandeep Dadheech | 32.77 |
| Syed Aqil Rizvi | 13.04 |
| **Biju C.O** | **5.82**  ← was 0.00 |
| Suresh Nair | 2.91 |
| Non-territory (Project/Govt/GeM/JJM) | ~5.42 |
| Anant Singh | 2.57 |
| Babu | 2.35 |
| Sulinder Pal | 2.12 |
| Pawan Sharma | 1.90 |
| Lalan Kumar | 1.80 |
| Nasir Hussain Khan | 0.99 |
| Sunil Patel | 0.80 |
| Anuj Sharma | 0.73 |
| **TOTAL** | **73.22** |

- [ ] Company total Sale Report 26-27 = **₹73.22 Cr** (± ₹0.05 Cr), not ₹63 Cr.
- [ ] Biju C.O = ₹5.82 Cr (not 0).
- [ ] No duplicate head rows anywhere (Data, Summary, Secondary tabs).
- [ ] Institutional total ≈ ₹5.42 Cr shown as its own line, not attributed to a person.
- [ ] Any unmapped head is listed in Missing Data, not dropped.
- [ ] FY filter still on the FY column (register holds two years); July stays partial.

## WHAT NOT TO DO
- Do not join heads on raw (un-normalised) names.
- Do not drop institutional/unmapped rows — bucket + list them.
- Do not change the report layout; this only corrects the values and de-dupes head rows.

## NOTE (separate, still open)
The whole order/retailer block is still empty because the **Secondary Order Booking** source isn't
being read (see the earlier "Fix Secondary Order Booking" prompt). This prompt only fixes the Sale
Report ₹10.2 Cr drop. Both fixes are needed for a correct report.
