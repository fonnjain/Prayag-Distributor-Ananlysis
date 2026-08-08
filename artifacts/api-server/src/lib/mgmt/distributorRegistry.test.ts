import { describe, it, expect } from "vitest";
import { DistributorRegistry, type DistributorRecord } from "./distributorRegistry.js";

const rec = (p: Partial<DistributorRecord> & { name: string; normKey: string }): DistributorRecord => ({
  distId: null,
  state: null,
  district: null,
  source: "test",
  ...p,
});

describe("DistributorRegistry.resolve", () => {
  // Mirrors the real schema: distributor_identity holds ONE row per DIST#
  // (unique constraint); alternate spellings live in distributor_identity_alias.
  const registry = new DistributorRegistry(
    [
      rec({ distId: "DIST#100", name: "R R Traders", normKey: "R R TRADE", state: "BIHAR", district: "Patna" }),
      // Two different DIST# sharing one normKey — TWO distributors, always.
      rec({ distId: "DIST#200", name: "SHIV TRADERS", normKey: "SHIV TRADE", state: "BIHAR", district: "Gaya" }),
      rec({ distId: "DIST#201", name: "Shiv Traders", normKey: "SHIV TRADE", state: "RAJASTHAN", district: "Jaipur" }),
      // No-ID rows: identity is name + state + district.
      rec({ name: "KUMAR AGENCIES", normKey: "KUMAR AGENCIES", state: "UP", district: "Kanpur" }),
      rec({ name: "KUMAR AGENCIES", normKey: "KUMAR AGENCIES", state: "MP", district: "Bhopal" }),
      // Unique name.
      rec({ distId: "DIST#300", name: "Noida Buildmart Pvt Ltd", normKey: "NOIDA BUILDMART PVTLTD", state: "West U.P", district: "Gautam Buddha Nagar" }),
    ],
    [
      // Another source spells DIST#100 differently — SAME distributor.
      { distId: "DIST#100", alias: "R.R.TRADERS", normKey: "RRTRADE", source: "party-tm-bridge" },
    ],
  );

  it("resolves an explicit DIST# directly", () => {
    const r = registry.resolve("something DIST#300");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.record.name).toBe("Noida Buildmart Pvt Ltd");
  });

  it("resolves a unique name", () => {
    const r = registry.resolve("NOIDA BUILDMART PVT LTD");
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.record.distId).toBe("DIST#300");
  });

  it("errors with every candidate when two DIST# share a name", () => {
    const r = registry.resolve("Shiv Traders");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.length).toBe(2);
      expect(r.message).toContain("DIST#200");
      expect(r.message).toContain("DIST#201");
    }
  });

  it("disambiguates by state context", () => {
    const r = registry.resolve("Shiv Traders", { state: "RAJASTHAN" });
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.record.distId).toBe("DIST#201");
  });

  it("treats no-ID rows with different geography as distinct identities", () => {
    const r = registry.resolve("Kumar Agencies");
    expect(r.kind).toBe("ambiguous");
    const byDistrict = registry.resolve("Kumar Agencies", { state: "MP" });
    expect(byDistrict.kind).toBe("found");
    if (byDistrict.kind === "found") expect(byDistrict.record.district).toBe("Bhopal");
  });

  it("resolves an alias spelling to the same DIST# identity", () => {
    const direct = registry.resolve("R R Traders");
    const viaAlias = registry.resolve("R.R.TRADERS");
    expect(direct.kind).toBe("found");
    expect(viaAlias.kind).toBe("found");
    if (direct.kind === "found" && viaAlias.kind === "found") {
      expect(viaAlias.record.distId).toBe("DIST#100");
      expect(viaAlias.record).toBe(direct.record); // one identity record
    }
  });

  it("an alias whose key collides with a different DIST# is ambiguous, not first-match", () => {
    const reg2 = new DistributorRegistry(
      [
        rec({ distId: "DIST#400", name: "AV TRADERS", normKey: "AV TRADE", state: "TN" }),
        rec({ distId: "DIST#401", name: "A.V Traders", normKey: "AVTRADE", state: "TN" }),
      ],
      [{ distId: "DIST#401", alias: "AV Trade Rs", normKey: "AV TRADE", source: "test" }],
    );
    const r = reg2.resolve("AV TRADE");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates.length).toBe(2);
  });

  it("returns not_found for unknown names", () => {
    expect(registry.resolve("TOTALLY UNKNOWN").kind).toBe("not_found");
  });
});
