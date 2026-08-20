---
name: Coverage drift review contract
description: HTTP 409 carries a complete, read-only coverage-review payload when exceptions are detected.
---

Coverage-drift endpoints use HTTP 409 to signal that review is required, while still returning the full result payload. Clients must parse that payload rather than treating it as a transport failure. Anonymous requests remain rejected; the response status does not relax authentication.

**Why:** A drift is a business review state, not an application failure. Treating the 409 as a generic error hides the precise dates, amounts, ownership evidence, and concentration warnings needed to resolve it safely.

**How to apply:** For any drift check or drift-history client, accept both 200 and 409 responses after normal authentication. Present the returned evidence as read-only and retain the explicit message that coverage is never changed automatically.