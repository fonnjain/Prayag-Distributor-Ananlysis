import { describe, expect, it } from "vitest";
import { resolveTop80Snapshot } from "./opsSurfaceNodes.js";

describe("Prompt 115 operational graph adapters", () => {
  it("returns the approved dated Top-80 membership without recalculating it", async () => {
    const result = await resolveTop80Snapshot();
    const detail = result.detail as Record<string, unknown>;
    expect(detail.availability).toBe("measured");
    expect(detail.snapshotId).toBe("top80-prod-2026-09-17");
    expect(detail.codeCount).toBe(564);
    expect(detail.totalValueInr).toBe(1120023424.93);
    expect(result.source).toBe("prompt105-top80-snapshots.json");
    expect(result.cutoff).toBeTruthy();
    expect(result.readTime).toBeTruthy();
  });

  it("does not expose an unapproved or missing frozen snapshot", async () => {
    const result = await resolveTop80Snapshot("top80-live-566");
    expect((result.detail as Record<string, unknown>).availability).toBe("unavailable");
    expect(result.detail).not.toHaveProperty("membership");
  });
});