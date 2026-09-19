import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function migrationSource(): string {
  for (const path of [
    resolve(process.cwd(), "../../lib/db/src/runMigrations.ts"),
    resolve(process.cwd(), "lib/db/src/runMigrations.ts"),
  ]) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // Try the workspace-relative path next.
    }
  }
  throw new Error("Cannot locate runMigrations.ts");
}

function step4Migration(): string {
  const source = migrationSource();
  const start = source.indexOf('id: "130_prompt118_source_change_register"');
  expect(start).toBeGreaterThan(0);
  return source.slice(start, source.indexOf("\n  },", start));
}

describe("Prompt 118 Step 4 source-change register", () => {
  it("is replay-safe, does not mutate Step 5 data, and removes the obsolete blocking H2 hold", () => {
    const migration = step4Migration();
    expect(migration).toContain("ON CONFLICT (code) DO UPDATE");
    expect(migration).toContain("WHERE code = 'H2'");
    expect(migration).toContain("type = 'PENDING'");
    expect(migration).toContain("status = 'open'");
    expect(migration).toContain("owner = 'internal'");
    expect(migration).toContain("blocks_api = FALSE");
    expect(migration).not.toMatch(/register_month_state|frozen_at|head_month|sale_line_current\s+SET/i);
    expect(migration).toContain("does not represent an outstanding Prayag export request");
  });

  it("creates Q-UGD with every literal code and names all development cache misses", () => {
    const migration = step4Migration();
    for (const code of [
      "U-11CS", "U-12CS", "U-13CS", "U-14CS", "U-15CS", "U-16CS",
      "U-11BS", "U-12BS", "U-13BS", "U-14BS",
    ]) {
      expect(migration).toContain(code);
    }
    expect(migration).toContain("'Q-UGD'");
    expect(migration).toContain("'Prayag'");
    expect(migration).toContain("missing every requested literal code");
    expect(migration).toContain("Production active cache contains all ten literal codes");
    expect(migration).toContain("Development active cache evidence is stale and is missing every requested literal code");
    expect(migration).toContain("Unmapped");
  });

  it("preserves the operating-rule seam and derived-MRP wording", () => {
    const rules = readFileSync(resolve(process.cwd(), "../../PRAYAG_OPERATING_RULES.md"), "utf8");
    expect(rules).toContain("RULE 6.1");
    expect(rules).toContain("PSCode3 ends on 31 July 2026");
    expect(rules).toContain("Product-Wise is the sole secondary source from 1 August 2026");
    expect(rules).toContain("Rupees are never summed or compared across the seam");
    expect(rules).toContain("derived from MRP");
    expect(rules).toContain("Unmapped");
  });
});