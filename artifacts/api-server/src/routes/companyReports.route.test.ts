import { describe, expect, it } from "vitest";
import { applyMonthFilter, asOfScopedMonths } from "../lib/companyReports.js";
import {
  DRILL_ROW_LIMIT,
  parseCompanyReportsFilter,
  parseJsonArray,
  registryJoinForDrill,
  report4Reconciliation,
} from "./companyReports.js";

describe("company reports filter and drill period contract", () => {
  it("merges repeated/JSON array query values into one canonical, deduplicated filter", () => {
    expect(parseJsonArray(["[\"Party A\", \"Party B\"]", "[\"Party B\", \"Party C\"]"])).toEqual([
      "Party A", "Party B", "Party C",
    ]);
    expect(parseCompanyReportsFilter({
      customers: ["[\"Party A\"]", "[\"Party A\", \"Party B\"]"],
      states: "[\"BIHAR\"]",
      months: ["Apr-26,May-26", "May-26"],
    })).toEqual({
      invalidMonths: false,
      filter: {
        customers: ["Party A", "Party B"],
        states: ["BIHAR"],
        months: ["Apr-26", "May-26"],
      },
    });
  });

  it("rejects malformed month labels while retaining the canonical filter contract", () => {
    expect(parseCompanyReportsFilter({ months: "April-26", customers: "[\"Party A\"]" })).toEqual({
      invalidMonths: true,
      filter: { months: ["April-26"], customers: ["Party A"] },
    });
  });

  it("validates every month input before duplicate removal or truncation", () => {
    const thirteen = Array.from({ length: 13 }, () => "Apr-26");
    expect(parseCompanyReportsFilter({ months: thirteen }).invalidMonths).toBe(true);
    expect(parseCompanyReportsFilter({
      months: [...Array.from({ length: 12 }, () => "Apr-26"), "NotAMonth"],
    }).invalidMonths).toBe(true);
  });

  it("scopes a clicked period to complete-like current/prior month pairs", () => {
    expect(applyMonthFilter(
      ["Apr-26", "May-26", "Jun-26"],
      ["Apr-25", "May-25", "Jun-25"],
      { months: ["May-26"] },
    )).toEqual({
      likeMonths: ["May-26"],
      likeMonthsPrior: ["May-25"],
    });
  });

  it("reconciles an R7 parent and child over the same filtered as-of period", () => {
    const months = asOfScopedMonths("2026-27", "2026-05-31", ["Apr-26", "May-26", "Jun-26"]);
    const parentByMonth = new Map([
      ["Apr-26", 100],
      ["May-26", 250],
      ["Jun-26", 900],
    ]);
    const childRows = [
      { month: "Apr-26", invoiceDate: "2026-04-15", amount: 60 },
      { month: "Apr-26", invoiceDate: "2026-04-30", amount: 40 },
      { month: "May-26", invoiceDate: "2026-05-15", amount: 150 },
      { month: "May-26", invoiceDate: "2026-05-31", amount: 100 },
      { month: "Jun-26", invoiceDate: "2026-06-01", amount: 900 },
    ].filter((row) => months.includes(row.month) && row.invoiceDate <= "2026-05-31");
    const parentAmount = months.reduce((sum, month) => sum + (parentByMonth.get(month) ?? 0), 0);
    const childAmount = childRows.reduce((sum, row) => sum + row.amount, 0);
    expect(months).toEqual(["Apr-26", "May-26"]);
    expect(parentAmount).toBe(350);
    expect(childAmount).toBe(parentAmount);
    expect(asOfScopedMonths("2026-27", "2026-05-31", [])).toEqual([]);
  });

  it("keeps Report 4 complete through the five-thousand-row cap", () => {
    expect(DRILL_ROW_LIMIT).toBeGreaterThanOrEqual(5_000);
    const reconciliation = report4Reconciliation(DRILL_ROW_LIMIT + 1, 10_000, 10_000);
    expect(reconciliation.complete).toBe(false);
    expect(reconciliation.unattributed).toBeNull();
    expect(reconciliation.delta).toBe(0);
  });

  it("keeps the drill registry lookup bounded and non-lateral", () => {
    const chunks = (registryJoinForDrill() as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
    const plan = JSON.stringify(chunks);
    expect(plan).toContain("NOT EXISTS");
    expect(plan).not.toContain("LATERAL");
    expect(plan).toContain("effective_from");
    expect(plan).toContain("effective_to");
  });
});