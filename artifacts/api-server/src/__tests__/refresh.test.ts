// Integration tests for POST /dashboard/refresh: the happy path (fixture
// workbooks -> live snapshot with correct control totals) and the failure path
// (sync throws -> last good snapshot is served with a refreshError, never a
// blank response).
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { truncateSnapshots, snapshotCount } from "./setup-db.js";
import {
  EXPECTED_ORDERS_YTD_CR,
  FY2425_CONTROL_TOTAL,
  fixtureForFileId,
} from "./helpers.js";

vi.mock("../lib/sheets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sheets.js")>();
  return { ...actual, fetchWorkbook: vi.fn() };
});

import { fetchWorkbook } from "../lib/sheets.js";
import dashboardRouter from "../routes/dashboard.js";
import { ensureSeeded } from "../lib/dashboard/sync.js";

const fetchWorkbookMock = vi.mocked(fetchWorkbook);

function makeApp() {
  const app = express();
  app.use(express.json());
  // The routes use req.log (normally attached by pino-http); stub it here.
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    };
    next();
  });
  app.use("/api", dashboardRouter);
  return app;
}

const app = makeApp();

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateSnapshots();
});

describe("POST /api/dashboard/refresh", () => {
  it("builds a live snapshot from the fixture workbooks with correct totals", async () => {
    fetchWorkbookMock.mockImplementation(fixtureForFileId);

    const res = await request(app).post("/api/dashboard/refresh");

    expect(res.status).toBe(200);
    expect(res.body.refreshError).toBeUndefined();
    expect(res.body.sourceStatus).toBe("live");

    const data = res.body.data;
    expect(data.fy2425.grand_total).toBe(FY2425_CONTROL_TOTAL);
    expect(data.totals.fy2425_sales_inr).toBe(FY2425_CONTROL_TOTAL);
    expect(data.totals.orders_fy2627_ytd_cr).toBe(EXPECTED_ORDERS_YTD_CR);
    // Seed-sourced sections must still be merged in.
    expect(data.coverage).toBeDefined();
    expect(data.heads_resources).toBeDefined();
    expect(res.body.manifest.data_mode).toBe("live");

    // Exactly one new snapshot row was persisted.
    expect(await snapshotCount()).toBe(1);
  });

  it("returns the last good snapshot plus refreshError when the sync throws", async () => {
    // Establish a known-good snapshot first (the seed baseline).
    await ensureSeeded();
    expect(await snapshotCount()).toBe(1);

    fetchWorkbookMock.mockRejectedValue(
      new Error("Google Drive export failed (simulated)"),
    );

    const res = await request(app).post("/api/dashboard/refresh");

    expect(res.status).toBe(200);
    expect(typeof res.body.refreshError).toBe("string");
    expect(res.body.refreshError.length).toBeGreaterThan(0);
    // The response still carries full dashboard data (never blank).
    expect(res.body.data).toBeDefined();
    expect(res.body.data.totals).toBeDefined();
    expect(res.body.sourceStatus).toBe("seed");
    // The failed sync must not have persisted anything.
    expect(await snapshotCount()).toBe(1);
  });

  it("returns 502 when the sync throws and no previous snapshot exists", async () => {
    fetchWorkbookMock.mockRejectedValue(new Error("simulated failure"));

    const res = await request(app).post("/api/dashboard/refresh");

    expect(res.status).toBe(502);
    expect(typeof res.body.error).toBe("string");
    expect(await snapshotCount()).toBe(0);
  });
});

describe("GET /api/dashboard", () => {
  it("serves the seed baseline on first request (empty table)", async () => {
    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.sourceStatus).toBe("seed");
    expect(res.body.data.totals).toBeDefined();
    expect(await snapshotCount()).toBe(1);
  });
});
