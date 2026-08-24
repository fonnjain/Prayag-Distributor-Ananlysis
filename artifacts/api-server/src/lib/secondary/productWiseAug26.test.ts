import { describe, expect, it } from "vitest";
import {
  AUG26_PRODUCTWISE_APPROVED_SHA256,
  assertApprovedAug26ProductWiseArchive,
  assertProductWiseAug26Controls,
  assertProductWiseAug26UploadMetadata,
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
    expect(() => assertProductWiseAug26UploadMetadata({ sourceNote: "", uploadedBy: "Data Operations" }))
      .toThrow(/source_note is required/);
    expect(toProductWiseAug26RecordedProvenance({
      sourceNote: "Approved CRM export",
      uploadedBy: "Data Operations",
      uploadedAt: "2026-08-24T12:00:00.000Z",
      archiveSha256: AUG26_PRODUCTWISE_APPROVED_SHA256,
    }, prepared().controls)).toMatchObject({
      fy: "2026-27",
      month: "Aug-26",
      rows: 8_602,
      net: 56_403_177,
      valueBasis: "Basic Order Value (ex-GST)",
    });
  });
});