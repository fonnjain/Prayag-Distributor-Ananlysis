import { describe, expect, it } from "vitest";
import {
  coveragePersonSql,
  getUnverifiedCoverageAliasReview,
  unverifiedCoverageAliasReviewSql,
  unverifiedCoverageAliasStatusSql,
} from "./coverageAliases.js";

describe("coverage alias review registry", () => {
  it("keeps the Babu compatibility mapping explicit and unverified", () => {
    expect(getUnverifiedCoverageAliasReview({
      coveragePerson: "Taninki Ramesh Babu",
      stateCanon: "TAMIL NADU",
      fiscalYear: "2024-25",
    })).toMatchObject({
      status: "UNVERIFIED ALIAS",
      registerHead: "Babu",
    });
    expect(getUnverifiedCoverageAliasReview({
      coveragePerson: "Taninki Ramesh Babu",
      stateCanon: "TAMIL NADU",
      fiscalYear: "2026-27",
    })).toBeNull();
  });

  it("provides the same registry-backed SQL for reports and people detail", () => {
    expect(coveragePersonSql("sl.head_canon")).toContain("WHEN 'Babu' THEN 'Taninki Ramesh Babu'");
    expect(unverifiedCoverageAliasStatusSql("c", "coverage_person.name")).toContain("UNVERIFIED ALIAS");
    expect(unverifiedCoverageAliasStatusSql("c", "coverage_person.name")).toContain("'2023-24', '2024-25'");
    expect(unverifiedCoverageAliasReviewSql("c", "coverage_person.name")).toMatchObject({
      registerHeadLabel: expect.stringContaining("THEN 'Babu'"),
      reviewNote: expect.stringContaining("separate departed S.Babu record"),
    });
  });
});