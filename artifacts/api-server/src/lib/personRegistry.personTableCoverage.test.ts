// Task 300: confirm that a new team member seeded into person_registry but
// absent from the person table is caught and reported before territory
// roll-ups silently lose their secondary_sku_line rows.
//
// findRegistryMembersWithoutPersonRow() is the pure core of
// assertPersonTableCoverage().  Tests exercise it without a live DB.

import { describe, it, expect } from "vitest";
import { findRegistryMembersWithoutPersonRow } from "./personRegistry.js";

describe("findRegistryMembersWithoutPersonRow", () => {
  it("returns empty when every registry member has a person row", () => {
    const registry = ["Alice Sharma", "Bob Kumar", "Carol Singh"];
    const persons = ["Alice Sharma", "Bob Kumar", "Carol Singh"];
    expect(findRegistryMembersWithoutPersonRow(registry, persons)).toEqual([]);
  });

  it("flags a member present in person_registry but absent from person table", () => {
    const registry = ["Alice Sharma", "New Member"];
    const persons = ["Alice Sharma"];
    const missing = findRegistryMembersWithoutPersonRow(registry, persons);
    expect(missing).toEqual(["New Member"]);
  });

  it("matches case-insensitively (person table may store different casing)", () => {
    const registry = ["Pawan Kumar Sharma"];
    const persons = ["PAWAN KUMAR SHARMA"];
    expect(findRegistryMembersWithoutPersonRow(registry, persons)).toEqual([]);
  });

  it("strips leading/trailing and collapses internal whitespace before comparing", () => {
    // person_registry canonical_name and person.name may have extra spaces.
    // IMPORTANT: this normalization (REGEXP_REPLACE + LOWER + TRIM) must stay
    // in sync with the SQL join in reconcilePersonRegistryStateHeads() so that
    // a member declared "covered" by this check can actually be reconciled.
    // Both use the same collapse-whitespace semantics.
    const registry = ["  Anant  Singh "];
    const persons = ["Anant Singh"];
    expect(findRegistryMembersWithoutPersonRow(registry, persons)).toEqual([]);
  });

  it("flags a member whose name has extra internal whitespace that person table uses single-spaced", () => {
    // Verify the REVERSE direction: if person table has "Anant  Singh" (double
    // space) and registry has "Anant Singh" (single), both collapse to the same
    // normalised form so coverage check correctly marks it as covered.
    const registry = ["Anant Singh"];
    const persons = ["Anant  Singh"];
    expect(findRegistryMembersWithoutPersonRow(registry, persons)).toEqual([]);
  });

  it("flags multiple missing members in insertion order", () => {
    const registry = ["Alice", "Bob", "Carol", "Dave"];
    const persons = ["Alice", "Carol"];
    const missing = findRegistryMembersWithoutPersonRow(registry, persons);
    expect(missing).toEqual(["Bob", "Dave"]);
  });

  it("returns empty when both lists are empty", () => {
    expect(findRegistryMembersWithoutPersonRow([], [])).toEqual([]);
  });

  it("flags all members when person table is empty (fresh deploy before master import)", () => {
    const registry = ["Alice Sharma", "Bob Kumar"];
    const missing = findRegistryMembersWithoutPersonRow(registry, []);
    expect(missing).toEqual(["Alice Sharma", "Bob Kumar"]);
  });

  it("handles PAWAN KUMAR trap: two registry members with similar names are checked independently", () => {
    // "Pawan Kumar Sharma" is a state head (not checked here — is_state_head=true rows
    // are excluded upstream); "Pawan Kumar (HR)" is the ordinary TM row.
    const registry = ["Pawan Kumar (HR)"];
    const persons = ["Pawan Kumar Sharma"]; // state head in person table — different person
    const missing = findRegistryMembersWithoutPersonRow(registry, persons);
    // The TM row has no person table entry → should be flagged
    expect(missing).toEqual(["Pawan Kumar (HR)"]);
  });
});
