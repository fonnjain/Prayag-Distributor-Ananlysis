---
name: Retrospective load provenance
description: Truthfulness and safety rules for reconstructing missing load metadata after data was already written.
---

Retrospective provenance must be explicitly labelled retrospective. Preserve the original source facts and control values exactly, store the original load timestamp separately from the later provenance-record timestamp, and never imply the record existed at load time.

**Why:** A provenance row that appears contemporaneous when it was reconstructed later is misleading audit evidence, even if every source figure is correct.

**How to apply:** Use a metadata-only transaction that shares the original loader's lock, prevents concurrent data writes, verifies protected-table totals before and after, refuses existing provenance or any anchor mismatch, and inserts only the provenance row. If the exact original timestamp is unknown, keep commit disabled until reviewed evidence supplies it.