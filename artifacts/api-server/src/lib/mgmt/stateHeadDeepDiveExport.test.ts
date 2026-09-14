import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildStateHeadDeepDiveExport,
  buildStateHeadDeepDiveWorkbook,
  resolveAuthoritativePeriodValue,
  stateHeadWorkbookEvidence,
  type StateHeadDeepDiveExportInput,
} from "./stateHeadDeepDiveExport.js";
import type { MemberKpis, TeamSummary } from "./deepDiveData.js";

function member(name: string, overrides: Partial<MemberKpis> = {}): MemberKpis {
  return {
    stateHead: "Head A",
    name,
    normKey: name.toLowerCase(),
    hq: "HQ",
    designation: "Sales",
    contact: null,
    primaryTarget: null,
    secondaryTarget: null,
    monthlyTarget: null,
    primaryTargetMonthly: null,
    secondaryTargetMonthly: null,
    totalTargetToDate: 100,
    elapsedMonths: 5,
    elapsedMonthsFromSheet: 5,
    isLeft: false,
    orderBooking: 80,
    directDealersOrder: 10,
    newPartyOrderBooking: 10,
    sale: 70,
    saleSource: "state_head_dashboard_data_tab",
    achievementPct: 80,
    achievementSecondary: null,
    achievementDirectDealer: null,
    achievementTotal: 1,
    achievementSale: 0.7,
    lastYearQ1: null,
    lastYearQ2: null,
    lastYearQ3: null,
    lastYearQ4: null,
    ctcMonthly: 10,
    ctcAnnual: 120,
    taBillStCost: 5,
    costRatio: null,
    workingDaysActual: null,
    totalOldRetailers: null,
    visitedRetailers: 2,
    nonVisitedRetailers: 1,
    businessPerRetailer: null,
    totalRetailers: 3,
    directDealersCount: null,
    totalVisitsYtd: 8,
    extra: {},
    ...overrides,
  };
}

const teamSummary: TeamSummary = {
  totalMembers: 3,
  activeMembers: 2,
  leftMembers: 1,
  zeroTargetActiveCount: 1,
  zeroTargetActiveOb: 25,
  zeroTargetActiveNames: ["No Target"],
  totalTarget: 100,
  totalOB: 225,
  totalSale: 140,
  totalVisits: 8,
  totalRetailers: 3,
  directDealerOB: 10,
  headlineAchievementPct: 225,
  likeForLikeAchievementPct: 200,
  byState: [],
};

function input(overrides: Partial<StateHeadDeepDiveExportInput> = {}): StateHeadDeepDiveExportInput {
  return {
    fy: "2026-27",
    stateHead: "Head A",
    periodLabel: "Apr–Aug 2026",
    periodMonths: [1, 2, 3, 4, 5],
    members: [
      member("Targeted Member"),
      member("No Target", { totalTargetToDate: null, orderBooking: 25, directDealersOrder: null, newPartyOrderBooking: null, sale: null }),
      member("Left Member", { isLeft: true }),
    ],
    teamSummary,
    reportingMonthCount: 5,
    dataReadAt: Date.parse("2026-09-14T01:00:00.000Z"),
    generatedAt: new Date("2026-09-14T02:00:00.000Z"),
    provisionalMonths: "Aug 2026 is provisional.",
    companyBenchmark: {
      costRatio: 0.25,
      returnPerRupee: 4,
      source: "company snapshot",
      population: "All active company members",
      peerCount: 12,
    },
    ...overrides,
  };
}

describe("Prompt 91 Section C state-head deep-dive export", () => {
  it("has exactly five sheets and all members under the selected head", async () => {
    const bytes = await buildStateHeadDeepDiveExport(input());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Team summary", "Members", "Cost and ROI", "Missing data", "Info",
    ]);
    expect(workbook.getWorksheet("Members")!.rowCount).toBe(5);
    expect(workbook.getWorksheet("Members")!.getColumn(1).values).toContain("No Target");
    expect(workbook.getWorksheet("Members")!.getColumn(1).values).toContain("Left Member");
  });

  it("carries the disclosure verbatim and exports dynamic no-target names", () => {
    const workbook = buildStateHeadDeepDiveWorkbook(input());
    const summary = workbook.getWorksheet("Team summary")!;
    const text = summary.getRows(1, summary.rowCount)!.flatMap((row) =>
      row.values as unknown[]).map(String).join(" | ");
    expect(text).toContain(
      "1 active members have no target recorded - carrying Rs 0.00 Cr of order booking. Headline includes their OB but contributes no target denominator. Like-for-like excludes them entirely.",
    );
    expect(text).toContain("No Target");
    expect(text).toContain("Headline OB achievement");
    expect(text).toContain("Like-for-like OB achievement");
    const headline = summary.getRows(1, summary.rowCount)!.find((row) =>
      row.getCell(1).value === "Headline OB achievement")!;
    const lfl = summary.getRows(1, summary.rowCount)!.find((row) =>
      row.getCell(1).value === "Like-for-like OB achievement")!;
    expect([headline.getCell(3).value, headline.getCell(4).value]).toEqual([225, 100]);
    expect([lfl.getCell(3).value, lfl.getCell(4).value]).toEqual([200, 100]);
    expect(headline.getCell(6).value).toBe("value");
    expect(lfl.getCell(6).value).toBe("value");
  });

  it("keeps operands, three-state markers, costs, ROI and benchmark visible", () => {
    const workbook = buildStateHeadDeepDiveWorkbook(input());
    const members = workbook.getWorksheet("Members")!;
    expect(members.getRow(3).getCell(4).value).toBe(100);
    expect(members.getRow(3).getCell(5).value).toBe("value");
    expect(members.getRow(4).getCell(10).value).toBeNull();
    expect(members.getRow(4).getCell(11).value).toBe("unavailable");
    expect(members.getRow(4).getCell(29).value).toBe("Yes");
    const cost = workbook.getWorksheet("Cost and ROI")!;
    expect(cost.getColumn(1).values).toContain("HEAD TOTAL");
    expect(cost.getColumn(1).values).toContain("COMPANY BENCHMARK");
    expect(cost.getColumn(1).values).toContain("No Target");
    expect(workbook.getWorksheet("Missing data")!.getColumn(2).values).toContain("Sales received");
  });

  it("records sources, filters, coverage, provisional months and generated evidence", () => {
    const workbook = buildStateHeadDeepDiveWorkbook(input());
    const infoText = (workbook.getWorksheet("Info")!.getColumn(1).values as unknown[])
      .concat(workbook.getWorksheet("Info")!.getColumn(2).values as unknown[]).map(String).join(" | ");
    expect(infoText).toContain("Head A");
    expect(infoText).toContain("Apr–Aug 2026");
    expect(infoText).toContain("Aug 2026 is provisional.");
    expect(infoText).toContain("2026-09-14T01:00:00.000Z");
    const evidence = stateHeadWorkbookEvidence(workbook);
    expect(evidence).toContain("Sheets: Team summary (");
    expect(evidence).toContain("Cost and ROI (");
    expect(evidence).toContain("Info:");
  });

  it("changes team, member and cost operands with the selected period", () => {
    const oneMonth = input({
      periodLabel: "Apr 2026",
      periodMonths: [1],
      periodMembers: {
        "targeted member": {
          target: 50, orderBooking: 20, sales: 10,
          source: "secondary_head_month authoritative monthly array",
          taBill: null,
          taReason: "T.A. is YTD-only.",
        },
        "no target": {
          target: null, orderBooking: 5, sales: null,
          source: "secondary_head_month authoritative monthly array",
          targetReason: "No Apr row target.",
          orderBookingReason: "",
          salesReason: "No Apr sales.",
          taBill: null,
          taReason: "T.A. is YTD-only.",
        },
        "left member": {
          target: 25, orderBooking: 10, sales: 8,
          source: "secondary_head_month authoritative monthly array",
          taBill: null,
          taReason: "T.A. is YTD-only.",
        },
      },
      periodReportingMonthCount: 1,
    });
    const twoMonths = input({
      periodLabel: "Apr–May 2026",
      periodMonths: [1, 2],
      periodMembers: {
        "targeted member": {
          target: 120, orderBooking: 90, sales: 60,
          source: "secondary_head_month authoritative monthly array",
          taBill: null,
          taReason: "T.A. is YTD-only.",
        },
        "no target": {
          target: null, orderBooking: 9, sales: null,
          source: "secondary_head_month authoritative monthly array",
          targetReason: "No target in selected months.",
          orderBookingReason: "",
          salesReason: "No sales in selected months.",
          taBill: null,
          taReason: "T.A. is YTD-only.",
        },
        "left member": {
          target: 50, orderBooking: 30, sales: 20,
          source: "secondary_head_month authoritative monthly array",
          taBill: null,
          taReason: "T.A. is YTD-only.",
        },
      },
      periodReportingMonthCount: 2,
    });
    const first = buildStateHeadDeepDiveWorkbook(oneMonth);
    const second = buildStateHeadDeepDiveWorkbook(twoMonths);
    const firstHeadline = first.getWorksheet("Team summary")!.getRows(1, 10)!.find((row) =>
      row.getCell(1).value === "Headline OB achievement")!;
    const secondHeadline = second.getWorksheet("Team summary")!.getRows(1, 10)!.find((row) =>
      row.getCell(1).value === "Headline OB achievement")!;
    expect(firstHeadline.getCell(3).value).toBe(25);
    expect(secondHeadline.getCell(3).value).toBe(99);
    expect(first.getWorksheet("Members")!.getRow(3).getCell(7).value).toBe(20);
    expect(second.getWorksheet("Members")!.getRow(3).getCell(7).value).toBe(90);
    expect(first.getWorksheet("Cost and ROI")!.getRow(3).getCell(5).value)
      .not.toBe(second.getWorksheet("Cost and ROI")!.getRow(3).getCell(5).value);
    expect((first.getWorksheet("Info")!.getColumn(2).values as unknown[]).map(String).join(" | "))
      .toContain("Apr 2026");
    expect((second.getWorksheet("Info")!.getColumn(2).values as unknown[]).map(String).join(" | "))
      .toContain("Apr–May 2026");
  });

  it("rejects three-of-five monthly arrays and never zero-fills one unavailable member", () => {
    const incomplete = resolveAuthoritativePeriodValue(
      [
        { monthIdx: 0, value: 10 },
        { monthIdx: 1, value: 20 },
        { monthIdx: 2, value: 30 },
      ],
      [1, 2, 3, 4, 5],
      "order booking",
    );
    expect(incomplete.value).toBeNull();
    expect(incomplete.reason).toContain("exactly one authoritative monthly row");

    const workbook = buildStateHeadDeepDiveWorkbook(input({
      periodMonths: [1, 2, 3, 4, 5],
      periodMembers: {
        "targeted member": {
          target: 100, orderBooking: null, sales: 50,
          source: "secondary_head_month authoritative monthly array",
          orderBookingReason: "Incomplete order booking: one member operand is unavailable.",
          taBill: null,
        },
        "no target": {
          target: null, orderBooking: 20, sales: 10,
          source: "secondary_head_month authoritative monthly array",
          targetReason: "No target recorded for the selected period.",
          taBill: null,
        },
        "left member": {
          target: 100, orderBooking: 30, sales: 20,
          source: "secondary_head_month authoritative monthly array",
          taBill: null,
        },
      },
      periodTeamOperands: {
        headlineOb: null,
        headlineTarget: 100,
        lflOb: null,
        lflTarget: 100,
      },
    }));
    const summary = workbook.getWorksheet("Team summary")!;
    const headline = summary.getRows(1, summary.rowCount)!.find((row) =>
      row.getCell(1).value === "Headline OB achievement")!;
    const lfl = summary.getRows(1, summary.rowCount)!.find((row) =>
      row.getCell(1).value === "Like-for-like OB achievement")!;
    expect(headline.getCell(3).value).toBeNull();
    expect(headline.getCell(5).value).toBeNull();
    expect(headline.getCell(6).value).toBe("unavailable");
    expect(lfl.getCell(3).value).toBeNull();
    expect(lfl.getCell(6).value).toBe("unavailable");
    const summaryText = summary.getRows(1, summary.rowCount)!.flatMap((row) =>
      row.values as unknown[]).map(String).join(" | ");
    expect(summaryText).not.toContain("Targeted Member");
    expect(summaryText).not.toContain("Rs 0.00");
    expect(summaryText).toContain("0 active members have no target recorded");
  });
});
