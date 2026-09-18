import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("../../companyReports.js", () => ({ buildCompanyReports: vi.fn() }));
vi.mock("../../momentum/momentumInsights.js", () => ({ buildMomentumInsights: vi.fn() }));
vi.mock("../../overviewPerformance.js", () => ({ buildOverviewPerformance: vi.fn() }));
vi.mock("../../comparison/comparison.js", () => ({ runComparison: vi.fn() }));
vi.mock("../../dashboard/sync.js", () => ({ ensureSeeded: vi.fn() }));

import { buildCompanyReports } from "../../companyReports.js";
import { buildMomentumInsights } from "../../momentum/momentumInsights.js";
import { buildOverviewPerformance } from "../../overviewPerformance.js";
import { runComparison } from "../../comparison/comparison.js";
import { ensureSeeded } from "../../dashboard/sync.js";
import {
  COMPANY_REPORT_PAYLOAD_KEYS,
  COMPANY_REPORT_VARIANTS,
  parseCommercialPath,
  resolveCommercialSurface,
} from "./commercialSurfaceNodes.js";

describe("commercial graph path contract", () => {
  it("accepts bounded report and series paths", () => {
    expect(parseCommercialPath("company-report/7/2026-27")).toEqual({
      surface: "company-report", report: 7, fy: "2026-27",
    });
    expect(parseCommercialPath("momentum/2026-27")).toEqual({
      surface: "momentum", fy: "2026-27",
    });
    expect(parseCommercialPath("comparison/2026-27")).toEqual({
      surface: "comparison", fy: "2026-27",
    });
  });

  it("rejects unbounded or malformed variants", () => {
    expect(parseCommercialPath("company-report/8/2026-27")).toBeNull();
    expect(parseCommercialPath("company-report/1/2026-27/extra")).toBeNull();
    expect(parseCommercialPath("momentum/2026-27/member/Ravi")).toBeNull();
    expect(parseCommercialPath("growth/not-a-fy")).toBeNull();
  });

  it("executes each report against its distinct prepared payload", async () => {
    vi.mocked(buildCompanyReports).mockResolvedValue({
      fy: "2026-27", priorFy: "2025-26", likeMonths: ["Apr-26"], likeMonthsPrior: ["Apr-25"],
      r1r2_byState: [{ label: "R1", thisFy: 1, lastFy: 0, diff: 1, growthPct: null, sharePct: 100 }],
      r2_byStateMonth: [{ state: "UP", month: "Apr-26", thisFy: 2, lastFy: 1 }],
      r3_byGroup: [], r3a_byStateGroup: [], r3b_byPartyGroup: [],
      r4_byGroupQty: [{ group: "PTMT", subcategory: "x", groupRaw: "x", customer: "c", state: "UP", qtyThisFy: 3, qtyLastFy: 2, amountThisFy: 4, amountLastFy: 3, unit: "pieces" }],
      r5_byCustomer: [{ customer: "c", state: "UP", head: "h", thisFy: 5, lastFy: 4, diff: 1 }],
      r3c_byGroupFull: [], r6_byGroupFull: [{ group: "PTMT", thisFyLike: 6, lastFyLike: 5, lastFyFull: 8, growthLike: 20 }],
      r7_asOf: { date: "2026-05-01", total: 99, byGroup: [], byState: [], invoiceCount: 1, customerCount: 1, note: "fixture" },
      monthlyPrimary: [],
    } as never);
    for (let report = 1; report <= 7; report++) {
      const result = await resolveCommercialSurface({ surface: "company-report", fy: "2026-27", report });
      expect((result.detail as any)?.payloadKey).toBe(COMPANY_REPORT_PAYLOAD_KEYS[report - 1]);
    }
    expect(vi.mocked(buildCompanyReports)).toHaveBeenCalledTimes(7);
  });

  it("publishes every prepared Report 3 drill variant as nested typed measures", async () => {
    vi.mocked(buildCompanyReports).mockResolvedValue({
      fy: "2026-27", priorFy: "2025-26", likeMonths: ["Apr-26"], likeMonthsPrior: ["Apr-25"],
      r1r2_byState: [], r2_byStateMonth: [], r2_byPartyMonth: [],
      r3_byGroup: [{ label: "PTMT", thisFy: 10, lastFy: 8, growthPct: 25, diff: 2, sharePct: 100 }],
      r3_bySubcategory: [{ group: "PTMT", subcategory: "Taps", thisFy: 6, lastFy: 5 }],
      r3a_byStateGroup: [{ state: "UP", group: "PTMT", subcategory: "Taps", thisFy: 4, lastFy: 3 }],
      r3b_byPartyGroup: [{ customer: "Dealer", state: "UP", group: "PTMT", subcategory: "Taps", thisFy: 3, lastFy: 2 }],
      r3c_byGroupFull: [{ group: "PTMT", thisFyLike: 10, lastFyLike: 8, lastFyFull: 20, growthLike: 25 }],
      r4_byGroupQty: [], r5_byCustomer: [], r6_byGroupFull: [], r7_asOf: {
        date: "2026-05-01", total: 0, byGroup: [], byState: [], invoiceCount: 0, customerCount: 0, note: "",
      }, monthlyPrimary: [],
    } as never);
    expect(COMPANY_REPORT_VARIANTS[3]).toEqual([
      "r3_byGroup", "r3_bySubcategory", "r3a_byStateGroup", "r3b_byPartyGroup", "r3c_byGroupFull",
    ]);
    const result = await resolveCommercialSurface({ surface: "company-report", fy: "2026-27", report: 3 });
    const drill = (result.detail as any).drill;
    expect(new Set(drill.map((row: any) => row.variant))).toEqual(new Set(COMPANY_REPORT_VARIANTS[3]));
    expect(drill.every((row: any) => Array.isArray(row.measures))).toBe(true);
    expect(drill.some((row: any) => row.measures.some((m: any) => m.measure === "comparison_pct" && m.basis))).toBe(true);
  });

  it("publishes the overview monthly series and its supplied growth basis", async () => {
    vi.mocked(buildOverviewPerformance).mockResolvedValue({
      fy: "2026-27", priorFy: "2025-26",
      months: [{ label: "Apr-26", current: 120, prior: 100, growthPct: 20, state: "closed", currentSource: "sale_line", priorSource: "sale_line" }],
      closedComparableYtd: { currentSalesInr: 120, priorSalesInr: 100, growthPct: 20, growthNumeratorInr: 20, growthDenominatorInr: 100, throughDate: "2026-04-30" },
      companyAchievement: {} as never,
    } as never);
    const result = await resolveCommercialSurface({ surface: "growth", fy: "2026-27" });
    expect(result.source).toBe("buildOverviewPerformance");
    expect((result.detail as any)?.months).toHaveLength(1);
    expect(result.measures[1]?.basis?.numerator).toContain("growthNumerator");
  });

  it("executes comparison with an explicit primary basis", async () => {
    vi.mocked(runComparison).mockResolvedValue({ blocked: false, basis: { source: "sale_line" }, matrix: [] } as never);
    const result = await resolveCommercialSurface({ surface: "comparison", fy: "2026-27" });
    expect(result.source).toBe("runComparison");
    expect(vi.mocked(runComparison).mock.calls[0]?.[0]).toMatchObject({ basis: "primary", entityType: "company" });
  });

  it("executes the coverage builder over the dashboard snapshot", async () => {
    vi.mocked(ensureSeeded).mockResolvedValue({
      syncedAt: new Date("2026-05-01T00:00:00.000Z"),
      data: { heads_resources: [], coverage: [], coverage_totals: { states: 1, districts: 2, cities: 3, retailers: 4 } },
    } as never);
    const result = await resolveCommercialSurface({ surface: "coverage", fy: "2026-27" });
    expect(result.source).toBe("coverageReports.buildPayload");
    expect(result.measures[0]).toMatchObject({ label: "Covered retailers", value: 4, unit: "count" });
  });

  it("publishes seasonal projection metadata and suppresses flat pacing", async () => {
    vi.mocked(buildMomentumInsights).mockResolvedValue({
      meta: { fy: "2026-27", likeMonths: ["Apr-26"], priorLikeMonths: ["Apr-25"], channel: "territory",
        channelLabel: "territory", latestMonthNote: "Apr closed", filterNote: null, generatedAt: "2026-05-01", guards: [] },
      headline: { nominal: { current: 1, prior: 1, growthPct: 2 }, real: { index: null, indexName: null, currentReal: null, growthPct: null }, series: [], consecutiveRealDeclines: 0 },
      acceleration: { months: [{ month: "Apr-26", yoyPct: 2, seasonalNote: "like month" }], latestRate: 2, previousRate: null, direction: null },
      runRate: { ytd: 1, curveShareOfYear: 10, curveName: "approved curve v1", varianceNote: null, projection: 10, flatProjection: 8, priorFyTotal: 9, note: "seasonal" },
    } as never);
    const result = await resolveCommercialSurface({ surface: "momentum", fy: "2026-27" });
    const seasonal = result.measures.find((m) => m.label === "Seasonal year-end projection") as any;
    const flat = result.measures.find((m) => m.label.includes("Flat pacing")) as any;
    expect(seasonal.projection).toMatchObject({ seasonalService: "buildMomentumInsights", calibrationBasis: "approved curve v1" });
    expect(seasonal.value).toBe(100000000);
    expect(flat.availability).toBe("not_applicable");
    expect(flat).not.toHaveProperty("value");
  });
});
