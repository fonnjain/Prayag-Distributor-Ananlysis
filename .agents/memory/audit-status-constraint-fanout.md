---
name: Audit status constraint fan-out
description: Prevent one-time reconciliations from rolling back because a linked audit table rejects the new semantic status.
---

When a controlled operation introduces a new outcome or resolution status, inventory every table it writes and update all related CHECK constraints before production use.

**Why:** A reconciliation can successfully pass its primary ledger constraint yet roll back later when a linked review or resolution table rejects the same new status.

**How to apply:** Trace the complete transaction write set, inspect each target table's constraints, make every constraint migration replay-safe, and verify all status writes together before invoking the live operation.