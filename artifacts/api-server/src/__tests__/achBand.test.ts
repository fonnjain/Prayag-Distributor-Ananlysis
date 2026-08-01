import { describe, it, expect } from "vitest";
import { achBand } from "../routes/mgmt";

// Glossary v2 (G4 Correction 4 / G1 Part 10) band boundaries.
// achBand takes a FRACTION (0.60 = 60%). The prayag frontend helper
// (src/lib/achievementBands.ts) mirrors these boundaries on a 0–100 scale.
describe("achBand boundaries", () => {
  it("no target → noTarget (never Red)", () => {
    expect(achBand(null, false)).toBe("noTarget");
    expect(achBand(0.6, false)).toBe("noTarget");
    expect(achBand(null, true)).toBe("noTarget");
  });

  it("below 25% → below25 (Red)", () => {
    expect(achBand(0, true)).toBe("below25");
    expect(achBand(0.2499, true)).toBe("below25");
  });

  it("25–50% → below50 (Orange)", () => {
    expect(achBand(0.25, true)).toBe("below50");
    expect(achBand(0.4999, true)).toBe("below50");
  });

  it("50–70% → 50to70 (Amber) — a 60% member is Amber", () => {
    expect(achBand(0.5, true)).toBe("50to70");
    expect(achBand(0.6, true)).toBe("50to70");
    expect(achBand(0.6999, true)).toBe("50to70");
  });

  it("70–90% → 70to90 (Yellow)", () => {
    expect(achBand(0.7, true)).toBe("70to90");
    expect(achBand(0.8999, true)).toBe("70to90");
  });

  it("90–100% → 90to100 (Green), 100% exactly is Green", () => {
    expect(achBand(0.9, true)).toBe("90to100");
    expect(achBand(1.0, true)).toBe("90to100");
  });

  it("strictly above 100% → above100 (Emerald)", () => {
    expect(achBand(1.0001, true)).toBe("above100");
    expect(achBand(1.5, true)).toBe("above100");
  });
});
