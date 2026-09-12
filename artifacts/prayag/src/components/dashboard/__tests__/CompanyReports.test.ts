import { describe, expect, it } from "vitest";
import { formatReport2Growth, sortReport2Months } from "../CompanyReports";

describe("Report 2 month drill presentation", () => {
  it("formats large real growth to one decimal without capping it", () => {
    expect(formatReport2Growth(854.5685170933435, 100)).toBe("+754.6%");
  });

  it("distinguishes new business from unavailable growth", () => {
    expect(formatReport2Growth(6_500_000, null)).toBe("new");
    expect(formatReport2Growth(6_500_000, 0)).toBe("new");
    expect(formatReport2Growth(null, 0)).toBe("—");
    expect(formatReport2Growth(null, 1_000_000)).toBe("—");
  });

  it("keeps valid declines visible", () => {
    expect(formatReport2Growth(0, 1_000_000)).toBe("-100.0%");
  });

  it("sorts months in fiscal order", () => {
    const rows = [
      { month: "Aug-26" },
      { month: "Jun-26" },
      { month: "Apr-26" },
      { month: "Jul-26" },
      { month: "May-26" },
    ];
    expect(sortReport2Months(rows).map((row) => row.month))
      .toEqual(["Apr-26", "May-26", "Jun-26", "Jul-26", "Aug-26"]);
  });
});