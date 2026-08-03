---
name: Comparison guard validation
description: How the comparison-guards validation step stays deterministic and bounded
---
Rule: a registered validation command that curls the API must never assume a running server — probe COMPARISON_BASE_URL / the preview proxy, else boot a disposable api-server on a private port and kill it on exit; fail fast (exit 2) when an explicitly configured base URL is down.
**Why:** validation runs in a clean environment; the Project run button invokes only the validation command, so an unstarted localhost target makes the check useless.
**How to apply:** any future live-API validation script; also never fan out over all heads/entities in one request — per-head deep-dive loads make the run unbounded; use one fixed fixture (GUARD_HEAD) with per-request timeouts.
Note: live data records cost for every member, so the partially-missing-cost head cost-ratio path (full-team denominator + wording) is only enforceable via the pure computeCostCell unit test, not live curls.
