---
name: Pre-gate router scoping
description: Prevent integration authentication middleware from intercepting the application's protected routes
---

Any router mounted before the normal session-authentication gate must scope router-level authentication middleware to its own path prefix. A bare `router.use(authGuard)` is prohibited there.

**Why:** An external-read router used an unscoped router-level guard while mounted before the session gate. Express ran it for every later protected route, taking the entire authenticated application offline with an external-key error.

**How to apply:** Mount the guard with the integration prefix or directly on each endpoint. Keep a boundary test proving an unrelated internal route bypasses the guard while the integration route invokes it.