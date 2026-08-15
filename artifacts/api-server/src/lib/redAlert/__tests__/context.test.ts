// Integration tests for buildDetectionContext — specifically the personsByNameKey set.
//
// These tests call buildDetectionContext with a mock pool so they exercise the
// actual build logic (including normSecKey) rather than injecting the set
// directly.  They guard against normalization regressions that unit tests
// which inject the set directly cannot catch.

import { describe, it, expect } from "vitest";
import { buildDetectionContext } from "../context.js";
import type { DbPool } from "../types.js";

// ── Minimal mock pool ─────────────────────────────────────────────────────────
// Returns empty rows for every query EXCEPT the person_registry query (query 7),
// which is identified by the presence of "person_registry" in the SQL string.

function makePool(
  persons: Array<{
    norm_key: string;
    canonical_name: string;
    state_head: string | null;
    is_state_head: boolean;
    hr_status: string | null;
    is_person: boolean;
  }>,
): DbPool {
  return {
    async query<R = Record<string, unknown>>(sql: string): Promise<{ rows: R[] }> {
      if (sql.includes("person_registry")) {
        return { rows: persons as unknown as R[] };
      }
      // All other queries return empty result sets.
      return { rows: [] };
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildDetectionContext — personsByNameKey", () => {
  it("PNK-1: numeric employee-code norm_key — parenthetical canonical name normalises correctly", async () => {
    // "Ashutosh Kumar (Rudrapur)" → normSecKey → "ashutoshkumarrudrapur"
    // This is the exact case that failed before: my old code used .replace(/[\s.]/g, "")
    // which would leave "ashutoshkumar(rudrapur)", NOT matching head_canon.
    const pool = makePool([
      {
        norm_key: "639",
        canonical_name: "Ashutosh Kumar (Rudrapur)",
        state_head: null,
        is_state_head: false,
        hr_status: "Active",
        is_person: true,
      },
    ]);
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("ashutoshkumarrudrapur")).toBe(true);
    // The raw employee code should NOT be in the set — it is not a head_canon key
    expect(ctx.personsByNameKey.has("639")).toBe(false);
  });

  it("PNK-2: collision-disambiguation norm_key — base name extracted, state-head suffix excluded", async () => {
    // "abhisheksingh:rajansrivastava" → base = "abhisheksingh"
    const pool = makePool([
      {
        norm_key: "abhisheksingh:rajansrivastava",
        canonical_name: "Abhishek Singh",
        state_head: "Rajan Srivastava",
        is_state_head: false,
        hr_status: null,
        is_person: true,
      },
    ]);
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("abhisheksingh")).toBe(true);
    // Full collision key and state-head suffix must not appear
    expect(ctx.personsByNameKey.has("abhisheksingh:rajansrivastava")).toBe(false);
    expect(ctx.personsByNameKey.has("rajansrivastava")).toBe(false);
  });

  it("PNK-3: off-roll disambiguation key — base name preserved", async () => {
    // "ameeraliekoffroll:sanojm" → base = "ameeraliekoffroll"
    const pool = makePool([
      {
        norm_key: "ameeraliekoffroll:sanojm",
        canonical_name: "Ameerali Ek (Off Roll)",
        state_head: null,
        is_state_head: false,
        hr_status: "Active",
        is_person: true,
      },
    ]);
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("ameeraliekoffroll")).toBe(true);
  });

  it("PNK-4: canonical name with hyphens and dots — stripped by normSecKey", async () => {
    // "M. Gowthaman" → normSecKey → "mgowthaman"
    const pool = makePool([
      {
        norm_key: "859",
        canonical_name: "M. Gowthaman",
        state_head: null,
        is_state_head: false,
        hr_status: "Deactive",
        is_person: true,
      },
    ]);
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("mgowthaman")).toBe(true);
  });

  it("PNK-5: is_person=false rows are excluded from the set", async () => {
    const pool = makePool([
      {
        norm_key: "999",
        canonical_name: "State Head Name",
        state_head: null,
        is_state_head: true,
        hr_status: null,
        is_person: false,
      },
    ]);
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("stateheadname")).toBe(false);
    expect(ctx.personsByNameKey.size).toBe(0);
  });

  it("PNK-6: empty disambiguation base (bare colon) — not added to the set", async () => {
    // A pathological key of ":something" should not add an empty string.
    const pool = makePool([
      {
        norm_key: ":stateheadonly",
        canonical_name: "Some Person",
        state_head: null,
        is_state_head: false,
        hr_status: null,
        is_person: true,
      },
    ]);
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("")).toBe(false);
    // canonical_name normalisation is not applied for disambiguation-format keys
    expect(ctx.personsByNameKey.has("someperson")).toBe(false);
  });
});
