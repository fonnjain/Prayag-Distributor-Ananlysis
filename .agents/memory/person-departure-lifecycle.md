---
name: Person departure + holding lifecycle
description: Durable rules for handling state-head departures without losing or leaking data.
---

# Person departure + holding lifecycle

- A departed head's customers move to a system "holding" person; historical figures are never rewritten. Exactly one holding person per departed head.
- Holding persons and departed heads stay OUT of assignable-person lists, active-people counts, and per-head alert firing (C6 uses the departed-heads set in the alert context). They never enter person_registry/rosters, so reports and the target engine exclude them by construction — never add them to the registry.
- Plain reactivation of a departed or holding person is forbidden: it would leave someone "active yet departed" while their customers sit in holding. Re-hire needs an explicit reversal workflow (not built yet).
- Departure reason/note are HR-sensitive: read routes must redact them for non-admin callers, **including the change-log audit trail**, which records the same values.
- Concurrency: departure recording re-checks under a row lock; a second submission must fail rather than overwrite the recorded departure.
- The org-page holding warning clears lazily once a holding person's open assignments hit zero — individual redistribution resolves it with no dedicated "clear" action.

**Why:** a departure used to silently drop months of booking history from head-scoped views and distort remaining heads' alert shares.
