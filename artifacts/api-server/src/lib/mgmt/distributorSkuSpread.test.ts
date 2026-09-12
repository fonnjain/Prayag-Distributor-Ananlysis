import { describe, expect, it } from "vitest";
import {
  ALL_BROAD_SEGMENTS,
  CANONICAL_MASTER_CATEGORIES,
  masterForLegacyBroadSegment,
  rollupCanonicalMasters,
} from "./distributorSkuSpread.js";

describe("distributor SKU spread canonical taxonomy", () => {
  it("maps every legacy source segment through the reviewed registry", () => {
    expect(ALL_BROAD_SEGMENTS).toHaveLength(17);
    expect(
      ALL_BROAD_SEGMENTS.map(masterForLegacyBroadSegment),
    ).not.toContain(null);
    expect(masterForLegacyBroadSegment("WATER TANK")).toBe("PLUMBING");
    expect(new Set(ALL_BROAD_SEGMENTS.map(masterForLegacyBroadSegment))).toEqual(
      new Set(CANONICAL_MASTER_CATEGORIES),
    );
  });

  it("reconciles all old subcategory values into the six masters", () => {
    const source = new Map([
      ["WATER TANKS", 100],
      ["AGRITEC", 200],
      ["UPVC AQUAFRESH", 300],
      ["CPVC DURALIFE", 400],
      ["SWR DRAINTECH", 500],
      ["PPR PIPE", 600],
      ["HDPE PIPE", 700],
      ["P.V.C. GARDEN PIPE", 800],
      ["COLUMN PIPE", 900],
      ["CORRUGATED PIPE", 1_000],
      ["P.T.M.T. SYMET", 1_100],
      ["CISTERNS & SEAT COVERS", 1_200],
      ["CP CHROME SERIES", 1_300],
      ["S.STEEL SINK", 1_400],
      ["SANITARYWARE", 1_500],
      ["COCKROACH TRAPS & GRATINGS", 1_600],
      ["HARDWARE", 1_700],
    ]);
    const total = [...source.values()].reduce((sum, amount) => sum + amount, 0);
    const rollup = rollupCanonicalMasters(source, total);

    expect(rollup.netByMasterCategory.map((row) => row.segment).sort()).toEqual(
      [...CANONICAL_MASTER_CATEGORIES].sort(),
    );
    expect(rollup.unmappedNet).toBe(0);
    expect(rollup.unmappedSourceSegments).toEqual([]);
    expect(
      rollup.netByMasterCategory.reduce((sum, row) => sum + row.net, 0) + rollup.unmappedNet,
    ).toBe(total);
  });

  it("does not silently classify an unknown source segment", () => {
    const rollup = rollupCanonicalMasters(new Map([["UNREVIEWED LINE", 250]]), 250);
    expect(rollup.netByMasterCategory).toEqual([]);
    expect(rollup.unmappedNet).toBe(250);
    expect(rollup.unmappedSourceSegments).toEqual(["(other)"]);
    expect(rollup.netBySourceSegment[0]).toMatchObject({
      segment: "(other)",
      masterCategory: null,
      net: 250,
    });
  });
});