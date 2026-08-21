import { describe, expect, it } from "vitest";
import {
  classifyStateHeadPackFile,
  fiscalYearsForStateHeadAudit,
  hasMaterialPackTotalDiscrepancy,
  manifestBlockers,
  manifestConflictFileIds,
  missingMaterialSourceHeads,
  manifestWarnings,
  createStateHeadPackPeriodIntegrity,
  recordStateHeadPackPeriodRow,
  stateHeadPackPeriodIntegrityBlockers,
  stateHeadSourceLoadBlockers,
  sumEligibleStateHeadSaleRows,
} from "./stateHeadPack.js";

function evidence(
  headDisplay: string,
  kind: "head" | "nonTerritory" | "unmapped",
  amount: number,
) {
  return {
    headDisplay,
    kind,
    byFy: new Map([["2025-26", { amount }]]),
  };
}

describe("State Head master-pack manifest", () => {
  it("excludes Copy of files and reports the source and amount", () => {
    const entry = classifyStateHeadPackFile({
      fileId: "copy-id",
      fileName: "Copy of LALAN 2025-26",
      evidence: [evidence("Lalan Kumar", "head", 112_800_202)],
    });

    expect(entry.classification).toBe("excluded");
    expect(entry.included).toBe(false);
    expect(entry.report1ByFy["2025-26"]).toBe(112_800_202);
    expect(manifestWarnings([entry][0] ? [entry] : [])).toEqual([
      expect.stringContaining("Copy of LALAN 2025-26"),
    ]);
  });

  it("includes a canonical workbook only when the filename identifies its head", () => {
    const entry = classifyStateHeadPackFile({
      fileId: "lalan-id",
      fileName: "LALAN 2025-26",
      evidence: [evidence("Lalan Kumar", "head", 112_800_202)],
    });
    expect(entry.classification).toBe("canonical-head");
    expect(entry.includedByFy["2025-26"]).toBe(112_800_202);
  });

  it("blocks non-head and mixed feeders from head totals", () => {
    const entries = [
      classifyStateHeadPackFile({
        fileId: "kakkar-id",
        fileName: "KAKKAR 2025-26",
        evidence: [evidence("Non-territory", "nonTerritory", 10)],
      }),
      classifyStateHeadPackFile({
        fileId: "suresh-id",
        fileName: "Suresh Nair 2025-26",
        evidence: [
          evidence("Sandeep Dadheech", "head", 80),
          evidence("Biju C.O", "head", 20),
        ],
      }),
    ];
    expect(entries.every((entry) => !entry.included)).toBe(true);
    expect(manifestBlockers(entries)).toHaveLength(2);
  });

  it("requires an explicit mapping before a feeder becomes an approved slice", () => {
    const entry = classifyStateHeadPackFile({
      fileId: "slice-id",
      fileName: "Legacy feeder 2025-26",
      evidence: [evidence("Sandeep Dadheech", "head", 100)],
      policy: {
        excludeFilenamePatterns: [],
        approvedSlices: {
          "slice-id": {
            heads: ["Sandeep Dadheech"],
            note: "approved legacy slice",
          },
        },
      },
    });
    expect(entry.classification).toBe("approved-slice");
    expect(entry.includedByFy["2025-26"]).toBe(100);
  });

  it("blocks a renamed duplicate canonical workbook at manifest level", () => {
    const entries = [
      classifyStateHeadPackFile({
        fileId: "lalan-id",
        fileName: "LALAN 2025-26",
        evidence: [evidence("LALAN", "head", 100)],
      }),
      classifyStateHeadPackFile({
        fileId: "renamed-copy-id",
        fileName: "Lalan Kumar 2025-26 (1)",
        evidence: [evidence("Lalan Kumar", "head", 100)],
      }),
    ];
    expect(manifestBlockers(entries).some((x) => x.includes("Duplicate included candidates"))).toBe(true);
    expect(manifestConflictFileIds(entries)).toEqual(
      new Set(["lalan-id", "renamed-copy-id"]),
    );
  });

  it("does not treat an unknown raw label as a canonical State Head", () => {
    const entry = classifyStateHeadPackFile({
      fileId: "unknown-id",
      fileName: "UNKNOWN TERRITORY 2025-26",
      evidence: [evidence("UNKNOWN TERRITORY", "unmapped", 100)],
    });
    expect(entry.classification).toBe("mixed/non-head feeder");
    expect(entry.included).toBe(false);
  });

  it("audits only the requested FY and otherwise includes every manifest FY", () => {
    const entry = classifyStateHeadPackFile({
      fileId: "two-fy-id",
      fileName: "LALAN 2025-26",
      evidence: [
        {
          headDisplay: "Lalan Kumar",
          kind: "head",
          byFy: new Map([
            ["2025-26", { amount: 100 }],
            ["2026-27", { amount: 100 }],
          ]),
        },
      ],
    });
    expect(fiscalYearsForStateHeadAudit([entry], "2025-26")).toEqual([
      "2025-26",
    ]);
    expect(fiscalYearsForStateHeadAudit([entry], null)).toEqual([
      "2025-26",
      "2026-27",
    ]);
  });

  it("blocks a material total gap and reports a source head missing from the pack", () => {
    expect(hasMaterialPackTotalDiscrepancy(98, 100)).toBe(true);
    expect(
      missingMaterialSourceHeads(
        new Map([["lalan", 99]]),
        new Map([
          ["lalan", 99],
          ["sandeep", 2],
        ]),
        101,
      ),
    ).toEqual([{ head: "sandeep", net: 2, sharePct: 2 / 101 }]);
  });

  it("fails closed when the State Heads folder cannot be listed", () => {
    const blockers = stateHeadSourceLoadBlockers(
      "Could not list the State Heads Drive folder (403)",
      [],
    );
    expect(blockers).toEqual([
      "State Head source could not be loaded: Could not list the State Heads Drive folder (403)",
      "State Head source folder produced no workbook manifest; release is blocked.",
    ]);
  });

  it("fails closed when an otherwise successful source load is empty", () => {
    expect(stateHeadSourceLoadBlockers(null, [])).toEqual([
      "State Head source folder produced no workbook manifest; release is blocked.",
    ]);
  });

  it("keeps only in-FY rows and hard-blocks out-of-FY, future, and undated evidence", () => {
    const period = createStateHeadPackPeriodIntegrity();
    // 01-Apr-2025 is valid for FY2025-26.
    expect(
      recordStateHeadPackPeriodRow(
        period,
        "2025-26",
        { amount: 100, dateSerial: 45748 },
        46255,
      ),
    ).toBe(true);
    // 01-Apr-2026 falls outside FY2025-26; 25-Dec-2026 is also future
    // relative to the 21-Aug-2026 run date (serial 46255).
    expect(
      recordStateHeadPackPeriodRow(
        period,
        "2025-26",
        { amount: 20, dateSerial: 46113 },
        46255,
      ),
    ).toBe(false);
    expect(
      recordStateHeadPackPeriodRow(
        period,
        "2025-26",
        { amount: 30, dateSerial: 46381 },
        46255,
      ),
    ).toBe(false);
    expect(
      recordStateHeadPackPeriodRow(
        period,
        "2025-26",
        { amount: 10, dateSerial: null },
        46255,
      ),
    ).toBe(false);

    const entry = classifyStateHeadPackFile({
      fileId: "dated-file",
      fileName: "LALAN 2025-26",
      evidence: [
        {
          headDisplay: "Lalan Kumar",
          kind: "head",
          byFy: new Map([["2025-26", { amount: period.inFyTotal }]]),
          headlineByFy: new Map([["2025-26", { amount: period.headlineTotal }]]),
        },
      ],
      periodIntegrityByFy: { "2025-26": period },
    });

    expect(entry.report1ByFy["2025-26"]).toBe(160);
    expect(entry.includedByFy["2025-26"]).toBe(100);
    expect(stateHeadPackPeriodIntegrityBlockers([entry])).toEqual([
      expect.stringContaining("outside the requested FY"),
      expect.stringContaining("have no usable transaction date"),
      expect.stringContaining("future-dated raw rows"),
    ]);
  });

  it("blocks copied and headline-identical files even before they can be summed", () => {
    const copy = classifyStateHeadPackFile({
      fileId: "copy-id",
      fileName: "Copy of LALAN 2025-26",
      evidence: [evidence("Lalan Kumar", "head", 100)],
    });
    const original = classifyStateHeadPackFile({
      fileId: "original-id",
      fileName: "LALAN 2025-26",
      evidence: [evidence("Lalan Kumar", "head", 100)],
    });

    const blockers = manifestBlockers([copy, original]);
    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Excluded duplicate/temporary workbook"),
        expect.stringContaining("Headline-identical workbooks"),
      ]),
    );
  });

  it("reconciles territorial heads without counting institutional channel sales", () => {
    const source = sumEligibleStateHeadSaleRows([
      { head: "Sandeep Dadheech", net: 100 },
      { head: "Non-territory / Project / Govt", net: 500 },
      { head: null, net: 25 },
    ]);
    const pack = new Map([["sandeepdadheech", 100]]);

    expect(source.total).toBe(100);
    expect(source.byHead.get("sandeepdadheech")).toBe(100);
    expect(hasMaterialPackTotalDiscrepancy(100, source.total)).toBe(false);
    expect(missingMaterialSourceHeads(pack, source.byHead, source.total)).toEqual(
      [],
    );
  });
});