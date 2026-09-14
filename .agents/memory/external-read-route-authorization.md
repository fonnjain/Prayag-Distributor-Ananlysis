---
name: External-read route authorization
description: Mount-independent authorization and auditable usage rules for external_read API keys.
---

External-read authorization must compare the GET method and immutable terminal route name (`/sales-by-item` or `/margin-by-item`), not a router mount prefix. Keep the global credential resolver and nested route guard on the same predicate.

**Why:** Express strips `/external` when nested middleware runs. Comparing `/external/sales-by-item` worked during global authentication but failed later as `/sales-by-item`, producing a 403 after the key had already authenticated.

**How to apply:** New external endpoints need an explicit terminal-name allowlist entry and real HTTP checks for allowed routes, unrelated routes, revoked keys, and missing keys. Persist timestamp, method, path, and final status together after the response finishes.