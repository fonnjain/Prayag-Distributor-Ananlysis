import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function migrationSource(): string {
  const candidates = [
    resolve(process.cwd(), "lib/db/src/runMigrations.ts"),
    resolve(process.cwd(), "../../lib/db/src/runMigrations.ts"),
  ];
  const file = candidates.find(existsSync);
  if (!file) throw new Error("Cannot locate runMigrations.ts for Prompt 93 seed test");
  return readFileSync(file, "utf8");
}

function prompt93Migration(): string {
  const source = migrationSource();
  const start = source.indexOf('id: "115_prompt93_geography_resolution_items"');
  const end = source.indexOf("\n  },", start);
  if (start < 0 || end < 0) throw new Error("Prompt 93 geography migration is missing");
  return source.slice(start, end);
}

describe("Prompt 93 Section A resolution seeds", () => {
  it("seeds H4 with the canonical geography hold semantics", () => {
    const migration = prompt93Migration();

    expect(migration).toContain(
      "('H4', 'HOLD', 'CANONICAL RETAILER GEOGRAPHY INCOMPLETE', 'master data'",
    );
    expect(migration).toContain("'retailer state attribution', 'peer-set construction'");
    expect(migration).toContain(
      "Retailer canonical state is directly known for 33.28% of FY2025-26 active retailers and 26.12% of FY2026-27. An unambiguous distributor bridge lifts this to 58.17% and 46.27%.",
    );
    expect(migration).toContain(
      "8,898 FY2025-26 active retailers, 2,961 with direct state, 5,176 after bridge. 6,194 FY2026-27 active, 1,618 direct, 2,866 after bridge. Among directly known FY2025-26 state x size-quintile cells, 32 of 45 hold at least 30 retailers - so peers are statistically credible WHERE geography is known.",
    );
    expect(migration).toContain(
      "'internal, then Prayag for source attribution', 'high', 'open', TRUE)",
    );
  });

  it("seeds P44 as a non-blocking pending coverage finding", () => {
    const migration = prompt93Migration();

    expect(migration).toContain(
      "('P44', 'PENDING', 'RET# COVERAGE UNEVEN ACROSS YEARS', 'data quality'",
    );
    expect(migration).toContain(
      "52,515 of 379,439 FY2025-26 secondary rows carry RET#, against complete RET# on all 123,326 FY2026-27 rows. Retailer identity falls back to normalised name for the remainder, which is weaker.",
    );
    expect(migration).toContain(
      "NULL, NULL, NULL, NULL,\n         '52,515 of 379,439",
    );
    expect(migration).toContain(
      "'internal', 'medium', 'open', FALSE)",
    );
  });

  it("is replay-safe and preserves administrator edits", () => {
    const migration = prompt93Migration();

    expect(migration).toContain("ON CONFLICT (code) DO NOTHING;");
    expect(migration).not.toContain("DO UPDATE");
  });
});