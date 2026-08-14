// Regression tests for customer state-head derivation helpers.
//
// normaliseCustomerState: pure function — no DB needed.
// resolvePickerToStoredHead: tested via a minimal mock Queryable so the test
//   is deterministic without touching the live person_registry table.
//
// WHAT THESE TESTS PROTECT:
//   1. The alias mismatch between person_registry.canonical_name ("Pawan Kumar
//      Sharma") and the sale-line display canonical stored in customer_master
//      ("Pawan Sharma" = alias_secondary).  Without the resolution step the
//      cascade-states filter finds zero customer_master rows for that head and
//      falls back to all 33 states — defeating the cascade restriction.
//   2. The graceful fallback: when the picker name is unknown or has no
//      alias_secondary, the raw name is returned so the endpoint can detect
//      zero customer rows and fall back to all states.

import { describe, it, expect } from "vitest";
import { normaliseCustomerState, resolvePickerToStoredHead } from "./customerStateHead.js";

// ── normaliseCustomerState ────────────────────────────────────────────────────

describe("normaliseCustomerState", () => {
  it("uppercases and trims plain state names", () => {
    expect(normaliseCustomerState("Punjab")).toBe("PUNJAB");
    expect(normaliseCustomerState("  Rajasthan  ")).toBe("RAJASTHAN");
    expect(normaliseCustomerState("Maharashtra")).toBe("MAHARASHTRA");
  });

  it("maps Delhi NCR to DELHI", () => {
    expect(normaliseCustomerState("Delhi NCR")).toBe("DELHI");
    expect(normaliseCustomerState("DELHI NCR")).toBe("DELHI");
  });

  it("keeps EAST U.P and WEST U.P distinct", () => {
    expect(normaliseCustomerState("East U.P")).toBe("EAST U.P");
    expect(normaliseCustomerState("EAST U.P")).toBe("EAST U.P");
    expect(normaliseCustomerState("West U.P")).toBe("WEST U.P");
    expect(normaliseCustomerState("WEST U.P")).toBe("WEST U.P");
  });

  it("maps HP to HIMACHAL PRADESH", () => {
    expect(normaliseCustomerState("HP")).toBe("HIMACHAL PRADESH");
    expect(normaliseCustomerState("hp")).toBe("HIMACHAL PRADESH");
  });

  it("returns null for blank input", () => {
    expect(normaliseCustomerState(null)).toBeNull();
    expect(normaliseCustomerState("")).toBeNull();
    expect(normaliseCustomerState(undefined)).toBeNull();
  });
});

// ── resolvePickerToStoredHead ─────────────────────────────────────────────────

/** Minimal Queryable mock that returns a fixed result set. */
function mockDb(rows: { stored_head: string }[]): { query: (sql: string, params?: unknown[]) => Promise<{ rows: typeof rows }> } {
  return { query: async () => ({ rows }) };
}

describe("resolvePickerToStoredHead — alias resolution", () => {
  it("returns alias_secondary when it differs from canonical_name", async () => {
    // Simulates: canonical_name="Pawan Kumar Sharma", alias_secondary="Pawan Sharma"
    const db = mockDb([{ stored_head: "Pawan Sharma" }]);
    const result = await resolvePickerToStoredHead(db as Parameters<typeof resolvePickerToStoredHead>[0], "Pawan Kumar Sharma");
    expect(result).toBe("Pawan Sharma");
  });

  it("returns canonical_name as-is when alias_secondary is absent", async () => {
    // Simulates: canonical_name="Sandeep Dadheech", alias_secondary=NULL
    const db = mockDb([{ stored_head: "Sandeep Dadheech" }]);
    const result = await resolvePickerToStoredHead(db as Parameters<typeof resolvePickerToStoredHead>[0], "Sandeep Dadheech");
    expect(result).toBe("Sandeep Dadheech");
  });

  it("falls back to the raw picker name when the registry has no matching row", async () => {
    // Simulates: head not yet in registry (backfill edge case) or misspelled picker value.
    const db = mockDb([]);
    const result = await resolvePickerToStoredHead(db as Parameters<typeof resolvePickerToStoredHead>[0], "Unknown Head Name");
    expect(result).toBe("Unknown Head Name");
  });
});
