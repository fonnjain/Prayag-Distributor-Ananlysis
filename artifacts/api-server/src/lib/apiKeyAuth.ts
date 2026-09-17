import { createHash, randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db, pool } from "@workspace/db";
import { apiKeys } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

export type ApiKeyScope = "full_api" | "verification" | "external_read";

const VERIFICATION_IDENTITY_NAME = "verification";
const VERIFICATION_ENDPOINTS = new Set([
  "GET /verify",
  "GET /verify/environment-parity",
  "GET /mgmt/verify",
  "GET /audit",
  "GET /audit/download",
]);
const EXTERNAL_READ_ENDPOINTS = new Set([
  "GET /sales-by-item",
  "GET /margin-by-item",
]);
const EXTERNAL_READ_PATHS = new Set([
  "/sales-by-item",
  "/margin-by-item",
]);

// ── Key generation ─────────────────────────────────────────────────────────────

export function generateRawKey(): string {
  return "pk_" + randomBytes(28).toString("hex");
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function keyPrefix(raw: string): string {
  return raw.slice(0, 12);
}

export function verificationKeyFingerprint(keyHash: string): string {
  return `vrf_${keyHash.slice(0, 12)}`;
}

// ── Middleware ─────────────────────────────────────────────────────────────────
// Attaches req.apiKey when a valid Bearer or (on the two external read
// endpoints only) X-API-Key token is present.
// Routes that require an API key should call requireApiKey() after this.
// Routes that allow unauthenticated (same-origin browser) calls need nothing extra.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: { id: number; name: string; scope?: ApiKeyScope };
    }
  }
}

export function isVerificationEndpoint(req: Pick<Request, "method" | "path">): boolean {
  return VERIFICATION_ENDPOINTS.has(`${req.method.toUpperCase()} ${req.path}`);
}

function externalRoutePath(path: string): string {
  const cleanPath = path.split("?")[0];
  const routeName = cleanPath.match(/\/(sales-by-item|margin-by-item)$/)?.[0];
  return routeName ?? cleanPath;
}

export function isExternalReadEndpoint(req: Pick<Request, "method" | "path">): boolean {
  return EXTERNAL_READ_ENDPOINTS.has(
    `${req.method.toUpperCase()} ${externalRoutePath(req.path)}`,
  );
}

export function isExternalReadPath(req: Pick<Request, "path">): boolean {
  return EXTERNAL_READ_PATHS.has(externalRoutePath(req.path));
}

export async function resolveApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers["authorization"];
  const xApiKey = req.headers["x-api-key"];
  const bearerHeader = typeof auth === "string" ? auth : "";
  const bearerRaw = bearerHeader.startsWith("Bearer ")
    ? bearerHeader.slice(7).trim()
    : "";
  const xApiRaw = typeof xApiKey === "string" ? xApiKey.trim() : "";

  if (xApiRaw && !isExternalReadEndpoint(req)) {
    res.status(403).json({ error: "X-API-Key is only accepted for external read endpoints" });
    return;
  }
  if (bearerRaw && xApiRaw && bearerRaw !== xApiRaw) {
    res.status(400).json({ error: "Conflicting Bearer and X-API-Key credentials" });
    return;
  }

  const raw = bearerRaw || xApiRaw;
  if (!raw) {
    if (isExternalReadPath(req)) {
      res.status(401).json({ error: "A valid external_read API key is required" });
      return;
    }
    return next();
  }

  const hash = hashKey(raw);
  try {
    const [row] = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        scope: apiKeys.scope,
        isRevoked: apiKeys.isRevoked,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, hash))
      .limit(1);

    if (!row) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    if (row.isRevoked) {
      res.status(401).json({ error: "API key has been revoked" });
      return;
    }
    const scope = row.scope as ApiKeyScope;
    if (scope === "verification" && !isVerificationEndpoint(req)) {
      res.status(403).json({ error: "Verification identity is not authorized for this endpoint" });
      return;
    }
    if (isExternalReadPath(req) && scope !== "external_read") {
      res.status(403).json({ error: "An external_read API key is required for this endpoint" });
      return;
    }
    if (scope === "external_read" && !isExternalReadEndpoint(req)) {
      res.status(403).json({ error: "External read identity is not authorized for this endpoint" });
      return;
    }

    req.apiKey = { id: row.id, name: row.name, scope };
    return next();
  } catch (err) {
    req.log.error({ err }, "apiKeyAuth: db error");
    res.status(500).json({ error: "Authentication check failed" });
  }
}

export function requireVerificationEndpointAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.authUser || req.apiKey?.scope === "verification") {
    next();
    return;
  }
  res.status(401).json({ error: "A browser session or verification identity is required" });
}

/**
 * External item APIs are intentionally narrower than a normal application
 * session: only a key explicitly issued with external_read may call them.
 * Keeping this as a route middleware prevents a full_api, verification key,
 * admin secret, or browser session from being silently widened into an
 * external integration credential.
 */
export function requireExternalReadEndpointAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.apiKey?.scope === "external_read" && isExternalReadEndpoint(req)) {
    next();
    return;
  }
  if (!req.apiKey) {
    res.status(401).json({ error: "A valid external_read API key is required" });
    return;
  }
  res.status(403).json({ error: "An external_read API key is required for this endpoint" });
}

export async function bootstrapVerificationIdentity(): Promise<void> {
  const raw = String(process.env.VERIFICATION_SERVICE_TOKEN ?? "").trim();
  if (!raw) {
    logger.warn("verification identity: VERIFICATION_SERVICE_TOKEN is not configured");
    return;
  }
  if (raw.length < 32) {
    throw new Error("VERIFICATION_SERVICE_TOKEN must contain at least 32 characters");
  }

  const keyHash = hashKey(raw);
  const prefix = verificationKeyFingerprint(keyHash);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [103_077]);
    const { rows } = await client.query<{
      id: number;
      key_hash: string;
      is_revoked: boolean;
    }>(
      `SELECT id, key_hash, is_revoked
       FROM api_keys
       WHERE scope = 'verification'
       FOR UPDATE`,
    );
    if (rows.length > 1) {
      throw new Error("More than one verification service identity exists");
    }

    const existing = rows[0];
    if (!existing) {
      await client.query(
        `INSERT INTO api_keys (name, description, prefix, key_hash, scope)
         VALUES ($1, $2, $3, $4, 'verification')`,
        [
          VERIFICATION_IDENTITY_NAME,
          "Read-only post-publish reconciliation and audit service identity",
          prefix,
          keyHash,
        ],
      );
      await client.query(
        `INSERT INTO auth_audit (event, metadata)
         VALUES ('verification_credential_created', $1::jsonb)`,
        [JSON.stringify({ identity: VERIFICATION_IDENTITY_NAME, prefix })],
      );
      logger.info({ identity: VERIFICATION_IDENTITY_NAME, prefix }, "verification identity created");
    } else if (existing.key_hash !== keyHash || existing.is_revoked) {
      await client.query(
        `UPDATE api_keys
         SET key_hash = $1, prefix = $2, is_revoked = false,
             revoked_at = NULL, last_used_at = NULL
         WHERE id = $3`,
        [keyHash, prefix, existing.id],
      );
      await client.query(
        `INSERT INTO auth_audit (event, metadata)
         VALUES ('verification_credential_rotated', $1::jsonb)`,
        [JSON.stringify({ identity: VERIFICATION_IDENTITY_NAME, prefix })],
      );
      logger.info({ identity: VERIFICATION_IDENTITY_NAME, prefix }, "verification credential rotated");
    } else {
      await client.query(
        `UPDATE api_keys SET prefix = $1 WHERE id = $2 AND prefix IS DISTINCT FROM $1`,
        [prefix, existing.id],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Use on any route that must require a valid API key (optional — for future lock-down).
export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.apiKey) {
    res.status(401).json({ error: "A valid API key is required" });
    return;
  }
  next();
}
