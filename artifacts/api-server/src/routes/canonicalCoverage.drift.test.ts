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
  buildCanonicalCoverageReport: vi.fn(),
  buildCanonicalCoverageWorkbook: vi.fn(),
}));

import { isAdminToken } from "../lib/adminAuth.js";
import { auditCanonicalCoverageDrift } from "../lib/canonicalCoverageReport.js";
import canonicalCoverageRouter from "./canonicalCoverage.js";

const app = express();
app.use(canonicalCoverageRouter);

describe("POST /master/coverage-drift/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses ordinary authenticated callers from creating a manual audit", async () => {
    const res = await request(app).post("/master/coverage-drift/check?fy=2026-27");

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
    });

    const res = await request(app)
      .post("/master/coverage-drift/check?fy=2026-27")
      .set("x-admin-secret", "valid-operator-secret");

    expect(res.status).toBe(200);
    expect(auditCanonicalCoverageDrift).toHaveBeenCalledWith("manual", "2026-27");
    expect(res.body.warning).toBeNull();
  });
});