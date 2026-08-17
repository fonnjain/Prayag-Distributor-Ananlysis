// Integration tests for buildDetectionContext.
//
// These tests call buildDetectionContext with a mock pool so they exercise the
// actual build logic (including normSecKey and the frozenMonths cross-validation)
// rather than injecting values directly.  They guard against normalization
// regressions and Guard-3 bypass bugs that unit tests cannot catch.

import { describe, it, expect } from "vitest";
import { buildDetectionContext } from "../context.js";
import type { DbPool } from "../types.js";

// ── Minimal mock pool factory ─────────────────────────────────────────────────
// Routes queries by SQL content; returns empty rows for unrecognised queries.

function makePool(overrides: {
  persons?: Array<{
    norm_key: string; canonical_name: string; state_head: string | null;
    is_state_head: boolean; hr_status: string | null; is_person: boolean;
  }>;
  frozenMonths?: Array<{ fy: string; month_label: string }>;
  // distSecMonthly rows (query 15) — distributor monthly secondary
  distSecMonthly?: Array<{ fy: string; month_label: string; distributor: string; val: string }>;
} = {}): DbPool {
  return {
    async query<R = Record<string, unknown>>(sql: string): Promise<{ rows: R[] }> {
      if (sql.includes("person_registry")) {
        return { rows: (overrides.persons ?? []) as unknown as R[] };
      }
      if (sql.includes("register_month_state")) {
        return { rows: (overrides.frozenMonths ?? []) as unknown as R[] };
      }
      // Query 15 — distributor monthly secondary (identified by GROUP BY fy,
      // month_label, distributor on secondary_sku_line with no retailer filter).
      // We match on "distributor" presence AND absence of "retailer IS NOT NULL"
      // to distinguish from the retailer-dist mapping query (query 9).
      if (
        sql.includes("secondary_sku_line") &&
        sql.includes("distributor") &&
        !sql.includes("retailer IS NOT NULL")
      ) {
        return { rows: (overrides.distSecMonthly ?? []) as unknown as R[] };
      }
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
    const pool = makePool({ persons: [
      { norm_key: "639", canonical_name: "Ashutosh Kumar (Rudrapur)",
        state_head: null, is_state_head: false, hr_status: "Active", is_person: true },
    ]});
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("ashutoshkumarrudrapur")).toBe(true);
    expect(ctx.personsByNameKey.has("639")).toBe(false);
  });

  it("PNK-2: collision-disambiguation norm_key — base name extracted, state-head suffix excluded", async () => {
    const pool = makePool({ persons: [
      { norm_key: "abhisheksingh:rajansrivastava", canonical_name: "Abhishek Singh",
        state_head: "Rajan Srivastava", is_state_head: false, hr_status: null, is_person: true },
    ]});
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("abhisheksingh")).toBe(true);
    expect(ctx.personsByNameKey.has("abhisheksingh:rajansrivastava")).toBe(false);
    expect(ctx.personsByNameKey.has("rajansrivastava")).toBe(false);
  });

  it("PNK-3: off-roll disambiguation key — base name preserved", async () => {
    const pool = makePool({ persons: [
      { norm_key: "ameeraliekoffroll:sanojm", canonical_name: "Ameerali Ek (Off Roll)",
        state_head: null, is_state_head: false, hr_status: "Active", is_person: true },
    ]});
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("ameeraliekoffroll")).toBe(true);
  });

  it("PNK-4: canonical name with hyphens and dots — stripped by normSecKey", async () => {
    const pool = makePool({ persons: [
      { norm_key: "859", canonical_name: "M. Gowthaman",
        state_head: null, is_state_head: false, hr_status: "Deactive", is_person: true },
    ]});
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("mgowthaman")).toBe(true);
  });

  it("PNK-5: is_person=false rows are excluded from the set", async () => {
    const pool = makePool({ persons: [
      { norm_key: "999", canonical_name: "State Head Name",
        state_head: null, is_state_head: true, hr_status: null, is_person: false },
    ]});
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("stateheadname")).toBe(false);
    expect(ctx.personsByNameKey.size).toBe(0);
  });

  it("PNK-6: empty disambiguation base (bare colon) — not added to the set", async () => {
    const pool = makePool({ persons: [
      { norm_key: ":stateheadonly", canonical_name: "Some Person",
        state_head: null, is_state_head: false, hr_status: null, is_person: true },
    ]});
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.personsByNameKey.has("")).toBe(false);
    expect(ctx.personsByNameKey.has("someperson")).toBe(false);
  });
});

// ── Guard-3 cross-validation: frozen months vs actual secondary rows ───────────
//
// register_month_state can drift from secondary_sku_line when a sync clears rows
// without updating the state record.  buildDetectionContext must remove any
// frozen month that has zero actual secondary rows so Guard 3 never passes it.

describe("buildDetectionContext — frozenMonths cross-validation", () => {
  it("FMV-1: frozen month with zero secondary rows is dropped from frozenMonths", async () => {
    // Jul-26 is frozen in register_month_state (frozen_at IS NOT NULL) but has
    // zero rows in secondary_sku_line — exactly the production state on 2026-08-17.
    const pool = makePool({
      frozenMonths: [
        { fy: "2026-27", month_label: "Apr-26" },
        { fy: "2026-27", month_label: "May-26" },
        { fy: "2026-27", month_label: "Jun-26" },
        { fy: "2026-27", month_label: "Jul-26" }, // frozen but no secondary data
      ],
      distSecMonthly: [
        { fy: "2026-27", month_label: "Apr-26", distributor: "DIST A", val: "100000" },
        { fy: "2026-27", month_label: "May-26", distributor: "DIST A", val: "90000"  },
        { fy: "2026-27", month_label: "Jun-26", distributor: "DIST A", val: "80000"  },
        // Jul-26: intentionally absent — zero rows in secondary_sku_line
      ],
    });
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    const fy2627 = ctx.frozenMonths.get("2026-27");
    expect(fy2627?.has("Apr-26")).toBe(true);
    expect(fy2627?.has("May-26")).toBe(true);
    expect(fy2627?.has("Jun-26")).toBe(true);
    // Jul-26 must be evicted — it has frozen_at but zero actual rows
    expect(fy2627?.has("Jul-26")).toBe(false);
  });

  it("FMV-2: frozen month WITH secondary rows is retained in frozenMonths", async () => {
    const pool = makePool({
      frozenMonths: [{ fy: "2026-27", month_label: "May-26" }],
      distSecMonthly: [
        { fy: "2026-27", month_label: "May-26", distributor: "DIST B", val: "50000" },
      ],
    });
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.frozenMonths.get("2026-27")?.has("May-26")).toBe(true);
  });

  it("FMV-3: all frozen months empty — frozenMonths entry exists but is empty set", async () => {
    // Simulates a catastrophic sync failure across all months.
    const pool = makePool({
      frozenMonths: [
        { fy: "2026-27", month_label: "Apr-26" },
        { fy: "2026-27", month_label: "May-26" },
      ],
      distSecMonthly: [], // nothing loaded
    });
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    const fy = ctx.frozenMonths.get("2026-27");
    // The key may be absent or an empty set — either way, no month passes
    expect(fy == null || fy.size === 0).toBe(true);
  });

  it("FMV-4: cross-validation is fy-scoped — rows for a different FY do not rescue a zero month", async () => {
    const pool = makePool({
      frozenMonths: [
        { fy: "2026-27", month_label: "Jul-26" }, // frozen but no 2026-27 secondary
      ],
      distSecMonthly: [
        // Only prior-FY data present — must not count as evidence for 2026-27
        { fy: "2025-26", month_label: "Jul-25", distributor: "DIST C", val: "120000" },
      ],
    });
    const ctx = await buildDetectionContext(pool, ["2026-27"]);
    expect(ctx.frozenMonths.get("2026-27")?.has("Jul-26")).toBe(false);
  });
});
