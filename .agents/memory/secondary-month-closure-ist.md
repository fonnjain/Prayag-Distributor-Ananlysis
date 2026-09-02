---
name: Secondary month closure boundary
description: Business-time boundary for deciding when secondary reporting months become closed.
---

Secondary reporting months close at 00:00 IST on the first day of the following month, which is 18:30 UTC on the month's final calendar day.

**Why:** This is an Indian sales operation working on IST data. Treating UTC midnight at the start of the final day as closure removed 18.5 hours of the Indian trading day and allowed an incomplete month to enter recorded-period calculations.

**How to apply:** Use the IST boundary for secondary YTD, State Head Dashboard, and secondary-ingest validation closure decisions. Do not alter date-only last-day helpers or the independent register/SKU freeze clock.