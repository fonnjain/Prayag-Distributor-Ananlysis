---
name: Seasonal curve baseline reconciliation
description: Activation requires the FY2025-26 approved calibration to match the correctly classified retail source within rounding tolerance.
---

Do not activate a rebuilt seasonal curve unless the FY2025-26 source matches the checked-in monthly calibration within 0.1 percentage points for every month. Resolve source classification before changing a projection denominator.

**Why:** An all-channel FY2025-26 total reconciled, yet its monthly shape materially diverged. The approved curve instead reproduced the `Retail` channel to ordinary one-decimal rounding. Project, Govt, JJM, and GeM were leaking in because legacy territory flags were NULL.

**How to apply:** Prefer a populated channel classification (`Retail`) over territory flags; if no channel exists, use explicit `is_territory=TRUE`; only retain an entirely unclassified historical year with a visible provenance caveat. Persist the chosen basis alongside rows/nets, then append the verified baseline and equal-weighted multi-year version.