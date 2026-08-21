import { describe, expect, it } from "vitest";
import {
  assertNoOtherCurrentManualLink,
  RelationshipPersonAlreadyLinkedError,
  validateOperationalHierarchy,
} from "./personRegistryRelationshipResolution.js";

describe("operational hierarchy validation", () => {
  it("accepts a graph with neither self-links nor cycles", async () => {
    const hierarchy = await validateOperationalHierarchy({
      query: async () => ({ rows: [] }),
    });

    expect(hierarchy).toEqual({
      valid: true,
      selfLinkPersonIds: [],
      cyclePersonIds: [],
    });
  });

  it("reports self-links and indirect cycles before a registry relationship can be saved", async () => {
    const hierarchy = await validateOperationalHierarchy({
      query: async (sql: string) => ({
        rows: sql.includes("reports_to_person_id = person_id")
          ? [{ person_id: 4 }]
          : [{ person_id: 7 }, { person_id: 8 }],
      }),
    });

    expect(hierarchy).toEqual({
      valid: false,
      selfLinkPersonIds: [4],
      cyclePersonIds: [7, 8],
    });
  });

  it("rejects a second current manual relationship decision for the same People record", async () => {
    const query = async () => ({
      rows: [{ registry_id: 24, canonical_name: "Existing Registry Identity" }],
    });

    await expect(assertNoOtherCurrentManualLink({ query }, 7, 25)).rejects.toEqual(
      expect.objectContaining({
        personId: 7,
        existingRegistryId: 24,
        existingCanonicalName: "Existing Registry Identity",
      }),
    );
    await expect(assertNoOtherCurrentManualLink({ query }, 7, 25)).rejects.toBeInstanceOf(
      RelationshipPersonAlreadyLinkedError,
    );
  });

  it("checks only current linked decisions and locks the row during a save", async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    };

    await expect(assertNoOtherCurrentManualLink({ query }, 7, 25, true)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ params: [7, 25] });
    expect(calls[0].sql).toContain("resolution.decision = 'linked'");
    expect(calls[0].sql).toContain("resolution.superseded_at IS NULL");
    expect(calls[0].sql).toContain("FOR UPDATE OF resolution");
  });
});