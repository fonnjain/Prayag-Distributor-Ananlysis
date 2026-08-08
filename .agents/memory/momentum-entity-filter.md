---
name: Momentum entity filters
description: Momentum page State Head/State/Distributor/person filters — resolution rules, skipped panels, casing trap
---
- Momentum insights accept the shared EntityFilter (heads/states/customers JSON params) plus `person=<roster member>`.
- Person resolution: directory members → distributor sheet names → re-resolved case-insensitively (`upper(trim(customer))`) against sale_line_current, returning the REGISTER spellings so exact-match entityConds work. **Why:** member sheets and the register differ in case ("Vidhya sales" vs "Vidhya Sales"); exact matching silently produced ₹0.
- Zero-resolution person → `{none:true}` explicit zeros; never fall back to unfiltered.
- Company-wide-only sources (deepDive, atRisk, first/lost codes, secondary discount) are skipped/marked unavailable under any filter; filtered payloads never cached; Excel export disabled while filtered.
- Real-terms Laspeyres index and the seasonal run-rate curve remain COMPANY-wide even when filtered — disclosed in meta.filterNote. Entity-scoped indexes were judged too heavy; if that changes, scope them or hide the cards.
**How to apply:** any new Momentum panel must either accept the filter conds or be added to the skipped/unavailable list — never render company-wide figures silently in a filtered payload.
