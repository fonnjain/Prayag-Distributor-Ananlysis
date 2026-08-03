---
name: Distributor warnings (W2)
description: Design rules for the distributor channel warnings engine and tab
---

# Distributor warnings (W2)

- **Channel is two levels**: Prayag → Distributor → Retailer; Direct Dealers are a parallel branch with no distributor relationship — excluded from these warnings. "Total Dealer" was renamed "Total Retailers" everywhere user-facing (it counts retail outlets).
- **No A-family cards**: distributors have no targets and none may be derived. Families are R (recency/fill/pending), F (flow mismatch, states BOTH readings, never accusatory), B (breadth loss, ranked by VALUE), D (discount), G (concentration), E (retailer health), V (real-terms growth).
- **R1 bands against each distributor's OWN median inter-order interval** (never a fixed day count); <5 order dates ⇒ insufficient history ⇒ NOT_AVAILABLE, never a flag. Insufficient history also hides trend-derived B1/D2/V1; R1 RED suppresses B1/D2/E3.
- **Period discipline**: every rate uses closed like-months on BOTH FYs (secondary_sku_line queries must scope `month_label = ANY(months)` per FY; R2/R3 sum per-month booking/dispatch restricted to closed months — deep-dive flow fields are FY-to-date and include the open month, don't use them for rates). F1 is a level comparison FY-to-date both sides (member sheets have no month split).
- **D1 norm is the territory cohort minus self** per code; company-wide (minus self) is the named fallback for thin codes; variance is gross-value weighted.
- **V1 uses each distributor's own prior-FY segment mix** for the Laspeyres multiplier, never the company figure.
- **Why:** architect review caught FY-total-vs-partial-year comparisons and a company-wide D1 baseline; both produce misleading flags on open FYs.
- **Data joins**: secondary_sku_line has its own `distributor` column — join via normDistKey to member-sheet distributor names. Prior-FY sale_line rows lack head_canon — always scope prior queries by the customer list, not head.
- **Frontend**: never render the previous head's cards after a head switch — gate rendering on the head you REQUESTED (server may canonicalise casing; comparing response.stateHead to the select value can loop the refetch effect).
