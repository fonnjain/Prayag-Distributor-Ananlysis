---
name: AI graph held-value boundary
description: How Resolution holds may be exposed to model-facing graph nodes without leaking blocked numeric evidence.
---

Model-facing held measures must omit the blocked value and use a curated,
non-numeric reason. Keep the complete evidence, including numeric diagnostics,
in the Resolution register rather than copying it into the graph node or model
prompt.

**Why:** A live Analyst run correctly matched the H1 hold but then repeated
numeric cost evidence from the register. The numeric guard blocked the answer,
showing that a held value can leak indirectly through a verbose reason even when
the measure's `value` field is absent.

**How to apply:** When adapting any HOLD into an AI graph node, preserve the
hold code/category and a safe explanation, omit the value, and do not pass raw
evidence text through. Keep the full Resolution record available on its own
audited surface.