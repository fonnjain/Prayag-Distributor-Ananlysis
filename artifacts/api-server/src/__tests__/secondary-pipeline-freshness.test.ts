// Unit tests for the secondary sheet pipeline freshness classifier.
// Tests the pure classifySecondaryPipelineFreshness() function without any DB
// or Sheets access — the function takes pre-resolved inputs so every branch
// can be covered deterministically.

import { describe, expect, it } from "vitest";
import {
  classifySecondaryPipelineFreshness,
  SECONDARY_PIPELINE_STALE_DAYS,
} from "../lib/audit/extraGroups.js";

const NOW = new Date("2026-08-15T12:00:00Z");
const FY = "2026-27";

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

describe("classifySecondaryPipelineFreshness", () => {
  it("returns no_data when latestAt is null", () => {
    const result = classifySecondaryPipelineFreshness(null, 0, FY, NOW);
    expect(result.status).toBe("no_data");
    expect(result.daysSince).toBeNull();
    expect(result.note).toMatch(/never.*run|empty/i);
  });

  it("returns pass when last ingest is < 1 day ago", () => {
    const result = classifySecondaryPipelineFreshness(daysAgo(0.5), 10, FY, NOW);
    expect(result.status).toBe("pass");
    expect(result.daysSince).toBeCloseTo(0.5, 1);
    expect(result.note).toMatch(/current/i);
  });

  it("returns pass at exactly 1 day boundary", () => {
    const result = classifySecondaryPipelineFreshness(daysAgo(1), 10, FY, NOW);
    expect(result.status).toBe("pass");
  });

  it("returns warn when gap is between 1 and SECONDARY_PIPELINE_STALE_DAYS", () => {
    const result = classifySecondaryPipelineFreshness(daysAgo(1.5), 10, FY, NOW);
    expect(result.status).toBe("warn");
    expect(result.daysSince).toBeCloseTo(1.5, 1);
    expect(result.note).toMatch(/lagging/i);
  });

  it("returns fail when gap exceeds SECONDARY_PIPELINE_STALE_DAYS", () => {
    const staleDays = SECONDARY_PIPELINE_STALE_DAYS + 0.1;
    const result = classifySecondaryPipelineFreshness(daysAgo(staleDays), 10, FY, NOW);
    expect(result.status).toBe("fail");
    expect(result.daysSince).toBeGreaterThan(SECONDARY_PIPELINE_STALE_DAYS);
    expect(result.note).toMatch(/stall/i);
  });

  it("returns fail for a 27-day gap (the observed real-world scenario)", () => {
    const result = classifySecondaryPipelineFreshness(daysAgo(27), 161, FY, NOW);
    expect(result.status).toBe("fail");
    expect(result.note).toContain("161");
    expect(result.note).toMatch(/stall/i);
  });

  it("includes the FY label in every non-null note", () => {
    const cases = [null, daysAgo(0.5), daysAgo(1.5), daysAgo(3)];
    for (const latestAt of cases) {
      const result = classifySecondaryPipelineFreshness(latestAt, 5, FY, NOW);
      expect(result.note).toContain(FY);
    }
  });

  it("SECONDARY_PIPELINE_STALE_DAYS is 2 (tight enough to catch 8 missed ticks)", () => {
    expect(SECONDARY_PIPELINE_STALE_DAYS).toBe(2);
  });
});
