import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("@workspace/db", () => ({ pool: { query } }));

import {
  generateAiSchemesHistoryProposal,
  readAiSchemesHistory,
} from "./aiSchemesHistory.js";

const rows = {
  scheme: [{
    scheme_id: "OBSERVED_CP",
    name: "Observed CP",
    audience: ["sub_dealer"],
    settlement: "company",
    qualification_basis: "cumulative_value",
    territory_group: "KERALA/KARNATAKA",
    product_scope: "CP",
    period_from: "2026-07-01",
    period_to: "2026-09-30",
    period_note: "Q2",
  }],
  slab: [
    { scheme_id: "OBSERVED_CP", slab_order: 1, threshold_from: "50000", threshold_to: "99999", unit: "rupees", rate: "0.03", reward_status: "ok", alt_reward: null, free_goods: null, raw_text: "Observed 3%" },
    { scheme_id: "OBSERVED_CP", slab_order: 2, threshold_from: "100000", threshold_to: null, unit: "rupees", rate: "0.06", reward_status: "ok", alt_reward: null, free_goods: null, raw_text: "Observed 6%" },
  ],
  territory: [{ group_raw: "KERALA/KARNATAKA", label: "Kerala / Karnataka", states: ["KERALA", "KARNATAKA"] }],
  item: [{ item_group: "CP", scheme_id: "OBSERVED_CP" }],
};

beforeEach(() => {
  query.mockImplementation((statement: string) => {
    if (statement.includes("FROM scheme_reward_slab")) return Promise.resolve({ rows: rows.slab });
    if (statement.includes("FROM territory_group")) return Promise.resolve({ rows: rows.territory });
    if (statement.includes("FROM scheme_item_group")) return Promise.resolve({ rows: rows.item });
    return Promise.resolve({ rows: rows.scheme });
  });
});

describe("Prompt 95 historical scheme basis", () => {
  it("labels raw/canonical coverage and outcome unavailability", async () => {
    const result = await readAiSchemesHistory({ itemGroup: "CP", territory: "KERALA" });
    expect(result.readOnly).toBe(true);
    expect((result.coverage as { canonical: { available: boolean } }).canonical.available).toBe(false);
    expect((result.outcomeAvailability as { available: boolean }).available).toBe(false);
    expect((result.schemes as unknown[])).toHaveLength(1);
  });

  it("normalizes PostgreSQL Date values before period classification", async () => {
    query.mockImplementation((statement: string) => {
      if (statement.includes("FROM scheme_reward_slab")) return Promise.resolve({ rows: rows.slab });
      if (statement.includes("FROM territory_group")) return Promise.resolve({ rows: rows.territory });
      if (statement.includes("FROM scheme_item_group")) return Promise.resolve({ rows: rows.item });
      return Promise.resolve({
        rows: [{
          ...rows.scheme[0],
          period_from: new Date("2026-07-01T00:00:00.000Z"),
          period_to: new Date("2026-07-31T00:00:00.000Z"),
        }],
      });
    });

    const result = await readAiSchemesHistory();
    const scheme = (result.schemes as Array<{ periodFrom: string; periodTo: string | null }>)[0];
    expect(scheme.periodFrom).toBe("2026-07-01");
    expect(scheme.periodTo).toBe("2026-07-31");
    expect((result.historySummary as { historicalCount: number }).historicalCount).toBe(1);
  });

  it("copies an observed structure, caps rates, and performs no writes", async () => {
    const result = await generateAiSchemesHistoryProposal({
      itemGroup: "CP",
      territory: "KERALA",
      breadthOpportunityRetailers: 2,
      categoryGrossMarginInr: 1_000_000,
      grossMarginRatePct: 20,
      marginCapPct: 4,
    });
    const proposal = result.proposal as { slabs: Array<{ ratePct: number | null }> };
    expect(proposal.slabs.map((slab) => slab.ratePct)).toEqual([3, 4]);
    expect((result.proposal as { estimatedCostInr: number }).estimatedCostInr).toBe(100_000);
    expect((result.proposal as { costAsMarginPct: number }).costAsMarginPct).toBe(10);
    expect(result.persisted).toBe(false);
    expect(result.writes).toEqual([]);
    expect((result.breakeven as { available: boolean; value: number }).available).toBe(true);
    expect((result.breakeven as { value: number }).value).toBe(500_000);
    const flags = result.flags as {
      beyondPrecedent: boolean;
      modeledRateCeilingApplied: boolean;
      modeledRateCeilingBinding: boolean;
      historicalCostCeilingAvailable: boolean;
      historicalCostComparisonPerformed: boolean;
      statement: string;
    };
    expect(flags.beyondPrecedent).toBe(false);
    expect(flags.modeledRateCeilingApplied).toBe(true);
    expect(flags.modeledRateCeilingBinding).toBe(true);
    expect(flags.historicalCostCeilingAvailable).toBe(false);
    expect(flags.historicalCostComparisonPerformed).toBe(false);
    expect(flags.statement).toMatch(/modeled rate ceiling/i);
    expect(flags.statement).toMatch(/no historical cost comparison/i);
    expect((result.proposal as { modeledCostAssumption: string }).modeledCostAssumption)
      .toBe("Conservative modeled cost assumption: first usable observed percentage slab threshold × breadthOpportunityRetailers.");
    expect(query.mock.calls.every(([statement]) => !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(statement))).toBe(true);
  });

  it("rejects held and unknown-margin inputs", async () => {
    await expect(generateAiSchemesHistoryProposal({
      itemGroup: "CP",
      territory: "KERALA",
      breadthOpportunityRetailers: 1,
      categoryGrossMarginInr: 1_000_000,
      grossMarginRatePct: 20,
      marginCapPct: 4,
      marginStatus: "held",
    })).rejects.toThrow(/held|unknown/i);
    await expect(generateAiSchemesHistoryProposal({
      itemGroup: "CP",
      territory: "KERALA",
      breadthOpportunityRetailers: 1,
      categoryGrossMarginInr: 1_000_000,
      grossMarginRatePct: 20,
      marginStatus: "unknown",
    })).rejects.toThrow(/held|unknown/i);
  });

  it("rejects missing modeled economics", async () => {
    await expect(generateAiSchemesHistoryProposal({
      itemGroup: "CP",
      territory: "KERALA",
      marginCapPct: 4,
    })).rejects.toThrow(/breadthOpportunityRetailers/i);
  });
});