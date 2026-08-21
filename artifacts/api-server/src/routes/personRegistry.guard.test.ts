import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const patchRegistryRow = vi.fn();
const previewAliasImpact = vi.fn();
const loadPersonRegistry = vi.fn();
const isAdminToken = vi.fn();
const previewRegistryRelationshipResolution = vi.fn();
const resolveRegistryRelationship = vi.fn();

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
vi.mock("../lib/personRegistryRelationshipResolution.js", () => ({
  previewRegistryRelationshipResolution,
  resolveRegistryRelationship,
  RelationshipHierarchyInvalidError: class RelationshipHierarchyInvalidError extends Error {},
  RelationshipPreviewChangedError: class RelationshipPreviewChangedError extends Error {},
  RelationshipPreviewRequiredError: class RelationshipPreviewRequiredError extends Error {},
}));

const { default: orgRouter } = await import("./org.js");
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.header("x-test-user") === "admin") {
    req.authUser = {
      id: 1,
      email: "admin@example.com",
      displayName: "Verified Admin",
      role: "admin",
      isActive: true,
    };
  }
  next();
});
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
      .set("x-test-user", "admin")
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
      .set("x-test-user", "admin")
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
      { changedBy: "Verified Admin", reason: "Correct register spelling", acknowledgedImpact: impact },
    );
    expect(loadPersonRegistry).toHaveBeenCalledOnce();
  });

  it("returns a conflict when the impact preview became stale", async () => {
    isAdminToken.mockReturnValue(true);
    patchRegistryRow.mockRejectedValue(new RegistryImpactChangedError("Preview again"));

    const res = await request(app)
      .patch("/api/person-registry/10")
      .set("x-admin-secret", "valid-admin-secret")
      .set("x-test-user", "admin")
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
      .set("x-test-user", "admin")
      .send({
        stateHead: "A DIFFERENT HEAD",
        changedBy: "Nishant",
        reason: "Should not be editable here",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("stateHead is not editable");
    expect(patchRegistryRow).not.toHaveBeenCalled();
  });

  it("records the signed-in identity rather than accepting a claimed audit actor", async () => {
    isAdminToken.mockReturnValue(true);
    patchRegistryRow.mockResolvedValue({ id: 10, canonical_name: "Example Person" });
    const impact = {
      rowCount: 0,
      affectedCustomers: [],
      sourceUpdatedAt: "2026-08-21T00:00:00.000Z",
      proposalHash: "preview-bound-alias-hash",
    };

    const res = await request(app)
      .patch("/api/person-registry/10")
      .set("x-admin-secret", "valid-admin-secret")
      .set("x-test-user", "admin")
      .send({
        aliasPrimary: ["NEW ALIAS"],
        changedBy: "Impersonated Operator",
        reason: "Correct register spelling",
        acknowledgedImpact: impact,
      });

    expect(res.status).toBe(200);
    expect(patchRegistryRow).toHaveBeenLastCalledWith(
      10,
      expect.anything(),
      expect.objectContaining({ changedBy: "Verified Admin" }),
    );
  });

  it("requires a signed-in session in addition to the admin secret for an auditable write", async () => {
    isAdminToken.mockReturnValue(true);

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

    expect(res.status).toBe(401);
    expect(patchRegistryRow).not.toHaveBeenCalled();
  });
});

describe("relationship review mutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAdminToken.mockReturnValue(false);
  });

  it("requires the admin token before previewing a relationship decision", async () => {
    const res = await request(app)
      .get("/api/person-registry/10/relationship-preview?personId=5&effectiveDate=2026-08-21");

    expect(res.status).toBe(401);
    expect(previewRegistryRelationshipResolution).not.toHaveBeenCalled();
  });

  it("requires a signed-in operator as well as the admin token", async () => {
    isAdminToken.mockReturnValue(true);

    const res = await request(app)
      .get("/api/person-registry/10/relationship-preview?personId=5&effectiveDate=2026-08-21")
      .set("x-admin-secret", "valid-admin-secret");

    expect(res.status).toBe(401);
    expect(previewRegistryRelationshipResolution).not.toHaveBeenCalled();
  });

  it("passes a concrete People selection through the preview gate", async () => {
    isAdminToken.mockReturnValue(true);
    previewRegistryRelationshipResolution.mockResolvedValue({
      registry: { id: 10 },
      impact: { proposalHash: "preview-hash" },
    });

    const res = await request(app)
      .get("/api/person-registry/10/relationship-preview?personId=5&effectiveDate=2026-08-21")
      .set("x-admin-secret", "valid-admin-secret")
      .set("x-test-user", "admin");

    expect(res.status).toBe(200);
    expect(previewRegistryRelationshipResolution).toHaveBeenCalledWith(10, {
      personId: 5,
      effectiveDate: "2026-08-21",
    });
  });

  it("records an explicit unresolved decision with the session actor and preview hash", async () => {
    isAdminToken.mockReturnValue(true);
    resolveRegistryRelationship.mockResolvedValue({ registry: { id: 10 }, impact: {} });

    const res = await request(app)
      .post("/api/person-registry/10/relationship-resolution")
      .set("x-admin-secret", "valid-admin-secret")
      .set("x-test-user", "admin")
      .send({
        personId: null,
        effectiveDate: "2026-08-21",
        reason: "HR did not provide enough evidence",
        acknowledgedProposalHash: "preview-hash",
      });

    expect(res.status).toBe(200);
    expect(resolveRegistryRelationship).toHaveBeenCalledWith(10, {
      personId: null,
      effectiveDate: "2026-08-21",
      reason: "HR did not provide enough evidence",
      changedBy: "Verified Admin",
      acknowledgedProposalHash: "preview-hash",
    });
    expect(loadPersonRegistry).toHaveBeenCalledOnce();
  });

  it("requires a reason before the relationship service can change a link", async () => {
    isAdminToken.mockReturnValue(true);

    const res = await request(app)
      .post("/api/person-registry/10/relationship-resolution")
      .set("x-admin-secret", "valid-admin-secret")
      .set("x-test-user", "admin")
      .send({
        personId: 5,
        effectiveDate: "2026-08-21",
        reason: " ",
        acknowledgedProposalHash: "preview-hash",
      });

    expect(res.status).toBe(422);
    expect(resolveRegistryRelationship).not.toHaveBeenCalled();
  });
});