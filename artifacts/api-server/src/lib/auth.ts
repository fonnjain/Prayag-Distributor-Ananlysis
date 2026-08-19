import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { pool } from "@workspace/db";
import { isAdminToken } from "./adminAuth.js";
import { logger } from "./logger.js";

const scrypt = promisify(scryptCallback);

export const SESSION_COOKIE = "prayag_session";
const SESSION_DURATION_MS = 12 * 60 * 60 * 1_000;
const THROTTLE_MAX_FAILURES = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AuthRole = "admin" | "normal";

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: AuthRole;
  isActive: boolean;
}

interface SessionIdentity extends AuthUser {
  sessionId: number;
}

interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<any>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      authSessionId?: number;
    }
  }
}

export function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function validateEmail(value: unknown): string | null {
  const email = normalizeEmail(value);
  return email && email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

export function validatePassword(value: unknown): string | null {
  const password = typeof value === "string" ? value : "";
  if (password.length < 10 || password.length > 256) return null;
  return password;
}

export function safeUser(row: {
  id: number;
  email: string;
  display_name: string;
  role: string;
  is_active: boolean;
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role === "admin" ? "admin" : "normal",
    isActive: Boolean(row.is_active),
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  try {
    const actual = (await scrypt(password, salt, 64)) as Buffer;
    const expectedBuffer = Buffer.from(expected, "base64url");
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function requestIpHash(req: Request): string {
  return sha256(requestIp(req));
}

function throttleKey(email: string, req: Request): string {
  return sha256(`${email}\u0000${requestIp(req)}`);
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DURATION_MS,
  };
}

export async function recordAudit(
  event: string,
  req: Request | undefined,
  actorUserId: number | null,
  targetUserId: number | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await writeAudit(pool, event, req, actorUserId, targetUserId, metadata);
  } catch (err) {
    logger.error({ err, event }, "auth audit write failed");
  }
}

/**
 * Mandatory audit writer for security-sensitive state changes. Callers keep
 * this in the same transaction as the mutation so neither can commit alone.
 */
export async function writeAudit(
  client: Queryable,
  event: string,
  req: Request | undefined,
  actorUserId: number | null,
  targetUserId: number | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO auth_audit (event, actor_user_id, target_user_id, metadata, ip_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [event, actorUserId, targetUserId, JSON.stringify(metadata), req ? requestIpHash(req) : null],
  );
}

export async function isThrottled(email: string, req: Request): Promise<boolean> {
  const { rows } = await pool.query<{ locked_until: Date | null }>(
    `SELECT locked_until FROM auth_login_throttle WHERE key_hash = $1`,
    [throttleKey(email, req)],
  );
  return Boolean(rows[0]?.locked_until && rows[0].locked_until > new Date());
}

export async function recordLoginFailure(email: string, req: Request): Promise<boolean> {
  const key = throttleKey(email, req);
  const now = new Date();
  const { rows } = await pool.query<{
    failure_count: number;
    window_started: Date;
    locked_until: Date | null;
  }>(
    `INSERT INTO auth_login_throttle (key_hash, failure_count, window_started)
     VALUES ($1, 1, now())
     ON CONFLICT (key_hash) DO UPDATE
     SET failure_count = CASE
           WHEN auth_login_throttle.window_started < now() - interval '15 minutes' THEN 1
           ELSE auth_login_throttle.failure_count + 1
         END,
         window_started = CASE
           WHEN auth_login_throttle.window_started < now() - interval '15 minutes' THEN now()
           ELSE auth_login_throttle.window_started
         END,
         locked_until = CASE
           WHEN auth_login_throttle.window_started >= now() - interval '15 minutes'
             AND auth_login_throttle.failure_count + 1 >= $2
           THEN now() + interval '15 minutes'
           ELSE auth_login_throttle.locked_until
         END
     RETURNING failure_count, window_started, locked_until`,
    [key, THROTTLE_MAX_FAILURES],
  );
  return Boolean(rows[0]?.locked_until && rows[0].locked_until > now);
}

export async function clearLoginFailures(email: string, req: Request): Promise<void> {
  await pool.query(`DELETE FROM auth_login_throttle WHERE key_hash = $1`, [throttleKey(email, req)]);
}

export async function createSession(userId: number, req: Request): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await pool.query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at, ip_hash, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, sha256(raw), expiresAt, requestIpHash(req), req.get("user-agent")?.slice(0, 500) ?? null],
  );
  return raw;
}

export async function revokeSession(sessionId: number): Promise<void> {
  await pool.query(`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

export async function revokeAllUserSessions(userId: number): Promise<void> {
  await pool.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

async function resolveSessionIdentity(rawToken: string): Promise<SessionIdentity | null> {
  const { rows } = await pool.query<{
    session_id: number;
    id: number;
    email: string;
    display_name: string;
    role: string;
    is_active: boolean;
  }>(
    `SELECT s.id AS session_id, u.id, u.email, u.display_name, u.role, u.is_active
     FROM auth_sessions s
     JOIN auth_users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.is_active = true
     LIMIT 1`,
    [sha256(rawToken)],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...safeUser(row), sessionId: row.session_id };
}

export async function resolveSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const raw = typeof req.cookies?.[SESSION_COOKIE] === "string" ? req.cookies[SESSION_COOKIE] : "";
  if (!raw) return next();
  try {
    const identity = await resolveSessionIdentity(raw);
    if (identity) {
      req.authUser = identity;
      req.authSessionId = identity.sessionId;
      void pool.query(`UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1`, [identity.sessionId]);
    }
    return next();
  } catch (err) {
    req.log.error({ err }, "session authentication check failed");
    res.status(500).json({ error: "Authentication check failed" });
  }
}

export function requireAuthenticated(req: Request, res: Response, next: NextFunction): void {
  if (req.authUser || req.apiKey) return next();
  const operatorSecret = String(req.headers["x-admin-secret"] ?? "");
  if (isAdminToken(operatorSecret)) return next();
  res.status(401).json({ error: "Authentication required" });
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get("origin");
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  const expectedHost = forwardedHost || req.get("host") || "";
  try {
    if (!origin || !expectedHost || new URL(origin).host !== expectedHost) {
      res.status(403).json({ error: "Cross-origin request rejected" });
      return;
    }
  } catch {
    res.status(403).json({ error: "Cross-origin request rejected" });
    return;
  }
  next();
}

export function requireSameOriginForSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser || req.apiKey || ["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }
  requireSameOrigin(req, res, next);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.authUser?.role === "admin") return next();
  res.status(403).json({ error: "Administrator access required" });
}

export async function bootstrapAdministrators(): Promise<void> {
  const emails = String(process.env.AUTH_BOOTSTRAP_ADMINS ?? "")
    .split(",")
    .map(normalizeEmail)
    .filter((email) => validateEmail(email) !== null);
  const password = process.env.AUTH_BOOTSTRAP_PASSWORD;

  if (emails.length === 0 || !password) {
    logger.warn(
      "application auth bootstrap skipped: set AUTH_BOOTSTRAP_ADMINS and AUTH_BOOTSTRAP_PASSWORD securely before first sign-in",
    );
    return;
  }
  if (emails.length !== 3 || new Set(emails).size !== emails.length || !validatePassword(password)) {
    logger.error(
      { configuredEmailCount: emails.length },
      "application auth bootstrap skipped: expected three distinct valid emails and a password of at least 10 characters",
    );
    return;
  }

  const seeds = await Promise.all(emails.map(async (email) => ({
    email,
    displayName: email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    // Generate a separate salt for every account even though the initial
    // bootstrap password is shared.
    passwordHash: await hashPassword(password),
  })));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const seed of seeds) {
      const inserted = await client.query(
        `INSERT INTO auth_users (email, email_normalized, display_name, password_hash, role)
         VALUES ($1, $1, $2, $3, 'admin')
         ON CONFLICT (email_normalized) DO NOTHING
         RETURNING id`,
        [seed.email, seed.displayName, seed.passwordHash],
      );
      if (inserted.rows[0]) {
        await writeAudit(client, "bootstrap_admin_created", undefined, null, inserted.rows[0].id, {});
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  logger.info({ configuredEmailCount: emails.length }, "application auth bootstrap completed");
}

export function publicUserFromRow(row: {
  id: number;
  email: string;
  display_name: string;
  role: string;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
  deactivated_at?: Date | null;
  locked_until?: Date | null;
}) {
  return {
    ...safeUser(row),
    createdAt: row.created_at?.toISOString(),
    updatedAt: row.updated_at?.toISOString(),
    deactivatedAt: row.deactivated_at?.toISOString() ?? null,
    lockedUntil: row.locked_until?.toISOString() ?? null,
  };
}