import { describe, expect, it } from "vitest";
import { buildSalesPeopleWorkbook, figureState } from "../salesPeopleExport";

describe("Sales People export states", () => {
  it("keeps unavailable distinct from a genuine zero", () => {
    expect(figureState(null, "Sales was not recorded")).toEqual({
      state: "unavailable",
      reason: "Sales was not recorded",
    });
    expect(figureState(0)).toEqual({
      state: "genuine zero",
      reason: "Recorded value is zero",
    });
    expect(figureState(125)).toEqual({
      state: "available",
      reason: "Recorded value",
    });
  });

  it("builds all four sheets from exactly the supplied filtered rows", () => {
    const workbook = buildSalesPeopleWorkbook({
      fy: "2026-27",
      period: "Q1",
      filters: "State head=North; Member=All; Search=(none)",
      showPrimary: false,
      rows: [
        {
          name: "Unavailable Rep",
          stateHead: "North",
          plan: 100,
          ob: 20,
          sales: null,
          achievementPct: null,
          reasons: { sales: "Sales month is not recorded" },
        },
        {
          name: "Zero Rep",
          stateHead: "North",
          plan: 100,
          ob: 0,
          sales: 0,
          achievementPct: 0,
        },
      ],
      summary: {
        membersWithPlan: 2,
        obMembers: 2,
        plan: 200,
        ob: 20,
        sales: 0,
        salesAvailable: 0,
        salesUnavailable: 1,
        salesGenuineZero: 1,
      },
      sources: {
        plan: "STATE HEAD DASHBOARD",
        ob: "STATE HEAD DASHBOARD",
        sales: "STATE HEAD DASHBOARD",
        achievement: "Sales Received ÷ Plan",
      },
      provisionalMonths: "None in selected period",
      dataReadAt: "14 Sep 2026",
    });

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Summary",
      "Members",
      "Missing data",
      "Info",
    ]);
    expect(workbook.getWorksheet("Members")?.rowCount).toBe(3);
    expect(workbook.getWorksheet("Missing data")?.rowCount).toBe(2);
    expect(workbook.getWorksheet("Info")?.getCell("B8").value).toBe("STATE HEAD DASHBOARD");
    expect(
      workbook.getWorksheet("Members")?.getRow(1).values,
    ).toEqual(expect.arrayContaining([
      "Plan state",
      "OB state",
      "Sales state",
      "Sales/Plan state",
    ]));
    expect(workbook.getWorksheet("Members")?.getCell("J2").value).toBe("unavailable");
    expect(workbook.getWorksheet("Members")?.getCell("J3").value).toBe("genuine zero");
    expect(workbook.getWorksheet("Members")?.getCell("I2").value).toBeNull();
    expect(workbook.getWorksheet("Members")?.getCell("I2").fill).toMatchObject({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5E7EB" },
    });
    expect(workbook.getWorksheet("Members")?.getCell("I3").value).toBe(0);
    expect(workbook.getWorksheet("Members")?.getCell("I3").numFmt).toBe("₹#,##0");
    expect(workbook.getWorksheet("Members")?.getCell("L3").value).toBe(0);
    expect(workbook.getWorksheet("Members")?.getCell("L3").numFmt).toBe("0.00%");
    expect(workbook.getWorksheet("Members")?.getCell("L2").value).toBeNull();
    expect(workbook.getWorksheet("Members")?.getCell("L2").fill).toMatchObject({
      fgColor: { argb: "FFE5E7EB" },
    });
  });
});