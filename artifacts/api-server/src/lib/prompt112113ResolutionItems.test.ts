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

describe("Prompt 112/113 register migration", () => {
  it("is replay-safe and does not delete or close administrator history", () => {
    const source = migrationSource();
    const start = source.indexOf('id: "127_prompt112_113_rules_register_updates"');
    const migration = source.slice(start, source.indexOf("\n  },", start));
    expect(start).toBeGreaterThan(0);
    expect(migration).toContain("ON CONFLICT (code) DO NOTHING;");
    expect(migration).toContain("ON CONFLICT (source_code,target_code,relation) DO NOTHING;");
    expect(migration).not.toContain("DELETE FROM resolution_item");
    expect(migration).not.toContain("status='resolved'");
    expect(migration).toContain("WHERE code='P3'");
    expect(migration).toContain("WHERE code='P4'");
  });

  it("records the two bases, named sources, owners, priority, and closure", () => {
    const source = migrationSource();
    const start = source.indexOf('id: "127_prompt112_113_rules_register_updates"');
    const migration = source.slice(start, source.indexOf("\n  },", start));
    expect(migration).toContain("'P3-P021-UNRESOLVED'");
    expect(migration).toContain("816 resolver-unresolved");
    expect(migration).toContain("94925358.94");
    expect(migration).toContain("'P021-NOT-OFFERED'");
    expect(migration).toContain("status='answered'");
    expect(migration).toContain("'UGD-PIPE-SERIES-CATEGORY'");
    expect(migration).toContain("'high'::resolution_priority");
    expect(migration).toContain("'Prayag'");
    expect(migration).toContain("production mrp_sync_generation");
  });
});