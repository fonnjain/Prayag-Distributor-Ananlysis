---
name: Application auth system
description: Custom email/password auth added in Task 367 — tables, session model, admin UI, bootstrap pattern, and security choices.
---

## Tables
- `auth_users` — email (normalized unique), password_hash (scrypt), role (admin/normal), is_active, locked_until
- `auth_sessions` — opaque token stored as SHA-256 hash; 12h absolute expiry; revocable per-user or individually
- `auth_audit` — every account mutation and login event; always written in the same DB transaction as the mutation
- `auth_login_throttle` — IP + normalized-email key; 5 failures → 15-minute lockout

## Migration
Migration `054_application_auth` in `lib/db/src/runMigrations.ts` creates all four tables plus role-check constraint and indexes.

## Session model
- Cookie: `prayag_session`, HttpOnly, SameSite=Lax, 12h max-age
- Unsafe same-origin enforcement: `requireSameOrigin` middleware on `POST /auth/login`; `requireSameOriginForSession` on all other cookie-authenticated non-GET /api routes; API-key requests bypass both.
- Browser data routes protected by `requireAuthenticated` (allows session or valid API key).

## Bootstrap pattern
`bootstrapAdministrators()` reads `AUTH_BOOTSTRAP_ADMINS` (comma-, whitespace-, or semicolon-separated email tokens) and `AUTH_BOOTSTRAP_PASSWORD` from process.env at startup — idempotent via ON CONFLICT DO NOTHING. Invalid non-email prose is discarded; bootstrap still requires exactly 3 distinct valid emails and a 10-char+ password.

**Why startup injection sometimes fails**: Replit dev-workflow secrets may not propagate to the running process environment after new secrets are added, and a human-readable account list can contain separator or prose mistakes. Use the `POST /api/auth/admin-bootstrap` endpoint (protected by `X-Admin-Secret`) as the reliable fallback. It accepts `{emails: [...], password: "..."}` in the body and is idempotent.

Never record administrator email addresses in project memory; check the live account list through the protected route or database query when needed.

## Admin endpoint
`POST /api/auth/admin-bootstrap` — requires `X-Admin-Secret` header. Accepts body `{emails: string[], password: string}` to directly provision admins, or no body to fall back to env vars. An explicit `resetExisting: true` additionally changes passwords for matching accounts, revokes their sessions, and writes audit events; ordinary calls remain non-destructive. Returns `{ok, created, reset, skippedExisting}`.

## Security choices
- Passwords: scrypt with random per-password salt; timing-safe comparison
- Sessions: random opaque tokens stored only as SHA-256 hash in DB
- Last-admin guard: `pg_advisory_xact_lock(367054)` serializes concurrent deactivation/demotion; row-level FOR UPDATE prevents count drift
- Audit writes are transactional — failure rolls back the account/session mutation
- Password never returned in any API response; tests assert this

## Tests
`artifacts/api-server/src/routes/auth.test.ts` — 10 tests covering: hash/verify, authorization gate, cross-origin CSRF, user list non-disclosure, session revocation, audit rollback on failure, last-admin protection, idempotent bootstrap, CSRF on login endpoint.

**Why**: esbuild silently drops dead code after return — TS errors are invisible at build time; always run `pnpm --filter @workspace/api-server run typecheck` after auth changes.
