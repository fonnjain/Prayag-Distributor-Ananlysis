import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const { requireExternalReadEndpointAccess } = vi.hoisted(() => ({
  requireExternalReadEndpointAccess: vi.fn((_req, res, _next) => {
    res.status(418).json({ error: "external auth invoked" });
  }),
}));

vi.mock("../lib/apiKeyAuth.js", () => ({
  requireExternalReadEndpointAccess,
}));

vi.mock("../lib/externalItemAnalytics.js", () => ({
  ExternalSourceChangedError: class extends Error {},
  ProvenanceUnavailableError: class extends Error {},
  parseExternalRequest: vi.fn(),
  readMarginByItem: vi.fn(),
  readSalesByItem: vi.fn(),
}));

import externalRouter from "./external.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  requireExternalReadEndpointAccess.mockClear();
});

describe("external router boundary", () => {
  it("does not apply external authentication to internal routes", async () => {
    const app = express();
    app.use(externalRouter);
    app.get("/dashboard", (_req, res) => res.json({ internal: true }));
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/dashboard`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ internal: true });
    expect(requireExternalReadEndpointAccess).not.toHaveBeenCalled();
  });

  it("applies external authentication under /external", async () => {
    const app = express();
    app.use(externalRouter);
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/external/sales-by-item`);

    expect(response.status).toBe(418);
    expect(requireExternalReadEndpointAccess).toHaveBeenCalledOnce();
  });
});