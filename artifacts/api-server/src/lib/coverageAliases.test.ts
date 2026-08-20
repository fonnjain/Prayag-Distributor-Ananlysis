import { describe, expect, it } from "vitest";
import {
  coveragePersonSql,
  getUnverifiedCoverageAliasReview,
  unverifiedCoverageAliasReviewSql,
  unverifiedCoverageAliasStatusSql,
} from "./coverageAliases.js";

describe("coverage alias review registry", () => {
  it("keeps the confirmed Babu compatibility mapping explicit without a review warning", () => {
    expect(getUnverifiedCoverageAliasReview({
      coveragePerson: "Taninki Ramesh Babu",
      stateCanon: "TAMIL NADU",
      fiscalYear: "2024-25",
    })).toBeNull();
    expect(getUnverifiedCoverageAliasReview({
      coveragePerson: "Taninki Ramesh Babu",
      stateCanon: "TAMIL NADU",
      fiscalYear: "2026-27",
    })).toBeNull();
  });

  it("keeps confirmed aliases in matching SQL without emitting an unverified warning", () => {
    expect(coveragePersonSql("sl.head_canon")).toContain("WHEN 'Babu' THEN 'Taninki Ramesh Babu'");
    expect(unverifiedCoverageAliasStatusSql("c", "coverage_person.name")).toBe("NULL");
    expect(unverifiedCoverageAliasReviewSql("c", "coverage_person.name")).toEqual({
      status: "NULL",
      registerHeadLabel: "NULL",
      reviewNote: "NULL",
    });
  });
});