import { describe, expect, it } from "vitest";
import {
  APR_JUN26_PSCODE3,
  assertApprovedAprJunArchive,
  assertAprJunControls,
} from "./pscode3AprJun26.js";

describe("protected April-June PSCode3 controls", () => {
  it("rejects an archive with any other SHA-256", () => {
    expect(() => assertApprovedAprJunArchive("0".repeat(64))).toThrow(
      "approved April-June 2026",
    );
    expect(() =>
      assertApprovedAprJunArchive(APR_JUN26_PSCODE3.archiveSha256),
    ).not.toThrow();
  });

  it("rejects a hard-anchor mismatch", () => {
    const prepared = {
      rows: [],
      byMonth: {
        "Apr-26": { rows: 21612, net: 131087397 },
        "May-26": { rows: 31266, net: 210078126 },
        "Jun-26": { rows: 36300, net: 249037679 },
      },
      controls: {
        filesFound: 179,
        filesDropped: 17,
        filesLoading: 162,
        rows: 89178,
        net: 590203202,
        months: ["Apr-26", "May-26", "Jun-26"],
        footerRows: 162,
        noItemCode: 0,
        noMonth: 0,
        skippedNoValue: 0,
        wrongMonth: 0,
      },
    } as any;
    expect(() => assertAprJunControls(prepared)).toThrow("Apr-26");
  });
});
