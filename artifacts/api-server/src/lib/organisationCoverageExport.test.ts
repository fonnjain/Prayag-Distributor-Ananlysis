import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildCoverageReviewWorkbook,
  buildPeopleWorkbook,
  infoSheetEvidence,
  mapOperationalCoverageKpis,
  normalisePeopleActiveFilter,
  peopleActiveWhereClause,
  workbookSheetEvidence,
} from "./organisationCoverageExport.js";

describe("Prompt 91 Section E exports", () => {
  it("writes joining dates as true Excel dates and records all People conflict registers", () => {
    const workbook = buildPeopleWorkbook({
      rows: [{
        employeeCode: "1007",
        name: "Pawan Sharma",
        role: "State Head",
        stateHead: "Pawan Sharma",
        hq: "Delhi",
        state: "DELHI",
        workingState: "DELHI",
        hrStatus: "Deactive",
        rosterStatus: "Active",
        dateOfJoining: new Date("2020-04-01T00:00:00.000Z"),
        email: null,
        mobile: "9999999999",
        conflictFlags: "P12 — HR Deactive vs active head",
      }],
      filters: { active: "Active", search: "All" },
      source: "person master + hr_roster_csv",
    });
    const people = workbook.getWorksheet("People")!;
    expect(people.getCell("J2").value).toBeInstanceOf(Date);
    expect(people.getCell("J2").numFmt).toBe("dd-mmm-yyyy");
    expect(workbookSheetEvidence(workbook).map((sheet) => sheet.name))
      .toEqual(["People", "Conflict flags", "Info"]);
    const info = infoSheetEvidence(workbook);
    expect(info["Filters applied"]).toContain("active: Active");
    expect(info["Conflict flags"]).toContain("P14");
    expect(info["Conflict flags"]).toContain("P40");
    expect(info["Conflict flags"]).toContain("P11");
    expect(info["Conflict flags"]).toContain("P12");
  });

  it("keeps unavailable visit values blank and marks genuine zero separately", async () => {
    const workbook = buildCoverageReviewWorkbook({
      byHead: [{
        stateHead: "Head A",
        member: "1 member",
        retailers: 4,
        retailersSource: "Data tab totalRetailers",
        visited: null,
        visitedSource: "Data tab visitedRetailers",
        notVisited: null,
        notVisitedSource: "Derived only when operands are known",
        partiesGivingBusiness: 0,
        partiesGivingBusinessSource: "Unavailable",
        businessAmount: 0,
        businessAmountSource: "Data tab newPartyOrderBooking",
      }],
      byMember: [{
        stateHead: "Head A",
        member: "Member A",
        retailers: 4,
        retailersSource: "Data tab totalRetailers",
        visited: null,
        visitedSource: "Data tab visitedRetailers",
        notVisited: null,
        notVisitedSource: "Derived only when operands are known",
        partiesGivingBusiness: 0,
        partiesGivingBusinessSource: "Unavailable",
        businessAmount: 0,
        businessAmountSource: "Data tab newPartyOrderBooking",
      }],
      filters: { stateHead: "Head A", member: "All" },
      fy: "2026-27",
      period: "Fiscal months 1–3",
      sources: "State Head Dashboard + HR SFA",
      dataReadAt: "2026-09-14T00:00:00.000Z",
    });
    const member = workbook.getWorksheet("By Member")!;
    expect(member.getCell("F2").value).toBeNull();
    expect(member.getCell("G2").value).toBe("UNKNOWN");
    expect(member.getCell("M2").value).toBe("ZERO");
    expect(member.getCell("P2").value).toBe("ZERO");
    const info = infoSheetEvidence(workbook);
    expect(info["Figure semantics"]).toContain("never converted to zero");
    expect(workbookSheetEvidence(workbook)).toEqual([
      { name: "By Head", rows: 1 },
      { name: "By Member", rows: 1 },
      { name: "Info", rows: 11 },
    ]);
    const bytes = await workbook.xlsx.writeBuffer();
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(bytes as unknown as Parameters<typeof reloaded.xlsx.load>[0]);
    expect(reloaded.getWorksheet("By Member")?.getCell("F2").value).toBeNull();
  });

  it("maps the actual Sales Deep Dive payload and keeps People filter parity", () => {
    const mapped = mapOperationalCoverageKpis({
      stateHead: "Head A",
      name: "Member A",
      totalRetailers: 10,
      visitedRetailers: 7,
      nonVisitedRetailers: null,
      newPartyOrderBooking: 1200,
      businessPerRetailer: 120,
      hrSfa: { businessReceivedVisits: 0 },
    });
    expect(mapped.notVisited).toBe(3);
    expect(mapped.notVisitedSource).toContain("Derived");
    expect(mapped.businessAmount).toBe(1200);
    expect(mapped.partiesGivingBusiness).toBe(0);
    expect(mapped.partiesGivingBusinessSource).toContain("businessReceivedVisits");
    const ambiguous = mapOperationalCoverageKpis({
      stateHead: "Head A",
      name: "Member A",
      totalRetailers: 10,
      visitedRetailers: 7,
      nonVisitedRetailers: 3,
      newPartyOrderBooking: null,
      businessPerRetailer: null,
      hrSfa: { businessReceivedVisits: 8, identityAmbiguous: true },
    });
    expect(ambiguous.partiesGivingBusiness).toBeNull();
    expect(ambiguous.partiesGivingBusinessSource).toContain("ambiguous");
    const unmatched = mapOperationalCoverageKpis({
      stateHead: "Head A",
      name: "Member A",
      totalRetailers: null,
      visitedRetailers: null,
      nonVisitedRetailers: null,
      newPartyOrderBooking: null,
      businessPerRetailer: null,
      hrSfa: null,
    });
    expect(unmatched.partiesGivingBusiness).toBeNull();
    expect(unmatched.partiesGivingBusinessSource).toContain("no normalized member match");
    expect(normalisePeopleActiveFilter("active")).toBe("active");
    expect(normalisePeopleActiveFilter("inactive")).toBe("inactive");
    expect(normalisePeopleActiveFilter("all")).toBe("all");
    expect(normalisePeopleActiveFilter("true")).toBe("active");
    expect(normalisePeopleActiveFilter("false")).toBe("inactive");
    expect(peopleActiveWhereClause("active")).toBe(peopleActiveWhereClause("true"));
    expect(peopleActiveWhereClause("inactive")).toBe(peopleActiveWhereClause("false"));
    expect(peopleActiveWhereClause("all")).toBe("");
  });
});