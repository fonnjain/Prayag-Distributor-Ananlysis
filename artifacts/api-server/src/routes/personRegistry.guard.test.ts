import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const patchRegistryRow = vi.fn();
const previewAliasImpact = vi.fn();
const loadPersonRegistry = vi.fn();
const isAdminToken = vi.fn();

class RegistryImpactRequiredError extends Error {}
class RegistryImpactChangedError extends Error {}

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
vi.mock("../lib/adminAuth.js", () => ({ isAdminToken }));
vi.mock("../lib/personRegistry.js", () => ({
  getRegistryRows: vi.fn(),
  patchRegistryRow,
  previewAliasImpact,
  seedPersonRegistry: vi.fn(),
  loadPersonRegistry,
  RegistryImpactChangedError,
  RegistryImpactRequiredError,
}));

const { default: orgRouter } = await import("./org.js");
const app = express();
app.use(express.json());
app.use("/api", orgRouter);

describe("PATCH /api/person-registry/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdminToken.mockReturnValue(false);
  });

  it("rejects an unauthorised alias mutation before it reaches the registry service", async () => {
    const res = await request(app)
      .patch("/api/person-registry/10")
      .send({
        aliasPrimary: ["NEW ALIAS"],
        changedBy: "Nishant",
        reason: "Correct register spelling",
      });

    expect(res.status).toBe(401);
    expect(patchRegistryRow).not.toHaveBeenCalled();
  });

  it("requires an identified operator and reason on every authorised registry edit", async () => {
    isAdminToken.mockReturnValue(true);

    const res = await request(app)
      .patch("/api/person-registry/10")
      .set("x-admin-secret", "valid-admin-secret")
      .send({ aliasPrimary: ["NEW ALIAS"], changedBy: "Nishant" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("changedBy and reason");
    expect(patchRegistryRow).not.toHaveBeenCalled();
  });

  it("passes the operator, reason, and acknowledged impact to the transactional registry service", async () => {
    isAdminToken.mockReturnValue(true);
    patchRegistryRow.mockResolvedValue({ id: 10, canonical_name: "Example Person" });
    const impact = {
      rowCount: 7,
      affectedCustomers: ["EXAMPLE HEAD"],
      sourceUpdatedAt: "2026-08-21T00:00:00.000Z",
      proposalHash: "preview-bound-alias-hash",
    };

    const res = await request(app)
      .patch("/api/person-registry/10")
      .set("x-admin-secret", "valid-admin-secret")
      .send({
        aliasPrimary: ["NEW ALIAS"],
        changedBy: "Nishant",
        reason: "Correct register spelling",
        acknowledgedImpact: impact,
      });

    expect(res.status).toBe(200);
    expect(patchRegistryRow).toHaveBeenCalledWith(
      10,
      expect.objectContaining({ aliasPrimary: ["NEW ALIAS"] }),
      { changedBy: "Nishant", reason: "Correct register spelling", acknowledgedImpact: impact },
    );
    expect(loadPersonRegistry).toHaveBeenCalledOnce();
  });

  it("returns a conflict when the impact preview became stale", async () => {
    isAdminToken.mockReturnValue(true);
    patchRegistryRow.mockRejectedValue(new RegistryImpactChangedError("Preview again"));

    const res = await request(app)
      .patch("/api/person-registry/10")
      .set("x-admin-secret", "valid-admin-secret")
      .send({
        aliasPrimary: ["NEW ALIAS"],
        changedBy: "Nishant",
        reason: "Correct register spelling",
        acknowledgedImpact: {
          rowCount: 0,
          affectedCustomers: [],
          sourceUpdatedAt: "2026-08-21T00:00:00.000Z",
          proposalHash: "preview-bound-alias-hash",
        },
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Preview again");
  });

  it("rejects non-alias registry fields rather than silently widening the editor", async () => {
    isAdminToken.mockReturnValue(true);

    const res = await request(app)
      .patch("/api/person-registry/10")
      .set("x-admin-secret", "valid-admin-secret")
      .send({
        stateHead: "A DIFFERENT HEAD",
        changedBy: "Nishant",
        reason: "Should not be editable here",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("stateHead is not editable");
    expect(patchRegistryRow).not.toHaveBeenCalled();
  });
});