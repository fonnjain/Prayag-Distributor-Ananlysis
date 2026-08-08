// Task 172 guards: RET# column detection, merged-cell carry-forward, and
// serial-pollution prevention in the secondary SKU loader.
import { describe, it, expect } from "vitest";
import { parseTab, normaliseRetId, checkReplaceSanity } from "./skuLoader.js";

describe("checkReplaceSanity (pre-delete gate for replace mode)", () => {
  const good = { rowsParsed: 300_000, rowsWithRetId: 300_000, tabsWithItemCodes: 4, existingRows: 250_000 };
  it("accepts a genuine full parse", () => {
    expect(checkReplaceSanity(good)).toEqual({ ok: true });
  });
  it("refuses when no data tab was found", () => {
    expect(checkReplaceSanity({ ...good, tabsWithItemCodes: 0 }).ok).toBe(false);
  });
  it("refuses an empty or near-empty parse", () => {
    expect(checkReplaceSanity({ ...good, rowsParsed: 0, rowsWithRetId: 0 }).ok).toBe(false);
    expect(checkReplaceSanity({ ...good, rowsParsed: 999, rowsWithRetId: 999 }).ok).toBe(false);
  });
  it("refuses when RET# coverage collapses (broken carry-forward/columns)", () => {
    expect(checkReplaceSanity({ ...good, rowsWithRetId: 40_000 }).ok).toBe(false);
  });
  it("refuses a suspiciously small replacement of a populated FY", () => {
    expect(checkReplaceSanity({ ...good, rowsParsed: 100_000, rowsWithRetId: 100_000 }).ok).toBe(false);
  });
  it("allows first-time loads of an empty FY (no existing rows)", () => {
    expect(checkReplaceSanity({ rowsParsed: 5_000, rowsWithRetId: 5_000, tabsWithItemCodes: 1, existingRows: 0 })).toEqual({ ok: true });
  });
});

describe("normaliseRetId", () => {
  it("normalises RET# forms", () => {
    expect(normaliseRetId("RET#12345")).toBe("RET#12345");
    expect(normaliseRetId("ret# 12345")).toBe("RET#12345");
    expect(normaliseRetId("RET 987")).toBe("RET#987");
  });
  it("rejects bare serials and junk (never pollute retailer_id again)", () => {
    expect(normaliseRetId("123")).toBeNull();
    expect(normaliseRetId("1")).toBeNull();
    expect(normaliseRetId("SR.NO")).toBeNull();
    expect(normaliseRetId("")).toBeNull();
  });
});

const HEADER = ["SR.NO.", "DATE", "RETAILER ID", "RETAILER", "ORDER ID", "SEGMENT", "CAT. NO.", "QTY", "MRP", "ORDER VALUE", "DISTRIBUTOR", "DISCOUNT", "SUB TOTAL", "ORDER TOTAL", "TEAM MEMBER"];

describe("parseTab RET# handling", () => {
  it("binds retailerId to RETAILER ID (not SR.NO) and retailer to RETAILER (not RETAILER ID)", () => {
    const rows = [
      HEADER,
      ["1", "01-05-2024", "RET#111", "ALPHA TRADERS", "ORD1", "CPVC", "C100", "2", "50", "100", "DIST A", "", "100", "", "TM ONE"],
    ];
    const res = parseTab("T", rows as never, "2024-25", "sheet1");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].retailerId).toBe("RET#111");
    expect(res.rows[0].retailer).toBe("ALPHA TRADERS");
  });

  it("carry-forwards merged RET#/retailer/date/segment cells", () => {
    const rows = [
      HEADER,
      ["1", "01-05-2024", "RET#111", "ALPHA TRADERS", "ORD1", "CPVC", "C100", "2", "50", "100", "DIST A", "", "100", "", "TM ONE"],
      // merge-continuation rows: identity cells blank
      ["", "", "", "", "", "", "C200", "1", "80", "80", "", "", "80", "", ""],
      ["", "", "", "", "", "SWR", "C300", "3", "20", "60", "", "", "60", "", ""],
    ];
    const res = parseTab("T", rows as never, "2024-25", "sheet1");
    expect(res.rows).toHaveLength(3);
    expect(res.rows[1].retailerId).toBe("RET#111");
    expect(res.rows[1].retailer).toBe("ALPHA TRADERS");
    expect(res.rows[1].monthLabel).toBe(res.rows[0].monthLabel);
    expect(res.rows[1].segmentRaw).toBe("CPVC");
    expect(res.rows[2].segmentRaw).toBe("SWR");
    expect(res.rowsWithRetId).toBe(3);
  });

  it("does not leak the previous block's RET# into a new retailer block without one", () => {
    const rows = [
      HEADER,
      ["1", "01-05-2024", "RET#111", "ALPHA TRADERS", "ORD1", "CPVC", "C100", "2", "50", "100", "DIST A", "", "100", "", "TM ONE"],
      ["2", "02-05-2024", "", "BETA AGENCIES", "ORD2", "SWR", "C200", "1", "80", "80", "DIST B", "", "80", "", "TM ONE"],
    ];
    const res = parseTab("T", rows as never, "2024-25", "sheet1");
    expect(res.rows).toHaveLength(2);
    expect(res.rows[1].retailer).toBe("BETA AGENCIES");
    expect(res.rows[1].retailerId).toBeNull();
  });

  it("never stores a bare serial as retailer_id (old ID-column layouts)", () => {
    const header = ["S.NO", "DATE", "RETAILERS", "ID", "SEGMENT", "CAT.NO", "QTY", "MRP", "ORDER VALUE", "DISTRIBUTOR", "DISCOUNT", "SUB TOTAL", "ORDER TOTAL", "TEAM MEMBER"];
    const rows = [
      header,
      ["7", "01-06-2021", "GAMMA STORES", "RET#555", "AGRI", "A10", "1", "10", "10", "DIST C", "", "10", "", "TM TWO"],
      ["8", "01-06-2021", "DELTA STORES", "42", "AGRI", "A11", "1", "10", "10", "DIST C", "", "10", "", "TM TWO"],
    ];
    const res = parseTab("T", rows as never, "2021-22", "sheet2");
    expect(res.rows[0].retailerId).toBe("RET#555");
    expect(res.rows[1].retailerId).toBeNull();
  });
});
