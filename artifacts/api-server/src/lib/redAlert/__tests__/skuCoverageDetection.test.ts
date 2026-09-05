import { describe, expect, it } from "vitest";
import { detectAlerts } from "../detectAlerts.js";
import type { DetectionContext } from "../types.js";

const FY = "2026-27";
const COMPLETE_MONTHS = ["Apr-26", "May-26", "Jun-26", "Jul-26"];

function makeContext(): DetectionContext {
  return {
    pool: null as unknown as DetectionContext["pool"],
    // A March primary purchase establishes a real distributor, followed by
    // four zero-primary months in the current FY.
    customerSale: [{
      fy: "2025-26", monthLabel: "Mar-26", customer: "ACME DISTRIBUTOR",
      headCanon: null, stateCanon: null, channel: "retail", groupCanon: null,
      value: 1_000_000, qty: 1,
    }],
    customerMeta: [],
    customerCode: [],
    // A retailer that bought in every comparable prior-month window and has
    // no current raw SKU rows is a B3 candidate if a missing raw month leaks
    // into its evaluation window.
    retailerSale: COMPLETE_MONTHS.map((monthLabel) => ({
      fy: "2025-26",
      monthLabel: monthLabel.replace("-26", "-25"),
      retailer: "RET-SKU-COVERAGE",
      value: 3_000_000,
    })),
    retailerSku: [],
    secHeadMonths: [],
    mrpHistory: [],
    ambiguousCodes: new Set(),
    marginFact: [],
    persons: [],
    customerMaster: new Map(),
    retailerDistributors: new Map(),
    frozenMonths: new Map([[FY, new Set(COMPLETE_MONTHS)]]),
    secCompleteMonths: new Map(),
    lastSheetRead: new Map(),
    personsByNameKey: new Set(),
    departedHeadNames: new Set(),
    retailerPrimaryDist: new Map(),
    // Raw SKU order-booking data is present for every month in the source fixture;
    // skuCompleteMonths controls which of those months detection may use.
    distSecMonthly: new Map(
      COMPLETE_MONTHS.map((monthLabel) => [`ACME DISTRIBUTOR|${FY}|${monthLabel}`, 1_000_000]),
    ),
    headToStateHead: new Map(),
    retailerHeadCanon: new Map(),
  };
}

function run(skuCompleteMonths: string[]) {
  return detectAlerts(makeContext(), {
    fy: FY,
    primaryCompleteMonths: COMPLETE_MONTHS,
    skuCompleteMonths,
    nowDate: new Date("2026-08-01T00:00:00Z"),
    c5AsOfDate: new Date("2026-08-01T00:00:00Z"),
  });
}

describe("detectAlerts raw-SKU coverage policy", () => {
  it("excludes a frozen raw-SKU gap from B3/S1, then includes it after the SKU load", () => {
    const beforeSkuLoad = run(["Apr-26", "May-26", "Jun-26"]);
    const b3Before = beforeSkuLoad.alerts.find((alert) => alert.code === "B3");

    expect(b3Before?.currentMonths).toEqual(["Apr-26", "May-26", "Jun-26"]);
    expect(beforeSkuLoad.alerts.filter((alert) => alert.code === "S1")).toHaveLength(1);
    expect(beforeSkuLoad.alerts.find((alert) => alert.code === "S1")?.currentMonths)
      .toEqual(["Apr-26", "May-26", "Jun-26"]);

    const afterSkuLoad = run(COMPLETE_MONTHS);
    const b3After = afterSkuLoad.alerts.find((alert) => alert.code === "B3");

    expect(b3After?.currentMonths).toEqual(COMPLETE_MONTHS);
    expect(afterSkuLoad.alerts.find((alert) => alert.code === "S1")?.currentMonths)
      .toEqual(COMPLETE_MONTHS);
  });
});