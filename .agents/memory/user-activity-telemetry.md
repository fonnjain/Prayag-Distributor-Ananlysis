---
name: User activity telemetry
description: Accuracy, concurrency, and privacy rules for daily authenticated-user activity reporting.
---

Per-user active and idle time must be calculated as the union of all confirmed tab intervals, never as the sum of each tab's elapsed time. When intervals overlap, active takes precedence over idle. The read/rebuild/write operation must be serialized per user so concurrently reporting tabs cannot overwrite each other's complete daily result.

**Why:** A person commonly has more than one tab open. Summing tab heartbeats inflates time, while concurrent replacement rollups can discard one tab's counts unless the whole rebuild is protected.

**How to apply:** Derive rollups from server-timestamped, completed heartbeat intervals only; cap or discard late intervals rather than projecting an unconfirmed event forward. Partition intervals at the Asia/Kolkata day boundary before aggregating.

Retention is an independent operational responsibility, not an ingestion side effect. Keep exactly 90 India-calendar dates and run cleanup at startup and on a production cadence.

**Why:** Activity can stop completely after a user leaves; write-triggered cleanup would then retain historical telemetry indefinitely.

**How to apply:** Use one aligned India-local cutoff consistently for raw events, tab sessions, and daily rollups.