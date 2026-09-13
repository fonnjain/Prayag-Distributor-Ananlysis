import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { SALES_DEEP_DIVE_EXTRA_MANIFEST as SHARED_EXTRA_MANIFEST } from "@workspace/api-zod";
import {
  buildDeepDiveExport,
  buildDeepDiveWorkbook,
  buildDeepDivePeriodAnalysis,
  SALES_DEEP_DIVE_EXTRA_MANIFEST,
  type DeepDiveExportInput,
} from "./deepDiveExport.js";
import type { MemberKpis } from "./deepDiveData.js";
import type { MemberSheetData } from "./memberSheet.js";
import { closedReportingMonthCount } from "../fyAnchors.js";

function fixture(overrides: Partial<MemberKpis> = {}): MemberKpis {
  return {
    stateHead: "Test Head",
    name: "Monmon Paul",
    normKey: "monmon paul",
    hq: "HQ",
    designation: "Sales",
    contact: "000",
    primaryTarget: 100,
    secondaryTarget: 200,
    monthlyTarget: 50,
    primaryTargetMonthly: 10,
    secondaryTargetMonthly: 40,
    totalTargetToDate: 300,
    elapsedMonths: 6,
    elapsedMonthsFromSheet: 6,
    isLeft: false,
    orderBooking: 80,
    directDealersOrder: 20,
    newPartyOrderBooking: 10,
    sale: 90,
    achievementPct: 30,
    saleSource: "state_head_dashboard_data_tab",
    achievementSecondary: 40,
    achievementDirectDealer: 20,
    achievementTotal: 36.666666,
    achievementSale: 30,
    lastYearQ1: 20,
    lastYearQ2: 30,
    lastYearQ3: null,
    lastYearQ4: 40,
    ctcMonthly: 12000,
    ctcAnnual: 144000,
    taBillStCost: 30000,
    // Deliberately differs from the export KPI.  It is source metadata only.
    costRatio: 0.02,
    workingDaysActual: 0,
    totalOldRetailers: null,
    visitedRetailers: 0,
    nonVisitedRetailers: null,
    businessPerRetailer: null,
    totalRetailers: 3,
    directDealersCount: null,
    totalVisitsYtd: 0,
    extra: {
      DOJ: 41004,
      STATE: "Maharashtra",
      WORKINGSTATE: "West",
      EMPLOYEECODE: "E-17",
      OLDNEW: "New",
      CHANNEL: "Secondary",
      TARGETRANGE: "₹10L–₹20L",
      BUSINESSBREAKDOWN: 1234,
      COUNTERWISEVISITS: 12,
      GPSDISTANCE: 45.5,
      AVERAGEORDER: 101.25,
      TARGETACHIEVEMENT: 0.42,
      TOTALVISITSOFBUSINESSRECEIVEDPARTIES: 7,
      TOTALVISITSOFVISITEDBUTNOBUSINESSRECEIVED: 5,
      COSTRATIOSALE: 0.56789,
      CURRENTTOTALSALE: 90,
      PRIORTOTALSALE: 80,
      A4: "must not be exported",
    },
    ...overrides,
  };
}

const detail = {
  status: "ok",
  fileId: "file-1",
  tabName: "Summary Report 26-27",
  canonicalName: "Summary Report 26-27",
  rows: [],
  removedRows: [],
  spread: {
    totalRetailers: 3,
    activeRetailers: 2,
    dormantRetailers: 1,
    removedRetailers: 0,
    activePct: 66.666,
    totalOrderBooking: 110,
    totalSale: 90,
    totalVisits: 0,
    top5ObShare: 100,
    top10ObShare: 100,
    concentrationIndex: 5000,
    businessPerActiveRetailer: 55,
    businessPerVisit: null,
    annualBusinessPlan: 500,
  },
} as unknown as MemberSheetData;

const roiCost = {
  ctcMonthly: 12000,
  taBillYtd: 30000,
  elapsedCompleteMonths: 6,
  ctcCostYtd: 72000,
  totalCost: 102000,
  obToCostMultiple: 110 / 102000,
  saleToCostMultiple: 90 / 102000,
  costPerRetailer: 34000,
  costPerVisit: null,
  costPerActiveRetailer: 51000,
  costRatioPct: (102000 / 110) * 100,
  marginRoiAvailable: false as const,
};

function input(overrides: Partial<DeepDiveExportInput> = {}): DeepDiveExportInput {
  return {
    fy: "2026-27",
    kpis: fixture(),
    monthlyRows: [
      { monthLabel: "Apr-26", monthIdx: 0, planAmount: 100, orderedAmount: 0, receivedAmount: 40, achievementPct: 0.4, notYetRecorded: false },
      { monthLabel: "May-26", monthIdx: 1, planAmount: 100, orderedAmount: 250, receivedAmount: null, achievementPct: null, notYetRecorded: true },
      { monthLabel: "Jun-26", monthIdx: 2, planAmount: 0, orderedAmount: 0, receivedAmount: 0, achievementPct: 0, notYetRecorded: false },
    ],
    periodLabel: "Apr–Jun 2026",
    periodMonths: [1, 2, 3],
    generatedAt: new Date("2026-08-01T00:00:00.000Z"),
    dataReadAt: Date.parse("2026-08-01T01:00:00.000Z"),
    provisionalMonths: "May 2026 is provisional and may change until it closes.",
    dataSource: "STATE HEAD DASHBOARD Data tab resolved page payload",
    monthlySource: "secondary_head_month resolved page payload",
    retailerDetail: detail,
    roiCost,
    skuSpread: {
      isLiveYear: false,
      totalRows: 4,
      totalNet: 1000,
      distinctSegments: 2,
      totalKnownSegments: 4,
      coveragePct: 50,
      netBySegment: [
        { segment: "Brand Alpha", net: 700, pct: 70 },
        { segment: "Brand Beta", net: 300, pct: 30 },
      ],
      crossSellDepth: 1.5,
      concentrationHhi: 5800,
    },
    winBack: [
      { customer: "Dormant A", lastActiveFy: "2025-26", lastActiveMonth: "Mar-26", lastNet: 500 },
      { customer: "Dormant B", lastActiveFy: "2024-25", lastActiveMonth: "Dec-25", lastNet: 250 },
    ],
    ...overrides,
  };
}

function row(ws: ExcelJS.Worksheet, label: string): ExcelJS.Row {
  const hit = ws.getRows(1, ws.rowCount)?.find((r) =>
    r.getCell(1).value === label || r.getCell(2).value === label);
  if (!hit) throw new Error(`Could not find row ${label}`);
  return hit;
}

function values(workbook: ExcelJS.Workbook): unknown[] {
  return workbook.worksheets.flatMap((ws) =>
    ws.getRows(1, ws.rowCount)?.flatMap((r) => r.values as unknown[]) ?? []);
}

describe("Prompt 84 Sales Deep Dive workbook", () => {
  it("has exactly the approved eleven-sheet order and all resolved collections", async () => {
    const bytes = await buildDeepDiveExport(input());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);

    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      "Summary for Decision",
      "Targets and Achievement",
      "Performance and Prior Period",
      "Coverage and Visits",
      "Cost",
      "Segment Spread",
      "Reconciliation",
      "Dormant Retailers",
      "Profile",
      "Working detail",
      "Info",
    ]);
    expect(workbook.worksheets).toHaveLength(11);
    const dormant = workbook.getWorksheet("Dormant Retailers")!;
    expect(dormant.getColumn(1).values).toContain("Dormant A");
    expect(dormant.getColumn(1).values).toContain("Dormant B");
    expect(dormant.getColumn(5).values).toContain("Resolved full collection (not UI top 20)");
  });

  it("has one recomputed cost-ratio KPI with an auditable basis, never the raw source ratio", () => {
    const workbook = buildDeepDiveWorkbook(input());
    const cost = workbook.getWorksheet("Cost")!;
    const labels = cost.getColumn(1).values as unknown[];
    expect(labels.filter((v) => String(v).toLowerCase().includes("cost ratio"))).toHaveLength(1);
    expect(row(cost, "YTD CTC").getCell(2).value).toBe(72000);
    expect(row(cost, "YTD T.A.").getCell(2).value).toBe(30000);
    expect(row(cost, "Total YTD cost").getCell(2).value).toBe(102000);
    expect(row(cost, "Exact denominator (sales received)").getCell(2).value).toBe(90);
    expect(row(cost, "Denominator TYPE").getCell(2).value).toBe("SALES_RECEIVED");
    expect(row(cost, "Cost ratio (recomputed; the only cost-ratio KPI)").getCell(2).value)
      .toBeCloseTo(102000 / 90, 8);
    const costRatio = row(cost, "Cost ratio (recomputed; the only cost-ratio KPI)");
    expect(costRatio.getCell(2).numFmt).toBe("0.00%");
    expect(costRatio.getCell(3).value).toBe(102000);
    expect(costRatio.getCell(4).value).toBe(90);
    expect(costRatio.getCell(5).value).toBeCloseTo(102000 / 90, 8);
    const summaryCost = workbook.getWorksheet("Summary for Decision")!.getRows(1, workbook.getWorksheet("Summary for Decision")!.rowCount)!
      .find((r) => String(r.getCell(2).value).startsWith("YTD cost vs Sales Received"))!;
    expect(summaryCost.getCell(3).value).toBe(102000);
    expect(values(workbook)).not.toContain(0.02);
    expect(workbook.getWorksheet("Info")!.getColumn(1).values).toContain("Unverified source ratio metadata");
    const summaryRows = workbook.getWorksheet("Summary for Decision")!.getRows(1, workbook.getWorksheet("Summary for Decision")!.rowCount)!;
    expect(summaryRows.find((r) => String(r.getCell(2).value).startsWith("Sales / cost multiple"))!.getCell(3).value)
      .toBeCloseTo(90 / 102000, 8);
    expect(summaryRows.find((r) => String(r.getCell(2).value).startsWith("OB / cost multiple"))!.getCell(3).value)
      .toBeCloseTo(110 / 102000, 8);
  });

  it("writes DOJ as a genuine Excel date and preserves value, zero and unavailable states", async () => {
    const bytes = await buildDeepDiveExport(input());
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(bytes as unknown as Parameters<typeof reloaded.xlsx.load>[0]);
    const profile = reloaded.getWorksheet("Profile")!;
    const doj = row(profile, "Date of Joining").getCell(2);
    expect(doj.value).toBeInstanceOf(Date);
    expect(doj.numFmt).toBe("dd-mmm-yyyy");

    const coverage = reloaded.getWorksheet("Coverage and Visits")!;
    const zero = row(coverage, "Total visits YTD");
    expect(zero.getCell(2).value).toBe(0);
    expect(zero.getCell(6).value).toBe("zero");
    const unavailable = row(coverage, "Total old retailers");
    expect(unavailable.getCell(2).value).toBeNull();
    expect(unavailable.getCell(2).fill).toMatchObject({ fgColor: { argb: "FFE7E7E7" } });
    expect(unavailable.getCell(8).value).toContain("unavailable");
    expect(unavailable.getCell(6).value).toBe("unavailable");
  });

  it("exports period rows and prior-period rows on Performance and Prior Period", () => {
    const workbook = buildDeepDiveWorkbook(input({ periodMonths: [2] }));
    const performance = workbook.getWorksheet("Performance and Prior Period")!;
    expect(row(performance, "May-26").getCell(1).value).toBe("May-26");
    expect(row(performance, "Prior year Q1").getCell(3).value).toBe(20);
    expect(row(performance, "Prior year Q2").getCell(1).value).toBe("Prior year Q2");
    expect(row(performance, "Prior year Q3").getCell(7).value).toBeNull();
    expect(row(performance, "Prior year Q4").getCell(1).value).toBe("Prior year Q4");
  });

  it("records sources, filters, timestamps, provisional months, booking/dispatch basis and omissions", () => {
    const workbook = buildDeepDiveWorkbook(input({ omissions: ["Source B unresolved text is not yet loaded."] }));
    const info = workbook.getWorksheet("Info")!;
    const infoText = (info.getColumn(1).values as unknown[]).concat(info.getColumn(2).values as unknown[])
      .map(String).join(" | ");
    expect(infoText).toContain("STATE HEAD DASHBOARD Data tab");
    expect(infoText).toContain("secondary_head_month");
    expect(infoText).toContain("secondary_register_line");
    expect(infoText).toContain("May 2026 is provisional");
    expect(infoText).toContain("Order booking is committed order value");
    expect(infoText).toContain("Source B unresolved text is not yet loaded");
    expect(infoText).toContain("2026-08-01T01:00:00.000Z");
  });

  it("has a broad resolved-page figure manifest and does not invent unresolved Source B text", () => {
    const workbook = buildDeepDiveWorkbook(input());
    const labels = (name: string) => new Set(
      workbook.getWorksheet(name)!.getRows(1, workbook.getWorksheet(name)!.rowCount)!
        .flatMap((r) => [r.getCell(1).value, r.getCell(2).value]).map(String),
    );
    for (const block of ["Cost / ROI", "Attainment", "What works", "Risk", "Trend"]) {
      expect(labels("Summary for Decision")).toContain(block);
    }
    for (const label of [
      "YTD cost vs Sales Received", "Sales / cost multiple", "OB / cost multiple",
      "Sales received vs total target", "Secondary OB vs secondary target",
      "Direct dealer OB vs primary target", "Prior FY quarterly shape",
      "Visited retailer coverage", "Non-visited retailer count",
      "Parties giving business", "OB vs Sales Received multiple", "Business per retailer vs peer median",
      "New retailers", "New-party order value",
      "Concentration HHI", "Dormant retailer count", "Dormant retailer value",
    ]) expect([...labels("Summary for Decision")].some((v) => v.includes(label))).toBe(true);
    for (const label of [
      "Monthly CTC basis", "Annual CTC", "YTD CTC", "YTD T.A.", "Total YTD cost",
      "Exact denominator (sales received)", "Denominator TYPE", "Average sales / day",
       "Visits / day", "Order booking value/working day", "Orders count/working day",
    ]) expect(labels("Cost")).toContain(label);
    for (const label of [
      "Annual business plan", "Active retailer percentage", "Top 5 order-booking share",
       "Top 10 order-booking share", "Retailer concentration HHI", "Dashboard total visits",
    ]) expect(labels("Coverage and Visits")).toContain(label);
    for (const label of ["Business breakdown", "Counterwise visits"]) {
      expect(labels("Working detail")).toContain(label);
    }
    for (const label of [
      "Current FY YTD", "Custom selected period", "Full Year / current FY", "Prior FY same-period comparison",
      "Q1", "Q2", "Q3", "Q4", "Prior year Q1", "Prior year Q2", "Prior year Q3", "Prior year Q4",
    ]) expect(labels("Performance and Prior Period")).toContain(label);
    for (const label of [
      "Distinct segments", "Known segment universe", "Segment coverage", "Total NET",
      "Cross-sell depth", "Concentration HHI", "Vocabulary / join note",
    ]) expect(labels("Segment Spread")).toContain(label);
    for (const label of ["Member", "State head", "Designation", "HQ", "Status", "State", "Working state",
      "Employee code", "Old / new", "Channel", "Target range", "Date of Joining"]) {
      expect(labels("Profile")).toContain(label);
    }
    expect(row(workbook.getWorksheet("Profile")!, "State").getCell(2).value).toBe("Maharashtra");
    expect(row(workbook.getWorksheet("Profile")!, "Working state").getCell(2).value).toBe("West");
    expect(row(workbook.getWorksheet("Profile")!, "Employee code").getCell(2).value).toBe("E-17");
    expect(row(workbook.getWorksheet("Profile")!, "Old / new").getCell(2).value).toBe("New");
    expect(row(workbook.getWorksheet("Profile")!, "Channel").getCell(2).value).toBe("Secondary");
    expect(row(workbook.getWorksheet("Profile")!, "Target range").getCell(2).value).toBe("₹10L–₹20L");
    expect(labels("Reconciliation")).not.toContain("Source B unresolved text");
    expect(labels("Info")).toContain("Designation");
    expect(labels("Info")).toContain("HQ");
  });

  it("exports mapped page extras as typed numeric rows and records explicit omissions", () => {
    const workbook = buildDeepDiveWorkbook(input());
    const profile = workbook.getWorksheet("Profile")!;
    expect(profile.getColumn(1).values).not.toContain("Business breakdown");
    const working = workbook.getWorksheet("Working detail")!;
    expect(row(working, "Business breakdown").getCell(3).value).toBe(1234);
    expect(row(working, "Business breakdown").getCell(3).numFmt).toContain("₹");
    expect(row(working, "Counterwise visits").getCell(3).value).toBe(12);
    expect(row(working, "GPS distance (km)").getCell(3).value).toBe(45.5);
    expect(row(working, "Average order value").getCell(3).value).toBe(101.25);
    expect(row(working, "Target Achievement").getCell(3).value).toBe(0.42);
    expect(row(working, "Current total sales").getCell(3).value).toBe(90);
    expect(row(working, "Business breakdown").getCell(9).value).toBe("BUSINESSBREAKDOWN");
    const info = workbook.getWorksheet("Info")!;
    const infoText = (info.getColumn(2).values as unknown[]).map(String).join(" | ");
    expect(infoText).toContain("A4: omitted internal source field.");
    expect(infoText).toContain("COSTRATIOSALE: unverified source field");
  });

  it("keeps the export manifest aligned with every meaningful page EXTRA_LABELS key", () => {
    const pageKeys = [
      "TOTALLEADCOUNTERS", "TOTALLEADVISITS", "TOTALNONLEADVISITS",
      "DISTRIBUTORCOUNTER", "DISTRIBUTORVISITS", "DIRECTDEALERCOUNTER",
      "DIRECTDEALERVISITS", "DISTRIBUTORDIRECTDEALERLEADCOUNTER",
      "DISTRIBUTORDIRECTDEALERLEADVISITS", "BUSINESSRECEIVEDPARTIESVISITS",
      "ACTIVEPARTIESVISITS", "TOTALVISITS", "VISITEDBUTNOBUSINESSRECEIVED",
      "NOVISITNOBUSINESSRECEIVED", "TOTALWORKINGHOURS", "TOTALGPSKM",
      "AVGDISTANCEKM", "NOOFORDERS", "AVERAGESALESPERDAY", "AVERAGEVISITPERDAY",
      "BUSINESSACHIEVEDBY", "BUSINESSACHIVEDBYNOOFOLDPARTIES",
      "BUSINESSACHIVEDBYNOOFNEWPARTIES", "BUSINESSACHIEVEDBYDIRECTDEALER",
      "TARGETACHIEVEMENT", "TARGETACHIEVEMENTSALE",
      "DIRECTDEALERPRIMARYTARGETACHIEVEMENT", "SALE2526", "TOTALORDER2526",
      "Q1", "Q2", "Q3", "Q4", "SALENOWYTD", "TOTALORDERNOWYTD",
    ];
    for (const key of pageKeys) {
      expect(SHARED_EXTRA_MANIFEST[key]).toBeDefined();
      expect(SALES_DEEP_DIVE_EXTRA_MANIFEST[key]).toEqual(SHARED_EXTRA_MANIFEST[key]);
    }
  });

  it("keeps worksheet headers aligned with metric operands, availability, source and reason cells", () => {
    const workbook = buildDeepDiveWorkbook(input());
    const eight = ["Measure", "Value", "Numerator", "Denominator", "Percentage", "Availability", "Source", "Reason"];
    for (const name of ["Targets and Achievement", "Coverage and Visits", "Cost", "Segment Spread", "Profile"]) {
      expect((workbook.getWorksheet(name)!.getRow(2).values as unknown[]).slice(1, 9)).toEqual(eight);
    }
    expect((workbook.getWorksheet("Performance and Prior Period")!.getRow(2).values as unknown[]).slice(1, 11)).toEqual([
      "Measure / period", "Plan", "Order booking", "Direct dealer order", "Sales received",
      "Achievement", "Numerator", "Denominator", "Source", "Reason",
    ]);
    const coverage = workbook.getWorksheet("Coverage and Visits")!;
    const metricRow = row(coverage, "Total visits YTD");
    expect(metricRow.getCell(6).value).toBe("zero");
    expect(metricRow.getCell(7).value).toBe("STATE HEAD DASHBOARD Data tab resolved page payload");
    const pct = row(coverage, "Active retailer percentage");
    expect(pct.getCell(3).value).toBe(2);
    expect(pct.getCell(4).value).toBe(3);
    expect(pct.getCell(5).value).toBeCloseTo(2 / 3, 8);
    expect(pct.getCell(7).value).toBe("Resolved member working-sheet page payload");
  });

  it("uses Indian grouping formats for money and numeric cells", () => {
    const workbook = buildDeepDiveWorkbook(input());
    expect(row(workbook.getWorksheet("Targets and Achievement")!, "Sales received").getCell(2).numFmt)
      .toBe('"₹"#,##,##0;[Red]-"₹"#,##,##0');
    expect(row(workbook.getWorksheet("Coverage and Visits")!, "Working days actual").getCell(2).numFmt)
      .toBe("#,##,##0.00");
  });

  it("builds page-equivalent full-year, selected-period and selected-month analysis", () => {
    const analysis = buildDeepDivePeriodAnalysis([
      { month: "Apr", orderBooking: 10, sale: 8 },
      { month: "May", orderBooking: 20, sale: null },
      { month: "Jun", orderBooking: 30, sale: 24 },
    ], [2], []);
    expect(analysis.fullYearOb).toBeNull();
    expect(analysis.fullYearSales).toBeNull();
    expect(analysis.selectedPeriodOb).toBe(20);
    expect(analysis.selectedPeriodSales).toBeNull();
    expect(analysis.quarters?.[0]).toMatchObject({ plan: null, orderBooking: null, sale: null });
    expect(analysis.selectedMonthLabel).toBe("May");
  });

  it("does not call one-month source YTD or full-year and keeps growth prior unavailable", () => {
    const workbook = buildDeepDiveWorkbook(input({
      monthlyRows: [{
        monthLabel: "Apr-26", monthIdx: 0, planAmount: 100, orderedAmount: 10,
        receivedAmount: 8, achievementPct: 0.08, notYetRecorded: false,
      }],
      retailerDetail: null,
      retailerDetailStatus: "not-loaded",
    }));
    const performance = workbook.getWorksheet("Performance and Prior Period")!;
    const ytd = row(performance, "Current FY YTD");
    expect(ytd.getCell(3).value).toBeNull();
    expect(ytd.getCell(5).value).toBeNull();
    expect(ytd.getCell(10).value).toContain("closed-month boundary");
    const fullYear = row(performance, "Full Year / current FY");
    expect(fullYear.getCell(3).value).toBeNull();
    expect(fullYear.getCell(10).value).toContain("12 distinct FY months");
    const summary = workbook.getWorksheet("Summary for Decision")!;
    expect((summary.getRow(2).values as unknown[]).slice(1, 5)).toEqual([
      "Decision block", "Figure / question", "Value / basis", "Verdict",
    ]);
    const salesGrowth = summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("Current sales vs same-period prior sales"))!;
    expect(salesGrowth.getCell(3).value).toBe(90);
    expect(salesGrowth.getCell(4).value).toContain("Unavailable");
    const obGrowth = summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("Current OB vs same-period prior OB"))!;
    expect(obGrowth.getCell(3).value).toBe(110);
    expect(obGrowth.getCell(4).value).toContain("Unavailable");
    const workingStatus = row(workbook.getWorksheet("Working detail")!, "Retailer detail availability");
    expect(workingStatus.getCell(3).value).toBe("not-loaded");
    expect(workingStatus.getCell(8).value).toContain("not yet loaded");
    const infoStatus = workbook.getWorksheet("Info")!;
    expect((infoStatus.getColumn(2).values as unknown[]).map(String).join(" | ")).toContain("status=not-loaded");
  });

  it("uses page-equivalent reconciliation and preserves every Source B status", () => {
    const statuses = ["ok", "loading", "not-mapped", "error", "not-loaded"] as const;
    for (const status of statuses) {
      const workbook = buildDeepDiveWorkbook(input({
        retailerDetail: status === "ok" ? detail : null,
        retailerDetailStatus: status,
      }));
      const recon = workbook.getWorksheet("Reconciliation")!;
      const order = row(recon, "Order booking (retailer + DD)");
      expect(order.getCell(2).value).toBe(100);
      expect(order.getCell(3).value).toBe(status === "ok" ? 110 : null);
      if (status === "ok") {
        expect(order.getCell(4).value).toBe(-10);
        expect(order.getCell(5).value).toBeCloseTo(-0.1, 8);
      }
      expect(row(recon, "Source B status").getCell(6).value).toBe(status);
      const reason = String(order.getCell(7).value ?? "");
      if (status === "loading" || status === "not-loaded") expect(reason).toContain("not yet loaded");
      else if (status === "error") expect(reason).toContain("failed to load");
      else if (status === "not-mapped") expect(reason).toContain("not mapped");
      else expect(reason).not.toContain("not yet loaded");
    }
  });

  it("exports all dormant rows and retailer detail in separate numeric columns", () => {
    const dormantRows = Array.from({ length: 25 }, (_, i) => ({
      customer: `Dormant ${i}`, lastActiveFy: "2025-26", lastActiveMonth: "Mar-26", lastNet: i,
    }));
    const retailerRows = [{
      name: "Retailer One", district: "D", city: "C", distributor: "Dist", distanceKm: 12.5,
      businessPlan: 100, visitsRequired: 4, orderBooking: 80, sale: 75, totalVisit: 3,
      achievementPct: 80, isActive: true, lastActiveYear: null, lastYearOb: null, lastYearSale: null,
    }];
    const visitPlan = {
      pattern: {
        totalVisitsDone: 3, totalVisitsRequired: 4, proRatedRequired: 4,
        visitDeficit: 1, visitedZeroOrderCount: 0, visitedZeroOrderRetailers: [],
        distanceBuckets: [],
      },
      capacity: {
        fyStartDate: "2026-04-01", dataWindowEndDate: "2026-06-30",
        dataCutoffWorkingDays: 78, demonstratedVisitsPerDay: 0.04,
        annualCapacityAnchor: 100, anchorFy: "2025-26",
        feasibleRemainingVisits: 97, remainingRequired: 1, gap: 96,
        workingDaysRemaining: 250, monthlyCapacity: 10,
      },
      historicalFyCapacity: [], totalFeasible: 97, totalRequired: 1, gap: 96,
      unassignedExcluded: 0,
      monthPlans: [{
        month: "Jul", workingDays: 26, capacity: 10, maintenanceVisits: 1,
        developmentVisits: 9, poolExhausted: false,
        targets: [{
          name: "Retailer One", district: "D", distanceKm: 12.5, ob: 80,
          businessPlan: 100, visitsDone: 3, priority: "maintain", reason: "maintain active business",
        }],
      }],
    };
    const workbook = buildDeepDiveWorkbook(input({
      winBack: dormantRows,
      retailerDetail: { ...detail, rows: retailerRows, visitPlan } as unknown as MemberSheetData,
    }));
    const dormant = workbook.getWorksheet("Dormant Retailers")!;
    expect((dormant.getColumn(1).values as unknown[]).filter((v) => /^Dormant \d+$/.test(String(v)))).toHaveLength(25);
    const coverage = workbook.getWorksheet("Coverage and Visits")!;
    expect(coverage.getRows(1, coverage.rowCount)!.some((r) => r.getCell(2).value === "Retailer One")).toBe(false);
    const working = workbook.getWorksheet("Working detail")!;
    for (const header of ["District", "City", "Distributor", "Distance km", "Annual plan", "Visits required",
      "OB", "Sales received", "Visits done", "Achievement", "Effective OB", "Effective plan", "Status",
      "Visit month", "Target name", "Target district", "Target distance km", "Target OB", "Target visits", "Visit decision"]) {
      expect((working.getRow(2).values as unknown[])).toContain(header);
    }
    const retailer = working.getRows(1, working.rowCount)!.find((r) => r.getCell(2).value === "Retailer One")!;
    expect(retailer.getCell(13).value).toBe(12.5);
    expect(retailer.getCell(16).value).toBe(80);
    expect(retailer.getCell(14).value).toBe(100);
    expect(retailer.getCell(19).value).toBeCloseTo(0.8, 8);
    expect(retailer.getCell(19).numFmt).toBe("0.00%");
    const target = working.getRows(1, working.rowCount)!.find((r) =>
      r.getCell(1).value === "Visit target rows" && r.getCell(26).value === "Retailer One",
    )!;
    expect(target.getCell(25).value).toBe("Jul");
    expect(target.getCell(27).value).toBe("D");
    expect(target.getCell(28).value).toBe(12.5);
    expect(target.getCell(29).value).toBe(80);
    expect(target.getCell(30).value).toBe(3);
    expect(target.getCell(31).value).toContain("maintain");
  });

  it("uses the real NOOFORDERS field for count/day and leaves it unavailable when absent", () => {
    const withOrders = buildDeepDiveWorkbook(input({
      kpis: fixture({ workingDaysActual: 10, extra: { NOOFORDERS: 23 } }),
    }));
    const cost = withOrders.getWorksheet("Cost")!;
    expect(row(cost, "Order booking value/working day").getCell(2).value).toBe(11);
    expect(row(cost, "Orders count/working day").getCell(2).value).toBe(2.3);
    expect(row(cost, "Orders count/working day").getCell(7).value).toContain("NOOFORDERS");
    const unavailable = buildDeepDiveWorkbook(input({ kpis: fixture({ workingDaysActual: 10 }) }))
      .getWorksheet("Cost")!;
    expect(row(unavailable, "Orders count/working day").getCell(2).value).toBeNull();
    expect(row(unavailable, "Orders count/working day").getCell(6).value).toBe("unavailable");
  });

  it("keeps dashboard coverage counts separate from the working population", () => {
    const workbook = buildDeepDiveWorkbook(input({
      kpis: fixture({ totalRetailers: 64, visitedRetailers: 46, nonVisitedRetailers: 18 }),
      retailerDetail: {
        ...detail,
        spread: { ...(detail as any).spread, totalRetailers: 59 },
      } as unknown as MemberSheetData,
    }));
    const coverage = workbook.getWorksheet("Coverage and Visits")!;
    expect(row(coverage, "Visited retailers").getCell(2).value).toBe(46);
    expect(row(coverage, "Non-visited retailers").getCell(2).value).toBe(18);
    expect(row(coverage, "Working-sheet total retailers").getCell(2).value).toBe(59);
    expect(row(coverage, "Population arithmetic mismatch (dashboard visited + non-visited − working total)").getCell(2).value).toBe(5);
    expect(row(coverage, "Total retailers").getCell(7).value).toContain("STATE HEAD DASHBOARD");
    expect(row(coverage, "Working-sheet total retailers").getCell(7).value).toContain("member working-sheet");
  });

  it("uses all declared retailers for the selected business-per-retailer denominator", () => {
    const workbook = buildDeepDiveWorkbook(input({
      kpis: fixture({ totalRetailers: 10 }),
      retailerDetail: {
        ...detail,
        spread: { ...(detail as any).spread, totalRetailers: 10, activeRetailers: 2, businessPerActiveRetailer: 55 },
      } as unknown as MemberSheetData,
      benchmarks: [{
        metric: "businessPerRetailer",
        median: 12,
        population: "peer declared totals",
        peerCount: 3,
        period: "FY 2026-27 resolved YTD",
        source: "test peer snapshot",
      }],
    }));
    const summary = workbook.getWorksheet("Summary for Decision")!;
    const business = summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("Business per retailer vs peer median"))!;
    expect(business.getCell(3).value).toBeCloseTo(110 / 10, 8);
    expect(String(business.getCell(2).value)).toContain("all retailers");
    expect(String(business.getCell(2).value)).not.toContain("active");
  });

  it("describes OB and sales as conditional source/timing measures", () => {
    const above = buildDeepDiveWorkbook(input());
    const aboveText = String(above.getWorksheet("Summary for Decision")!
      .getRows(1, above.getWorksheet("Summary for Decision")!.rowCount)!
      .find((r) => String(r.getCell(2).value).startsWith("Plain decision"))!.getCell(2).value);
    expect(aboveText).toContain("distinct source/timing measures");
    expect(aboveText).toContain("conversion/basis review");
    expect(aboveText).not.toContain("has not converted");

    const below = buildDeepDiveWorkbook(input({
      kpis: fixture({ orderBooking: 10, directDealersOrder: 0, newPartyOrderBooking: 0, sale: 90 }),
    }));
    const belowText = String(below.getWorksheet("Summary for Decision")!
      .getRows(1, below.getWorksheet("Summary for Decision")!.rowCount)!
      .find((r) => String(r.getCell(2).value).startsWith("Plain decision"))!.getCell(2).value);
    expect(belowText).toContain("Sales received exceeds order booking");
    expect(belowText).not.toContain("has not converted");
  });

  it("reconstructs Neel-style YTD cost from monthly CTC and authoritative elapsed months", () => {
    const workbook = buildDeepDiveWorkbook(input({
      kpis: fixture({
        ctcMonthly: 51950,
        taBillStCost: null,
        elapsedMonths: 4,
        elapsedMonthsFromSheet: 4,
        sale: 719342,
        extra: {
          ...fixture().extra,
          CTC: 207800,
          BUSINESSACHIEVEDBY: 18,
        },
      }),
      roiCost: null,
      reportingMonthCount: 5,
      retailerDetail: null,
      retailerDetailStatus: "loading",
      benchmarks: [{
        metric: "costRatio",
        median: 3,
        population: "active peers under state head Maharashtra",
        peerCount: 10,
        period: "FY 2026-27 resolved YTD",
        source: "resolved peer snapshots",
        basis: "ctcOnly",
      }],
    }));
    const summary = workbook.getWorksheet("Summary for Decision")!;
    const cost = summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("YTD cost vs Sales Received"))!;
    expect(cost.getCell(3).value).toBe(259750);
    expect(String(cost.getCell(2).value)).toContain("known CTC");
    const ratio = summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("Cost ratio vs peer median"))!;
    expect(ratio.getCell(3).value).toBeCloseTo((259750 / 719342 * 100) / 100, 8);
    expect(String(ratio.getCell(2).value)).toContain("Benchmark median 3.00");
    expect(String(ratio.getCell(2).value)).toContain("basis ctcOnly");
    expect(String(ratio.getCell(4).value)).toContain("peer median");
    expect(summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("Sales / cost multiple"))!.getCell(3).value).toBeCloseTo(719342 / 259750, 8);
    expect(summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("OB / cost multiple"))!.getCell(3).value).toBeCloseTo(110 / 259750, 8);
    const parties = summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("Parties giving business"))!;
    expect(parties.getCell(3).value).toBe(18);
    expect(String(parties.getCell(2).value)).toContain("BUSINESSACHIEVEDBY");
    const working = workbook.getWorksheet("Working detail")!;
    expect(row(working, "Authoritative elapsed months").getCell(3).value).toBe(5);
    expect(row(working, "YTD CTC").getCell(3).value).toBe(259750);
    expect(row(working, "Cost ratio benchmark basis").getCell(3).value).toBe("ctcOnly");
    const info = workbook.getWorksheet("Info")!;
    expect((info.getColumn(2).values as unknown[]).map(String).join(" | ")).toContain("basis ctcOnly");
  });

  it("derives five closed Apr-Aug months for an empty current-FY monthly payload", () => {
    const asOf = Date.UTC(2026, 8, 13);
    expect(closedReportingMonthCount("2026-27", asOf)).toBe(5);
    const workbook = buildDeepDiveWorkbook(input({
      monthlyRows: [],
      reportingMonthCount: closedReportingMonthCount("2026-27", asOf),
      kpis: fixture({
        ctcMonthly: 51950,
        elapsedMonths: 4,
        elapsedMonthsFromSheet: 4,
        taBillStCost: null,
        sale: 719342,
      }),
      roiCost: null,
    }));
    const summary = workbook.getWorksheet("Summary for Decision")!;
    const cost = summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("YTD cost vs Sales Received"))!;
    expect(cost.getCell(3).value).toBe(259750);
    const unavailable = summary.getRows(1, summary.rowCount)!.find((r) =>
      String(r.getCell(2).value).startsWith("Unavailable measures"))!;
    expect(String(unavailable.getCell(2).value)).toContain("YTD T.A.");
  });

  it("does not export raw internal A4 fields and explains the segment vocabulary limitation", () => {
    const workbook = buildDeepDiveWorkbook(input());
    const all = values(workbook).map(String).join(" | ");
    expect(all).not.toContain("must not be exported");
    expect(all).toContain("A4: omitted internal source field.");
    expect(all).toContain("brand_canon");
    expect(all).toContain("No item code or six-master join was available");
    expect(values(workbook)).not.toContain(0.56789);
    expect(all).not.toContain("Cost Ratio (Sale)");
    expect(all).toContain("COSTRATIOSALE: unverified source field; suppressed from all numeric KPI rows.");
  });
});