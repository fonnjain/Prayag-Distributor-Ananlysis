---
name: Presentation route streaming requirement
description: The A4A 27-slide deck requires max_tokens=32000, which exceeds the Anthropic SDK's non-streaming threshold; must use messages.stream().
---

## Rule

The A4A state-head presentation (`/api/ai/presentation` with `stateHead` and no `member`) generates a 27-slide JSON object. This requires `max_tokens: 32000` to avoid truncated JSON. The Anthropic SDK v0.78+ refuses non-streaming calls estimated to take >10 minutes, which is triggered when `max_tokens` exceeds ~8192.

**Fix applied (Jul 28 2026):** switched to `anthropic.messages.stream({...})` and called `.finalMessage()` on the result. The route still returns a regular JSON response — streaming is only used internally for the Anthropic call.

**Why:** `anthropic.messages.create()` with `max_tokens: 32000` throws `AnthropicError: "Streaming is required for operations that may take longer than 10 minutes"` immediately, before any Claude call is made. This appears as an instant 502 with no useful log detail.

**How to apply:** Any new route that needs `max_tokens > 8192` must use `messages.stream()` rather than `messages.create()`. The member-level routes (report, suggestions, travel-plan, performance-review) all use the shared `MAX_TOKENS = 8192` constant and are unaffected.
