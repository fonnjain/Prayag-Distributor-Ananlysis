import { describe, expect, it } from "vitest";
import { completeLikeMonthNames, historyFlag, lookupFrozenStateKey, median, targetAnchoredQuintile } from "./aiSalesPlanShared";

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
});