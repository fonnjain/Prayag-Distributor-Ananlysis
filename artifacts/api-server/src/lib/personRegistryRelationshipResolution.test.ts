import { describe, expect, it } from "vitest";
import { validateOperationalHierarchy } from "./personRegistryRelationshipResolution.js";

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
});