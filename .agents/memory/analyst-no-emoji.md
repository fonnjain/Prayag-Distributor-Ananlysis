---
name: No-emoji analyst enforcement
description: Why the analyst answer needs server-side emoji stripping, not just a prompt rule
---
The "Ask the Analyst" feature (Anthropic claude-sonnet-4-6) kept emitting medal/rank emojis in ranked lists even with an explicit "do not use emojis" system-prompt line.

**Rule:** a prose instruction is not sufficient to guarantee emoji-free output. Enforce it with a programmatic Unicode-range strip on the model's text before returning it.
**Why:** the no-emoji requirement is a hard product constraint here; the model violated it reliably on ranking questions.
**How to apply:** the strip pass lives in the `/analyze` route; strengthen the prompt too, but treat the code pass as the actual guarantee.
