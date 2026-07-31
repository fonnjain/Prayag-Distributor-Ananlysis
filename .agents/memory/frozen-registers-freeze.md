---
name: Frozen registers system
description: Closed-FY freeze for sale_line registers — anchors, guards, override protocol
---

# Frozen registers (FY2023-24, 2024-25, 2025-26)

`artifacts/api-server/config/frozen_registers.json` holds per-FY anchors (rows + amountRupees, ±10 Rs tolerance; amountRupees=0 skips the amount assertion).

Verified frozen anchors (Jul 31 2026, dev AND production exact):
- 2023-24: 137,619 rows · 3,490,233,848 Rs (Sheets total == xlsx total)
- 2024-25: 141,201 rows · 3,411,433,805 Rs
- 2025-26: 145,613 rows · 3,609,953,809 Rs

**Rule:** every mutating `/registers/...` route must call `rejectIfFrozen(req,res,fy,{dryRun})` (in routes/registers.ts). Frozen FYs return HTTP 423 unless `?unfreeze=true&reason=<text>`. Dry runs always pass. `tank-tier-a-apply` guards "2025-26" explicitly (hardcoded FY list).
**Why:** anchor assertion at startup only *detects* drift; the route guard is what *prevents* it. A code-review pass found six unguarded mutating routes after the initial freeze shipped.
**How to apply:** any new register write route gets the guard; scheduler + ensureRegisterSynced already skip frozen FYs via `isFrozen()`. REGISTER_SYNC_PAUSE env var was deleted — freeze replaces it.

Test quirk: doSync awaits the persisted-baseline load BEFORE setting phase='syncing'; tests polling sync state must treat both 'idle' and 'syncing' as in-progress.
