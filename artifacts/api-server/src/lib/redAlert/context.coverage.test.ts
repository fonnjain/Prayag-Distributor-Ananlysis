import { describe, expect, it, vi } from "vitest";
import { getSkuAlertCoverage } from "./context.js";

describe("getSkuAlertCoverage", () => {
  it("keeps a frozen raw-SKU gap out of B3/S1 and explains why", async () => {
    const pool = {
      query: vi.fn(async (query: string) => {
        if (query.includes("register_month_state")) {
          return { rows: [{ month_label: "Apr-26" }, { month_label: "Jul-26" }] };
        }
        if (query.includes("MAX(ingested_at)")) {
          return { rows: [] };
        }
        return { rows: [{ month_label: "Apr-26" }] };
      }),
    };

    const coverage = await getSkuAlertCoverage(pool as never, "2026-27");

    expect(coverage.evaluatedMonths).toEqual(["Apr-26"]);
    expect(coverage.excludedMonths).toContainEqual({
      monthLabel: "Jul-26",
      reason: "raw_sku_data_missing",
    });
    expect(coverage.excludedMonths).toContainEqual({
      monthLabel: "Aug-26",
      reason: "primary_month_not_frozen",
    });
    expect(coverage.latestLoadedMonth).toBeNull();
    expect(coverage.latestLoadedAt).toBeNull();
    expect(coverage.latestLoadedAgeDays).toBeNull();
  });

  it("includes a frozen month only when distributor-level raw SKU data exists", async () => {
    const pool = {
      query: vi.fn(async (query: string) => {
        if (query.includes("MAX(ingested_at)")) {
          return { rows: [{ month_label: "Jul-26", loaded_at: "2026-08-24T00:00:00.000Z" }] };
        }
        return { rows: [{ month_label: "Apr-26" }, { month_label: "Jul-26" }] };
      }),
    };

    const coverage = await getSkuAlertCoverage(pool as never, "2026-27");

    expect(coverage.evaluatedMonths).toEqual(["Apr-26", "Jul-26"]);
    expect(coverage.excludedMonths).not.toContainEqual({
      monthLabel: "Jul-26",
      reason: "raw_sku_data_missing",
    });
    expect(coverage.latestLoadedMonth).toBe("Jul-26");
    expect(coverage.latestLoadedAt).toBe("2026-08-24T00:00:00.000Z");
    expect(coverage.latestLoadedAgeDays).toBeTypeOf("number");
  });
});