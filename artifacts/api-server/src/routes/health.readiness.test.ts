/**
 * Guard test: /api/healthz must be reachable even when the server has not yet
 * completed its post-listen background initialisation (isServerReady() === false).
 *
 * The critical invariant is that healthRouter is mounted BEFORE requireServerReady
 * in routes/index.ts.  A future refactor that accidentally reverses this order
 * would make the deployment health-check return 503, causing the platform to
 * declare the instance unhealthy before any real request is served.
 *
 * This file tests three things:
 *   A. /api/healthz returns 200 while the server is still warming up.
 *   B. A data-heavy route (/api/dashboard) returns 503 + Retry-After while warming.
 *   C. If the health route were mounted AFTER requireServerReady (wrong order),
 *      test A would fail — proving the test catches the regression.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Router } from "express";
import supertest from "supertest";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an app that mirrors the mounting order of routes/index.ts:
 *   healthRouter  →  requireServerReady  →  dummy data route
 *
 * `isReady` controls what requireServerReady reports without mutating module state.
 */
function buildApp(
  opts: { isReady: boolean; mountHealthBeforeGate: boolean } = {
    isReady: false,
    mountHealthBeforeGate: true,
  },
) {
  const app = express();

  // Inline health router (mirrors src/routes/health.ts without the Zod dep)
  const healthRouter: Router = express.Router();
  healthRouter.get("/api/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Inline readiness gate (mirrors src/lib/serverReadiness.ts behaviour)
  function requireServerReady(
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void {
    if (opts.isReady) return next();
    res.setHeader("Retry-After", "30");
    res.status(503).json({ status: "warming_up" });
  }

  // Dummy data-heavy route that would normally be gated
  const dashboardRouter: Router = express.Router();
  dashboardRouter.get("/api/dashboard", (_req, res) => {
    res.status(200).json({ data: "ok" });
  });

  if (opts.mountHealthBeforeGate) {
    // CORRECT order — matches routes/index.ts
    app.use(healthRouter);
    app.use(requireServerReady);
    app.use(dashboardRouter);
  } else {
    // WRONG order — health endpoint is gated (regression scenario)
    app.use(requireServerReady);
    app.use(healthRouter);
    app.use(dashboardRouter);
  }

  return app;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("health endpoint is never gated by requireServerReady", () => {
  it("A — GET /api/healthz returns 200 while the server is still warming up (isReady=false)", async () => {
    const app = buildApp({ isReady: false, mountHealthBeforeGate: true });
    const res = await supertest(app).get("/api/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });

  it("B — GET /api/dashboard returns 503 with Retry-After while the server is still warming up (isReady=false)", async () => {
    const app = buildApp({ isReady: false, mountHealthBeforeGate: true });
    const res = await supertest(app).get("/api/dashboard");

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.body).toMatchObject({ status: "warming_up" });
  });

  it("B2 — GET /api/dashboard returns 200 once the server is ready (isReady=true)", async () => {
    const app = buildApp({ isReady: true, mountHealthBeforeGate: true });
    const res = await supertest(app).get("/api/dashboard");

    expect(res.status).toBe(200);
  });

  it("C — regression guard: mounting healthRouter AFTER requireServerReady causes /api/healthz to return 503 (the bad case)", async () => {
    // This test documents what the broken ordering looks like — if someone
    // moves healthRouter after requireServerReady, the endpoint returns 503.
    const app = buildApp({ isReady: false, mountHealthBeforeGate: false });
    const res = await supertest(app).get("/api/healthz");

    // With wrong order the gate fires first → 503
    expect(res.status).toBe(503);
  });
});

// ── import-order guard against routes/index.ts ────────────────────────────────
// This section verifies the ACTUAL routes/index.ts from the codebase has
// healthRouter mounted before requireServerReady.  It inspects the source text
// rather than importing the module (which would pull in DB connections).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

describe("routes/index.ts mount order", () => {
  it("healthRouter is registered before requireServerReady in the source file", () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const indexPath = path.resolve(__dirname, "index.ts");
    const source = fs.readFileSync(indexPath, "utf8");

    const lines = source.split("\n");

    // Find the line positions of the two critical router.use() calls.
    const healthLine = lines.findIndex((l) =>
      l.includes("router.use(healthRouter)"),
    );
    const gateLine = lines.findIndex((l) =>
      l.includes("router.use(requireServerReady)"),
    );

    expect(healthLine, "router.use(healthRouter) not found in routes/index.ts").toBeGreaterThanOrEqual(0);
    expect(gateLine, "router.use(requireServerReady) not found in routes/index.ts").toBeGreaterThanOrEqual(0);

    expect(
      healthLine,
      `healthRouter (line ${healthLine + 1}) must be mounted BEFORE requireServerReady (line ${gateLine + 1}) — reversing this order makes /api/healthz return 503 during warmup`,
    ).toBeLessThan(gateLine);
  });
});
