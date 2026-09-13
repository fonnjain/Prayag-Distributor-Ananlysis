import { describe, expect, it } from "vitest";
import { finalizeCheckGroup } from "./verifyFull.js";

describe("full audit expected-key manifests", () => {
  it("emits explicit pending rows when a dependency fails", () => {
    const group = finalizeCheckGroup(
      {
        id: "forced_dependency_failure",
        label: "Forced dependency failure",
        available: false,
        pendingNote: "Forced dependency failure for test coverage.",
        checks: [],
      },
      ["dependency_check_a", "dependency_check_b"],
    );

    expect(group.checks.map((check) => check.key)).toEqual([
      "dependency_check_a",
      "dependency_check_b",
    ]);
    expect(group.checks.every((check) => check.status === "pending")).toBe(true);
    expect(group.checks.every((check) => check.note?.includes("NOT EVALUATED"))).toBe(true);
    expect(group.checks.every((check) => check.evaluation === "not_evaluated")).toBe(true);
    expect(group.totals).toEqual({ expected: 2, evaluated: 0, notEvaluated: 2 });
  });

  it("counts evaluated and not-evaluated checks without changing statuses", () => {
    const group = finalizeCheckGroup(
      {
        id: "mixed",
        label: "Mixed",
        available: true,
        checks: [{
          key: "pass_check",
          label: "Pass",
          unit: "count",
          expected: 1,
          actual: 1,
          deltaPct: 0,
          status: "pass",
        }, {
          key: "known_skip",
          label: "Skip",
          unit: "text",
          expected: null,
          actual: null,
          deltaPct: null,
          status: "skip",
        }],
      },
      ["pass_check", "known_skip", "missing_check"],
    );

    expect(group.totals).toEqual({ expected: 3, evaluated: 2, notEvaluated: 1 });
    expect(group.checks.find((check) => check.key === "known_skip")?.status).toBe("skip");
    expect(group.checks.find((check) => check.key === "known_skip")?.evaluation).toBe("evaluated");
  });

  it("rejects an evaluator output key that was not predeclared", () => {
    expect(() => finalizeCheckGroup(
      {
        id: "undeclared",
        label: "Undeclared",
        available: true,
        checks: [{
          key: "unexpected",
          label: "Unexpected",
          unit: "text",
          expected: null,
          actual: null,
          deltaPct: null,
          status: "skip",
        }],
      },
      ["declared"],
    )).toThrow(/undeclared check key.*unexpected/i);
  });
});