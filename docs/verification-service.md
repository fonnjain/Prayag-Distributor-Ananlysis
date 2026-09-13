# Read-only post-publish verification identity

The `verification` service identity is a non-human API principal. Its Bearer
credential is accepted only for these read-only requests:

- `GET /api/verify`
- `GET /api/mgmt/verify`
- `GET /api/audit`
- `GET /api/audit/download`

It cannot call mutation routes, health routes, or any other application API.
Authenticated browser sessions retain access so the Data Health page continues
to work. `X-Admin-Secret` does not satisfy the route-level verification gate.

## Secret configuration

Store a random value of at least 32 characters in the Replit Secret
`VERIFICATION_SERVICE_TOKEN`. Never put the value in Git, logs, chat, command
arguments, or documentation.

At application startup, the service synchronizes the secret's SHA-256 hash into
the single `api_keys` row whose scope is `verification`. The raw credential is
never stored in PostgreSQL.

## Post-publish check

Set `VERIFICATION_BASE_URL` to the published API base URL, ending in `/api`, then
run:

```sh
pnpm --filter @workspace/api-server run verify:published
```

The script requires HTTPS for published URLs, rejects redirects, and
authenticates with `VERIFICATION_SERVICE_TOKEN`. It prints redacted status
summaries for the three JSON responses and the audit workbook status, content
type, filename, byte count, and XLSX signature check. It never prints full audit
payloads or the credential.

## Rotation

1. Generate a new random value with at least 32 characters outside chat.
2. Replace `VERIFICATION_SERVICE_TOKEN` through Replit Secrets.
3. restart development or publish production so startup synchronizes the hash.
4. Run the post-publish verification script with the new credential.
5. Confirm `auth_audit` contains `verification_credential_rotated`.

Rotation invalidates the previous credential when the application starts.
Creation records `verification_credential_created`; later hash changes record
`verification_credential_rotated`. Audit metadata contains only the service
identity name and a hash-derived fingerprint, never the credential, credential
prefix, or complete hash.