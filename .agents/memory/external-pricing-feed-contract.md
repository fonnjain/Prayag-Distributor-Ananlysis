---
name: External pricing feed contract
description: Business semantics required when sales and factory-cost data is supplied to pricing applications
---

External pricing consumers may interpret an omitted period as zero. Every response must therefore declare requested, returned, held, unavailable, and provisional coverage, including responses with no data. Holds are enforced by the source server, not delegated to the consumer.

**Why:** Unknown margin and zero margin lead to opposite pricing decisions. Silent omission can make missing data appear loss-making or inactive.

**How to apply:** Keep sales on primary taxable dispatch data, retain unmatched item codes, and mark missing or held margin explicitly. Open-period changes need a pollable revision or last-modified signal.

Factory-cost contribution is gross margin or gross contribution, never profit.

**Why:** BOM cost excludes freight, overhead, and SG&A, so calling the result profit materially overstates what the measure represents.

**How to apply:** Use gross-margin/contribution names in fields, documentation, exports, and downstream prompts. Include the cost-basis limitation wherever the measure is described.