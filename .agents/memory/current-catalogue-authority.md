---
name: Current catalogue authority
description: Rules for separating authoritative current product existence and price from local taxonomy and effective-dated historical MRP.
---

For current SKU catalogue and current-period price calculations, product existence and MRP come only from the active authoritative source generation. A local `item_master` match is optional taxonomy/label enrichment, never a reason to hide an authority product or substitute a current price. Missing local taxonomy is shown as `Unmapped`.

**Why:** The local upload catalogue is both broader in some places and incomplete in others, so using it as a product gate creates misleading catalogue figures and suppresses valid recommendations.

**How to apply:** Use the shared authority resolution rule for current catalogue features. Use effective-dated `mrp_history` for a closed period/as-of calculation; do not apply the latest current price retroactively. Preserve explicit price/taxonomy coverage gaps rather than silently falling back.