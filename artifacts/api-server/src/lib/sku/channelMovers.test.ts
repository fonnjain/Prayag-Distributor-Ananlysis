import { describe, it, expect } from "vitest";
import {
  buildChannelMoverPairs,
  MOVER_FLOOR,
  type MoverCustRow,
} from "./channelMovers.js";

// Helpers simulate what the SQL produces for each level:
//   - distributor view: netInLevel = territory (non-direct) net
//   - direct_dealer view: netInLevel = direct-typed territory net
//   - project view: netInLevel = project net
//   - head scope: netInLevel additionally restricted to the selected head
// Classification (isProject) and side-nets are whole-book per FY.

function row(
  fy: string,
  customer: string,
  opts: { isProject: boolean; terr?: number; proj?: number; inLevel: number },
): MoverCustRow {
  return {
    fy,
    customer,
    isProject: opts.isProject,
    netTerritory: opts.terr ?? 0,
    netProject: opts.proj ?? 0,
    netInLevel: opts.inLevel,
  };
}

const FYS = ["2024-25", "2025-26"];

describe("buildChannelMoverPairs", () => {
  it("company/distributor: flags a territory→project mover with side-nets (MOHAN IMPEX shape)", () => {
    const rows = [
      // Mover: territory in FY24-25 (in distributor charts), project in FY25-26
      row("2024-25", "MOHAN IMPEX", { isProject: false, terr: 30.36e7, inLevel: 30.36e7 }),
      row("2025-26", "MOHAN IMPEX", { isProject: true, proj: 35.73e7, inLevel: 0 }),
      // Stable territory customer
      row("2024-25", "STABLE", { isProject: false, terr: 5e6, inLevel: 5e6 }),
      row("2025-26", "STABLE", { isProject: false, terr: 6e6, inLevel: 6e6 }),
      // New in-level customer
      row("2025-26", "NEWCO", { isProject: false, terr: 1e6, inLevel: 1e6 }),
    ];
    const [p] = buildChannelMoverPairs(rows, FYS);
    expect(p.channelChanged).toBe(1);
    expect(p.sameChannel).toBe(1);
    expect(p.newCustomers).toBe(1);
    expect(p.movers).toHaveLength(1);
    expect(p.movers[0]).toMatchObject({
      customer: "MOHAN IMPEX",
      direction: "territory_to_project",
      netFrom: 30.36e7,
      netTo: 35.73e7,
    });
    expect(p.netChangedTo).toBeCloseTo(35.73e7);
    expect(p.netChangedFrom).toBeCloseTo(30.36e7);
  });

  it("distributor: a customer with no in-level presence either FY is not counted", () => {
    // Direct-dealer-only customer: excluded from the distributor comparison,
    // so their head change must not appear in the distributor disclosure.
    const rows = [
      row("2024-25", "DD ONLY", { isProject: false, terr: 2e6, inLevel: 0 }),
      row("2025-26", "DD ONLY", { isProject: true, proj: 3e6, inLevel: 0 }),
    ];
    const [p] = buildChannelMoverPairs(rows, FYS);
    expect(p.channelChanged).toBe(0);
    expect(p.sameChannel).toBe(0);
    expect(p.newCustomers).toBe(0);
    expect(p.movers).toHaveLength(0);
  });

  it("direct_dealer: mover gated on direct-typed in-level net", () => {
    const rows = [
      // In-level (direct) in FY24-25, whole book moves to project in FY25-26
      row("2024-25", "DD MOVER", { isProject: false, terr: 8e6, inLevel: 8e6 }),
      row("2025-26", "DD MOVER", { isProject: true, proj: 9e6, inLevel: 0 }),
    ];
    const [p] = buildChannelMoverPairs(rows, FYS);
    expect(p.channelChanged).toBe(1);
    expect(p.movers[0].direction).toBe("territory_to_project");
    expect(p.movers[0].netTo).toBe(9e6);
  });

  it("project: joiner is disclosed with prior-FY territory net (project→territory reversed)", () => {
    // Project view: in-level = project net. A customer who was territory in
    // FY24-25 (inLevel 0 for project view) and project in FY25-26 is a
    // candidate via toFy in-level presence.
    const rows = [
      row("2024-25", "JOINER", { isProject: false, terr: 12e6, inLevel: 0 }),
      row("2025-26", "JOINER", { isProject: true, proj: 15e6, inLevel: 15e6 }),
    ];
    const [p] = buildChannelMoverPairs(rows, FYS);
    expect(p.channelChanged).toBe(1);
    expect(p.movers[0]).toMatchObject({
      direction: "territory_to_project",
      netFrom: 12e6,
      netTo: 15e6,
    });
  });

  it("head scope: mover leaving the head to project is disclosed; head-to-head moves are not channel movers", () => {
    const rows = [
      // Leaves selected head for project channel — disclosed
      row("2024-25", "LEAVER", { isProject: false, terr: 10e6, inLevel: 10e6 }),
      row("2025-26", "LEAVER", { isProject: true, proj: 11e6, inLevel: 0 }),
      // Moves from selected head to another territory head — head reassignment,
      // classification unchanged ⇒ sameChannel, not a channel mover
      row("2024-25", "REASSIGNED", { isProject: false, terr: 4e6, inLevel: 4e6 }),
      row("2025-26", "REASSIGNED", { isProject: false, terr: 5e6, inLevel: 0 }),
    ];
    const [p] = buildChannelMoverPairs(rows, FYS);
    expect(p.channelChanged).toBe(1);
    expect(p.movers[0].customer).toBe("LEAVER");
    expect(p.sameChannel).toBe(1);
  });

  it("materiality floor: below-floor movers counted in totals but not listed", () => {
    const small = MOVER_FLOOR / 2;
    const rows = [
      row("2024-25", "TINY", { isProject: false, terr: small, inLevel: small }),
      row("2025-26", "TINY", { isProject: true, proj: small, inLevel: 0 }),
    ];
    const [p] = buildChannelMoverPairs(rows, FYS);
    expect(p.channelChanged).toBe(1);
    expect(p.movers).toHaveLength(0);
    expect(p.netChangedTo).toBeCloseTo(small);
  });

  it("multiple FY pairs: one entry per adjacent pair, movers sorted by magnitude", () => {
    const fys = ["2023-24", "2024-25", "2025-26"];
    const rows = [
      row("2023-24", "A", { isProject: true, proj: 2e6, inLevel: 0 }),
      row("2024-25", "A", { isProject: false, terr: 3e6, inLevel: 3e6 }),
      row("2024-25", "B", { isProject: false, terr: 50e6, inLevel: 50e6 }),
      row("2025-26", "B", { isProject: true, proj: 60e6, inLevel: 0 }),
      row("2024-25", "C", { isProject: false, terr: 1e6, inLevel: 1e6 }),
      row("2025-26", "C", { isProject: true, proj: 2e6, inLevel: 0 }),
    ];
    const pairs = buildChannelMoverPairs(rows, fys);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].movers[0]).toMatchObject({
      customer: "A",
      direction: "project_to_territory",
    });
    expect(pairs[1].movers.map((m) => m.customer)).toEqual(["B", "C"]);
  });
});
