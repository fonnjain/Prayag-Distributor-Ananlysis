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