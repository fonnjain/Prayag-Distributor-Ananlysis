// Guards the PSCode_3 / secondary-register brand vocabulary in
// config/group_map.json: canonGroupFromMap must map every brand name that
// appears in secondary_sku_line.segment_raw to a canonical segment.
// If a new register drop introduces a name outside this list, segment_canon
// goes NULL at ingest and Comparison "Segment coverage (%)" silently
// understates — extend group_map.json AND migration
// 010_backfill_secondary_sku_segment_canon together.
import { describe, it, expect } from "vitest";
import { canonGroupFromMap } from "../lib/sku/catalogue.js";

const EXPECTED: Record<string, string> = {
  "P.T.M.T. SYMET": "PTMT / Faucets",
  "VIGNETTE": "PTMT / Faucets",
  "CPVC DURALIFE": "CPVC",
  "UPVC AQUAFRESH": "UPVC",
  "SWR DRAINTECH": "SWR",
  "C.P-CDA": "CP (Chrome-Plated)",
  "C.P. 5000 SERIES": "CP (Chrome-Plated)",
  "C.P. 6000 SERIES": "CP (Chrome-Plated)",
  "C.P. 7000 SERIES": "CP (Chrome-Plated)",
  "C.P. 8000 SERIES": "CP (Chrome-Plated)",
  "C.P. 9000 SERIES": "CP (Chrome-Plated)",
  "P.V.C. GARDEN PIPE": "Garden Pipe",
  "CISTERNS & SEAT COVERS": "CISTERN",
  "S.STEEL SINK": "Sink",
  "AGRITEC": "AGRI",
  "AGRI AGRITEC": "AGRI",
  "WATER TANKS": "WATER TANK",
  "COLUMN PIPE": "COLUMN",
  "WATER HEATER": "Sanitaryware",
  "COCKROACH TRAPS & GRATINGS": "Connection / Waste",
  "MANHOLE COVER": "Connection / Waste",
};

describe("PSCode_3 brand vocabulary → canonical segment", () => {
  it("maps every known register brand name", () => {
    for (const [raw, canon] of Object.entries(EXPECTED)) {
      expect(canonGroupFromMap(raw), raw).toBe(canon);
    }
  });

  it("is case-insensitive and trims", () => {
    expect(canonGroupFromMap("  cpvc duralife ")).toBe("CPVC");
  });

  it("returns null for unknown vocabulary (never a guess)", () => {
    expect(canonGroupFromMap("SOME NEW BRAND")).toBeNull();
    expect(canonGroupFromMap("")).toBeNull();
    expect(canonGroupFromMap(null)).toBeNull();
  });
});
