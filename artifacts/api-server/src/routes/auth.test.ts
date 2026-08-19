import express, { type RequestHandler } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: mocks.query,
    connect: mocks.connect,
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import authRouter from "./auth.js";
import {
  bootstrapAdministrators,
  hashPassword,
  requireAuthenticated,
  requireSameOrigin,
  requireSameOriginForSession,
  validatePassword,
  verifyPassword,
} from "../lib/auth.js";

const adminIdentity: RequestHandler = (req, _res, next) => {
  req.authUser = {
    id: 7,
    email: "admin@example.com",
    displayName: "Admin",
    role: "admin",
    isActive: true,
  };
  req.authSessionId = 70;
  next();
};

function authApp(identity?: RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  if (identity) app.use(identity);
  app.use(authRouter);
  return app;
}

describe("application authentication", () => {
  const previousAdmins = process.env.AUTH_BOOTSTRAP_ADMINS;
  const previousPassword = process.env.AUTH_BOOTSTRAP_PASSWORD;

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.connect.mockReset();
  });

  afterEach(() => {
    if (previousAdmins === undefined) delete process.env.AUTH_BOOTSTRAP_ADMINS;
    else process.env.AUTH_BOOTSTRAP_ADMINS = previousAdmins;
    if (previousPassword === undefined) delete process.env.AUTH_BOOTSTRAP_PASSWORD;
    else process.env.AUTH_BOOTSTRAP_PASSWORD = previousPassword;
  });

  it("stores a salted one-way password hash and verifies it safely", async () => {
    const encoded = await hashPassword("a-strong-password-123");
    expect(encoded).not.toContain("a-strong-password-123");
    expect(encoded.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("a-strong-password-123", encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", encoded)).resolves.toBe(false);
  });

  it("accepts passwords of 10 characters and rejects shorter passwords", () => {
    expect(validatePassword("123456789")).toBeNull();
    expect(validatePassword("1234567890")).toBe("1234567890");
  });

  it("rejects protected browser requests but permits resolved API keys", () => {
    const unauthorizedResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();
    requireAuthenticated({ headers: {} } as any, unauthorizedResponse as any, next);
    expect(unauthorizedResponse.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();

    requireAuthenticated({ apiKey: { id: 1, name: "client" }, headers: {} } as any, unauthorizedResponse as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin cookie-authenticated writes", () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();
    requireSameOriginForSession({
      authUser: adminIdentity,
      method: "POST",
      headers: { host: "prayag.example.com", origin: "https://attacker.example.com" },
      get(name: string) {
        return (this.headers as Record<string, string>)[name.toLowerCase()];
      },
    } as any, response as any, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects cross-origin attempts to establish a login session", async () => {
    const response = await request(authApp())
      .post("/auth/login")
      .set("Origin", "https://attacker.example.com")
      .send({ email: "admin@example.com", password: "a-strong-password-123" });
    expect(response.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();

    const noOriginResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();
    requireSameOrigin({
      method: "POST",
      headers: { host: "prayag.example.com" },
      get(name: string) {
        return (this.headers as Record<string, string>)[name.toLowerCase()];
      },
    } as any, noOriginResponse as any, next);
    expect(noOriginResponse.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("requires an administrator for user management", async () => {
    const response = await request(authApp()).get("/auth/users");
    expect(response.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("never returns a password hash from the user list", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{
        id: 1,
        email: "person@example.com",
        display_name: "Person",
        password_hash: "must-not-leak",
        role: "normal",
        is_active: true,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-01T00:00:00Z"),
        deactivated_at: null,
        locked_until: null,
      }],
    });
    const response = await request(authApp(adminIdentity)).get("/auth/users");
    expect(response.status).toBe(200);
    expect(response.body.users[0]).toMatchObject({
      email: "person@example.com",
      displayName: "Person",
      role: "normal",
    });
    expect(JSON.stringify(response.body)).not.toContain("password");
    expect(JSON.stringify(response.body)).not.toContain("must-not-leak");
  });

  it("revokes every existing session when an administrator resets a password", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 12 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // revoke sessions
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // audit
        .mockResolvedValueOnce({ rows: [] }), // COMMIT
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(client);

    const response = await request(authApp(adminIdentity))
      .post("/auth/users/12/reset-password")
      .send({ password: "replacement-password-123" });

    expect(response.status).toBe(204);
    const sqlCalls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls.some((sql) => sql.includes("UPDATE auth_sessions") && sql.includes("revoked_at"))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO auth_audit"))).toBe(true);
    expect(JSON.stringify(client.query.mock.calls)).not.toContain("replacement-password-123");
  });

  it("rolls back a password reset when the mandatory audit write fails", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 12 }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 })
        .mockRejectedValueOnce(new Error("audit unavailable"))
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(client);

    const response = await request(authApp(adminIdentity))
      .post("/auth/users/12/reset-password")
      .send({ password: "replacement-password-123" });

    expect(response.status).toBe(500);
    expect(client.query.mock.calls.some(([sql]) => String(sql) === "ROLLBACK")).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql) === "COMMIT")).toBe(false);
  });

  it("revokes active sessions when an administrator is demoted to normal", async () => {
    // Target starts as an active admin being demoted — this exercises the full
    // rejectLastAdmin path: advisory lock → target row → activeAdminCount (2
    // active admins, so demotion is permitted) → UPDATE + session revocation.
    const updatedUser = {
      id: 5,
      email: "admin5@example.com",
      display_name: "Admin Five",
      role: "normal",
      is_active: true,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
      deactivated_at: null,
      locked_until: null,
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock
        .mockResolvedValueOnce({ rows: [{ id: 5, role: "admin", is_active: true }] }) // rejectLastAdmin SELECT (active admin)
        .mockResolvedValueOnce({ rows: [{ id: 5 }, { id: 7 }] }) // activeAdminCount — 2 admins, demotion allowed
        .mockResolvedValueOnce({ rows: [updatedUser] }) // UPDATE auth_users
        .mockResolvedValueOnce({ rows: [], rowCount: 3 }) // UPDATE auth_sessions (revoke)
        .mockResolvedValueOnce({ rows: [] }) // INSERT INTO auth_audit
        .mockResolvedValueOnce({ rows: [] }), // COMMIT
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(client);

    const response = await request(authApp(adminIdentity))
      .patch("/auth/users/5")
      .send({ role: "normal" });

    expect(response.status).toBe(200);
    const sqlCalls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(
      sqlCalls.some((sql) => sql.includes("UPDATE auth_sessions") && sql.includes("revoked_at")),
    ).toBe(true);
  });

  it("does not revoke sessions when only displayName is updated without a role change", async () => {
    const updatedUser = {
      id: 5,
      email: "person@example.com",
      display_name: "New Name",
      role: "normal",
      is_active: true,
      created_at: new Date("2026-01-01T00:00:00Z"),
      updated_at: new Date("2026-08-01T00:00:00Z"),
      deactivated_at: null,
      locked_until: null,
    };
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_xact_lock
        .mockResolvedValueOnce({ rows: [{ id: 5, role: "normal", is_active: true }] }) // rejectLastAdmin SELECT
        .mockResolvedValueOnce({ rows: [updatedUser] }) // UPDATE auth_users
        .mockResolvedValueOnce({ rows: [] }) // INSERT INTO auth_audit
        .mockResolvedValueOnce({ rows: [] }), // COMMIT
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(client);

    const response = await request(authApp(adminIdentity))
      .patch("/auth/users/5")
      .send({ displayName: "New Name" });

    expect(response.status).toBe(200);
    const sqlCalls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(
      sqlCalls.some((sql) => sql.includes("UPDATE auth_sessions") && sql.includes("revoked_at")),
    ).toBe(false);
  });

  it("prevents the last active administrator from being deactivated", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [{ id: 7, role: "admin", is_active: true }] })
        .mockResolvedValueOnce({ rows: [{ id: 7 }] })
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(client);

    const response = await request(authApp(adminIdentity)).post("/auth/users/7/deactivate");
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("last active administrator");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET is_active = false"))).toBe(false);
  });

  it("writes a last_admin_blocked audit event via the pool when a deactivation is rejected as LAST_ADMIN", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [{ id: 7, role: "admin", is_active: true }] })
        .mockResolvedValueOnce({ rows: [{ id: 7 }] })
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(client);
    // pool.query is used by recordAudit (outside the rolled-back transaction)
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const response = await request(authApp(adminIdentity)).post("/auth/users/7/deactivate");
    expect(response.status).toBe(409);

    // The post-rollback audit write must go through the pool (mocks.query), not
    // the rolled-back client, so it is never lost if the transaction aborted.
    const auditCall = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO auth_audit"),
    );
    expect(auditCall).toBeDefined();
    const auditParams = auditCall![1] as unknown[];
    expect(auditParams[0]).toBe("last_admin_blocked");
    expect(JSON.parse(String(auditParams[3]))).toMatchObject({ action: "deactivate" });
  });

  it("writes a last_admin_blocked audit event via the pool when a demotion is rejected as LAST_ADMIN", async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // advisory lock
        .mockResolvedValueOnce({ rows: [{ id: 7, role: "admin", is_active: true }] })
        .mockResolvedValueOnce({ rows: [{ id: 7 }] })
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(client);
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const response = await request(authApp(adminIdentity))
      .patch("/auth/users/7")
      .send({ role: "normal" });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("last active administrator");

    const auditCall = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO auth_audit"),
    );
    expect(auditCall).toBeDefined();
    const auditParams = auditCall![1] as unknown[];
    expect(auditParams[0]).toBe("last_admin_blocked");
    expect(JSON.parse(String(auditParams[3]))).toMatchObject({ action: "demote" });
  });

  // ── Concurrent last-admin protection tests ───────────────────────────────────
  //
  // The two tests below use a stateful shared-memory mock to mirror the
  // pg_advisory_xact_lock serialization that PostgreSQL performs in production.
  //
  // AsyncMutex: the advisory-lock call in the second concurrent request blocks
  // (returns a pending Promise) until the first transaction calls COMMIT or
  // ROLLBACK and releases the lock.  This makes the 200/409 split emerge from
  // actual async concurrency rather than from pre-scripted fixture ordering.
  //
  // makeAdminClient: each client reads and writes a shared Map of user rows.
  // COMMIT flushes pending writes into the shared Map before releasing the lock,
  // so the unblocked second transaction sees the post-commit admin count.
  // ROLLBACK discards pending writes and releases the lock without updating
  // shared state.

  class AsyncMutex {
    private queue: Array<() => void> = [];
    private locked = false;

    async acquire(): Promise<() => void> {
      if (!this.locked) {
        this.locked = true;
        return this.makeRelease();
      }
      return new Promise((resolve) => {
        this.queue.push(() => resolve(this.makeRelease()));
      });
    }

    private makeRelease(): () => void {
      return () => {
        if (this.queue.length > 0) {
          this.queue.shift()!();
        } else {
          this.locked = false;
        }
      };
    }
  }

  type UserRow = { id: number; role: string; is_active: boolean };

  function makeAdminClient(sharedUsers: Map<number, UserRow>, mutex: AsyncMutex) {
    let releaseLock: (() => void) | null = null;
    const pendingWrites = new Map<number, Partial<UserRow>>();

    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        const s = String(sql);

        if (s.includes("BEGIN")) return { rows: [] };

        // pg_advisory_xact_lock: serialize all lock-acquiring transactions
        if (s.includes("pg_advisory_xact_lock")) {
          releaseLock = await mutex.acquire();
          return { rows: [] };
        }

        // rejectLastAdmin: read target user row
        if (s.includes("SELECT id, role, is_active FROM auth_users WHERE id = $1")) {
          const id = Number(params?.[0]);
          const u = sharedUsers.get(id);
          return { rows: u ? [{ ...u }] : [] };
        }

        // activeAdminCount: count surviving active admins from shared (committed) state
        if (s.includes("SELECT id FROM auth_users") && s.includes("is_active = true")) {
          const rows = [...sharedUsers.values()]
            .filter((u) => u.is_active && u.role === "admin")
            .map((u) => ({ id: u.id }));
          return { rows };
        }

        // deactivate route: UPDATE auth_users SET is_active = false …
        if (s.includes("SET is_active = false")) {
          const id = Number(params?.[0]);
          pendingWrites.set(id, { is_active: false });
          const base = sharedUsers.get(id)!;
          return {
            rows: [{
              id,
              email: `admin${id}@example.com`,
              display_name: `Admin ${id}`,
              role: base.role,
              is_active: false,
              created_at: new Date(),
              updated_at: new Date(),
              deactivated_at: new Date(),
              locked_until: null,
            }],
          };
        }

        // patch route: UPDATE auth_users SET display_name = COALESCE(…), role = COALESCE(…) …
        if (s.includes("display_name = COALESCE")) {
          const id = Number(params?.[0]);
          const newRole = (params?.[2] as string | null) ?? null;
          if (newRole) pendingWrites.set(id, { role: newRole });
          const base = sharedUsers.get(id)!;
          return {
            rows: [{
              id,
              email: `admin${id}@example.com`,
              display_name: `Admin ${id}`,
              role: newRole ?? base.role,
              is_active: base.is_active,
              created_at: new Date(),
              updated_at: new Date(),
              deactivated_at: null,
              locked_until: null,
            }],
          };
        }

        // Session revocations and audit writes are side-effect-only
        if (s.includes("UPDATE auth_sessions") || s.includes("INSERT INTO")) {
          return { rows: [] };
        }

        if (s.trim() === "COMMIT") {
          // Flush pending writes to shared state before releasing the lock so
          // the next transaction's activeAdminCount sees the committed values.
          for (const [id, changes] of pendingWrites) {
            const u = sharedUsers.get(id);
            if (u) Object.assign(u, changes);
          }
          releaseLock?.();
          releaseLock = null;
          return { rows: [] };
        }

        if (s.trim() === "ROLLBACK") {
          pendingWrites.clear();
          releaseLock?.();
          releaseLock = null;
          return { rows: [] };
        }

        return { rows: [] };
      }),
      release: vi.fn(),
    };
  }

  it("serializes concurrent deactivation of two admins so exactly one succeeds and one is rejected", async () => {
    // Both admins start active.  Whoever acquires the mutex first sees 2 active
    // admins and is allowed to deactivate; the second waits until the first
    // transaction commits (reducing the count to 1) and is then rejected as
    // LAST_ADMIN.  The 200/409 split emerges from concurrency, not fixtures.
    const sharedUsers: Map<number, UserRow> = new Map([
      [7, { id: 7, role: "admin", is_active: true }],
      [8, { id: 8, role: "admin", is_active: true }],
    ]);
    const mutex = new AsyncMutex();

    mocks.connect
      .mockResolvedValueOnce(makeAdminClient(sharedUsers, mutex))
      .mockResolvedValueOnce(makeAdminClient(sharedUsers, mutex));

    const [res1, res2] = await Promise.all([
      request(authApp(adminIdentity)).post("/auth/users/7/deactivate"),
      request(authApp(adminIdentity)).post("/auth/users/8/deactivate"),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const rejected = [res1, res2].find((r) => r.status === 409)!;
    expect(rejected.body.error).toContain("last active administrator");

    // After both transactions settle, shared state must show exactly one active
    // admin — confirming one deactivation actually committed.
    const remaining = [...sharedUsers.values()].filter((u) => u.is_active && u.role === "admin");
    expect(remaining).toHaveLength(1);
  });

  it("serializes a concurrent demotion and deactivation so exactly one succeeds and one is rejected", async () => {
    // One request demotes admin 8 to 'normal'; another simultaneously deactivates
    // admin 7.  If both succeeded there would be zero administrators.  The
    // advisory lock ensures exactly one commits; the other is blocked as LAST_ADMIN.
    const sharedUsers: Map<number, UserRow> = new Map([
      [7, { id: 7, role: "admin", is_active: true }],
      [8, { id: 8, role: "admin", is_active: true }],
    ]);
    const mutex = new AsyncMutex();

    mocks.connect
      .mockResolvedValueOnce(makeAdminClient(sharedUsers, mutex))
      .mockResolvedValueOnce(makeAdminClient(sharedUsers, mutex));

    const [resDemotion, resDeactivate] = await Promise.all([
      request(authApp(adminIdentity)).patch("/auth/users/8").send({ role: "normal" }),
      request(authApp(adminIdentity)).post("/auth/users/7/deactivate"),
    ]);

    const statuses = [resDemotion.status, resDeactivate.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const rejected = [resDemotion, resDeactivate].find((r) => r.status === 409)!;
    expect(rejected.body.error).toContain("last active administrator");

    // After both transactions, exactly one active administrator must remain —
    // either admin 7 (if demotion won) or admin 8 (if deactivation won).
    const activeAdmins = [...sharedUsers.values()].filter((u) => u.is_active && u.role === "admin");
    expect(activeAdmins).toHaveLength(1);
  });

  it("bootstraps three administrators idempotently without resetting existing hashes", async () => {
    process.env.AUTH_BOOTSTRAP_ADMINS = "one@example.com,two@example.com,three@example.com";
    process.env.AUTH_BOOTSTRAP_PASSWORD = "bootstrap-password-123";
    let nextId = 1;
    const client = {
      query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("INSERT INTO auth_users")) {
        const callNumber = client.query.mock.calls.filter(([calledSql]) =>
          String(calledSql).includes("INSERT INTO auth_users")).length;
        return callNumber <= 3 ? { rows: [{ id: nextId++ }] } : { rows: [] };
      }
      return { rows: [] };
      }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);

    await bootstrapAdministrators();
    await bootstrapAdministrators();

    const insertCalls = client.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO auth_users"));
    expect(insertCalls).toHaveLength(6);
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE auth_users") && String(sql).includes("password_hash"))).toBe(false);
    const firstRunHashes = insertCalls.slice(0, 3).map(([, params]) => params![2]);
    expect(new Set(firstRunHashes).size).toBe(3);
    expect(JSON.stringify(client.query.mock.calls)).not.toContain("bootstrap-password-123");
    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO auth_audit"))).toHaveLength(3);
  });
});
