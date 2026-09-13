---
name: Verification service identity
description: Least-privilege authentication policy for production reconciliation endpoints and post-publish checks.
---

Production reconciliation must use one non-human API identity with verification
scope. It may call only GET verification, management verification, audit JSON,
and audit workbook endpoints. Browser sessions retain access, but ordinary API
keys and the admin secret do not satisfy the route-level verification gate.

The raw credential belongs only in Replit Secrets. Persist only its SHA-256 hash
and a hash-derived fingerprint; never persist or log any raw credential prefix.
Startup creates or rotates the identity transactionally and records either a
creation or rotation audit event.

Post-publish verification must require HTTPS, reject redirects, validate JSON
and XLSX response semantics, and print redacted summaries rather than complete
audit payloads.

**Why:** Production verification needs a reliable automated path without
granting administrator authority or leaking employee and business audit data
into terminal or deployment logs.

**How to apply:** Extend the exact allowlist only after explicit review. Keep
health independently public, deny mutation and sibling paths, and rotate the
secret whenever any raw portion may have been exposed.