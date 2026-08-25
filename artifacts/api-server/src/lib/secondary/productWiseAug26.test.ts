import { describe, expect, it } from "vitest";
import {
  AUG26_PRODUCTWISE_APPROVED_SHA256,
  AUG26_PRODUCTWISE_SOURCE_FILE,
  assertApprovedAug26ProductWiseArchive,
  assertProductWiseAug26Controls,
  assertProductWiseAug26MonthWritable,
  assertProductWiseAug26OverrideMetadata,
  assertProductWiseAug26UploadMetadata,
  assertProductWiseRangeReplacementCoverage,
  productWiseAug26MonthStatus,
  productWiseMonthFreezeDecision,
  productWiseRangeMonthPlan,
  toProductWiseAug26RecordedProvenance,
  type PreparedProductWiseAug26Load,
} from "./productWiseAug26.js";

function prepared(overrides: Partial<PreparedProductWiseAug26Load["controls"]> = {}): PreparedProductWiseAug26Load {
  return {
    rows: [],
    controls: {
      rowsScanned: 8_602,
      rows: 8_602,
      rowsRejected: 0,
      noMonth: 0,
      wrongMonth: 0,
      missingNames: 0,
      missingItemCode: 0,
      missingBasicValue: 0,
      net: 56_403_177,
      qty: 322_465,
      retailers: 1_132,
      distributors: 128,
      itemCodes: 1_605,
      salespeople: 121,
      orders: 1_361,
      pendingRows: 430,
      months: ["Aug-26"],
      meanDiscountPct: 48.83,
      unmappedCategories: [],
      ...overrides,
    },
  };
}

describe("Product-Wise Aug-26 source controls", () => {
  it("accepts the reviewed workbook controls", () => {
    expect(() => assertProductWiseAug26Controls(prepared())).not.toThrow();
  });

  it("refuses a partial, wrong-period, or wrong-value replacement", () => {
    expect(() => assertProductWiseAug26Controls(prepared({ rows: 8_601 }))).toThrow(/rows=8601/);
    expect(() => assertProductWiseAug26Controls(prepared({ months: ["Jul-26"] }))).toThrow(/expected Aug-26/);
    expect(() => assertProductWiseAug26Controls(prepared({ net: 56_403_178 }))).toThrow(/net=56403178/);
  });

  it("pins the approved source fingerprint", () => {
    expect(() => assertApprovedAug26ProductWiseArchive("a".repeat(64))).toThrow(/reviewed 1–19 Aug-26/);
    expect(() => assertApprovedAug26ProductWiseArchive(AUG26_PRODUCTWISE_APPROVED_SHA256)).not.toThrow();
  });

  it("requires provenance and records the Basic Order Value basis", () => {
    expect(() => assertProductWiseAug26UploadMetadata({
      sourceNote: "", uploadedBy: "Data Operations", sourceFile: AUG26_PRODUCTWISE_SOURCE_FILE,
    }))
      .toThrow(/source_note is required/);
    expect(toProductWiseAug26RecordedProvenance({
      sourceNote: "Approved CRM export",
      uploadedBy: "Data Operations",
      uploadedAt: "2026-08-24T12:00:00.000Z",
      archiveSha256: AUG26_PRODUCTWISE_APPROVED_SHA256,
      sourceFile: AUG26_PRODUCTWISE_SOURCE_FILE,
    }, prepared().controls)).toMatchObject({
      fy: "2026-27",
      month: "Aug-26",
      rows: 8_602,
      net: 56_403_177,
      valueBasis: "Basic Order Value (ex-GST)",
      controls: { rows: 8_602, net: 56_403_177 },
    });
  });
});

describe("Product-Wise month immutability", () => {
  it("keeps a loaded current month writable until the shared monthly lock", () => {
    const current = new Date("2026-08-24T12:00:00Z");
    expect(productWiseAug26MonthStatus(true, null, current)).toBe("in_progress");
    expect(() => assertProductWiseAug26MonthWritable({ hasLoad: true, closedAt: null }, null, current))
      .not.toThrow();
  });

  it("refuses a frozen replacement unless an explicit operator and reason are recorded", () => {
    const frozen = new Date("2026-09-08T00:00:00Z");
    expect(productWiseAug26MonthStatus(true, null, frozen)).toBe("frozen_verified");
    expect(() => assertProductWiseAug26MonthWritable({ hasLoad: true, closedAt: null }, null, frozen))
      .toThrow(/requires an explicit audited override/);
    expect(() => assertProductWiseAug26OverrideMetadata({ by: "", reason: "Corrected export" }))
      .toThrow(/override_by is required/);
    expect(() => assertProductWiseAug26MonthWritable(
      { hasLoad: true, closedAt: null },
      { by: "Data Operations", reason: "Approved correction to the frozen source evidence" },
      frozen,
    )).not.toThrow();
  });
});

describe("Product-Wise frozen/open range overlap", () => {
  it("keeps the 7th in the grace window and freezes at the calculated 8th lock instant", () => {
    const now = new Date("2026-09-07T00:00:00.000Z");
    const august = productWiseRangeMonthPlan({
      month: "Aug-26",
      incomingRows: 8_900,
      rowsBefore: 8_602,
      sharedFrozenAt: null,
      now,
    });
    const september = productWiseRangeMonthPlan({
      month: "Sep-26",
      incomingRows: 1_250,
      rowsBefore: 17,
      sharedFrozenAt: null,
      now,
    });

    expect(august).toMatchObject({
      action: "loaded",
      rowsBefore: 8_602,
      rowsAfter: 8_900,
      freezeAt: null,
    });
    expect(september).toMatchObject({
      action: "loaded",
      rowsBefore: 17,
      rowsAfter: 1_250,
      freezeAt: null,
    });
    const delayed = productWiseRangeMonthPlan({
      month: "Aug-26",
      incomingRows: 8_900,
      rowsBefore: 8_602,
      sharedFrozenAt: null,
      now: new Date("2026-09-10T12:00:00.000Z"),
    });
    expect(delayed).toMatchObject({
      action: "frozen-skipped",
      rowsBefore: 8_602,
      rowsAfter: 8_602,
      freezeAt: new Date("2026-09-08T00:00:00.000Z"),
    });
    expect(productWiseMonthFreezeDecision(
      "Aug-26",
      null,
      new Date("2026-09-10T12:00:00.000Z"),
    ).frozenAt).toEqual(new Date("2026-09-08T00:00:00.000Z"));
  });
});

describe("Product-Wise range replacement coverage", () => {
  it("refuses a truncated range export before it can replace an established month", () => {
    expect(() => assertProductWiseRangeReplacementCoverage({
      rowsBefore: 1_000,
      netBefore: 1_000_000,
      rowsIncoming: 1,
      netIncoming: 1_000,
    })).toThrow(/materially short/);
  });

  it("accepts a replacement within the monthly row and net tolerance", () => {
    expect(() => assertProductWiseRangeReplacementCoverage({
      rowsBefore: 1_000,
      netBefore: 1_000_000,
      rowsIncoming: 980,
      netIncoming: 980_000,
    })).not.toThrow();
  });
});