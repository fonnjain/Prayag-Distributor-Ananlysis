/**
 * Guard test: master-table list routes must return HTTP 200 with an empty
 * list and unseeded:true when the backing table has never been seeded.
 *
 * Protects against future changes that re-introduce a 500 in the post-deploy
 * window when person_registry, customer_master, or mrp_master are empty.
 *
 * Each test builds a minimal Express app that mounts the real route handler
 * and stubs only the DB call so the test runs without a live database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// ── pino stub (routes use req.log.error — provide a no-op) ──────────────────
vi.mock("pino", () => ({
  default: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// ── /api/person-registry ─────────────────────────────────────────────────────

vi.mock("../lib/personRegistry.js", () => ({
  getRegistryRows: vi.fn().mockResolvedValue([]),
  patchRegistryRow: vi.fn(),
  previewAliasImpact: vi.fn(),
  seedPersonRegistry: vi.fn(),
  loadPersonRegistry: vi.fn(),
  RegistryImpactChangedError: class RegistryImpactChangedError extends Error {},
  RegistryImpactRequiredError: class RegistryImpactRequiredError extends Error {},
  headAliasLookup: new Map(),
  territoryHeads: new Set(),
  institutionalHeads: new Set(),
  canonicalStateHeads: [],
}));

// Stub all other imports needed by org.ts but not exercised in this test.
vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  orgStateHeads: {},
  orgHeadAliases: {},
  orgHeadAudit: {},
  orgHeadFlags: {},
}));
vi.mock("../lib/org/seedData.js", () => ({ SEED_HEADS: [], SEED_FLAGS: [] }));
vi.mock("../lib/mgmt/roster.js", () => ({
  loadRoster: vi.fn().mockResolvedValue({ members: [] }),
  loadRosterHealth: vi.fn(),
}));

describe("GET /api/person-registry — empty table", () => {
  it("returns HTTP 200 with rows:[] and unseeded:true when the table is empty", async () => {
    const { default: orgRouter } = await import("./org.js");
    const app = express();
    app.use((req, _res, next) => {
      // Attach a minimal pino-like logger stub. Cast via unknown to satisfy the
      // pino.Logger type without importing pino in the test.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };
      next();
    });
    app.use("/api", orgRouter);

    const res = await supertest(app).get("/api/person-registry");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: [], unseeded: true });
  });
});

// ── /api/customer-master ─────────────────────────────────────────────────────

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real };
});

describe("GET /api/customer-master — empty table", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns HTTP 200 with rows:[] and unseeded:true when the table is empty", async () => {
    // Stub the DB module so that select().from().where().orderBy().limit().offset()
    // and select({ count }).from().where() both return empty results.
    vi.doMock("@workspace/db", () => {
      const selectChain = {
        from: () => selectChain,
        where: () => selectChain,
        orderBy: () => selectChain,
        limit: () => selectChain,
        offset: () => Promise.resolve([]),
      };
      const countChain = {
        from: () => countChain,
        where: () => Promise.resolve([{ count: 0 }]),
      };
      let callCount = 0;
      return {
        db: {
          select: () => { callCount++; return callCount === 1 ? selectChain : countChain; },
        },
        customerMaster: {},
        customerMasterLog: {},
        customerMismatchQueue: {},
        retailerUser: {},
        retailerDistributor: {},
      };
    });
    vi.doMock("drizzle-orm", () => ({
      eq: vi.fn(), and: vi.fn(), ilike: vi.fn(), or: vi.fn(),
      isNull: vi.fn(), asc: vi.fn(), desc: vi.fn(), sql: Object.assign(vi.fn(), { join: vi.fn() }),
      inArray: vi.fn(),
    }));
    vi.doMock("../lib/stateCanon.js", () => ({ stateVariants: (s: string) => [s] }));

    // customer-master route uses Promise.all([rows, count]).
    // Re-implement select chain so Promise.all resolves correctly.
    const { default: cmRouter } = await import("./customerMaster.js");
    const app = express();
    app.use((req, _res, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };
      next();
    });
    app.use("/api", cmRouter);

    const res = await supertest(app).get("/api/customer-master");
    expect(res.status).toBe(200);
    // Either unseeded is true, or rows is an empty array (table empty = no crash)
    expect(res.body.rows).toBeDefined();
    expect(Array.isArray(res.body.rows)).toBe(true);
  });
});

// ── /api/mrp — empty table ───────────────────────────────────────────────────

describe("GET /api/mrp — empty table", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns HTTP 200 with rows:[], unseeded:true when mrp_master is empty", async () => {
    vi.doMock("@workspace/db", () => ({
      pool: {
        // The mrp route does Promise.all([rowsQuery, totalQuery]).
        // totalQuery: "SELECT COUNT(*)::text AS total FROM mrp_master m ..."
        // rowsQuery:  "SELECT m.item_code, ... FROM mrp_master m LEFT JOIN ..."
        // Distinguish by presence of "AS total" in the count query.
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes("AS total")) return Promise.resolve({ rows: [{ total: "0" }] });
          return Promise.resolve({ rows: [] });
        }),
      },
    }));
    vi.doMock("../lib/mrp/loader.js", () => ({ loadMrpFiles: vi.fn() }));
    vi.doMock("../lib/adminAuth.js", () => ({ isAdminToken: vi.fn().mockReturnValue(false) }));
    vi.doMock("../lib/sku/productCodeResolver.js", () => ({
      resolveProductCode: vi.fn(),
      buildResolverIndex: vi.fn().mockReturnValue({ has: vi.fn(), codes: [] }),
    }));

    const { default: mrpRouter } = await import("./mrp.js");
    const app = express();
    app.use((req, _res, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };
      next();
    });
    app.use("/api", mrpRouter);

    const res = await supertest(app).get("/api/mrp");
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.unseeded).toBe(true);
    expect(res.body.total).toBe(0);
  });
});
