import { Router } from "express";
import { pool } from "@workspace/db";
import { isAdminToken } from "../lib/adminAuth.js";
import {
  authCookieOptions,
  bootstrapAdministrators,
  clearLoginFailures,
  createSession,
  hashPassword,
  isThrottled,
  normalizeEmail,
  publicUserFromRow,
  recordAudit,
  recordLoginFailure,
  requireAdmin,
  requireSameOrigin,
  revokeSession,
  safeUser,
  SESSION_COOKIE,
  validateEmail,
  validatePassword,
  verifyPassword,
  writeAudit,
} from "../lib/auth.js";

const router = Router();
const GENERIC_LOGIN_ERROR = "Invalid email or password";

function stringValue(value: unknown, max: number): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result && result.length <= max ? result : null;
}

function validRole(value: unknown): "admin" | "normal" | null {
  return value === "admin" || value === "normal" ? value : null;
}

async function activeAdminCount(client: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<number> {
  const { rows } = await client.query(
    `SELECT id FROM auth_users
     WHERE is_active = true AND role = 'admin'
     ORDER BY id
     FOR UPDATE`,
  );
  return rows.length;
}

async function rejectLastAdmin(
  client: { query: (sql: string, params?: unknown[]) => Promise<any> },
  targetId: number,
  becomingAdmin: boolean,
): Promise<boolean> {
  // Serialize all operations that can remove administrator authority before
  // taking any row lock. This keeps concurrent demotions/deactivations from
  // deadlocking or both observing the same stale administrator count.
  await client.query(`SELECT pg_advisory_xact_lock(367054)`);
  const { rows } = await client.query(
    `SELECT id, role, is_active FROM auth_users WHERE id = $1 FOR UPDATE`,
    [targetId],
  );
  const target = rows[0];
  if (!target) return false;
  if (target.is_active && target.role === "admin" && !becomingAdmin && await activeAdminCount(client) <= 1) {
    const error = new Error("LAST_ADMIN");
    throw error;
  }
  return true;
}

// ── Operator bootstrap (admin-secret protected, idempotent) ──────────────────

/**
 * POST /api/auth/admin-bootstrap
 * Triggers the same idempotent administrator-seeding logic as startup.
 * Protected by X-Admin-Secret (ADMIN_SECRET env var) — not by a user session.
 * Use when the startup bootstrap skipped because secrets were not yet injected.
 */
router.post("/auth/admin-bootstrap", async (req, res) => {
  const token = req.headers["x-admin-secret"];
  if (!token || typeof token !== "string" || !isAdminToken(token)) {
    return void res.status(403).json({ error: "Forbidden" });
  }

  // Accept explicit body values as an alternative to environment variables,
  // for environments where secrets are set but not yet injected into process.env.
  const {
    emails: bodyEmails,
    password: bodyPassword,
    resetExisting = false,
  } = req.body ?? {};
  if (Array.isArray(bodyEmails) && typeof bodyPassword === "string") {
    // Direct-provision path: validate and create the requested admins. Existing
    // accounts are only reset when an operator explicitly opts in; this keeps
    // ordinary bootstrap runs idempotent and non-destructive.
    if (typeof resetExisting !== "boolean") {
      return void res.status(400).json({ error: "resetExisting must be a boolean" });
    }
    const normalised = bodyEmails.map((e: unknown) => normalizeEmail(String(e ?? ""))).filter(validateEmail);
    if (normalised.length !== bodyEmails.length || normalised.length === 0) {
      return void res.status(400).json({ error: "One or more emails is invalid" });
    }
    if (!validatePassword(bodyPassword)) {
      return void res.status(400).json({ error: "Password must be at least 10 characters" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const created: number[] = [];
      const reset: number[] = [];
      for (const email of normalised) {
        const passwordHash = await hashPassword(bodyPassword);
        const displayName = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO auth_users (email, email_normalized, display_name, password_hash, role)
           VALUES ($1, $1, $2, $3, 'admin')
           ON CONFLICT (email_normalized) DO NOTHING
           RETURNING id`,
          [email, displayName, passwordHash],
        );
        if (rows[0]) {
          await writeAudit(client, "bootstrap_admin_created", req, null, rows[0].id, { source: "admin_bootstrap_endpoint" });
          created.push(rows[0].id);
        } else if (resetExisting) {
          const updated = await client.query<{ id: number }>(
            `UPDATE auth_users
             SET password_hash = $2, locked_until = NULL, updated_at = now()
             WHERE email_normalized = $1
             RETURNING id`,
            [email, passwordHash],
          );
          if (updated.rows[0]) {
            await client.query(
              `UPDATE auth_sessions SET revoked_at = now()
               WHERE user_id = $1 AND revoked_at IS NULL`,
              [updated.rows[0].id],
            );
            await writeAudit(client, "bootstrap_admin_password_reset", req, null, updated.rows[0].id, {
              source: "admin_bootstrap_endpoint",
            });
            reset.push(updated.rows[0].id);
          }
        }
      }
      await client.query("COMMIT");
      res.json({
        ok: true,
        created: created.length,
        reset: reset.length,
        skippedExisting: normalised.length - created.length - reset.length,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      req.log.error({ err }, "admin-bootstrap direct-provision failed");
      res.status(500).json({ error: "Bootstrap failed" });
    } finally {
      client.release();
    }
    return;
  }

  // Environment-variable path (original startup logic).
  try {
    await bootstrapAdministrators();
    const count = await pool.query("SELECT COUNT(*)::int AS n FROM auth_users WHERE role = 'admin' AND is_active = true");
    res.json({ ok: true, activeAdminCount: count.rows[0].n });
  } catch (err) {
    req.log.error({ err }, "admin-bootstrap failed");
    res.status(500).json({ error: "Bootstrap failed" });
  }
});

// ── Public session endpoints ──────────────────────────────────────────────────

router.post("/auth/login", requireSameOrigin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!validateEmail(email) || !password) {
    await recordLoginFailure(email || "invalid", req);
    return void res.status(401).json({ error: GENERIC_LOGIN_ERROR });
  }
  try {
    if (await isThrottled(email, req)) {
      await recordAudit("login_throttled", req, null, null, {});
      return void res.status(429).json({ error: GENERIC_LOGIN_ERROR });
    }
    const { rows } = await pool.query<{
      id: number; email: string; display_name: string; password_hash: string;
      role: string; is_active: boolean; locked_until: Date | null;
    }>(
      `SELECT id, email, display_name, password_hash, role, is_active, locked_until
       FROM auth_users WHERE email_normalized = $1 LIMIT 1`,
      [email],
    );
    const user = rows[0];
    const valid = Boolean(user && user.is_active && (!user.locked_until || user.locked_until <= new Date())
      && await verifyPassword(password, user.password_hash));
    if (!valid) {
      const locked = await recordLoginFailure(email, req);
      if (user) {
        if (locked) {
          await pool.query(
            `UPDATE auth_users
             SET locked_until = now() + interval '15 minutes', updated_at = now()
             WHERE id = $1`,
            [user.id],
          );
        }
        await recordAudit(locked ? "login_locked" : "login_failure", req, null, user.id, {});
      } else {
        await recordAudit(locked ? "login_locked" : "login_failure", req, null, null, {});
      }
      return void res.status(locked ? 429 : 401).json({ error: GENERIC_LOGIN_ERROR });
    }
    await clearLoginFailures(email, req);
    await pool.query(
      `UPDATE auth_users SET locked_until = NULL, updated_at = now() WHERE id = $1`,
      [user.id],
    );
    const token = await createSession(user.id, req);
    res.cookie(SESSION_COOKIE, token, authCookieOptions());
    await recordAudit("login_success", req, user.id, user.id, {});
    return void res.json({ user: safeUser(user) });
  } catch (err) {
    req.log.error({ err }, "login failed unexpectedly");
    return void res.status(500).json({ error: "Unable to sign in" });
  }
});

router.post("/auth/logout", async (req, res) => {
  if (req.authSessionId) {
    await revokeSession(req.authSessionId);
    await recordAudit("logout", req, req.authUser?.id ?? null, req.authUser?.id ?? null, {});
  }
  res.clearCookie(SESSION_COOKIE, { ...authCookieOptions(), maxAge: undefined });
  res.status(204).end();
});

router.get("/auth/me", (req, res) => {
  if (!req.authUser) return void res.status(401).json({ error: "Not signed in" });
  res.json({ user: req.authUser });
});

// ── Administrator account management ─────────────────────────────────────────

router.get("/auth/users", requireAdmin, async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const status = String(req.query.status ?? "all");
  const role = String(req.query.role ?? "all");
  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(email ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
  }
  if (status === "active") where.push("is_active = true");
  if (status === "inactive") where.push("is_active = false");
  if (role === "admin" || role === "normal") {
    params.push(role);
    where.push(`role = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT id, email, display_name, role, is_active, created_at, updated_at, deactivated_at, locked_until
     FROM auth_users ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY is_active DESC, role ASC, display_name ASC`,
    params,
  );
  res.json({ users: rows.map(publicUserFromRow) });
});

router.post("/auth/users", requireAdmin, async (req, res) => {
  const email = validateEmail(req.body?.email);
  const displayName = stringValue(req.body?.displayName, 120);
  const role = validRole(req.body?.role);
  const password = validatePassword(req.body?.password);
  if (!email || !displayName || !role || !password) {
    return void res.status(400).json({ error: "Provide a valid email, display name, role, and password of at least 10 characters" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const passwordHash = await hashPassword(password);
    const { rows } = await client.query(
      `INSERT INTO auth_users (email, email_normalized, display_name, password_hash, role)
       VALUES ($1, $1, $2, $3, $4)
       RETURNING id, email, display_name, role, is_active, created_at, updated_at, deactivated_at, locked_until`,
      [email, displayName, passwordHash, role],
    );
    await writeAudit(client, "user_created", req, req.authUser!.id, rows[0].id, { role });
    await client.query("COMMIT");
    res.status(201).json({ user: publicUserFromRow(rows[0]) });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err?.code === "23505") return void res.status(409).json({ error: "An account already uses that email address" });
    req.log.error({ err }, "user creation failed");
    res.status(500).json({ error: "Unable to create user" });
  } finally {
    client.release();
  }
});

router.patch("/auth/users/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "Invalid user id" });
  const displayName = req.body?.displayName === undefined ? undefined : stringValue(req.body.displayName, 120);
  const role = req.body?.role === undefined ? undefined : validRole(req.body.role);
  if ((req.body?.displayName !== undefined && !displayName) || (req.body?.role !== undefined && !role)) {
    return void res.status(400).json({ error: "Invalid account update" });
  }
  if (displayName === undefined && role === undefined) return void res.status(400).json({ error: "No changes supplied" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exists = await rejectLastAdmin(client, id, role !== "normal");
    if (!exists) {
      await client.query("ROLLBACK");
      return void res.status(404).json({ error: "User not found" });
    }
    const { rows } = await client.query(
      `UPDATE auth_users
       SET display_name = COALESCE($2, display_name), role = COALESCE($3, role), updated_at = now()
       WHERE id = $1
       RETURNING id, email, display_name, role, is_active, created_at, updated_at, deactivated_at, locked_until`,
      [id, displayName ?? null, role ?? null],
    );
    if (role === "normal") {
      await client.query(
        `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );
    }
    await writeAudit(client, "user_updated", req, req.authUser!.id, id, {
      displayNameChanged: displayName !== undefined,
      role,
    });
    await client.query("COMMIT");
    res.json({ user: publicUserFromRow(rows[0]) });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err?.message === "LAST_ADMIN") return void res.status(409).json({ error: "The last active administrator cannot be demoted" });
    req.log.error({ err }, "user update failed");
    res.status(500).json({ error: "Unable to update user" });
  } finally {
    client.release();
  }
});

router.post("/auth/users/:id/deactivate", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "Invalid user id" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exists = await rejectLastAdmin(client, id, false);
    if (!exists) {
      await client.query("ROLLBACK");
      return void res.status(404).json({ error: "User not found" });
    }
    const { rows } = await client.query(
      `UPDATE auth_users SET is_active = false, deactivated_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, email, display_name, role, is_active, created_at, updated_at, deactivated_at, locked_until`,
      [id],
    );
    await client.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
    await writeAudit(client, "user_deactivated", req, req.authUser!.id, id, {});
    await client.query("COMMIT");
    res.json({ user: publicUserFromRow(rows[0]) });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err?.message === "LAST_ADMIN") return void res.status(409).json({ error: "The last active administrator cannot be deactivated" });
    req.log.error({ err }, "user deactivation failed");
    res.status(500).json({ error: "Unable to deactivate user" });
  } finally {
    client.release();
  }
});

router.post("/auth/users/:id/reactivate", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return void res.status(400).json({ error: "Invalid user id" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE auth_users SET is_active = true, deactivated_at = NULL, locked_until = NULL, updated_at = now()
       WHERE id = $1
       RETURNING id, email, display_name, role, is_active, created_at, updated_at, deactivated_at, locked_until`,
      [id],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return void res.status(404).json({ error: "User not found" });
    }
    await writeAudit(client, "user_reactivated", req, req.authUser!.id, id, {});
    await client.query("COMMIT");
    res.json({ user: publicUserFromRow(rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log.error({ err }, "user reactivation failed");
    res.status(500).json({ error: "Unable to reactivate user" });
  } finally {
    client.release();
  }
});

router.post("/auth/users/:id/reset-password", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const password = validatePassword(req.body?.password);
  if (!Number.isInteger(id) || id <= 0 || !password) {
    return void res.status(400).json({ error: "Provide a valid user id and a password of at least 10 characters" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const passwordHash = await hashPassword(password);
    const { rows } = await client.query(
      `UPDATE auth_users SET password_hash = $2, locked_until = NULL, updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [id, passwordHash],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return void res.status(404).json({ error: "User not found" });
    }
    await client.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    );
    await writeAudit(client, "password_reset", req, req.authUser!.id, id, {});
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log.error({ err }, "password reset failed");
    res.status(500).json({ error: "Unable to reset password" });
  } finally {
    client.release();
  }
});

export default router;