// Focused unit tests for Red Alert Category B engine.
// Proves:
//   R1. A retailer dropout (B3) fires using secondary_sku_line data, not primary.
//   R2. A retailer B3 does NOT fire when the retailer appears in customerSale only
//       (ensuring primary data is not used for retailer classification).
//   R3. B5 fires at exactly the 50% boundary (20 codes → 10, inclusive).
//   R4. B5 does NOT fire when only 9 codes are lost from 20 (44.9% < 50%).

import { describe, it, expect } from "vitest";
import { buildCategoryBAlerts } from "../categoryB.js";
import { detectAlerts } from "../detectAlerts.js";
import type { DetectionContext, RetailerSaleRow, RetailerSkuRow } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FLOORS_LOOSE = {
  DISTRIBUTOR_RUPEES: 1,
  DIRECT_DEALER_RUPEES: 1,
  RETAILER_RUPEES: 1,   // very low so materiality never blocks test retailers
};

const CFG = {
  B1_REAL_GROWTH_FLOOR_PCT: -20,
  B2_NOMINAL_DECLINE_FLOOR_PCT: 25,
  B2_SUSTAINED_PERIODS: 2,
  B4_SEGMENT_FLOOR_RUPEES: 1,
  B5_BREADTH_DROP_FLOOR_PCT: 50,
  B5_PRIOR_CODE_FLOOR: 20,
  MATERIALITY_FLOORS: FLOORS_LOOSE,
  // B3 rollup — set permissive values so unit tests see individual retailer alerts
  B3_RETAILER_ROLLUP_MIN_RETAILERS: 999,
  B3_RETAILER_ROLLUP_MIN_COMBINED_RUPEES: 1e12,
  B3_RETAILER_INDIVIDUAL_FLOOR_RUPEES: 0,
};

function makeCtx(overrides: Partial<Pick<DetectionContext,
  "retailerSale" | "retailerSku" | "customerSale" | "customerCode" | "customerMaster"
  | "mrpHistory" | "ambiguousCodes"
>> = {}): DetectionContext {
  return {
    pool: null as unknown as DetectionContext["pool"],
    customerSale: overrides.customerSale ?? [],
    customerMeta: [],
    customerCode: overrides.customerCode ?? [],
    retailerSale: overrides.retailerSale ?? [],
    retailerSku:  overrides.retailerSku  ?? [],
    secHeadMonths: [],
    mrpHistory: overrides.mrpHistory ?? [],
    ambiguousCodes: overrides.ambiguousCodes ?? new Set(),
    marginFact: [],
    persons: [],
    customerMaster: overrides.customerMaster ?? new Map(),
    retailerDistributors: new Map(),
    frozenMonths: new Map(),
    secCompleteMonths: new Map(),
    lastSheetRead: new Map(),
    personsByNameKey: new Set(),
    retailerPrimaryDist: new Map(),
    distSecMonthly: new Map(),
    headToStateHead: new Map(),
  };
}

// Build a minimal RetailerSaleRow
function rsRow(fy: string, monthLabel: string, retailer: string, value: number): RetailerSaleRow {
  return { fy, monthLabel, retailer, value };
}

// Build a minimal RetailerSkuRow
function rskuRow(fy: string, monthLabel: string, retailer: string, itemCode: string, value = 100): RetailerSkuRow {
  return { fy, monthLabel, retailer, itemCode, segmentCanon: "SegA", value };
}

const CUR_FY       = "2026-27";
const PRIOR_FY     = "2025-26";
const PRIOR_PRIOR_FY = "2024-25";
const CUR_MONTHS   = ["Apr-26", "May-26"];
const PRIOR_MONTHS = ["Apr-25", "May-25"];

// ─────────────────────────────────────────────────────────────────────────────
// R1: Retailer B3 fires from secondary_sku_line data
// ─────────────────────────────────────────────────────────────────────────────
describe("Category B — retailer data source", () => {
  it("R1: a retailer with prior secondary data and zero current secondary data fires B3", () => {
    const ctx = makeCtx({
      retailerSale: [
        // Prior period only — no current period rows → B3 should fire
        rsRow(PRIOR_FY, "Apr-25", "RET-001", 50_000),
        rsRow(PRIOR_FY, "May-25", "RET-001", 60_000),
      ],
    });

    const alerts = buildCategoryBAlerts(ctx, CUR_FY, CUR_MONTHS, CFG);
    const b3 = alerts.filter((a) => a.code === "B3" && a.entityKey === "RET-001");
    expect(b3).toHaveLength(1);
    expect(b3[0]!.entityType).toBe("retailer");
    expect(b3[0]!.numbers.priorValue).toBe(110_000);
    expect(b3[0]!.numbers.currentValue).toBe(0);
  });

  it("R2: a retailer present ONLY in customerSale (primary) does NOT fire B3", () => {
    // Primary sale data has RETAILER-PRIMARY; secondary data has nothing.
    // Since retailers must be sourced from secondary_sku_line, no B alert should fire.
    const ctx = makeCtx({
      customerSale: [
        {
          fy: PRIOR_FY, monthLabel: "Apr-25", customer: "RETAILER-PRIMARY",
          headCanon: null, stateCanon: null, channel: "Territory", groupCanon: null,
          value: 100_000, qty: 10,
        },
      ],
      // customerMaster classifies this customer as a retailer so the primary path skips it
      customerMaster: new Map([
        ["RETAILER-PRIMARY", { id: "1", company: "RETAILER-PRIMARY", entityType: "Retail", stateHead: null }],
      ]),
    });

    const alerts = buildCategoryBAlerts(ctx, CUR_FY, CUR_MONTHS, CFG);
    const forCustomer = alerts.filter((a) => a.entityKey === "RETAILER-PRIMARY");
    expect(forCustomer).toHaveLength(0);
  });

  it("R3: a distributor present in customerSale but absent from secondary still fires B3 via primary path", () => {
    // Distributors use primary data. A distributor with prior primary sale and zero current
    // should fire B3 through the primary path, not the secondary path.
    const ctx = makeCtx({
      customerSale: [
        {
          fy: PRIOR_FY, monthLabel: "Apr-25", customer: "DIST-ALPHA",
          headCanon: "Head1", stateCanon: "UP", channel: "Territory", groupCanon: "SegA",
          value: 500_000, qty: 100,
        },
      ],
      customerMaster: new Map([
        ["DIST-ALPHA", { id: "2", company: "DIST-ALPHA", entityType: "Distributors", stateHead: null }],
      ]),
    });

    const alerts = buildCategoryBAlerts(ctx, CUR_FY, CUR_MONTHS, CFG);
    const b3 = alerts.filter((a) => a.code === "B3" && a.entityKey === "DIST-ALPHA");
    expect(b3).toHaveLength(1);
    expect(b3[0]!.entityType).toBe("distributor");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B1 regression: retailer B1 fires using ONLY secondary data (no primary rows)
// ─────────────────────────────────────────────────────────────────────────────
describe("Category B — retailer B1 (secondary-basket MRP index)", () => {
  it("B1 fires for a retailer using secondary_sku_line data; zero customerCode rows required", () => {
    // Retailer had good prior sales. Current period: nominal value declined but MRP rose a lot
    // → real growth is negative. MRP history has one code with a 30% increase.
    // Real growth = nominal growth pct - MRP increase pct < -20% threshold → should fire.
    const ctx = makeCtx({
      retailerSale: [
        rsRow(PRIOR_FY, "Apr-25", "RET-B1", 100_000),
        rsRow(CUR_FY,   "Apr-26", "RET-B1",  85_000), // -15% nominal
      ],
      retailerSku: [
        // Prior period basket: code CODE-A, segment SegA, value 100k
        rskuRow(PRIOR_FY, "Apr-25", "RET-B1", "CODE-A", 100_000),
        rskuRow(CUR_FY,   "Apr-26", "RET-B1", "CODE-A",  85_000),
      ],
      mrpHistory: [
        // CODE-A had MRP 100 in the prior period and 130 now = +30% MRP increase
        {
          itemCode: "CODE-A", segment: "SegA",
          mrp: 100, effectiveFrom: "2025-01-01", effectiveTo: "2026-03-31", isCurrent: false,
        },
        {
          itemCode: "CODE-A", segment: "SegA",
          mrp: 130, effectiveFrom: "2026-04-01", effectiveTo: null, isCurrent: true,
        },
      ],
      // customerCode is intentionally empty — proving no primary rows are needed
    });

    const alerts = buildCategoryBAlerts(ctx, CUR_FY, ["Apr-26"], CFG);
    const b1 = alerts.filter((a) => a.code === "B1" && a.entityKey === "RET-B1");
    expect(b1).toHaveLength(1);
    expect(b1[0]!.entityType).toBe("retailer");
    // real growth = -15% nominal - 30% MRP = -45%, well below -20% floor
    expect(b1[0]!.numbers.realGrowthPct).toBeLessThan(CFG.B1_REAL_GROWTH_FLOOR_PCT);
    expect(b1[0]!.numbers.mrpIncreasePct).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B3 end-to-end: genuine retailer dropout reaches final alerts through detectAlerts
// ─────────────────────────────────────────────────────────────────────────────
describe("Category B — B3 end-to-end through detectAlerts", () => {
  // Populate frozenMonths so Guard 3 (complete months) allows the analysis months.
  const FROZEN = new Map<string, Set<string>>([
    [CUR_FY,         new Set(["Apr-26"])],
    [PRIOR_FY,       new Set(["Apr-25"])],
    [PRIOR_PRIOR_FY, new Set(["Apr-24"])],
  ]);

  it("E2E-B3-pass: a genuine retailer dropout reaches final alert results (not suppressed)", () => {
    // Retailer had prior secondary activity; zero current activity.
    // Prior distributor attribution present; current window: no attribution at all.
    // Guard 5 (after case-b removal) must NOT suppress this.
    const retailerDistributors = new Map<string, Map<string, Set<string>>>();
    const rdm = new Map<string, Set<string>>();
    rdm.set(`${PRIOR_FY}|Apr-25`, new Set(["DistA"])); // prior attribution
    // current window has NO distributor rows — genuine dropout, not redistribution
    retailerDistributors.set("RET-DROPOUT", rdm);

    const ctx: DetectionContext = {
      pool: null as unknown as DetectionContext["pool"],
      customerSale: [], customerMeta: [], customerCode: [],
      retailerSale: [rsRow(PRIOR_FY, "Apr-25", "RET-DROPOUT", 3_000_000)], // ≥ ₹25 L B3 individual floor
      retailerSku: [],
      secHeadMonths: [],
      mrpHistory: [], ambiguousCodes: new Set(), marginFact: [], persons: [],
      customerMaster: new Map(),
      retailerDistributors,
      frozenMonths: FROZEN,
      secCompleteMonths: new Map(),
      lastSheetRead: new Map(),
      personsByNameKey: new Set(),
      retailerPrimaryDist: new Map(),
      distSecMonthly: new Map(),
      headToStateHead: new Map(),
    };

    const result = detectAlerts(ctx, {
      fy: CUR_FY,
      primaryCompleteMonths: ["Apr-26"],
      nowDate: new Date("2026-08-01"),
      c5AsOfDate: new Date("2026-08-01"),
    });

    const b3 = result.alerts.filter((a) => a.code === "B3" && a.entityKey === "RET-DROPOUT");
    expect(b3).toHaveLength(1);
    expect(b3[0]!.entityType).toBe("retailer");

    // Confirm Guard 5 did not suppress it
    const g5Suppressed = result.suppressed.filter(
      (s) => s.alert.entityKey === "RET-DROPOUT" && s.guard === 5,
    );
    expect(g5Suppressed).toHaveLength(0);
  });

  it("E2E-B3-suppress: B3 is suppressed by Guard 5 when distributor changed in-window (redistribution)", () => {
    // Retailer had prior attribution DistA; current window shows DistB → redistribution.
    const retailerDistributors = new Map<string, Map<string, Set<string>>>();
    const rdm = new Map<string, Set<string>>();
    rdm.set(`${PRIOR_FY}|Apr-25`, new Set(["DistA"]));
    rdm.set(`${CUR_FY}|Apr-26`,   new Set(["DistB"]));  // different distributor → redistribution
    retailerDistributors.set("RET-REDIR", rdm);

    const ctx: DetectionContext = {
      pool: null as unknown as DetectionContext["pool"],
      customerSale: [], customerMeta: [], customerCode: [],
      retailerSale: [rsRow(PRIOR_FY, "Apr-25", "RET-REDIR", 3_000_000)], // ≥ ₹25 L B3 individual floor
      retailerSku: [],
      secHeadMonths: [],
      mrpHistory: [], ambiguousCodes: new Set(), marginFact: [], persons: [],
      customerMaster: new Map(),
      retailerDistributors,
      frozenMonths: FROZEN,
      secCompleteMonths: new Map(),
      lastSheetRead: new Map(),
      personsByNameKey: new Set(),
      retailerPrimaryDist: new Map(),
      distSecMonthly: new Map(),
      headToStateHead: new Map(),
    };

    const result = detectAlerts(ctx, {
      fy: CUR_FY,
      primaryCompleteMonths: ["Apr-26"],
      nowDate: new Date("2026-08-01"),
      c5AsOfDate: new Date("2026-08-01"),
    });

    const b3Final = result.alerts.filter((a) => a.code === "B3" && a.entityKey === "RET-REDIR");
    expect(b3Final).toHaveLength(0);

    const g5Suppressed = result.suppressed.filter(
      (s) => s.alert.entityKey === "RET-REDIR" && s.guard === 5,
    );
    expect(g5Suppressed).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4/R5: B5 boundary — exact 50% drop must fire; 44.9% must not
// ─────────────────────────────────────────────────────────────────────────────
describe("Category B — B5 boundary (20→10 inclusive)", () => {
  // A retailer with prior=20 codes and current=N codes.
  function makeRetailerCtxB5(priorCodeCount: number, currentCodeCount: number): DetectionContext {
    const priorSkus: RetailerSkuRow[] = [];
    for (let i = 1; i <= priorCodeCount; i++) {
      priorSkus.push(rskuRow(PRIOR_FY, "Apr-25", "RET-B5", `CODE-${i.toString().padStart(3, "0")}`));
    }
    const curSkus: RetailerSkuRow[] = [];
    for (let i = 1; i <= currentCodeCount; i++) {
      curSkus.push(rskuRow(CUR_FY, "Apr-26", "RET-B5", `CODE-${i.toString().padStart(3, "0")}`));
    }

    return makeCtx({
      retailerSale: [
        rsRow(PRIOR_FY, "Apr-25", "RET-B5", 500_000),
        rsRow(CUR_FY,   "Apr-26", "RET-B5", 400_000),
      ],
      retailerSku: [...priorSkus, ...curSkus],
    });
  }

  it("R4: 20 → 10 codes (exactly 50% drop) DOES fire B5 (boundary inclusive)", () => {
    const ctx = makeRetailerCtxB5(20, 10);
    const alerts = buildCategoryBAlerts(ctx, CUR_FY, ["Apr-26"], CFG);
    const b5 = alerts.filter((a) => a.code === "B5" && a.entityKey === "RET-B5");
    expect(b5).toHaveLength(1);
    expect(b5[0]!.numbers.codePrior).toBe(20);
    expect(b5[0]!.numbers.codeCurrent).toBe(10);
    expect(b5[0]!.numbers.declinePct).toBeCloseTo(50, 1);
  });

  it("R5: 20 → 11 codes (45% drop) does NOT fire B5 (below 50% threshold)", () => {
    const ctx = makeRetailerCtxB5(20, 11);
    const alerts = buildCategoryBAlerts(ctx, CUR_FY, ["Apr-26"], CFG);
    const b5 = alerts.filter((a) => a.code === "B5" && a.entityKey === "RET-B5");
    expect(b5).toHaveLength(0);
  });

  it("R6: 20 → 9 codes (55% drop) fires B5", () => {
    const ctx = makeRetailerCtxB5(20, 9);
    const alerts = buildCategoryBAlerts(ctx, CUR_FY, ["Apr-26"], CFG);
    const b5 = alerts.filter((a) => a.code === "B5" && a.entityKey === "RET-B5");
    expect(b5).toHaveLength(1);
  });

  it("R7: prior code count < 20 does NOT fire B5 even with large drop (B5_PRIOR_CODE_FLOOR = 20)", () => {
    // 19 prior codes → 0 current = 100% drop, but below floor
    const ctx = makeRetailerCtxB5(19, 0);
    // Need current sale row so the retailer appears in the set
    const modCtx = {
      ...ctx,
      retailerSale: [
        ...ctx.retailerSale,
        rsRow(CUR_FY, "Apr-26", "RET-B5", 0),
      ],
    };
    const alerts = buildCategoryBAlerts(modCtx, CUR_FY, ["Apr-26"], CFG);
    const b5 = alerts.filter((a) => a.code === "B5" && a.entityKey === "RET-B5");
    expect(b5).toHaveLength(0);
  });
});
