import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  canonicalMonthLabel,
  computeVisitPlan,
  forwardMonthChoices,
  aggregateStateHeadMonthPace,
  plannerTargetInputMetadata,
  type HistoricalFyCapacity,
} from "./visitPlan.js";
import { inferVisitCompletion, retailerIdentity } from "./visitPlanPersistence.js";
import type { RetailerRow } from "./memberSheet.js";

const history: HistoricalFyCapacity[] = [];
function row(overrides: Partial<RetailerRow>): RetailerRow {
  return {
    name: "Retailer",
    district: "Pune",
    city: null,
    distributor: "Distributor",
    distanceKm: 20,
    businessPlan: 0,
    visitsRequired: 0,
    orderBooking: 0,
    sale: 0,
    totalVisit: 0,
    achievementPct: null,
    isActive: false,
    lastActiveYear: null,
    lastYearOb: null,
    lastYearSale: null,
    ...overrides,
  };
}

describe("Prompt 94 Section A visit semantics", () => {
  it("keeps analytics ranking IDs separate from base-plan aggregation", () => {
    const routeSource = readFileSync(new URL("../../routes/aiPlan.ts", import.meta.url), "utf8");
    expect(routeSource).toContain("WITH current_plan_ids AS");
    expect(routeSource).toContain("JOIN current_plan_ids current_plan ON current_plan.id = p.id");
    expect(routeSource).toContain("GROUP BY p.id ORDER BY p.generated_at DESC");
    expect(routeSource).not.toContain("FROM (\\n         SELECT p.*,");
  });

  it("keeps the publish-visible current-revision index free of function expressions", () => {
    const migrationSource = readFileSync(
      new URL("../../../../../lib/db/src/runMigrations.ts", import.meta.url),
      "utf8",
    );
    expect(migrationSource).toContain(
      "ON visit_plan (member_norm, fy, month)\n        WHERE status <> 'superseded'",
    );
    expect(migrationSource).not.toContain(
      "ON visit_plan (lower(regexp_replace(member",
    );
  });

  it("canonicalizes accepted month spellings and exposes forward choices", () => {
    expect(canonicalMonthLabel("2026-27", "Apr-26")).toBe("Apr 26");
    expect(canonicalMonthLabel("2026-27", "April 26")).toBe("Apr 26");
    expect(canonicalMonthLabel("2026-27", "Apr 27")).toBeNull();
    expect(forwardMonthChoices("2026-27", new Date("2026-03-31T00:00:00Z"))).toContain("Apr 26");
  });

  it("does not turn unavailable visit values into recorded zeros", () => {
    const plan = computeVisitPlan([
      row({ name: "Recorded zero", totalVisit: 0, visitsRequired: 0 }),
      row({ name: "Unavailable", totalVisit: null, visitsRequired: null }),
    ], "2026-27", history, new Date("2026-04-15T00:00:00Z"));

    expect(plan.pattern.totalVisitsDone).toBe(0);
    expect(plan.pattern.totalVisitsRequired).toBe(0);
    expect(plan.pattern.unavailableTotalVisitRows).toBe(1);
    expect(plan.pattern.unavailableVisitsRequiredRows).toBe(1);
    const unavailable = plan.monthPlans.flatMap((month) => month.targets)
      .find((target) => target.name === "Unavailable");
    expect(unavailable).toBeUndefined();
  });

  it("exposes the three ranking defaults and counts default-ranked targets", () => {
    const plan = computeVisitPlan([
      row({ name: "Guessed rank", businessPlan: null, distanceKm: null, visitsRequired: null }),
    ], "2026-27", history, new Date("2026-04-15T00:00:00Z"));
    const target = plan.monthPlans.flatMap((month) => month.targets)[0];
    expect(target?.effectiveInputs).toEqual({
      businessPlan: 50000,
      distanceKm: 20,
      visitsRequired: 12,
    });
    expect(target?.defaultedInputs).toEqual(["businessPlan", "distanceKm", "visitsRequired"]);
    expect(plan.defaultedTargetCount).toBeGreaterThan(0);
    expect(plan.defaultedRankCount).toBeGreaterThan(0);
    expect(plannerTargetInputMetadata(row({ businessPlan: null, distanceKm: null, visitsRequired: null }))).toMatchObject({
      priorityScore: 2500,
      effectiveInputs: { businessPlan: 50000, distanceKm: 20, visitsRequired: 12 },
      defaultedInputs: ["businessPlan", "distanceKm", "visitsRequired"],
    });
  });
});

describe("Prompt 94 Section D inference honesty", () => {
  it("infers only a cumulative increase and labels it inferred", () => {
    const identity = retailerIdentity("A/B Retailer", "Pune");
    const result = inferVisitCompletion({
      retailerIdentity: identity,
      baselineTotalVisit: 2,
      baselineObservedAt: "2026-04-01T00:00:00.000Z",
      baselineOrderBooking: 100,
    }, row({ name: "A/B Retailer", totalVisit: 3, orderBooking: 125 }), "2026-05-01T00:00:00.000Z", "2026-05-01");
    expect(result.status).toBe("visited");
    expect(result.completionBasis).toBe("inferred_total_visit_increase");
    expect(result.evidence.inferenceLabel).toBe("inferred");
    expect(result.orderValueAfter).toBe(25);
  });

  it("does not infer from null-to-zero or unavailable current data", () => {
    const nullBaseline = inferVisitCompletion({
      retailerIdentity: "retailer|pune",
      baselineTotalVisit: null,
    }, row({ totalVisit: 0 }), "2026-05-01T00:00:00.000Z", "2026-05-01");
    const unavailableCurrent = inferVisitCompletion({
      retailerIdentity: "retailer|pune",
      baselineTotalVisit: 0,
    }, row({ totalVisit: null }), "2026-05-01T00:00:00.000Z", "2026-05-01");
    expect(nullBaseline.status).toBe("planned");
    expect(unavailableCurrent.status).toBe("planned");
    expect(unavailableCurrent.evidence.currentTotalVisit).toBeNull();
  });

  it("keeps a plan planned when the source observation is not newer", () => {
    const result = inferVisitCompletion({
      retailerIdentity: "retailer|pune",
      baselineTotalVisit: 2,
      baselineObservedAt: "2026-05-01T00:00:00.000Z",
      baselineOrderBooking: 100,
    }, row({ totalVisit: 3, orderBooking: 140 }), "2026-05-01T00:00:00.000Z", "2026-05-01");
    expect(result.status).toBe("planned");
    expect(result.orderValueAfter).toBeNull();
  });

  it("keeps an unchanged authoritative source observation planned", () => {
    const result = inferVisitCompletion({
      retailerIdentity: "retailer|pune",
      baselineTotalVisit: 2,
      baselineObservedAt: "2026-05-01T00:00:00.000Z",
      baselineSourceSnapshotHash: "same-source",
    }, row({ totalVisit: 2 }), "2026-05-02T00:00:00.000Z", "2026-05-02", "same-source");
    expect(result.status).toBe("planned");
  });

  it("only marks unchanged counts not visited after a changed source and month close", () => {
    const target = {
      retailerIdentity: "retailer|pune",
      baselineTotalVisit: 2,
      baselineObservedAt: "2026-04-15T00:00:00.000Z",
      baselineSourceSnapshotHash: "before",
    };
    const beforeClose = inferVisitCompletion(
      target, row({ totalVisit: 2 }), "2026-04-30T23:59:59.000Z", "2026-04-30", "after", "Apr 26",
    );
    const afterClose = inferVisitCompletion(
      target, row({ totalVisit: 2 }), "2026-05-01T00:00:01.000Z", "2026-05-01", "after", "Apr 26",
    );
    expect(beforeClose.status).toBe("planned");
    expect(afterClose.status).toBe("not_visited");
  });

  it("does not double-count a member's current plans across months", () => {
    const stateHeads = aggregateStateHeadMonthPace([
      {
        stateHead: "West",
        month: "Apr 26",
        sourceSnapshotHash: "apr",
        pattern: { totalVisitsDone: 8, proRatedRequired: 10 },
        capacity: { gap: -2, demonstratedRateDenominator: 20, demonstratedRateDenominatorAuthority: "calendar fallback", dataWindowEndDate: "2026-03-31" },
      },
      {
        stateHead: "West",
        month: "May 26",
        sourceSnapshotHash: "may",
        pattern: { totalVisitsDone: 3, proRatedRequired: 5 },
        capacity: { gap: 1, demonstratedRateDenominator: 25, demonstratedRateDenominatorAuthority: "calendar fallback", dataWindowEndDate: "2026-04-30" },
      },
    ]);
    expect(stateHeads).toHaveLength(2);
    expect(stateHeads.find((item) => item.month === "Apr 26")?.paceVisitsDone).toBe(8);
    expect(stateHeads.find((item) => item.month === "May 26")?.paceVisitsDone).toBe(3);
  });
});
