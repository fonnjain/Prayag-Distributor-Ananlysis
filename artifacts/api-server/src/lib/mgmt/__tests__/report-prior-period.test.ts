import { describe, expect, it } from "vitest";
import {
  formatTargetProvenance,
  mergeDashboardXlsxTargets,
  resolveMonthlyPlan,
  sumFiscalMonthAmount,
  sumMonthlyPlanRange,
  type TargetProvenance,
} from "../report.js";
import type { DashboardXlsxRecord } from "../dashboardXlsx.js";

describe("prior booking period basis", () => {
  const months = [
    802659, 1054749, 1642560, 1297273, 806671,
    1000000, 1100000, 1200000, 1300000, 1400000, 1500000, 1600000,
  ];

  it("uses Apr-Aug for the Apr-Aug comparison window", () => {
    expect(sumFiscalMonthAmount(months, 1, 5)).toBe(5603912);
  });

  it("uses all twelve months when Full Year is selected", () => {
    expect(sumFiscalMonthAmount(months, 1, 12)).toBe(
      months.reduce((total, amount) => total + amount, 0),
    );
  });

  it("keeps a secondary_head_month SQL NULL as unknown instead of zero", () => {
    expect(resolveMonthlyPlan(null, [100, null], 0)).toBe(100);
    expect(resolveMonthlyPlan(null, [100, null], 1)).toBeNull();
  });

  it("sums the secondary monthly fallback across the selected range without Target Master", () => {
    expect(sumMonthlyPlanRange(null, [100, 200, null], 1, 2)).toBe(300);
    expect(sumMonthlyPlanRange(null, [100, 200, null], 3, 3)).toBeNull();
  });

  it("reports only sources that actually contributed target rows", () => {
    const base = (): TargetProvenance => ({
      targetMaster: { success: true, rowCount: 0, contributedRows: 0, overlays: 0, error: null },
      memberTargets: { success: true, rowCount: 0, contributedRows: 0, overlays: 0, error: null },
      dashboardXlsx: { success: true, rowCount: 2, contributedRows: 0, error: null },
    });
    expect(formatTargetProvenance(base())).toContain("none — target_master");
    expect(
      formatTargetProvenance({
        ...base(),
        targetMaster: { success: true, rowCount: 3, contributedRows: 3, overlays: 0, error: null },
      }),
    ).toBe("target_master (3 contributed of 3 read)");
    expect(
      formatTargetProvenance({
        ...base(),
        dashboardXlsx: { success: true, rowCount: 2, contributedRows: 1, error: null },
      }),
    ).toBe("dashboard_xlsx (1 contributed of 2 read)");
    expect(
      formatTargetProvenance({
        targetMaster: { success: true, rowCount: 3, contributedRows: 3, overlays: 0, error: null },
        memberTargets: { success: true, rowCount: 2, contributedRows: 2, overlays: 1, error: null },
        dashboardXlsx: { success: true, rowCount: 2, contributedRows: 1, error: null },
      }),
    ).toBe("target_master (3 contributed of 3 read); member_targets (2 contributed of 2 read (1 overlays)); dashboard_xlsx (1 contributed of 2 read)");
  });

  it("includes exact read errors when neither target source contributed", () => {
    expect(
      formatTargetProvenance({
        targetMaster: { success: false, rowCount: 0, contributedRows: 0, overlays: 0, error: "Target Master 403" },
        memberTargets: { success: false, rowCount: 0, contributedRows: 0, overlays: 0, error: "DB unavailable" },
        dashboardXlsx: { success: false, rowCount: 0, contributedRows: 0, error: "XLSX missing" },
      }),
    ).toBe("none — target_master: Target Master 403; member_targets: DB unavailable; dashboard_xlsx: XLSX missing");
  });

  it("keeps failed-source reasons when another source contributed", () => {
    expect(
      formatTargetProvenance({
        targetMaster: { success: false, rowCount: 0, contributedRows: 0, overlays: 0, error: "Target Master 403" },
        memberTargets: { success: true, rowCount: 2, contributedRows: 2, overlays: 0, error: null },
        dashboardXlsx: { success: false, rowCount: 0, contributedRows: 0, error: "Dashboard XLSX missing" },
      }),
    ).toBe(
      "member_targets (2 contributed of 2 read (0 overlays)); failures: target_master: Target Master 403; dashboard_xlsx: Dashboard XLSX missing",
    );
  });

  it("counts one name-order-mismatch XLSX row once after sorted-token remapping", () => {
    const record = {
      name: "Doe Jane",
      normKey: "doe jane",
      stateHead: "Head",
      state: "State",
      headquarter: "HQ",
      primaryTarget: null,
      secondaryTarget: 120,
      secondaryMonthly: Array(12).fill(null),
      directDealerTarget: null,
      totalTarget: 120,
      targetMonthly: null,
      ctcMonthly: null,
      ctc: null,
      designation: null,
      empCode: null,
      doj: null,
      activeLeft: "Active",
    } satisfies DashboardXlsxRecord;
    const targetMap = new Map();
    const result = mergeDashboardXlsxTargets(
      targetMap,
      new Map([[record.normKey, record]]),
      "2026-27",
      [{ name: "Jane Doe", normKey: "jane doe" }],
    );
    expect(result.contributedRows).toBe(1);
    expect(targetMap.size).toBe(1);
    expect(targetMap.has("doe jane")).toBe(false);
    expect(targetMap.has("jane doe")).toBe(true);
  });
});