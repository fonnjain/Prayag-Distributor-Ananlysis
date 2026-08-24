import { describe, expect, it } from "vitest";
import {
  assertApprovedJul26PsCode3Archive,
  assertJul26PsCode3Controls,
  assertJul26UploadMetadata,
  JUL26_PSCODE3_APPROVED_ARCHIVE_SHA256,
  toJul26RecordedProvenance,
  type PreparedJul26Load,
} from "./pscode3Jul26.js";

function prepared(overrides: Partial<PreparedJul26Load["controls"]> = {}): PreparedJul26Load {
  return {
    rows: [],
    controls: {
      filesFound: 163,
      filesDropped: 14,
      filesLoading: 149,
      rawRows: 36_805,
      rawNet: 239_311_764,
      rows: 34_147,
      net: 223_436_806,
      gross: 442_326_730.1,
      discountPct: 49.48602677720013,
      footerRows: 149,
      noItemCode: 0,
      noMonth: 0,
      skippedNoValue: 0,
      wrongMonth: 0,
      months: ["Jul-26"],
      ashutoshMainRows: 368,
      ashutoshRudrapurRows: 98,
      ...overrides,
    },
  };
}

describe("assertJul26PsCode3Controls", () => {
  it("accepts the verified July control totals", () => {
    expect(() => assertJul26PsCode3Controls(prepared())).not.toThrow();
  });

  it("refuses an incomplete replacement before any database operation", () => {
    expect(() => assertJul26PsCode3Controls(prepared({ rows: 29_999 }))).toThrow(
      /rows=29999; expected 34147/,
    );
  });

  it("refuses an archive containing a month other than July", () => {
    expect(() => assertJul26PsCode3Controls(prepared({ months: ["Jun-26", "Jul-26"] }))).toThrow(
      /expected Jul-26/,
    );
  });

  it("refuses a control-total-preserving archive with a different fingerprint", () => {
    expect(() => assertApprovedJul26PsCode3Archive("a".repeat(64))).toThrow(
      /only the reviewed July 2026 PSCode_3 archive/,
    );
    expect(() => assertApprovedJul26PsCode3Archive(JUL26_PSCODE3_APPROVED_ARCHIVE_SHA256)).not.toThrow();
  });

  it("refuses a changed raw-source control even if the parsed row total matches", () => {
    expect(() => assertJul26PsCode3Controls(prepared({ rawNet: 239_311_765 }))).toThrow(
      /rawNet=239311765; expected 239311764/,
    );
  });
});

describe("July raw-SKU upload provenance", () => {
  it("rejects a protected upload without the required operator evidence", () => {
    expect(() => assertJul26UploadMetadata({ sourceNote: "", uploadedBy: "Nishant" }))
      .toThrow(/source_note is required/);
    expect(() => assertJul26UploadMetadata({ sourceNote: "Drive archive received from sales", uploadedBy: "" }))
      .toThrow(/uploaded_by is required/);
  });

  it("serializes the durable result evidence written after a successful load", () => {
    expect(toJul26RecordedProvenance({
      sourceNote: "July source archive supplied by Sales Operations",
      uploadedBy: "Nishant",
      uploadedAt: "2026-08-24T08:30:00.000Z",
      archiveSha256: JUL26_PSCODE3_APPROVED_ARCHIVE_SHA256,
    }, prepared().controls)).toEqual({
      sourceNote: "July source archive supplied by Sales Operations",
      uploadedBy: "Nishant",
      uploadedAt: "2026-08-24T08:30:00.000Z",
      archiveSha256: JUL26_PSCODE3_APPROVED_ARCHIVE_SHA256,
      fy: "2026-27",
      month: "Jul-26",
      rows: 34_147,
      net: 223_436_806,
    });
  });
});