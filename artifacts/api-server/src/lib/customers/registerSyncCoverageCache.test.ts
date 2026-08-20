import { describe, expect, it } from "vitest";
import { hasSuccessfulOpenMonthReplacement } from "./registerSyncCoverageCache.js";

describe("register-sync coverage cache invalidation boundary", () => {
  it("invalidates only when an open month was actually replaced", () => {
    expect(hasSuccessfulOpenMonthReplacement([
      { action: "aborted-short-read" },
      { action: "failed" },
      { action: "frozen-skipped" },
    ])).toBe(false);

    expect(hasSuccessfulOpenMonthReplacement([
      { action: "frozen-anchored" },
    ])).toBe(true);
  });
});