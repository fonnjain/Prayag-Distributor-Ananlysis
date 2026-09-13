---
name: Scheduler production gate
description: How to interpret freshness and mirror drift between development and the published VM.
---

Interval-based data refreshes run only when `NODE_ENV=production`; development and disposable guard servers intentionally suppress them. The published VM re-arms them after startup.

**Why:** Scheduler-backed development tables can look stale even while the same published code is healthy. A publish can immediately clear production OB-mirror and secondary-freshness failures without changing parser logic.

**How to apply:** Diagnose scheduler findings separately by environment. Check production logs and production ingestion timestamps before attributing a development freshness failure to production. Never treat a disposable guard server as a data-refresh worker.