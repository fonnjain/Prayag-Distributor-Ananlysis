---
name: Seasonal curve baseline reconciliation
description: Activation of the versioned curve is gated on the approved FY2025-26 calibration matching frozen source monthly shares.
---

Do not activate a rebuilt seasonal curve when the FY2025-26 frozen source differs from the checked-in baseline by 1 percentage point or more in any month. Retain the approved configuration as the active runtime fallback and surface the reconciliation finding instead.

**Why:** The frozen FY2025-26 source total can reconcile while its month distribution does not. A denominator change would otherwise alter target splits and Momentum projections without a defensible explanation.

**How to apply:** Reconcile the source aggregation/derivation first. Once the monthly shape is accepted, the versioned service can append the FY2025-26 baseline and equal-weighted multi-year version; never bypass the guard merely to activate v2.