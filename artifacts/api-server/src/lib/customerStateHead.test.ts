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
import {
  normaliseCustomerState,
  resolvePickerToStoredHead,
  buildCascadeStates,
  type StateHierarchyRow,
} from "./customerStateHead.js";

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

// ── buildCascadeStates ────────────────────────────────────────────────────────
//
// WHAT THESE TESTS PROTECT:
//   After the backfill populates customer_master.state_head, the cascade-states
//   endpoint must narrow the picker to only the states that head actually serves.
//   A regression in the normalisation map or the parent/child filter logic would
//   silently return all 33 states instead of the correct subset.
//
//   Fixtures are synthetic (no live DB) so the test is always deterministic.
//   The fixture mirrors the real state_hierarchy shape: parent-aggregate rows
//   plus is_split leaf rows, and plain non-split state rows.

/** Minimal state_hierarchy fixture (12 rows, three regions). */
const ALL_ROWS: StateHierarchyRow[] = [
  // ── NORTH region ─────────────────────────────────────────────────────────
  { canon: "NORTH",            parent: "NORTH",  isSplit: false }, // parent aggregate
  { canon: "DELHI",            parent: "NORTH",  isSplit: false },
  { canon: "RAJASTHAN",        parent: "NORTH",  isSplit: false },
  { canon: "HIMACHAL PRADESH", parent: "NORTH",  isSplit: false },
  // ── EAST region ──────────────────────────────────────────────────────────
  { canon: "EAST",             parent: "EAST",   isSplit: false }, // parent aggregate
  { canon: "BIHAR",            parent: "EAST",   isSplit: false },
  { canon: "WEST BENGAL",      parent: "EAST",   isSplit: false },
  // ── WEST region ──────────────────────────────────────────────────────────
  { canon: "WEST",             parent: "WEST",   isSplit: false }, // parent aggregate
  { canon: "GUJARAT",          parent: "WEST",   isSplit: false },
  { canon: "MAHARASHTRA",      parent: "WEST",   isSplit: false },
  // ── UP split (two leaf children share a parent canon) ────────────────────
  { canon: "U.P",              parent: "U.P",    isSplit: false }, // parent aggregate
  { canon: "EAST U.P",         parent: "U.P",    isSplit: true  },
  { canon: "WEST U.P",         parent: "U.P",    isSplit: true  },
];

describe("buildCascadeStates — cascade filter after backfill", () => {
  it("Sandeep Dadheech: raw customer states narrow to his 2 states + parent rows", () => {
    // customer_master rows for Sandeep Dadheech after backfill:
    //   state = "Rajasthan" (raw upload), state = "Gujarat" (raw upload)
    const raw = ["Rajasthan", "Gujarat"];
    const result = buildCascadeStates(raw, ALL_ROWS);

    expect(result).not.toBeNull();
    const canons = result!.map((r) => r.canon);

    // Matched leaves must be present.
    expect(canons).toContain("RAJASTHAN");
    expect(canons).toContain("GUJARAT");

    // Parent-aggregate rows for matched leaves must be included.
    expect(canons).toContain("NORTH"); // parent of RAJASTHAN
    expect(canons).toContain("WEST");  // parent of GUJARAT

    // States from other heads must NOT appear.
    expect(canons).not.toContain("BIHAR");
    expect(canons).not.toContain("WEST BENGAL");
    expect(canons).not.toContain("DELHI");
    expect(canons).not.toContain("HIMACHAL PRADESH");
    expect(canons).not.toContain("EAST");

    // Filtered result is a proper subset — far fewer than all 13 rows.
    expect(result!.length).toBeLessThan(ALL_ROWS.length);
  });

  it("Nasir Hussain Khan: raw customer state narrows to his 1 state + parent", () => {
    // customer_master rows for Nasir Hussain Khan after backfill:
    //   state = "Bihar" (raw upload)
    const raw = ["Bihar"];
    const result = buildCascadeStates(raw, ALL_ROWS);

    expect(result).not.toBeNull();
    const canons = result!.map((r) => r.canon);

    // His one state and its parent must appear.
    expect(canons).toContain("BIHAR");
    expect(canons).toContain("EAST"); // parent of BIHAR

    // All other states must NOT appear.
    expect(canons).not.toContain("RAJASTHAN");
    expect(canons).not.toContain("GUJARAT");
    expect(canons).not.toContain("DELHI");
    expect(canons).not.toContain("WEST BENGAL");
    expect(canons).not.toContain("NORTH");
    expect(canons).not.toContain("WEST");
    expect(canons).not.toContain("U.P");

    expect(result!.length).toBe(2); // EAST + BIHAR only
  });

  it("normalisation: raw 'Delhi NCR' maps to DELHI leaf", () => {
    const raw = ["Delhi NCR"];
    const result = buildCascadeStates(raw, ALL_ROWS);

    expect(result).not.toBeNull();
    const canons = result!.map((r) => r.canon);
    expect(canons).toContain("DELHI");
    expect(canons).toContain("NORTH");
    expect(canons).not.toContain("RAJASTHAN");
  });

  it("split state: raw 'UP ( A )' resolves to EAST U.P leaf + U.P parent", () => {
    const raw = ["UP ( A )"]; // CUSTOMER_STATE_OVERRIDES maps this to EAST U.P
    const result = buildCascadeStates(raw, ALL_ROWS);

    expect(result).not.toBeNull();
    const canons = result!.map((r) => r.canon);
    expect(canons).toContain("EAST U.P");
    expect(canons).toContain("U.P");   // parent aggregate
    expect(canons).not.toContain("WEST U.P"); // sibling not served by this head
    expect(canons).not.toContain("BIHAR");
  });

  it("unknown head: empty rawStates returns null (caller falls back to all states)", () => {
    // Backfill not yet run, or head name resolved to one with no customer rows.
    const result = buildCascadeStates([], ALL_ROWS);
    expect(result).toBeNull();
  });

  it("vocab mismatch: state not in hierarchy returns null (caller falls back)", () => {
    // Raw state that normalises to something not in the fixture hierarchy.
    const result = buildCascadeStates(["Nonexistent Territory"], ALL_ROWS);
    expect(result).toBeNull();
  });

  it("ordering is preserved from allRows", () => {
    const raw = ["Gujarat", "Rajasthan"]; // reversed relative to fixture order
    const result = buildCascadeStates(raw, ALL_ROWS);

    expect(result).not.toBeNull();
    const canons = result!.map((r) => r.canon);
    // NORTH comes before WEST in ALL_ROWS; RAJASTHAN before GUJARAT.
    const northIdx     = canons.indexOf("NORTH");
    const rajasthanIdx = canons.indexOf("RAJASTHAN");
    const westIdx      = canons.indexOf("WEST");
    const gujaratIdx   = canons.indexOf("GUJARAT");

    expect(northIdx).toBeLessThan(westIdx);
    expect(rajasthanIdx).toBeLessThan(gujaratIdx);
  });
});
