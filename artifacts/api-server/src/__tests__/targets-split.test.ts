// Unit tests for the pro-rata target split: members with prior-FY actuals
// share pro-rata; members with none get an equal per-capita share; rounding
// drift is absorbed by the largest allocation so sums reconcile exactly.
import { describe, it, expect } from "vitest";
import { computeSplit, balanceSplit } from "../lib/mgmt/targets.js";

const totals = (secondary: number) => ({
  primary: null,
  secondary,
  directDealer: null,
  businessPlan: null,
});

describe("computeSplit", () => {
  it("splits pro-rata by prior-year actuals", () => {
    const split = computeSplit(
      [
        { name: "A", priorYearActual: 300 },
        { name: "B", priorYearActual: 100 },
      ],
      totals(1_200_000),
    );
    expect(split.map((s) => s.allocated.secondary)).toEqual([900_000, 300_000]);
    expect(split[0].allocated.primary).toBeNull();
  });

  it("gives no-data members an equal per-capita share and pro-rates the rest", () => {
    const split = computeSplit(
      [
        { name: "A", priorYearActual: 300 },
        { name: "B", priorYearActual: 100 },
        { name: "C", priorYearActual: 0 },
        { name: "D", priorYearActual: 0 },
      ],
      totals(1_200_000),
    );
    const by = Object.fromEntries(split.map((s) => [s.name, s.allocated.secondary]));
    // C and D each get 1/4 (equal split among members with none)
    expect(by.C).toBe(300_000);
    expect(by.D).toBe(300_000);
    // remaining half pro-rata 3:1 between A and B
    expect(by.A).toBe(450_000);
    expect(by.B).toBe(150_000);
  });

  it("splits equally when no member has prior data", () => {
    const split = computeSplit(
      [
        { name: "A", priorYearActual: 0 },
        { name: "B", priorYearActual: 0 },
        { name: "C", priorYearActual: 0 },
      ],
      totals(900_000),
    );
    expect(split.map((s) => s.allocated.secondary)).toEqual([300_000, 300_000, 300_000]);
  });

  it("reconciles to the entered total after balanceSplit absorbs rounding drift", () => {
    const t = totals(1_000_000);
    const split = computeSplit(
      [
        { name: "A", priorYearActual: 333 },
        { name: "B", priorYearActual: 333 },
        { name: "C", priorYearActual: 334 },
        { name: "D", priorYearActual: 0 },
      ],
      t,
    );
    balanceSplit(split, t);
    const sum = split.reduce((a, s) => a + (s.allocated.secondary ?? 0), 0);
    expect(sum).toBe(1_000_000);
  });
});
