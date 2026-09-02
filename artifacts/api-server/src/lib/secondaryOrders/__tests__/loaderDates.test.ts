import { describe, expect, it } from "vitest";
import { assertProductWiseEraStart, isNormalSecondaryOrderUploadVerification, parseOrderDatetime } from "../loader.js";
import { isPrompt56AugustDate, literalProductOrderDatetime } from "../legacyV1Parser.js";

describe("secondary order literal date guards", () => {
  it("accepts only Product-Wise's explicit datetime literal or Date", () => {
    expect(parseOrderDatetime("19-08-2026 15:06:12")?.toISOString()).toBe("2026-08-19T09:36:12.000Z");
    expect(parseOrderDatetime("08/19/2026")).toBeNull();
    expect(parseOrderDatetime("2026-08-19T00:00:00Z")).toBeNull();
  });

  it("keeps Prompt 56 Product-Wise datetime parsing literal", () => {
    expect(literalProductOrderDatetime("01-08-2026 00:00:00")?.toISOString()).toBe("2026-07-31T18:30:00.000Z");
    expect(literalProductOrderDatetime("19-08-2026 23:59:59")?.toISOString()).toBe("2026-08-19T18:29:59.000Z");
    expect(isPrompt56AugustDate(literalProductOrderDatetime("01-08-2026 00:00:00")!)).toBe(true);
    expect(isPrompt56AugustDate(literalProductOrderDatetime("20-08-2026 00:00:00")!)).toBe(false);
  });

  it("does not treat Prompt 56 empty lineage metrics as a normal quality baseline", () => {
    expect(isNormalSecondaryOrderUploadVerification({})).toBe(false);
    expect(isNormalSecondaryOrderUploadVerification({ rowsParsed: 1, rowsScanned: 1 })).toBe(true);
  });

  it("rejects an entire Product-Wise load before its August-era start", () => {
    expect(() => assertProductWiseEraStart([
      { orderDatetime: new Date("2026-07-31T18:29:59.000Z") },
    ])).toThrow(/era violation/);
    expect(() => assertProductWiseEraStart([
      { orderDatetime: new Date("2026-08-01T00:00:00.000Z") },
    ])).not.toThrow();
  });
});