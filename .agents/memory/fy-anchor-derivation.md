---
name: FY anchor auto-derivation
description: Policy keeping guards/features from silently anchoring on an outdated fiscal year
---

Rule: never hardcode a fiscal-year literal ("last complete FY", closed-FY lists, open FY, or prior-year month labels) in guards, guard scripts, or features. Derive it: newest fully-ingested closed FY from live ingest stats (row + 12-month completeness floor), with a ~90-day grace window after FY close, then a loud throw — or derive open-FY/month labels from the clock (Apr–Mar fiscal year).

**Why:** hardcoded anchors kept comparing against old data after FY close with no visible failure; guard scripts with literal FYs/months produce false CI failures at rollover. The grace-window throw makes staleness visible instead of silent.

**How to apply:** shared helpers live in the api-server lib (grep `fyAnchors`). Standalone .mjs guard scripts can't import TS — give them a small clock-derived FY/month helper with a self-check assertion. Intentional per-FY anchors are fine only when they already fail loudly (explicit whitelist → 400, missing verify anchors → 422).

- Route-level FY defaults (mgmt/salespeople/audit default = deriveSaleLineCohortFy; open-FY defaults everywhere = currentOpenFy at request time; audit valid list = deriveSaleLineClosedFys + open FY). Never reintroduce a hardcoded FY default in a route; module-load-time currentOpenFy() consts also go stale across April 1 — call at request time.
