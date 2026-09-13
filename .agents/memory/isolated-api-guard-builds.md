---
name: Isolated API guard builds
description: Why standalone API-backed guards build into unique directories inside the API package rather than shared dist or system tmp.
---

Standalone guards that start disposable API servers must use a unique output directory for each invocation, and that directory must be inside the API package tree.

**Why:** Concurrent builds delete the shared `dist` directory and can remove Pino worker files while another server starts. A bundle written directly under `/tmp` avoids that race but Node ESM cannot resolve external packages from the API package's `node_modules`.

**How to apply:** Give each guard build its own package-local temporary output directory, verify the entry point and worker files before spawning, and remove the directory synchronously when the guard exits. Infrastructure failures must report “could not evaluate” separately from assertion failures.