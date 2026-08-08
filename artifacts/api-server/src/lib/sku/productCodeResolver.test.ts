import { describe, it, expect } from "vitest";
import { resolveProductCode, buildResolverIndex } from "./productCodeResolver.js";

// Master codes covering every verified example in the spec.
const MASTER = [
  // P-strip targets
  "6818", "6806", "6875", "6812", "6802",
  // colour-suffix bases
  "7118", "4011", "4019", "4051", "4303",
  // whitespace target
  "Q724 MB",
  // exact-match codes that LOOK like colour suffixes but are legitimate
  "130-B", "141-E", "121-E", "129-C",
];

const { has, codes } = buildResolverIndex(MASTER);

describe("resolveProductCode — step order (exact first)", () => {
  it("resolves legitimate suffixed codes by EXACT match, never stripping", () => {
    for (const c of ["130-B", "141-E", "121-E", "129-C"]) {
      const r = resolveProductCode(c, has, codes);
      expect(r.method).toBe("exact");
      expect(r.masterCode).toBe(c);
      expect(r.colour).toBeNull();
    }
  });
});

describe("resolveProductCode — step 2 P-strip", () => {
  it.each([
    ["P6818", "6818"],
    ["P6806", "6806"],
    ["P6875", "6875"],
    ["P6812", "6812"],
    ["P6802", "6802"],
  ])("%s resolves to %s by P-strip", (reg, master) => {
    const r = resolveProductCode(reg, has, codes);
    expect(r.method).toBe("p_strip");
    expect(r.masterCode).toBe(master);
  });
});

describe("resolveProductCode — step 3 colour suffix", () => {
  it.each([
    ["7118-B", "7118", "B"],
    ["4011B", "4011", "B"],
    ["4011G", "4011", "G"],
    ["4019-P", "4019", "P"],
    ["4051-B", "4051", "B"],
    ["4303 J", "4303", "J"],
  ])("%s resolves to %s (colour %s)", (reg, master, colour) => {
    const r = resolveProductCode(reg, has, codes);
    expect(r.method).toBe("colour_suffix");
    expect(r.masterCode).toBe(master);
    expect(r.colour).toBe(colour);
  });
});

describe("resolveProductCode — step 4 whitespace", () => {
  it("register Q724MB resolves to master 'Q724 MB'", () => {
    const r = resolveProductCode("Q724MB", has, codes);
    expect(r.method).toBe("whitespace");
    expect(r.masterCode).toBe("Q724 MB");
  });
});

describe("resolveProductCode — unresolved", () => {
  it("returns unresolved for a code with no match at any step", () => {
    const r = resolveProductCode("PTA-72", has, codes);
    expect(r.method).toBe("unresolved");
    expect(r.masterCode).toBeNull();
  });
});
