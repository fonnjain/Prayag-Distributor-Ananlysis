---
name: Project head reclassification breaks cross-FY mix comparisons
description: head_canon moves between FYs (not state_canon) can shift ₹30+ Cr between territory and project channels; null-state tests cannot detect it
---

**Rule:** Before declaring any cross-FY channel/mix comparison "clean", check per-customer head_canon stability across the two FYs — not just state_canon fill rates. A customer whose head_canon was NULL (territory) in one FY and 'Non-territory / Project / Govt' in the next moves their entire book across the comparison boundary.

**Why:** MOHAN IMPEX booked ₹30.36 Cr in FY2024-25 with NULL head_canon (counted territory) and ₹35.73 Cr in FY2025-26 as project. The FY2025-26 "project channel doubled" story (₹26.71→₹57.14 Cr) was ~₹35.7 Cr attribution artefact + ~₹21.4 Cr genuine channel. A state_canon-NULL contamination test passed 100% and gave false confidence.

**How to apply:** For any FY-over-FY mix/share claim, run the three-way split — (a) same head both years, (b) head changed, (c) new customer — and report group (b) net before signing off. bool_or over NULL comparisons silently misbuckets: use COALESCE(bool_or(...), false) and treat `head_canon IS NULL` explicitly as territory.
