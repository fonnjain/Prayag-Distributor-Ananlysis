---
name: Route snapshot coverage rules
description: Principles for wrapping heavy GET routes with serveWithSnapshot without going stale or unbounded
---

Heavy page-load routes serve snapshot-first via serveWithSnapshot. Principles when wrapping a new one:

- **Bound the key space**: snapshot only validated, default page-load variants; free-form filter combos stay live. Every distinct key persists a DB row, so unvalidated params in the key = unbounded storage (a DoS vector).
- **Detect defaults by value, not absence**: the frontend often sends default parameters explicitly (e.g. the full month list), so compare against the computed default rather than checking the param is missing.
- **Never set `frozen` when the payload depends on cross-FY or live-clock inputs**, even for a closed FY (cross-FY breadth denominators, days-since-last-order scoring, audits that must keep re-checking). Frozen snapshots skip refresh permanently.
- **`frozen` builds must be complete**: if the build reads an optional cache, block on loading it inside the build — a frozen snapshot persisted with nulls is served as final forever.

**Why:** a snapshot layer only fixes blank first loads if the UI's real first requests hit it, and unbounded keys turn the snapshot table into a DoS vector.
**How to apply:** ask (1) is the key space bounded to validated values, (2) does the UI's actual first request hit the snapshot path, (3) does anything in the payload change after the FY closes, (4) does the build degrade on cold caches.
