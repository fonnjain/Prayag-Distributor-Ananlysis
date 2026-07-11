// Pure-logic tests for the SAP month derivation. No DB or Sheets access: we
// hand-build the rate-list maps and assert the cross-foot invariant (every
// dimension sums back to the grand total), the territory/institutional split,
// customer matching, and unmapped-group surfacing.
import { describe, expect, it } from "vitest";
import { createMonthAccumulator, deriveMonthSummary } from "../lib/sap/derive.js";
import type { RateListMaps } from "../lib/sap/rateList.js";
import { normParty } from "../lib/mgmt/names.js";
import type { SapRow } from "../lib/sap/sapStream.js";

function buildMaps(): RateListMaps {
  const items = new Map();
  items.set("ITEM-A", {
    code: "ITEM-A",
    itemName: "Faucet A",
    itemType: "FAUCETS",
    group: "Faucets",
    category: "FG",
    mrp: 1000,
  });
  items.set("ITEM-B", {
    code: "ITEM-B",
    itemName: "Shower B",
    itemType: "SHOWERS",
    group: "Showers",
    category: "FG",
    mrp: 500,
  });
  const customers = new Map();
  customers.set(normParty("Acme Traders"), {
    name: "Acme Traders",
    head: "Sandeep Dadheech",
    state: "Rajasthan",
    channel: "Retail",
  });
  customers.set(normParty("Govt Project Cell"), {
    name: "Govt Project Cell",
    head: "PROJECT",
    state: "Delhi",
    channel: "Project",
  });
  return { items, customers };
}

function row(partial: Partial<SapRow>): SapRow {
  return {
    invoiceNo: null,
    date: null,
    customer: null,
    city: null,
    code: null,
    qty: null,
    mrp: null,
    saleRate: null,
    taxable: 0,
    ...partial,
  };
}

describe("deriveMonthSummary", () => {
  const maps = buildMaps();
  const rows: SapRow[] = [
    row({ invoiceNo: "I1", customer: "Acme Traders", code: "ITEM-A", qty: 2, taxable: 1000 }),
    row({ invoiceNo: "I2", customer: "Govt Project Cell", code: "ITEM-B", qty: 1, taxable: 400 }),
    // Unknown item code -> Unmapped group, unknown customer -> unmatched.
    row({ invoiceNo: "I3", customer: "Mystery Buyer", code: "ITEM-Z", qty: 5, taxable: 200 }),
  ];
  const s = deriveMonthSummary(rows, maps, "2026-27", "Apr-26");

  it("totals the taxable value as the grand amount", () => {
    expect(s.amount).toBe(1600);
    expect(s.rowsRead).toBe(3);
    expect(s.invoiceCount).toBe(3);
    expect(s.customerCount).toBe(3);
  });

  it("splits territory vs institutional and they sum to the grand total", () => {
    expect(s.territoryAmount).toBe(1000);
    expect(s.institutionalAmount).toBe(600);
    expect(s.territoryAmount + s.institutionalAmount).toBe(s.amount);
  });

  it("cross-foots: group, head, and state each sum back to the grand total", () => {
    const sum = (arr: Array<{ amount: number }>) =>
      arr.reduce((a, b) => a + b.amount, 0);
    expect(sum(s.byGroup)).toBe(s.amount);
    expect(sum(s.byHead)).toBe(s.amount);
    expect(sum(s.byState)).toBe(s.amount);
  });

  it("counts matched vs unmatched customers", () => {
    expect(s.matchedRows).toBe(2);
    expect(s.matchedRevenue).toBe(1400);
    expect(s.unmatchedCustomers).toEqual([{ name: "Mystery Buyer", amount: 200 }]);
  });

  it("surfaces unmapped item groups without losing revenue", () => {
    expect(s.unmappedGroups.length).toBe(1);
    expect(s.unmappedGroups[0].amount).toBe(200);
    const unmapped = s.byGroup.find((g) => g.key === "Unmapped");
    expect(unmapped?.amount).toBe(200);
  });
});

describe("month derivation from invoice date", () => {
  const maps = buildMaps();
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it("derives the month label from each row's date", () => {
    const acc = createMonthAccumulator(maps, "2026-27", "Apr-26");
    acc.addRow(row({ customer: "Acme Traders", code: "ITEM-A", date: d("2026-04-15"), taxable: 1000 }));
    const stats = acc.audit();
    expect(stats.monthsDetected).toEqual([{ month: "Apr-26", rows: 1, amount: 1000 }]);
    expect(stats.offMonthRows).toBe(0);
    expect(stats.inMonthRows).toBe(1);
    expect(acc.finish().amount).toBe(1000);
  });

  it("excludes rows dated outside the requested month and flags them", () => {
    const acc = createMonthAccumulator(maps, "2026-27", "Apr-26");
    acc.addRow(row({ customer: "Acme Traders", code: "ITEM-A", date: d("2026-04-10"), taxable: 1000 }));
    acc.addRow(row({ customer: "Acme Traders", code: "ITEM-A", date: d("2026-05-02"), taxable: 500 }));
    const stats = acc.audit();
    expect(stats.offMonthRows).toBe(1);
    expect(stats.offMonthAmount).toBe(500);
    expect(stats.inMonthRows).toBe(1);
    // Only the in-month row lands in the aggregation.
    const s = acc.finish();
    expect(s.amount).toBe(1000);
    expect(stats.monthsDetected.map((m) => m.month).sort()).toEqual(["Apr-26", "May-26"]);
  });

  it("detects a fully wrong-month file (no in-month rows)", () => {
    const acc = createMonthAccumulator(maps, "2026-27", "Apr-26");
    acc.addRow(row({ customer: "Acme Traders", code: "ITEM-A", date: d("2026-06-01"), taxable: 700 }));
    const stats = acc.audit();
    expect(stats.scannedRows).toBe(1);
    expect(stats.offMonthRows).toBe(1);
    expect(stats.inMonthRows).toBe(0);
  });

  it("falls back to the requested month for undated rows", () => {
    const acc = createMonthAccumulator(maps, "2026-27", "Apr-26");
    acc.addRow(row({ customer: "Acme Traders", code: "ITEM-A", taxable: 300 }));
    const stats = acc.audit();
    expect(stats.undatedRows).toBe(1);
    expect(stats.offMonthRows).toBe(0);
    expect(stats.inMonthRows).toBe(1);
    expect(acc.finish().amount).toBe(300);
  });
});
