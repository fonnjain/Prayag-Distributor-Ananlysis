import { describe, expect, it } from "vitest";
import { normalizeSchemeMaster } from "../schemeMasterAdapter";

describe("normalizeSchemeMaster", () => {
  it("adapts the live DB-backed scheme and slab rows", () => {
    const result = normalizeSchemeMaster({
      _source: "database",
      schemes: [{
        scheme_id: "CP_LALAN",
        name: "CP Lalan Scheme",
        qualification_basis: "cumulative_value",
        territory_group: "BIHAR + JHARKHAND",
      }],
      slabs: [
        {
          scheme_id: "CP_LALAN",
          slab_order: 2,
          threshold_from: "200000",
          rate: "0.05",
          alt_reward: null,
          free_goods: null,
        },
        {
          scheme_id: "CP_LALAN",
          slab_order: 1,
          threshold_from: "100000",
          rate: "0.025",
          alt_reward: null,
          free_goods: null,
        },
      ],
    });

    expect(result.schemes).toEqual([{
      id: "CP_LALAN",
      name: "CP Lalan Scheme",
      basis: "cumulative_value",
      stateRestriction: ["BIHAR + JHARKHAND"],
      slabs: [
        { threshold: 100000, rate: 0.025, reward: null, rewardType: "pct" },
        { threshold: 200000, rate: 0.05, reward: null, rewardType: "pct" },
      ],
    }]);
  });

  it("fails explicitly instead of passing a malformed response to render", () => {
    expect(() => normalizeSchemeMaster({ error: "Unauthorized" }))
      .toThrow("missing its schemes list");
  });
});