import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: { query: mocks.query },
}));

vi.mock("./logger.js", () => ({
  logger: { error: mocks.error },
}));

import {
  consumeExternalReadQuota,
  EXTERNAL_READ_RATE_LIMIT,
  rateLimitExternalRead,
} from "./externalReadRateLimiter.js";

function response() {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

describe("external read rate limiter", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.error.mockReset();
  });

  it("uses one atomic Postgres upsert and allows the first request", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ request_count: 1, retry_after_seconds: 60 }],
    });

    await expect(consumeExternalReadQuota(42)).resolves.toEqual({
      allowed: true,
      requestCount: 1,
      retryAfterSeconds: 60,
    });
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO api_key_rate_limit");
    expect(String(sql)).toContain("ON CONFLICT (api_key_id) DO UPDATE");
    expect(params).toEqual([42, EXTERNAL_READ_RATE_LIMIT]);
  });

  it("returns 429 with Retry-After after the 60th request", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ request_count: EXTERNAL_READ_RATE_LIMIT + 1, retry_after_seconds: 17 }],
    });
    const res = response();
    const next = vi.fn();

    await rateLimitExternalRead(
      {
        method: "GET",
        path: "/external/sales-by-item",
        apiKey: { id: 42, name: "reader", scope: "external_read" },
      } as any,
      res as any,
      next,
    );

    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "17");
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: "Rate limit exceeded", retryAfter: 17 });
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed with a retry hint if Postgres is unavailable", async () => {
    mocks.query.mockRejectedValueOnce(new Error("database unavailable"));
    const res = response();
    const next = vi.fn();

    await rateLimitExternalRead(
      {
        method: "GET",
        path: "/external/margin-by-item",
        apiKey: { id: 42, name: "reader", scope: "external_read" },
      } as any,
      res as any,
      next,
    );

    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
  });

  it("does not touch Postgres for unrelated identities or paths", async () => {
    const next = vi.fn();
    const res = response();
    await rateLimitExternalRead(
      { method: "GET", path: "/external/sales-by-item", apiKey: { id: 1, name: "full", scope: "full_api" } } as any,
      res as any,
      next,
    );
    await rateLimitExternalRead(
      { method: "POST", path: "/external/sales-by-item", apiKey: { id: 1, name: "reader", scope: "external_read" } } as any,
      res as any,
      next,
    );
    expect(mocks.query).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });
});
