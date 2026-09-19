import { describe, expect, it } from "vitest";
import { isSnapshotGenerationCurrent } from "./payloadSnapshot.js";

describe("payload snapshot generations", () => {
  it("rejects an older pending DB save after invalidation advances generation", () => {
    expect(isSnapshotGenerationCurrent(4, 4)).toBe(true);
    expect(isSnapshotGenerationCurrent(4, 5)).toBe(false);
  });

  it("rejects a persisted snapshot load that crossed invalidation", async () => {
    const captured = 9;
    await Promise.resolve();
    const afterInvalidation = 10;
    expect(isSnapshotGenerationCurrent(captured, afterInvalidation)).toBe(false);
  });
});