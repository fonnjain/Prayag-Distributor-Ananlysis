import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: mocks.select,
    update: mocks.update,
  },
  pool: { connect: vi.fn() },
}));

vi.mock("./logger.js", () => ({
  logger: {
    error: mocks.error,
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { resolveApiKey } from "./apiKeyAuth.js";

type ApiKeyRow = {
  id: number;
  name: string;
  scope: "full_api" | "verification" | "external_read";
  isRevoked: boolean;
};

let selectedRows: ApiKeyRow[] = [];

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

function request(headers: Record<string, string>, method = "GET", path = "/external/sales-by-item") {
  return {
    headers,
    method,
    path,
    log: { error: vi.fn() },
  };
}

function setSelectedRow(row: ApiKeyRow | null) {
  selectedRows = row ? [row] : [];
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(selectedRows),
  };
  mocks.select.mockReturnValue(query);
  mocks.update.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

describe("API-key header resolution", () => {
  beforeEach(() => {
    mocks.select.mockReset();
    mocks.update.mockReset();
    mocks.error.mockReset();
    setSelectedRow({
      id: 9,
      name: "external reader",
      scope: "external_read",
      isRevoked: false,
    });
  });

  it("resolves X-API-Key through the hashed api_keys lookup", async () => {
    const raw = "pk_external_reader";
    const req = request({ "x-api-key": raw });
    const res = response();
    const next = vi.fn();

    await resolveApiKey(req as any, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any).apiKey).toMatchObject({
      id: 9,
      name: "external reader",
      scope: "external_read",
    });
    // X-API-Key uses resolveApiKey's same api_keys query path as Bearer.
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it("does not accept X-API-Key outside the two exact external GET paths", async () => {
    const cases = [
      { method: "GET", path: "/customers" },
      { method: "POST", path: "/external/sales-by-item" },
      { method: "GET", path: "/external/sales-by-item/" },
    ];
    for (const item of cases) {
      mocks.select.mockReset();
      const res = response();
      const next = vi.fn();
      await resolveApiKey(
        request({ "x-api-key": "pk_external_reader" }, item.method, item.path) as any,
        res as any,
        next,
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
      expect(mocks.select).not.toHaveBeenCalled();
    }
  });

  it("requires an API-key credential on external paths, excluding sessions and secrets", async () => {
    const res = response();
    const next = vi.fn();
    await resolveApiKey(
      request({}, "GET", "/external/margin-by-item") as any,
      res as any,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each([
    ["full_api", 403],
    ["verification", 403],
  ] as const)("rejects an X-API-Key resolved to %s on external reads", async (scope, status) => {
    setSelectedRow({
      id: 10,
      name: scope,
      scope,
      isRevoked: false,
    });
    const res = response();
    const next = vi.fn();

    await resolveApiKey(
      request({ "x-api-key": "pk_wrong_scope" }) as any,
      res as any,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(status);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects conflicting Bearer and X-API-Key credentials before lookup", async () => {
    const res = response();
    const next = vi.fn();

    await resolveApiKey(
      request({
        authorization: "Bearer pk_one",
        "x-api-key": "pk_two",
      }) as any,
      res as any,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Conflicting Bearer and X-API-Key credentials",
    });
    expect(next).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("allows matching Bearer and X-API-Key credentials without a second identity", async () => {
    const raw = "pk_same_credential";
    const res = response();
    const next = vi.fn();

    await resolveApiKey(
      request({
        authorization: `Bearer ${raw}`,
        "x-api-key": raw,
      }) as any,
      res as any,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it("rejects revoked X-API-Key credentials", async () => {
    setSelectedRow({
      id: 11,
      name: "revoked reader",
      scope: "external_read",
      isRevoked: true,
    });
    const res = response();
    const next = vi.fn();

    await resolveApiKey(
      request({ "x-api-key": "pk_revoked" }) as any,
      res as any,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
