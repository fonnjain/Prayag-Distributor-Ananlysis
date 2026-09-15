import { describe, expect, it, beforeEach } from "vitest";
import {
  buildFactoryPending,
  buildFactoryPendingWorkbook,
  buildPendingPricingFromRows,
  buildConflictIndex,
  invalidateFactoryPendingCache,
  saleQuantityDenominator,
  type AttributionIndex,
  type PendingHead,
} from "./factoryPending.js";
import type { StateHeadAttributionConflictReport } from "./stateHeadAttributionConflicts.js";

function party(partyName: string, total: number): PendingHead["parties"][number] {
  return {
    party: partyName,
    total,
    byGroup: { "GARDEN PIPE": total },
    classification: "None",
    candidateEvidence: [],
    attributionLink: null,
    attribution: {
      classification: "None",
      candidateCount: 0,
      candidates: [],
      conflictEvidence: [],
      conflictLink: null,
    },
    reconciliation: { parent: total, children: total, difference: 0, exact: true },
  };
}

describe("factory pending attribution audit", () => {
  beforeEach(() => invalidateFactoryPendingCache());

  it("keeps the corrected Sandeep quantities and coverage assertions exact", async () => {
    const sandeep: PendingHead = {
      head: "Sandeep Dadheech",
      total: 168445,
      parties: [
        party("M/S PRAYAG BASE", 67718),
        party("BAJRANG HOME INNOVATIONS", 712),
        party("SRI LAKSHMI LALITHA AGENCIES", 3698),
        party("GRAHAA PRIYA ENTERPRISES", 2956),
        party("M/S NO ASSIGNMENT", 58839),
        party("M/S MULTIPLE DISTRIBUTORS", 34522),
      ],
      buckets: [],
      members: [],
      reconciliation: { parent: 168445, children: 168445, difference: 0, exact: true },
      coverage: {
        candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0, cost: 0,
        candidateQty: 0, safeQty: 0, conflictQty: 0, unassignedQty: 0, disputedQty: 0,
      },
      candidateQty: 0, safeQty: 0, conflictQty: 0, disputedQty: 0, unassignedQty: 0,
      candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0,
    };
    const attribution: AttributionIndex = new Map([
      ["prayagbase", [{
        partyKey: "prayagbase", customerId: "DIST#1", customerName: "M/S PRAYAG BASE", assignmentId: 1,
        personId: 1, memberName: "Active member", stateHeadName: "Sandeep Dadheech",
        personActive: true, leftDate: null, registryStatus: "active", registryName: "Active member",
      }]],
      ["bajranghomeinnovations", [{
        partyKey: "bajranghomeinnovations", customerId: "DIST#2", customerName: "BAJRANG HOME INNOVATIONS", assignmentId: 2,
        personId: 2, memberName: "Active candidate 1", stateHeadName: "Sandeep Dadheech",
        personActive: true, leftDate: null, registryStatus: "active", registryName: "Active candidate 1",
      }]],
      ["srilakshmilalithaagencies", [{
        partyKey: "srilakshmilalithaagencies", customerId: "DIST#3", customerName: "SRI LAKSHMI LALITHA AGENCIES", assignmentId: 3,
        personId: 3, memberName: "Active candidate 2", stateHeadName: "Sandeep Dadheech",
        personActive: true, leftDate: null, registryStatus: "active", registryName: "Active candidate 2",
      }, {
        partyKey: "srilakshmilalithaagencies", customerId: "DIST#3", customerName: "SRI LAKSHMI LALITHA AGENCIES", assignmentId: 3,
        personId: 3, memberName: "Active candidate 2", stateHeadName: "Sandeep Dadheech",
        personActive: true, leftDate: null, registryStatus: "active", registryName: "Active candidate 2",
      }]],
      ["grahaapriyaenterprises", []],
      ["noassignment", []],
      ["multipledistributors", [{
        partyKey: "multipledistributors", customerId: "DIST#5", customerName: "M/S MULTIPLE DISTRIBUTORS", assignmentId: 5,
        personId: 5, memberName: "Multiple candidate 1", stateHeadName: "Sandeep Dadheech",
        personActive: true, leftDate: null, registryStatus: "active", registryName: "Multiple candidate 1",
      }, {
        partyKey: "multipledistributors", customerId: "DIST#5", customerName: "M/S MULTIPLE DISTRIBUTORS", assignmentId: 6,
        personId: 6, memberName: "Multiple candidate 2", stateHeadName: "Sandeep Dadheech",
        personActive: true, leftDate: null, registryStatus: "active", registryName: "Multiple candidate 2",
      }]],
    ]);
    const rawConflicts: StateHeadAttributionConflictReport["conflicts"] = [
      {
        state: "MAHARASHTRA",
        customer: "BAJRANG HOME INNOVATIONS",
        cities: ["Pune"],
        workbookHeads: [
          { head: "Sandeep Dadheech", rows: 2, net: 712 },
          { head: "Suresh Nair", rows: 1, net: 100 },
        ],
        derivedRegisterHeads: [{ head: "Sandeep Dadheech", net: 812 }],
        workbookRows: 3,
        workbookNet: 812,
        registerNet: 812,
        departedWorkbookHeads: [],
        packToRegisterRatio: 1,
        crossHeadComparisons: [],
      },
      {
        state: "MAHARASHTRA",
        customer: "GRAHAA PRIYA ENTERPRISES",
        cities: ["Mumbai"],
        workbookHeads: [
          { head: "Babu", rows: 1, net: 2956 },
          { head: "Sandeep Dadheech", rows: 1, net: 100 },
        ],
        derivedRegisterHeads: [{ head: "Sandeep Dadheech", net: 3056 }],
        workbookRows: 2,
        workbookNet: 3056,
        registerNet: 3056,
        departedWorkbookHeads: [],
        packToRegisterRatio: 1,
        crossHeadComparisons: [],
      },
      {
        state: "MAHARASHTRA",
        customer: "SRI LAKSHMI LALITHA AGENCIES",
        cities: ["Nagpur"],
        workbookHeads: [
          { head: "Sandeep Dadheech", rows: 2, net: 3698 },
          { head: "Suresh Nair", rows: 1, net: 50 },
        ],
        derivedRegisterHeads: [{ head: "Sandeep Dadheech", net: 3748 }],
        workbookRows: 3,
        workbookNet: 3748,
        registerNet: 3748,
        departedWorkbookHeads: [],
        packToRegisterRatio: 1,
        crossHeadComparisons: [],
      },
    ];
    const conflicts = buildConflictIndex(rawConflicts);
    const result = await buildFactoryPending({
      readReport2: async () => ({ groups: ["GARDEN PIPE"], grandTotal: 168445, byHead: [sandeep] }),
      loadOrderBookSaleByHead: async () => ({ total: 298679, error: null } as never),
      loadStateHeadSale: async () => ({ total: 147, error: null } as never),
      loadAttributionIndex: async () => attribution,
      loadConflictIndex: async () => conflicts,
      now: () => new Date("2026-09-15T00:00:00.000Z"),
    });
    expect(result.grandTotal).toBe(168445);
    expect(result.coverage.candidateQty).toBe(72128);
    expect(result.coverage.safeQty).toBe(67718);
    expect(result.coverage.conflictQty).toBe(4410);
    expect(result.coverage.unassignedQty).toBe(58839);
    expect(result.coverage.disputedQty).toBe(41888);
    expect(result.reconciliation.company.difference).toBe(0);
    expect(result.candidateCoveragePct).toBe(42.82);
    expect(result.safeCoveragePct).toBe(40.2);
    expect(result.conflictCostPp).toBe(2.62);
    expect(result.byHead[0].coverage.candidateQty).toBe(72128);
    expect(result.byHead[0].coverage.safeQty).toBe(67718);
    for (const [name, workbookHead, registerHead] of [
      ["BAJRANG HOME INNOVATIONS", "Sandeep Dadheech", "Sandeep Dadheech"],
      ["GRAHAA PRIYA ENTERPRISES", "Babu", "Sandeep Dadheech"],
      ["SRI LAKSHMI LALITHA AGENCIES", "Suresh Nair", "Sandeep Dadheech"],
    ]) {
      const row = result.byHead[0].parties.find((item) => item.party === name)!;
      expect(row.classification).toBe("Attribution Conflicts");
      expect(row.candidateEvidence.join(" ")).toContain(name);
      expect(row.candidateEvidence.join(" ")).toContain(workbookHead);
      expect(row.candidateEvidence.join(" ")).toContain(`register-derived heads: ${registerHead}`);
      expect(row.attributionLink).toBe("/org/attribution-conflicts");
    }
  });

  it("retains the factory 298679 total and 147 source parties", async () => {
    const parties = Array.from({ length: 146 }, (_, index) =>
      party(`Party ${index + 1}`, index === 145 ? 14234 : 800),
    );
    const result = await buildFactoryPending({
      readReport2: async () => ({
        groups: ["GARDEN PIPE"],
        grandTotal: 298679,
        byHead: [{
          head: "Factory",
          total: 298679,
          parties: [
            party("Sandeep named", 168445),
            ...parties,
          ],
          buckets: [],
          members: [],
          reconciliation: { parent: 298679, children: 298679, difference: 0, exact: true },
          coverage: {
            candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0, cost: 0,
            candidateQty: 0, safeQty: 0, conflictQty: 0, unassignedQty: 0, disputedQty: 0,
          },
          candidateQty: 0, safeQty: 0, conflictQty: 0, disputedQty: 0, unassignedQty: 0,
          candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0,
        }],
      }),
      loadOrderBookSaleByHead: async () => ({ total: 0, error: null } as never),
      loadStateHeadSale: async () => ({ total: 0, error: null } as never),
      loadAttributionIndex: async () => new Map(),
    });
    expect(result.grandTotal).toBe(298679);
    expect(result.byHead[0].parties.length).toBe(147);
  });

  it("deduplicates repeated open assignments for one person without a conflict-page finding", async () => {
    const result = await buildFactoryPending({
      readReport2: async () => ({
        groups: ["GARDEN PIPE"],
        grandTotal: 10,
        byHead: [{
          head: "Sandeep Dadheech",
          total: 10,
          parties: [party("M/S DUPLICATE OPEN", 10)],
          buckets: [],
          members: [],
          reconciliation: { parent: 10, children: 10, difference: 0, exact: true },
          coverage: {
            candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0, cost: 0,
            candidateQty: 0, safeQty: 0, conflictQty: 0, unassignedQty: 0, disputedQty: 0,
          },
          candidateQty: 0, safeQty: 0, conflictQty: 0, disputedQty: 0, unassignedQty: 0,
          candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0,
        }],
      }),
      loadOrderBookSaleByHead: async () => ({ total: 0, error: null } as never),
      loadStateHeadSale: async () => ({ total: 0, error: null } as never),
      loadAttributionIndex: async () => new Map([["duplicateopen", [
        {
          partyKey: "duplicateopen", customerId: "DIST#9", customerName: "M/S DUPLICATE OPEN",
          assignmentId: 9, personId: 9, memberName: "One member", stateHeadName: "Sandeep Dadheech",
          personActive: true, leftDate: null, registryStatus: "active", registryName: "One member",
        },
        {
          partyKey: "duplicateopen", customerId: "DIST#9", customerName: "M/S DUPLICATE OPEN",
          assignmentId: 10, personId: 9, memberName: "One member", stateHeadName: "Sandeep Dadheech",
          personActive: true, leftDate: null, registryStatus: "active", registryName: "One member",
        },
      ]]]),
      loadConflictIndex: async () => new Map(),
    });
    expect(result.byHead[0].parties[0].classification).toBe("Active member");
    expect(result.byHead[0].parties[0].attribution.candidateCount).toBe(1);
    expect(result.coverage.candidateQty).toBe(10);
    expect(result.coverage.safeQty).toBe(10);
  });

  it("counts a unique LEFT candidate but excludes it from safe coverage and keeps no-person rows unassigned", async () => {
    const result = await buildFactoryPending({
      readReport2: async () => ({
        groups: ["GARDEN PIPE"],
        grandTotal: 20,
        byHead: [{
          head: "Sandeep Dadheech",
          total: 20,
          parties: [party("M/S LEFT PARTY", 12), party("M/S NO PERSON", 8)],
          buckets: [],
          members: [],
          reconciliation: { parent: 20, children: 20, difference: 0, exact: true },
          coverage: {
            candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0, cost: 0,
            candidateQty: 0, safeQty: 0, conflictQty: 0, unassignedQty: 0, disputedQty: 0,
          },
          candidateQty: 0, safeQty: 0, conflictQty: 0, disputedQty: 0, unassignedQty: 0,
          candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0,
        }],
      }),
      loadOrderBookSaleByHead: async () => ({ total: 0, error: null } as never),
      loadStateHeadSale: async () => ({ total: 0, error: null } as never),
      loadAttributionIndex: async () => new Map([
        ["leftparty", [{
          partyKey: "leftparty", customerId: "DIST#10", customerName: "M/S LEFT PARTY",
          assignmentId: 10, personId: 10, memberName: "Departed member", stateHeadName: "Sandeep Dadheech",
          personActive: false, leftDate: "2026-06-30", registryStatus: "left", registryName: "Departed member",
        }]],
        ["noperson", [{
          partyKey: "noperson", customerId: "DIST#11", customerName: "M/S NO PERSON",
          assignmentId: 11, personId: null, memberName: null, stateHeadName: null,
          personActive: null, leftDate: null, registryStatus: "active", registryName: null,
        }]],
      ]),
      loadConflictIndex: async () => new Map(),
    });
    expect(result.byHead[0].parties[0].classification).toBe("LEFT / departed member");
    expect(result.byHead[0].parties[1].classification).toBe("None");
    expect(result.coverage.candidateQty).toBe(12);
    expect(result.coverage.safeQty).toBe(0);
    expect(result.coverage.unassignedQty).toBe(8);
  });

  it("fails closed when assignment attribution loading fails", async () => {
    const result = await buildFactoryPending({
      readReport2: async () => ({
        groups: ["GARDEN PIPE"],
        grandTotal: 10,
        byHead: [{
          head: "Sandeep Dadheech",
          total: 10,
          parties: [party("M/S SOURCE PARTY", 10)],
          buckets: [],
          members: [],
          reconciliation: { parent: 10, children: 10, difference: 0, exact: true },
          coverage: {
            candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0, cost: 0,
            candidateQty: 0, safeQty: 0, conflictQty: 0, unassignedQty: 0, disputedQty: 0,
          },
          candidateQty: 0, safeQty: 0, conflictQty: 0, disputedQty: 0, unassignedQty: 0,
          candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0,
        }],
      }),
      loadOrderBookSaleByHead: async () => ({ total: 0, error: null } as never),
      loadStateHeadSale: async () => ({ total: 0, error: null } as never),
      loadAttributionIndex: async () => {
        throw new Error("assignment index unavailable");
      },
      loadConflictIndex: async () => new Map(),
    });
    expect(result.attributionAvailable).toBe(false);
    expect(result.attributionError).toContain("assignment index unavailable");
    expect(result.coverage.safeQty).toBeNull();
    expect(result.byHead[0].coverage.safeQty).toBeNull();
    expect(result.grandTotal).toBe(10);
    expect(result.byHead[0].parties[0].classification).toBe("Attribution unavailable");
  });

  it("fails closed when conflict report loading fails", async () => {
    const result = await buildFactoryPending({
      readReport2: async () => ({
        groups: ["GARDEN PIPE"],
        grandTotal: 10,
        byHead: [{
          head: "Sandeep Dadheech",
          total: 10,
          parties: [party("M/S SOURCE PARTY", 10)],
          buckets: [],
          members: [],
          reconciliation: { parent: 10, children: 10, difference: 0, exact: true },
          coverage: {
            candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0, cost: 0,
            candidateQty: 0, safeQty: 0, conflictQty: 0, unassignedQty: 0, disputedQty: 0,
          },
          candidateQty: 0, safeQty: 0, conflictQty: 0, disputedQty: 0, unassignedQty: 0,
          candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0,
        }],
      }),
      loadOrderBookSaleByHead: async () => ({ total: 0, error: null } as never),
      loadStateHeadSale: async () => ({ total: 0, error: null } as never),
      loadAttributionIndex: async () => new Map(),
      loadConflictIndex: async () => {
        throw new Error("conflict report unavailable");
      },
    });
    expect(result.attributionAvailable).toBe(false);
    expect(result.attributionError).toContain("conflict report unavailable");
    expect(result.coverage.safeQty).toBeNull();
  });

  it("keeps REPORT 2 quantity when pricing fails and reports an explicit amount error", async () => {
    const result = await buildFactoryPending({
      readReport2: async () => ({
        groups: ["GARDEN PIPE"],
        grandTotal: 10,
        byHead: [{
          head: "Factory",
          total: 10,
          parties: [party("SOURCE", 10)],
          buckets: [],
          members: [],
          reconciliation: { parent: 10, children: 10, difference: 0, exact: true },
          coverage: {
            candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0, cost: 0,
            candidateQty: 0, safeQty: 0, conflictQty: 0, unassignedQty: 0, disputedQty: 0,
          },
          candidateQty: 0, safeQty: 0, conflictQty: 0, disputedQty: 0, unassignedQty: 0,
          candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0,
        }],
      }),
      loadOrderBookSaleByHead: async () => ({ total: 0, error: null } as never),
      loadStateHeadSale: async () => ({ total: 0, error: null } as never),
      loadAttributionIndex: async () => new Map(),
      loadConflictIndex: async () => new Map(),
      loadPricing: async () => {
        throw new Error("sale pricing dependency unavailable");
      },
    });
    expect(result.grandTotal).toBe(10);
    expect(result.byHead[0].parties[0].total).toBe(10);
    expect(result.pricingAvailable).toBe(false);
    expect(result.pricingError).toContain("sale pricing dependency unavailable");
    expect(result.pricedAmount).toBeNull();
    expect(result.unpriceableQty).toBeNull();
    expect(result.amountReconciliation).toBeNull();
    expect(result.byHead[0].amountReconciliation).toBeUndefined();
  });

  it("prices product groups independently and retains total-minus-group residual as unpriceable", async () => {
    const source = party("SOURCE", 10);
    source.byGroup = { "GARDEN PIPE": 8 };
    source.reconciliation = { parent: 10, children: 8, difference: 2, exact: false };
    const result = await buildFactoryPending({
      readReport2: async () => ({
        groups: ["GARDEN PIPE"],
        grandTotal: 10,
        byHead: [{
          head: "Factory",
          total: 10,
          parties: [source],
          buckets: [],
          members: [],
          reconciliation: { parent: 10, children: 8, difference: 2, exact: false },
          coverage: {
            candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0, cost: 0,
            candidateQty: 0, safeQty: 0, conflictQty: 0, unassignedQty: 0, disputedQty: 0,
          },
          candidateQty: 0, safeQty: 0, conflictQty: 0, disputedQty: 0, unassignedQty: 0,
          candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0,
        }],
      }),
      loadOrderBookSaleByHead: async () => ({ total: 0, error: null } as never),
      loadStateHeadSale: async () => ({ total: 0, error: null } as never),
      loadAttributionIndex: async () => new Map(),
      loadConflictIndex: async () => new Map(),
      loadPricing: async () => ({
        source: "sale_line_current",
        fy: "2026-27",
        basis: "test",
        byGroup: {
          "Garden Pipe": {
            canonicalGroup: "Garden Pipe",
            averageRealisedRate: 10,
            medianCodeLevelRealisedRate: 10,
            p10RealisedRate: 10,
            p90RealisedRate: 10,
            contributingCodeCount: 1,
            amount: null,
            unpriceableQty: 0,
            unpriceableReason: null,
          },
        },
      }),
    });
    expect(result.pricedAmount).toBe(80);
    expect(result.unpriceableQty).toBe(2);
    expect(result.byHead[0].parties[0].pricedAmount).toBe(80);
    expect(result.amountReconciliation?.company.difference).toBe(0);
  });

  it("keeps CP source labels separate while resolving both to the canonical CP price", async () => {
    const first = party("CP ONE", 2);
    first.byGroup = { "C P": 2 };
    const second = party("CP TWO", 3);
    second.byGroup = { "CP ACCESSORIES": 3 };
    const result = await buildFactoryPending({
      readReport2: async () => ({
        groups: ["C P", "CP ACCESSORIES"],
        grandTotal: 5,
        byHead: [{
          head: "Factory", total: 5, parties: [first, second], buckets: [], members: [],
          reconciliation: { parent: 5, children: 5, difference: 0, exact: true },
          coverage: {
            candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0, cost: 0,
            candidateQty: 0, safeQty: 0, conflictQty: 0, unassignedQty: 0, disputedQty: 0,
          },
          candidateQty: 0, safeQty: 0, conflictQty: 0, disputedQty: 0, unassignedQty: 0,
          candidateCoveragePct: 0, safeCoveragePct: 0, conflictCostPp: 0,
        }],
      }),
      loadOrderBookSaleByHead: async () => ({ total: 0, error: null } as never),
      loadStateHeadSale: async () => ({ total: 0, error: null } as never),
      loadAttributionIndex: async () => new Map(),
      loadConflictIndex: async () => new Map(),
      loadPricing: async () => ({
        source: "sale_line_current", fy: "2026-27", basis: "test",
        byGroup: {
          "CP (Chrome-Plated)": {
            canonicalGroup: "CP (Chrome-Plated)", averageRealisedRate: 10,
            medianCodeLevelRealisedRate: 10, p10RealisedRate: 10, p90RealisedRate: 10,
            contributingCodeCount: 2, amount: null, unpriceableQty: 0, unpriceableReason: null,
          },
        },
      }),
    });
    expect(Object.keys(result.pricing?.byGroup ?? {})).toEqual(["C P", "CP ACCESSORIES"]);
    expect(result.pricing?.byGroup["C P"].canonicalGroup).toBe("CP (Chrome-Plated)");
    expect(result.pricing?.byGroup["C P"].amount).toBe(20);
    expect(result.pricing?.byGroup["CP ACCESSORIES"].amount).toBe(30);
    expect(result.byHead[0].parties[0].byGroupAmount?.["C P"]).toBe(20);
    expect(result.byHead[0].parties[0].amountReconciliation?.difference).toBe(0);
    expect(result.amountReconciliation?.parties.every((row) => row.difference === 0)).toBe(true);
    const workbook = buildFactoryPendingWorkbook(result);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toContain("Info");
    expect(workbook.getWorksheet("Pending Detail")?.getRow(1).values).toEqual(
      expect.arrayContaining(["Priced Amount (₹)", "Unpriceable Qty", "C P Amount (₹)"]),
    );
  });

  it("uses pieces for resolved tanks and litres divided by canonical capacity for old rows", () => {
    expect(saleQuantityDenominator("WT-02", "WATER TANK", 7, 1400)).toBe(7);
    expect(saleQuantityDenominator("WT-02", "WATER TANK", 1400, null)).toBe(7);
    expect(saleQuantityDenominator("WT-001", "WATER TANK", 12, null)).toBe(12);
  });

  it("excludes null sale amounts from both realised numerator and denominator", () => {
    const pricing = buildPendingPricingFromRows([
      { code: "GP-1", group_canon: "Garden Pipe", group_raw: null, amount: null, qty: 100, qty_ltr: null },
      { code: "GP-2", group_canon: "Garden Pipe", group_raw: null, amount: 1000, qty: 10, qty_ltr: null },
    ]);
    expect(pricing.byGroup["Garden Pipe"].averageRealisedRate).toBe(100);
  });
});