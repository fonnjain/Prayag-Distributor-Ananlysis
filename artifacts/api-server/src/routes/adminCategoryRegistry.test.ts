import { describe, expect, it } from "vitest";
import { controlsPass } from "./adminCategoryRegistry.js";

const valid = {
  rows: 58_348,
  codes: 4_033,
  amount: "1387308970.80",
  mapped: 58_332,
  mapped_amount: "1387067399.80",
  unmapped: 16,
  unmapped_amount: "241571.00",
  overlapping: 0,
  masters: {
    "C P": [1134, "340660426.27"],
    PTMT: [1225, "434762190.24"],
    SINK: [201, "61920099.03"],
    HARDWARE: [165, "8877508.20"],
    PLUMBING: [1057, "469784966.07"],
    SANITARYWARE: [237, "71062209.99"],
  },
};

describe("Prompt 68 category-registry controls", () => {
  it("accepts the approved generation against the current cross-foot", () => {
    expect(controlsPass(valid)).toBe(true);
  });

  it("does not require the obsolete 4,000-code point-in-time snapshot", () => {
    expect(valid.codes).toBe(4_033);
    expect(valid.unmapped).toBe(16);
    expect(controlsPass(valid)).toBe(true);
  });

  it.each([
    ["missing rows", { mapped: 58_331 }],
    ["value drift", { mapped_amount: "1387067398.80" }],
    ["overlap", { overlapping: 1 }],
    ["missing master", { masters: { ...valid.masters, SINK: undefined } }],
    ["unexpected master", { masters: { ...valid.masters, Composite: [1, "1.00"] } }],
  ])("rejects %s", (_label, change) => {
    const candidate = { ...valid, ...change };
    if (candidate.masters.SINK === undefined) delete candidate.masters.SINK;
    expect(controlsPass(candidate)).toBe(false);
  });
});