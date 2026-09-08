import { describe, expect, it } from "vitest";
import {
  invoiceDifferences,
  isFrozenDrift,
  isPrematureFreezeReconciliationScope,
  PREMATURE_FREEZE_MONTHS,
} from "./frozenDrift.js";
import type { InsertSaleLine } from "@workspace/db";
import { currentOpenFy } from "../fyAnchors.js";

function line(
  invoiceNo: string,
  invoiceDate: string,
  amount: number,
): InsertSaleLine {
  return {
    lineUid: `${invoiceNo}-${amount}`,
    fy: "2026-27",
    invoiceNo,
    invoiceDate,
    monthLabel: "Jun-26",
    code: "SKU-1",
    amount: String(amount),
    source: "sheets",
  } as InsertSaleLine;
}

describe("frozen drift materiality", () => {
  it("flags every row-count difference and only material net-only differences", () => {
    expect(isFrozenDrift(-1, 0)).toBe(true);
    expect(isFrozenDrift(0, 1000)).toBe(false);
    expect(isFrozenDrift(0, -1000)).toBe(false);
    expect(isFrozenDrift(0, 1000.01)).toBe(true);
  });
});


describe("frozen drift invoice evidence", () => {
  it("keeps only added, removed, and changed invoice summaries with dates", () => {
    const result = invoiceDifferences(
      [
        line("APP-ONLY", "2026-06-30", 100),
        line("CHANGED", "2026-06-30", 200),
      ],
      [
        line("SHEET-ONLY", "2026-06-30", 300),
        line("CHANGED", "2026-06-30", 250),
      ],
    );

    expect(result.removals).toEqual([
      { invoice: "APP-ONLY", date: "2026-06-30", lineCount: 1, net: 100 },
    ]);
    expect(result.additions).toEqual([
      { invoice: "SHEET-ONLY", date: "2026-06-30", lineCount: 1, net: 300 },
    ]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      invoice: "CHANGED",
      app: { date: "2026-06-30", lineCount: 1, net: 200 },
      sheet: { date: "2026-06-30", lineCount: 1, net: 250 },
    });
  });
});

describe("premature freeze reconciliation scope", () => {
  it("is limited to the exact three current-FY months and cannot become a generic unfreeze", () => {
    expect(isPrematureFreezeReconciliationScope(currentOpenFy(), [...PREMATURE_FREEZE_MONTHS])).toBe(true);
    expect(isPrematureFreezeReconciliationScope("1900-01", [...PREMATURE_FREEZE_MONTHS])).toBe(false);
    expect(isPrematureFreezeReconciliationScope(currentOpenFy(), ["May-26", "Jun-26", "Jul-26"])).toBe(false);
    expect(isPrematureFreezeReconciliationScope(currentOpenFy(), ["Jun-26", "Jul-26"])).toBe(false);
  });
});