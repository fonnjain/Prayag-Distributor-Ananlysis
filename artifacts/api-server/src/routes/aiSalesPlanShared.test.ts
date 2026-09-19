import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { completeLikeMonthNames, crossesSecondarySourceSeam, historyFlag, isValidDistId, isValidRetId, lookupFrozenStateKey, median, missingSecondaryMonths, targetAnchoredQuintile } from "./aiSalesPlanShared";

describe("Prompt 105 shared computation pure rules", () => {
  it("anchors quintile on target and applies floor", () => {
    expect(targetAnchoredQuintile(100, [90, 80, 70, 60, 50, 40, 30, 20, 10]).quintile).toBe(0);
    expect(targetAnchoredQuintile(1, [2, 3, 4, 5, 6, 7, 8, 9, 10]).available).toBe(false);
  });
  it("computes median over one value per peer", () => {
    expect(median([10, 30, 20])).toBe(20);
  });
  it("suppresses flags for limited history and compares like months", () => {
    expect(historyFlag(10, 0, 0, true)).toBe("STOPPED");
    expect(historyFlag(100, 60, 100, true)).toBe("DOWN30");
    expect(historyFlag(100, 140, 100, true)).toBe("UP30");
    expect(historyFlag(100, 0, 0, false)).toBeNull();
  });
  it("looks up frozen title-case state keys case-insensitively", () => {
    expect(lookupFrozenStateKey("delhi", ["Delhi", "Rajasthan"])).toBe("Delhi");
    expect(lookupFrozenStateKey("Unknown", ["Delhi"])).toBeNull();
  });
  it("excludes partial August from like-month flags", () => {
    const names = completeLikeMonthNames(["Apr-26", "May-26", "Jul-26"]);
    expect(names.has("aug")).toBe(false);
    expect(names.has("jul")).toBe(true);
  });
  it("accepts only the correct RET# and DIST# identity prefixes", () => {
    expect(isValidRetId("RET#54782")).toBe(true);
    expect(isValidRetId("DIST#54782")).toBe(false);
    expect(isValidDistId("DIST#34")).toBe(true);
    expect(isValidDistId("DIS#34")).toBe(false);
    expect(isValidDistId("RET#31724")).toBe(false);
  });
  it("refuses monetary penetration arithmetic across the July/August source seam", () => {
    expect(crossesSecondarySourceSeam(["Jul-26", "Aug-26"])).toBe(true);
    expect(crossesSecondarySourceSeam(["Aug-26"])).toBe(false);
    expect(crossesSecondarySourceSeam(["Jul-26"])).toBe(false);
  });
  it("requires full month labels so wrong-source or wrong-year rows cannot mark a period loaded", () => {
    expect(missingSecondaryMonths(["Aug-26"], ["Aug"])).toEqual(["Aug-26"]);
    expect(missingSecondaryMonths(["Aug-26"], ["Aug-26"])).toEqual([]);
    expect(missingSecondaryMonths(["Jan-27", "Feb-27", "Mar-27"], ["Aug-26"])).toEqual(["Jan-27", "Feb-27", "Mar-27"]);
  });
  it("guards Product-Wise penetration against line-weighted and lexical-period arithmetic", () => {
    const source = readFileSync(new URL("./aiSalesPlanShared.ts", import.meta.url), "utf8");
    expect(source).toContain("GROUP BY dealer_id, product_code");
    expect(source).toContain("secondarySourceForMonth(period)");
    expect(source).toContain("TO_CHAR(order_datetime AT TIME ZONE 'Asia/Kolkata','Mon-YY')=ANY");
    expect(source).toContain("No secondary rows loaded for requested month(s)");
    expect(source).toContain("source_kind='product_wise'");
    expect(source).toContain("entry.month === month && entry.source === source");
    expect(source).not.toContain('period >= "Aug-26"');
  });
});
