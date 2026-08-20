import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: { query: vi.fn() },
}));

vi.mock("../lib/adminAuth.js", () => ({
  isAdminToken: vi.fn().mockReturnValue(false),
}));

vi.mock("../lib/canonicalCoverageReport.js", () => ({
  auditCanonicalCoverageDrift: vi.fn(),
  buildCanonicalCoverageDriftCheck: vi.fn(),
  buildCanonicalCoverageReport: vi.fn(),
  buildCanonicalCoverageWorkbook: vi.fn(),
}));

import { isAdminToken } from "../lib/adminAuth.js";
import {
  auditCanonicalCoverageDrift,
  buildCanonicalCoverageDriftCheck,
} from "../lib/canonicalCoverageReport.js";
import canonicalCoverageRouter from "./canonicalCoverage.js";

const app = express();
app.use((req, _res, next) => {
  const role = req.header("x-test-role");
  if (role === "admin" || role === "normal") {
    req.authUser = {
      id: role === "admin" ? 1 : 2,
      email: `${role}@example.com`,
      displayName: role,
      role,
      isActive: true,
    };
  }
  next();
});
app.use(canonicalCoverageRouter);

describe("POST /master/coverage-drift/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAdminToken).mockReturnValue(false);
  });

  it("refuses ordinary authenticated callers from creating a manual audit", async () => {
    const res = await request(app)
      .post("/master/coverage-drift/check?fy=2026-27")
      .set("x-test-role", "normal");

    expect(res.status).toBe(403);
    expect(auditCanonicalCoverageDrift).not.toHaveBeenCalled();
  });

  it("allows an operator secret to create a manual reviewable check", async () => {
    vi.mocked(isAdminToken).mockReturnValue(true);
    vi.mocked(auditCanonicalCoverageDrift).mockResolvedValue({
      checkedAt: "2026-08-20T00:00:00.000Z",
      fiscalYear: "2026-27",
      passed: true,
      issueCount: 0,
      issues: [],
      concentrationWarnings: [],
    });

    const res = await request(app)
      .post("/master/coverage-drift/check?fy=2026-27")
      .set("x-admin-secret", "valid-operator-secret");

    expect(res.status).toBe(200);
    expect(auditCanonicalCoverageDrift).toHaveBeenCalledWith("manual", "2026-27");
    expect(res.body.warning).toBeNull();
  });
});

describe("GET /master/coverage-drift/current", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAdminToken).mockReturnValue(false);
  });

  it("serves a current read-only drift review without writing an audit event", async () => {
    vi.mocked(buildCanonicalCoverageDriftCheck).mockResolvedValue({
      checkedAt: "2026-08-20T00:00:00.000Z",
      fiscalYear: "2025-26",
      passed: false,
      issueCount: 1,
      issues: [{
        kind: "coverage-mismatch",
        stateCanon: "TAMIL NADU",
        fiscalYear: "2025-26",
        customer: null,
        detail: { review: { coverageWasChanged: false } },
      }],
      concentrationWarnings: [{
        stateCanon: "TAMIL NADU",
        fiscalYear: "2025-26",
        customer: "GRAHAA PRIYA ENTERPRISES",
        customerCount: 1,
        customerNetAmount: 94_025_777.70,
        stateNetAmount: 94_025_777.70,
        sharePercent: 100,
        coverageRows: 1,
        coveragePeople: ["Sandeep Dadheech"],
        responsibleHeads: ["Sandeep Dadheech"],
        message: "Review concentration; coverage was not changed.",
      }],
    });

    const res = await request(app)
      .get("/master/coverage-drift/current?fy=2025-26")
      .set("x-test-role", "normal");

    expect(res.status).toBe(409);
    expect(buildCanonicalCoverageDriftCheck).toHaveBeenCalledWith("2025-26");
    expect(auditCanonicalCoverageDrift).not.toHaveBeenCalled();
    expect(res.body.concentrationWarnings[0]).toMatchObject({
      customer: "GRAHAA PRIYA ENTERPRISES",
      sharePercent: 100,
    });
    expect(res.body.warning).toContain("not changed automatically");
  });

  it("rejects anonymous access to current drift and history evidence", async () => {
    const [current, history] = await Promise.all([
      request(app).get("/master/coverage-drift/current"),
      request(app).get("/master/coverage-drift"),
    ]);

    expect(current.status).toBe(401);
    expect(history.status).toBe(401);
    expect(buildCanonicalCoverageDriftCheck).not.toHaveBeenCalled();
  });
});