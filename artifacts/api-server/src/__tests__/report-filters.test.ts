// Aggregate-level report filters (Regional + Coverage pages).
//
// The filter bar's options come from the sale_line territory tree, while the
// underlying aggregates use roster/order-book vocabularies — these tests pin
// the vocabulary bridge and the scoping semantics the pages rely on.
import { describe, it, expect } from "vitest";
import { filterRegional } from "../routes/regionalReports.js";
import { buildPayload as buildCoverage } from "../routes/coverageReports.js";
import { normHead, normState } from "../lib/reportFilterVocab.js";

describe("reportFilterVocab", () => {
  it("bridges roster and order-book head nicknames to sale_line names", () => {
    expect(normHead("DADHEECH JI")).toBe(normHead("Sandeep Dadheech"));
    expect(normHead("SANDEEP JI")).toBe(normHead("Sandeep Dadheech"));
    expect(normHead("RIZVI JI")).toBe(normHead("Syed Aqil Rizvi"));
    expect(normHead("BIJJU")).toBe(normHead("Biju C.O"));
    expect(normHead("PAWAN KUMAR")).toBe(normHead("Pawan Sharma"));
    expect(normHead("GOVT")).toBe(normHead("Non-territory / Project / Govt"));
  });

  it("bridges state spellings and territory splits to geographic states", () => {
    expect(normState("W-BENGAL")).toBe("WEST BENGAL");
    expect(normState("East U.P")).toBe("UTTAR PRADESH");
    expect(normState("UP ( R )")).toBe("UTTAR PRADESH");
    expect(normState("Chattisgarh")).toBe("CHHATTISGARH");
    expect(normState("MAHARASTRA L")).toBe("MAHARASHTRA");
    expect(normState("DELHI NCR")).toBe("DELHI");
  });
});

describe("filterRegional (order-book aggregates)", () => {
  const data = {
    by_state: [
      { state: "W-BENGAL", head: "SANDEEP JI", retailers: 33, sales: 100 },
      { state: "UP ( R )", head: "RIZVI JI", retailers: 63, sales: 80 },
      { state: "BIHAR", head: "SANDEEP JI", retailers: 19, sales: 60 },
    ],
    heads_retail: [
      { head: "SANDEEP JI", retailers: 52, sales: 160, share: 66.7 },
      { head: "RIZVI JI", retailers: 63, sales: 80, share: 33.3 },
    ],
    top_retailers: [
      { company: "A", state: "W-BENGAL", city: "Kolkata", sales: 50 },
      { company: "B", state: "UP ( R )", city: "Lucknow", sales: 40 },
    ],
  };

  it("returns everything unfiltered", () => {
    const p = filterRegional(data, "t");
    expect(p.filtered).toBe(false);
    expect(p.byState).toHaveLength(3);
    expect(p.headsRetail).toHaveLength(2);
    expect(p.topRetailers).toHaveLength(2);
  });

  it("head filter uses sale_line names and narrows all three tables", () => {
    const p = filterRegional(data, "t", ["Sandeep Dadheech"]);
    expect(p.byState.map((r) => r.state)).toEqual(["W-BENGAL", "BIHAR"]);
    expect(p.headsRetail.map((r) => r.head)).toEqual(["SANDEEP JI"]);
    expect(p.topRetailers.map((r) => r.company)).toEqual(["A"]);
  });

  it("state filter constrains the heads table to heads touching the state and flags full-territory figures", () => {
    const p = filterRegional(data, "t", undefined, ["UTTAR PRADESH"]);
    expect(p.headsFullTerritory).toBe(true);
    expect(p.byState.map((r) => r.state)).toEqual(["UP ( R )"]);
    expect(p.headsRetail.map((r) => r.head)).toEqual(["RIZVI JI"]);
    expect(p.topRetailers.map((r) => r.company)).toEqual(["B"]);
  });
});

describe("buildCoverage (roster aggregates)", () => {
  const data = {
    heads_resources: [
      { head: "DADHEECH JI", distributors: 63, dealers: 4810, total: 4873, states: "West Bengal, Bihar, North East" },
      { head: "ANANT SINGH", distributors: 22, dealers: 824, total: 846, states: "West U.P, Delhi, Uttarakhand" },
    ],
    coverage: [
      { state: "WEST BENGAL", districts: 10, cities: 50, retailers: 500 },
      { state: "WEST U.P", districts: 8, cities: 40, retailers: 400 },
      { state: "EAST U.P", districts: 6, cities: 30, retailers: 300 },
      { state: "ASSAM", districts: 5, cities: 20, retailers: 200 },
    ],
    coverage_totals: { states: 4, districts: 29, cities: 140, retailers: 1400 },
  };

  it("head filter narrows states via the head's covered territory (incl. North East expansion)", () => {
    const p = buildCoverage(data, "t", ["Sandeep Dadheech"]);
    expect(p.headsResources.map((h) => h.head)).toEqual(["DADHEECH JI"]);
    expect(p.coverage.map((c) => c.state).sort()).toEqual(["ASSAM", "WEST BENGAL"]);
    expect(p.coverageTotals.retailers).toBe(700);
  });

  it("state filter constrains the heads table and recomputes totals from matching rows", () => {
    const p = buildCoverage(data, "t", undefined, ["UTTAR PRADESH"]);
    expect(p.headsFullTerritory).toBe(true);
    expect(p.headsResources.map((h) => h.head)).toEqual(["ANANT SINGH"]);
    // Both roster UP splits match the geographic state.
    expect(p.coverage.map((c) => c.state).sort()).toEqual(["EAST U.P", "WEST U.P"]);
    expect(p.coverageTotals).toEqual({ states: 2, districts: 14, cities: 70, retailers: 700 });
  });

  it("unfiltered totals pass through untouched", () => {
    const p = buildCoverage(data, "t");
    expect(p.filtered).toBe(false);
    expect(p.coverageTotals).toEqual(data.coverage_totals);
  });
});
