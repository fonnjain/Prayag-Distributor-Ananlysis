import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/adminAuth.js", () => ({
  isAdminToken: vi.fn((token: string) => token === "valid-secret"),
}));

import { requireFrozenDriftAdmin } from "../lib/registers/frozenDriftAuth.js";
import { isAdminToken } from "../lib/adminAuth.js";

const dataAccess = vi.fn();
const dataHandler = (_req: express.Request, res: express.Response) => {
  dataAccess();
  res.json({ protected: true });
};
const app = express();
app.use((req, _res, next) => {
  const role = req.get("x-test-role");
  if (role === "admin" || role === "normal") {
    req.authUser = {
      id: role === "admin" ? 1 : 2,
      email: `${role}@example.com`,
      displayName: role,
      role,
      isActive: true,
      mustChangePassword: false,
    };
  }
  if (req.get("x-test-api-key")) req.apiKey = { id: 1, name: "test-key" };
  next();
});
const privileged = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (requireFrozenDriftAdmin(req, res)) next();
};
app.get("/registers/frozen-drift", privileged, dataHandler);
app.get("/registers/frozen-drift/:id", privileged, dataHandler);

describe("frozen drift route access", () => {
  beforeEach(() => {
    dataAccess.mockClear();
    vi.mocked(isAdminToken).mockImplementation((token: string) => token === "valid-secret");
  });

  for (const path of ["/registers/frozen-drift", "/registers/frozen-drift/42"]) {
    it(`rejects anonymous GET ${path}`, async () => {
      const response = await request(app).get(path);
      expect(response.status).toBe(401);
      expect(dataAccess).not.toHaveBeenCalled();
    });

    it(`rejects normal and API-key-only GET ${path}`, async () => {
      expect((await request(app).get(path).set("x-test-role", "normal")).status).toBe(403);
      expect((await request(app).get(path).set("x-test-api-key", "yes")).status).toBe(403);
      expect(dataAccess).not.toHaveBeenCalled();
    });

    it(`allows admin session and operator secret GET ${path}`, async () => {
      expect((await request(app).get(path).set("x-test-role", "admin")).status).toBe(200);
      expect((await request(app).get(path).set("x-admin-secret", "valid-secret")).status).toBe(200);
      expect(dataAccess).toHaveBeenCalledTimes(2);
    });
  }
});