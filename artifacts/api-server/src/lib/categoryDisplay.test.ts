import { describe, expect, it } from "vitest";
import {
  MASTER_CATEGORIES,
  MASTER_CATEGORY_DISPLAY_NOTE,
  latestReviewedMasterJoinSql,
  rollUpMarginRows,
} from "./categoryDisplay.js";

describe("master-category display classification", () => {
  it("uses the approved six-master list with Water Tank assigned to PLUMBING", () => {
    expect(MASTER_CATEGORIES).toEqual([
      "PLUMBING", "PTMT", "C P", "SANITARYWARE", "SINK", "HARDWARE",
    ]);
    const grouped = rollUpMarginRows(
      [
        { code: "WT-1", revenue: 100, cost: 60 },
        { code: "CP-1", revenue: 80, cost: 50 },
        { code: "UNKNOWN", revenue: 20, cost: 10 },
      ],
      new Map([["WT-1", "PLUMBING"], ["CP-1", "C P"]]),
    );
    expect(grouped).toEqual([
      { group: "PLUMBING", revenue: 100, cost: 60 },
      { group: "C P", revenue: 80, cost: 50 },
      { group: "Unmapped", revenue: 20, cost: 10 },
    ]);
    expect(grouped.reduce((sum, row) => sum + row.revenue, 0)).toBe(200);
    expect(grouped.reduce((sum, row) => sum + row.cost, 0)).toBe(120);
  });

  it("selects the latest reviewed non-null master without rewriting effective history", () => {
    const join = latestReviewedMasterJoinSql("sl");
    expect(join).toContain("r.master_category IS NOT NULL");
    expect(join).toContain("r.effective_from DESC");
    expect(join).not.toContain("sl.invoice_date");
    expect(MASTER_CATEGORY_DISPLAY_NOTE).toContain("historical periods");
    expect(MASTER_CATEGORY_DISPLAY_NOTE).toContain("effective-dated registry history");
  });
});