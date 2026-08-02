---
name: State-head report extras (SKU / multi-year / roster)
description: Part 4 extras block on the statehead-report route — sources, guard interplay, and pitfalls
---

- `buildStateHeadExtras` (aiStateHeadExtras.ts) attaches three verified blocks to POST /api/ai/statehead-report: SKU gap segments + top-2-distributor push lists, multi-year like-months primary net by head_canon, and roster-change achievement with vs without departed members. All blocks are catch-guarded — a failure degrades to null, never breaks the report.
- **head_canon stores DISPLAY names** ("Anant Singh"), not normalized keys — a code reviewer wrongly flagged this; verified by SQL Aug 2026. Do not "fix" it by normalizing.
- SKU gap/push figures come from `sale_line_current` → measure type is **primary_sale**; only `loadSkuFacts level=retailer` / secondary_sku_line figures are secondary_sale.
- The state-head report Claude call needs max_tokens 16000 — the richer extras made 8192 truncate mid-JSON (SyntaxError at JSON.parse).
- Any rupee figure the report must cite must exist as a **numeric field** in payload/extras — figures embedded only in prose strings get mis-quoted by the model and flagged by the guard (e.g. unmappedResidualApproxRupees).
