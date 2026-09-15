---
name: AI visit-plan lifecycle
description: Durable integrity rules for visit-plan defaults, revisions, source evidence, and inferred completion.
---

Visit planning keeps recorded zero, unavailable, and defaulted inputs separate. Ranking defaults may preserve usefulness, but every default must remain visible and must never enter a count-looking total.

**Why:** A missing visit count is not evidence of zero visits, and a score built from hidden ₹50,000/20 km/12-visit defaults can otherwise look authoritative.

**How to apply:** Persist source identity, content hash, observation time, and exact calculation denominator authority. Create new revisions instead of overwriting; approval activates proposed targets. Infer a visit only from a newer, changed authoritative source with a cumulative visit increase. Use order-booking delta, not cumulative booking, as post-visit value. Mark not visited only after the plan month closes with newer changed evidence. Aggregate head-level pace by month so one member's monthly revisions are not double-counted.