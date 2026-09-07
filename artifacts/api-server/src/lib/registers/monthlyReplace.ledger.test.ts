import { describe, expect, it } from "vitest";
import {
  buildRegisterMonthlyLedgerPreview,
  canonicalRegisterEvidenceRow,
  canonicalRegisterFingerprint,
  classifyMonthlyReadGuard,
} from "./monthlyReplace.js";

describe("primary monthly ledger fingerprint", () => {
  it("canonicalizes decimal/date forms and ignores enrichment metadata", () => {
    const source = [{
      fy: "2026-27", monthLabel: "Jan-27", invoiceDate: "2027-01-02",
      code: "A1", amount: "00100.00", qty: "2.0", source: "sheets",
      lineUid: "sheet-identity", channel: null, qtyLtr: "2000",
      groupCanon: "derived",
    }];
    const db = [{
      ...source[0], invoiceDate: new Date("2027-01-02T23:00:00.000Z"),
      amount: "100", qty: "2", lineUid: "different-identity",
      channel: "Retail",
    }];
    expect(canonicalRegisterEvidenceRow(source[0])).toEqual(canonicalRegisterEvidenceRow(db[0]));
    expect(canonicalRegisterFingerprint(source)).toBe(canonicalRegisterFingerprint(db));
  });

  it("is multiset-sensitive but source-row-order-insensitive", () => {
    const row = { fy: "2026-27", monthLabel: "Jan-27", code: "A", amount: "1", source: "sheets" };
    expect(canonicalRegisterFingerprint([row, { ...row, code: "B" }]))
      .toBe(canonicalRegisterFingerprint([{ ...row, code: "B" }, row]));
    expect(canonicalRegisterFingerprint([row, row]))
      .not.toBe(canonicalRegisterFingerprint([row]));
  });
});

describe("primary monthly ledger guard outcomes", () => {
  it("distinguishes strict freeze rejection, catastrophic short read, and accepted small shrink", () => {
    expect(classifyMonthlyReadGuard({
      force: false, frozen: true, lastGood: 12_878, sheetRows: 12_871,
    })).toBe("rejected-shrink");
    expect(classifyMonthlyReadGuard({
      force: false, frozen: false, lastGood: 1_000, sheetRows: 970,
    })).toBe("aborted-short-read");
    expect(classifyMonthlyReadGuard({
      force: false, frozen: false, lastGood: 1_000, sheetRows: 998,
    })).toBeNull();
  });
});

describe("primary monthly ledger dry-run preview", () => {
  const base = Array.from({ length: 1_000 }, (_, index) => ({
    fy: "2026-27",
    monthLabel: "Sep-26",
    invoiceDate: "2026-09-01",
    invoiceNo: `INV-${index}`,
    code: "A",
    color: "WHITE",
    qty: "1",
    amount: "100",
    source: "sheets",
  }));

  it("records a 0.2% source shrink even though it is above the 98% guard", () => {
    const preview = buildRegisterMonthlyLedgerPreview({
      beforeLines: base,
      sourceLines: base.slice(0, 998),
      fy: "2026-27",
      month: "Sep-26",
      attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
      spreadsheet: {
        id: "sheet-id",
        monthSources: {
          "Sep-26": [{ tab: "Sep", contentHash: "source-content-hash" }],
        },
      },
    });

    expect(preview.sourceRowDelta).toBe(-2);
    expect(preview.sourceAmountDelta).toBe("-200");
    expect(preview.sourceShrink).toBe(true);
    expect(preview.actualRowDelta).toBe(-2);
    expect(preview.projectedRowsWritten).toBe(998);
    expect(preview.rowsWritten).toBeNull();
    expect(preview.sourceEvidence).toEqual({
      month: "Sep-26",
      sources: [{ tab: "Sep", contentHash: "source-content-hash" }],
    });
  });

  it("populates every ledger field without representing a committed write", () => {
    const preview = buildRegisterMonthlyLedgerPreview({
      beforeLines: base.slice(0, 1),
      sourceLines: base.slice(0, 1),
      fy: "2026-27",
      month: "Sep-26",
      attemptedAt: new Date("2026-09-07T00:00:00.000Z"),
    });

    for (const [field, value] of Object.entries(preview)) {
      expect(value, field).not.toBeUndefined();
    }
    expect(preview.rowsWritten).toBeNull();
    expect(preview.detail).toContain("no rows");
  });
});