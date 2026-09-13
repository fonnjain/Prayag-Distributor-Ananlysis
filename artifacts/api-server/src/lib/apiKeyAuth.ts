import { createHash, randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db, pool } from "@workspace/db";
import { apiKeys } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

export type ApiKeyScope = "full_api" | "verification";

const VERIFICATION_IDENTITY_NAME = "verification";
const VERIFICATION_ENDPOINTS = new Set([
  "GET /verify",
  "GET /mgmt/verify",
  "GET /audit",
  "GET /audit/download",
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
// Attaches req.apiKey when a valid Bearer token is present.
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

export async function resolveApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) {
    return next();
  }
  const raw = auth.slice(7).trim();
  if (!raw) return next();

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

    // Fire-and-forget last_used_at update
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch(() => undefined);

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
