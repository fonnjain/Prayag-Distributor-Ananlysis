import { describe, expect, it } from "vitest";
import { normaliseAuthoritativeProduct } from "./authorityClient.js";
import { mapAuthoritativeDivisions } from "./syncedCache.js";

describe("authoritative MRP source normalization", () => {
  it("keeps one price row and maps every source division without altering the raw source model", () => {
    const row = normaliseAuthoritativeProduct({
      id: 101,
      itemCode: "cns-15",
      productName: "Concealed Stop Cock",
      division: "CP Fittings / Faucets | PTMT & Plastic Fittings",
      currentMrp: 1020,
      effectiveDate: "2026-08-01",
      isActive: true,
      dataFlag: "new_from_load",
    });

    expect(row.itemCode).toBe("CNS-15");
    expect(row.divisionRaw).toBe("CP Fittings / Faucets | PTMT & Plastic Fittings");
    expect(row.mrp).toBe(1020);
    expect(row.sourceBatchId).toBeNull();
    expect(row.sourceReviewStatus).toBe("new_from_load");
    expect(mapAuthoritativeDivisions(row.divisionRaw)).toEqual([
      { sourceDivision: "CP Fittings / Faucets", appSegment: "CP" },
      { sourceDivision: "PTMT & Plastic Fittings", appSegment: "PTMT" },
    ]);
  });

  it("does not manufacture approval metadata when the source omits it", () => {
    const row = normaliseAuthoritativeProduct({
      id: 1,
      itemCode: "101",
      division: "Hardware",
      currentMrp: 112.2,
    });
    expect(row.sourceBatchId).toBeNull();
    expect(row.sourceReviewStatus).toBeNull();
    expect(row.sourceReviewReasons).toEqual([]);
  });
});