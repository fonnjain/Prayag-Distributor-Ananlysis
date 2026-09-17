import { describe, expect, it } from "vitest";
import {
  buildSecondaryRegisterCoverageDisclosure,
  parseSecondaryCoverageMonthIndexes,
} from "./registerCoverage.js";

describe("secondary register H5 coverage", () => {
  it("parses fiscal month ranges from the Resolution Register", () => {
    expect(parseSecondaryCoverageMonthIndexes("April to June 2026")).toEqual([1, 2, 3]);
    expect(parseSecondaryCoverageMonthIndexes("Apr-Jun 2026")).toEqual([1, 2, 3]);
    expect(parseSecondaryCoverageMonthIndexes("July 2026")).toEqual([4]);
  });

  it("does not invent a range when the register field is empty", () => {
    expect(parseSecondaryCoverageMonthIndexes("")).toEqual([]);
    expect(parseSecondaryCoverageMonthIndexes("review pending")).toEqual([]);
  });

  it("formats the exact H5 disclosure from H5 scope/value and live differences", () => {
    const disclosure = buildSecondaryRegisterCoverageDisclosure({
      id: 457,
      owner: "Data Engineering",
      fiscalYear: "2026-27",
      targetMonths: ["Apr-26", "May-26", "Jun-26"],
      loadedMonths: ["Jul-26"],
      missingMonths: ["Apr-26", "May-26", "Jun-26"],
      missingRows: 89179,
      // Deliberately differ from H5 to prove the message uses H5 value_at_stake.
      missingNet: 1,
      h5ValueAtStake: 590203202,
    });
    expect(disclosure?.message).toBe(
      "FY2026-27 secondary register covers July 2026 only. " +
      "April to June 2026 - 89,179 lines, Rs 59.02 Cr - are not loaded. See Resolution H5.",
    );
  });

  it("removes the disclosure when the live difference reaches zero", () => {
    expect(buildSecondaryRegisterCoverageDisclosure({
      id: 457,
      owner: "Data Engineering",
      fiscalYear: "2026-27",
      targetMonths: ["Apr-26", "May-26", "Jun-26"],
      loadedMonths: ["Apr-26", "May-26", "Jun-26", "Jul-26"],
      missingMonths: [],
      missingRows: 0,
      missingNet: 0,
      h5ValueAtStake: 590203202,
    })).toBeNull();
  });

  it("does not describe non-contiguous loaded months as a range", () => {
    const disclosure = buildSecondaryRegisterCoverageDisclosure({
      id: 457,
      owner: "Data Engineering",
      fiscalYear: "2026-27",
      targetMonths: ["Apr-26", "May-26", "Jun-26"],
      loadedMonths: ["Apr-26", "Jun-26"],
      missingMonths: ["May-26"],
      missingRows: 1,
      missingNet: 1,
      h5ValueAtStake: 1,
    });
    expect(disclosure?.message).toContain("April 2026, June 2026 only.");
  });
});