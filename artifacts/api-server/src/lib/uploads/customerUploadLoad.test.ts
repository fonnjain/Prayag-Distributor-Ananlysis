import { describe, it, expect } from "vitest";
import {
  uploadTimestamp,
  assertSameUploadGeneration,
  UPLOAD_GENERATION_TOLERANCE_MS,
} from "./customerUploadLoad.js";

const DIST_A = "attached_assets/Distributer_Upload_Sample_File_1786193253055.csv";
const RET_A = "attached_assets/Retailer_Upload_Sample_file_1786193253057.csv";
const RET_OLD = "attached_assets/Retailer_Upload_Sample_file_1786182410891.csv";

describe("uploadTimestamp", () => {
  it("extracts the epoch-ms suffix", () => {
    expect(uploadTimestamp(DIST_A)).toBe(1786193253055);
    expect(uploadTimestamp(RET_A)).toBe(1786193253057);
  });

  it("throws on a filename without a timestamp suffix", () => {
    expect(() => uploadTimestamp("attached_assets/Distributer_Upload_Sample_File.csv"))
      .toThrow(/cannot extract upload timestamp/);
  });
});

describe("assertSameUploadGeneration", () => {
  it("accepts files from the same upload (ms apart)", () => {
    expect(() => assertSameUploadGeneration(DIST_A, RET_A)).not.toThrow();
  });

  it("rejects a mixed-generation pair (different uploads)", () => {
    // 1786193253055 - 1786182410891 ≈ 3 hours apart — far beyond tolerance.
    expect(() => assertSameUploadGeneration(DIST_A, RET_OLD))
      .toThrow(/upload generation mismatch/);
  });

  it("rejects exactly-beyond-tolerance and accepts exactly-at-tolerance", () => {
    const base = 1786193253055;
    const at = `x_${base + UPLOAD_GENERATION_TOLERANCE_MS}.csv`;
    const beyond = `x_${base + UPLOAD_GENERATION_TOLERANCE_MS + 1}.csv`;
    expect(() => assertSameUploadGeneration(`x_${base}.csv`, at)).not.toThrow();
    expect(() => assertSameUploadGeneration(`x_${base}.csv`, beyond))
      .toThrow(/upload generation mismatch/);
  });

  it("names both files and the re-upload remedy in the error", () => {
    try {
      assertSameUploadGeneration(DIST_A, RET_OLD);
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("Distributer_Upload_Sample_File_1786193253055.csv");
      expect(msg).toContain("Retailer_Upload_Sample_file_1786182410891.csv");
      expect(msg).toMatch(/re-upload BOTH files/i);
    }
  });
});
