// Pure-logic tests for the SAP verification gate. buildReportFromSummaries is a
// pure reducer over per-month summaries, so we hand-build summaries and assert
// the benchmark gate, cross-foot tolerance, match threshold, and the combined
// verified flag that drives the analytics cutover.
import { describe, expect, it } from "vitest";
import { buildReportFromSummaries } from "../lib/sap/verify.js";
import type { MonthSummary } from "../lib/sap/derive.js";

// A balanced month: group/head/state each sum to `amount`, match >95%.
function month(monthLabel: string, amount: number): MonthSummary {
  const matchedRevenue = Math.round(amount * 0.98);
  return {
    fy: "2026-27",
    monthLabel,
    rowsRead: 100,
    amount,
    territoryAmount: amount,
    institutionalAmount: 0,
    maxInvoiceDate: null,
    invoiceCount: 100,
    customerCount: 50,
    byHead: [{ head: "Sandeep Dadheech", amount, isTerritory: true }],
    byState: [{ key: "RAJASTHAN", amount }],
    byGroup: [{ key: "Faucets", amount }],
    byCustomer: [["Acme Traders", amount]],
    byCode: [{ code: "ITEM-A", qty: 10, revenue: amount, group: "Faucets" }],
    matchedRows: 98,
    matchedRevenue,
    unmatchedCustomers: [],
    unmappedGroups: [],
  };
}

// The benchmark expects ~73 Cr across Apr-Jul; split it evenly so a full,
// balanced upload verifies.
const APR_JUL = ["Apr-26", "May-26", "Jun-26", "Jul-26"].map((m) =>
  month(m, 730000000 / 4),
);

describe("buildReportFromSummaries", () => {
  it("verifies when all four benchmark months are present, balanced, and matched", () => {
    const r = buildReportFromSummaries("2026-27", APR_JUL);
    expect(r.benchmark.ok).toBe(true);
    expect(r.crossFoot.ok).toBe(true);
    expect(r.match.revenuePct).toBeGreaterThan(95);
    expect(r.verified).toBe(true);
  });

  it("does not verify with an empty upload set", () => {
    const r = buildReportFromSummaries("2026-27", []);
    expect(r.verified).toBe(false);
    expect(r.benchmark.ok).toBe(false);
  });

  it("fails the benchmark gate when a benchmark month is missing", () => {
    const r = buildReportFromSummaries("2026-27", APR_JUL.slice(0, 3));
    expect(r.benchmark.presentMonths).toHaveLength(3);
    expect(r.benchmark.ok).toBe(false);
    expect(r.verified).toBe(false);
  });

  it("fails the benchmark gate when the total is outside 5% tolerance", () => {
    const low = ["Apr-26", "May-26", "Jun-26", "Jul-26"].map((m) =>
      month(m, (730000000 * 0.8) / 4),
    );
    const r = buildReportFromSummaries("2026-27", low);
    expect(r.benchmark.ok).toBe(false);
    expect(r.verified).toBe(false);
  });

  it("fails the cross-foot when a dimension does not sum to the grand total", () => {
    const broken = APR_JUL.map((s) => ({ ...s }));
    // Corrupt one month's byGroup so Sigma group != grand total.
    broken[0] = {
      ...broken[0],
      byGroup: [{ key: "Faucets", amount: broken[0].amount - 5 }],
    };
    const r = buildReportFromSummaries("2026-27", broken);
    expect(r.crossFoot.ok).toBe(false);
    expect(r.crossFoot.maxDeltaRupees).toBeGreaterThan(1);
    expect(r.verified).toBe(false);
  });

  it("fails when customer match revenue is below the 95% target", () => {
    const poor = APR_JUL.map((s) => ({
      ...s,
      matchedRevenue: Math.round(s.amount * 0.9),
      matchedRows: 90,
    }));
    const r = buildReportFromSummaries("2026-27", poor);
    expect(r.match.revenuePct).toBeLessThan(95);
    expect(r.verified).toBe(false);
  });
});
