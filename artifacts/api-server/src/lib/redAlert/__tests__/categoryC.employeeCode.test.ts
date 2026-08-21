import { describe, expect, it } from "vitest";
import { buildCategoryCAlerts } from "../categoryC.js";
import type { DetectionContext } from "../types.js";

function makeCtx(headCanon: string): DetectionContext {
  return {
    pool: null as unknown as DetectionContext["pool"],
    customerSale: [],
    customerCode: [],
    retailerSale: [],
    retailerSku: [],
    customerMeta: [],
    secHeadMonths: [{
      fy: "2026-27",
      headCanon,
      stateHead: "Nasir Hussain Khan",
      monthLabel: "Apr-26",
      monthIdx: 1,
      planAmount: 1,
      orderedAmount: 1,
      receivedAmount: 1,
      notYetRecorded: false,
      isAnomaly: false,
      ingestedAt: new Date("2026-01-01T00:00:00.000Z"),
    }],
    mrpHistory: [],
    ambiguousCodes: new Set(),
    marginFact: [],
    persons: [{
      normKey: headCanon,
      canonicalName: "Basit Ahmad Pala",
      stateHead: "Nasir Hussain Khan",
      isStateHead: false,
      hrStatus: "Active",
      isPerson: true,
    }],
    customerMaster: new Map(),
    retailerDistributors: new Map(),
    retailerPrimaryDist: new Map(),
    distSecMonthly: new Map(),
    headToStateHead: new Map(),
    retailerHeadCanon: new Map(),
    frozenMonths: new Map(),
    secCompleteMonths: new Map(),
    lastSheetRead: new Map([[headCanon, new Date("2026-01-01T00:00:00.000Z")]]),
    personsByNameKey: new Set(),
    departedHeadNames: new Set(),
  };
}

const cfg = {
  C1_CONCENTRATION_SHARE_PCT: 60,
  C1_DECLINE_PCT: 15,
  C2_STATE_DECLINE_PCT: 15,
  C2_SUSTAINED_PERIODS: 2,
  C3_SEGMENT_UNDER_INDEX_PTS: 20,
  C4_GROSS_CONTRIBUTION_DROP_PCT: 15,
  C5_SHEET_STALENESS_DAYS: 10,
  C6_MIN_STOPS: 10,
  C6_MIN_STOP_SHARE_PCT: 30,
  C6_MATERIALITY_FLOOR_RUPEES: 0,
} as Parameters<typeof buildCategoryCAlerts>[3];

describe("C5 employee-code identity guard", () => {
  it("never emits a person-attributed C5 alert for Basit and Jijo's shared numeric code", () => {
    const alerts = buildCategoryCAlerts(
      makeCtx("5900000000000"),
      "2026-27",
      ["Apr-26"],
      cfg,
      new Date("2026-02-01T00:00:00.000Z"),
    );

    expect(alerts.filter((alert) => alert.code === "C5")).toEqual([]);
  });
});