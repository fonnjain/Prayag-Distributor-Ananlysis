import { createHash, randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { apiKeys } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

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

// ── Middleware ─────────────────────────────────────────────────────────────────
// Attaches req.apiKey when a valid Bearer token is present.
// Routes that require an API key should call requireApiKey() after this.
// Routes that allow unauthenticated (same-origin browser) calls need nothing extra.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: { id: number; name: string };
    }
  }
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
      .select({ id: apiKeys.id, name: apiKeys.name, isRevoked: apiKeys.isRevoked })
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

    // Fire-and-forget last_used_at update
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id))
      .catch(() => undefined);

    req.apiKey = { id: row.id, name: row.name };
    return next();
  } catch (err) {
    req.log.error({ err }, "apiKeyAuth: db error");
    res.status(500).json({ error: "Authentication check failed" });
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
