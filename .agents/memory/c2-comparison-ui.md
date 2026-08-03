---
name: C2 Comparison Deep Dive UI
description: /comparison page conventions — render-only rule, authoritative flags, export basis rule.
---

# C2 Comparison Deep Dive (UI over the C1 contract)

- **Render-only rule:** the page shows only what POST /api/comparison returns. A 422 blocked response is rendered as information (blue, "this comparison would mislead"), never as an error; the basis strip renders in full above any figure, channelLabel untruncated.
- **Flags and ranking come from the API, never inferred client-side.** MatrixRow carries `flags` (TENURE / NO TARGET / NO BUSINESS / INSUFFICIENT SAMPLE), `rankEligible`, `rankBlockReason` — added in C2 after review caught the UI sniffing note strings.
  **Why:** note text is human prose and changes; sniffing it mislabelled sample-suppression as TENURE. Any future consumer (C3 matrix, exports) must read these fields verbatim.
- **Export basis rule:** every figure-bearing surface (each Excel sheet via a shared basis-header writer, the PDF print window) carries the complete basis + guard report, not just the channel label. Blocked results still export (basis-only workbook). Frontend checks Content-Type before saving a blob — an error JSON must never download as .xlsx.
- Mode C (many entities × many periods) is deliberately locked out until C3 — one axis disables the other with an explanatory note.
- Entity option lists: GET /api/comparison/entities?type= (long lists searchable + capped; member list ships name+stateHead pairs for disambiguation). Guard-10 candidates render as buttons that re-run with context.stateHead.
- Page registered as period-capability "NONE" — it has its own period builder.
